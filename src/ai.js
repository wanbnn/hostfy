'use strict';

// ---------------------------------------------------------------------------
// Cliente de LLM (compatível com a API OpenAI Chat Completions)
//
// Funciona com OpenAI, Azure OpenAI, Groq, Together, OpenRouter, Ollama, LM Studio
// e qualquer endpoint que exponha POST {base}/chat/completions.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 120000);
const MAX_FILES = Number(process.env.AI_MAX_FILES || 40);
const MAX_FILE_BYTES = Number(process.env.AI_MAX_FILE_BYTES || 200 * 1024);

function baseUrl() {
  return String(process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function enabled() {
  return Boolean(process.env.AI_API_KEY);
}

// Instruções fixas: o modelo só produz arquivos de aplicação. O boilerplate
// (package.json, configs, componentes shadcn) já existe e não deve ser reescrito.
const SYSTEM_PROMPT = `Você é um gerador de aplicações React para a plataforma Hostfy.

O projeto JÁ EXISTE com este boilerplate pronto (NÃO gere nem altere estes arquivos):
- package.json, vite.config.ts, tsconfig.json, tailwind.config.js, postcss.config.js, components.json, index.html, server.js
- src/main.tsx, src/index.css, src/lib/utils.ts
- src/components/ui/* (componentes shadcn/ui prontos)

Dependências já instaladas e disponíveis para importar:
- react, react-dom
- lucide-react (ícones)
- recharts (gráficos: LineChart, BarChart, AreaChart, PieChart, ResponsiveContainer, etc.)
- shadcn/ui em "@/components/ui/*": button, card, input, label, badge, table, tabs, separator, avatar, progress, textarea, skeleton, select, dialog, dropdown-menu, switch, checkbox, tooltip
- "@/lib/utils" exporta cn()

OPERAÇÕES DISPONÍVEIS (escolha a mais econômica):
- "create": cria um arquivo novo. Use quando o arquivo ainda não existe.
- "update": reescreve o arquivo inteiro. Use para arquivos novos ou pequenos.
- "patch": aplica um unified diff em um arquivo existente. PREFIRA isto para
  editar arquivos que já existem, principalmente os grandes. O diff deve casar
  exatamente com o conteúdo atual (linhas de contexto com um espaço à esquerda,
  remoções com "-", adições com "+", cabeçalho "@@ -a,b +c,d @@").

REGRAS:
1. Gere SOMENTE arquivos de aplicação. O ponto de entrada é src/App.tsx.
3. Use imports com o alias "@/..." (ex.: import { Button } from '@/components/ui/button').
4. Use TypeScript (.tsx/.ts). Não crie package.json, configs ou componentes em src/components/ui.
5. Se precisar de um componente shadcn que não está na lista, implemente-o em src/components/ (não em ui/).
6. Use Tailwind para estilos e lucide-react para ícones. Use recharts quando o usuário pedir gráficos.
7. Código completo e funcional, sem placeholders como "// TODO" ou "...".
8. Ao editar um arquivo existente, use "patch" (diff) em vez de reescrevê-lo inteiro.
9. Responda APENAS com um objeto JSON válido, sem texto ao redor, no formato:
{"operations":[
  {"op":"create","path":"src/components/Header.tsx","content":"<código completo>"},
  {"op":"update","path":"src/App.tsx","content":"<código completo>"},
  {"op":"patch","path":"src/App.tsx","patch":"@@ -1,3 +1,4 @@\\n import ...\\n+import ...\\n ..."}
]}`;

function buildUserPrompt(description, existingFiles = []) {
  let prompt = `Crie ou edite a aplicação conforme a descrição abaixo.\n\nDescrição:\n${description}`;
  if (existingFiles.length) {
    prompt += `\n\nArquivos atuais do projeto (use "patch" para editá-los):\n`;
    for (const file of existingFiles) {
      if (typeof file === 'string') {
        prompt += `\n### ${file}\n(conteúdo não fornecido)\n`;
      } else {
        prompt += `\n### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n`;
      }
    }
  }
  return prompt;
}

// Extrai o primeiro objeto JSON balanceado de um texto (tolera cercas ```json).
function extractJson(text) {
  const cleaned = String(text || '').replace(/```json/gi, '```');
  const fence = cleaned.match(/```([\s\S]*?)```/);
  const candidate = fence ? fence[1] : cleaned;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('A IA não retornou JSON.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('JSON inválido retornado pela IA.');
}

function safeRel(input) {
  const rel = String(input || '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  if (!rel || rel.split('/').some(segment => segment === '..' || segment === '.') || rel.includes('\0') || rel.includes(':')) return null;
  return rel;
}

// Valida e normaliza as operações devolvidas pelo modelo.
// Aceita tanto o formato novo {"operations":[...]} quanto o antigo {"files":[...]}.
function normalizeOperations(raw) {
  let list = Array.isArray(raw?.operations) ? raw.operations : null;
  if (!list && Array.isArray(raw?.files)) {
    list = raw.files.map(f => ({ op: 'update', path: f?.path, content: f?.content }));
  }
  if (!list) throw new Error('A IA não retornou operações válidas.');

  // Mantém a última operação de cada caminho (o modelo pode se corrigir).
    const byPath = new Map();
  for (const item of list) {
    if (!item || typeof item.path !== 'string') continue;
    const rel = safeRel(item.path);
      if (!rel) continue;

    const op = String(item.op || '').toLowerCase();
    if (op === 'patch') {
      if (typeof item.patch !== 'string' || !item.patch.trim()) continue;
      if (Buffer.byteLength(item.patch, 'utf8') > MAX_FILE_BYTES) continue;
        byPath.set(rel, { op: 'patch', path: rel, patch: item.patch });
    } else if (op === 'create' || op === 'update') {
      if (typeof item.content !== 'string') continue;
      if (Buffer.byteLength(item.content, 'utf8') > MAX_FILE_BYTES) continue;
        byPath.set(rel, { op, path: rel, content: item.content });
    }
  }
    const out = [...byPath.values()].slice(0, MAX_FILES);
  if (!out.length) throw new Error('A IA não retornou nenhuma operação válida.');
  return out;
}

async function requestCompletion({ description, existingFiles = [], onContent }) {
  if (!enabled()) throw new Error('Geração por IA não está configurada (AI_API_KEY ausente).');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        temperature: Number(process.env.AI_TEMPERATURE || 0.3),
        ...(onContent ? {} : { response_format: { type: 'json_object' } }),
        stream: Boolean(onContent),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(description, existingFiles) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('A geração demorou demais e foi cancelada.');
    throw new Error('Não foi possível contatar o provedor de IA.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Provedor de IA respondeu com erro: ${detail}`);
  }

  if (onContent) {
    if (!response.body) throw new Error('O provedor não iniciou a resposta em streaming.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const consume = (line) => {
      const value = line.trim();
      if (!value.startsWith('data:')) return;
      const payload = value.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let event;
      try { event = JSON.parse(payload); } catch { return; }
      if (event.error?.message) throw new Error(event.error.message);
      const token = event.choices?.[0]?.delta?.content;
      if (typeof token === 'string' && token) {
        content += token;
        onContent(token);
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) consume(line);
        if (done) break;
      }
      if (buffer) consume(buffer);
    } finally {
      reader.releaseLock();
    }
    if (!content) throw new Error('Resposta vazia do provedor de IA.');
    return content;
  }

  const data = await response.json().catch(() => ({}));
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Resposta vazia do provedor de IA.');
  return content;
}

async function generate({ description, existingFiles = [], onContent }) {
  const content = await requestCompletion({ description, existingFiles, onContent });
  return normalizeOperations(extractJson(content));
}

  module.exports = { enabled, generate, normalizeOperations, DEFAULT_MODEL, SYSTEM_PROMPT };
