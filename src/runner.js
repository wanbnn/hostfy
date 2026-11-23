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
const docker = require('./docker-runtime');
const cleanup = require('./cleanup');

const CONTROL_PORT = Number(process.env.RUNNER_CONTROL_PORT || 1594);
const PUBLIC_PORT = Number(process.env.RUNNER_PORT || 1593);
const TOKEN = String(process.env.RUNNER_TOKEN || '');
const STORAGE = process.env.STORAGE_DIR || '/data/projects';
const PORT_BASE = Number(process.env.PORT_BASE || 21000);
const PROJECTS_DOMAIN = String(process.env.PROJECTS_DOMAIN || '').trim().toLowerCase();
// Servidor interno que entrega os arquivos dos sites estáticos. Quando definido,
// os subdomínios também atendem projetos estáticos (repassados a ele).
const STATIC_URL = String(process.env.STATIC_URL || '').trim();
const MAX_RESTARTS = Number(process.env.RUNNER_MAX_RESTARTS || 5);
const NODE_MEM_MB = Number(process.env.RUNNER_NODE_MEM_MB || 256);
const PHP_MEMORY = process.env.RUNNER_PHP_MEMORY || '256M';
const LOG_LIMIT = Number(process.env.RUNNER_LOG_LINES || 500);
const CLK_TCK = Number(process.env.CLK_TCK || 100);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 4096);
const CLEANUP_ENABLED = String(process.env.CLEANUP_ENABLED || 'true') !== 'false';
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 60);
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

// ---------------------------------------------------------------------------
// Métricas de recursos dos processos PHP/Node (via /proc)
// ---------------------------------------------------------------------------

function readProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    const fields = raw.slice(end + 2).split(' ');
    return {
      ppid: Number(fields[1]),
      utime: Number(fields[11]),
      stime: Number(fields[12]),
      cutime: Number(fields[13]),
      cstime: Number(fields[14]),
      rss: Number(fields[21]),
    };
  } catch {
    return null;
  }
}

function procTree(rootPid) {
  const all = {};
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(name);
    if (stat) all[name] = stat;
  }
  const pids = new Set([String(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, stat] of Object.entries(all)) {
      if (pids.has(String(stat.ppid)) && !pids.has(pid)) {
        pids.add(pid);
        changed = true;
      }
    }
  }
  return [...pids].map(pid => all[pid]).filter(Boolean);
}

function processStats(app) {
  if (!app.child || !app.child.pid) return { cpuPercent: 0, memBytes: 0, containers: 0 };
  const procs = procTree(app.child.pid);
  if (!procs.length) return { cpuPercent: 0, memBytes: 0, containers: 0 };
  const ticks = procs.reduce((a, s) => a + s.utime + s.stime + s.cutime + s.cstime, 0);
  const rssPages = procs.reduce((a, s) => a + s.rss, 0);
  const now = Date.now();
  let cpuPercent = 0;
  if (app.sample) {
    const dt = (now - app.sample.ts) / 1000;
    if (dt > 0) cpuPercent = ((ticks - app.sample.ticks) / CLK_TCK / dt) * 100;
  }
  app.sample = { ticks, ts: now };
  return {
    cpuPercent: Math.max(0, Math.round(cpuPercent * 100) / 100),
    memBytes: Math.max(0, rssPages * PAGE_SIZE),
    containers: procs.length,
  };
}

async function statsFor(projectId) {
  const app = apps.get(String(projectId));
  if (!app) return { status: 'unknown', cpuPercent: 0, memBytes: 0, containers: 0 };
  if (app.kind === 'docker') {
    const s = await docker.stats(app.projectName).catch(() => ({ cpuPercent: 0, memBytes: 0, containers: 0 }));
    return { status: app.status, ...s };
  }
  return { status: app.status, ...processStats(app) };
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
    kind: app.kind || 'process',
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
      env: baseEnv({ NODE_ENV: 'production', ...(app.env || {}) }),
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
        ...(app.env || {}),
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
      env: baseEnv({ HOSTLY_DOCROOT: docroot, ...(app.env || {}) }),
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
  if (app.kind === 'docker') {
    app.stopRequested = true;
    await docker
      .composeStop({ projectName: app.projectName, dir: app.dir, composeFile: app.composeFile })
      .catch(() => {});
    app.status = 'stopped';
    persistStatus(app);
    return { stopped: true };
  }
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
    kind: 'process',
    storageKey: payload.storageKey,
    slug: payload.slug,
    type: payload.type,
    dir,
    docroot: payload.docroot || '',
    startCommand: payload.startCommand || null,
    hasBuild: Boolean(payload.hasBuild),
    env: payload.env || {},
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
  if (app.kind === 'docker') {
    await docker
      .composeDown({ projectName: app.projectName, dir: app.dir, composeFile: app.composeFile, removeVolumes: true })
      .catch(() => {});
    await docker.removeProjectResources(app.projectName).catch(() => {});
    apps.delete(key);
    return { removed: true };
  }
  await stopApp(key);
  apps.delete(key);
  return { removed: true };
}

