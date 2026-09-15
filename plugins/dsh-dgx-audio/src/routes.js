// Host Fetch routes for the shared audio UI (CONTRACT.md §2–§5), mounted through
// `ctx.connection.fetch.register`. Connection authenticates every request before these run.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { CONTRACT_VERSION, PLUGIN_NAME, PLUGIN_VERSION, ROUTE_PREFIX } from './constants.js'
import { readSse } from './sse.js'
import { chatStreamEvents } from './openai-stream.js'
import { RealtimeDuplexClient, realtimeUrl } from './realtime.js'
import { resolveRecordingId } from './recording.js'
import { LiveError } from './live.js'
import { attributionHeaders } from './compat.js'
import { routeApiKey } from './config.js'
import { validateTaskParams } from './tasks.js'
import { optionControlsOf } from './option-controls.js'
import { ADAPTER_MODES, REALTIME_WIRES, catalogTasksOf, catalogTasksSourceOf, ioOf, paramsListOf, taskOf, uiTaskOf } from './task-map.js'

const FILE_FORMATS = ['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'webm']
const INPUT_FORMATS = {
  chat: FILE_FORMATS,
  transcribe: FILE_FORMATS,
  translate: FILE_FORMATS,
  speech: FILE_FORMATS, // optional reference clip
  'generate-audio': [],
  align: FILE_FORMATS,
  'generate-video': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', ...FILE_FORMATS],
  realtime: ['pcm_s16le'],
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function failure(status, code, message, details, key) {
  return json(status, { ok: false, error: { code, message, ...(key === undefined ? {} : { key }), ...(details === undefined ? {} : { details }) } })
}

/**
 * GET voices `voices` is always `string[]` (mic HANDOFF_NEXT §3): strings pass, objects contribute `name` (else `voice`/`id`),
 * anything else is dropped; duplicates removed, order kept. Each name is a valid `voice` param (string ≤ 4000).
 */
export function normalizeVoiceNames(list) {
  if (!Array.isArray(list)) return []
  const names = []
  for (const item of list) {
    const name = typeof item === 'string' ? item : [item?.name, item?.voice, item?.id].find(v => typeof v === 'string')
    if (typeof name === 'string' && name.length > 0 && name.length <= 4000 && !names.includes(name)) names.push(name)
  }
  return names
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const text = await request.text()
  if (text.length > maxBytes) throw new LiveError('PAYLOAD_TOO_LARGE', 'request body too large', 413)
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw new LiveError('BAD_REQUEST', 'request body is not JSON', 400) }
}

function guard(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof LiveError) return failure(error.status ?? 400, error.code, error.message, error.details, error.key)
      return failure(500, error?.code ?? 'INTERNAL', String(error?.message ?? error))
    }
  }
}

/**
 * @param {object} deps
 * @param {() => any} deps.config
 * @param {import('./audio-hub.js').AudioHub} deps.hub
 * @param {import('./capabilities.js').CapabilityRegistry} deps.capabilities
 * @param {import('./live.js').LiveSessionManager} deps.live
 * @param {(m: string) => void} deps.log
 * @param {typeof fetch} [deps.fetch]
 * @param {typeof WebSocket} [deps.WebSocket]
 * @returns {{ path: string, methods: string[], requestBody: 'buffered' | 'streaming', fetch: (request: Request) => Promise<Response> }[]}
 */
