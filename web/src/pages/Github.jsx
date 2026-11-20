import React, {useCallback, useEffect, useMemo, useState} from 'react'
import {Button, FormControl, Heading, Label, Spinner, Stack, Text, TextInput} from '@primer/react'
import {
  AlertIcon,
  CheckCircleIcon,
  GitBranchIcon,
  MarkGithubIcon,
  RepoIcon,
  RocketIcon,
  SearchIcon,
  TrashIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {useRouter} from '../router.jsx'
import {fmtRelative} from '../ui.jsx'

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-')
}

function ConnectCard({onConnected}) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function connect(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api('/api/github/connect', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token}),
      })
      onConnected()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel narrow-panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <MarkGithubIcon className="muted" />
          <Heading as="h2" variant="small">Conectar GitHub</Heading>
        </div>
      </div>
      <Stack gap="normal">
        {error ? <div className="inline-error">{error}</div> : null}
        <Text className="muted">
          Crie um <b>Personal Access Token</b> (fine-grained) com acesso de leitura a <i>Contents</i> e <i>Metadata</i>
          nos repositórios desejados. Para repositórios privados, marque-os explicitamente.
        </Text>
        <form onSubmit={connect}>
          <Stack gap="normal">
            <FormControl required>
              <FormControl.Label>Token do GitHub</FormControl.Label>
              <TextInput block type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="ghp_…" />
            </FormControl>
            <Button variant="primary" type="submit" block loading={busy} leadingVisual={MarkGithubIcon}>
              Conectar conta
            </Button>
          </Stack>
        </form>
      </Stack>
    </div>
  )
}

