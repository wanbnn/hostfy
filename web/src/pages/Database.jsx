import React, {useCallback, useEffect, useState} from 'react'
import {
  Button,
  Heading,
  IconButton,
  Label,
  Spinner,
  Stack,
  Text,
  TextInput,
} from '@primer/react'
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  EyeClosedIcon,
  EyeIcon,
  KeyIcon,
  PlayIcon,
  PlusIcon,
  ServerIcon,
  SyncIcon,
  TrashIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {Link, useRouter} from '../router.jsx'
import {Empty, UsageBar, fmtBytes, fmtDate} from '../ui.jsx'

async function copyText(value) {
  const text = String(value || '')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // navegador sem permissão de área de transferência — tenta o método antigo
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function Field({label, value, secret}) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const shown = secret && !revealed ? '•'.repeat(String(value || '').length) : value

  async function copy() {
    const ok = await copyText(value)
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="conn-field">
      <div className="conn-label">{label}</div>
      <div className="conn-value">
        <TextInput block readOnly value={shown} className="code-input" />
        <Stack direction="horizontal" gap="condensed">
          {secret ? (
            <IconButton
              icon={revealed ? EyeClosedIcon : EyeIcon}
              aria-label={revealed ? 'Ocultar' : 'Mostrar'}
              size="small"
              onClick={() => setRevealed(v => !v)}
            />
          ) : null}
          <IconButton icon={copied ? CheckIcon : CopyIcon} aria-label="Copiar" size="small" onClick={copy} />
        </Stack>
      </div>
    </div>
  )
}

