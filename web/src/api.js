export async function api(url, options = {}) {
  const response = await fetch(url, {credentials: 'same-origin', ...options})
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(data.error || 'Ocorreu um erro.'), {code: data.code, status: response.status})
  }
  return data
}