export function createRouteHandlers(deps) {
  const doFetch = deps.fetch ?? globalThis.fetch

  function modelDocument(route, model) {
    const config = deps.config()
    return {
      id: model.id,
      name: model.name ?? model.id,
      mode: model.mode,
      upstreamModel: model.upstreamModel ?? model.id,
      input: {
        formats: model.inputFormats ?? INPUT_FORMATS[model.mode],
        recommended: model.mode === 'realtime'
          ? (model.realtime.wire === 'omni-speech-ws' ? { encoding: 'text', container: 'live/text' } : { encoding: 'pcm_s16le', sampleRate: model.realtime.inputSampleRate, channels: 1, container: 'raw', frameMs: model.realtime.frameMs, wireEncoding: model.realtime.inputEncoding })
          : { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, container: 'wav' },
      },
      task: taskOf(model),
      tasks: model.tasks ?? [taskOf(model)],
      uiTask: uiTaskOf(model),
      catalogTasks: catalogTasksOf(model),
      catalogTasksSource: catalogTasksSourceOf(model),
      ...(model.catalogId ? { catalogId: model.catalogId } : {}),
      ...(model.deploymentId ? { deploymentId: model.deploymentId } : {}),
      // Catalog request_options, verbatim and uninterpreted (mic HANDOFF_NEXT §4): the UI decides which controls to show.
      ...(Array.isArray(model.requestOptions) ? { requestOptions: model.requestOptions } : {}),
      // 0.4.6 (§K.11): the catalog's per-variant statuses verbatim, and the host-derived controls a UI may offer.
      ...(Array.isArray(model.requestOptionsMap) ? { requestOptionsMap: model.requestOptionsMap } : {}),
      ...(typeof model.requestOptionsScope === 'string' ? { requestOptionsScope: model.requestOptionsScope } : {}),
      ...(model.requestOptionsEvidence !== undefined ? { requestOptionsEvidence: model.requestOptionsEvidence } : {}),
      optionControls: optionControlsOf(model),
      io: ioOf(model),
      wire: model.mode === 'realtime' ? model.realtime.wire : { chat: model.outputAudio ? 'omni-chat-s2s' : 'openai-chat-audio', transcribe: 'openai-transcriptions', translate: 'openai-translations', speech: 'omni-speech-http', 'generate-audio': 'omni-audio-generate', align: 'vllm-pooling-forced-align', 'generate-video': 'omni-videos' }[model.mode],
      activation: deps.activation?.(route.provider, model.id) ?? { state: 'ready' },
      availability: { state: deps.activation?.(route.provider, model.id)?.state ?? 'ready' },
      params: paramsListOf(model, route.provider),
      output: {
        text: !(model.mode === 'speech' || model.mode === 'generate-audio' || (model.mode === 'realtime' && model.realtime.wire === 'omni-speech-ws')),
        audio: (model.mode === 'realtime' && model.realtime.wire !== 'vllm-asr') || model.outputAudio === true || model.mode === 'speech' || model.mode === 'generate-audio',
      },
      capabilities: deps.capabilities.describe(route, model),
      limits: {
        maxAudioBytes: config.maxAudioBytes,
        maxAudioPerRequest: model.maxAudioPerRequest,
        liveFrameMaxBytes: config.live.maxFrameBytes,
        liveMaxSeconds: config.live.maxSeconds,
      },
    }
  }

  function capabilitiesDocument() {
    const config = deps.config()
    return {
      contractVersion: CONTRACT_VERSION,
      taskContractVersion: '0.2',
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      adapterModes: ADAPTER_MODES,
      realtimeWires: REALTIME_WIRES,
      configured: config.routes.length > 0,
      // 0.4.7 (§K.12): a test-only fault configuration is always visible, so no run silently counts as product defaults.
      ...(config.testFaults === undefined ? {} : { testFaults: config.testFaults }),
      routes: config.routes.map(route => ({
        provider: route.provider,
        displayName: route.displayName,
        baseURL: route.baseURL,
        authentication: route.apiKey || route.apiKeyEnv ? 'bearer' : 'none',
        credentialPresent: routeApiKey(route) !== undefined,
        models: route.models.map(model => modelDocument(route, model)),
      })),
    }
  }

  function findModel(provider, modelId) {
    const route = deps.config().routes.find(r => r.provider === provider)
    const model = route?.models.find(m => m.id === modelId)
    if (route === undefined || model === undefined) throw new LiveError('UNKNOWN_ROUTE', `no configured model ${provider}/${modelId}`, 404)
    return { route, model }
  }

  async function probe(body, signal) {
    const { route, model } = findModel(body.provider, body.model)
    const checks = Array.isArray(body.checks) && body.checks.length > 0 ? body.checks : ['reachability']
    const results = {}
    const base = route.baseURL.replace(/\/+$/, '')
    const key = routeApiKey(route)
    const auth = key ? { authorization: `Bearer ${key}` } : {}
    for (const check of checks) {
      const started = Date.now()
      try {
        if (check === 'reachability') {
          const response = await doFetch(`${base}/models`, { headers: { ...attributionHeaders(), ...auth }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
          const listed = response.ok ? ((await response.json().catch(() => ({}))).data ?? []).map(m => m.id) : []
          results.reachability = { ok: response.ok, status: response.status, listedModels: listed, modelListed: listed.includes(model.upstreamModel ?? model.id), ms: Date.now() - started }
        } else if (check === 'text-stream') {
          if (model.mode !== 'chat') throw new LiveError('UNSUPPORTED_CAPABILITY', 'text-stream probe applies to chat models', 409)
          const response = await doFetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { ...attributionHeaders(), ...auth, 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({ model: model.upstreamModel ?? model.id, stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'Count from 1 to 10, separated by spaces.' }], ...(model.sendModalities ? { modalities: ['text'] } : {}), ...(model.extraBody ?? {}) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          })
          const type = String(response.headers.get('content-type') ?? '')
          if (!response.ok || !type.includes('text/event-stream')) {
            const detail = `HTTP ${response.status} ${type}`
            await response.body?.cancel().catch(() => {})
            if (response.ok) deps.capabilities.observe(route, model, 'textStreaming', { state: 'unsupported', source: 'probe', detail })
            results['text-stream'] = { ok: false, detail, ms: Date.now() - started }
          } else {
            let deltas = 0
            let firstDeltaMs = null
            for await (const event of chatStreamEvents(readSse(response.body, { signal }))) {
              if (event.type === 'text') { deltas += 1; firstDeltaMs ??= Date.now() - started }
            }
            if (deltas >= 2) deps.capabilities.observe(route, model, 'textStreaming', { state: 'verified', source: 'probe', detail: `${deltas} SSE text deltas` })
            results['text-stream'] = { ok: deltas >= 2, deltas, firstDeltaMs, ms: Date.now() - started }
          }
        } else if (check === 'realtime-session') {
          if (model.mode !== 'realtime') throw new LiveError('UNSUPPORTED_CAPABILITY', 'realtime-session probe applies to realtime models', 409)
          const client = new RealtimeDuplexClient({
            url: realtimeUrl(route.baseURL, model.realtime, { model: model.upstreamModel ?? model.id, sessionId: `${model.realtime.sessionIdPrefix}probe-${Date.now().toString(36)}` }),
            session: { model: model.upstreamModel ?? model.id, ...model.realtime.session },
            apiKey: routeApiKey(route),
            WebSocket: deps.WebSocket,
            connectTimeoutMs: model.realtime.connectTimeoutMs,
          })
          try {
            const server = await client.connect(signal)
            const caps = server.capabilities ?? {}
            // Handshake evidence is `advertised` only (CONTRACT.md §2).
            if (typeof caps.implementation_level === 'string') {
              deps.capabilities.observe(route, model, 'fullDuplex', caps.implementation_level === 'model_native_duplex'
                ? { state: 'advertised', source: 'server-session', implementationLevel: caps.implementation_level }
                : { state: 'unsupported', source: 'server-session', implementationLevel: caps.implementation_level })
            }
            results['realtime-session'] = { ok: true, serverSessionId: server.sessionId ?? null, implementationLevel: caps.implementation_level ?? null, advertised: caps, ms: Date.now() - started }
          } finally {
            await client.close()
          }
        } else {
          throw new LiveError('BAD_REQUEST', `unknown probe check ${JSON.stringify(check)}`, 400)
        }
      } catch (error) {
        if (error instanceof LiveError) throw error
        results[check] = { ok: false, error: { code: error?.code ?? 'BACKEND_UNREACHABLE', message: String(error?.message ?? error) }, ms: Date.now() - started }
      }
    }
    return { ok: true, provider: route.provider, model: modelDocument(route, model), probe: results }
  }

  function events(request) {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return failure(400, 'BAD_REQUEST', 'sessionId is required')
    const afterRaw = url.searchParams.get('after')
    const after = afterRaw === null ? undefined : Number(afterRaw)
    if (after !== undefined && !(Number.isInteger(after) && after >= 0)) return failure(400, 'BAD_REQUEST', 'after must be a non-negative integer cursor')
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = deps.hub.subscribe(sessionId, { after, signal: controller.signal })[Symbol.asyncIterator]()
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      async pull(stream) {
        const { value, done } = await iterator.next()
        if (done) { stream.close(); return }
        stream.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
      },
      async cancel() {
        controller.abort()
        request.signal?.removeEventListener('abort', onAbort)
        await iterator.return?.()
      },
    }, { highWaterMark: 1 })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }

  async function recording(request) {
    const url = new URL(request.url)
    const path = resolveRecordingId(deps.config().outputDir, url.searchParams.get('id'))
    if (path === undefined) return failure(400, 'BAD_REQUEST', 'invalid recording id')
    let size
    try { size = (await stat(path)).size } catch { return failure(404, 'NOT_FOUND', 'recording not found') }
    const headers = { 'content-type': path.endsWith('.mp4') ? 'video/mp4' : 'audio/wav', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' }
    const range = parseRange(request.headers.get('range'), size)
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
    const [start, end] = range ?? [0, size - 1]
    const length = size === 0 ? 0 : end - start + 1
    const responseHeaders = { ...headers, 'content-length': String(length), ...(range === undefined ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }) }
    if (request.method === 'HEAD' || length === 0) return new Response(null, { status: range === undefined ? 200 : 206, headers: responseHeaders })
    const stream = Readable.toWeb(createReadStream(path, { start, end }))
    return new Response(stream, { status: range === undefined ? 200 : 206, headers: responseHeaders })
  }

  async function liveOpen(request) {
    const body = await readJsonBody(request)
    if (body.task !== undefined) {
      const { model } = findModel(body.provider, body.model)
      if (model.mode !== 'realtime' || taskOf(model) !== body.task) throw new LiveError('UNSUPPORTED_CAPABILITY', `${body.provider}/${body.model} does not provide task ${body.task}`, 409)
    }
    if (body.params !== undefined) {
      const { model } = findModel(body.provider, body.model)
      try { body.params = validateTaskParams(model, body.params) } catch (error) { throw Object.assign(new LiveError(error.reason ?? 'BAD_REQUEST', error.message, 400), { key: error.key }) }
    }
    const session = await deps.live.open(body, request.signal)
    const config = deps.config()
    return json(200, {
      ok: true,
      liveId: session.liveId,
      task: taskOf(session.model),
      wire: session.wire,
      input: session.wire === 'omni-speech-ws'
        ? { encoding: 'text', route: `${ROUTE_PREFIX}/live/text` }
        : { encoding: 'pcm_s16le', sampleRate: session.inputRate, channels: 1, frameMs: session.model.realtime.frameMs, maxFrameBytes: config.live.maxFrameBytes, wireEncoding: session.model.realtime.inputEncoding },
      capabilities: deps.capabilities.describe(session.route, session.model),
    })
  }

  async function liveAppend(request) {
    const url = new URL(request.url)
    const session = deps.live.get(url.searchParams.get('liveId'))
    const type = String(request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/octet-stream') return failure(415, 'BAD_REQUEST', 'content type must be application/octet-stream')
    const bytes = Buffer.from(await request.arrayBuffer())
    return json(200, await session.append(Number(url.searchParams.get('seq')), bytes))
  }

  async function liveControl(request) {
    const url = new URL(request.url)
    const session = deps.live.get(url.searchParams.get('liveId'))
    return json(200, await session.control(await readJsonBody(request)))
  }

  async function liveText(request) {
    const url = new URL(request.url)
    const session = deps.live.get(url.searchParams.get('liveId'))
    const body = await readJsonBody(request, 64 * 1024)
    if (body.params !== undefined) {
      // Per-turn session.config replacement (speech stream-input); validated against the wire schema.
      try { body.params = validateTaskParams(session.model, body.params) } catch (error) { throw Object.assign(new LiveError(error.reason ?? 'BAD_REQUEST', error.message, 400), { key: error.key }) }
    }
    return json(200, await session.text(body))
  }

  async function sessionParamsRoute(request) {
    const body = await readJsonBody(request)
    if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new LiveError('BAD_REQUEST', 'sessionId is required', 400)
    const { route, model } = findModel(body.provider, body.model)
    let params
    // 0.4.3: UNKNOWN_PARAM / INVALID_PARAM with error.key so the UI can mark the control (mic HANDOFF 02:29 item 3).
    try { params = validateTaskParams(model, body.params ?? {}) } catch (error) { throw Object.assign(new LiveError(error.reason ?? 'BAD_REQUEST', error.message, 400), { key: error.key }) }
    deps.sessionParams?.set(body.sessionId, route.provider, model.id, params)
    return json(200, { ok: true, provider: route.provider, model: model.id, params })
  }

  async function voices(request) {
    const url = new URL(request.url)
    const { route, model } = findModel(url.searchParams.get('provider'), url.searchParams.get('model'))
    if (model.mode !== 'speech' && !(model.mode === 'realtime' && model.realtime.wire === 'omni-speech-ws')) throw new LiveError('UNSUPPORTED_CAPABILITY', 'voices are listed for speech models only', 409)
    const key = routeApiKey(route)
    let response
    try {
      response = await doFetch(`${route.baseURL.replace(/\/+$/, '')}/audio/voices`, { headers: { ...attributionHeaders(), ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) })
    } catch (error) {
      return failure(502, 'BACKEND_UNREACHABLE', String(error?.message ?? error))
    }
    const text = await response.text()
    if (!response.ok) return failure(502, 'BACKEND_REJECTED', `HTTP ${response.status}: ${text.slice(0, 300)}`)
    let body
    try { body = JSON.parse(text) } catch { return failure(502, 'BACKEND_REJECTED', 'voices endpoint returned non-JSON') }
    return json(200, { ok: true, provider: route.provider, model: model.id, voices: normalizeVoiceNames(body.voices), uploadedVoices: Array.isArray(body.uploaded_voices) ? body.uploaded_voices.filter(v => typeof v?.name === 'string' && v.name !== '').map(v => ({ name: v.name, createdAt: Number.isFinite(v.created_at) ? v.created_at : null, refText: typeof v.ref_text === 'string' ? v.ref_text : null, speakerDescription: typeof v.speaker_description === 'string' ? v.speaker_description : null })) : [] })
  }

  /** GET/HEAD result?id= — the durable structured result behind a footer link line (same auth as recording). */
  async function resultRoute(request) {
    const id = new URL(request.url).searchParams.get('id')
    if (deps.results === undefined) return failure(404, 'RESULT_NOT_FOUND', 'results are not stored by this host')
    if (deps.results.pathOf(id) === undefined) return failure(400, 'BAD_REQUEST', 'invalid result id')
    const result = await deps.results.load(id)
    if (result === undefined) return failure(404, 'RESULT_NOT_FOUND', 'result not found (never stored here, or its output directory was cleared)')
    const body = JSON.stringify(result)
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=3600', 'content-length': String(Buffer.byteLength(body)) }
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
  }

  function activity(request) {
    const url = new URL(request.url)
    const provider = url.searchParams.get('provider') ?? undefined
    const live = [...deps.live.sessions.values()].filter(s => s.state !== 'closed' && (provider === undefined || s.route.provider === provider)).map(s => ({ liveId: s.liveId, provider: s.route.provider, model: s.model.id, sessionId: s.sessionId, state: s.reconnecting ? 'reconnecting' : s.state, task: taskOf(s.model) }))
    const inflight = (deps.work?.list(provider) ?? []).filter(i => i.kind !== 'auxiliary').map(i => ({ provider: i.provider, model: i.model, sessionId: i.sessionId, kind: i.kind, since: i.startedAt }))
    return json(200, { ok: true, live, inflight })
  }

  async function liveClose(request) {
    const url = new URL(request.url)
    const session = deps.live.get(url.searchParams.get('liveId'))
    return json(200, await session.close('client-close'))
  }

  const handlers = [
    { path: `${ROUTE_PREFIX}/capabilities`, methods: ['GET'], requestBody: 'buffered', fetch: guard(async () => json(200, capabilitiesDocument())) },
    { path: `${ROUTE_PREFIX}/capabilities/probe`, methods: ['POST'], requestBody: 'buffered', fetch: guard(async request => json(200, await probe(await readJsonBody(request), request.signal ?? new AbortController().signal))) },
    { path: `${ROUTE_PREFIX}/events`, methods: ['GET'], requestBody: 'buffered', fetch: guard(async request => events(request)) },
    { path: `${ROUTE_PREFIX}/recording`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: guard(recording) },
    { path: `${ROUTE_PREFIX}/live/open`, methods: ['POST'], requestBody: 'buffered', fetch: guard(liveOpen) },
    { path: `${ROUTE_PREFIX}/live/append`, methods: ['POST'], requestBody: 'buffered', fetch: guard(liveAppend) },
    { path: `${ROUTE_PREFIX}/live/control`, methods: ['POST'], requestBody: 'buffered', fetch: guard(liveControl) },
    { path: `${ROUTE_PREFIX}/live/close`, methods: ['POST'], requestBody: 'buffered', fetch: guard(liveClose) },
    { path: `${ROUTE_PREFIX}/live/text`, methods: ['POST'], requestBody: 'buffered', fetch: guard(liveText) },
    { path: `${ROUTE_PREFIX}/session-params`, methods: ['POST'], requestBody: 'buffered', fetch: guard(sessionParamsRoute) },
    { path: `${ROUTE_PREFIX}/voices`, methods: ['GET'], requestBody: 'buffered', fetch: guard(voices) },
    { path: `${ROUTE_PREFIX}/activity`, methods: ['GET'], requestBody: 'buffered', fetch: guard(async request => activity(request)) },
    { path: `${ROUTE_PREFIX}/result`, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: guard(resultRoute) },
  ]
  Object.defineProperty(handlers, 'describe', { value: capabilitiesDocument, enumerable: false })
  return handlers
}

/**
 * @param {string | null} header
 * @param {number} size
 * @returns {[number, number] | undefined | 'invalid'}
 */
export function parseRange(header, size) {
  if (header === null || header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null || (match[1] === '' && match[2] === '')) return 'invalid'
  let start
  let end
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return [start, end]
}
