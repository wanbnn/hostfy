import React, {useCallback, useEffect, useState} from 'react'
import {
  BaseStyles,
  Button,
  Details,
  Spinner,
  Text,
  ThemeProvider,
} from '@primer/react'
import {CheckCircleIcon} from '@primer/octicons-react'
import {api} from './api.js'
import {RouterProvider, useRouter} from './router.jsx'
import {Layout} from './components/Layout.jsx'
import AuthPage from './pages/Auth.jsx'
import OverviewPage from './pages/Overview.jsx'
import ProjectsPage from './pages/Projects.jsx'
import DeployPage from './pages/Deploy.jsx'
import DockerPage from './pages/Docker.jsx'
import GithubPage from './pages/Github.jsx'
import SystemPage from './pages/System.jsx'
import FilesPage from './pages/Files.jsx'
import DatabasePage from './pages/Database.jsx'
import AiBuilderPage from './pages/AiBuilder.jsx'

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
        <Text as="strong">Usamos cookies.</Text> Utilizamos um cookie essencial para manter sua sessão
        autenticada com segurança. Não rastreamos você nem usamos cookies de publicidade.{' '}
        <Details>
          <Details.Summary>Saiba mais</Details.Summary>
          <Text as="p" className="cookie-detail">
            O cookie <b>hostly_session</b> é httpOnly, fica válido por até 7 dias e serve apenas para
            autenticar seu acesso. Ele é necessário para o login e não pode ser desativado sem encerrar a
            sessão. Nenhum dado é compartilhado com terceiros.
          </Text>
        </Details>
      </div>
      <div className="cookie-actions">
        <Button size="small" onClick={() => decide('essential')}>Apenas essenciais</Button>
        <Button variant="primary" size="small" leadingVisual={CheckCircleIcon} onClick={() => decide('all')}>
          Aceitar e continuar
        </Button>
      </div>
    </div>
  )
}

function Shell({user, onLogout}) {
  const {path} = useRouter()
  const [projects, setProjects] = useState([])
  const [capabilities, setCapabilities] = useState({runtimeEnabled: false, dockerEnabled: false})
  const [loading, setLoading] = useState(true)
  const [notifications, setNotifications] = useState([])
  const [unread, setUnread] = useState(0)

  const loadProjects = useCallback(async () => {
    const data = await api('/api/projects')
    setProjects(data.projects || [])
    setCapabilities({
      runtimeEnabled: Boolean(data.runtimeEnabled),
      dockerEnabled: Boolean(data.dockerEnabled),
      dockerVersion: data.dockerVersion || null,
      cleanupGraceHours: data.cleanupGraceHours || 24,
    })
  }, [])

  const loadNotifications = useCallback(async () => {
    try {
      const data = await api('/api/notifications')
      setNotifications(data.notifications || [])
      setUnread(data.unread || 0)
    } catch {}
  }, [])

  useEffect(() => {
    Promise.all([loadProjects(), loadNotifications()]).finally(() => setLoading(false))
  }, [loadProjects, loadNotifications])

  async function refreshAll() {
    await Promise.all([loadProjects(), loadNotifications()])
  }

  async function readAll() {
    await api('/api/notifications/read-all', {method: 'POST'})
    await loadNotifications()
  }

  async function readOne(notification) {
    if (notification.read_at) return
    await api(`/api/notifications/${notification.id}/read`, {method: 'POST'})
    await loadNotifications()
  }

  let page
  if (path.startsWith('/files/')) {
    const id = Number(path.split('/')[2])
    page = (
      <FilesPage
        project={projects.find(project => Number(project.id) === id)}
        loading={loading}
        onRefresh={refreshAll}
      />
    )
  } else if (path.startsWith('/database/')) {
    const id = Number(path.split('/')[2])
    page = (
      <DatabasePage
        project={projects.find(project => Number(project.id) === id)}
        loading={loading}
        onRefresh={refreshAll}
      />
    )
  } else if (path.startsWith('/ai-builder')) {
    page = <AiBuilderPage onRefresh={refreshAll} />
  } else if (path.startsWith('/projects')) {
    page = <ProjectsPage projects={projects} loading={loading} onRefresh={refreshAll} {...capabilities} />
  } else if (path.startsWith('/deploy')) {
    page = <DeployPage capabilities={capabilities} onDone={refreshAll} />
  } else if (path.startsWith('/docker')) {
    page = <DockerPage projects={projects} loading={loading} onRefresh={refreshAll} user={user} {...capabilities} />
  } else if (path.startsWith('/github')) {
    page = <GithubPage onRefresh={refreshAll} dockerEnabled={capabilities.dockerEnabled} />
  } else if (path.startsWith('/system')) {
    page = user?.isAdmin ? <SystemPage /> : <OverviewPage projects={projects} loading={loading} notifications={notifications} {...capabilities} />
  } else {
    page = <OverviewPage projects={projects} loading={loading} notifications={notifications} {...capabilities} />
  }

  return (
    <>
      <Layout
        user={user}
        onLogout={onLogout}
        notifications={notifications}
        unread={unread}
        onReadAll={readAll}
        onReadOne={readOne}
      >
        {page}
      </Layout>
      <CookieBanner />
    </>
  )
}

function AppRoot() {
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
    <div className="app-shell">
      {status === 'loading' ? (
        <div className="auth-wrap">
          <Spinner size="large" />
        </div>
      ) : status === 'auth' ? (
        <AuthPage onAuthed={refresh} />
      ) : (
        <Shell user={user} onLogout={logout} />
      )}
    </div>
  )
}

function App() {
  return (
    <ThemeProvider colorMode="night" nightScheme="dark">
      <BaseStyles>
        <RouterProvider>
          <AppRoot />
        </RouterProvider>
      </BaseStyles>
    </ThemeProvider>
  )
}

export default App