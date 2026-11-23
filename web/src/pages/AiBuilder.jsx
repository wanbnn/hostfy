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
  PlusIcon,
  RocketIcon,
  SyncIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {useRouter} from '../router.jsx'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function slugify(v) {
  return v.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-')
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

/* ------------------------------------------------------------------ */
/* Mensagens do chat                                                   */
/* ------------------------------------------------------------------ */

function ChatMessage({msg}) {
  const isUser = msg.role === 'user'
  return (
    <div className={`ai-msg ${isUser ? 'ai-msg-user' : 'ai-msg-assistant'}`}>
      <div className="ai-msg-avatar">
        {isUser ? '👤' : '✨'}
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

function PreviewPane({files}) {
  const iframeRef = useRef(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Monta o HTML combinando os arquivos do projeto
  const html = React.useMemo(() => {
    const indexFile = files.find(f =>
      f.path === 'index.html' || f.path === 'public/index.html'
    )
    if (!indexFile) {
      return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: system-ui; display: flex; align-items: center; justify-content: center;
    height: 100vh; margin: 0; background: #0d1117; color: #8b949e; text-align: center; }
  h2 { font-weight: 400; font-size: 16px; }
</style></head><body>
<div><h2>Nenhum <code>index.html</code> ainda.<br/>Use o chat para gerar o projeto.</h2></div>
</body></html>`
    }

    let content = indexFile.content

    // Injeta CSS inline se houver arquivos .css
    const cssFiles = files.filter(f => f.path.endsWith('.css'))
    for (const css of cssFiles) {
      const linkPattern = new RegExp(`<link[^>]*href=["']\.?\/?${css.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*/?>`, 'gi')
      content = content.replace(linkPattern, `<style>${css.content}</style>`)
    }

    // Injeta JS inline se houver arquivos .js
    const jsFiles = files.filter(f => f.path.endsWith('.js') || f.path.endsWith('.mjs'))
    for (const js of jsFiles) {
      const scriptPattern = new RegExp(`<script[^>]*src=["']\.?\/?${js.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*</script>`, 'gi')
      content = content.replace(scriptPattern, `<script>${js.content}</script>`)
    }

    return content
  }, [files, refreshKey])

  return (
    <div className="ai-preview-wrap">
      <div className="ai-preview-toolbar">
        <div className="ai-preview-url">
          <GlobeIcon size={14} />
          <span>preview://localhost</span>
        </div>
        <IconButton
          icon={SyncIcon}
          variant="invisible"
          size="small"
          aria-label="Recarregar"
          onClick={() => setRefreshKey(k => k + 1)}
        />
      </div>
      <iframe
        ref={iframeRef}
        key={refreshKey}
        className="ai-preview-frame"
        sandbox="allow-scripts allow-same-origin"
        srcDoc={html}
        title="Preview do projeto"
      />
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
  const {navigate} = useRouter()
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: 'Olá! Sou o assistente de criação de projetos da Hostfy. 🚀\n\nDescreva o projeto que deseja criar e eu vou gerar os arquivos para você. Os projetos gerados usam Node.js com React + shadcn/ui + Lucide Icons.\n\nVocê pode dizer algo como:\n• "Crie uma landing page com hero e seção de preços"\n• "Quero um dashboard com sidebar e gráficos"\n• "Monte um portfólio minimalista"',
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

  // Simulação local do LLM — gera arquivos com base na descrição.
  // Em produção, troque por uma chamada à API do backend com seu LLM.
  const processAiResponse = useCallback(async (userMessage) => {
    // Adiciona mensagem do usuário
    setMessages(prev => [...prev, {role: 'user', content: userMessage}])
    setSending(true)

    // Simula delay de "pensando"
    await new Promise(r => setTimeout(r, 1200))

    // Gera arquivos de exemplo — substitua por chamada real à API
    const generatedFiles = generateProjectFiles(userMessage)
    setProjectFiles(generatedFiles)

    const fileNames = generatedFiles.map(f => f.path)

    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: `Pronto! Criei o projeto com ${generatedFiles.length} arquivos:\n\n${fileNames.map(f => `• ${f}`).join('\n')}\n\nVocê pode ver o preview à direita ou editar os arquivos na aba "Arquivos". Quando estiver satisfeito, preencha o nome/slug e clique em "Publicar na Hostfy".`,
        files: fileNames,
      },
    ])
    setSending(false)
    setRightTab('preview')

    // Auto-preenche nome/slug
    if (!projectName) {
      const name = userMessage.slice(0, 60).trim()
      setProjectName(name)
      setProjectSlug(slugify(name).slice(0, 50))
    }
  }, [projectName])

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
      // Monta um index.html completo com os assets inline
      const indexFile = projectFiles.find(f => f.path === 'index.html')
      if (!indexFile) throw new Error('O projeto precisa de um index.html.')

      // Cria blob ZIP com os arquivos (simplificado — envia como formulário)
      const blob = buildProjectZip(projectFiles)
      const body = new FormData()
      body.append('name', projectName)
      body.append('slug', projectSlug)
      body.append('type', 'static')
      body.append('project', blob, 'project.zip')

      const result = await api('/api/projects', {method: 'POST', body})
      setDeployUrl(result.url)
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `🎉 Projeto publicado com sucesso!\n\nAcesse: ${result.url}\n\nVocê pode gerenciar o projeto na página de Projetos.`,
        },
      ])
      if (onRefresh) onRefresh()
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {role: 'assistant', content: `❌ Erro ao publicar: ${err.message}`},
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
          <div className="ai-chat-title">
            <RocketIcon size={16} />
            <Heading as="h2" sx={{fontSize: 16, m: 0}}>Criar projeto com IA</Heading>
          </div>
          <Label variant="accent">Node.js · React + shadcn + Lucide</Label>
        </div>

        <div className="ai-chat-messages">
          {messages.map((msg, i) => (
            <ChatMessage key={i} msg={msg} />
          ))}
          {sending ? (
            <div className="ai-msg ai-msg-assistant">
              <div className="ai-msg-avatar">✨</div>
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
            <PreviewPane files={projectFiles} />
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

/* ------------------------------------------------------------------ */
/* Geração de projeto de exemplo (substitua pela sua API de LLM)       */
/* ------------------------------------------------------------------ */

function generateProjectFiles(description) {
  const desc = description.toLowerCase()

  // CSS base com tokens shadcn-like
  const baseCss = `/* Gerado pelo Hostfy AI Builder */
:root {
  --background: #0a0a0a;
  --foreground: #fafafa;
  --card: #0f0f0f;
  --card-foreground: #fafafa;
  --primary: #fafafa;
  --primary-foreground: #0a0a0a;
  --secondary: #1a1a1a;
  --secondary-foreground: #fafafa;
  --muted: #1a1a1a;
  --muted-foreground: #a1a1aa;
  --accent: #1a1a1a;
  --accent-foreground: #fafafa;
  --destructive: #7f1d1d;
  --border: #27272a;
  --ring: #d4d4d8;
  --radius: 0.5rem;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: var(--background);
  color: var(--foreground);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }

/* Button */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 20px; border-radius: var(--radius);
  font-size: 14px; font-weight: 500; cursor: pointer;
  border: 1px solid var(--border); transition: all 0.2s;
  text-decoration: none;
}
.btn-primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
.btn-primary:hover { opacity: 0.9; }
.btn-secondary { background: var(--secondary); color: var(--secondary-foreground); }
.btn-secondary:hover { background: var(--accent); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--foreground); }
.btn-ghost:hover { background: var(--accent); }

/* Card */
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 24px;
}

/* Badge */
.badge {
  display: inline-flex; align-items: center;
  padding: 2px 10px; border-radius: 9999px;
  font-size: 12px; font-weight: 500;
  background: var(--secondary); color: var(--secondary-foreground);
  border: 1px solid var(--border);
}

/* Input */
.input {
  width: 100%; padding: 10px 14px;
  background: var(--secondary); color: var(--foreground);
  border: 1px solid var(--border); border-radius: var(--radius);
  font-size: 14px; outline: none;
}
.input:focus { border-color: var(--ring); box-shadow: 0 0 0 2px rgba(212,212,216,0.1); }

a { color: var(--foreground); }
`

  // Decide o tipo de projeto
  let htmlContent, cssExtra

  if (desc.includes('dashboard') || desc.includes('painel') || desc.includes('admin')) {
    cssExtra = `
/* Dashboard */
.dashboard { display: flex; min-height: 100vh; }
.sidebar {
  width: 260px; background: var(--card); border-right: 1px solid var(--border);
  padding: 24px 16px; display: flex; flex-direction: column; gap: 4px;
}
.sidebar-brand { font-size: 18px; font-weight: 700; padding: 8px 12px; margin-bottom: 24px; }
.sidebar-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: var(--radius);
  color: var(--muted-foreground); font-size: 14px; cursor: pointer;
  text-decoration: none; border: none; background: none; width: 100%;
}
.sidebar-item:hover, .sidebar-item.active { background: var(--accent); color: var(--foreground); }
.sidebar-item svg { width: 18px; height: 18px; }
.main-content { flex: 1; padding: 32px; overflow-y: auto; }
.main-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px; }
.main-header h1 { font-size: 24px; font-weight: 600; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 32px; }
.stat-card { padding: 20px; }
.stat-label { font-size: 13px; color: var(--muted-foreground); margin-bottom: 8px; }
.stat-value { font-size: 28px; font-weight: 700; }
.stat-change { font-size: 12px; margin-top: 4px; }
.stat-change.up { color: #22c55e; }
.stat-change.down { color: #ef4444; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th { text-align: left; padding: 12px; color: var(--muted-foreground); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
.data-table td { padding: 12px; border-bottom: 1px solid var(--border); }
@media (max-width: 768px) { .sidebar { display: none; } }
`

    htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard</title>
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="dashboard.css">
</head>
<body>
  <div class="dashboard">
    <aside class="sidebar">
      <div class="sidebar-brand">📊 Dashboard</div>
      <a href="#" class="sidebar-item active">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        Visão geral
      </a>
      <a href="#" class="sidebar-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        Usuários
      </a>
      <a href="#" class="sidebar-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        Receita
      </a>
      <a href="#" class="sidebar-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Configurações
      </a>
    </aside>
    <main class="main-content">
      <div class="main-header">
        <h1>Visão geral</h1>
        <button class="btn btn-primary">Exportar relatório</button>
      </div>
      <div class="stats-grid">
        <div class="card stat-card">
          <div class="stat-label">Receita total</div>
          <div class="stat-value">R$ 45.231</div>
          <div class="stat-change up">↑ 20.1% em relação ao mês passado</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Assinantes</div>
          <div class="stat-value">+2.350</div>
          <div class="stat-change up">↑ 180.1% em relação ao mês passado</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Vendas</div>
          <div class="stat-value">+12.234</div>
          <div class="stat-change up">↑ 19% em relação ao mês passado</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Ativos agora</div>
          <div class="stat-value">+573</div>
          <div class="stat-change up">↑ 201 desde a última hora</div>
        </div>
      </div>
      <div class="card">
        <h2 style="font-size:18px;font-weight:600;margin-bottom:16px;">Transações recentes</h2>
        <table class="data-table">
          <thead>
            <tr><th>Cliente</th><th>E-mail</th><th>Valor</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr><td>Ana Silva</td><td>ana@exemplo.com</td><td>R$ 1.999</td><td><span class="badge">Concluído</span></td></tr>
            <tr><td>Carlos Lima</td><td>carlos@exemplo.com</td><td>R$ 39</td><td><span class="badge">Pendente</span></td></tr>
            <tr><td>Maria Costa</td><td>maria@exemplo.com</td><td>R$ 299</td><td><span class="badge">Concluído</span></td></tr>
            <tr><td>João Santos</td><td>joao@exemplo.com</td><td>R$ 99</td><td><span class="badge">Concluído</span></td></tr>
            <tr><td>Lúcia Alves</td><td>lucia@exemplo.com</td><td>R$ 450</td><td><span class="badge">Cancelado</span></td></tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>
</body>
</html>`

    return [
      {path: 'index.html', content: htmlContent},
      {path: 'styles.css', content: baseCss},
      {path: 'dashboard.css', content: cssExtra},
    ]
  }

  // Default: Landing page
  cssExtra = `
/* Landing */
.nav { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border); }
.nav-brand { font-size: 20px; font-weight: 700; }
.nav-links { display: flex; gap: 8px; }
.hero { padding: 100px 0 80px; text-align: center; }
.hero h1 { font-size: 56px; font-weight: 800; line-height: 1.1; letter-spacing: -1.5px; max-width: 800px; margin: 0 auto 24px; }
.hero p { font-size: 18px; color: var(--muted-foreground); max-width: 600px; margin: 0 auto 40px; line-height: 1.7; }
.hero-buttons { display: flex; gap: 12px; justify-content: center; }
.features { padding: 80px 0; }
.features-header { text-align: center; margin-bottom: 56px; }
.features-header h2 { font-size: 36px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 12px; }
.features-header p { color: var(--muted-foreground); font-size: 16px; }
.features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
.feature-card { padding: 28px; }
.feature-icon { width: 44px; height: 44px; border-radius: var(--radius); background: var(--secondary); display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
.feature-card h3 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
.feature-card p { font-size: 14px; color: var(--muted-foreground); line-height: 1.6; }
.cta { padding: 80px 0; text-align: center; border-top: 1px solid var(--border); }
.cta h2 { font-size: 36px; font-weight: 700; margin-bottom: 16px; }
.cta p { color: var(--muted-foreground); margin-bottom: 32px; font-size: 16px; }
.footer { padding: 32px 0; border-top: 1px solid var(--border); text-align: center; color: var(--muted-foreground); font-size: 13px; }
@media (max-width: 768px) {
  .hero h1 { font-size: 36px; }
  .hero-buttons { flex-direction: column; align-items: center; }
}
`

  htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meu Projeto</title>
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="landing.css">
</head>
<body>
  <div class="container">
    <nav class="nav">
      <div class="nav-brand">🚀 MeuApp</div>
      <div class="nav-links">
        <a href="#features" class="btn btn-ghost">Features</a>
        <a href="#cta" class="btn btn-ghost">Contato</a>
        <a href="#" class="btn btn-primary">Começar grátis</a>
      </div>
    </nav>

    <section class="hero">
      <span class="badge" style="margin-bottom:16px;">✨ Versão 2.0 disponível</span>
      <h1>Construa algo incrível com velocidade</h1>
      <p>Uma plataforma moderna para criar, publicar e escalar seus projetos web. Sem configuração. Sem complicação.</p>
      <div class="hero-buttons">
        <a href="#" class="btn btn-primary">Começar agora →</a>
        <a href="#" class="btn btn-secondary">Ver demonstração</a>
      </div>
    </section>

    <section class="features" id="features">
      <div class="features-header">
        <h2>Tudo que você precisa</h2>
        <p>Ferramentas poderosas para cada etapa do seu projeto.</p>
      </div>
      <div class="features-grid">
        <div class="card feature-card">
          <div class="feature-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
          </div>
          <h3>Deploy instantâneo</h3>
          <p>Publique seu projeto em segundos. Suporte para sites estáticos, Node.js, PHP e Docker Compose.</p>
        </div>
        <div class="card feature-card">
          <div class="feature-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h3>Segurança integrada</h3>
          <p>HTTPS automático, isolamento de containers e variáveis de ambiente criptografadas.</p>
        </div>
        <div class="card feature-card">
          <div class="feature-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </div>
          <h3>Editor de arquivos</h3>
          <p>Edite código diretamente no navegador. Sem IDE local. Acesse de qualquer lugar.</p>
        </div>
      </div>
    </section>

    <section class="cta" id="cta">
      <h2>Pronto para começar?</h2>
      <p>Junte-se a milhares de desenvolvedores que já publicam com a Hostfy.</p>
      <div style="display:flex;gap:12px;justify-content:center;max-width:420px;margin:0 auto;">
        <input type="email" class="input" placeholder="Seu e-mail" />
        <button class="btn btn-primary" style="flex-shrink:0;">Criar conta</button>
      </div>
    </section>

    <footer class="footer">
      <p>© 2026 MeuApp. Feito com ❤️ usando Hostfy.</p>
    </footer>
  </div>
</body>
</html>`

  return [
    {path: 'index.html', content: htmlContent},
    {path: 'styles.css', content: baseCss},
    {path: 'landing.css', content: cssExtra},
  ]
}

/* ------------------------------------------------------------------ */
/* ZIP builder simples (cria um ZIP válido em memória)                  */
/* ------------------------------------------------------------------ */

function buildProjectZip(files) {
  // Cria ZIP minimal com deflate=0 (store) — funciona com qualquer unzipper
  const encoder = new TextEncoder()
  const parts = []
  const centralDir = []
  let offset = 0

  for (const f of files) {
    const nameBytes = encoder.encode(f.path)
    const contentBytes = encoder.encode(f.content)
    const crc = crc32(contentBytes)

    // Local file header
    const local = new ArrayBuffer(30 + nameBytes.length + contentBytes.length)
    const lv = new DataView(local)
    lv.setUint32(0, 0x04034b50, true) // sig
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // compression (store)
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0, true) // mod date
    lv.setUint32(14, crc, true) // crc32
    lv.setUint32(18, contentBytes.length, true) // compressed
    lv.setUint32(22, contentBytes.length, true) // uncompressed
    lv.setUint16(26, nameBytes.length, true) // name length
    lv.setUint16(28, 0, true) // extra length
    new Uint8Array(local, 30, nameBytes.length).set(nameBytes)
    new Uint8Array(local, 30 + nameBytes.length, contentBytes.length).set(contentBytes)
    parts.push(new Uint8Array(local))

    // Central directory entry
    const cd = new ArrayBuffer(46 + nameBytes.length)
    const cv = new DataView(cd)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true) // compression
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, contentBytes.length, true)
    cv.setUint32(24, contentBytes.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true) // local header offset
    new Uint8Array(cd, 46, nameBytes.length).set(nameBytes)
    centralDir.push(new Uint8Array(cd))

    offset += local.byteLength
  }

  const cdOffset = offset
  let cdSize = 0
  for (const c of centralDir) cdSize += c.length

  // End of central directory
  const eocd = new ArrayBuffer(22)
  const ev = new DataView(eocd)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, cdOffset, true)
  ev.setUint16(20, 0, true)

  const all = [...parts, ...centralDir, new Uint8Array(eocd)]
  const total = all.reduce((s, a) => s + a.length, 0)
  const result = new Uint8Array(total)
  let pos = 0
  for (const a of all) { result.set(a, pos); pos += a.length }

  return new Blob([result], {type: 'application/zip'})
}

function crc32(data) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}
