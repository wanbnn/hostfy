import React, {useRef, useState} from 'react'
import {Button, FormControl, Heading, Label, Select, Stack, Text, TextInput} from '@primer/react'
import {AlertIcon, PackageIcon, ServerIcon, UploadIcon} from '@primer/octicons-react'
import {api} from '../api.js'
import {useRouter} from '../router.jsx'

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-')
}

function FileField({fileRef, fileName, help}) {
  return (
    <div>
      <span className="field-label">Arquivo do projeto (.zip)</span>
      <div className="file-drop">
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={e => help.onChange(e.target.files?.[0]?.name || '')}
        />
        <Button type="button" leadingVisual={UploadIcon} onClick={() => fileRef.current?.click()}>
          Escolher arquivo
        </Button>
        <div className="field-help">{fileName || help.text}</div>
      </div>
    </div>
  )
}

function StandardUpload({runtimeEnabled, onDone}) {
  const fileRef = useRef(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [fileName, setFileName] = useState('')
  const [type, setType] = useState('auto')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setError('')
    const file = fileRef.current?.files?.[0]
    if (!file) return setError('Escolha o arquivo ZIP do projeto.')
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
      const body = new FormData()
      body.append('name', name)
      body.append('slug', slug)
      body.append('type', type)
      body.append('env', JSON.stringify(env))
      body.append('project', file)
      const result = await api('/api/projects', {method: 'POST', body})
      onDone(result.url)
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
          <Heading as="h2" variant="small">Estático · PHP · Node.js</Heading>
        </div>
        <Label variant="accent">ZIP</Label>
      </div>
      <form onSubmit={submit}>
        <Stack gap="normal">
          {error ? <div className="inline-error">{error}</div> : null}
          <FormControl required>
            <FormControl.Label>Nome do projeto</FormControl.Label>
            <TextInput block value={name} onChange={e => setName(e.target.value)} placeholder="Meu portfólio" />
          </FormControl>
          <FormControl required>
            <FormControl.Label>Slug / endereço</FormControl.Label>
            <TextInput block leadingVisual="/" value={slug} onChange={e => setSlug(slugify(e.target.value))} placeholder="meu-portfolio" />
          </FormControl>
          <FormControl>
            <FormControl.Label>Tipo de projeto</FormControl.Label>
            <Select block value={type} onChange={e => setType(e.target.value)}>
              <Select.Option value="auto">Detectar automaticamente</Select.Option>
              <Select.Option value="static">Site estático (HTML/CSS/JS)</Select.Option>
              <Select.Option value="php">PHP</Select.Option>
              <Select.Option value="node">Node.js</Select.Option>
            </Select>
            {!runtimeEnabled ? (
              <FormControl.Caption>Somente estático está habilitado neste servidor.</FormControl.Caption>
            ) : null}
          </FormControl>
          <FormControl>
            <FormControl.Label>Variáveis de ambiente (opcional, JSON)</FormControl.Label>
            <textarea className="code-input" rows={3} value={envText} onChange={e => setEnvText(e.target.value)} placeholder={'{"NODE_ENV": "production"}'} />
          </FormControl>
          <FileField fileRef={fileRef} fileName={fileName} help={{text: 'Inclua o index.html ou package.json na raiz do ZIP', onChange: setFileName}} />
          <Button variant="primary" type="submit" block loading={busy} leadingVisual={UploadIcon}>
            Publicar projeto
          </Button>
        </Stack>
      </form>
    </div>
  )
}

