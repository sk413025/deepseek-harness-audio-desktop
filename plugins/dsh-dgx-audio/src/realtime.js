// Backend WebSocket driver for vLLM-Omni `/v1/realtime?duplex=1` sessions.
//
// Wire facts (DGX SERVER_CONTRACT.md 2026-09-15, vLLM-Omni 0.28.0 source eb11446b):
// - Connect with `autostart=0`, then send `session.update` (MiniCPM-o 4.5 requires `ref_audio`).
// - `session.created` carries the server-issued `session.id`, `incarnation`, `resume_token`
//   and `session.capabilities` (advertised flags only).
// - Input: `input_audio_buffer.append` base64 pcm16 16 kHz mono.
// - Output: `response.audio.delta` (0.28) or `response.output_audio.delta` (nightly) with
//   `format` + `sample_rate_hz` + `metadata.epoch`.
// - Every server event carries `server_event_seq`; resume replays after
//   `last_received_server_event_seq`, and must use the server-issued session id.

import { EventEmitter } from 'node:events'
import { LlmError } from './compat.js'
import { s16ToF32 } from './pcm.js'

/** Nightly OpenAI GA spellings → 0.28 names. */
const EVENT_ALIASES = new Map([
  ['response.output_audio.delta', 'response.audio.delta'],
  ['response.output_audio.done', 'response.audio.done'],
  ['response.output_audio_transcript.delta', 'response.audio_transcript.delta'],
  ['response.output_audio_transcript.done', 'response.audio_transcript.done'],
])

const CONTROL_EVENTS = new Set(['session.resumed', 'session.resync_required', 'session.replaced'])

/** Backend resume failures worth one more attempt inside the server's disconnect grace. */
export const RETRYABLE_RESUME_CODES = new Set(['session_resume_conflict', 'runtime_resume_failed', 'transport'])

export function canonicalEventType(type) {
  return EVENT_ALIASES.get(type) ?? type
}

/**
 * Build the realtime WebSocket URL from an http(s) route base URL.
 * @param {string} baseURL - e.g. http://host:18120/v1
 * @param {any} realtime - resolved model.realtime config
 * @param {{ model: string, sessionId?: string }} params
 */
