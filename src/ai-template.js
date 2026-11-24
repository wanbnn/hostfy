'use strict';

// ---------------------------------------------------------------------------
// Template base do AI Builder
//
// O modelo de IA gera apenas os arquivos de aplicação. Aqui mesclamos esses
// arquivos sobre o boilerplate React + shadcn/ui + lucide + recharts, para que
// o modelo não precise (e não possa) reescrever package.json, configs, etc.
//
// O modelo pode enviar operações de três tipos:
//   - create: cria um arquivo novo
//   - update: reescreve o arquivo inteiro
//   - patch:  aplica um unified diff sobre o conteúdo atual
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs/promises');
const { applyPatch } = require('./ai-patch');

const TEMPLATE_DIR = process.env.AI_TEMPLATE_DIR || path.join(__dirname, '..', 'templates', 'react-shadcn');

// Arquivos do template que o modelo NUNCA deve sobrescrever, mesmo que os envie.
// Garante que dependências e configuração de build permaneçam consistentes.
const PROTECTED = new Set([
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'vite.config.js',
  'tsconfig.json',
  'tsconfig.node.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'postcss.config.js',
  'postcss.config.cjs',
  'components.json',
  'server.js',
  'index.html',
  'src/main.tsx',
  'src/index.css',
  'src/lib/utils.ts',
]);

// Normaliza um caminho relativo vindo do modelo, recusando escapes.
function safeRelative(input) {
  const raw = String(input || '').replace(/\\/g, '/').trim();
  const parts = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' || segment.includes('\0') || segment.includes(':')) {
      throw new Error(`Caminho inválido gerado pela IA: ${input}`);
    }
    parts.push(segment);
  }
  return parts.join('/');
}

async function listFilesRecursive(dir, base = dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

async function readIfExists(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

// Aplica uma operação (create/update/patch) sobre `destDir`.
// Retorna { path, op, ok, error? }.
async function applyOperation(destDir, operation) {
  let rel;
  try {
    rel = safeRelative(operation?.path);
  } catch (e) {
    return { path: operation?.path, op: operation?.op, ok: false, error: e.message };
  }
  if (!rel) return { path: operation?.path, op: operation?.op, ok: false, error: 'Caminho vazio.' };
  if (PROTECTED.has(rel)) return { path: rel, op: operation?.op, ok: false, error: 'Arquivo protegido.' };

  const target = path.join(destDir, rel);
  const op = String(operation?.op || '').toLowerCase();

  if (op === 'patch') {
    const current = await readIfExists(target);
    if (current === null) return { path: rel, op, ok: false, error: 'Arquivo não existe para aplicar o patch.' };
    let patched;
    try {
      patched = applyPatch(current, operation.patch);
    } catch (e) {
      return { path: rel, op, ok: false, error: e.message };
    }
    await fs.writeFile(target, patched, 'utf8');
    return { path: rel, op, ok: true };
  }

  // create / update
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, String(operation.content ?? ''), 'utf8');
  return { path: rel, op: op || 'update', ok: true };
}

// Copia o template para `destDir` e aplica as operações geradas por cima.
// Retorna a lista final de arquivos e o resultado de cada operação.
async function materialize(destDir, operations = []) {
  await fs.mkdir(destDir, { recursive: true });

  // 1. Copia o boilerplate.
  await fs.cp(TEMPLATE_DIR, destDir, { recursive: true });

  // 2. Aplica as operações geradas (exceto as protegidas/inválidas).
  const results = [];
  for (const operation of operations) {
    results.push(await applyOperation(destDir, operation));
  }

  const all = await listFilesRecursive(destDir);
  const applied = results.filter(r => r.ok).map(r => r.path);
  const failed = results.filter(r => !r.ok);
  return { files: all, applied, failed };
}

module.exports = { TEMPLATE_DIR, PROTECTED, materialize, applyOperation, safeRelative };