import React, {useEffect, useRef, useState} from 'react'
import {
  Button,
  ConfirmationDialog,
  Dialog,
  FormControl,
  Heading,
  IconButton,
  Label,
  LinkButton,
  Pagination,
  Select,
  Spinner,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@primer/react'
import {
  AlertIcon,
  CheckCircleFillIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitBranchIcon,
  LinkExternalIcon,
  MarkGithubIcon,
  RepoIcon,
  RocketIcon,
  SearchIcon,
  SyncIcon,
  UnlinkIcon,
  XIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {useRouter} from '../router.jsx'
import {fmtRelative} from '../ui.jsx'
import '../github.css'

const PAGE_SIZE = 10

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

function ConnectCard({onConnected}) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function connect(event) {
    event.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const account = await api('/api/github/connect', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: token.trim()}),
      })
      onConnected(account)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel github-connect" aria-labelledby="github-connect-title">
      <Stack gap="normal">
        <Heading as="h2" variant="small" id="github-connect-title">Conectar conta</Heading>
        <Text className="muted">
          Use um token de acesso com permissão de leitura para <strong>Contents</strong> e <strong>Metadata</strong>
          {' '}nos repositórios que quer publicar.
        </Text>
        <form onSubmit={connect}>
          <Stack gap="normal">
            {error && <div className="inline-error" role="alert">{error}</div>}
            <FormControl required>
              <FormControl.Label>Token do GitHub</FormControl.Label>
              <TextInput block type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" />
            </FormControl>
            <div className="github-connect-actions">
              <Button variant="primary" type="submit" disabled={!token.trim()} loading={busy} leadingVisual={MarkGithubIcon}>
                Conectar ao GitHub
              </Button>
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                Criar token <LinkExternalIcon size={12} />
              </a>
            </div>
          </Stack>
        </form>
      </Stack>
    </section>
  )
}

