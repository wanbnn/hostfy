import {useEffect, useState} from 'react'
import {api} from './api.js'

// Busca CPU/memória dos projetos dinâmicos (PHP/Node/Docker) em paralelo.
export function useStats(projects) {
  const [stats, setStats] = useState({})
  const dynamic = projects.filter(p => p.type !== 'static')
  const key = dynamic.map(p => p.id).join(',')

  useEffect(() => {
    if (!key) {
      setStats({})
      return undefined
    }
    let cancelled = false
    Promise.all(
      dynamic.map(p =>
        api(`/api/projects/${p.id}/stats`)
          .then(s => [p.id, s])
          .catch(() => [p.id, {cpuPercent: 0, memBytes: 0, containers: 0, status: 'unknown'}])
      )
    ).then(pairs => {
      if (!cancelled) setStats(Object.fromEntries(pairs))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return stats
}