import React, {useCallback, useEffect, useState} from 'react'
import {Button, Heading, Label, Spinner, Stack, Text, TextInput} from '@primer/react'
import {
  AlertIcon,
  CheckCircleIcon,
  DatabaseIcon,
  SearchIcon,
  ServerIcon,
  TrashIcon,
  ZapIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {Empty, StatusLabel, TypeLabel, fmtBytes, fmtDate, fmtRelative} from '../ui.jsx'

function DfCards({df}) {
  if (!df.length) return null
  return (
    <div className="metrics-grid">
      {df.map(row => (
        <div className="metric-card" key={row.Type}>
          <div className="metric-icon">
            <DatabaseIcon size={16} />
          </div>
          <div>
            <Text className="metric-label">{row.Type}</Text>
            <div className="metric-value">{row.TotalCount}</div>
            <Text className="metric-hint">
              {row.Size} · recuperável {row.Reclaimable}
            </Text>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function SystemPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [impact, setImpact] = useState(null)
  const [volumes, setVolumes] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api('/api/system/docker'))
    } catch (err) {
      window.alert(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function act(name, fn) {
    setBusy(name)
    try {
      await fn()
      await load()
    } catch (err) {
      window.alert(err.message)
    } finally {
      setBusy('')
    }
  }

  if (loading && !data) {
    return (
      <div className="loading">
        <Spinner /> <Text className="muted">Carregando informações do Docker…</Text>
      </div>
    )
  }

  if (!data) return <Empty icon={ServerIcon} title="Sem dados do sistema" />

  const containers = (data.containers || []).filter(c => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return c.name.toLowerCase().includes(q) || (c.image || '').toLowerCase().includes(q) || (c.project || '').toLowerCase().includes(q)
  })

  return (
    <div className="page">
      <div className="page-heading">
        <Stack direction="horizontal" align="center" justify="space-between" wrap="wrap">
          <div>
            <Heading as="h1" variant="medium">Sistema · Docker</Heading>
            <Text className="muted">
              Otimização do host: limpeza de contêineres, imagens e volumes sem uso (carência de {data.graceHours}h com aviso).
            </Text>
          </div>
          <Stack direction="horizontal" gap="condensed">
            <Button leadingVisual={SearchIcon} loading={busy === 'scan'} onClick={() => act('scan', () => api('/api/system/cleanup/scan', {method: 'POST'}))}>
              Analisar agora
            </Button>
            <Button leadingVisual={TrashIcon} loading={busy === 'run'} onClick={() => act('run', () => api('/api/system/cleanup/run', {method: 'POST'}))}>
              Executar limpeza
            </Button>
          </Stack>
        </Stack>
      </div>

      {!data.dockerEnabled ? (
        <div className="inline-warning">
          <AlertIcon size={16} />
          <Text>Docker não disponível no runner. Monte o socket em <code>/var/run/docker.sock</code> e reinicie o serviço.</Text>
        </div>
      ) : null}

      <DfCards df={data.df || []} />

      <div className="panel">
        <div className="panel-title">
          <div className="panel-title-main">
            <ZapIcon className="muted" />
            <Heading as="h2" variant="small">Prune completo (docker system prune -a -f)</Heading>
          </div>
        </div>
        <Text className="muted">
          Remove contêineres parados, redes órfãs, imagens sem uso e cache de build. Antes de executar,
          calculamos o impacto e avisamos cada usuário afetado com o motivo. Ative “volumes” para também
          remover volumes órfãos.
        </Text>
        <Stack direction="horizontal" gap="normal" align="center" style={{marginTop: 12}}>
          <label className="checkbox">
            <input type="checkbox" checked={volumes} onChange={e => setVolumes(e.target.checked)} /> incluir volumes
          </label>
          <Button
            variant="danger"
            leadingVisual={AlertIcon}
            loading={busy === 'preview'}
            onClick={() => act('preview', async () => {
              const result = await api('/api/system/prune', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({force: false, volumes}),
              })
              setImpact(result.impact)
            })}
          >
            Calcular impacto
          </Button>
          {impact ? (
            <Button
              variant="danger"
              leadingVisual={CheckCircleIcon}
              loading={busy === 'force'}
              onClick={() => act('force', async () => {
                if (!window.confirm('Executar o prune completo agora? Recursos sem uso serão removidos.')) return
                await api('/api/system/prune', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({force: true, volumes}),
                })
                setImpact(null)
              })}
            >
              Executar prune
            </Button>
          ) : null}
        </Stack>
        {impact ? (
          <div className="impact">
            <Text as="strong">Impacto estimado</Text>
            <div className="impact-grid">
              <div><b>{impact.reclaimable.containers}</b> contêiner(es) parado(s)</div>
              <div><b>{impact.reclaimable.images}</b> imagem(ns) sem uso ({fmtBytes(impact.reclaimable.imageBytes)})</div>
              <div><b>{impact.reclaimable.volumes}</b> volume(s) órfão(s)</div>
              <div><b>{impact.affectedUsers}</b> usuário(s) notificado(s)</div>
            </div>
            {impact.containers?.length ? (
              <ul className="impact-list">
                {impact.containers.slice(0, 10).map((c, i) => (
                  <li key={i}>{c.name} <span className="muted">({c.reason})</span></li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-title">
          <div className="panel-title-main">
            <AlertIcon className="muted" />
            <Heading as="h2" variant="small">Candidatos à limpeza</Heading>
          </div>
          <Label variant="secondary">{(data.candidates || []).length}</Label>
        </div>
        {(data.candidates || []).length === 0 ? (
          <Text className="muted">Nenhum recurso aguardando limpeza.</Text>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Tipo</th><th>Recurso</th><th>Motivo</th><th>Agendado</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.candidates.map(c => (
                  <tr key={c.id}>
                    <td>{c.kind}</td>
                    <td><code>{c.name || c.resource_id}</code></td>
                    <td className="wrap">{c.reason}</td>
                    <td>{c.scheduled_for ? fmtDate(c.scheduled_for) : '—'}</td>
                    <td>{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <div className="panel-title-main">
            <ServerIcon className="muted" />
            <Heading as="h2" variant="small">Contêineres do host</Heading>
          </div>
          <Label variant="secondary">{(data.containers || []).length}</Label>
        </div>
        <div className="toolbar">
          <TextInput block leadingVisual={SearchIcon} placeholder="Filtrar contêineres…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {containers.length === 0 ? (
          <Text className="muted">Nenhum contêiner.</Text>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Nome</th><th>Imagem</th><th>Estado</th><th>Projeto</th></tr>
              </thead>
              <tbody>
                {containers.map(c => (
                  <tr key={c.id}>
                    <td><code>{c.name}</code></td>
                    <td className="wrap">{c.image}</td>
                    <td>{c.state}</td>
                    <td>{c.project || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <div className="panel-title-main">
            <ServerIcon className="muted" />
            <Heading as="h2" variant="small">Projetos Docker do Hostfy</Heading>
          </div>
          <Label variant="secondary">{(data.dockerProjects || []).length}</Label>
        </div>
        {(data.dockerProjects || []).length === 0 ? (
          <Text className="muted">Nenhum projeto Docker publicado.</Text>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Nome</th><th>Slug</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.dockerProjects.map(p => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td><code>{p.slug}</code></td>
                    <td><StatusLabel status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}