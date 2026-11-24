import React, {useCallback, useEffect, useRef, useState} from 'react'
import {
  Button,
  FormControl,
  Heading,
  IconButton,
  Label,
  Spinner,
  Stack,
  Text,
  TextInput,
} from '@primer/react'
import {
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FileDirectoryIcon,
  FileIcon,
  GlobeIcon,
  PaperAirplaneIcon,
  PersonIcon,
  PlusIcon,
  RocketIcon,
  SparkleFillIcon,
  SyncIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {useRouter} from '../router.jsx'
import templatePackage from '../../../templates/react-shadcn/package.json?raw'
import templateViteConfig from '../../../templates/react-shadcn/vite.config.ts?raw'
import templateTsConfig from '../../../templates/react-shadcn/tsconfig.json?raw'
import templateTailwindConfig from '../../../templates/react-shadcn/tailwind.config.js?raw'
import templatePostcssConfig from '../../../templates/react-shadcn/postcss.config.js?raw'
import templateHtml from '../../../templates/react-shadcn/index.html?raw'
import templateServer from '../../../templates/react-shadcn/server.js?raw'
import templateMain from '../../../templates/react-shadcn/src/main.tsx?raw'
import templateCss from '../../../templates/react-shadcn/src/index.css?raw'
import templateUtils from '../../../templates/react-shadcn/src/lib/utils.ts?raw'

const PREVIEW_TEMPLATE_FILES = [
  ['package.json', templatePackage],
  ['vite.config.ts', templateViteConfig],
  ['tsconfig.json', templateTsConfig],
  ['tailwind.config.js', templateTailwindConfig],
  ['postcss.config.js', templatePostcssConfig],
  ['index.html', templateHtml],
  ['server.js', templateServer],
  ['src/main.tsx', templateMain],
  ['src/index.css', templateCss],
  ['src/lib/utils.ts', templateUtils],
]

function readTemplateFiles() {
  return PREVIEW_TEMPLATE_FILES.map(([path, content]) => ({path, content}))
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function slugify(v) {
  return v.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function fileIcon(name) {
  if (!name) return FileIcon
  const ext = name.split('.').pop().toLowerCase()
  const code = ['js', 'jsx', 'ts', 'tsx', 'json', 'css', 'html', 'md', 'mjs']
  return code.includes(ext) ? FileCodeIcon : FileIcon
}

function fileLanguage(name) {
  if (!name) return 'text'
  const ext = name.split('.').pop().toLowerCase()
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', css: 'css', html: 'html', md: 'markdown',
  }
  return map[ext] || 'text'
}

// Aplica um unified diff sobre um texto (mesma lógica do backend).
function applyPatchText(original, patch) {
  const split = t => String(t ?? '').replace(/\r\n/g, '\n').split('\n')
  const fileLines = split(original)
  const hunks = []
  let current = null
  for (const line of split(patch)) {
    const header = line.match(/^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/)
    if (header) {
      current = {oldStart: Number(header[1]), lines: []}
      hunks.push(current)
      continue
    }
    if (!current || line.startsWith('\\')) continue
    const marker = line[0]
    if (marker === ' ' || marker === '+' || marker === '-') current.lines.push({type: marker, text: line.slice(1)})
    else if (line === '') current.lines.push({type: ' ', text: ''})
  }
  if (!hunks.length) throw new Error('Patch sem hunks válidos.')

  const out = []
  let cursor = 0
  for (const hunk of hunks) {
    const pattern = hunk.lines.filter(l => l.type !== '+')
    const matches = (start) => pattern.every((p, i) => fileLines[start + i] === p.text)
    let start = -1
    const declared = Math.max(0, hunk.oldStart - 1)
    if (declared >= cursor && declared <= fileLines.length - pattern.length && matches(declared)) start = declared
    if (start === -1) {
      for (let s = cursor; s <= fileLines.length - pattern.length; s++) {
        if (matches(s)) { start = s; break }
      }
    }
    if (start === -1) throw new Error('O patch não corresponde ao conteúdo atual do arquivo.')
    for (let i = cursor; i < start; i++) out.push(fileLines[i])
    let idx = start
    for (const line of hunk.lines) {
      if (line.type === ' ') { out.push(fileLines[idx]); idx++ }
      else if (line.type === '-') idx++
      else if (line.type === '+') out.push(line.text)
    }
    cursor = idx
  }
  for (let i = cursor; i < fileLines.length; i++) out.push(fileLines[i])
  return out.join('\n')
}

// Aplica as operações da IA sobre a lista atual de arquivos.
// Retorna { files, summary }.
function applyOperations(currentFiles, operations) {
  const map = new Map(currentFiles.map(f => [f.path, f.content]))
  const created = []
  const updated = []
  const patched = []
  const failed = []

  for (const op of operations) {
    const path = op?.path
    if (!path) continue
    try {
      if (op.op === 'patch') {
        if (!map.has(path)) throw new Error('arquivo não existe')
        map.set(path, applyPatchText(map.get(path), op.patch))
        patched.push(path)
      } else {
        const existed = map.has(path)
        map.set(path, String(op.content ?? ''))
        ;(existed ? updated : created).push(path)
      }
    } catch (err) {
      failed.push(`${path} (${err.message})`)
    }
  }

  const files = [...map.entries()].map(([path, content]) => ({path, content}))
  const parts = []
  if (created.length) parts.push(`${created.length} criado(s)`)
  if (updated.length) parts.push(`${updated.length} atualizado(s)`)
  if (patched.length) parts.push(`${patched.length} editado(s) via patch`)
  if (failed.length) parts.push(`${failed.length} falhou(aram)`)
  const summary = parts.length ? `Operações: ${parts.join(', ')}.` : 'Nenhuma alteração.'
  return {files, summary}
}

/* ------------------------------------------------------------------ */
/* Mensagens do chat                                                   */
/* ------------------------------------------------------------------ */

function ChatMessage({msg}) {
  const isUser = msg.role === 'user'
  return (
    <div className={`ai-msg ${isUser ? 'ai-msg-user' : 'ai-msg-assistant'}`}>
      <div className="ai-msg-avatar">
        {isUser ? <PersonIcon size={14} /> : <SparkleFillIcon size={14} />}
      </div>
      <div className="ai-msg-content">
        {msg.files && msg.files.length > 0 ? (
          <div className="ai-msg-files">
            {msg.files.map((f, i) => (
              <span key={i} className="ai-msg-file-tag">
                <FileCodeIcon size={12} /> {f}
              </span>
            ))}
          </div>
        ) : null}
        <div className="ai-msg-text">{msg.content}</div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* File tree                                                           */
/* ------------------------------------------------------------------ */

function FileTree({files, selected, onSelect, onDelete}) {
  // Agrupa arquivos em pastas
  const tree = {}
  for (const f of files) {
    const parts = f.path.split('/')
    if (parts.length === 1) {
      tree[f.path] = f
    } else {
      const dir = parts.slice(0, -1).join('/')
      if (!tree[dir]) tree[dir] = {dir: true, name: dir, children: []}
      tree[dir].children.push(f)
    }
  }

  return (
    <div className="ai-file-tree">
      {files.length === 0 ? (
        <div className="ai-file-empty">
          <FileDirectoryIcon size={20} />
          <Text className="muted small">Os arquivos do projeto aparecerão aqui.</Text>
        </div>
      ) : (
        files.map(f => {
          const Icon = fileIcon(f.path)
          const isActive = selected === f.path
          return (
            <button
              key={f.path}
              type="button"
              className={`ai-file-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(f.path)}
              title={f.path}
            >
              <Icon size={14} />
              <span className="ai-file-name">{f.path}</span>
              <button
                type="button"
                className="ai-file-delete"
                title="Remover"
                onClick={e => {
                  e.stopPropagation()
                  onDelete(f.path)
                }}
              >
                <XIcon size={12} />
              </button>
            </button>
          )
        })
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Preview iframe                                                      */
/* ------------------------------------------------------------------ */

function PreviewPane({files, deployUrl, previewUrl, previewError, previewLoading}) {
  const activeUrl = deployUrl || previewUrl
  if (activeUrl) {
    return (
      <div className="ai-preview-wrap">
        <div className="ai-preview-toolbar">
          <div className="ai-preview-url">
            <GlobeIcon size={14} />
            <span>{activeUrl}</span>
          </div>
          <IconButton
            icon={SyncIcon}
            variant="invisible"
            size="small"
            aria-label="Abrir em nova aba"
            onClick={() => window.open(activeUrl, '_blank', 'noopener')}
          />
        </div>
        <iframe
          className="ai-preview-frame"
          src={activeUrl}
          key={activeUrl}
          title="Preview do projeto"
        />
      </div>
    )
  }

  return (
    <div className="ai-preview-wrap">
      <div className="ai-preview-toolbar">
        <div className="ai-preview-url">
          <GlobeIcon size={14} />
          <span>preview://{previewLoading ? 'iniciando' : 'aguardando'}</span>
        </div>
      </div>
      <div className="ai-preview-placeholder">
        <GlobeIcon size={28} />
        <Text className="muted">
          {previewError || (files.length === 0
            ? 'Descreva o projeto no chat para gerar os arquivos.'
            : previewLoading ? 'Atualizando o preview…' : 'Preparando o preview ao vivo…')}
        </Text>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Code viewer                                                         */
/* ------------------------------------------------------------------ */

function CodeViewer({file}) {
  if (!file) {
    return (
      <div className="ai-code-empty">
        <FileCodeIcon size={24} />
        <Text className="muted">Selecione um arquivo para ver o código.</Text>
      </div>
    )
  }
  return (
    <div className="ai-code-viewer">
      <div className="ai-code-header">
        <span className="ai-code-path">
          <FileCodeIcon size={14} /> {file.path}
        </span>
        <Label variant="secondary">{fileLanguage(file.path)}</Label>
      </div>
      <pre className="ai-code-content">{file.content}</pre>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sugestões rápidas                                                   */
/* ------------------------------------------------------------------ */

const SUGGESTIONS = [
  {text: 'Landing page moderna com hero e seção de features', icon: RocketIcon},
  {text: 'Dashboard com sidebar, cards de métricas e tabela', icon: GlobeIcon},
  {text: 'Página de portfólio com galeria e seção about', icon: FileCodeIcon},
  {text: 'App de tarefas com lista, formulário e filtros', icon: PlusIcon},
]

/* ------------------------------------------------------------------ */
/* AI Builder (página principal)                                       */
/* ------------------------------------------------------------------ */

export default function AiBuilderPage({onRefresh}) {
  useRouter()
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: 'Olá! Sou o assistente de criação de projetos da Hostfy.\n\nDescreva o projeto que deseja criar e eu vou gerar os arquivos para você. Os projetos usam React + shadcn/ui + Lucide Icons + Recharts (gráficos).\n\nVocê pode dizer algo como:\n• "Crie uma landing page com hero e seção de preços"\n• "Quero um dashboard com sidebar e gráficos de vendas"\n• "Monte um portfólio minimalista"',
    },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [projectFiles, setProjectFiles] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [rightTab, setRightTab] = useState('preview') // 'preview' | 'files'
  const [projectName, setProjectName] = useState('')
  const [projectSlug, setProjectSlug] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployUrl, setDeployUrl] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewReady, setPreviewReady] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [boilerplate, setBoilerplate] = useState([])
  const previewSession = useRef(0)
  const chatEndRef = useRef(null)
  const inputRef = useRef(null)

  // Auto-scroll do chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({behavior: 'smooth'})
  }, [messages])

  // Foca o input ao montar
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let active = true
    if (active) setBoilerplate(readTemplateFiles())
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!boilerplate.length) return
    const timer = setTimeout(async () => {
      const version = ++previewSession.current
      setPreviewLoading(true)
      setPreviewError('')
      try {
        const map = new Map(boilerplate.map(file => [file.path, file.content]))
        for (const file of projectFiles) map.set(file.path, file.content)
        const result = await api('/api/ai/preview', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({files: [...map].map(([path, content]) => ({path, content}))}),
        })
        if (version === previewSession.current) {
          setPreviewReady(current => current || Boolean(result.ready))
          setPreviewUrl(result.url)
        }
      } catch (error) {
        if (version === previewSession.current) setPreviewError(error.message)
      } finally {
        if (version === previewSession.current) setPreviewLoading(false)
      }
    }, projectFiles.length ? 700 : 0)
    return () => clearTimeout(timer)
  }, [boilerplate, projectFiles])

  useEffect(() => {
    if (previewReady || !previewUrl) return
    const timer = setInterval(async () => {
      try {
        const response = await fetch(previewUrl, {credentials: 'same-origin'})
        if (response.ok) setPreviewReady(true)
      } catch {}
    }, 1500)
    return () => clearInterval(timer)
  }, [previewReady, previewUrl])

  // Chama o backend, que consulta o LLM e devolve operações (create/update/patch).
  // O boilerplate (package.json, configs, componentes shadcn) é mesclado no
  // deploy, então aqui só lidamos com os arquivos gerados pela IA.
  const processAiResponse = useCallback(async (userMessage) => {
    setMessages(prev => [...prev, {role: 'user', content: userMessage}])
    setSending(true)

    try {
      // Envia o boilerplate e o conteúdo atual para o modelo editar via patch.
      const existingFiles = projectFiles.map(f => ({path: f.path, content: f.content}))
      const templateFiles = projectFiles.length ? [] : boilerplate.filter(file => file.path.startsWith('src/'))
      const response = await fetch('/api/ai/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', Accept: 'text/event-stream'},
        body: JSON.stringify({description: userMessage, existingFiles: [...templateFiles, ...existingFiles], stream: true}),
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || 'Não foi possível gerar o projeto.')
      }

      let streamBuffer = ''
      let pendingOperations = null
      let streamError = null
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const handleEvent = raw => {
        const lines = raw.split(/\r?\n/)
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const dataLine = lines.find(line => line.startsWith('data:'))
        if (!dataLine) return
        const data = JSON.parse(dataLine.slice(5).trim())
        if (event === 'token') {
          setMessages(prev => {
            const last = prev[prev.length - 1]
            if (last?.streaming) return [...prev.slice(0, -1), {...last, content: last.content + data.token}]
            return [...prev, {role: 'assistant', content: data.token, streaming: true}]
          })
        } else if (event === 'complete') pendingOperations = data.operations || []
        else if (event === 'error') streamError = data.error
      }
      while (true) {
        const {value, done} = await reader.read()
        streamBuffer += decoder.decode(value || new Uint8Array(), {stream: !done})
        const events = streamBuffer.split(/\r?\n\r?\n/)
        streamBuffer = events.pop() || ''
        events.forEach(handleEvent)
        if (done) break
      }
      if (streamBuffer.trim()) handleEvent(streamBuffer)
      if (streamError) throw new Error(streamError)
      const operations = pendingOperations || []
      const baseFiles = projectFiles.length ? projectFiles : boilerplate.filter(file => file.path.startsWith('src/'))
      const {files: nextFiles, summary} = applyOperations(baseFiles, operations)
      if (!operations.some(operation => operation.path === 'src/App.tsx') && !projectFiles.length)
        throw new Error('A IA nÃ£o gerou src/App.tsx para substituir a tela inicial. Tente enviar o pedido novamente.')
      setProjectFiles(nextFiles)

      setMessages(prev => [
        ...prev.filter(msg => !msg.streaming),
        {
          role: 'assistant',
          content: `Pronto! ${summary}\n\nO projeto usa React + shadcn/ui + Lucide + Recharts. Veja o código na aba "Arquivos". Quando estiver satisfeito, preencha o nome/slug e clique em "Publicar na Hostfy".`,
          files: operations.map(o => o.path),
        },
      ])
      setRightTab('files')

      if (!projectName) {
        const name = userMessage.slice(0, 60).trim()
        setProjectName(name)
        setProjectSlug(slugify(name).slice(0, 50))
      }
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {role: 'assistant', content: `Não consegui gerar o projeto: ${err.message}`},
      ])
    } finally {
      setSending(false)
    }
  }, [projectName, projectFiles, boilerplate])

  function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    processAiResponse(text)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSuggestion(text) {
    if (sending) return
    setInput('')
    processAiResponse(text)
  }

  function handleDeleteFile(filePath) {
    setProjectFiles(prev => prev.filter(f => f.path !== filePath))
    if (selectedFile === filePath) setSelectedFile(null)
  }

  async function handleDeploy() {
    if (!projectName.trim() || !projectSlug.trim()) return
    if (projectFiles.length === 0) return

    setDeploying(true)
    try {
      // O backend mescla o boilerplate React + shadcn com os arquivos gerados
      // e publica como projeto Node (build + start via runner). Enviamos o
      // estado final como operações "update" (o front já aplicou os patches).
      const operations = projectFiles.map(f => ({op: 'update', path: f.path, content: f.content}))
      const result = await api('/api/ai/deploy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: projectName, slug: projectSlug, operations}),
      })
      setDeployUrl(result.url)
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `Projeto publicado com sucesso!\n\nAcesse: ${result.url}\n\nVocê pode gerenciar o projeto na página de Projetos.`,
        },
      ])
      if (onRefresh) onRefresh()
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {role: 'assistant', content: `Erro ao publicar: ${err.message}`},
      ])
    } finally {
      setDeploying(false)
    }
  }

  const currentFile = projectFiles.find(f => f.path === selectedFile)

  return (
    <div className="ai-builder">
      {/* ---- Painel esquerdo: Chat ---- */}
      <div className="ai-chat-panel">
        <div className="ai-chat-header">
          <div className="ai-chat-heading">
            <Label variant="accent">React · shadcn/ui · Lucide · Recharts</Label>
            <div className="ai-chat-title">
              <RocketIcon size={16} />
              <Heading as="h2" sx={{fontSize: 16, m: 0}}>Criar projeto com IA</Heading>
            </div>
          </div>
        </div>

        <div className="ai-chat-messages">
          {messages.map((msg, i) => (
            <ChatMessage key={i} msg={msg} />
          ))}
          {sending ? (
            <div className="ai-msg ai-msg-assistant">
              <div className="ai-msg-avatar"><SparkleFillIcon size={14} /></div>
              <div className="ai-msg-content">
                <div className="ai-msg-thinking">
                  <Spinner size="small" /> Gerando projeto…
                </div>
              </div>
            </div>
          ) : null}
          <div ref={chatEndRef} />
        </div>

        {/* Sugestões (só se não há mensagens do usuário) */}
        {messages.length === 1 ? (
          <div className="ai-suggestions">
            {SUGGESTIONS.map((s, i) => (
              <button key={i} type="button" className="ai-suggestion" onClick={() => handleSuggestion(s.text)}>
                <s.icon size={14} />
                <span>{s.text}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Input */}
        <div className="ai-chat-input-wrap">
          <div className="ai-chat-input">
            <textarea
              ref={inputRef}
              className="ai-chat-textarea"
              placeholder="Descreva o projeto que deseja criar…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={sending}
            />
            <IconButton
              icon={PaperAirplaneIcon}
              variant="primary"
              size="small"
              aria-label="Enviar"
              disabled={!input.trim() || sending}
              onClick={handleSend}
            />
          </div>
        </div>

        {/* Deploy bar */}
        {projectFiles.length > 0 && !deployUrl ? (
          <div className="ai-deploy-bar">
            <div className="ai-deploy-fields">
              <TextInput
                size="small"
                placeholder="Nome do projeto"
                value={projectName}
                onChange={e => {
                  setProjectName(e.target.value)
                  setProjectSlug(slugify(e.target.value).slice(0, 50))
                }}
              />
              <TextInput
                size="small"
                leadingVisual="/"
                placeholder="slug"
                value={projectSlug}
                onChange={e => setProjectSlug(slugify(e.target.value))}
              />
            </div>
            <Button
              variant="primary"
              size="small"
              leadingVisual={RocketIcon}
              loading={deploying}
              disabled={!projectName.trim() || !projectSlug.trim()}
              onClick={handleDeploy}
            >
              Publicar na Hostfy
            </Button>
          </div>
        ) : null}
      </div>

      {/* ---- Painel direito: Preview / Arquivos ---- */}
      <div className="ai-right-panel">
        <div className="ai-right-tabs">
          <button
            type="button"
            className={rightTab === 'preview' ? 'active' : ''}
            onClick={() => setRightTab('preview')}
          >
            <GlobeIcon size={14} /> Preview
          </button>
          <button
            type="button"
            className={rightTab === 'files' ? 'active' : ''}
            onClick={() => setRightTab('files')}
          >
            <FileDirectoryIcon size={14} /> Arquivos
            {projectFiles.length > 0 ? (
              <span className="ai-tab-badge">{projectFiles.length}</span>
            ) : null}
          </button>
        </div>

        <div className="ai-right-content">
          {rightTab === 'preview' ? (
            <PreviewPane files={projectFiles} deployUrl={deployUrl} previewUrl={previewReady ? previewUrl : ''} previewError={previewError} previewLoading={previewLoading || (Boolean(previewUrl) && !previewReady)} />
          ) : (
            <div className="ai-files-panel">
              <div className="ai-files-split">
                <FileTree
                  files={projectFiles}
                  selected={selectedFile}
                  onSelect={setSelectedFile}
                  onDelete={handleDeleteFile}
                />
                <div className="ai-files-code">
                  <CodeViewer file={currentFile} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
