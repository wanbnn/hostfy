import React, {useMemo, useState} from 'react'
import {
  Button,
  FormControl,
  Heading,
  IconButton,
  Link,
  Spinner,
  Stack,
  Text,
  TextInput,
} from '@primer/react'
import {
  AlertIcon,
  CpuIcon,
  DatabaseIcon,
  FileIcon,
  GlobeIcon,
  LinkExternalIcon,
  PencilIcon,
  PlayIcon,
  RocketIcon,
  SearchIcon,
  StopIcon,
  SyncIcon,
  TerminalIcon,
  TrashIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {Empty, StatusLabel, TypeLabel, UsageBar, fmtBytes, fmtCpu, fmtRelative} from '../ui.jsx'
import {useStats} from '../useStats.js'
import {useRouter} from '../router.jsx'

function LogsViewer({project, onClose}) {
  const [logs, setLogs] = useState(null)
  React.useEffect(() => {
    let cancelled = false
    api(`/api/projects/${project.id}/logs`)
      .then(data => {
        if (!cancelled) setLogs((data.logs || []).map(e => `[${e.stream}] ${e.line}`).join('\n') || 'Sem saída registrada ainda.')
      })
      .catch(err => {
        if (!cancelled) setLogs(`Não foi possível carregar os logs: ${err.message}`)
      })
    return () => {
      cancelled = true
    }
  }, [project.id])
  return (
    <div className="expand">
      <div className="expand-head">
        <Text as="strong">Logs · {project.name}</Text>
        <Button size="small" variant="invisible" onClick={onClose}>
          Fechar
        </Button>
      </div>
      <pre className="logs-box">{logs ?? 'Carregando…'}</pre>
    </div>
  )
}

function EditForm({project, onDone}) {
  const [name, setName] = useState(project.name)
  const [slug, setSlug] = useState(project.slug)
  const [webService, setWebService] = useState(project.web_service || '')
  const [webPort, setWebPort] = useState(project.web_port || '')
  const [envText, setEnvText] = useState(() => JSON.stringify(project.env || {}, null, 2))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isDocker = project.type === 'docker'

  async function save(event) {
    event.preventDefault()
    setError('')
    let env
    try {
      env = envText.trim() ? JSON.parse(envText) : {}
    } catch {
      setError('As variáveis de ambiente precisam ser um JSON válido, ex.: {"CHAVE": "valor"}.')
      return
    }
    setBusy(true)
    try {
      const body = {name, slug, env}
      if (isDocker) {
        body.web_service = webService
        body.web_port = webPort ? Number(webPort) : null
      }
      await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      })
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="expand" onSubmit={save}>
      <div className="expand-head">
        <Text as="strong">Editar · {project.name}</Text>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <Stack gap="normal">
        <FormControl>
          <FormControl.Label>Nome</FormControl.Label>
          <TextInput block value={name} onChange={e => setName(e.target.value)} />
        </FormControl>
        <FormControl>
          <FormControl.Label>Slug / endereço</FormControl.Label>
          <TextInput
            block
            leadingVisual="/"
            value={slug}
            onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-'))}
          />
          <FormControl.Caption>Alterar o slug reimplanta o projeto e muda o endereço.</FormControl.Caption>
        </FormControl>
        {isDocker ? (
          <div className="two-cols">
            <FormControl>
              <FormControl.Label>Serviço web</FormControl.Label>
              <TextInput block value={webService} onChange={e => setWebService(e.target.value)} placeholder="web" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Porta interna</FormControl.Label>
              <TextInput block value={webPort} onChange={e => setWebPort(e.target.value)} placeholder="80" />
            </FormControl>
          </div>
        ) : null}
        {project.type !== 'static' ? (
          <FormControl>
            <FormControl.Label>Variáveis de ambiente (JSON)</FormControl.Label>
            <textarea className="code-input" rows={5} value={envText} onChange={e => setEnvText(e.target.value)} />
          </FormControl>
        ) : null}
        <Stack direction="horizontal" gap="condensed">
          <Button variant="primary" type="submit" loading={busy} leadingVisual={PencilIcon}>
            Salvar alterações
          </Button>
          <Button type="button" onClick={onDone}>
            Cancelar
          </Button>
        </Stack>
      </Stack>
    </form>
  )
}

