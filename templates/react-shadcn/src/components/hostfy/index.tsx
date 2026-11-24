import * as React from 'react'
import { Menu, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './styles.css'

export type HostfyNavItem = {
  label: string
  href: string
  icon?: LucideIcon
}

export type AppShellProps = {
  brand: React.ReactNode
  navItems?: HostfyNavItem[]
  activeHref?: string
  header?: React.ReactNode
  sidebarFooter?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/** Grid-based application frame with a flow-based, collapsible mobile menu. */
export function AppShell({
  brand,
  navItems = [],
  activeHref,
  header,
  sidebarFooter,
  children,
  className,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const shellClassName = ['hostfy-shell', className].filter(Boolean).join(' ')

  const renderNav = (navClassName: string) => (
    <nav className={navClassName} aria-label="Navegação principal">
      {navItems.map(({ label, href, icon: Icon }) => {
        const active = href === activeHref
        return (
          <a
            key={href}
            href={href}
            className="hostfy-nav-link"
            aria-current={active ? 'page' : undefined}
            onClick={() => setMobileNavOpen(false)}
          >
            {Icon ? <Icon size={18} aria-hidden="true" /> : null}
            <span>{label}</span>
          </a>
        )
      })}
    </nav>
  )

  return (
    <div className={shellClassName}>
      <aside className="hostfy-sidebar">
        <div className="hostfy-brand">{brand}</div>
        {renderNav('hostfy-sidebar-nav')}
        {sidebarFooter ? <div className="hostfy-sidebar-footer">{sidebarFooter}</div> : null}
      </aside>

      <div className="hostfy-main-column">
        <header className="hostfy-topbar">
          <button
            type="button"
            className="hostfy-mobile-toggle"
            aria-label={mobileNavOpen ? 'Fechar menu' : 'Abrir menu'}
            aria-expanded={mobileNavOpen}
            aria-controls="hostfy-mobile-navigation"
            onClick={() => setMobileNavOpen(open => !open)}
          >
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="hostfy-mobile-brand">{brand}</div>
          {header ? <div className="hostfy-topbar-content">{header}</div> : null}
        </header>

        {mobileNavOpen ? (
          <div id="hostfy-mobile-navigation" className="hostfy-mobile-navigation">
            {renderNav('hostfy-mobile-nav')}
            {sidebarFooter ? <div className="hostfy-mobile-footer">{sidebarFooter}</div> : null}
          </div>
        ) : null}

        <main className="hostfy-main-content">{children}</main>
      </div>
    </div>
  )
}

export type PageHeaderProps = {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={['hostfy-page-header', className].filter(Boolean).join(' ')}>
      <div className="hostfy-page-heading">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="hostfy-page-actions">{actions}</div> : null}
    </header>
  )
}

export type ContentGridProps = React.HTMLAttributes<HTMLDivElement> & {
  columns?: 1 | 2 | 3 | 4
}

export function ContentGrid({ columns = 3, className, ...props }: ContentGridProps) {
  return (
    <div
      className={['hostfy-content-grid', className].filter(Boolean).join(' ')}
      data-columns={columns}
      {...props}
    />
  )
}

export type MetricCardProps = {
  label: React.ReactNode
  value: React.ReactNode
  change?: React.ReactNode
  hint?: React.ReactNode
  icon?: LucideIcon
  changeTone?: 'positive' | 'negative' | 'neutral'
  className?: string
}

export function MetricCard({
  label,
  value,
  change,
  hint,
  icon: Icon,
  changeTone = 'neutral',
  className,
}: MetricCardProps) {
  return (
    <section className={['hostfy-metric-card', className].filter(Boolean).join(' ')}>
      <div className="hostfy-metric-topline">
        <span className="hostfy-metric-label">{label}</span>
        {Icon ? <Icon className="hostfy-metric-icon" size={18} aria-hidden="true" /> : null}
      </div>
      <div className="hostfy-metric-value">{value}</div>
      {change || hint ? (
        <div className="hostfy-metric-foot">
          {change ? <span className={`hostfy-metric-change hostfy-tone-${changeTone}`}>{change}</span> : null}
          {hint ? <span className="hostfy-muted">{hint}</span> : null}
        </div>
      ) : null}
    </section>
  )
}

export type PanelProps = Omit<React.HTMLAttributes<HTMLElement>, 'title'> & {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}

export function Panel({ title, description, action, className, children, ...props }: PanelProps) {
  const hasHeading = title || description || action
  return (
    <section className={['hostfy-panel', className].filter(Boolean).join(' ')} {...props}>
      {hasHeading ? (
        <div className="hostfy-panel-header">
          <div className="hostfy-panel-heading">
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {action ? <div className="hostfy-panel-action">{action}</div> : null}
        </div>
      ) : null}
      <div className="hostfy-panel-content">{children}</div>
    </section>
  )
}

export type DataTableColumn<Row extends Record<string, React.ReactNode>> = {
  key: keyof Row
  label: string
  align?: 'left' | 'center' | 'right'
}

export type DataTableProps<Row extends Record<string, React.ReactNode>> = {
  columns: DataTableColumn<Row>[]
  rows: Row[]
  getRowKey?: (row: Row, index: number) => React.Key
  emptyMessage?: string
}

export function DataTable<Row extends Record<string, React.ReactNode>>({
  columns,
  rows,
  getRowKey,
  emptyMessage = 'Nenhum registro encontrado.',
}: DataTableProps<Row>) {
  return (
    <div className="hostfy-table-scroll">
      <table className="hostfy-table">
        <thead>
          <tr>
            {columns.map(column => (
              <th key={String(column.key)} data-align={column.align || 'left'} scope="col">{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, index) => (
            <tr key={getRowKey ? getRowKey(row, index) : String(row.id ?? `row-${index}`)}>
              {columns.map(column => (
                <td key={String(column.key)} data-align={column.align || 'left'}>{row[column.key]}</td>
              ))}
            </tr>
          )) : (
            <tr><td className="hostfy-table-empty" colSpan={Math.max(columns.length, 1)}>{emptyMessage}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export type StatusTone = 'positive' | 'warning' | 'danger' | 'info' | 'neutral'

export type StatusBadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTone
}

export function StatusBadge({ tone = 'neutral', className, ...props }: StatusBadgeProps) {
  return <span className={['hostfy-status-badge', `hostfy-status-${tone}`, className].filter(Boolean).join(' ')} {...props} />
}

export type EmptyStateProps = {
  title: React.ReactNode
  description?: React.ReactNode
  icon?: LucideIcon
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ title, description, icon: Icon, action, className }: EmptyStateProps) {
  return (
    <div className={['hostfy-empty-state', className].filter(Boolean).join(' ')}>
      {Icon ? <Icon className="hostfy-empty-icon" size={24} aria-hidden="true" /> : null}
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="hostfy-empty-action">{action}</div> : null}
    </div>
  )
}
