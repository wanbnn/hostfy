import React from 'react'
import {Label, Text} from '@primer/react'

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

export function fmtCpu(value) {
  const n = Number(value) || 0
  return `${n.toFixed(n >= 10 ? 0 : 2)}%`
}

export function fmtDate(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString('pt-BR')
  } catch {
    return String(value)
  }
}

export function fmtRelative(value) {
  if (!value) return '—'
  const diff = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diff)) return fmtDate(value)
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins} min atrás`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h atrás`
  const days = Math.round(hours / 24)
  return `${days} d atrás`
}

const TYPE_LABELS = {
  static: {text: 'Estático', variant: 'secondary'},
  php: {text: 'PHP', variant: 'accent'},
  node: {text: 'Node.js', variant: 'success'},
  docker: {text: 'Docker', variant: 'primary'},
}

const STATUS_LABELS = {
  running: {text: 'Em execução', variant: 'success'},
  deploying: {text: 'Publicando', variant: 'attention'},
  restarting: {text: 'Reiniciando', variant: 'attention'},
  stopped: {text: 'Parado', variant: 'secondary'},
  error: {text: 'Erro', variant: 'danger'},
}

export function TypeLabel({type}) {
  const info = TYPE_LABELS[type] || TYPE_LABELS.static
  return <Label variant={info.variant}>{info.text}</Label>
}

export function StatusLabel({status}) {
  const info = STATUS_LABELS[status] || {text: status || '—', variant: 'secondary'}
  return <Label variant={info.variant}>{info.text}</Label>
}

export function MetricCard({label, value, hint, icon: Icon}) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{Icon ? <Icon size={16} /> : null}</div>
      <div>
        <Text className="metric-label">{label}</Text>
        <div className="metric-value">{value}</div>
        {hint ? <Text className="metric-hint">{hint}</Text> : null}
      </div>
    </div>
  )
}

export function Empty({icon: Icon, title, children}) {
  return (
    <div className="empty">
      {Icon ? <Icon size={24} /> : null}
      <Text as="strong">{title}</Text>
      {children ? <Text className="muted">{children}</Text> : null}
    </div>
  )
}

export function UsageBar({value, unit = '%'}) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div className="usage">
      <div className="usage-track">
        <div className="usage-fill" style={{width: `${pct}%`}} />
      </div>
      <span className="usage-text">
        {unit === '%' ? `${pct.toFixed(pct >= 10 ? 0 : 1)}%` : value}
      </span>
    </div>
  )
}