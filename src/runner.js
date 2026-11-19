'use strict';

// ---------------------------------------------------------------------------
// Hostfy runner
//
// Responsável por executar projetos PHP/Node como processos gerenciados e por
// encaminhar requisições de subdomínios ({slug}.PROJECTS_DOMAIN) para o processo
// correspondente. Dois listeners:
//   - público    (RUNNER_PORT)          -> proxy de subdomínio (via cloudflared)
//   - controle   (RUNNER_CONTROL_PORT)  -> API interna usada pelo app
//
// Executa código enviado por usuários. O isolamento é de nível "médio":
// processos separados com limites de memória e reinício automático, mas
// compartilhando o mesmo contêiner. Veja o README para as ressalvas de segurança.
// ---------------------------------------------------------------------------

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const CONTROL_PORT = Number(process.env.RUNNER_CONTROL_PORT || 1594);
const PUBLIC_PORT = Number(process.env.RUNNER_PORT || 1593);
const TOKEN = String(process.env.RUNNER_TOKEN || '');
const STORAGE = process.env.STORAGE_DIR || '/data/projects';
const PORT_BASE = Number(process.env.PORT_BASE || 21000);
const PROJECTS_DOMAIN = String(process.env.PROJECTS_DOMAIN || '').trim().toLowerCase();
const MAX_RESTARTS = Number(process.env.RUNNER_MAX_RESTARTS || 5);
const NODE_MEM_MB = Number(process.env.RUNNER_NODE_MEM_MB || 256);
const PHP_MEMORY = process.env.RUNNER_PHP_MEMORY || '256M';
const LOG_LIMIT = Number(process.env.RUNNER_LOG_LINES || 500);
const RUNTIME_DIR = '/tmp/hostly';
const ROUTER_PATH = path.join(RUNTIME_DIR, 'php-router.php');
const BUILD_HOME = path.join(RUNTIME_DIR, 'home');

// O binário do PHP varia entre distribuições (php, php83, php82...).
function findInPath(bin) {
  const dirs = (process.env.PATH || '').split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const PHP_BIN = (() => {
  if (process.env.PHP_BIN) return process.env.PHP_BIN;
  for (const name of ['php', 'php83', 'php82', 'php81']) {
    const found = findInPath(name);
    if (found) return found;
  }
  return 'php';
})();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', e => console.error(`[runner] erro no pool de conexões: ${e.message}`));

/** projectId (string) -> app em memória */
const apps = new Map();
const usedPorts = new Set();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function baseEnv(extra) {
  return {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: BUILD_HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    ...extra,
  };
}

function log(app, stream, chunk) {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    app.logs.push({ t: Date.now(), stream, line });
  }
  if (app.logs.length > LOG_LIMIT) app.logs.splice(0, app.logs.length - LOG_LIMIT);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function allocatePort() {
  let port = PORT_BASE;
  while (usedPorts.has(port) || !(await isPortFree(port))) port += 1;
  usedPorts.add(port);
  return port;
}

function releasePort(app) {
  if (app.port) usedPorts.delete(app.port);
}

function persistStatus(app) {
  if (!app.projectId) return;
  pool
    .query('UPDATE projects SET status=$1, runtime_port=$2, updated_at=NOW() WHERE id=$3', [
      app.status,
      app.port || null,
      app.projectId,
    ])
    .catch(() => {});
}

function summary(app) {
  return {
    projectId: app.projectId,
    slug: app.slug,
    type: app.type,
    status: app.status,
    port: app.port || null,
    restarts: app.restarts,
    lastError: app.lastError || null,
  };
}

// ---------------------------------------------------------------------------
// Execução de passos (npm install / build)
// ---------------------------------------------------------------------------

function runStep(app, cmd, args, label) {
  log(app, 'system', `$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: app.dir,
      env: baseEnv({ NODE_ENV: 'production' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => log(app, 'stdout', d));
    child.stderr.on('data', d => log(app, 'stderr', d));
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${label} falhou (código ${code}).`))));
  });
}

