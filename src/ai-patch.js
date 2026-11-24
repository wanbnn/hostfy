'use strict';

// ---------------------------------------------------------------------------
// Aplicador de patch (unified diff)
//
// O modelo pode editar arquivos existentes enviando um diff em vez do arquivo
// inteiro. Isso economiza tokens e reduz o risco de regressões em arquivos
// grandes. Implementação tolerante: aceita cabeçalhos @@ sem números exatos e
// faz busca por contexto com fuzz quando a linha não bate exatamente.
// ---------------------------------------------------------------------------

// Divide em linhas preservando o conteúdo (sem o \n final).
function splitLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n');
}

// Faz o parse de um unified diff em uma lista de hunks.
// Cada hunk: { oldStart, oldLines: [{type, text}], newCount }
function parseHunks(patch) {
  const lines = splitLines(patch);
  if (lines.at(-1) === '') lines.pop();
  const hunks = [];
  let current = null;

  for (const line of lines) {
    const header = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
    if (header) {
      current = { oldStart: Number(header[1]), insertion: header[2] === '0', lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // ignora cabeçalhos ---/+++ e ruído antes do primeiro @@
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const marker = line[0];
    if (marker === ' ' || marker === '+' || marker === '-') {
      current.lines.push({ type: marker, text: line.slice(1) });
    } else if (line === '') {
      // Linha vazia dentro do hunk = contexto vazio.
      current.lines.push({ type: ' ', text: '' });
    }
  }
  return hunks;
}

// Tenta casar o bloco de contexto/remoções de um hunk em `fileLines` a partir
// de `fromIndex`. Retorna o índice de início ou -1.
function findHunkStart(fileLines, hunkLines, fromIndex) {
  const pattern = hunkLines.filter(l => l.type !== '+');
  if (!pattern.length) return fromIndex; // hunk puramente aditivo

  for (let start = fromIndex; start <= fileLines.length - pattern.length; start++) {
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (fileLines[start + i] !== pattern[i].text) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
  }
  return -1;
}

// Aplica um unified diff sobre `original`. Lança se algum hunk não casar.
function applyPatch(original, patch) {
  const hunks = parseHunks(patch);
  if (!hunks.length) throw new Error('Patch sem hunks válidos.');

  const fileLines = splitLines(original);
  const out = [];
  let cursor = 0;

  for (const hunk of hunks) {
    // Prefere a posição declarada no cabeçalho; se não casar, procura adiante.
    let start = -1;
    const declared = Math.min(fileLines.length, Math.max(0, hunk.oldStart - (hunk.insertion ? 0 : 1)));
    if (declared >= cursor) {
      const probe = findHunkStart(fileLines, hunk.lines, declared);
      if (probe !== -1 && probe >= cursor) start = probe;
    }
    if (start === -1) start = findHunkStart(fileLines, hunk.lines, cursor);
    if (start === -1) throw new Error('O patch não corresponde ao conteúdo atual do arquivo.');

    // Copia o que está entre o cursor e o início do hunk.
    for (let i = cursor; i < start; i++) out.push(fileLines[i]);

    // Aplica as linhas do hunk.
    let idx = start;
    for (const line of hunk.lines) {
      if (line.type === ' ') {
        out.push(fileLines[idx]);
        idx++;
      } else if (line.type === '-') {
        idx++;
      } else if (line.type === '+') {
        out.push(line.text);
      }
    }
    cursor = idx;
  }

  for (let i = cursor; i < fileLines.length; i++) out.push(fileLines[i]);
  return out.join('\n');
}

// Detecta se um texto parece um unified diff.
function looksLikePatch(text) {
  return /^@@\s*-\d+/m.test(String(text || '')) || /^---\s/m.test(String(text || ''));
}

module.exports = { applyPatch, parseHunks, looksLikePatch };
