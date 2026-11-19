import React, {useCallback, useEffect, useRef, useState} from 'react'
import {
  BaseStyles,
  Button,
  CounterLabel,
  Details,
  FormControl,
  Heading,
  IconButton,
  Label,
  Link,
  Select,
  Spinner,
  Stack,
  Text,
  TextInput,
  ThemeProvider,
} from '@primer/react'
import {Blankslate, InlineMessage} from '@primer/react/experimental'
import {
  ArrowRightIcon,
  CheckCircleIcon,
  GlobeIcon,
  LinkExternalIcon,
  PackageIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SyncIcon,
  TerminalIcon,
  TrashIcon,
  UploadIcon,
} from '@primer/octicons-react'
import {api} from './api.js'

function Wordmark({className}) {
  return (
    <span className={className}>
      <span style={{fontWeight: 550}}>Host</span>
      <span style={{fontWeight: 900}}>fy.</span>
    </span>
  )
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Hostfy">
      <Wordmark className="wordmark" />
    </a>
  )
}

function AppHeader({children}) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Brand />
        <div>{children}</div>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* Autenticação                                                        */
/* ------------------------------------------------------------------ */
function AuthView({onAuthed}) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const isLogin = mode === 'login'

  async function submit(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api(`/api/${mode}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email, password}),
      })
      await onAuthed()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next) {
    setMode(next)
    setError('')
    setPassword('')
  }

  return (
    <div className="auth-wrap">
      <Wordmark className="auth-wordmark" />
      <Heading as="h1" className="auth-title">
        {isLogin ? 'Bem-vindo!' : 'Criar sua conta'}
      </Heading>

      <div className="auth-panel panel">
        <form onSubmit={submit}>
          <Stack gap="normal">
            {error ? (
              <InlineMessage variant="critical">{error}</InlineMessage>
            ) : null}

            <FormControl required>
              <FormControl.Label>E-mail</FormControl.Label>
              <TextInput
                block
                type="email"
                name="email"
                autoComplete="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={event => setEmail(event.target.value)}
              />
            </FormControl>

            <FormControl required>
              <FormControl.Label>Senha</FormControl.Label>
              <TextInput
                block
                type="password"
                name="password"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                placeholder={isLogin ? 'Sua senha' : 'Mínimo de 10 caracteres'}
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
              {!isLogin ? (
                <FormControl.Caption>Use pelo menos 10 caracteres.</FormControl.Caption>
              ) : null}
            </FormControl>

            <Button variant="primary" type="submit" block loading={busy} leadingVisual={ArrowRightIcon}>
              {isLogin ? 'Entrar na plataforma' : 'Criar minha conta'}
            </Button>
          </Stack>
        </form>
      </div>

      <div className="switch-box">
        {isLogin ? (
          <Text>
            Novo por aqui?{' '}
            <Link as="button" type="button" onClick={() => switchMode('register')}>
              Criar uma conta
            </Link>
          </Text>
        ) : (
          <Text>
            Já tem uma conta?{' '}
            <Link as="button" type="button" onClick={() => switchMode('login')}>
              Entrar
            </Link>
          </Text>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Painel                                                              */
/* ------------------------------------------------------------------ */
function UploadPanel({onUploaded}) {
  const fileRef = useRef(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [fileName, setFileName] = useState('')
  const [type, setType] = useState('auto')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function updateSlug(value) {
    setSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-'))
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('Escolha o arquivo ZIP do projeto.')
      return
    }
    setBusy(true)
    try {
      const body = new FormData()
      body.append('name', name)
      body.append('slug', slug)
      body.append('type', type)
      body.append('project', file)
      const result = await api('/api/projects', {method: 'POST', body})
      onUploaded(result.url)
      setName('')
      setSlug('')
      setType('auto')
      setFileName('')
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <PackageIcon className="muted" />
          <Heading as="h2" variant="small">Enviar projeto</Heading>
        </div>
        <Label variant="accent">ZIP</Label>
      </div>

      <form onSubmit={submit}>
        <Stack gap="normal">
          {error ? <InlineMessage variant="critical">{error}</InlineMessage> : null}

          <FormControl required>
            <FormControl.Label>Nome do projeto</FormControl.Label>
            <TextInput
              block
              name="name"
              maxLength={80}
              placeholder="Meu portfólio"
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </FormControl>

          <FormControl required>
            <FormControl.Label>Slug / endereço</FormControl.Label>
            <TextInput
              block
              name="slug"
              leadingVisual="/"
              placeholder="meu-portfolio"
              value={slug}
              onChange={event => updateSlug(event.target.value)}
            />
            <FormControl.Caption>
              Estáticos usam <b>/{slug || 'meu-projeto'}/</b>; PHP/Node usam o subdomínio.
            </FormControl.Caption>
          </FormControl>

          <FormControl>
            <FormControl.Label>Tipo de projeto</FormControl.Label>
            <Select block value={type} onChange={event => setType(event.target.value)}>
              <Select.Option value="auto">Detectar automaticamente</Select.Option>
              <Select.Option value="static">Site estático (HTML/CSS/JS)</Select.Option>
              <Select.Option value="php">PHP</Select.Option>
              <Select.Option value="node">Node.js</Select.Option>
            </Select>
            <FormControl.Caption>
              Node roda <code>npm ci</code> e o build (se existir) e inicia com <code>npm start</code>.
            </FormControl.Caption>
          </FormControl>

          <div>
            <span className="field-label">Arquivo do projeto (.zip)</span>
            <div className="file-drop">
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={event => setFileName(event.target.files?.[0]?.name || '')}
              />
              <Button type="button" leadingVisual={UploadIcon} onClick={() => fileRef.current?.click()}>
                Escolher arquivo
              </Button>
              <div className="field-help">
                {fileName || 'Inclua o index.html na raiz do ZIP'}
              </div>
            </div>
          </div>

          <Button variant="primary" type="submit" block loading={busy} leadingVisual={UploadIcon}>
            Publicar projeto
          </Button>
        </Stack>
      </form>
    </div>
  )
}

const TYPE_LABELS = {
  static: {text: 'Estático', variant: 'secondary'},
  php: {text: 'PHP', variant: 'accent'},
  node: {text: 'Node.js', variant: 'success'},
}

const STATUS_LABELS = {
  running: {text: 'Em execução', variant: 'success'},
  deploying: {text: 'Publicando', variant: 'attention'},
  restarting: {text: 'Reiniciando', variant: 'attention'},
  stopped: {text: 'Parado', variant: 'secondary'},
  error: {text: 'Erro', variant: 'danger'},
}

function ProjectRow({project, onDelete, onChanged}) {
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState(null)
  const [busy, setBusy] = useState(false)
  const isDynamic = project.type === 'php' || project.type === 'node'
  const typeLabel = TYPE_LABELS[project.type] || TYPE_LABELS.static
  const statusLabel = STATUS_LABELS[project.status] || {text: project.status || '—', variant: 'secondary'}
  const displayUrl = String(project.url).replace(/^https?:\/\//, '')

  async function toggleLogs() {
    const next = !showLogs
    setShowLogs(next)
    if (!next) return
    setLogs(null)
    try {
      const data = await api(`/api/projects/${project.id}/logs`)
      const text = (data.logs || []).map(entry => `[${entry.stream}] ${entry.line}`).join('\n')
      setLogs(text || 'Sem saída registrada ainda.')
    } catch (err) {
      setLogs(`Não foi possível carregar os logs: ${err.message}`)
    }
  }

  async function restart() {
    setBusy(true)
    try {
      await api(`/api/projects/${project.id}/restart`, {method: 'POST'})
      await onChanged()
    } catch (err) {
      window.alert(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-row-wrap">
      <div className="project-row">
        <div className="project-info">
          <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
            <Text as="strong">{project.name}</Text>
            <Label variant={typeLabel.variant}>{typeLabel.text}</Label>
            {isDynamic ? <Label variant={statusLabel.variant}>{statusLabel.text}</Label> : null}
          </Stack>
          <Link href={project.url} target="_blank" rel="noopener" className="project-slug">
            {displayUrl} <LinkExternalIcon size={12} />
          </Link>
        </div>
        <div className="project-actions">
          {isDynamic ? (
            <IconButton
              icon={SyncIcon}
              aria-label={`Reiniciar ${project.name}`}
              size="small"
              disabled={busy}
              onClick={restart}
            />
          ) : null}
          {isDynamic ? (
            <Button size="small" leadingVisual={TerminalIcon} onClick={toggleLogs}>
              Logs
            </Button>
          ) : null}
          <Button as="a" href={project.url} target="_blank" rel="noopener" size="small" leadingVisual={GlobeIcon}>
            Abrir
          </Button>
          <IconButton
            icon={TrashIcon}
            aria-label={`Excluir ${project.name}`}
            variant="danger"
            size="small"
            onClick={() => onDelete(project)}
          />
        </div>
      </div>
      {showLogs ? <pre className="logs-box">{logs ?? 'Carregando…'}</pre> : null}
    </div>
  )
}

function ProjectsPanel({projects, onDelete, onChanged, loading, runtimeEnabled}) {
  return (
    <div className="panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <GlobeIcon className="muted" />
          <Heading as="h2" variant="small">Publicados</Heading>
        </div>
        <CounterLabel>{projects.length}</CounterLabel>
      </div>

      {loading ? (
        <div className="loading">
          <Spinner /> <Text className="muted">Carregando projetos…</Text>
        </div>
      ) : projects.length === 0 ? (
        <Blankslate narrow>
          <Blankslate.Visual>
            <GlobeIcon size={24} />
          </Blankslate.Visual>
          <Blankslate.Heading>Nenhum projeto publicado</Blankslate.Heading>
          <Blankslate.Description>
            Envie seu primeiro ZIP ao lado para publicar um site, aplicação PHP ou Node.js.
          </Blankslate.Description>
        </Blankslate>
      ) : (
        <div>
          {!runtimeEnabled ? (
            <InlineMessage variant="warning">
              A execução de PHP/Node está desativada neste servidor. Apenas sites estáticos funcionarão.
            </InlineMessage>
          ) : null}
          {projects.map(project => (
            <ProjectRow key={project.id} project={project} onDelete={onDelete} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  )
}

function Dashboard({user, onLogout}) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [runtimeEnabled, setRuntimeEnabled] = useState(false)

  const loadProjects = useCallback(async () => {
    const data = await api('/api/projects')
    setProjects(data.projects)
    setRuntimeEnabled(Boolean(data.runtimeEnabled))
  }, [])

  useEffect(() => {
    loadProjects().finally(() => setLoading(false))
  }, [loadProjects])

  async function handleUploaded(url) {
    await loadProjects()
    window.alert(`Projeto publicado: ${url}`)
  }

  async function handleDelete(project) {
    if (!window.confirm(`Excluir "${project.name}" permanentemente?`)) return
    try {
      await api(`/api/projects/${project.id}`, {method: 'DELETE'})
      await loadProjects()
    } catch (err) {
      window.alert(err.message)
    }
  }

  return (
    <>
      <AppHeader>
        <Button leadingVisual={SignOutIcon} onClick={onLogout}>
          Sair
        </Button>
      </AppHeader>

      <main className="container">
        <div className="page-heading">
          <Stack direction="horizontal" align="center" gap="condensed">
            <Heading as="h1" variant="medium">Seus projetos</Heading>
            <Label variant="secondary">
              <ShieldCheckIcon size={12} /> {user.email}
            </Label>
          </Stack>
          <Text className="muted">
            Publique sites estáticos, aplicações PHP ou Node.js e compartilhe cada projeto por endereço próprio.
          </Text>
        </div>

        <div className="grid">
          <UploadPanel onUploaded={handleUploaded} />
          <ProjectsPanel
            projects={projects}
            onDelete={handleDelete}
            onChanged={loadProjects}
            loading={loading}
            runtimeEnabled={runtimeEnabled}
          />
        </div>
      </main>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Consentimento de cookies                                            */
/* ------------------------------------------------------------------ */
function CookieBanner() {
  const [visible, setVisible] = useState(() => {
    try {
      return !localStorage.getItem('hostly_cookie_consent')
    } catch {
      return true
    }
  })

  function decide(value) {
    try {
      localStorage.setItem('hostly_cookie_consent', value)
    } catch {}
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="cookie" role="dialog" aria-label="Aviso de cookies">
      <div className="cookie-text">
        <Text as="strong">Usamos cookies.</Text> Utilizamos um cookie essencial para manter sua
        sessão autenticada com segurança. Não rastreamos você nem usamos cookies de publicidade.{' '}
        <Details>
          <Details.Summary>Saiba mais</Details.Summary>
          <Text as="p" className="cookie-detail">
            O cookie <b>hostly_session</b> é httpOnly, fica válido por até 7 dias e serve apenas
            para autenticar seu acesso. Ele é necessário para o funcionamento do login e não pode
            ser desativado sem encerrar a sessão. Nenhum dado é compartilhado com terceiros.
          </Text>
        </Details>
      </div>
      <div className="cookie-actions">
        <Button size="small" onClick={() => decide('essential')}>
          Apenas essenciais
        </Button>
        <Button variant="primary" size="small" leadingVisual={CheckCircleIcon} onClick={() => decide('all')}>
          Aceitar e continuar
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
function App() {
  const [status, setStatus] = useState('loading')
  const [user, setUser] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/me')
      setUser(data.user)
      setStatus('dashboard')
    } catch {
      setUser(null)
      setStatus('auth')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function logout() {
    try {
      await api('/api/logout', {method: 'POST'})
    } catch {}
    setUser(null)
    setStatus('auth')
  }

  return (
    <ThemeProvider colorMode="night" nightScheme="dark">
      <BaseStyles>
        <div className="app-shell">
          {status === 'loading' ? (
            <>
              <AppHeader />
              <div className="auth-wrap">
                <Spinner size="large" />
              </div>
            </>
          ) : status === 'auth' ? (
            <>
              <AppHeader />
              <AuthView onAuthed={refresh} />
            </>
          ) : (
            <Dashboard user={user} onLogout={logout} />
          )}

          <footer className="app-footer">
            Hostfy · Hospedagem simples para a web.
          </footer>

          {status !== 'loading' ? <CookieBanner /> : null}
        </div>
      </BaseStyles>
    </ThemeProvider>
  )
}

export default App