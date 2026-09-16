// Minimal Chrome DevTools Protocol client for the microphone E2E scenarios (Node >= 22 global WebSocket).
import { writeFileSync } from 'node:fs'

/**
 * Attach to the first page target whose URL starts with a prefix (or any page).
 * @param {number} port - remote debugging port.
 * @param {(url: string) => boolean} match - page URL predicate.
 */
export async function attach(port, match = () => true) {
  let targets = []
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (targets.some(t => t.type === 'page' && match(t.url))) break
    } catch { /* browser still starting */ }
    await sleep(200)
  }
  const page = targets.find(t => t.type === 'page' && match(t.url))
  if (page === undefined) throw new Error(`no matching page on ${port}: ${targets.map(t => t.url).join(', ')}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const listeners = new Set()
  const consoleLines = []
  ws.onmessage = (message) => {
    const msg = JSON.parse(message.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
      else resolve(msg.result)
    } else if (msg.method) {
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLines.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`)
      }
      for (const listener of listeners) listener(msg)
    }
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value
  }
  return {
    send,
    evaluate,
    consoleLines,
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    async waitFor(expression, { timeoutMs = 15000, intervalMs = 100, label = expression } = {}) {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        try {
          last = await evaluate(expression)
          if (last) return last
        } catch (error) { last = String(error) }
        await sleep(intervalMs)
      }
      throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`)
    },
    async clickSelector(selector) {
      const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!el.disabled } })()`)
      if (box === null) throw new Error(`no element ${selector}`)
      if (box.disabled) throw new Error(`element ${selector} is disabled`)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
      }
    },
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(data, 'base64'))
    },
    close: () => ws.close(),
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