async function restartApp(projectId) {
  const app = apps.get(String(projectId));
  if (!app) throw new Error('Projeto não encontrado no runner.');
  if (app.kind === 'docker') {
    await docker
      .composeRestart({ projectName: app.projectName, dir: app.dir, composeFile: app.composeFile })
      .catch(async () => {
        await docker.composeStart({ projectName: app.projectName, dir: app.dir, composeFile: app.composeFile });
      });
    await docker.attachDatabasesNetwork(app.projectName).catch(() => {});
    const target = await docker.resolveWebTarget({
      projectName: app.projectName,
      dir: app.dir,
      composeFile: app.composeFile,
      webService: app.webService,
      webPort: app.webPort,
    });
    app.host = target.host;
    app.port = target.port;
    app.status = 'running';
    persistStatus(app);
    return { status: app.status, port: app.port };
  }
  await stopApp(projectId);
  app.stopRequested = false;
  app.restarts = 0;
  app.port = null;
  app.port = await allocatePort();
  startProcess(app);
  return { status: app.status, port: app.port };
}

// ---------------------------------------------------------------------------
// Projetos Docker Compose
// ---------------------------------------------------------------------------

async function deployDockerApp(payload) {
  const key = String(payload.projectId);
  await stopApp(key);

  const dir = path.resolve(STORAGE, payload.storageKey);
  await fsp.access(dir);

  const composeFile = payload.composeFile || (await docker.findComposeFile(dir));
  if (!composeFile) {
    throw new Error('Não encontrei um arquivo docker-compose.yml (ou compose.yaml) no projeto.');
  }

  const projectName = docker.projectNameFor(payload.slug);
  const env = payload.env || {};

  await docker.composeUp({ projectName, dir, composeFile, env });
    // O projeto precisa alcançar o Postgres do Hostfy (alias "db").
  await docker.attachDatabasesNetwork(projectName).catch(() => {});
  const target = await docker.resolveWebTarget({
    projectName,
    dir,
    composeFile,
    webService: payload.webService,
    webPort: payload.webPort,
  });

  const existing = apps.get(key);
  const app = existing || { logs: [] };
  Object.assign(app, {
    projectId: key,
    kind: 'docker',
    type: 'docker',
    storageKey: payload.storageKey,
    slug: payload.slug,
    dir,
    composeFile,
    projectName,
    webService: target.service,
    webPort: target.port,
    host: target.host,
    port: target.port,
    env,
    status: 'running',
    restarts: 0,
    stopRequested: false,
    lastError: null,
    child: null,
  });
  apps.set(key, app);
  persistStatus(app);
  return { status: 'running', port: target.port, host: target.host, service: target.service, type: 'docker' };
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
    if (app.slug !== slug || app.status !== 'running') continue;
    if (app.kind === 'docker' ? app.host : app.child) return app;
  }
  return null;
}

// Cache curto do tipo/storage do projeto por slug, para não consultar o banco
// a cada ativo (CSS, JS, imagens) de um site estático.
const identityCache = new Map(); // slug -> { type, storageKey, at }
const IDENTITY_TTL_MS = 15000;
async function projectIdentity(slug) {
  const cached = identityCache.get(slug);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached;
  const { rows } = await pool.query(
    'SELECT p.type, s.storage_key FROM projects p JOIN project_storage s ON s.project_id=p.id WHERE p.slug=$1',
    [slug]
  );
  const value = {
    type: rows[0] ? rows[0].type : null,
    storageKey: rows[0] ? rows[0].storage_key : null,
    at: Date.now(),
  };
  identityCache.set(slug, value);
  return value;
}

