window.__dshRpc = async (method, request) => {
  const body = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }
  const response = await fetch(`/api/${method}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await response.json()
  if (!json.result?.ok) throw new Error(`${method}: ${JSON.stringify(json).slice(0, 400)}`)
  return json.result.value
}
