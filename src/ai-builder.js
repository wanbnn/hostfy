'use strict';

const { setTimeout: pause } = require('node:timers/promises');
const ai = require('./ai');
const preview = require('./ai-preview-client');
const { editablePath, readEntryFile } = require('./ai-template');
const { applyPatch } = require('./ai-patch');

const ENTRY = 'src/App.tsx';
const MAX_REPAIR_ATTEMPTS = 2;

function previewQueue({ userId, draftId, signal, send }) {
  let pending;
  let running;
  let last;
  let scheduledVersion = -1;

  async function buildPending() {
    while (pending && !signal.aborted) {
      await pause(350, undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
      const { files, version } = pending;
      pending = null;
      send('build', { version });
      try {
        const result = await preview.update(userId, files, { draftId, signal });
        last = { ...result, version };
        send('preview', { url: result.url, version });
      } catch (error) {
        if (!signal.aborted) last = { error, version };
      }
    }
  }

  return {
    schedule(files, version) {
      if (!preview.enabled() || scheduledVersion === version || signal.aborted) return;
      scheduledVersion = version;
      pending = { files, version };
      if (!running) running = buildPending().finally(() => { running = null; });
    },
    async finish() {
      await running;
      return last;
    },
  };
}

function readDraft(existingFiles) {
  const files = new Map();
  for (const file of existingFiles) {
    let rel;
    try { rel = editablePath(file.path); } catch { continue; }
    if (rel) files.set(rel, { path: rel, content: file.content });
  }
  return files;
}

async function generate({ userId, draftId, description, existingFiles, previewDiagnostic, signal, send }) {
  const files = readDraft(existingFiles);
  const starter = { path: ENTRY, content: await readEntryFile() };
  const queue = previewQueue({ userId, draftId, signal, send });
  let version = 0;

  function hasEntry() {
    const entry = files.get(ENTRY);
    return Boolean(entry?.content.trim() && entry.content !== starter.content);
  }

  async function attempt(diagnostic) {
    const initialVersion = version;
    const base = new Map(files);
    if (!base.has(ENTRY)) base.set(ENTRY, starter);
    const seen = new Map();
    const failures = new Map();
    const apply = operation => {
      const previous = seen.get(operation.path);
      if (previous?.op === operation.op && previous.content === operation.content &&
          previous.patch === operation.patch) return;
      seen.set(operation.path, operation);

      const current = base.get(operation.path);
      let content = operation.content;
      try {
        if (operation.op === 'patch') {
          if (!current) throw new Error('O arquivo não existe para aplicar o patch.');
          content = applyPatch(current.content, operation.patch);
        }
      } catch (error) {
        failures.set(operation.path, error.message);
        return;
      }

      failures.delete(operation.path);
      if (files.get(operation.path)?.content === content || (!files.has(operation.path) && current?.content === content)) return;
      const file = { path: operation.path, content };
      files.set(operation.path, file);
      send('file', { op: operation.op, ...file, version: ++version });
      if (hasEntry()) queue.schedule([...files.values()], version);
    };

    let outputError;
    let generationError;
    try {
      let writing = false;
      const operations = await ai.requestOperations({
        description,
        diagnostic,
        existingFiles: [...base.values()],
        onContent: () => {
          if (!writing) send('writing', {});
          writing = true;
        },
        onOperation: apply,
        onPending: path => send('writing', { path }),
        signal,
      });
      operations.forEach(apply);
    } catch (error) {
      signal.throwIfAborted();
      if (error.code === 'AI_OUTPUT') outputError = error.message;
      else generationError = error.message;
    }

    const built = await queue.finish();
    signal.throwIfAborted();
    const problems = [
      built?.error?.code === 'PREVIEW_BUILD' && built.error.message,
      outputError,
      ...[...failures].map(([file, error]) => file + ': ' + error),
      !hasEntry() && 'A primeira tela precisa ser implementada em src/App.tsx.',
      previewDiagnostic && !version && 'A tentativa de correção não alterou os arquivos.',
    ].filter(Boolean);
    return { built, problems, generationError, changed: version !== initialVersion };
  }

  let result = await attempt(previewDiagnostic);
  let repairs = 0;
  while (repairs < MAX_REPAIR_ATTEMPTS && result.problems.length && !result.generationError) {
    repairs++;
    send('repair', {});
    const { built, problems, changed } = result;
    result = await attempt([
      !changed && built?.error?.code === 'PREVIEW_BUILD' &&
        'A tentativa anterior deixou o código igual. Use o arquivo atual para aplicar uma alteração que elimine o erro.',
      ...problems,
      built?.error?.code !== 'PREVIEW_BUILD' && previewDiagnostic,
    ].filter(Boolean).join('\n\n'));
  }

  const { built, problems, generationError } = result;
  const previewError = built?.error?.message;
  return {
    files: [...files.values()],
    model: ai.DEFAULT_MODEL,
    version,
    repaired: repairs > 0,
    generationError: generationError || problems.find(problem => problem !== previewError),
    previewError,
    previewRepairable: built?.error?.code === 'PREVIEW_BUILD',
    previewDisabled: !preview.enabled(),
    ready: Boolean(built?.ready && built.version === version && !generationError && !problems.length),
  };
}

module.exports = { generate };