function proxyRequest(req, res, app) {
  const targetHost = app.host || '127.0.0.1';
  const headers = { ...req.headers };
  headers.host = `${targetHost}:${app.port}`;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  delete headers.connection;

  const upstream = http.request(
    { host: targetHost, port: app.port, method: req.method, path: req.url, headers },
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
  const targetHost = app.host || '127.0.0.1';
  const upstream = net.connect(app.port, targetHost, () => {
    const headers = { ...req.headers, host: `${targetHost}:${app.port}` };
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

// Repassa um subdomínio de site estático para o servidor de estáticos, que
// entrega os arquivos do projeto identificado pelo cabeçalho X-Hostfy-Slug.
function proxyStatic(req, res, slug) {
  let base;
  try {
    base = new URL(STATIC_URL);
  } catch {
    return res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Serviço indisponível.');
  }
  const headers = { ...req.headers, host: base.host, 'x-hostfy-slug': slug };
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  delete headers.connection;

  const upstream = http.request(
    { host: base.hostname, port: base.port || 80, method: req.method, path: req.url, headers },
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

const publicServer = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const slug = subdomainSlug(host);
    if (!slug) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Projeto não encontrado.');
    }
    const app = findRunningBySlug(slug);
    if (app) return proxyRequest(req, res, app);

    const identity = await projectIdentity(slug);
    if (!identity.type) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Projeto não encontrado.');
    }
    // Sites estáticos não precisam de processo: o servidor de estáticos entrega os arquivos.
    if (identity.type === 'static' && STATIC_URL) return proxyStatic(req, res, slug);

    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Projeto indisponível no momento.');
  } catch (e) {
    console.error(`[runner] falha no proxy: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Erro interno.');
  }
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
      if (!app) return send(res, 200, { logs: [] });
      if (app.kind === 'docker') {
        const text = await docker
          .composeLogs({ projectName: app.projectName, dir: app.dir, composeFile: app.composeFile })
          .catch(() => '');
        const logs = text
          .split('\n')
          .filter(Boolean)
          .map(line => ({ t: Date.now(), stream: 'docker', line }));
        return send(res, 200, { logs });
      }
      return send(res, 200, { logs: app.logs });
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

    if (req.method === 'GET' && parts[0] === 'capabilities') {
      const dockerAvailable = await docker.available();
      return send(res, 200, {
        runtime: true,
        docker: dockerAvailable,
        dockerVersion: dockerAvailable ? await docker.serverVersion() : null,
        cleanupGraceHours: cleanup.GRACE_HOURS,
      });
    }
    if (req.method === 'GET' && parts[0] === 'stats' && parts.length === 2) {
      return send(res, 200, await statsFor(parts[1]));
    }
    if (req.method === 'GET' && parts[0] === 'stats') {
      const out = {};
      for (const app of apps.values()) out[app.projectId] = await statsFor(app.projectId);
      return send(res, 200, { stats: out });
    }

    if (req.method === 'POST' && parts[0] === 'docker' && parts[1] === 'deploy') {
      const body = await readJson(req);
      return send(res, 200, await deployDockerApp(body));
    }
    if (req.method === 'POST' && parts[0] === 'docker' && parts[1] === 'down') {
      const body = await readJson(req);
      const app = apps.get(String(body.projectId));
      if (!app || app.kind !== 'docker') return send(res, 404, { error: 'Projeto Docker não encontrado no runner.' });
      await docker.composeDown({ projectName: app.projectName, dir: app.dir, composeFile: app.composeFile });
      app.status = 'stopped';
      persistStatus(app);
      return send(res, 200, { ok: true, status: 'stopped' });
    }
    if (req.method === 'POST' && parts[0] === 'docker' && parts[1] === 'restart') {
      const body = await readJson(req);
      return send(res, 200, await restartApp(String(body.projectId)));
    }
    if (req.method === 'GET' && parts[0] === 'docker' && parts[1] === 'df') {
      return send(res, 200, { df: await docker.diskUsage(), containers: await docker.listContainers() });
    }
    if (req.method === 'GET' && parts[0] === 'docker' && parts[1] === 'containers') {
      return send(res, 200, { containers: await docker.listContainers() });
    }
    if (req.method === 'POST' && parts[0] === 'docker' && parts[1] === 'prune') {
      const body = await readJson(req);
      const impact = await cleanup.pruneImpact(pool, { volumes: Boolean(body.volumes) });
      let output = null;
      if (body.force) {
        if (!(await docker.available())) throw new Error('O Docker não está disponível neste host.');
        output = await docker.prune({ volumes: Boolean(body.volumes) });
      }
      return send(res, 200, { impact, executed: Boolean(body.force), output });
    }
    if (req.method === 'POST' && parts[0] === 'cleanup' && parts[1] === 'scan') {
      return send(res, 200, await cleanup.scan(pool));
    }
    if (req.method === 'POST' && parts[0] === 'cleanup' && parts[1] === 'run') {
      return send(res, 200, await cleanup.runDue(pool));
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

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_storage (
      project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE
    );
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS compose_file TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_service TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_port INTEGER;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS env_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT,
      action TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
      ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cleanup_candidates (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      name TEXT,
      project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
      owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      size_bytes BIGINT,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scheduled_for TIMESTAMPTZ,
      notified_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cleanup_candidates_active_idx
      ON cleanup_candidates(kind, resource_id) WHERE status NOT IN ('executed','skipped');
  `);
}

function startCleanupScheduler() {
  if (!CLEANUP_ENABLED) {
    console.log('[runner] limpeza automática desativada (CLEANUP_ENABLED=false).');
    return;
  }
  const tick = async () => {
    try {
      await cleanup.scan(pool);
      const result = await cleanup.runDue(pool);
      if (result.executed.length) console.log(`[runner] limpeza: ${result.executed.length} recurso(s) removido(s).`);
    } catch (e) {
      console.error(`[runner] falha na limpeza automática: ${e.message}`);
    }
  };
  const interval = Math.max(5, CLEANUP_INTERVAL_MINUTES) * 60 * 1000;
  setInterval(tick, interval);
  setTimeout(tick, 15000);
  console.log(`[runner] limpeza automática a cada ${CLEANUP_INTERVAL_MINUTES} min (carência de ${cleanup.GRACE_HOURS}h).`);
}

async function bootstrap() {
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  await fsp.mkdir(BUILD_HOME, { recursive: true });
  await fsp.mkdir(STORAGE, { recursive: true });
  await fsp.writeFile(ROUTER_PATH, ROUTER_SOURCE);

  await waitForSchema();
  await ensureSchema();

  const dockerAvailable = await docker.available();
  console.log(`[runner] Docker ${dockerAvailable ? 'disponível' : 'indisponível'}.`);

  // Restaura projetos de runtime que já existiam (ex.: após reinício do runner).
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.type, p.docroot, p.start_command,
            p.compose_file, p.web_service, p.web_port, p.env_json, s.storage_key
       FROM projects p
       JOIN project_storage s ON s.project_id = p.id
      WHERE p.type IN ('php','node','docker')`
  );
  for (const row of rows) {
    try {
      if (row.type === 'docker') {
        if (!dockerAvailable) {
          console.log(`[runner] pulando docker ${row.slug} (Docker indisponível).`);
          continue;
        }
        await deployDockerApp({
          projectId: String(row.id),
          storageKey: row.storage_key,
          slug: row.slug,
          composeFile: row.compose_file || null,
          webService: row.web_service || null,
          webPort: row.web_port || null,
          env: row.env_json || {},
        });
      } else {
        await deployApp({
          projectId: String(row.id),
          storageKey: row.storage_key,
          slug: row.slug,
          type: row.type,
          docroot: row.docroot || '',
          startCommand: row.start_command || null,
          env: row.env_json || {},
          rebuild: false,
        });
      }
      console.log(`[runner] restaurado ${row.slug} (${row.type})`);
    } catch (e) {
      console.error(`[runner] falha ao restaurar ${row.slug}: ${e.message}`);
    }
  }

  if (dockerAvailable) startCleanupScheduler();

  publicServer.listen(PUBLIC_PORT, () => console.log(`Hostfy runner proxy on ${PUBLIC_PORT}`));
  controlServer.listen(CONTROL_PORT, () => console.log(`Hostfy runner control on ${CONTROL_PORT}`));
  // Builds de Docker Compose podem levar vários minutos.
  controlServer.requestTimeout = 0;
  controlServer.headersTimeout = 60 * 60 * 1000;
}

bootstrap().catch(e => {
  console.error(e);
  process.exit(1);
});