import React, {useState} from 'react'
import {Button, IconButton, Label, Text} from '@primer/react'
import {
  BellIcon,
  CopilotIcon,
  GearIcon,
  HomeIcon,
  MarkGithubIcon,
  PackageIcon,
  ServerIcon,
  SignOutIcon,
  UploadIcon,
} from '@primer/octicons-react'
import {Link, useRouter} from '../router.jsx'
import {fmtRelative} from '../ui.jsx'

export function Wordmark({className}) {
  return (
    <span className={className}>
      <span style={{fontWeight: 550}}>Host</span>
      <span style={{fontWeight: 900}}>fy.</span>
    </span>
  )
}

const NAV = [
  {to: '/', label: 'Visão geral', icon: HomeIcon, exact: true},
  {to: '/ai-builder', label: 'Criar com IA', icon: CopilotIcon},
  {to: '/projects', label: 'Projetos', icon: PackageIcon},
  {to: '/deploy', label: 'Publicar', icon: UploadIcon},
  {to: '/docker', label: 'Docker', icon: ServerIcon},
  {to: '/github', label: 'GitHub', icon: MarkGithubIcon},
]

function isActive(path, item) {
  if (item.exact) return path === item.to
  return path === item.to || path.startsWith(`${item.to}/`)
}

function NotificationBell({notifications, unread, onReadAll, onReadOne}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="notif-wrap">
      <IconButton
        icon={BellIcon}
        variant="invisible"
        aria-label="Notificações"
        onClick={() => setOpen(v => !v)}
      />
      {unread > 0 ? <span className="notif-dot">{unread > 9 ? '9+' : unread}</span> : null}
      {open ? (
        <div className="notif-panel" role="dialog" aria-label="Notificações">
          <div className="notif-head">
            <Text as="strong">Notificações</Text>
            {unread > 0 ? (
              <Button size="small" variant="invisible" onClick={onReadAll}>
                Marcar todas como lidas
              </Button>
            ) : null}
          </div>
          {notifications.length === 0 ? (
            <div className="notif-empty">Nada por aqui.</div>
          ) : (
            <div className="notif-list">
              {notifications.slice(0, 20).map(n => (
                <button
                  key={n.id}
                  type="button"
                  className={`notif-item level-${n.level} ${n.read_at ? 'read' : ''}`}
                  onClick={() => onReadOne(n)}
                >
                  <div className="notif-title">{n.title}</div>
                  {n.body ? <div className="notif-body">{n.body}</div> : null}
                  <div className="notif-time">{fmtRelative(n.created_at)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function Layout({user, onLogout, notifications, unread, onReadAll, onReadOne, children}) {
  const {path, navigate} = useRouter()
  const items = user?.isAdmin
    ? [...NAV, {to: '/system', label: 'Sistema', icon: GearIcon}]
    : NAV

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand" href="/" aria-label="Hostfy" onClick={e => {e.preventDefault(); navigate('/')}}>
            <Wordmark className="wordmark" />
          </a>
          <nav className="nav" aria-label="Navegação principal">
            {items.map(item => {
              const Icon = item.icon
              return (
                <Link key={item.to} to={item.to} className={`nav-link ${isActive(path, item) ? 'active' : ''}`}>
                  <Icon size={15} />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </nav>
          <div className="header-actions">
            <Label variant="secondary" className="hide-small">{user?.email}</Label>
            <NotificationBell notifications={notifications} unread={unread} onReadAll={onReadAll} onReadOne={onReadOne} />
            <IconButton icon={SignOutIcon} variant="invisible" aria-label="Sair" onClick={onLogout} />
          </div>
        </div>
      </header>
      <main className="container">{children}</main>
      <footer className="app-footer">Hostfy · Hospedagem simples para a web.</footer>
    </div>
  )
}