function ProjectCard({project, stat, onChanged, dockerEnabled, runtimeEnabled}) {
  const [mode, setMode] = useState(null) // 'logs' | 'edit'
  const [busy, setBusy] = useState(false)
  const {navigate} = useRouter()
  const isDynamic = project.type !== 'static'
  const displayUrl = String(project.url).replace(/^https?:\/\//, '')
  const cpu = stat?.cpuPercent ?? 0
  const mem = stat?.memBytes ?? 0

  async function run(fn, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true)
    try {
      await fn()
      await onChanged()
    } catch (err) {
      window.alert(err.message)
    } finally {
      setBusy(false)
    }
  }

  const action = url => () => run(() => api(url, {method: 'POST'}))

  return (
    <div className="project-card">
      <div className="project-main">
        <div className="project-info">
          <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
            <Text as="strong">{project.name}</Text>
            <TypeLabel type={project.type} />
            {isDynamic ? <StatusLabel status={project.status} /> : null}
            {project.has_database ? (
              <Text className="muted small" title="Projeto com banco de dados próprio">
                <DatabaseIcon size={12} /> banco
              </Text>
            ) : null}
            {project.source === 'github' ? <Text className="muted small">GitHub · {project.repo_full_name}</Text> : null}
          </Stack>
          <Link href={project.url} target="_blank" rel="noopener" className="project-slug">
            {displayUrl} <LinkExternalIcon size={12} />
          </Link>
          {isDynamic ? (
            <div className="project-metrics">
              <span className="metric-inline">
                <CpuIcon size={12} /> {fmtCpu(cpu)}
              </span>
              <span className="metric-inline">Mem {fmtBytes(mem)}</span>
              {stat?.containers ? <span className="metric-inline">{stat.containers} contêiner(s)</span> : null}
              <div className="metric-bar">
                <UsageBar value={Math.min(100, cpu)} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="project-actions">
          {isDynamic ? (
            <IconButton icon={SyncIcon} aria-label="Reiniciar" size="small" disabled={busy} onClick={action(`/api/projects/${project.id}/restart`)} />
          ) : null}
          {isDynamic ? (
            <IconButton icon={StopIcon} aria-label="Parar" size="small" disabled={busy} onClick={action(`/api/projects/${project.id}/stop`)} />
          ) : null}
          {isDynamic ? (
            <IconButton icon={RocketIcon} aria-label="Refazer deploy" size="small" disabled={busy} onClick={action(`/api/projects/${project.id}/deploy`)} />
          ) : null}
          {isDynamic ? (
            <Button size="small" leadingVisual={TerminalIcon} onClick={() => setMode(mode === 'logs' ? null : 'logs')}>
              Logs
            </Button>
          ) : null}
          <Button as="a" href={project.url} target="_blank" rel="noopener" size="small" leadingVisual={GlobeIcon}>
            Abrir
          </Button>
          <Button size="small" leadingVisual={FileIcon} onClick={() => navigate(`/files/${project.id}`)}>
            Arquivos
          </Button>
          <Button size="small" leadingVisual={DatabaseIcon} onClick={() => navigate(`/database/${project.id}`)}>
            Banco
          </Button>
          <IconButton icon={PencilIcon} aria-label="Editar" size="small" onClick={() => setMode(mode === 'edit' ? null : 'edit')} />
          <IconButton
            icon={TrashIcon}
            aria-label="Excluir"
            variant="danger"
            size="small"
            disabled={busy}
            onClick={() =>
              run(
                () => api(`/api/projects/${project.id}`, {method: 'DELETE'}),
                `Excluir "${project.name}" permanentemente?`
              )
            }
          />
        </div>
      </div>
      {mode === 'logs' ? <LogsViewer project={project} onClose={() => setMode(null)} /> : null}
      {mode === 'edit' ? (
        <EditForm
          project={project}
          onDone={() => {
            setMode(null)
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}

export default function ProjectsPage({projects, dockerEnabled, runtimeEnabled, onRefresh, loading}) {
  const [query, setQuery] = useState('')
  const stats = useStats(projects)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      p => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || p.type.includes(q)
    )
  }, [projects, query])

  return (
    <div className="page">
      <div className="page-heading">
        <Heading as="h1" variant="medium">Projetos</Heading>
        <Text className="muted">
          Gerencie, monitore o consumo de CPU e memória, reinicie e edite cada projeto.
        </Text>
      </div>

      {!runtimeEnabled ? (
        <div className="inline-warning">
          <AlertIcon size={16} />
          <Text>A execução de PHP/Node está desativada. Apenas sites estáticos funcionarão.</Text>
        </div>
      ) : null}
      {runtimeEnabled && !dockerEnabled ? (
        <div className="inline-warning">
          <AlertIcon size={16} />
          <Text>O Docker não está disponível neste host — projetos Docker ficarão limitados.</Text>
        </div>
      ) : null}

      <div className="toolbar">
        <TextInput
          block
          leadingVisual={SearchIcon}
          placeholder="Buscar por nome, slug ou tipo…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="loading">
          <Spinner /> <Text className="muted">Carregando projetos…</Text>
        </div>
      ) : filtered.length === 0 ? (
        <Empty icon={GlobeIcon} title="Nenhum projeto encontrado">
          Vá para <b>Publicar</b> para criar seu primeiro projeto.
        </Empty>
      ) : (
        <div className="project-list">
          {filtered.map(project => (
            <ProjectCard
              key={project.id}
              project={project}
              stat={stats[project.id]}
              onChanged={onRefresh}
              dockerEnabled={dockerEnabled}
              runtimeEnabled={runtimeEnabled}
            />
          ))}
        </div>
      )}
    </div>
  )
}