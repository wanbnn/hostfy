'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'templates', 'react-shadcn');
const PORT = Number(process.env.AI_PREVIEW_PORT || 1595);
const HOST = process.env.AI_PREVIEW_HOST || '0.0.0.0';
const PUBLIC_URL = String(process.env.AI_PREVIEW_PUBLIC_URL || '').replace(/\/$/, '');
const TOKEN = String(process.env.AI_PREVIEW_TOKEN || '');
const STORAGE = path.resolve(process.env.AI_PREVIEW_DIR || path.join(ROOT, 'data', 'ai-previews'));
const ALLOWED_ORIGINS = String(process.env.AI_PREVIEW_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const MAX_BODY = 4 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = Number(process.env.AI_PREVIEW_INSTALL_TIMEOUT_MS || 300000);
const sessions = new Map();
const PORT_RANGE_START = Number(process.env.AI_PREVIEW_VITE_PORT_START || 18000);
const PORT_RANGE_END = Number(process.env.AI_PREVIEW_VITE_PORT_END || 18100);
const usedPorts = new Set();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) reject(new Error('Payload de preview muito grande.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON invÃ¡lido.')); }
    });
    req.on('error', reject);
  });
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function publicHostAllowed(host) {
  if (!PUBLIC_URL) return true;
  const configured = new URL(PUBLIC_URL).host.toLowerCase();
  const incoming = String(host || '').toLowerCase();
  const hosts = new Set([configured, 'localhost', '127.0.0.1', '::1']);
  return hosts.has(incoming);
}

function setPreviewHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * ws: wss:; frame-ancestors 'self'");
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.headers['x-hostfy-session']) {
    const session = sessions.get(String(req.headers['x-hostfy-session']));
    if (session) {
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `ai_preview_session=${session.id}; Path=/__ai-preview/${session.id}/; SameSite=Lax; HttpOnly${secure}`);
    }
  }
}

function safePath(input) {
  const rel = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  return rel;
}

async function writeFiles(dir, files) {
  const allowed = new Set((files || []).map(file => safePath(file?.path)).filter(Boolean));
  const keep = new Set(['package.json', 'package-lock.json', 'vite.config.ts', 'vite.config.js', 'tsconfig.json', 'tsconfig.node.json', 'tailwind.config.js', 'tailwind.config.ts', 'postcss.config.js', 'postcss.config.cjs', 'components.json', 'server.js', 'index.html', 'src/main.tsx', 'src/index.css', 'src/lib/utils.ts']);
  async function prune(dir, base = dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await prune(full, base);
        const remaining = await fs.readdir(full).catch(() => []);
        if (!remaining.length) await fs.rmdir(full).catch(() => {});
      }
      else {
        const rel = path.relative(base, full).replace(/\\/g, '/');
        if (!keep.has(rel) && !allowed.has(rel)) await fs.rm(full, { force: true });
      }
    }
  }
  await prune(dir);
  for (const entry of files || []) {
    const rel = safePath(entry?.path);
    if (!rel || typeof entry.content !== 'string') continue;
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.content, 'utf8');
  }
}