function DeployFromRepo({repo, onClose, onRefresh, onViewProjects}) {
  const [ref, setRef] = useState(repo.defaultBranch || 'main')
  const [branches, setBranches] = useState([])
  const [name, setName] = useState(repo.name)
  const [slug, setSlug] = useState(() => slugify(repo.name).slice(0, 50).replace(/^-+|-+$/g, ''))
  const [composeFile, setComposeFile] = useState('')
  const [webService, setWebService] = useState('')
  const [webPort, setWebPort] = useState('')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [publishedUrl, setPublishedUrl] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const endpoint = '/api/github/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name) + '/branches'
    api(endpoint, {signal: controller.signal})
      .then(data => { if (!controller.signal.aborted) setBranches(data.branches || []) })
      .catch(() => {})
    return () => controller.abort()
  }, [repo.owner, repo.name])

  async function deploy(event) {
    event.preventDefault()
    if (busy) return
    setError('')
    let env = {}
    if (envText.trim()) {
      try {
        env = JSON.parse(envText)
        if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error()
      } catch {
        setError('Informe as variáveis de ambiente como um objeto JSON.')
        return
      }
    }

    setBusy(true)
    try {
      const result = await api('/api/projects/docker/github', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.name,
          ref: ref.trim(),
          name: name.trim(),
          slug: slug.replace(/^-+|-+$/g, ''),
          compose_file: composeFile.trim() || undefined,
          web_service: webService.trim() || undefined,
          web_port: webPort ? Number(webPort) : undefined,
          env,
        }),
      })
      setPublishedUrl(result.url)
    } catch (err) {
      setError(err.message)
      return
    } finally {
      setBusy(false)
    }
    if (onRefresh) void Promise.resolve().then(onRefresh).catch(() => {})
  }

  function close() {
    if (!busy) onClose()
  }

  return (
    <Dialog
      className="github-dialog"
      title={publishedUrl ? 'Projeto publicado' : 'Configurar publicação'}
      subtitle={repo.fullName}
      width="xlarge"
      position={{narrow: 'fullscreen', regular: 'center', wide: 'center'}}
      onClose={close}
    >
      {publishedUrl ? (
        <Stack gap="normal">
          <div className="github-published" role="status">
            <CheckCircleFillIcon size={20} />
            <Text>Seu projeto já pode ser aberto.</Text>
          </div>
          <div className="github-form-actions">
            <Button onClick={onViewProjects}>Ver projetos Docker</Button>
            <LinkButton variant="primary" href={publishedUrl} target="_blank" rel="noreferrer" trailingVisual={LinkExternalIcon}>
              Abrir projeto
            </LinkButton>
          </div>
        </Stack>
      ) : (
        <form onSubmit={deploy}>
          <Stack gap="normal">
            {error && <div className="inline-error" role="alert">{error}</div>}
            <FormControl disabled={busy}>
              <FormControl.Label>Branch ou referência</FormControl.Label>
              <TextInput block leadingVisual={GitBranchIcon} list="github-deploy-branches" value={ref} onChange={e => setRef(e.target.value)} />
              <FormControl.Caption>Você pode usar uma branch, uma tag ou um hash de commit.</FormControl.Caption>
            </FormControl>
            <datalist id="github-deploy-branches">
              {branches.map(branch => <option key={branch.name} value={branch.name} />)}
            </datalist>
            <div className="github-form-columns">
              <FormControl required disabled={busy}>
                <FormControl.Label>Nome do projeto</FormControl.Label>
                <TextInput block maxLength={80} value={name} onChange={e => setName(e.target.value)} />
              </FormControl>
              <FormControl required disabled={busy}>
                <FormControl.Label>Slug</FormControl.Label>
                <TextInput block leadingVisual="/" maxLength={50} value={slug} onChange={e => setSlug(slugify(e.target.value))} />
              </FormControl>
            </div>
            <details className="github-advanced">
              <summary>Configurações avançadas</summary>
              <Stack gap="normal" className="github-advanced-fields">
                <div className="github-form-columns">
                  <FormControl disabled={busy}>
                    <FormControl.Label>Arquivo Compose</FormControl.Label>
                    <TextInput block value={composeFile} onChange={e => setComposeFile(e.target.value)} placeholder="docker-compose.yml" />
                  </FormControl>
                  <FormControl disabled={busy}>
                    <FormControl.Label>Serviço web</FormControl.Label>
                    <TextInput block value={webService} onChange={e => setWebService(e.target.value)} placeholder="web" />
                  </FormControl>
                </div>
                <FormControl disabled={busy}>
                  <FormControl.Label>Porta interna</FormControl.Label>
                  <TextInput block type="number" min={1} max={65535} value={webPort} onChange={e => setWebPort(e.target.value)} placeholder="80" />
                </FormControl>
                <FormControl disabled={busy}>
                  <FormControl.Label>Variáveis de ambiente (JSON)</FormControl.Label>
                  <Textarea block rows={3} value={envText} onChange={e => setEnvText(e.target.value)} placeholder='{"CHAVE": "valor"}' />
                </FormControl>
              </Stack>
            </details>
            <div className="github-form-actions">
              <Button onClick={close} disabled={busy}>Cancelar</Button>
              <Button variant="primary" type="submit" loading={busy} leadingVisual={RocketIcon}>
                Publicar com Docker Compose
              </Button>
            </div>
          </Stack>
        </form>
      )}
    </Dialog>
  )
}

function RepositoryCard({repo, canDeploy, onSelect}) {
  return (
    <li className="github-repo">
      <div className="github-repo-title">
        <RepoIcon size={16} aria-hidden="true" />
        {repo.url ? (
          <a href={repo.url} target="_blank" rel="noreferrer" title={repo.fullName}>
            <span>{repo.fullName}</span><LinkExternalIcon size={12} aria-hidden="true" />
          </a>
        ) : <strong>{repo.fullName}</strong>}
        <Label variant={repo.private ? 'attention' : 'secondary'}>{repo.private ? 'Privado' : 'Público'}</Label>
      </div>
      {repo.description && <p className="github-repo-description" title={repo.description}>{repo.description}</p>}
      <div className="github-repo-bottom">
        <div className="github-repo-meta">
          {repo.language && <span>{repo.language}</span>}
          <span title={repo.defaultBranch}><GitBranchIcon size={13} aria-hidden="true" />{repo.defaultBranch}</span>
          {repo.updatedAt && <time dateTime={repo.updatedAt} title={new Date(repo.updatedAt).toLocaleString('pt-BR')}>{fmtRelative(repo.updatedAt)}</time>}
        </div>
        <Button size="small" onClick={() => onSelect(repo)} disabled={!canDeploy} aria-label={'Publicar ' + repo.fullName}>
          Publicar
        </Button>
      </div>
    </li>
  )
}

