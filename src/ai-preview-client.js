'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const PORT = Number(process.env.AI_PREVIEW_PORT || 1595);
const HOST = process.env.AI_PREVIEW_HOST;
const LOOPBACK = !HOST || HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
const BASE = new URL(process.env.AI_PREVIEW_SERVICE_URL || 'http://' + LOOPBACK + ':' + PORT);
const TOKEN = String(process.env.AI_PREVIEW_TOKEN || '');
const TIMEOUT_MS = Number(process.env.AI_PREVIEW_INSTALL_TIMEOUT_MS || 300000) + 60000;
const authentication = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

function enabled() {
  return process.env.AI_PREVIEW_ENABLED !== 'false';
}

function validDraftId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,80}$/i.test(value);
}

async function update(userId, files, { draftId = '', signal } = {}) {
  if (!enabled()) throw Object.assign(new Error('O preview ao vivo está desativado neste servidor.'), { status: 503 });
  const id = crypto.createHash('sha256').update(String(userId) + '\0' + draftId).digest('hex');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetch(new URL('/sessions', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authentication },
      body: JSON.stringify({ id, files }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Object.assign(new Error('O serviço de preview está indisponível. Tente atualizar novamente.'), { status: 503 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Falha ao preparar o preview.'), {
    code: data.code,
    status: response.status,
  });
  if (!data.url?.startsWith('/__ai-preview/')) {
    throw Object.assign(new Error('O serviço de preview não devolveu uma versão válida.'), { status: 502 });
  }
  return data;
}

function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);
  const target = new URL(BASE);
  target.pathname = req.originalUrl.split('?')[0];
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: req.method, headers: authentication }, response => {
    const headers = {
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-modals allow-downloads; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
    };
    for (const name of ['content-type', 'content-length']) {
      if (response.headers[name]) headers[name] = response.headers[name];
    }
    res.writeHead(response.statusCode, headers);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).type('text').send('Preview indisponível.');
    else res.destroy();
  });
  res.on('close', () => upstream.destroy());
  upstream.end();
}

module.exports = { enabled, validDraftId, update, serve };