function DeployFromRepo({repo, onDone}) {
  const [ref, setRef] = useState(repo.defaultBranch || 'main')
  const [branches, setBranches] = useState([])
  const [name, setName] = useState(repo.name)
  const [slug, setSlug] = useState(slugify(repo.name))
  const [composeFile, setComposeFile] = useState('')
  const [webService, setWebService] = useState('')
  const [webPort, setWebPort] = useState('')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api(`/api/github/repos/${repo.owner}/${repo.name}/branches`)
      .then(data => {
        if (!cancelled) setBranches(data.branches || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [repo.owner, repo.name])

  async function deploy(event) {
    event.preventDefault()
    setError('')
    let env = {}
    if (envText.trim()) {
      try {
        env = JSON.parse(envText)
      } catch {
        return setError('As variáveis de ambiente precisam ser um JSON válido.')
      }
    }
    setBusy(true)
    try {
      const body = {
        owner: repo.owner,
        repo: repo.name,
        ref,
        name,
        slug,
        compose_file: composeFile || undefined,
        web_service: webService || undefined,
        web_port: webPort ? Number(webPort) : undefined,
        env,
      }
      const result = await api('/api/projects/docker/github', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      })
      onDone(result.url)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel" onSubmit={deploy}>
      <div className="panel-title">
        <div className="panel-title-main">
          <RocketIcon className="muted" />
          <Heading as="h2" variant="small">Publicar {repo.fullName}</Heading>
        </div>
        {repo.private ? <Label variant="attention">Privado</Label> : <Label variant="secondary">Público</Label>}
      </div>
      <Stack gap="normal">
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="two-cols">
          <FormControl>
            <FormControl.Label>Branch / ref</FormControl.Label>
            {branches.length ? (
              <TextInput block value={ref} onChange={e => setRef(e.target.value)} />
            ) : (
              <TextInput block leadingVisual={GitBranchIcon} value={ref} onChange={e => setRef(e.target.value)} />
            )}
            {branches.length ? (
              <FormControl.Caption>{branches.length} branches disponíveis (ex.: {branches[0].name}).</FormControl.Caption>
            ) : null}
          </FormControl>
          <FormControl required>
            <FormControl.Label>Nome do projeto</FormControl.Label>
            <TextInput block value={name} onChange={e => setName(e.target.value)} />
          </FormControl>
        </div>
        <FormControl required>
          <FormControl.Label>Slug</FormControl.Label>
          <TextInput block leadingVisual="/" value={slug} onChange={e => setSlug(slugify(e.target.value))} />
        </FormControl>
        <div className="two-cols">
          <FormControl>
            <FormControl.Label>Arquivo do compose</FormControl.Label>
            <TextInput block value={composeFile} onChange={e => setComposeFile(e.target.value)} placeholder="docker-compose.yml" />
          </FormControl>
          <FormControl>
            <FormControl.Label>Serviço web</FormControl.Label>
            <TextInput block value={webService} onChange={e => setWebService(e.target.value)} placeholder="web" />
          </FormControl>
        </div>
        <div className="two-cols">
          <FormControl>
            <FormControl.Label>Porta interna</FormControl.Label>
            <TextInput block value={webPort} onChange={e => setWebPort(e.target.value)} placeholder="80" />
          </FormControl>
          <FormControl>
            <FormControl.Label>Variáveis de ambiente (JSON)</FormControl.Label>
            <TextInput block value={envText} onChange={e => setEnvText(e.target.value)} placeholder='{"CHAVE": "valor"}' />
          </FormControl>
        </div>
        <Button variant="primary" type="submit" block loading={busy} leadingVisual={RocketIcon}>
          Baixar e subir com Docker Compose
        </Button>
        <Text className="muted small">
          Deploy refaz o download do código e roda <code>docker compose up -d --build --remove-orphans</code>.
        </Text>
      </Stack>
    </form>
  )
}

export default function GithubPage({onRefresh, dockerEnabled}) {
  const {navigate} = useRouter()
  const [account, setAccount] = useState(null)
  const [repos, setRepos] = useState([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)

  const loadAccount = useCallback(async () => {
    const data = await api('/api/github')
    setAccount(data)
    return data
  }, [])

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true)
    try {
      const data = await api('/api/github/repos')
      setRepos(data.repos || [])
    } catch (err) {
      window.alert(err.message)
    } finally {
      setLoadingRepos(false)
    }
  }, [])

  useEffect(() => {
    loadAccount().then(data => {
      if (data.connected) loadRepos()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function disconnect() {
    if (!window.confirm('Desvincular a conta do GitHub?')) return
    await api('/api/github', {method: 'DELETE'})
    setAccount({connected: false})
    setRepos([])
    setSelected(null)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter(r => r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
  }, [repos, query])

  function handleDeployed(url) {
    window.alert(`Projeto publicado: ${url}`)
    onRefresh()
    navigate('/docker')
  }

  if (!account) {
    return (
      <div className="loading">
        <Spinner /> <Text className="muted">Carregando integração…</Text>
      </div>
    )
  }

  if (!account.connected) {
    return (
      <div className="page">
        <div className="page-heading">
          <Heading as="h1" variant="medium">GitHub</Heading>
          <Text className="muted">Vincule sua conta para publicar repositórios públicos e privados.</Text>
        </div>
        <ConnectCard onConnected={() => loadAccount().then(() => loadRepos())} />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-heading">
        <Stack direction="horizontal" align="center" justify="space-between" wrap="wrap">
          <div>
            <Heading as="h1" variant="medium">GitHub</Heading>
            <Stack direction="horizontal" gap="condensed" align="center">
              <CheckCircleIcon size={14} />
              <Text className="muted">
                Conectado como <b>{account.login}</b>
                {account.scopes ? ` · escopos: ${account.scopes}` : ''}
              </Text>
            </Stack>
          </div>
          <Button leadingVisual={TrashIcon} variant="danger" onClick={disconnect}>
            Desvincular
          </Button>
        </Stack>
      </div>

      {!dockerEnabled ? (
        <div className="inline-warning">
          <AlertIcon size={16} />
          <Text>O Docker não está disponível neste host. Os deploys do GitHub ficarão indisponíveis.</Text>
        </div>
      ) : null}

      {selected ? (
        <DeployFromRepo repo={selected} onDone={handleDeployed} />
      ) : (
        <div className="panel">
          <div className="panel-title">
            <div className="panel-title-main">
              <RepoIcon className="muted" />
              <Heading as="h2" variant="small">Seus repositórios</Heading>
            </div>
            <Button size="small" onClick={loadRepos} loading={loadingRepos}>
              Atualizar
            </Button>
          </div>
          <div className="toolbar">
            <TextInput block leadingVisual={SearchIcon} placeholder="Buscar repositório…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          {loadingRepos ? (
            <div className="loading">
              <Spinner /> <Text className="muted">Carregando repositórios…</Text>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <Text as="strong">Nenhum repositório encontrado</Text>
            </div>
          ) : (
            <div className="repo-list">
              {filtered.map(repo => (
                <div className="repo-row" key={repo.id}>
                  <div className="project-info">
                    <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
                      <Text as="strong">{repo.fullName}</Text>
                      {repo.private ? <Label variant="attention">Privado</Label> : <Label variant="secondary">Público</Label>}
                      {repo.language ? <Text className="muted small">{repo.language}</Text> : null}
                    </Stack>
                    {repo.description ? <Text className="muted small">{repo.description}</Text> : null}
                    <Text className="muted small">Atualizado {fmtRelative(repo.updatedAt)}</Text>
                  </div>
                  <Button size="small" variant="primary" leadingVisual={RocketIcon} onClick={() => setSelected(repo)}>
                    Publicar
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}