function DockerUpload({dockerEnabled, onDone}) {
  const fileRef = useRef(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [fileName, setFileName] = useState('')
  const [composeFile, setComposeFile] = useState('')
  const [webService, setWebService] = useState('')
  const [webPort, setWebPort] = useState('')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setError('')
    const file = fileRef.current?.files?.[0]
    if (!file) return setError('Escolha o ZIP com o docker-compose.yml.')
    let env = {}
    if (envText.trim()) {
      try {
        env = JSON.parse(envText)
      } catch {
        return setError('As variáveis de ambiente precisam ser um JSON válido.')
      }
    }
    if (!dockerEnabled) return setError('O Docker não está disponível neste servidor.')
    setBusy(true)
    try {
      const body = new FormData()
      body.append('name', name)
      body.append('slug', slug)
      if (composeFile) body.append('compose_file', composeFile)
      if (webService) body.append('web_service', webService)
      if (webPort) body.append('web_port', webPort)
      body.append('env', JSON.stringify(env))
      body.append('project', file)
      const result = await api('/api/projects/docker', {method: 'POST', body})
      onDone(result.url)
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
          <ServerIcon className="muted" />
          <Heading as="h2" variant="small">Docker Compose</Heading>
        </div>
        <Label variant="primary">ZIP</Label>
      </div>
      <form onSubmit={submit}>
        <Stack gap="normal">
          {!dockerEnabled ? (
            <div className="inline-warning">
              <AlertIcon size={16} />
              <Text>O Docker não está disponível neste host. Publique no runner com acesso ao socket.</Text>
            </div>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}
          <FormControl required>
            <FormControl.Label>Nome do projeto</FormControl.Label>
            <TextInput block value={name} onChange={e => setName(e.target.value)} placeholder="Minha stack" />
          </FormControl>
          <FormControl required>
            <FormControl.Label>Slug / endereço</FormControl.Label>
            <TextInput block leadingVisual="/" value={slug} onChange={e => setSlug(slugify(e.target.value))} placeholder="minha-stack" />
          </FormControl>
          <div className="two-cols">
            <FormControl>
              <FormControl.Label>Arquivo do compose</FormControl.Label>
              <TextInput block value={composeFile} onChange={e => setComposeFile(e.target.value)} placeholder="docker-compose.yml" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Serviço web (opcional)</FormControl.Label>
              <TextInput block value={webService} onChange={e => setWebService(e.target.value)} placeholder="web" />
            </FormControl>
          </div>
          <div className="two-cols">
            <FormControl>
              <FormControl.Label>Porta interna (opcional)</FormControl.Label>
              <TextInput block value={webPort} onChange={e => setWebPort(e.target.value)} placeholder="80" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Variáveis de ambiente (JSON)</FormControl.Label>
              <TextInput block value={envText} onChange={e => setEnvText(e.target.value)} placeholder='{"CHAVE": "valor"}' />
            </FormControl>
          </div>
          <FileField fileRef={fileRef} fileName={fileName} help={{text: 'Inclua o docker-compose.yml na raiz do ZIP', onChange: setFileName}} />
          <Button variant="primary" type="submit" block loading={busy} leadingVisual={ServerIcon}>
            Subir com Docker Compose
          </Button>
          <Text className="muted small">
            O Hostfy roda <code>docker compose up -d --build --remove-orphans</code>. Não publique portas no host:
            o acesso é feito pelo subdomínio do projeto.
          </Text>
        </Stack>
      </form>
    </div>
  )
}

export default function DeployPage({capabilities, onDone}) {
  const {navigate} = useRouter()
  const [tab, setTab] = useState('standard')

  function handleDone(url) {
    window.alert(`Projeto publicado: ${url}`)
    onDone()
    navigate('/projects')
  }

  return (
    <div className="page">
      <div className="page-heading">
        <Heading as="h1" variant="medium">Publicar projeto</Heading>
        <Text className="muted">Envie um ZIP (estático, PHP, Node) ou um projeto Docker Compose.</Text>
      </div>

      <div className="tabs">
        <button type="button" className={tab === 'standard' ? 'active' : ''} onClick={() => setTab('standard')}>
          Estático / PHP / Node
        </button>
        <button type="button" className={tab === 'docker' ? 'active' : ''} onClick={() => setTab('docker')}>
          Docker Compose
        </button>
      </div>

      <div className="deploy-grid">
        {tab === 'standard' ? (
          <StandardUpload runtimeEnabled={capabilities.runtimeEnabled} onDone={handleDone} />
        ) : (
          <DockerUpload dockerEnabled={capabilities.dockerEnabled} onDone={handleDone} />
        )}
        <div className="panel help-panel">
          <Heading as="h2" variant="small">Como funciona</Heading>
          <ul className="help-list">
            <li><b>Estático</b>: precisa de <code>index.html</code> na raiz. Publicado no subdomínio do projeto.</li>
            <li><b>PHP</b>: detecta <code>index.php</code>/<code>composer.json</code>; docroot em <code>public/</code> quando houver.</li>
            <li><b>Node.js</b>: roda <code>npm ci</code>, o build e <code>npm start</code>.</li>
            <li><b>Docker</b>: roda o seu <code>docker-compose.yml</code>. O serviço web é publicado no subdomínio.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}