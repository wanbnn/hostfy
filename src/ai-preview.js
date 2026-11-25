'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { TEMPLATE_DIR, copyTemplate, editablePath, checkSource } = require('./ai-template');

const exec = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AI_PREVIEW_PORT || 1595);
const HOST = process.env.AI_PREVIEW_HOST || '127.0.0.1';
const TOKEN = String(process.env.AI_PREVIEW_TOKEN || '');
const STORAGE = path.resolve(process.env.AI_PREVIEW_DIR || path.join(ROOT, 'data', 'ai-previews'));
const ARTIFACTS = path.join(STORAGE, 'revisions');
const MODULES = path.join(TEMPLATE_DIR, 'node_modules');
const VITE = path.join(MODULES, 'vite', 'bin', 'vite.js');
const INSTALL_TIMEOUT_MS = Number(process.env.AI_PREVIEW_INSTALL_TIMEOUT_MS || 300000);
const BUILD_TIMEOUT_MS = 30000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

const RUNTIME_FILE = 'ai-preview-runtime.js';

let installing;
async function ensureDependencies() {
  if (installing) return installing;
  installing = (async () => {
    try {
      await fs.access(VITE);
    } catch {
      await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: TEMPLATE_DIR,
        shell: process.platform === 'win32',
        timeout: INSTALL_TIMEOUT_MS,
        windowsHide: true,
      });
    }
  })();
  try {
    await installing;
  } catch (error) {
    installing = null;
    throw error;
  }
}

const waiters = [];
let activeBuilds = 0;
async function withBuildSlot(build) {
  if (activeBuilds >= 2) {
    if (waiters.length >= 8) {
      throw Object.assign(new Error('O preview está ocupado. Tente atualizar novamente em instantes.'), { status: 503 });
    }
    await new Promise(resolve => waiters.push(resolve));
  } else {
    activeBuilds++;
  }
  try {
    return await build();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeBuilds--;
  }
}

async function render(id, files, signal) {
  await ensureDependencies();
  signal.throwIfAborted();
  await fs.mkdir(ARTIFACTS, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(STORAGE, 'build-'));
  const revision = crypto.randomUUID();
  const url = '/__ai-preview/' + id + '/' + revision + '/';
  const destination = path.join(ARTIFACTS, id);
  try {
    await copyTemplate(workspace);
    await fs.symlink(MODULES, path.join(workspace, 'node_modules'), 'junction');
    for (const file of files) {
      let rel;
      try { rel = editablePath(file?.path); } catch { continue; }
      if (!rel || typeof file?.content !== 'string') continue;
      try { checkSource(rel, file.content); } catch (error) {
        throw Object.assign(error, { status: 422, code: 'PREVIEW_BUILD' });
      }
      const target = path.join(workspace, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content);
    }
    const output = path.join(workspace, 'dist');
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        /^(path|systemroot|temp|tmp|comspec|windir)$/i.test(name)));
      const readRoots = [MODULES, workspace];
      if (process.platform === 'win32') {
        // Algumas dependências normalizam a letra da unidade.
        readRoots.push(...readRoots.map(dir => dir.replace(/^[A-Z]:/, drive => drive.toLowerCase())));
      }
      await exec(process.execPath, [
        '--permission',
        ...readRoots.map(dir => '--allow-fs-read=' + dir),
        '--allow-fs-write=' + workspace,
        '--allow-child-process',
        '--allow-addons',
        VITE, 'build', '--base', url, '--logLevel', 'error',
      ], {
        cwd: workspace,
        env: { ...env, NO_COLOR: '1', NODE_ENV: 'production' },
        signal,
        timeout: BUILD_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const diagnostic = String(error.stderr || '')
        .replaceAll(workspace + path.sep, '')
        .replaceAll(workspace.replaceAll('\\', '/') + '/', '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split(/\r?\n/)
        .filter(line => !/^\s+at |^\(Use .+--trace-warnings/.test(line))
        .filter(line => !/^\(node:\d+\) (?:\[PERM|SecurityWarning: The flag --allow-(?:addons|child-process)\b)/.test(line))
        .join('\n').trim().slice(0, 4000);
      if (!diagnostic || error.killed) {
        throw Object.assign(new Error('O servidor não conseguiu compilar o preview a tempo. Tente atualizar novamente.'), { status: 503 });
      }
      throw Object.assign(new Error(diagnostic), { status: 422, code: 'PREVIEW_BUILD' });
    }
    signal.throwIfAborted();
    const index = path.join(output, 'index.html');
    const html = await fs.readFile(index, 'utf8');
    const runtimeTag = '<script src="' + url + RUNTIME_FILE + '"></script>\n    ';
    await Promise.all([
      fs.copyFile(path.join(__dirname, RUNTIME_FILE), path.join(output, RUNTIME_FILE)),
      fs.writeFile(index, html.replace(/<script\b(?=[^>]*\btype=["']module["'])/i, match => runtimeTag + match)),
    ]);
    await fs.mkdir(destination, { recursive: true });
    await fs.rename(output, path.join(destination, revision));
    return { ready: true, url };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function expirePreviews() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const id of await fs.readdir(ARTIFACTS)) {
    if (!/^[\w-]+$/.test(id)) continue;
    const directory = path.join(ARTIFACTS, id);
    for (const revision of await fs.readdir(directory).catch(() => [])) {
      const target = path.join(directory, revision);
      const info = await fs.stat(target).catch(() => null);
      if (info?.isDirectory() && info.mtimeMs < cutoff) {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
    await fs.rmdir(directory).catch(() => {});
  }
}

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  if (TOKEN && req.headers.authorization !== 'Bearer ' + TOKEN) return res.sendStatus(401);
  next();
});
app.use('/__ai-preview', express.static(ARTIFACTS, { cacheControl: false, redirect: false }));
app.post(['/sessions', '/sessions/:id/files'], express.json({ limit: '4mb' }), async (req, res) => {
  const id = String(req.params.id || req.body?.id || '');
  if (!/^[\w-]{1,80}$/.test(id)) return res.status(400).json({ error: 'Identificador de preview inválido.' });
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 200) : [];
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await withBuildSlot(() => render(id, files, controller.signal));
    if (!controller.signal.aborted) res.json({ ...result, ok: true });
  } catch (error) {
    if (controller.signal.aborted) return;
    if (!error.status) console.error('[ai-preview]', error);
    res.status(error.status || 503).json({
      code: error.code,
      error: error.status ? error.message : 'Não foi possível preparar o preview no servidor.',
    });
  }
});
app.use((_req, res) => res.status(404).json({ error: 'Preview não encontrado.' }));
app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ error: error.status === 413 ? 'O projeto excede o limite do preview.' : 'Falha ao ler o pedido de preview.' });
});

app.listen(PORT, HOST, () => console.log('[ai-preview] ouvindo em ' + HOST + ':' + PORT));
setInterval(() => expirePreviews().catch(error => {
  if (error.code !== 'ENOENT') console.error('[ai-preview] limpeza:', error.message);
}), 60 * 60 * 1000).unref();
