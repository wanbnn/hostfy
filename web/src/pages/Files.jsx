import React, {useCallback, useEffect, useRef, useState} from 'react'
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
  DownloadIcon,
  FileCodeIcon,
  FileDirectoryFillIcon,
  FileIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SyncIcon,
  TrashIcon,
  UploadIcon,
} from '@primer/octicons-react'
import {api} from '../api.js'
import {Link, useRouter} from '../router.jsx'
import {Empty, fmtBytes, fmtDate} from '../ui.jsx'

function joinPath(folder, name) {
  return folder ? `${folder}/${name}` : name
}

function parentPath(folder) {
  if (!folder) return ''
  const parts = folder.split('/')
  parts.pop()
  return parts.join('/')
}

function Breadcrumbs({project, folder, onOpen}) {
  const parts = folder ? folder.split('/') : []
  return (
    <div className="crumbs">
      <Link to="/projects" className="crumb-link">
        {project.name}
      </Link>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join('/')
        return (
          <span key={target} className="crumb">
            <span className="crumb-sep">/</span>
            <button type="button" className="crumb-link" onClick={() => onOpen(target)}>
              {part}
            </button>
          </span>
        )
      })}
    </div>
  )
}

function Editor({file, onClose, onSaved}) {
  const [content, setContent] = useState(file.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setError('')
    setBusy(true)
    try {
      await api(`/api/projects/${file.projectId}/files/content`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: file.path, content}),
      })
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel file-editor">
      <div className="panel-title">
        <div className="panel-title-main">
          <FileCodeIcon className="muted" />
          <Heading as="h2" variant="small">
            {file.path}
          </Heading>
        </div>
        <Button size="small" variant="invisible" onClick={onClose}>
          Fechar
        </Button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <textarea className="code-input code-editor" value={content} onChange={e => setContent(e.target.value)} spellCheck={false} />
      <Stack direction="horizontal" gap="condensed" className="editor-actions">
        <Button variant="primary" size="small" onClick={save} loading={busy} leadingVisual={PencilIcon}>
          Salvar arquivo
        </Button>
        <Text className="muted small">As alterações só valem depois de reiniciar o projeto (quando ele é dinâmico).</Text>
      </Stack>
    </div>
  )
}

