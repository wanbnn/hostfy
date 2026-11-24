'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { applyPatch } = require('../src/ai-patch');

const root = path.resolve(__dirname, '..');
const appFile = content => ({ path: 'src/App.tsx', op: 'update', content });
const component = title => 'export default function App() { return <h1>' + title + '</h1> }';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function token(res, content) {
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
}

function endStream(res) {
  res.end('data: [DONE]\n\n');
}

test('applyPatch accepts the trailing newline of a unified diff', () => {
  assert.equal(applyPatch('before\nafter\n', '@@ -1,1 +1,1 @@\n-before\n+new\n'), 'new\nafter\n');
  assert.equal(applyPatch('before\nafter\n', '@@ -1,0 +2,1 @@\n+middle\n'), 'before\nmiddle\nafter\n');
});

test('AI Builder publishes revisions before the model finishes and repairs a build failure', { timeout: 45000 }, async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hostfy-ai-test-'));
  const portProbe = http.createServer();
  const previewPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));

  let releaseModel;
  const gate = new Promise(resolve => { releaseModel = resolve; });
  const prompts = [];
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages[1].content;
    prompts.push(prompt);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (prompt.includes('incremental fixture')) {
      token(res, '{"operations":[' + JSON.stringify(appFile(component('Primeira etapa'))));
      await gate;
      token(res, ',' + JSON.stringify(appFile(component('Etapa final'))) + ']}');
    } else if (prompt.includes('repair fixture')) {
      const source = prompt.includes('implementação parcial')
        ? component('Aplicação corrigida')
        : 'import Missing from "./missing"; export default () => <Missing />';
      const entry = JSON.stringify({ operations: [appFile(source)] });
      token(res, entry.slice(0, 53));
      token(res, entry.slice(53));
    } else {
      token(res, '{"operations":[{"op":"update","path":"src/App.tsx","content":"');
      return;
    }
    endStream(res);
  });
  const providerPort = await listen(provider);
  const worker = spawn(process.execPath, ['src/ai-preview.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      AI_PREVIEW_PORT: String(previewPort),
      AI_PREVIEW_HOST: '127.0.0.1',
      AI_PREVIEW_DIR: storage,
      AI_PREVIEW_TOKEN: 'test-only',
    },
  });
  const workerBase = 'http://127.0.0.1:' + previewPort;
  t.after(async () => {
    releaseModel();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    if (worker.exitCode === null && worker.signalCode === null) {
      const stopped = once(worker, 'exit');
      worker.kill();
      await stopped;
    }
    await fs.rm(storage, { recursive: true, force: true });
  });
  const [ready] = await once(worker.stdout, 'data');
  assert.match(String(ready), /ouvindo/);

  Object.assign(process.env, {
    AI_BASE_URL: 'http://127.0.0.1:' + providerPort,
    AI_API_KEY: 'test-only',
    AI_TIMEOUT_MS: '12000',
    AI_PREVIEW_ENABLED: 'true',
    AI_PREVIEW_TOKEN: 'test-only',
    AI_PREVIEW_SERVICE_URL: workerBase,
  });
  const { generate } = require('../src/ai-builder');

  async function readBundle(url) {
    const headers = { Authorization: 'Bearer test-only' };
    const page = await fetch(workerBase + url, { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    const [source] = html.match(/\/__ai-preview\/[^"]+\.js/);
    assert.ok(source.startsWith(url));
    const asset = await fetch(workerBase + source, { headers });
    assert.equal(asset.status, 200);
    return asset.text();
  }

  const urls = [];
  const events = [];
  const result = await generate({
    userId: 'test',
    draftId: 'creation',
    description: 'incremental fixture',
    existingFiles: [],
    signal: new AbortController().signal,
    send(event, data) {
      events.push(event);
      if (event === 'preview') {
        urls.push(data.url);
        releaseModel();
      }
    },
  });
  assert.equal(result.ready, true, [result.previewError, result.generationError].filter(Boolean).join('\n'));
  assert.equal(result.repaired, false);
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
  assert.match(await readBundle(urls[0]), /Primeira etapa/);
  assert.match(await readBundle(urls[1]), /Etapa final/);
  assert.ok(events.indexOf('preview') < events.lastIndexOf('file'));

  const repairEvents = [];
  const repaired = await generate({
    userId: 'test',
    draftId: 'repair',
    description: 'repair fixture',
    existingFiles: [],
    signal: new AbortController().signal,
    send(event) { repairEvents.push(event); },
  });
  assert.equal(repaired.ready, true, [repaired.previewError, repaired.generationError].filter(Boolean).join('\n'));
  assert.equal(repaired.repaired, true);
  assert.match(repaired.files[0].content, /Aplicação corrigida/);
  assert.equal(repairEvents.filter(event => event === 'repair').length, 1);
  assert.equal(repairEvents.filter(event => event === 'preview').length, 1);
  assert.match(prompts.at(-1), /missing/);

  const controller = new AbortController();
  const pending = [];
  await assert.rejects(generate({
    userId: 'test',
    draftId: 'cancel',
    description: 'cancel fixture',
    existingFiles: [],
    signal: controller.signal,
    send(event, data) {
      if (event === 'writing' && data.path) {
        pending.push(data.path);
        controller.abort();
      }
    },
  }), { name: 'AbortError' });
  assert.deepEqual(pending, ['src/App.tsx']);
});
