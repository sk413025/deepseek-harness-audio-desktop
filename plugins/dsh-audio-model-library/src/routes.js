// Host Fetch routes (CONTRACT §3), mounted through `ctx.connection.fetch.register`.
// Connection authenticates every request before these run. Exact paths only.

import { ROUTE_PREFIX } from './constants.js'
import { LibraryError } from './binding.js'

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

async function readJson(request) {
  const text = await request.text()
  if (text.length > 16 * 1024) throw new LibraryError('BAD_REQUEST', 'request body too large', 413)
  if (text.trim() === '') return {}
  let body
  try { body = JSON.parse(text) } catch { throw new LibraryError('BAD_REQUEST', 'request body is not JSON', 400) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('BAD_REQUEST', 'request body must be an object', 400)
  return body
}

function guard(handler, log) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof LibraryError) return json(error.status ?? 409, { ok: false, error: { code: error.code, message: error.message, ...error.extra } })
      log?.(`dsh-audio-model-library: route error ${error?.stack ?? error}`)
      return json(500, { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } })
    }
  }
}

/** @param {{ library: import('./library.js').Library, log?: (m: string) => void }} deps */
export function createRouteHandlers({ library, log }) {
  const post = (path, action) => ({
    path: `${ROUTE_PREFIX}/${path}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guard(async request => json(200, await action(await readJson(request))), log),
  })
  const events = (request) => {
    const url = new URL(request.url)
    const afterRaw = url.searchParams.get('after')
    const after = afterRaw === null ? undefined : Number(afterRaw)
    if (after !== undefined && !(Number.isInteger(after) && after >= 0)) throw new LibraryError('BAD_REQUEST', 'after must be a non-negative integer', 400)
    const controller = new AbortController()
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const iterator = library.subscribe({ after, signal: controller.signal })[Symbol.asyncIterator]()
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      async pull(stream) {
        const { value, done } = await iterator.next()
        if (done) { stream.close(); return }
        stream.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
      },
      async cancel() {
        controller.abort()
        await iterator.return?.()
      },
    }, { highWaterMark: 1 })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }
  return [
    { path: `${ROUTE_PREFIX}/library`, methods: ['GET'], requestBody: 'buffered', fetch: guard(async () => { await library.loaded; return json(200, { ok: true, ...library.document() }) }, log) },
    { path: `${ROUTE_PREFIX}/events`, methods: ['GET'], requestBody: 'buffered', fetch: guard(async request => events(request), log) },
    post('refresh', async body => ({ ok: true, ...(await library.refresh(typeof body.serverId === 'string' ? body.serverId : undefined)) })),
    post('activate', body => library.activate(body)),
    post('bind', body => library.bind(body)),
    post('cancel', body => library.cancel(body)),
    post('deactivate', body => library.deactivate(body)),
  ]
}
