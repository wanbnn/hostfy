import React, {useState} from 'react'
import {Button, Heading, IconButton, Link, Spinner, Stack, Text} from '@primer/react'
import {
  AlertIcon,
  CpuIcon,
  GlobeIcon,
  LinkExternalIcon,
  MarkGithubIcon,
  RocketIcon,
  ServerIcon,
  SyncIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {Link as RouterLink, useRouter} from '../router.jsx'
import {Empty, StatusLabel, UsageBar, fmtBytes, fmtCpu} from '../ui.jsx'
import {useStats} from '../useStats.js'

function DockerCard({project, stat, onChanged}) {
  const [busy, setBusy] = useState(false)
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

  return (
    <div className="docker-card">
      <div className="docker-card-head">
        <div className="project-info">
          <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
            <Text as="strong">{project.name}</Text>
            <StatusLabel status={project.status} />
            {project.source === 'github' ? (
              <Text className="muted small">
                <MarkGithubIcon size={12} /> {project.repo_full_name}
                {project.repo_ref ? ` · ${project.repo_ref}` : ''}
              </Text>
            ) : null}
          </Stack>
          <Link href={project.url} target="_blank" rel="noopener" className="project-slug">
            {String(project.url).replace(/^https?:\/\//, '')} <LinkExternalIcon size={12} />
          </Link>
        </div>
        <div className="project-actions">
          <IconButton icon={SyncIcon} aria-label="Reiniciar" size="small" disabled={busy} onClick={() => run(() => api(`/api/projects/${project.id}/restart`, {method: 'POST'}))} />
          <IconButton icon={RocketIcon} aria-label="Refazer deploy" size="small" disabled={busy} onClick={() => run(() => api(`/api/projects/${project.id}/deploy`, {method: 'POST'}))} />
          <Button size="small" disabled={busy} leadingVisual={XIcon} onClick={() => run(() => api(`/api/projects/${project.id}/stop`, {method: 'POST'}), 'Parar todos os contêineres deste projeto?')}>
            Parar
          </Button>
          <Button as="a" href={project.url} target="_blank" rel="noopener" size="small" leadingVisual={GlobeIcon}>
            Abrir
          </Button>
          <IconButton
            icon={TrashIcon}
            aria-label="Excluir"
            variant="danger"
            size="small"
            disabled={busy}
            onClick={() => run(() => api(`/api/projects/${project.id}`, {method: 'DELETE'}), `Excluir "${project.name}" e remover contêineres e volumes?`)}
          />
        </div>
      </div>
      <div className="docker-metrics">
        <span className="metric-inline">
          <CpuIcon size={12} /> CPU {fmtCpu(cpu)}
        </span>
        <span className="metric-inline">Memória {fmtBytes(mem)}</span>
        {stat?.containers != null ? <span className="metric-inline">{stat.containers} contêiner(es)</span> : null}
        <div className="metric-bar">
          <UsageBar value={Math.min(100, cpu)} />
        </div>
      </div>
      <div className="docker-meta">
        {project.compose_file ? <span>compose: <code>{project.compose_file}</code></span> : null}
        {project.web_service ? <span>serviço web: <code>{project.web_service}</code></span> : null}
        {project.web_port ? <span>porta: <code>{project.web_port}</code></span> : null}
      </div>
    </div>
  )
}

export default function DockerPage({projects, dockerEnabled, dockerVersion, onRefresh, loading, user}) {
  const {navigate} = useRouter()
  const dockerProjects = projects.filter(p => p.type === 'docker')
  const stats = useStats(dockerProjects)

  return (
    <div className="page">
      <div className="page-heading">
        <Stack direction="horizontal" align="center" justify="space-between" wrap="wrap">
          <div>
            <Heading as="h1" variant="medium">Projetos Docker</Heading>
            <Text className="muted">
              Stacks Compose gerenciadas por <code>docker compose up -d --build --remove-orphans</code>.
            </Text>
          </div>
          <Stack direction="horizontal" gap="condensed">
            <Button leadingVisual={RocketIcon} onClick={() => navigate('/deploy')}>
              Subir por ZIP
            </Button>
            <Button leadingVisual={MarkGithubIcon} onClick={() => navigate('/github')}>
              Subir do GitHub
            </Button>
            {user?.isAdmin ? (
              <Button leadingVisual={ServerIcon} onClick={() => navigate('/system')}>
                Manutenção
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </div>

      {!dockerEnabled ? (
        <div className="inline-warning">
          <AlertIcon size={16} />
          <Text>
            O Docker não está disponível neste host{dockerVersion ? '' : ''}. Verifique se o socket foi montado no runner.
          </Text>
        </div>
      ) : (
        <div className="inline-info">
          <ServerIcon size={16} />
          <Text>Docker {dockerVersion || ''} pronto para receber projetos Compose.</Text>
        </div>
      )}

      {loading ? (
        <div className="loading">
          <Spinner /> <Text className="muted">Carregando…</Text>
        </div>
      ) : dockerProjects.length === 0 ? (
        <Empty icon={ServerIcon} title="Nenhum projeto Docker ainda">
          Publique um <b>docker-compose.yml</b> por ZIP ou conecte um repositório do GitHub.
        </Empty>
      ) : (
        <div className="docker-list">
          {dockerProjects.map(project => (
            <DockerCard key={project.id} project={project} stat={stats[project.id]} onChanged={onRefresh} />
          ))}
        </div>
      )}

      <div className="panel help-panel" style={{marginTop: 16}}>
        <Heading as="h2" variant="small">Boas práticas para o Compose</Heading>
        <ul className="help-list">
          <li>Não publique portas no host (evite <code>ports: ["8080:80"]</code>); use <code>expose</code> — o Hostfy faz o proxy pelo subdomínio.</li>
          <li>Defina o serviço web principal (ex.: <code>web</code>) e a porta interna (ex.: <code>80</code>) caso a detecção não acerte.</li>
          <li>Contêineres parados, imagens e volumes sem uso são limpos automaticamente após 24h, com aviso.</li>
        </ul>
      </div>
    </div>
  )
}