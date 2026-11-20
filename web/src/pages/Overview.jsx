import React, {useMemo} from 'react'
import {Button, Heading, Label, Link, Spinner, Stack, Text} from '@primer/react'
import {
  AlertIcon,
  CpuIcon,
  GlobeIcon,
  PackageIcon,
  RocketIcon,
  ServerIcon,
  UploadIcon,
} from '@primer/octicons-react'
import {Link as RouterLink} from '../router.jsx'
import {Empty, MetricCard, StatusLabel, TypeLabel, fmtBytes, fmtCpu, fmtRelative} from '../ui.jsx'
import {useStats} from '../useStats.js'

export default function OverviewPage({projects, loading, dockerEnabled, runtimeEnabled, notifications}) {
  const stats = useStats(projects)
  const summary = useMemo(() => {
    const dynamic = projects.filter(p => p.type !== 'static')
    const running = dynamic.filter(p => p.status === 'running').length
    let cpu = 0
    let mem = 0
    for (const p of dynamic) {
      const s = stats[p.id]
      if (s) {
        cpu += s.cpuPercent || 0
        mem += s.memBytes || 0
      }
    }
    return {
      total: projects.length,
      staticCount: projects.filter(p => p.type === 'static').length,
      dockerCount: projects.filter(p => p.type === 'docker').length,
      dynamic: dynamic.length,
      running,
      cpu,
      mem,
    }
  }, [projects, stats])

  if (loading) {
    return (
      <div className="loading">
        <Spinner /> <Text className="muted">Carregando painel…</Text>
      </div>
    )
  }

  const warnings = (notifications || []).filter(n => n.level === 'warning' && !n.read_at).slice(0, 3)

  return (
    <div className="page">
      <div className="page-heading">
        <Heading as="h1" variant="medium">Visão geral</Heading>
        <Text className="muted">Um resumo dos seus projetos e do consumo de recursos.</Text>
      </div>

      <div className="metrics-grid">
        <MetricCard label="Projetos" value={summary.total} hint={`${summary.staticCount} estáticos`} icon={PackageIcon} />
        <MetricCard label="Aplicações" value={summary.dynamic} hint={`${summary.running} em execução`} icon={RocketIcon} />
        <MetricCard label="Projetos Docker" value={summary.dockerCount} hint={dockerEnabled ? 'Docker disponível' : 'Docker indisponível'} icon={ServerIcon} />
        <MetricCard label="CPU total" value={fmtCpu(summary.cpu)} hint="Soma das aplicações" icon={CpuIcon} />
        <MetricCard label="Memória total" value={fmtBytes(summary.mem)} hint="Soma das aplicações" icon={ServerIcon} />
      </div>

      {warnings.length ? (
        <div className="inline-warning">
          <AlertIcon size={16} />
          <Text>
            {warnings.length} aviso(s) da limpeza automática do Docker esperando por você. Confira no sino de notificações.
          </Text>
        </div>
      ) : null}

      <div className="overview-grid">
        <div className="panel">
          <div className="panel-title">
            <div className="panel-title-main">
              <GlobeIcon className="muted" />
              <Heading as="h2" variant="small">Ações rápidas</Heading>
            </div>
          </div>
          <Stack gap="normal">
            <Button as={RouterLink} to="/deploy" block leadingVisual={UploadIcon}>
              Publicar um projeto
            </Button>
            <Button as={RouterLink} to="/docker" block leadingVisual={ServerIcon}>
              Gerenciar projetos Docker
            </Button>
            <Button as={RouterLink} to="/projects" block leadingVisual={PackageIcon}>
              Ver todos os projetos
            </Button>
          </Stack>
        </div>

        <div className="panel">
          <div className="panel-title">
            <div className="panel-title-main">
              <PackageIcon className="muted" />
              <Heading as="h2" variant="small">Projetos recentes</Heading>
            </div>
          </div>
          {projects.length === 0 ? (
            <Empty icon={PackageIcon} title="Você ainda não publicou nada">
              Comece publicando um ZIP ou um repositório do GitHub.
            </Empty>
          ) : (
            <div className="recent-list">
              {projects.slice(0, 5).map(p => (
                <div className="recent-row" key={p.id}>
                  <div className="project-info">
                    <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
                      <Text as="strong">{p.name}</Text>
                      <TypeLabel type={p.type} />
                      {p.type !== 'static' ? <StatusLabel status={p.status} /> : null}
                    </Stack>
                    <Link href={p.url} target="_blank" rel="noopener" className="project-slug">
                      {String(p.url).replace(/^https?:\/\//, '')}
                    </Link>
                  </div>
                  <Text className="muted small">{fmtRelative(p.created_at)}</Text>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}