export function realtimeUrl(baseURL, realtime, params) {
  const url = new URL(baseURL.replace(/\/+$/, '') + realtime.path)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(realtime.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  url.searchParams.set('model', params.model)
  if (params.sessionId) url.searchParams.set('session_id', params.sessionId)
  return url.toString()
}

export class RealtimeDuplexClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url
   * @param {Record<string, unknown>} options.session - session.update body (`session` object)
   * @param {string} [options.apiKey]
   * @param {typeof WebSocket} [options.WebSocket]
   * @param {number} [options.connectTimeoutMs]
   * @param {() => number} [options.now]
   */
  constructor(options) {
    super()
    this.options = options
    this.WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
    this.now = options.now ?? Date.now
    this.socket = undefined
    this.state = 'idle' // idle → connecting → ready → closing → closed
    this.server = { sessionId: undefined, incarnation: undefined, resumeToken: undefined, capabilities: undefined, session: undefined }
    this.lastSeq = -1
    this.duplicateEvents = 0
    this.recent = [] // events received while connecting (handshake race)
    this.sentEvents = 0
    this.receivedEvents = 0
  }

  /** @returns {number} bytes queued in the socket but not yet sent */
  get bufferedAmount() {
    return this.socket?.bufferedAmount ?? 0
  }

  /**
   * Open the socket, send `session.update`, resolve on `session.created`/`session.updated`.
   * @param {AbortSignal} [signal]
   */
  async connect(signal) {
    if (this.WebSocketImpl === undefined) throw new LlmError('WebSocket is not available in this runtime', 'TRANSPORT')
    this.state = 'connecting'
    this.recent = []
    const wire = this.options.wire ?? 'omni-duplex'
    await this.openSocket(this.options.url, signal)
    if (wire === 'omni-speech-ws') {
      // vLLM-Omni /v1/audio/speech/stream: the first message is session.config; there is no created event.
      this.send({ type: 'session.config', ...this.options.session })
      this.state = 'ready'
      return this.server
    }
    if (wire === 'vllm-asr' || wire === 'omni-turn') {
      // vLLM realtime: the server sends session.created on accept; the client names the model with a flat
      // session.update {model}; generation starts on commit(final=false) (speech_to_text/realtime @2cf0a691).
      const created = await this.waitFor(event => event.type === 'session.created', 'session.created', signal)
      this.server.sessionId = created.id ?? created.session?.id
      this.send({ type: 'session.update', model: this.options.model })
      this.state = 'ready'
      return this.server
    }
    const created = this.waitFor(event => event.type === 'session.created' || event.type === 'session.updated', 'session.created', signal)
    this.send({ type: 'session.update', session: this.options.session })
    const event = await created
    this.captureSession(event)
    this.state = 'ready'
    return this.server
  }

  /**
   * Re-attach after a dropped socket using the server-issued session id and resume token.
   * @param {AbortSignal} [signal]
   * @param {{ resumeToken?: string }} [override]
   */
  async resume(signal, override) {
    const { sessionId, incarnation } = this.server
    // `override.resumeToken` exists only for the test-only invalid-token fault (§K.12); normal resumes use the server token.
    const resumeToken = override?.resumeToken ?? this.server.resumeToken
    if (!sessionId || !resumeToken || !Number.isInteger(incarnation)) {
      throw Object.assign(new LlmError('realtime session has no server-issued id, incarnation or resume token', 'RESUME_UNAVAILABLE'), { backendCode: null })
    }
    this.state = 'connecting'
    this.recent = []
    const url = new URL(this.options.url)
    // Owner contract (nightly 58adeec): resume on a new socket with resume=1 and the SERVER session id.
    url.searchParams.set('resume', '1')
    url.searchParams.set('session_id', sessionId)
    const socket = await this.openSocket(url.toString(), signal)
    const resumed = this.waitFor(event => event.type === 'session.resumed' || event.type === 'session.resync_required' || event.type === 'error', 'session.resumed', signal)
    this.send({ type: 'session.resume', session_id: sessionId, incarnation, resume_token: resumeToken, last_received_server_event_seq: Math.max(0, this.lastSeq) })
    const event = await resumed
    if (event.type !== 'session.resumed') {
      this.state = 'closed'
      try { socket.close(1000, 'resume rejected') } catch {}
      const backendCode = event.type === 'session.resync_required' ? 'session.resync_required' : String(event.code ?? event.error?.code ?? 'error')
      throw Object.assign(new LlmError(`realtime resume rejected: ${backendCode}: ${errorText(event)}`, 'RESUME_REJECTED'), { backendCode })
    }
    if (typeof event.resume_token === 'string') this.server.resumeToken = event.resume_token
    if (Number.isInteger(event.incarnation)) this.server.incarnation = event.incarnation
    this.resumes = (this.resumes ?? 0) + 1
    this.state = 'ready'
    return event
  }

  openSocket(url, signal) {
    return new Promise((resolve, reject) => {
      const headers = this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : undefined
      let socket
      try {
        socket = headers === undefined ? new this.WebSocketImpl(url) : new this.WebSocketImpl(url, { headers })
      } catch (error) {
        reject(new LlmError(`cannot open realtime socket: ${error?.message ?? error}`, 'TRANSPORT', { cause: error }))
        return
      }
      // Listen before `open` so an immediate server event (vLLM realtime session.created) is not missed.
      socket.binaryType = 'arraybuffer'
      this.attach(socket)
      const timer = setTimeout(() => { cleanup(); try { socket.close() } catch {} reject(new LlmError(`realtime connect timed out after ${this.options.connectTimeoutMs ?? 15000} ms`, 'TRANSPORT')) }, this.options.connectTimeoutMs ?? 15000)
      const onOpen = () => { cleanup(); resolve(socket) }
      const onError = (event) => { cleanup(); reject(new LlmError(`realtime socket error: ${event?.message ?? 'connection failed'}`, 'TRANSPORT')) }
      const onAbort = () => { cleanup(); try { socket.close() } catch {} reject(new LlmError('realtime connect aborted', 'ABORTED')) }
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  attach(socket) {
    this.socket = socket
    socket.addEventListener('message', (message) => this.onMessage(message))
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      const expected = this.state === 'closing' || this.state === 'closed'
      this.state = 'closed'
      this.emit('socket-closed', { code: event?.code, reason: String(event?.reason ?? ''), expected })
    })
  }

  onMessage(message) {
    if (typeof message.data !== 'string') {
      // Binary frames carry raw PCM on the speech stream-input wire.
      this.receivedEvents += 1
      this.emit('binary', Buffer.from(message.data))
      return
    }
    let event
    try {
      event = JSON.parse(message.data)
    } catch {
      this.emit('protocol-error', { message: 'non-JSON realtime frame' })
      return
    }
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
      this.emit('protocol-error', { message: 'realtime frame without type' })
      return
    }
    const seq = event.server_event_seq
    // Session control events are never journal replays; only sequenced events are de-duplicated.
    if (Number.isInteger(seq) && !CONTROL_EVENTS.has(event.type)) {
      if (seq <= this.lastSeq) { this.duplicateEvents += 1; return } // replayed after resume
      this.lastSeq = seq
    }
    this.receivedEvents += 1
    event.type = canonicalEventType(event.type)
    if (this.state === 'connecting') { this.recent.push(event); if (this.recent.length > 16) this.recent.shift() }
    this.emit('event', event)
  }

  waitFor(predicate, label, signal) {
    const seen = this.recent.find(predicate)
    if (seen !== undefined) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new LlmError(`realtime ${label} not received within ${this.options.connectTimeoutMs ?? 15000} ms`, 'TRANSPORT')) }, this.options.connectTimeoutMs ?? 15000)
      const onEvent = (event) => {
        if (event.type === 'error' && label === 'session.created') {
          cleanup()
          const backendCode = typeof event.code === 'string' ? event.code : (typeof event.error?.code === 'string' ? event.error.code : undefined)
          reject(Object.assign(new LlmError(`realtime session rejected: ${errorText(event)}`, 'BACKEND_REJECTED'), { backendCode }))
          return
        }
        if (predicate(event)) { cleanup(); resolve(event) }
      }
      const onClosed = () => { cleanup(); reject(new LlmError(`realtime socket closed before ${label}`, 'TRANSPORT')) }
      const onAbort = () => { cleanup(); reject(new LlmError(`realtime ${label} aborted`, 'ABORTED')) }
      const cleanup = () => {
        clearTimeout(timer)
        this.off('event', onEvent)
        this.off('socket-closed', onClosed)
        signal?.removeEventListener('abort', onAbort)
      }
      this.on('event', onEvent)
      this.on('socket-closed', onClosed)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  captureSession(event) {
    const session = event.session ?? {}
    this.server.session = session
    this.server.sessionId = session.id ?? event.session_id ?? this.server.sessionId
    this.server.incarnation = Number.isInteger(event.incarnation) ? event.incarnation : this.server.incarnation
    this.server.resumeToken = event.resume_token ?? this.server.resumeToken
    this.server.capabilities = session.capabilities ?? event.capabilities ?? this.server.capabilities
  }

  send(payload) {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) throw new LlmError('realtime socket is not open', 'LIVE_CLOSED')
    socket.send(JSON.stringify(payload))
    this.sentEvents += 1
  }

  /**
   * @param {Buffer} pcm - pcm16 mono at the session input rate
   * @param {{ sampleRate: number, audioEndMs: number }} info
   */
  appendAudio(pcm, info) {
    const durationMs = Math.round((pcm.byteLength / 2 / info.sampleRate) * 1000)
    const wire = this.options.wire ?? 'omni-duplex'
    if (wire === 'vllm-asr' || wire === 'omni-turn') {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
    } else if (info.encoding === 'pcm_f32le') {
      this.send({ type: 'input_audio_buffer.append', audio: s16ToF32(pcm).toString('base64'), format: 'pcm_f32le', sample_rate_hz: info.sampleRate, duration_ms: durationMs, audio_end_ms: info.audioEndMs })
    } else {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64'), sample_rate_hz: info.sampleRate, duration_ms: durationMs, audio_end_ms: info.audioEndMs })
    }
    return durationMs
  }

  async close(timeoutMs = 2000) {
    if (this.state === 'closed' || this.socket === undefined) { this.state = 'closed'; return }
    const socket = this.socket
    this.state = 'closing'
    const wire = this.options.wire ?? 'omni-duplex'
    if (wire === 'vllm-asr' || wire === 'omni-turn') {
      // No session.close event in this protocol (it would be an unknown_event); closing the socket ends it.
      this.state = 'closed'
      try { socket.close(1000, 'client close') } catch {}
      return
    }
    try {
      if (socket.readyState === 1 && wire === 'omni-speech-ws') {
        socket.send(JSON.stringify({ type: 'session.close' }))
        await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 300)))
      } else if (socket.readyState === 1) {
        const closed = new Promise(resolve => {
          const timer = setTimeout(resolve, timeoutMs)
          const onEvent = (event) => { if (event.type === 'session.closed') { clearTimeout(timer); this.off('event', onEvent); resolve() } }
          this.on('event', onEvent)
        })
        socket.send(JSON.stringify({ type: 'session.close' }))
        await closed
      }
    } catch { /* socket already failing */ }
    this.state = 'closed'
    try { socket.close(1000, 'client close') } catch {}
  }
}

export function errorText(event) {
  const error = event.error ?? event
  if (typeof error === 'string') return error
  return String(error.message ?? error.code ?? JSON.stringify(error)).slice(0, 300)
}
