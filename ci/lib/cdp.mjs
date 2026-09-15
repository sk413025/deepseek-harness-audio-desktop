// Minimal Chrome DevTools Protocol client (Node >= 22 global fetch/WebSocket) for a packaged Electron app started with
// --remote-debugging-port. Used by the launch smoke test, which must not depend on a test framework.
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

export async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return undefined }
}

export async function attachPage(port, match) {
  const list = (await targets(port)) ?? []
  const page = list.find(t => t.type === 'page' && match(t.url))
  if (page === undefined) throw new Error(`no page target matching on port ${port}: ${list.map(t => t.url).join(', ')}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (message) => {
    const msg = JSON.parse(message.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
      else resolve(msg.result)
    } else if (msg.method === 'Runtime.exceptionThrown' || (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))) {
      if (events.length < 200) events.push({ method: msg.method, type: msg.params.type, text: (msg.params.exceptionDetails?.exception?.description ?? msg.params.args?.map(a => a.value ?? a.description ?? '').join(' ') ?? '').slice(0, 500) })
    }
  }
  ws.onclose = () => { for (const { reject } of pending.values()) reject(new Error('CDP socket closed')); pending.clear() }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP socket error')) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value
  }
  return {
    url: page.url,
    send,
    evaluate,
    events,
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(data, 'base64'))
    },
    close: () => { try { ws.close() } catch { /* already closed */ } },
  }
}

/** Poll an async predicate until it returns a truthy value; returns { value, ms } or throws with the last observation. */
export async function waitUntil(label, predicate, { timeoutMs, intervalMs = 1000 }) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    try {
      last = await predicate()
      if (last) return { value: last, ms: Date.now() - start }
    } catch (error) { last = String(error?.message ?? error) }
    await sleep(intervalMs)
  }
  const error = new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
  error.last = last
  throw error
}