export default function DatabasePage({project, loading, onChanged}) {
  const {navigate} = useRouter()
  const projectId = project?.id
  const [database, setDatabase] = useState(null)
  const [alertBytes, setAlertBytes] = useState(200 * 1024 * 1024)
  const [loadingDb, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tables, setTables] = useState([])
  const [sql, setSql] = useState('')
  const [result, setResult] = useState(null)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const data = await api(`/api/projects/${projectId}/database`)
      setDatabase(data.database || null)
      if (data.alertBytes) setAlertBytes(data.alertBytes)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadTables = useCallback(async () => {
    if (!projectId) return
    try {
      const data = await api(`/api/projects/${projectId}/database/tables`)
      setTables(data.tables || [])
    } catch (err) {
      setTables([])
      setError(err.message)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (database) loadTables()
  }, [database, loadTables])

  async function create() {
    setError('')
    setBusy(true)
    try {
      const data = await api(`/api/projects/${projectId}/database`, {method: 'POST'})
      setDatabase(data.database)
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword() {
    if (!window.confirm('Redefinir a senha do banco? O projeto precisará ser reiniciado com a nova senha.')) return
    setError('')
    setBusy(true)
    try {
      const data = await api(`/api/projects/${projectId}/database/password`, {method: 'POST'})
      setDatabase(data.database)
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function drop() {
    if (!window.confirm('Excluir o banco de dados deste projeto? Todos os dados serão perdidos.')) return
    setError('')
    setBusy(true)
    try {
      await api(`/api/projects/${projectId}/database`, {method: 'DELETE'})
      setDatabase(null)
      setTables([])
      setResult(null)
      onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function runQuery() {
    setError('')
    setBusy(true)
    try {
      const data = await api(`/api/projects/${projectId}/database/query`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sql}),
      })
      setResult(data)
    } catch (err) {
      setResult(null)
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!project) {
    return (
      <div className="page">
          {loading ? (
            <div className="loading">
              <Spinner /> <Text className="muted">Carregando projeto…</Text>
            </div>
          ) : (
            <Empty icon={DatabaseIcon} title="Projeto não encontrado">
              Volte para <b>Projetos</b> e escolha um projeto.
            </Empty>
          )}
      </div>
    )
  }

  const usage = database ? Math.min(100, (database.sizeBytes / alertBytes) * 100) : 0

  return (
    <div className="page">
      <div className="page-heading">
        <Stack direction="horizontal" gap="normal" align="center">
          <IconButton icon={ArrowLeftIcon} aria-label="Voltar aos projetos" onClick={() => navigate('/projects')} />
          <div>
            <Heading as="h1" variant="medium">Banco de dados · {project.name}</Heading>
            <Text className="muted">
              Um PostgreSQL dedicado para este projeto, rodando na mesma instância do servidor.
            </Text>
          </div>
        </Stack>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      {loadingDb ? (
        <div className="loading">
          <Spinner /> <Text className="muted">Carregando…</Text>
        </div>
      ) : !database ? (
        <div className="panel">
          <div className="panel-title">
            <div className="panel-title-main">
              <DatabaseIcon className="muted" />
              <Heading as="h2" variant="small">Nenhum banco de dados</Heading>
            </div>
            <Label variant="secondary">1 por projeto</Label>
          </div>
          <Text className="muted">
            Ao criar, o Hostfy cria um banco e um usuário próprios dentro do PostgreSQL do servidor
            (nenhum contêiner ou imagem extra). As variáveis de conexão são gravadas automaticamente no
            projeto e a aplicação é reiniciada.
          </Text>
          <div className="panel-actions">
            <Button variant="primary" leadingVisual={PlusIcon} onClick={create} loading={busy}>
              Criar banco de dados
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid">
            <div className="panel">
              <div className="panel-title">
                <div className="panel-title-main">
                  <ServerIcon className="muted" />
                  <Heading as="h2" variant="small">Conexão</Heading>
                </div>
                <Label variant="success">pronto</Label>
              </div>
              <div className="conn-grid">
                              <Field label="Host" value={database.host} />
                              <Field label="Porta" value={String(database.port)} />
                              <Field label="Banco" value={database.name} />
                              <Field label="Usuário" value={database.user} />
                              <Field label="Senha" value={database.password} secret />
                              <Field label="DATABASE_URL" value={database.url} />
              </div>
              <div className="panel-actions">
                <Button size="small" leadingVisual={KeyIcon} onClick={resetPassword} disabled={busy}>
                  Redefinir senha
                </Button>
                <Button size="small" variant="danger" leadingVisual={TrashIcon} onClick={drop} disabled={busy}>
                  Excluir banco
                </Button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                <div className="panel-title-main">
                  <DatabaseIcon className="muted" />
                  <Heading as="h2" variant="small">Uso do banco</Heading>
                </div>
                <IconButton icon={SyncIcon} aria-label="Atualizar" size="small" onClick={load} />
              </div>
              <div className="metric-value">{fmtBytes(database.sizeBytes)}</div>
              <div className="metric-bar">
                <UsageBar value={usage} />
              </div>
              <Text className="muted small">
                Aviso sugerido em {fmtBytes(alertBytes)} · criado em {fmtDate(database.createdAt)}
              </Text>
              {database.sizeBytes > alertBytes ? (
                <div className="inline-warning">
                  <Text>
                    O banco passou do limite sugerido. Nada é bloqueado — limpe os dados que não precisa.
                  </Text>
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">
              <div className="panel-title-main">
                <DatabaseIcon className="muted" />
                <Heading as="h2" variant="small">Tabelas</Heading>
              </div>
              <IconButton icon={SyncIcon} aria-label="Atualizar" size="small" onClick={loadTables} />
            </div>
            {tables.length === 0 ? (
              <Text className="muted">Nenhuma tabela no schema public.</Text>
            ) : (
              <table className="file-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th className="col-size">Tipo</th>
                    <th className="col-size">Linhas (aprox.)</th>
                    <th className="col-size">Tamanho</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map(table => (
                    <tr key={table.name}>
                      <td>{table.name}</td>
                      <td className="col-size">{table.kind}</td>
                      <td className="col-size">{table.approxRows}</td>
                      <td className="col-size">{fmtBytes(table.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">
              <div className="panel-title-main">
                <PlayIcon className="muted" />
                <Heading as="h2" variant="small">Console SQL</Heading>
              </div>
              <Button size="small" variant="primary" onClick={runQuery} loading={busy}>
                Executar
              </Button>
            </div>
            <textarea
              className="code-input code-editor"
              rows={6}
              value={sql}
              onChange={e => setSql(e.target.value)}
              placeholder="SELECT now();"
              spellCheck={false}
            />
            {result ? (
              result.rows && result.rows.length ? (
                <div className="sql-result">
                  <Text className="muted small">
                    {result.rowCount} linha(s){result.truncated ? ' (exibindo as primeiras 500)' : ''}
                  </Text>
                  <div className="table-scroll">
                    <table className="file-table">
                      <thead>
                        <tr>
                          {result.fields.map(field => (
                            <th key={field}>{field}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, index) => (
                          <tr key={index}>
                            {row.map((value, cell) => (
                              <td key={cell}>{value === null ? <span className="muted">NULL</span> : value}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <Text className="muted small">
                  Comando executado ({result.command || 'SQL'}) — {result.rowCount} linha(s) afetada(s).
                </Text>
              )
            ) : null}
            <ul className="help-list">
              <li>Uma instrução por vez; o resultado é limitado a 500 linhas.</li>
              <li>O console usa o mesmo usuário do projeto — ele não enxerga os outros bancos.</li>
            </ul>
          </div>
        </>
      )}

      <div className="panel">
        <Label variant="secondary">Como o projeto usa o banco</Label>
        <ul className="help-list">
          <li>
            Em PHP/Node o Hostfy já passa <code>DATABASE_URL</code>, <code>DB_HOST</code>, <code>DB_PORT</code>,{' '}
            <code>DB_NAME</code>, <code>DB_USER</code> e <code>DB_PASSWORD</code> como variáveis de ambiente.
          </li>
          <li>
            Em Docker Compose use <code>{'${DATABASE_URL}'}</code> no seu <code>docker-compose.yml</code> — o
            contêiner do projeto é conectado à rede do PostgreSQL do servidor.
          </li>
          <li>
            O host visto de dentro do contêiner do projeto é <code>db</code> e a porta <code>5432</code>.
          </li>
        </ul>
        <Text className="muted small">
          Precisa de outro ajuste? <Link to="/projects">Volte aos projetos</Link>.
        </Text>
      </div>
    </div>
  )
}
