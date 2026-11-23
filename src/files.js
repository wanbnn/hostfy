'use strict';

// ---------------------------------------------------------------------------
// Operações de arquivo dentro do diretório de um projeto
//
// Tudo é resolvido a partir da pasta do projeto e nunca pode escapar dela.
// Links simbólicos são ignorados na listagem e recusados na escrita.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs/promises');

// Tamanho máximo de um arquivo aberto no editor do painel.
const MAX_EDIT_BYTES = Number(process.env.MAX_EDIT_BYTES || 2 * 1024 * 1024);

function normalizeRelative(input) {
  const raw = String(input === undefined || input === null ? '' : input).replace(/\\/g, '/');
  const parts = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('Caminho inválido.');
    if (segment.includes('\0') || segment.includes(':')) throw new Error('Caminho inválido.');
    parts.push(segment);
  }
  return parts.join('/');
}

function resolveInside(baseDir, relative) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, normalizeRelative(relative));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Caminho inválido.');
  return target;
}

function joinRelative(parent, name) {
  const base = normalizeRelative(parent);
  return base ? `${base}/${name}` : name;
}

async function lstatSafe(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

function isTextual(buffer) {
  const sample = buffer.subarray(0, 8000);
  return !sample.includes(0);
}

async function listDirectory(baseDir, relative) {
  const target = resolveInside(baseDir, relative);
  const stat = await lstatSafe(target);
  if (!stat) throw new Error('Pasta não encontrada.');
  if (!stat.isDirectory()) throw new Error('O caminho não é uma pasta.');

  const entries = await fs.readdir(target, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    const info = await lstatSafe(full);
    if (!info || info.isSymbolicLink()) continue;
    items.push({
      name: entry.name,
      path: joinRelative(relative, entry.name),
      type: info.isDirectory() ? 'dir' : 'file',
      size: info.isDirectory() ? 0 : info.size,
      modified: info.mtime.toISOString(),
    });
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'pt-BR');
  });
  return { path: normalizeRelative(relative), entries: items };
}

async function readTextFile(baseDir, relative) {
  const target = resolveInside(baseDir, relative);
  const stat = await lstatSafe(target);
  if (!stat) throw new Error('Arquivo não encontrado.');
  if (stat.isSymbolicLink()) throw new Error('Arquivo não permitido.');
  if (!stat.isFile()) throw new Error('O caminho não é um arquivo.');
  if (stat.size > MAX_EDIT_BYTES)
    throw new Error(`Arquivo maior que ${Math.round(MAX_EDIT_BYTES / 1024 / 1024)} MB — não pode ser editado no painel.`);
  const buffer = await fs.readFile(target);
  if (!isTextual(buffer)) throw new Error('Arquivo binário — use o download.');
  return {
    path: normalizeRelative(relative),
    content: buffer.toString('utf8'),
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

async function writeTextFile(baseDir, relative, content) {
  const relativePath = normalizeRelative(relative);
  if (!relativePath) throw new Error('Informe o nome do arquivo.');
  const target = resolveInside(baseDir, relativePath);
  const stat = await lstatSafe(target);
  if (stat && stat.isSymbolicLink()) throw new Error('Arquivo não permitido.');
  if (stat && stat.isDirectory()) throw new Error('Já existe uma pasta com esse nome.');
  const text = String(content === undefined || content === null ? '' : content);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_EDIT_BYTES)
    throw new Error(`O conteúdo passa de ${Math.round(MAX_EDIT_BYTES / 1024 / 1024)} MB — não pode ser salvo pelo painel.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(text, 'utf8'));
  const info = await lstatSafe(target);
  return { path: relativePath, size: info ? info.size : size, modified: info ? info.mtime.toISOString() : null };
}

async function createDirectory(baseDir, relative) {
  const relativePath = normalizeRelative(relative);
  if (!relativePath) throw new Error('Informe o nome da pasta.');
  const target = resolveInside(baseDir, relativePath);
  const stat = await lstatSafe(target);
  if (stat) throw new Error('Já existe um item com esse nome.');
  await fs.mkdir(target, { recursive: true });
  return { path: relativePath };
}

async function renameEntry(baseDir, from, to) {
  const source = normalizeRelative(from);
  const destination = normalizeRelative(to);
  if (!source || !destination) throw new Error('Informe o caminho de origem e destino.');
  if (source === destination) return { path: destination };
  const sourcePath = resolveInside(baseDir, source);
  const destinationPath = resolveInside(baseDir, destination);
  const stat = await lstatSafe(sourcePath);
  if (!stat) throw new Error('Origem não encontrada.');
  if (stat.isSymbolicLink()) throw new Error('Arquivo não permitido.');
  const existing = await lstatSafe(destinationPath);
  if (existing) throw new Error('Já existe um item com esse nome.');
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rename(sourcePath, destinationPath);
  return { path: destination };
}

async function removeEntry(baseDir, relative) {
  const relativePath = normalizeRelative(relative);
  if (!relativePath) throw new Error('Informe o que deseja excluir.');
  const target = resolveInside(baseDir, relativePath);
  const stat = await lstatSafe(target);
  if (!stat) throw new Error('Item não encontrado.');
  if (stat.isSymbolicLink()) throw new Error('Arquivo não permitido.');
  await fs.rm(target, { recursive: true, force: true });
  return { path: relativePath };
}

// Recebe o arquivo já enviado pelo multer e grava dentro do projeto.
async function saveUploadedFile(baseDir, relative, tempPath) {
  const relativePath = normalizeRelative(relative);
  if (!relativePath) throw new Error('Informe o nome do arquivo.');
  const target = resolveInside(baseDir, relativePath);
  const stat = await lstatSafe(target);
  if (stat && stat.isDirectory()) throw new Error('Já existe uma pasta com esse nome.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(tempPath, target);
  const info = await lstatSafe(target);
  return { path: relativePath, size: info ? info.size : 0, modified: info ? info.mtime.toISOString() : null };
}

module.exports = {
  MAX_EDIT_BYTES,
  normalizeRelative,
  joinRelative,
  resolveInside,
  listDirectory,
  readTextFile,
  writeTextFile,
  createDirectory,
  renameEntry,
  removeEntry,
  saveUploadedFile,
};