// Instala as dependências do boilerplate no diretório do preview. O Vite só
// consegue iniciar depois que node_modules existe; sem isso o preview falha.
// Reaproveita node_modules de um preview anterior (mesmo package-lock) para
// evitar reinstalar a cada sessão.
async function ensureDependencies(dir) {
  const modules = path.join(dir, 'node_modules');
  const viteBin = path.join(modules, 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(viteBin)) return;
  const lock = path.join(dir, 'package-lock.json');
  const hasLock = fsSync.existsSync(lock);
  const cache = path.join(STORAGE, '.deps-cache');
  const cached = path.join(cache, 'node_modules');
  if (hasLock && fsSync.existsSync(path.join(cached, 'vite', 'bin', 'vite.js'))) {
    await fs.cp(cached, modules, { recursive: true });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + String(chunk)).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Tempo esgotado ao instalar as dependências do preview.'));
    }, INSTALL_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Falha ao instalar as dependências do preview (código ${code}). ${output.slice(-1200)}`));
    });
  });
  if (hasLock) {
    await fs.mkdir(cache, { recursive: true });
    await fs.cp(modules, cached, { recursive: true }).catch(() => {});
  }
}

async function startSession(id, files) {
  let session = sessions.get(id);
  if (!session) {
    session = { id, dir: path.join(STORAGE, id), process: null, port: null, vitePort: null, starting: null, logs: [], updating: false };
    sessions.set(id, session);
  }
  while (session.updating) await new Promise(resolve => setTimeout(resolve, 25));
  session.updating = true;
  try {
  const dir = path.join(STORAGE, id);
  session.dir = dir;
  if (!(await fs.stat(dir).catch(() => null))) {
    await fs.mkdir(dir, { recursive: true });
    await fs.cp(TEMPLATE, dir, { recursive: true });
  }
  await writeFiles(dir, files);
  await ensureDependencies(dir);
  if (session.process && session.process.exitCode === null) {
    const current = session.process;
    session.process.kill();
    await new Promise(resolve => current.once('exit', resolve));
  }
  if (!session.vitePort) {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
      if (usedPorts.has(port)) continue;
      usedPorts.add(port);
      session.vitePort = port;
      break;
    }
    if (!session.vitePort) throw new Error('Limite de previews simultÃ¢neos atingido.');
  }
  session.starting = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(session.vitePort), '--strictPort'], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1', NODE_ENV: 'development' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      session.process = child;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('Tempo esgotado ao iniciar o preview.'));
      }, 30000);
      const inspect = chunk => {
        const text = String(chunk);
        session.logs.push(text);
        const match = text.includes(`127.0.0.1:${session.vitePort}`) || text.includes(`localhost:${session.vitePort}`);
        if (match && !session.port) {
          session.port = session.vitePort;
          clearTimeout(timeout);
          session.starting = null;
          settled = true;
          resolve();
        }
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.on('error', error => {
        clearTimeout(timeout);
        session.port = null;
        session.starting = null;
        if (!settled) { settled = true; reject(error); }
      });
      child.on('exit', code => {
        const hadPort = Boolean(session.port);
        session.port = null;
        session.starting = null;
        if (!hadPort && !settled) {
          clearTimeout(timeout);
          settled = true;
          reject(new Error(`Servidor de preview saiu com cÃ³digo ${code}. ${session.logs.join('').slice(-1200)}`));
        }
      });
    });
  if (session.starting) await session.starting;
  return session;
  } catch (error) {
    session.port = null;
    session.starting = null;
    session.process?.kill();
    session.process = null;
    throw error;
  } finally {
    session.updating = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return respond(res, 401, { error: 'NÃ£o autorizado.' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/__ai-preview/') && req.method !== 'POST') {
      const id = url.pathname.split('/')[2];
      const targetPath = `${url.pathname.replace(/^\/__ai-preview\/[a-zA-Z0-9_-]+/, '') || '/'}${url.search}`;
      const session = sessions.get(id);
      if (!session?.port) return respond(res, 404, { error: 'Preview nÃ£o encontrado.' });
      setPreviewHeaders(req, res);
      const headers = { ...req.headers, host: `127.0.0.1:${session.port}` };
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-proto'];
      const upstream = http.request({ hostname: '127.0.0.1', port: session.port, path: targetPath, method: req.method, headers }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.statusCode = 502; res.end('Preview indisponÃ­vel.'); });
      return req.pipe(upstream);
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = await readBody(req);
      const id = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      if (!id) return respond(res, 400, { error: 'Identificador do preview invÃ¡lido.' });
      const session = await startSession(id, body.files);
      // O painel acessa o preview pelo proxy same-origin (/__ai-preview). O host
      // público vem de x-forwarded-host (enviado pelo proxy) ou do Host da
      // requisição. AI_PREVIEW_PUBLIC_URL só é usado como último recurso, pois
      // costuma apontar para o endereço interno do serviço (127.0.0.1:1595).
      const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      const host = forwardedHost || req.headers.host;
      const protocol = req.headers['x-forwarded-proto'] || (PUBLIC_URL ? new URL(PUBLIC_URL).protocol.slice(0, -1) : 'http');
      const publicBase = host ? `${protocol}://${host}` : PUBLIC_URL;
      return respond(res, 200, { url: `${publicBase}/__ai-preview/${id}/?session=${id}`, port: session.port });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/sessions/')) {
      const match = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/files$/);
      if (!match) return respond(res, 404, { error: 'Rota nÃ£o encontrada.' });
      const session = sessions.get(match[1]);
      if (!session) return respond(res, 404, { error: 'Preview nÃ£o encontrado.' });
      const body = await readBody(req);
      await writeFiles(session.dir, body.files);
      return respond(res, 200, { ok: true });
    }
    const match = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)(\/.*)?$/);
    if (match && req.method === 'DELETE') {
      const session = sessions.get(match[1]);
      if (session) {
        while (session.updating) await new Promise(resolve => setTimeout(resolve, 25));
        session.process?.kill();
        if (session.vitePort) usedPorts.delete(session.vitePort);
        sessions.delete(match[1]);
        await fs.rm(session.dir, { recursive: true, force: true });
      }
      return respond(res, 200, { ok: true });
    }
    if (match && (req.method === 'GET' || req.method === 'HEAD')) {
      const session = sessions.get(match[1]);
      if (!session?.port) return respond(res, 404, { error: 'Preview nÃ£o encontrado.' });
      setPreviewHeaders(req, res);
      const upstream = http.request({ hostname: '127.0.0.1', port: session.port, path: `${match[2] || '/'}${url.search}`, method: req.method, headers: req.headers }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => respond(res, 502, { error: 'O servidor de preview ficou indisponÃ­vel.' }));
      return req.pipe(upstream);
    }
    return respond(res, 404, { error: 'Rota nÃ£o encontrada.' });
  } catch (error) {
    return respond(res, 400, { error: error.message || 'Falha ao preparar o preview.' });
  }
});