export default function FilesPage({project, loading, onChanged}) {
  const {navigate} = useRouter()
  const projectId = project?.id
  const [folder, setFolder] = useState('')
  const [entries, setEntries] = useState([])
  const [loadingFiles, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState(null)
  const [newFolder, setNewFolder] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const fileRef = useRef(null)

  const load = useCallback(
    async target => {
      if (!projectId) return
      setLoading(true)
      setError('')
      try {
        const data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(target || '')}`)
        setEntries(data.entries || [])
        setFolder(data.path || '')
      } catch (err) {
        setError(err.message)
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    load('')
  }, [load])

  async function openFile(entry) {
    setError('')
    setBusy(true)
    try {
      const data = await api(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(entry.path)}`)
      setEditor({projectId, path: data.path, content: data.content})
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function createFolder() {
    const name = newFolder.trim()
    if (!name) return
    setError('')
    setBusy(true)
    try {
      await api(`/api/projects/${projectId}/files/dir`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: joinPath(folder, name)}),
      })
      setNewFolder('')
      setShowNewFolder(false)
      await load(folder)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function upload(event) {
    const selected = Array.from(event.target.files || [])
    event.target.value = ''
    if (!selected.length) return
    setError('')
    setBusy(true)
    try {
      const body = new FormData()
      body.append('path', folder)
      for (const file of selected) body.append('files', file)
      await api(`/api/projects/${projectId}/files/upload`, {method: 'POST', body})
      await load(folder)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function rename(entry) {
    const next = window.prompt('Novo nome', entry.name)
    if (!next || next === entry.name) return
    setError('')
    setBusy(true)
    try {
      await api(`/api/projects/${projectId}/files/rename`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: entry.path, to: joinPath(folder, next)}),
      })
      await load(folder)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(entry) {
    if (!window.confirm(`Excluir "${entry.name}"${entry.type === 'dir' ? ' e tudo dentro dela' : ''}?`)) return
    setError('')
    setBusy(true)
    try {
      await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(entry.path)}`, {method: 'DELETE'})
      if (editor && editor.path === entry.path) setEditor(null)
      await load(folder)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function restart() {
    setError('')
    setBusy(true)
    try {
      await api(`/api/projects/${projectId}/restart`, {method: 'POST'})
      window.alert('Projeto reiniciado com os arquivos atualizados.')
      onChanged?.()
    } catch (err) {
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
            <Empty icon={FileDirectoryFillIcon} title="Projeto não encontrado">
              Volte para <b>Projetos</b> e escolha um projeto.
            </Empty>
          )}
      </div>
    )
  }

  const isDynamic = project.type !== 'static'

  return (
    <div className="page">
      <div className="page-heading">
        <Stack direction="horizontal" gap="normal" align="center">
          <IconButton icon={ArrowLeftIcon} aria-label="Voltar aos projetos" onClick={() => navigate('/projects')} />
          <div>
            <Heading as="h1" variant="medium">Arquivos · {project.name}</Heading>
            <Text className="muted">
              Edite, envie e organize os arquivos do projeto sem precisar republicá-lo.
            </Text>
          </div>
        </Stack>
      </div>

      <div className="panel">
        <div className="panel-title">
          <Breadcrumbs project={project} folder={folder} onOpen={load} />
          <Stack direction="horizontal" gap="condensed">
            <Button size="small" variant="invisible" leadingVisual={SyncIcon} onClick={() => load(folder)}>
              Recarregar
            </Button>
            <Button size="small" leadingVisual={PlusIcon} onClick={() => setShowNewFolder(v => !v)}>
              Nova pasta
            </Button>
            <Button size="small" variant="primary" leadingVisual={UploadIcon} onClick={() => fileRef.current?.click()}>
              Enviar
            </Button>
            {isDynamic ? (
              <Button size="small" leadingVisual={PlayIcon} onClick={restart} disabled={busy}>
                Reiniciar
              </Button>
            ) : null}
          </Stack>
        </div>
        <input ref={fileRef} type="file" multiple hidden onChange={upload} />

        {showNewFolder ? (
          <Stack direction="horizontal" gap="condensed" className="folder-form">
            <TextInput
              autoFocus
              block
              placeholder="nome-da-pasta"
              value={newFolder}
              onChange={e => setNewFolder(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') createFolder()
              }}
            />
            <Button variant="primary" onClick={createFolder} loading={busy}>
              Criar
            </Button>
            <Button variant="invisible" onClick={() => setShowNewFolder(false)}>
              Cancelar
            </Button>
          </Stack>
        ) : null}

        {error ? <div className="inline-error">{error}</div> : null}

        {loadingFiles ? (
          <div className="loading">
            <Spinner /> <Text className="muted">Carregando arquivos…</Text>
          </div>
        ) : entries.length === 0 ? (
          <Empty icon={FileDirectoryFillIcon} title="Pasta vazia">
            Envie arquivos ou crie uma subpasta para começar.
          </Empty>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th className="col-size">Tamanho</th>
                <th className="col-date">Modificado</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {folder ? (
                <tr>
                  <td>
                    <button type="button" className="file-name" onClick={() => load(parentPath(folder))}>
                      <FileDirectoryFillIcon size={14} /> ..
                    </button>
                  </td>
                  <td className="col-size" />
                  <td className="col-date" />
                  <td className="col-actions" />
                </tr>
              ) : null}
              {entries.map(entry => (
                <tr key={entry.path}>
                  <td>
                    {entry.type === 'dir' ? (
                      <button type="button" className="file-name" onClick={() => load(entry.path)}>
                        <FileDirectoryFillIcon size={14} /> {entry.name}
                      </button>
                    ) : (
                      <button type="button" className="file-name" onClick={() => openFile(entry)}>
                        <FileIcon size={14} /> {entry.name}
                      </button>
                    )}
                  </td>
                  <td className="col-size">{entry.type === 'dir' ? '—' : fmtBytes(entry.size)}</td>
                  <td className="col-date">{fmtDate(entry.modified)}</td>
                  <td className="col-actions">
                    {entry.type === 'file' ? (
                      <a
                        className="file-action"
                        href={`/api/projects/${projectId}/files/download?path=${encodeURIComponent(entry.path)}`}
                        title="Baixar"
                      >
                        <DownloadIcon size={14} />
                      </a>
                    ) : null}
                    <button type="button" className="file-action" title="Renomear" onClick={() => rename(entry)}>
                      <PencilIcon size={14} />
                    </button>
                    <button type="button" className="file-action danger" title="Excluir" onClick={() => remove(entry)}>
                      <TrashIcon size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editor ? (
        <Editor
          file={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            load(folder)
          }}
        />
      ) : null}

      <div className="panel">
        <Label variant="secondary">Dicas</Label>
        <ul className="help-list">
          <li>Arquivos de texto abrem no editor; os demais podem ser baixados.</li>
          <li>Alterações em projetos PHP/Node/Docker só valem depois de reiniciar o projeto.</li>
          <li>O projeto continua no mesmo endereço — o slug e o banco não mudam.</li>
        </ul>
      </div>
    </div>
  )
}
