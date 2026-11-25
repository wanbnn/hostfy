'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const { applyPatch } = require('../src/ai-patch');

const root = path.resolve(__dirname, '..');
const appFile = content => ({ path: 'src/App.tsx', op: 'update', content });
const component = title => 'export default function App() { return <h1>' + title + '</h1> }';
const swapPath = 'src/components/schedule/SwapPanel.tsx';
const fixedSwap = 'export default function SwapPanel() {\n  return <div className={"p-3 rounded-lg"}>Análise inteligente</div>;\n}';
const brokenSwap = fixedSwap.replace('}>', '}>}');
const swapFile = content => ({ path: swapPath, op: 'update', content });
const swapApp = appFile('import SwapPanel from "./components/schedule/SwapPanel"; export default () => <SwapPanel />');

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

test('the preview reports its own JavaScript failures without discarding apps when analytics are blocked', async () => {
  const base = 'https://panel.example.test/__ai-preview/test/revision/';
  const runtime = await fs.readFile(path.join(root, 'src/ai-preview-runtime.js'), 'utf8');
  class Script {
    constructor(src, type = 'module') { Object.assign(this, { src, type }); }
  }
  const handlers = {};
  const reports = [];
  vm.runInNewContext(runtime, {
    URL,
    HTMLScriptElement: Script,
    document: { currentScript: { src: base + 'ai-preview-runtime.js' }, baseURI: base },
    window: {
      addEventListener(name, listener) { handlers[name] = listener; },
      parent: { postMessage: report => reports.push({ ...report }) },
    },
  });

  handlers.error({ target: new Script('https://static.cloudflareinsights.com/beacon.min.js') });
  handlers.error({ message: 'Inline script blocked', filename: base });
  handlers.unhandledrejection({ reason: { message: 'Analytics failed', stack: 'https://static.cloudflareinsights.com/beacon.min.js:1' } });
  assert.deepEqual(reports, []);

  const entry = base + 'assets/index-test.js';
  handlers.error({ target: new Script(entry) });
  handlers.error({ message: 'React runtime error', filename: entry });
  handlers.unhandledrejection({ reason: { message: 'App rejection', stack: entry + ':1:2' } });
  assert.deepEqual(reports, [
    { type: 'hostfy-preview-error', kind: 'load', error: 'Falha ao carregar index-test.js.' },
    { type: 'hostfy-preview-error', kind: 'runtime', error: 'React runtime error' },
    { type: 'hostfy-preview-error', kind: 'runtime', error: 'App rejection' },
  ]);
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
      const source = prompt.includes('Diagnóstico para correção:')
        ? component('Aplicação corrigida')
        : 'import Missing from "./missing"; export default () => <Missing />';
      const entry = JSON.stringify({ operations: [appFile(source)] });
      token(res, entry.slice(0, 53));
      token(res, entry.slice(53));
    } else if (prompt.includes('retry JSX fixture') || prompt.includes('broken JSX fixture')) {
      const attempts = prompts.filter(text => text.includes('retry JSX fixture')).length;
      const source = prompt.includes('retry JSX fixture') && attempts > 2 ? fixedSwap : brokenSwap;
      token(res, JSON.stringify({ operations: [swapFile(source), swapApp] }));
    } else if (prompt.includes('manual JSX fixture')) {
      token(res, JSON.stringify({ operations: [swapFile(fixedSwap)] }));
    } else if (prompt.includes('incomplete fixture')) {
      token(res, JSON.stringify({ operations: [appFile(component('Etapa parcial'))] }));
      res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'length' }] }) + '\n\n');
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
  const panel = express();
  panel.use('/__ai-preview', require('../src/ai-preview-client').serve);
  const panelServer = http.createServer(panel);
  const panelBase = 'http://127.0.0.1:' + await listen(panelServer);
  t.after(async () => {
    panelServer.closeAllConnections();
    await new Promise(resolve => panelServer.close(resolve));
  });

  async function readBundle(url) {
    const page = await fetch(panelBase + url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control'), /\bno-transform\b/);
    assert.match(page.headers.get('content-security-policy'), /\bsandbox\b/);
    const html = await page.text();
    const [, source] = html.match(/type="module"[^>]*src="([^"]+)"/);
    const runtimePath = url + 'ai-preview-runtime.js';
    assert.ok(html.indexOf(runtimePath) >= 0 && html.indexOf(runtimePath) < html.indexOf(source));
    assert.doesNotMatch(html, /<script\s*>/);
    const runtime = await fetch(panelBase + runtimePath);
    assert.equal(runtime.status, 200);
    assert.match(await runtime.text(), /hostfy-preview-error/);
    assert.ok(source.startsWith(url));
    const asset = await fetch(panelBase + source, { headers: { Origin: 'null' } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('access-control-allow-origin'), '*');
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

  const jsxEvents = [];
  const jsxResult = await generate({
    userId: 'test',
    draftId: 'retry-jsx',
    description: 'retry JSX fixture',
    existingFiles: [],
    signal: new AbortController().signal,
    send(event) { jsxEvents.push(event); },
  });
  assert.equal(jsxResult.ready, true, jsxResult.previewError);
  assert.equal(jsxEvents.filter(event => event === 'repair').length, 2);
  assert.match(prompts.at(-1), /A tentativa anterior deixou o código igual/);
  assert.match(prompts.at(-1), /src\/components\/schedule\/SwapPanel\.tsx:2:\d+/);
  assert.match(prompts.at(-1), /The character "}" is not valid inside a JSX element/);

  const failed = await generate({
    userId: 'test',
    draftId: 'broken-jsx',
    description: 'broken JSX fixture',
    existingFiles: [],
    signal: new AbortController().signal,
    send() {},
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.previewRepairable, true);
  assert.match(failed.previewError, /src\/components\/schedule\/SwapPanel\.tsx:2:\d+/);
  assert.doesNotMatch(failed.previewError, /SecurityWarning: The flag --allow-/);
  assert.equal(prompts.filter(prompt => prompt.includes('broken JSX fixture')).length, 3);

  const manualDescription = 'manual JSX fixture '.padEnd(4000, 'a');
  const manuallyRepaired = await generate({
    userId: 'test',
    draftId: 'broken-jsx',
    description: manualDescription,
    existingFiles: failed.files,
    previewDiagnostic: failed.previewError,
    signal: new AbortController().signal,
    send() {},
  });
  assert.ok(prompts.at(-1).includes(failed.previewError));
  assert.ok(prompts.at(-1).includes(manualDescription));
  assert.ok(prompts.at(-1).includes(brokenSwap));
  assert.equal(manuallyRepaired.ready, true, manuallyRepaired.previewError);
  assert.deepEqual(manuallyRepaired.files.find(file => file.path === swapPath), { path: swapPath, content: fixedSwap });

  const incomplete = await generate({
    userId: 'test',
    draftId: 'incomplete',
    description: 'incomplete fixture',
    existingFiles: [],
    signal: new AbortController().signal,
    send() {},
  });
  assert.match(incomplete.generationError, /limite de tokens/);
  assert.equal(incomplete.previewError, undefined);
  assert.equal(incomplete.ready, false);

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