server.listen(PORT, HOST, () => console.log(`[ai-preview] ouvindo em ${HOST}:${PORT}`));

server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, 'http://localhost');
  if (parsed.pathname === '/__ai-preview-hmr') {
    const sessionId = req.headers.cookie?.match(/(?:^|;\s*)ai_preview_session=([a-zA-Z0-9_-]+)/)?.[1];
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session?.port) return socket.destroy();
    const upstream = net.connect(session.port, '127.0.0.1', () => {
      let raw = `${req.method} /__ai-preview-hmr${parsed.search} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(req.headers)) raw += `${name}: ${value}\r\n`;
      raw += '\r\n';
      upstream.write(raw);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    return;
  }
  if (parsed.pathname.startsWith('/__ai-preview/')) {
    const id = parsed.pathname.split('/')[2];
    const session = sessions.get(id);
    if (!session?.port) return socket.destroy();
    const targetPath = `${parsed.pathname.replace(/^\/__ai-preview\/[a-zA-Z0-9_-]+/, '') || '/'}${parsed.search}`;
    const upstream = net.connect(session.port, '127.0.0.1', () => {
      let raw = `${req.method} ${targetPath} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(req.headers)) raw += `${name}: ${value}\r\n`;
      raw += '\r\n';
      upstream.write(raw);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    return;
  }
  const match = new URL(req.url, 'http://localhost').pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  const session = match ? sessions.get(match[1]) : null;
  if (!session?.port) return socket.destroy();
  const upstream = net.connect(session.port, '127.0.0.1', () => {
    let raw = `${req.method} ${match[2] || '/'}${parsed.search} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(req.headers)) raw += `${name}: ${value}\r\n`;
    raw += '\r\n';
    upstream.write(raw);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