function renderPage({key, number, rel, href, children, ...props}) {
  const disabled = props['aria-disabled'] === 'true'
  let label = 'Página ' + number
  let content = number
  if (rel === 'prev') {
    label = 'Página anterior'
    content = <><ChevronLeftIcon size={16} />Anterior</>
  } else if (rel === 'next') {
    label = 'Próxima página'
    content = <>Próxima<ChevronRightIcon size={16} /></>
  }
  return (
    <button key={key} type="button" {...props} aria-label={label} disabled={disabled}>
      {content}
    </button>
  )
}

function RepositoryBrowser({dockerEnabled, onRefresh, onViewProjects}) {
  const [repos, setRepos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(null)
  const loaded = useRef(false)
  const list = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    const {signal} = controller
    setLoading(true)
    setError('')
    async function load() {
      const found = new Map()
      try {
        let sourcePage = 1
        while (sourcePage) {
          const data = await api('/api/github/repos?page=' + sourcePage, {signal})
          if (signal.aborted) return
          for (const repo of data.repos || []) found.set(repo.id, repo)
          if (!loaded.current) setRepos([...found.values()])
          sourcePage = data.nextPage > sourcePage ? data.nextPage : null
        }
        loaded.current = true
        setRepos([...found.values()])
      } catch (err) {
        if (!signal.aborted) setError(err.message)
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [request])

  const q = query.trim().toLowerCase()
  const filtered = repos.filter(repo => {
    const matchesVisibility = visibility === 'all' || repo.private === (visibility === 'private')
    return matchesVisibility && (!q || repo.fullName.toLowerCase().includes(q) || repo.description?.toLowerCase().includes(q))
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const start = (currentPage - 1) * PAGE_SIZE
  const visible = filtered.slice(start, start + PAGE_SIZE)
  const hasFilters = Boolean(q) || visibility !== 'all'

  function clearFilters() {
    setQuery('')
    setVisibility('all')
    setPage(1)
  }

  return (
    <section className="panel github-browser" aria-labelledby="github-repos-title" ref={list}>
      <header className="github-browser-header">
        <div>
          <Heading as="h2" variant="small" id="github-repos-title">Repositórios</Heading>
          <p className="github-result-count" role="status">
            {loading && <Spinner size="small" />}
            {loading ? (repos.length ? 'Carregando repositórios…' : 'Buscando no GitHub…')
              : filtered.length + (filtered.length === 1 ? ' repositório' : ' repositórios')}
          </p>
        </div>
        <Button size="small" leadingVisual={SyncIcon} onClick={() => setRequest(value => value + 1)} disabled={loading}>
          Atualizar
        </Button>
      </header>

      <div className="github-filters">
        <TextInput
          block
          leadingVisual={SearchIcon}
          aria-label="Buscar repositórios"
          placeholder="Buscar por nome ou descrição"
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setPage(1)
          }}
          trailingAction={query ? <TextInput.Action icon={XIcon} aria-label="Limpar busca" onClick={() => { setQuery(''); setPage(1) }} /> : undefined}
        />
        <Select aria-label="Visibilidade" value={visibility} onChange={event => { setVisibility(event.target.value); setPage(1) }}>
          <Select.Option value="all">Públicos e privados</Select.Option>
          <Select.Option value="public">Públicos</Select.Option>
          <Select.Option value="private">Privados</Select.Option>
        </Select>
      </div>

      {error && <div className="inline-error" role="alert"><AlertIcon /><div>Falha ao carregar repositórios. {error}</div></div>}
      {visible.length > 0 ? (
        <>
          <ul className="github-repo-grid" aria-label="Repositórios nesta página">
            {visible.map(repo => <RepositoryCard key={repo.id} repo={repo} canDeploy={dockerEnabled} onSelect={setSelected} />)}
          </ul>
          <footer className="github-pagination">
            <Text className="muted small" role="status">
              {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} de {filtered.length}
              {pageCount > 1 && <span> · Página {currentPage} de {pageCount}</span>}
            </Text>
            {pageCount > 1 && (
              <Pagination
                aria-label="Paginação dos repositórios"
                pageCount={pageCount}
                currentPage={currentPage}
                showPages={{narrow: false, regular: true, wide: true}}
                renderPage={renderPage}
                onPageChange={(event, next) => {
                  event.preventDefault()
                  setPage(next)
                  if (list.current?.getBoundingClientRect().top < 0) list.current.scrollIntoView({block: 'start'})
                }}
              />
            )}
          </footer>
        </>
      ) : (
        <div className="github-empty">
          {loading ? <Spinner /> : <RepoIcon size={28} />}
          <Text as="strong">
            {loading ? 'Carregando repositórios' : error ? 'Lista indisponível' : hasFilters ? 'Nenhum resultado' : 'Nenhum repositório disponível'}
          </Text>
          {!loading && !error && (
            hasFilters
              ? <Button size="small" onClick={clearFilters}>Limpar filtros</Button>
              : <Text className="muted small">Confira quais repositórios o token pode acessar.</Text>
          )}
        </div>
      )}

      {selected && (
        <DeployFromRepo
          repo={selected}
          onClose={() => setSelected(null)}
          onRefresh={onRefresh}
          onViewProjects={onViewProjects}
        />
      )}
    </section>
  )
}

export default function GithubPage({onRefresh, dockerEnabled}) {
  const {navigate} = useRouter()
  const [account, setAccount] = useState(null)
  const [accountError, setAccountError] = useState('')
  const [accountRequest, setAccountRequest] = useState(0)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api('/api/github', {signal: controller.signal})
      .then(data => { if (!controller.signal.aborted) setAccount(data) })
      .catch(error => { if (!controller.signal.aborted) setAccountError(error.message) })
    return () => controller.abort()
  }, [accountRequest])

  async function disconnect() {
    setAccountError('')
    setDisconnecting(true)
    try {
      await api('/api/github', {method: 'DELETE'})
      setAccount({connected: false})
    } catch (error) {
      setAccountError(error.message)
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="page github-page">
      <header className="github-header">
        <div className="github-heading">
          <div className="github-logo"><MarkGithubIcon size={25} aria-hidden="true" /></div>
          <div>
            <Heading as="h1" variant="medium">GitHub</Heading>
            <Text className="muted">Publique repositórios com Docker Compose.</Text>
          </div>
        </div>
        {account?.connected && (
          <div className="github-account">
            <CheckCircleFillIcon size={16} aria-hidden="true" />
            <div><small>Conta conectada</small><strong>{account.login}</strong></div>
            <IconButton
              icon={UnlinkIcon}
              variant="invisible"
              aria-label="Desvincular conta do GitHub"
              onClick={() => setConfirmDisconnect(true)}
              disabled={disconnecting}
            />
          </div>
        )}
      </header>

      {accountError && (
        <div className="inline-error github-account-error" role="alert">
          <span>{accountError}</span>
          {!account && <Button size="small" onClick={() => { setAccountError(''); setAccountRequest(value => value + 1) }}>Tentar novamente</Button>}
        </div>
      )}

      {!account && !accountError && <div className="loading" role="status"><Spinner /> <Text className="muted">Carregando integração…</Text></div>}

      {account && !account.connected && <ConnectCard onConnected={setAccount} />}

      {account?.connected && (
        <>
          {!dockerEnabled && (
            <div className="inline-warning"><AlertIcon size={16} /><Text>O Docker está indisponível neste servidor.</Text></div>
          )}
          <RepositoryBrowser dockerEnabled={dockerEnabled} onRefresh={onRefresh} onViewProjects={() => navigate('/docker')} />
        </>
      )}

      {confirmDisconnect && (
        <ConfirmationDialog
          className="github-dialog"
          title="Desvincular conta do GitHub?"
          cancelButtonContent="Cancelar"
          confirmButtonContent="Desvincular"
          confirmButtonType="danger"
          onClose={gesture => {
            setConfirmDisconnect(false)
            if (gesture === 'confirm') void disconnect()
          }}
        >
          A busca de repositórios e novas publicações pelo GitHub voltarão a ficar disponíveis quando você conectar uma conta.
        </ConfirmationDialog>
      )}
    </div>
  )
}
