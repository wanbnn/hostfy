import React, {useEffect, useRef, useState} from 'react'
import {Button, Heading, IconButton, Label, Spinner, Text, TextInput} from '@primer/react'
import {
  FileCodeIcon,
  FileDirectoryIcon,
  GlobeIcon,
  LinkExternalIcon,
  PaperAirplaneIcon,
  PersonIcon,
  PlusIcon,
  RocketIcon,
  SparkleFillIcon,
  StopIcon,
  SyncIcon,
  UndoIcon,
  XIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {streamGeneration} from '../ai-builder-stream.js'

const SUGGESTIONS = [
  {text: 'Landing page moderna com hero e seção de features', icon: RocketIcon},
  {text: 'Dashboard com sidebar, cards de métricas e tabela', icon: GlobeIcon},
  {text: 'Página de portfólio com galeria e seção about', icon: FileCodeIcon},
  {text: 'App de tarefas com lista, formulário e filtros', icon: PlusIcon},
]

const GREETING = {
  role: 'assistant',
  content: 'Descreva o projeto que você quer criar. Acompanhe as versões no preview e peça os ajustes que precisar pelo chat.',
}

const EMPTY_PREVIEW = {
  url: '',
  previousUrl: '',
  ready: false,
  loading: false,
  disabled: false,
  error: '',
  failure: null,
}

const PHASE_LABELS = {
  waiting: 'Preparando a geração…',
  writing: 'Gerando arquivos…',
  building: 'Compilando o preview…',
  repairing: 'Corrigindo automaticamente o projeto…',
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function ChatMessage({message, phase}) {
  const isUser = message.role === 'user'
  const Avatar = isUser ? PersonIcon : SparkleFillIcon
  const verbs = {create: 'Criado', update: 'Atualizado', patch: 'Editado'}
  return (
    <div className={isUser ? 'ai-msg ai-msg-user' : 'ai-msg ai-msg-assistant'}>
      <div className="ai-msg-avatar"><Avatar size={14} /></div>
      <div className="ai-msg-content">
        {message.content && <div className="ai-msg-text">{message.content}</div>}
        {message.operations?.length > 0 && (
          <div className="ai-msg-operations">
            {message.operations.map(({op, path}) => (
              <div className="ai-operation-card" key={path}>
                <div className="ai-operation-heading">{verbs[op]}</div>
                <code className="ai-operation-path">{path}</code>
              </div>
            ))}
          </div>
        )}
        {message.streaming && (
          <div className="ai-msg-thinking" role="status">
            <Spinner size="small" /> {message.pendingFile && phase === 'writing'
              ? 'Gerando ' + message.pendingFile + '…'
              : PHASE_LABELS[phase]}
          </div>
        )}
      </div>
    </div>
  )
}

function FileTree({files, selected, onSelect, onDelete, locked}) {
  if (!files.length) {
    return (
      <div className="ai-file-tree">
        <div className="ai-file-empty">
          <FileDirectoryIcon size={20} />
          <Text className="muted small">Os arquivos do projeto aparecerão aqui.</Text>
        </div>
      </div>
    )
  }

  return (
    <div className="ai-file-tree">
      {files.map(file => (
        <div className={selected === file.path ? 'ai-file-row active' : 'ai-file-row'} key={file.path}>
          <button type="button" className="ai-file-item" onClick={() => onSelect(file.path)} title={file.path}>
            <FileCodeIcon size={14} />
            <span className="ai-file-name">{file.path}</span>
          </button>
          <button
            type="button"
            className="ai-file-delete"
            aria-label={'Remover ' + file.path}
            disabled={locked}
            onClick={() => onDelete(file.path)}
          >
            <XIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function PreviewPane({preview, files, phase, publishedUrl, frameRef, onRefresh, onRepair}) {
  let status = 'Aguardando a primeira versão'
  if (preview.disabled) status = 'Preview desativado'
  else if (preview.loading) status = 'Compilando o preview…'
  else if (preview.url) status = preview.ready ? 'Preview ao vivo' : 'Última versão disponível'
  else if (preview.error) status = 'Preview indisponível'
  else if (phase) status = PHASE_LABELS[phase]

  return (
    <div className="ai-preview-wrap">
      <div className="ai-preview-toolbar">
        <div className="ai-preview-url" role="status">
          {preview.loading ? <Spinner size="small" /> : <GlobeIcon size={14} />}
          <span>{status}</span>
        </div>
        <div className="ai-preview-actions">
          {publishedUrl && <a href={publishedUrl} target="_blank" rel="noreferrer">Abrir publicado</a>}
          {files.length > 0 && !preview.disabled && (
            <IconButton
              icon={SyncIcon}
              variant="invisible"
              size="small"
              aria-label="Atualizar preview"
              disabled={Boolean(phase) || preview.loading}
              onClick={onRefresh}
            />
          )}
          {preview.url && (
            <IconButton
              icon={LinkExternalIcon}
              variant="invisible"
              size="small"
              aria-label="Abrir preview em nova aba"
              onClick={() => window.open(preview.url, '_blank', 'noopener,noreferrer')}
            />
          )}
        </div>
      </div>
      {preview.error && (
        <div className="ai-preview-error">
          <details>
            <summary>{preview.failure === 'network' ? 'Falha ao atualizar o preview' : 'Esta versão precisa de ajustes'}</summary>
            <pre>{preview.error}</pre>
          </details>
          {!phase && preview.failure !== 'network' && (
            <Button size="small" onClick={onRepair}>Corrigir com IA</Button>
          )}
        </div>
      )}
      {preview.url ? (
        <iframe
          ref={frameRef}
          className="ai-preview-frame"
          src={preview.url}
          key={preview.url}
          sandbox="allow-scripts allow-forms allow-modals allow-downloads"
          referrerPolicy="no-referrer"
          title="Preview do projeto"
        />
      ) : (
        <div className="ai-preview-placeholder">
          <GlobeIcon size={28} />
          <Text className="muted">
            {preview.disabled ? 'O servidor está com o preview desativado.' :
              preview.error ? 'Os arquivos continuam disponíveis para edição pelo chat.' :
              phase || preview.loading ? 'O projeto aparece assim que a primeira versão compilar.' :
              'Descreva o projeto no chat para começar.'}
          </Text>
        </div>
      )}
    </div>
  )
}

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
        <span className="ai-code-path"><FileCodeIcon size={14} /> {file.path}</span>
        <Label variant="secondary">{file.path.split('.').pop()}</Label>
      </div>
      <pre className="ai-code-content">{file.content}</pre>
    </div>
  )
}

export default function AiBuilderPage({onRefresh}) {
  const [messages, setMessages] = useState([GREETING])
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState('')
  const [issue, setIssue] = useState('')
  const [lastRequest, setLastRequest] = useState('')
  const [projectFiles, setProjectFiles] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [rightTab, setRightTab] = useState('preview')
  const [projectName, setProjectName] = useState('')
  const [projectSlug, setProjectSlug] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [publishedUrl, setPublishedUrl] = useState('')
  const [preview, setPreview] = useState(EMPTY_PREVIEW)
  const [undo, setUndo] = useState(null)
  const [draftId] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''))
  const generation = useRef(null)
  const previewRequest = useRef(null)
  const frameRef = useRef(null)
  const chatRef = useRef(null)
  const stickToBottom = useRef(true)
  const inputRef = useRef(null)

  useEffect(() => {
    const chat = chatRef.current
    if (chat && stickToBottom.current) chat.scrollTop = chat.scrollHeight
  }, [messages, phase])

  useEffect(() => {
    inputRef.current?.focus()
    const reportError = event => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' ||
          event.data?.type !== 'hostfy-preview-error' || typeof event.data.error !== 'string') return
      const failedUrl = frame.getAttribute('src')
      const error = event.data.error.slice(0, 1000)
      setPreview(current => current.url === failedUrl ? {
        ...current,
        url: current.previousUrl,
        previousUrl: '',
        ready: false,
        error,
        failure: 'runtime',
      } : current)
    }
    window.addEventListener('message', reportError)
    return () => {
      window.removeEventListener('message', reportError)
      generation.current?.abort()
      previewRequest.current?.abort()
    }
  }, [])

  function showPreview(url, ready) {
    setPreview(current => ({
      ...EMPTY_PREVIEW,
      url,
      previousUrl: url === current.url ? current.previousUrl : current.url,
      ready,
    }))
  }

  async function refreshPreview(files) {
    previewRequest.current?.abort()
    if (!files.length) {
      setPreview(EMPTY_PREVIEW)
      return
    }
    const controller = new AbortController()
    previewRequest.current = controller
    setPreview(current => ({...current, loading: true, ready: false}))
    try {
      const result = await api('/api/ai/preview', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({draftId, files}),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) showPreview(result.url, result.ready)
    } catch (error) {
      if (!controller.signal.aborted) setPreview(current => ({
        ...current,
        loading: false,
        error: error.message,
        failure: error.code === 'PREVIEW_BUILD' ? 'build' : 'network',
      }))
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null
    }
  }

  async function processAiResponse(description, label = description) {
    if (generation.current || deploying) return
    previewRequest.current?.abort()
    const controller = new AbortController()
    generation.current = controller
    stickToBottom.current = true
    setIssue('')
    setPhase('waiting')
    setPreview(current => ({...current, loading: false}))
    setMessages(current => [...current, {role: 'user', content: label}, {role: 'assistant', streaming: true, operations: []}])

    const before = {files: projectFiles, preview}
    const knownFiles = new Map(projectFiles.map(file => [file.path, file]))
    const operations = new Map()
    let latestVersion = 0

    function finish(content) {
      setMessages(current => [...current.slice(0, -1), {role: 'assistant', content, operations: [...operations.values()]}])
    }

    try {
      const result = await streamGeneration({draftId, description, existingFiles: projectFiles}, controller.signal, (event, data) => {
        if (event === 'writing') {
          setPhase(current => current === 'repairing' ? current : 'writing')
          if (data.path) setMessages(current => [
            ...current.slice(0, -1),
            {...current[current.length - 1], pendingFile: data.path},
          ])
        }
        if (event === 'file') {
          if (!latestVersion) {
            setUndo(before)
            setProjectName(current => current || label.slice(0, 60).trim())
            setProjectSlug(current => current || slugify(label).slice(0, 50).replace(/-$/, ''))
          }
          latestVersion = data.version
          const {op, path, content} = data
          knownFiles.set(path, {path, content})
          operations.set(path, {op, path})
          setProjectFiles([...knownFiles.values()])
          setSelectedFile(current => current || path)
          setPreview(current => ({...current, ready: false}))
          setPhase(current => current === 'repairing' ? current : 'writing')
          setMessages(current => [
            ...current.slice(0, -1),
            {...current[current.length - 1], pendingFile: null, operations: [...operations.values()]},
          ])
        } else if (event === 'build') {
          setPhase(current => current === 'repairing' ? current : 'building')
          setPreview(current => ({...current, loading: true}))
        } else if (event === 'preview') {
          showPreview(data.url, data.version === latestVersion)
          setPhase(current => current === 'repairing' ? current : 'writing')
        } else if (event === 'repair') {
          setPhase('repairing')
          setPreview(current => ({...current, loading: false}))
        }
      })

      setProjectFiles(result.files)
      setIssue(result.generationError || '')
      setPreview(current => ({
        ...current,
        loading: false,
        disabled: result.previewDisabled,
        ready: current.failure !== 'runtime' && !result.previewError && (result.ready || (!latestVersion && current.ready)),
        error: result.previewError || current.error,
        failure: result.previewError ? (result.previewRepairable ? 'build' : 'network') : current.failure,
      }))

      if (result.generationError) {
        finish(latestVersion ? 'A geração ficou incompleta. Os arquivos recebidos continuam disponíveis.' : 'A geração ficou incompleta.')
      } else if (result.previewError) {
        finish('Os arquivos foram atualizados. Confira o resultado da compilação no preview.')
      } else if (!latestVersion) {
        finish('Nenhum arquivo mudou. Descreva o próximo ajuste que você quer fazer.')
      } else if (result.repaired) {
        finish('Corrigi os erros encontrados. Você pode testar a versão e pedir mais ajustes.')
      } else {
        finish('Arquivos atualizados. Teste a versão e peça os ajustes que precisar.')
      }
    } catch (error) {
      const stopped = controller.signal.aborted
      setIssue(stopped ? 'Geração interrompida.' : error.message)
      setPreview(current => ({...current, loading: false}))
      finish(latestVersion ? 'Os arquivos recebidos estão disponíveis no rascunho.' : 'Nenhum arquivo foi recebido nesta tentativa.')
    } finally {
      if (generation.current === controller) generation.current = null
      setPhase('')
    }
  }

  function send(text) {
    const description = text.trim()
    if (!description || generation.current || deploying) return
    setInput('')
    setLastRequest(description)
    void processAiResponse(description)
  }

  function resume() {
    if (!lastRequest) return
    const description = 'Continue a partir dos arquivos atuais e preserve o que já funciona. Pedido anterior:\n' + lastRequest.slice(0, 3750)
    void processAiResponse(description, 'Continuar geração')
  }

  function repair() {
    const description = [
      'Corrija o problema abaixo nos arquivos do projeto. Preserve as partes que já funcionam.',
      lastRequest && 'Pedido mais recente: ' + lastRequest.slice(0, 1700),
      'Diagnóstico do preview: ' + preview.error.slice(0, 1700),
    ].filter(Boolean).join('\n\n')
    void processAiResponse(description, 'Corrigir o preview')
  }

  function removeFile(path) {
    const files = projectFiles.filter(file => file.path !== path)
    setUndo({files: projectFiles, preview})
    setProjectFiles(files)
    if (selectedFile === path) setSelectedFile(files[0]?.path)
    void refreshPreview(files)
  }

  function restoreDraft() {
    previewRequest.current?.abort()
    setProjectFiles(undo.files)
    setPreview({...undo.preview, loading: false})
    setSelectedFile(undo.files[0]?.path)
    setUndo(null)
    setIssue('')
    setMessages(current => [...current, {role: 'assistant', content: 'Versão anterior restaurada.'}])
  }

  const canDeploy = Boolean(projectName.trim() && projectSlug.trim() && projectFiles.length &&
    (preview.ready || preview.disabled) && !phase && !preview.loading && !deploying)

  async function handleDeploy() {
    if (!canDeploy) return
    setDeploying(true)
    try {
      const operations = projectFiles.map(file => ({op: 'update', ...file}))
      const result = await api('/api/ai/deploy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: projectName, slug: projectSlug, operations}),
      })
      setPublishedUrl(result.url)
      setMessages(current => [...current, {role: 'assistant', content: 'Projeto publicado na Hostfy.'}])
      if (onRefresh) await onRefresh()
    } catch (error) {
      setMessages(current => [...current, {role: 'assistant', content: 'Falha ao publicar. ' + error.message}])
    } finally {
      setDeploying(false)
    }
  }

  const sending = Boolean(phase)
  return (
    <div className="ai-builder">
      <div className="ai-chat-panel">
        <div className="ai-chat-header">
          <div className="ai-chat-heading">
            <Heading as="h2" sx={{fontSize: 16, m: 0}} className="ai-chat-title">
              <RocketIcon size={16} /> Criar projeto com IA
            </Heading>
          </div>
        </div>

        <div
          className="ai-chat-messages"
          ref={chatRef}
          onScroll={event => {
            const chat = event.currentTarget
            stickToBottom.current = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48
          }}
        >
          {messages.map((message, index) => <ChatMessage key={index} message={message} phase={phase} />)}
        </div>

        {messages.length === 1 && (
          <div className="ai-suggestions">
            {SUGGESTIONS.map(({text, icon: Icon}) => (
              <button key={text} type="button" className="ai-suggestion" onClick={() => send(text)}>
                <Icon size={14} />
                <span>{text}</span>
              </button>
            ))}
          </div>
        )}

        {issue && !sending && (
          <div className="ai-generation-issue" role="status">
            <span>{issue}</span>
            {lastRequest && <Button size="small" onClick={resume}>Continuar geração</Button>}
          </div>
        )}

        <div className="ai-chat-input-wrap">
          <div className="ai-chat-input">
            <textarea
              ref={inputRef}
              className="ai-chat-textarea"
              aria-label="Instruções para o projeto"
              placeholder={projectFiles.length ? 'Peça um ajuste para o projeto…' : 'Descreva o projeto que deseja criar…'}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  send(input)
                }
              }}
              rows={1}
              maxLength={4000}
            />
            {sending ? (
              <IconButton
                icon={StopIcon}
                variant="default"
                size="small"
                aria-label="Parar geração"
                onClick={() => generation.current?.abort()}
              />
            ) : (
              <IconButton
                icon={PaperAirplaneIcon}
                variant="primary"
                size="small"
                aria-label="Enviar"
                disabled={!input.trim() || deploying}
                onClick={() => send(input)}
              />
            )}
          </div>
        </div>

        {projectFiles.length > 0 && !publishedUrl && (
          <div className="ai-deploy-bar">
            <div className="ai-deploy-fields">
              <TextInput
                size="small"
                placeholder="Nome do projeto"
                value={projectName}
                onChange={event => {
                  setProjectName(event.target.value)
                  setProjectSlug(slugify(event.target.value).slice(0, 50))
                }}
              />
              <TextInput
                size="small"
                leadingVisual="/"
                placeholder="slug"
                value={projectSlug}
                onChange={event => setProjectSlug(slugify(event.target.value).slice(0, 50))}
              />
            </div>
            <Button
              variant="primary"
              size="small"
              leadingVisual={RocketIcon}
              loading={deploying}
              disabled={!canDeploy}
              onClick={handleDeploy}
            >
              Publicar na Hostfy
            </Button>
          </div>
        )}
      </div>

      <div className="ai-right-panel">
        <div className="ai-right-tabs">
          <button type="button" className={rightTab === 'preview' ? 'active' : ''} onClick={() => setRightTab('preview')}>
            <GlobeIcon size={14} /> Preview
          </button>
          <button type="button" className={rightTab === 'files' ? 'active' : ''} onClick={() => setRightTab('files')}>
            <FileDirectoryIcon size={14} /> Arquivos
            {projectFiles.length > 0 && <span className="ai-tab-badge">{projectFiles.length}</span>}
          </button>
          {undo && (
            <button type="button" className="ai-undo-button" disabled={sending || deploying} onClick={restoreDraft}>
              <UndoIcon size={14} /> Desfazer
            </button>
          )}
        </div>

        <div className="ai-right-content">
          {rightTab === 'preview' ? (
            <PreviewPane
              files={projectFiles}
              preview={preview}
              phase={phase}
              publishedUrl={publishedUrl}
              frameRef={frameRef}
              onRefresh={() => refreshPreview(projectFiles)}
              onRepair={repair}
            />
          ) : (
            <div className="ai-files-panel">
              <div className="ai-files-split">
                <FileTree files={projectFiles} selected={selectedFile} onSelect={setSelectedFile} onDelete={removeFile} locked={sending || deploying} />
                <div className="ai-files-code">
                  <CodeViewer file={projectFiles.find(file => file.path === selectedFile)} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
