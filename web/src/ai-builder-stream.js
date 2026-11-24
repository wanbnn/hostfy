export async function streamGeneration(body, signal, onEvent) {
  const response = await fetch('/api/ai/generate', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', Accept: 'text/event-stream'},
    body: JSON.stringify({...body, stream: true}),
    signal,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || 'Não foi possível iniciar a geração.')
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error('O servidor não iniciou a transmissão da geração.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const {value, done} = await reader.read()
      buffer += decoder.decode(value, {stream: !done})
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop()
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/)
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        if (!event) continue
        const data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'))
        if (event === 'error') throw new Error(data.error)
        if (event === 'complete') return data
        onEvent(event, data)
      }
      if (done) throw new Error('A conexão terminou antes de concluir a geração.')
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