async function prepareNode(app, rebuild) {
  const hasLock = fs.existsSync(path.join(app.dir, 'package-lock.json'));
  const hasModules = fs.existsSync(path.join(app.dir, 'node_modules'));
  if (rebuild || !hasModules) {
    await runStep(app, 'npm', [hasLock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], 'Instalação de dependências');
  }
  if (rebuild && app.hasBuild) {
    await runStep(app, 'npm', ['run', 'build'], 'Build');
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida dos processos
// ---------------------------------------------------------------------------

function spawnApp(app) {
  if (app.type === 'node') {
    const command = app.startCommand || 'npm start';
    return spawn(command, {
      cwd: app.dir,
      env: baseEnv({
        NODE_ENV: 'production',
        PORT: String(app.port),
        HOST: '0.0.0.0',
        NODE_OPTIONS: `--max-old-space-size=${NODE_MEM_MB}`,
      }),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const docroot = path.resolve(app.dir, app.docroot || '');
  return spawn(
    PHP_BIN,
    ['-d', `memory_limit=${PHP_MEMORY}`, '-S', `0.0.0.0:${app.port}`, '-t', docroot, ROUTER_PATH],
    {
      cwd: app.dir,
      env: baseEnv({ HOSTLY_DOCROOT: docroot }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}

function startProcess(app) {
  app.stopRequested = false;
  let child;
  try {
    child = spawnApp(app);
  } catch (e) {
    app.status = 'error';
    app.lastError = e.message;
    log(app, 'system', `Falha ao iniciar: ${e.message}`);
    persistStatus(app);
    return;
  }
  app.child = child;
  app.status = 'running';
  app.lastError = null;
  persistStatus(app);

  child.stdout.on('data', d => log(app, 'stdout', d));
  child.stderr.on('data', d => log(app, 'stderr', d));
  child.on('error', e => {
    app.lastError = e.message;
    log(app, 'system', `Erro do processo: ${e.message}`);
    handleChildStop(app, child, null, null, true);
  });
  child.on('exit', (code, signal) => handleChildStop(app, child, code, signal, false));
}

function handleChildStop(app, child, code, signal, spawnError) {
  if (app.child !== child) return;
  app.child = null;
  if (app.stopRequested) {
    app.status = 'stopped';
    persistStatus(app);
    return;
  }
  if (spawnError) {
    app.status = 'error';
    app.lastError = app.lastError || 'Não foi possível iniciar o processo.';
    persistStatus(app);
    releasePort(app);
    return;
  }
  log(app, 'system', `Processo finalizou (code=${code}, sinal=${signal || '-'}).`);
  if (app.restarts < MAX_RESTARTS) {
    app.restarts += 1;
    app.status = 'restarting';
    persistStatus(app);
    const delay = Math.min(app.restarts * 1000, 10000);
    setTimeout(() => {
      if (!app.stopRequested && !app.child) startProcess(app);
    }, delay);
  } else {
    app.status = 'error';
    app.lastError = 'Processo falhou repetidamente.';
    persistStatus(app);
    releasePort(app);
  }
}

async function stopApp(projectId) {
  const app = apps.get(String(projectId));
  if (!app) return { stopped: false };
  app.stopRequested = true;
  const child = app.child;
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  app.child = null;
  app.status = 'stopped';
  releasePort(app);
  persistStatus(app);
  return { stopped: true };
}

async function deployApp(payload) {
  const key = String(payload.projectId);
  await stopApp(key);

  const dir = path.resolve(STORAGE, payload.storageKey);
  await fsp.access(dir); // lança se o diretório não existir

  const existing = apps.get(key);
  const app = existing || { logs: [] };
  Object.assign(app, {
    projectId: key,
    storageKey: payload.storageKey,
    slug: payload.slug,
    type: payload.type,
    dir,
    docroot: payload.docroot || '',
    startCommand: payload.startCommand || null,
    hasBuild: Boolean(payload.hasBuild),
    port: null,
    status: 'deploying',
    restarts: 0,
    stopRequested: false,
    lastError: null,
    child: null,
  });
  apps.set(key, app);
  persistStatus(app);

  try {
    if (app.type === 'node') await prepareNode(app, payload.rebuild !== false);
    app.port = await allocatePort();
    startProcess(app);
    return { status: app.status, port: app.port, type: app.type };
  } catch (e) {
    app.status = 'error';
    app.lastError = e.message;
    log(app, 'system', `Erro no deploy: ${e.message}`);
    persistStatus(app);
    releasePort(app);
    throw e;
  }
}

async function removeApp(projectId) {
  const key = String(projectId);
  const app = apps.get(key);
  if (!app) return { removed: false };
  await stopApp(key);
  apps.delete(key);
  return { removed: true };
}

async function restartApp(projectId) {
  const app = apps.get(String(projectId));
  if (!app) throw new Error('Projeto não encontrado no runner.');
  await stopApp(projectId);
  app.stopRequested = false;
  app.restarts = 0;
  app.port = null;
  app.port = await allocatePort();
  startProcess(app);
  return { status: app.status, port: app.port };
}

// ---------------------------------------------------------------------------
// Proxy de subdomínio
// ---------------------------------------------------------------------------

function subdomainSlug(host) {
  if (!PROJECTS_DOMAIN || !host || host === PROJECTS_DOMAIN) return null;
  const suffix = `.${PROJECTS_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, host.length - suffix.length);
  if (!sub) return null;
  const slug = sub.split('.')[0];
  return SLUG_RE.test(slug) ? slug : null;
}

function findRunningBySlug(slug) {
  for (const app of apps.values()) {
    if (app.slug === slug && app.status === 'running' && app.child) return app;
  }
  return null;
}

function proxyRequest(req, res, app) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${app.port}`;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  delete headers.connection;

  const upstream = http.request(
    { host: '127.0.0.1', port: app.port, method: req.method, path: req.url, headers },
    up => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Serviço indisponível.');
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, app) {
  const upstream = net.connect(app.port, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `127.0.0.1:${app.port}` };
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

const publicServer = http.createServer((req, res) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const slug = subdomainSlug(host);
  const app = slug ? findRunningBySlug(slug) : null;
  if (!slug) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Projeto não encontrado.');
  }
  if (!app) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Projeto indisponível no momento.');
  }
  proxyRequest(req, res, app);
});

publicServer.on('upgrade', (req, socket, head) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const slug = subdomainSlug(host);
  const app = slug ? findRunningBySlug(slug) : null;
  if (!app) return socket.destroy();
  proxyUpgrade(req, socket, head, app);
});

// ---------------------------------------------------------------------------
// API de controle (interna)
// ---------------------------------------------------------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const controlServer = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(res, 401, { error: 'Não autorizado.' });
    }
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && parts[0] === 'apps') {
      return send(res, 200, { apps: [...apps.values()].map(summary) });
    }
    if (req.method === 'GET' && parts[0] === 'status') {
      const app = apps.get(parts[1]);
      return send(res, 200, app ? summary(app) : { status: 'unknown' });
    }
    if (req.method === 'GET' && parts[0] === 'logs') {
      const app = apps.get(parts[1]);
      return send(res, 200, { logs: app ? app.logs : [] });
    }
    if (req.method === 'POST' && parts[0] === 'deploy') {
      const body = await readJson(req);
      return send(res, 200, await deployApp(body));
    }
    if (req.method === 'POST' && parts[0] === 'stop') {
      const body = await readJson(req);
      return send(res, 200, await stopApp(String(body.projectId)));
    }
    if (req.method === 'POST' && parts[0] === 'remove') {
      const body = await readJson(req);
      return send(res, 200, await removeApp(String(body.projectId)));
    }
    if (req.method === 'POST' && parts[0] === 'restart') {
      const body = await readJson(req);
      return send(res, 200, await restartApp(String(body.projectId)));
    }
    return send(res, 404, { error: 'Rota não encontrada.' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Erro no runner.' });
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const ROUTER_SOURCE = `<?php
$docroot = getenv('HOSTLY_DOCROOT');
if (!is_string($docroot) || $docroot === '') {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Configuração de docroot ausente';
    return true;
}
$root = realpath($docroot);
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = $path === null ? '/' : rawurldecode($path);
$target = $root === false ? false : realpath($root . $path);
if ($path !== '/' && $target !== false && strpos($target, $root) === 0 && is_file($target)) {
    return false; // serve o arquivo existente (estático ou .php)
}
$index = $docroot . DIRECTORY_SEPARATOR . 'index.php';
if (is_file($index)) {
    chdir($docroot);
    require $index;
    return true;
}
http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo 'Arquivo não encontrado';
return true;
`;

async function waitForSchema() {
  // O app é quem cria as tabelas; o runner pode iniciar antes dele.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query('SELECT type FROM projects LIMIT 1');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Tabela "projects" não ficou disponível a tempo.');
}

async function bootstrap() {
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  await fsp.mkdir(BUILD_HOME, { recursive: true });
  await fsp.mkdir(STORAGE, { recursive: true });
  await fsp.writeFile(ROUTER_PATH, ROUTER_SOURCE);

  await waitForSchema();

  await pool.query(`CREATE TABLE IF NOT EXISTS project_storage (
    project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE
  )`);

  // Restaura projetos de runtime que já existiam (ex.: após reinício do runner).
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.type, p.docroot, p.start_command, s.storage_key
       FROM projects p
       JOIN project_storage s ON s.project_id = p.id
      WHERE p.type IN ('php','node')`
  );
  for (const row of rows) {
    try {
      await deployApp({
        projectId: String(row.id),
        storageKey: row.storage_key,
        slug: row.slug,
        type: row.type,
        docroot: row.docroot || '',
        startCommand: row.start_command || null,
        rebuild: false,
      });
      console.log(`[runner] restaurado ${row.slug} (${row.type})`);
    } catch (e) {
      console.error(`[runner] falha ao restaurar ${row.slug}: ${e.message}`);
    }
  }

  publicServer.listen(PUBLIC_PORT, () => console.log(`Hostfy runner proxy on ${PUBLIC_PORT}`));
  controlServer.listen(CONTROL_PORT, () => console.log(`Hostfy runner control on ${CONTROL_PORT}`));
}

bootstrap().catch(e => {
  console.error(e);
  process.exit(1);
});