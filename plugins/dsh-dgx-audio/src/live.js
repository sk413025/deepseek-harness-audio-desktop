// Host-mediated live input / duplex sessions (CONTRACT.md §5).
//
// The browser sends ordered PCM frames to the host; the host forwards them to the backend
// realtime socket, publishes backend output on the session audio feed, records both
// directions, and turns wire observations into capability evidence. A handshake only makes
// capabilities `advertised`; `verified` needs the functional evidence in CONTRACT.md §2.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PcmStreamFramer, pcmFormat } from './pcm.js'
import { SPEECH_WS_FIELDS } from './tasks.js'
import { taskOf, uiTaskOf } from './task-map.js'
import { RETRYABLE_RESUME_CODES, RealtimeDuplexClient, errorText, realtimeUrl } from './realtime.js'
import { RecordingWriter, safeSegment } from './recording.js'
import { publicRecording } from './audio-hub.js'
import { routeApiKey } from './config.js'
import { modelProvenance, refusalRecord } from './records.js'

const BARGE_IN_REASONS = new Set(['barge_in', 'client_force_barge_in', 'client_overlap_action', 'turn_detected'])
/** Resume attempts after an unexpected socket loss; all well inside the server's 30 s disconnect grace. */
export const RESUME_RETRY_DELAYS_MS = Object.freeze([0, 500, 1500])
/** Window in which a server outcome (response.done, error, echo) is attributed to a sent control. */
export const CONTROL_OUTCOME_MS = 3000

export class LiveError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

export class LiveSessionManager {
  /**
   * @param {object} deps
   * @param {() => any} deps.config
   * @param {import('./audio-hub.js').AudioHub} deps.hub
   * @param {import('./capabilities.js').CapabilityRegistry} deps.capabilities
   * @param {(m: string) => void} deps.log
   * @param {typeof WebSocket} [deps.WebSocket]
   * @param {import('./live-turns.js').LiveTurnRegistry} [deps.turns]
   * @param {() => any} [deps.fileUploads] - host `ctx.fileUploads` (stages the input recording as a prompt receipt)
   */
  constructor(deps) {
    this.deps = deps
    /** @type {Map<string, LiveSession>} */
    this.sessions = new Map()
  }

  find(provider, modelId) {
    const route = this.deps.config().routes.find(r => r.provider === provider)
    const model = route?.models.find(m => m.id === modelId)
    if (route === undefined || model === undefined) throw new LiveError('UNKNOWN_ROUTE', `no configured model ${provider}/${modelId}`, 404)
    if (model.mode !== 'realtime') throw new LiveError('UNSUPPORTED_CAPABILITY', `${provider}/${modelId} is a ${model.mode} model; live input needs mode "realtime"`, 409)
    return { route, model }
  }

  /** @param {{ sessionId: string, provider: string, model: string, overlapPolicy?: string, turnDetection?: string | null }} request */
  async open(request, signal) {
    const config = this.deps.config()
    if (typeof request?.sessionId !== 'string' || request.sessionId === '') throw new LiveError('BAD_REQUEST', 'sessionId is required', 400)
    const { route, model } = this.find(request.provider, request.model)
    const activation = this.deps.activation?.(route.provider, model.id)
    // 0.4.7 (§K.12): fail-fast refusals before any backend connection are logged as refusal records, not invocations.
    const refuse = async (error, details) => {
      await this.deps.recordRefusal?.(refusalRecord({ origin: 'live.open', code: error.code, message: error.message, httpStatus: error.status, route, model, sessionId: request.sessionId, activation, details }))
      return error
    }
    if (activation !== undefined && activation.state !== 'ready') throw await refuse(new LiveError('MODEL_NOT_READY', `${route.provider}/${model.id} is ${activation.state}; activate the model first`, 409))
    const active = [...this.sessions.values()].filter(s => s.state !== 'closed')
    if (active.length >= config.live.maxSessions) throw await refuse(new LiveError('BUFFER_FULL', `at most ${config.live.maxSessions} live sessions`, 429))
    // One engine per DGX model server: a chat/speech reply still streaming from the same server starves the realtime
    // handshake (I2-A 6-3: server config_timeout after ~10 s). Refuse clearly instead of timing out.
    if (request.allowConcurrent !== true) {
      const routes = config.routes
      const busy = (this.deps.work?.list() ?? []).filter(item => item.kind !== 'auxiliary' && routes.find(r => r.provider === item.provider)?.baseURL === route.baseURL)
      if (busy.length > 0) {
        const details = { items: busy.map(({ cancel: _c, ...i }) => i) }
        throw Object.assign(await refuse(new LiveError('PROVIDER_BUSY', `the model server is still answering another request (${busy.map(i => `${i.kind} ${i.provider}/${i.model}`).join(', ')}); wait for that reply to finish or stop it, then start Live`, 409), details), { details })
      }
    }
    const session = new LiveSession(this, route, model, request)
    this.sessions.set(session.liveId, session)
    try {
      await session.start(signal)
    } catch (error) {
      await session.close('open-failed', { code: error?.code ?? 'BACKEND_UNREACHABLE', message: String(error?.message ?? error) })
      if (error instanceof LiveError) throw error
      if (error?.backendCode === 'config_timeout') {
        throw new LiveError('BACKEND_BUSY', `the model server did not accept the live session in time (config_timeout); it may still be busy with another request on the same model. Wait for other replies to finish, then retry. (${error.message})`, 503)
      }
      throw new LiveError(error?.code === 'BACKEND_REJECTED' ? 'BACKEND_REJECTED' : 'BACKEND_UNREACHABLE', String(error?.message ?? error), 502)
    }
    return session
  }

  /**
   * Test-only transport drop plan (config.testFaults.transportDrop, §K.12) for a session that just became ready: the plan
   * applies to exactly one session, the `occurrence`-th ready session of the matching model per distinct plan per process.
   */
  claimTransportDrop(model) {
    const spec = this.deps.config().testFaults?.transportDrop
    if (spec === undefined || (spec.model !== undefined && spec.model !== model.id)) return undefined
    const key = JSON.stringify(spec)
    this.faultCounts ??= new Map()
    const seen = (this.faultCounts.get(key) ?? 0) + 1
    this.faultCounts.set(key, seen)
    return seen === spec.occurrence ? { ...spec, fired: false } : undefined
  }

  get(liveId) {
    const session = this.sessions.get(String(liveId ?? ''))
    if (session === undefined) throw new LiveError('LIVE_NOT_FOUND', 'unknown liveId', 404)
    return session
  }

  async closeWhere(predicate, reason) {
    await Promise.allSettled([...this.sessions.values()].filter(s => s.state !== 'closed' && predicate(s)).map(s => s.close(reason, { code: 'MODEL_SWITCHED', message: reason })))
  }

  async closeAll(reason) {
    await Promise.allSettled([...this.sessions.values()].map(s => s.close(reason)))
  }
}

class LiveSession {
  constructor(manager, route, model, request) {
    this.manager = manager
    this.route = route
    this.model = model
    this.request = request
    this.liveId = `live_${randomUUID()}`
    this.sessionId = request.sessionId
    this.state = 'connecting'
    this.expectedSeq = 0
    this.inputRate = model.realtime.inputSampleRate
    this.inputBytes = 0
    this.frames = 0
    this.responses = new Map() // responseId → { stream, transcript, status, reason, framesDuring }
    this.lastResponseAudioAt = undefined
    this.overlapFrames = 0
    this.evidence = { framesBeforeServerReaction: undefined, bargeIns: 0, acks: 0 }
    this.t0 = performance.now()
    this.inputWriter = undefined
    this.idleTimer = undefined
    this.closing = undefined
    this.eventChain = Promise.resolve()
    this.pendingEvents = 0
  }

  get deps() { return this.manager.deps }
  get hub() { return this.deps.hub }
  get feed() { return this.hub.feed(this.sessionId) }

  publish(event) { this.feed.publish({ ...event, liveId: this.liveId }) }

  get wire() { return this.model.realtime.wire ?? 'omni-duplex' }

  async start(signal) {
    const config = this.deps.config()
    const realtime = this.model.realtime
    const upstream = this.model.upstreamModel ?? this.model.id
    const params = this.deps.sessionParams?.get(this.sessionId, this.route.provider, this.model.id) ?? {}
    const session = { model: upstream, ...realtime.session }
    const overlapPolicy = this.request.overlapPolicy ?? params.overlapPolicy
    const turnDetection = this.request.turnDetection ?? (params.turnDetection === 'none' ? null : params.turnDetection)
    if (overlapPolicy !== undefined) session.overlap_policy = overlapPolicy
    // Nightly vLLM-Omni rejects listen_only together with server_vad (I2 02:21): default to barge_in_on_speech.
    else if (turnDetection === 'server_vad' && this.wire === 'omni-duplex') session.overlap_policy = 'barge_in_on_speech'
    if (turnDetection !== undefined) {
      session.turn_detection = turnDetection === 'server_vad' ? { type: 'server_vad', interrupt_response: true } : null
    }
    if (this.request.voice ?? params.voice) session.voice = this.request.voice ?? params.voice
    if (this.request.instructions ?? params.instructions) session.instructions = this.request.instructions ?? params.instructions
    if (realtime.refAudioFile !== undefined) {
      const ref = await readFile(realtime.refAudioFile)
      session.ref_audio = `data:audio/wav;base64,${ref.toString('base64')}`
    }
    if (this.wire === 'omni-speech-ws') {
      delete session.overlap_policy
      delete session.turn_detection
      // Per-session params: session-params store, then live/open `params` (validated against SPEECH_WS_PARAMS by the route).
      Object.assign(session, speechWsConfig({ ...params, ...(this.request.params ?? {}) }))
      session.response_format = 'pcm'
      session.stream_audio = true
      this.sessionParams = { ...params, ...(this.request.params ?? {}) }
    }
    if (this.wire === 'omni-duplex') {
      // vLLM-Omni reads native duplex and auto-response from session.update.extra_body, not from the URL query
      // (entrypoints/duplex/protocol.py native_duplex_opt_in; serving.py _session_auto_responds). Without them the
      // server runs the generic serving adapter and waits for response.create (I2-A 6-4). Derive the defaults the
      // official client sends (experimental/fullduplex/client.py configure) from the query flag; explicit keys win.
      const extra = { ...(session.extra_body !== null && typeof session.extra_body === 'object' ? session.extra_body : {}) }
      const query = realtime.query ?? {}
      const on = value => value === true || value === 1 || value === '1' || value === 'true'
      const nativeKey = on(query.native_duplex) ? 'native_duplex' : on(query.minicpmo45_native_duplex) ? 'minicpmo45_native_duplex' : undefined
      const explicitNative = 'native_duplex' in extra || 'minicpmo45_native_duplex' in extra
      if (nativeKey !== undefined && !explicitNative) extra[nativeKey] = true
      // The server opts in only on a JSON boolean true; "1" or 1 silently falls back (DGX owner wire table 02:53).
      const off = value => value === false || value === 0 || value === '0' || value === 'false'
      for (const key of ['native_duplex', 'minicpmo45_native_duplex', 'auto_response', 'full_duplex']) {
        if (key in extra && typeof extra[key] !== 'boolean') {
          if (on(extra[key])) extra[key] = true
          else if (off(extra[key])) extra[key] = false
        }
      }
      if (!('auto_response' in extra) && !('full_duplex' in extra)) extra.auto_response = true
      if ((extra.native_duplex === true || extra.minicpmo45_native_duplex === true) && !('force_listen_count' in extra)) extra.force_listen_count = 0
      session.extra_body = extra
      this.nativeRequested = extra.native_duplex === true || extra.minicpmo45_native_duplex === true
      this.autoResponds = extra.auto_response === true || extra.full_duplex === true
    }
    this.sessionConfig = session
    this.publish({ type: 'live.state', state: 'connecting', provider: this.route.provider, model: this.model.id })
    this.client = new RealtimeDuplexClient({
      url: realtimeUrl(this.route.baseURL, realtime, { model: upstream, sessionId: `${realtime.sessionIdPrefix}${this.liveId.slice(5, 17)}` }),
      session,
      wire: this.wire,
      model: upstream,
      apiKey: routeApiKey(this.route),
      WebSocket: this.deps.WebSocket,
      connectTimeoutMs: realtime.connectTimeoutMs,
    })
    // Backend events are applied strictly in arrival order (audio pushes await disk writes).
    this.client.on('event', (event) => {
      this.pendingEvents += 1
      this.eventChain = this.eventChain.then(() => this.onBackendEvent(event)).finally(() => { this.pendingEvents -= 1 })
    })
    this.client.on('binary', (buf) => {
      this.pendingEvents += 1
      this.eventChain = this.eventChain.then(() => this.onBackendBinary(buf)).finally(() => { this.pendingEvents -= 1 })
    })
    this.client.on('socket-closed', info => { if (!info.expected) void this.onSocketLost(info) })
    const server = await this.client.connect(signal)
    this.recordAdvertised(server.capabilities)
    this.turnIndex = 0
    this.turnOpen = false
    this.inputWriter = await RecordingWriter.open(config.outputDir, `${safeSegment(this.sessionId, 'no-session')}/${new Date().toISOString().replace(/[:.]/g, '-')}-${safeSegment(this.model.id)}-live-input.wav`)
    this.state = 'ready'
    this.touch()
    this.warnings = []
    this.faultPlan = this.manager.claimTransportDrop(this.model)
    if (this.faultPlan?.trigger === 'after-ready') this.scheduleTransportDrop()
    const level = server.capabilities?.implementation_level
    if (this.nativeRequested && typeof level === 'string' && level !== 'model_native_duplex') {
      this.warnings.push({ code: 'NATIVE_DUPLEX_NOT_ENABLED', message: `native duplex was requested but the server runs ${level}; replies may need End input, and resume/overlap behave differently` })
    }
    this.publish({ type: 'live.state', state: 'ready', capabilities: this.deps.capabilities.describe(this.route, this.model), capabilitiesScope: 'deployment-history', serverSessionId: server.sessionId ?? null, ...(typeof level === 'string' ? { implementationLevel: level } : {}), autoResponse: this.autoResponds ?? null, warnings: this.warnings })
    for (const warning of this.warnings) {
      this.deps.log(`dsh-dgx-audio: ${this.route.provider}/${this.model.id}: ${warning.message}`)
      this.publish({ type: 'live.warning', ...warning })
    }
  }

  /**
   * One capability observation by this connection. It updates the deployment-level history (shared by every model entry
   * with the same fingerprint, now with structured `observedBy`) and this connection's own evidence: the `live.capability`
   * feed event and `live/close` `observations[]`. Per-connection acceptance must use the latter (CONTRACT §5, TASK_CONTRACT §K.9).
   */
  observe(key, observation, responseId) {
    const at = new Date().toISOString()
    const observedBy = { liveId: this.liveId, sessionId: this.sessionId, model: this.model.id, at, ...(responseId ? { responseId } : {}) }
    this.deps.capabilities.observe(this.route, this.model, key, { ...observation, observedBy })
    const entry = { key, state: observation.state, source: observation.source, detail: observation.detail ?? null, at, ...(responseId ? { responseId } : {}), ...(observation.implementationLevel ? { implementationLevel: observation.implementationLevel } : {}), ...(observation.observedDelivery ? { observedDelivery: observation.observedDelivery } : {}) }
    ;(this.observations ??= []).push(entry)
    this.publish({ type: 'live.capability', ...entry })
  }

  recordAdvertised(caps) {
    if (caps === null || typeof caps !== 'object') return
    const level = typeof caps.implementation_level === 'string' ? caps.implementation_level : undefined
    if (level !== undefined) {
      this.observe('fullDuplex', level === 'model_native_duplex'
        ? { state: 'advertised', source: 'server-session', implementationLevel: level, detail: 'session.created implementation_level' }
        : { state: 'unsupported', source: 'server-session', implementationLevel: level, detail: `server implementation_level ${level}` })
    }
    const flag = (key, name) => {
      if (caps[name] === true) this.observe(key, { state: 'advertised', source: 'server-session', detail: `${name}: true` })
      else if (caps[name] === false) this.observe(key, { state: 'unsupported', source: 'server-session', detail: `${name}: false` })
    }
    flag('liveInput', 'supports_input_append')
    flag('bargeIn', 'supports_barge_in')
    flag('playbackAck', 'supports_playback_ack')
    flag('sessionResume', 'supports_session_resume')
  }

  touch() {
    clearTimeout(this.idleTimer)
    const idle = this.deps.config().live.idleTimeoutMs
    this.idleTimer = setTimeout(() => { void this.close('idle', { code: 'IDLE_TIMEOUT', message: `no live input or control for ${idle} ms` }) }, idle)
    this.idleTimer.unref?.()
  }

  assertOpen() {
    if (this.state !== 'ready') throw new LiveError('LIVE_CLOSED', `live session is ${this.state}`, 410)
    if (this.reconnecting) throw new LiveError('RECONNECTING', 'backend session is reconnecting; retry the same request shortly', 503)
  }

  /**
   * @param {number} seq
   * @param {Buffer} pcm - pcm16 mono at inputRate
   */
  async append(seq, pcm) {
    this.assertOpen()
    if (this.wire === 'omni-speech-ws') throw new LiveError('UNSUPPORTED_CAPABILITY', 'this live session takes text (live/text), not audio frames', 409)
    const config = this.deps.config()
    if (!Number.isInteger(seq) || seq !== this.expectedSeq) throw new LiveError('SEQ_OUT_OF_ORDER', `expected seq ${this.expectedSeq}, got ${seq}`, 409)
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new LiveError('BAD_REQUEST', 'frame must be non-empty pcm16 (even byte length)', 400)
    if (pcm.byteLength > config.live.maxFrameBytes) throw new LiveError('PAYLOAD_TOO_LARGE', `frame exceeds ${config.live.maxFrameBytes} bytes`, 413)
    if ((this.inputBytes + pcm.byteLength) / 2 / this.inputRate > config.live.maxSeconds) throw new LiveError('PAYLOAD_TOO_LARGE', `live input exceeds ${config.live.maxSeconds} s`, 413)
    if (this.client.bufferedAmount > config.live.maxQueuedBytes) throw new LiveError('BUFFER_FULL', `backend socket has ${this.client.bufferedAmount} bytes queued`, 429)
    const receivedAt = Date.now()
    const audioEndMs = Math.round(((this.inputBytes + pcm.byteLength) / 2 / this.inputRate) * 1000)
    try {
      if ((this.wire === 'vllm-asr' || this.wire === 'omni-turn') && !this.turnOpen) {
        // Each turn is one generation: commit(final=false) starts it, commit(final=true) ends its audio.
        this.client.send({ type: 'input_audio_buffer.commit', final: false })
        this.turnOpen = true
        this.turnIndex += 1
        this.inputEndedAt = undefined
      }
      this.client.appendAudio(pcm, { sampleRate: this.inputRate, audioEndMs, encoding: this.model.realtime.inputEncoding })
    } catch (error) {
      // The socket dropped between the state check and the send: the frame was not forwarded.
      throw new LiveError('RECONNECTING', `frame ${seq} not forwarded: ${error?.message ?? error}`, 503)
    }
    const forwardedAt = Date.now()
    this.expectedSeq += 1
    this.inputBytes += pcm.byteLength
    this.frames += 1
    // Duplex overlap: input forwarded while a response is still delivering audio.
    const speakingIds = [...this.responses.values()].filter(r => r.status === 'created' && r.audioChunks > 0).map(r => r.id)
    const speaking = speakingIds.length > 0
    if (speaking) {
      this.overlapFrames += 1
      for (const r of this.responses.values()) if (r.status === 'created' && r.audioChunks > 0) r.framesDuring += 1
    }
    await this.inputWriter?.append(pcm, pcmFormat(this.inputRate, 1))
    this.touch()
    this.publish({ type: 'live.input.accepted', seq, bytes: pcm.byteLength, receivedAt, forwardedAt, ...(speaking ? { overlapResponseIds: speakingIds } : {}) })
    return { ok: true, seq, receivedAt, forwardedAt, queuedBytes: this.client.bufferedAmount }
  }

  /** @param {{ type: string, responseId?: string, playedMs?: number }} control */
  /**
   * Controls are acknowledged per connection (TASK_CONTRACT §K.10). Each gets a `controlId`; the reply says whether
   * anything was sent and, for barge-in / cancel-response, which response it targets. The outcome arrives as
   * `live.control.result` (and in the reply with `wait: true`). A barge-in with no active response sends nothing:
   * vLLM-Omni's `barge_in` is not response-targeted and, after a response ended, raises `stale_fence` and clears
   * buffered input (append reservation stale), so a late Interrupt must be a clean no-op.
   */
  async control(control) {
    this.assertOpen()
    this.controlSeq = (this.controlSeq ?? 0) + 1
    if (this.wire !== 'omni-duplex' && control?.type !== 'commit') {
      throw new LiveError('UNSUPPORTED_CAPABILITY', `${control?.type} is not available on the ${this.wire} wire`, 409)
    }
    const record = { controlId: `ctl_${this.liveId.slice(5, 13)}_${this.controlSeq}`, type: control?.type, at: new Date().toISOString(), sentAtMs: Date.now(), targetResponseId: control?.type === 'playback-ack' && typeof control.responseId === 'string' ? control.responseId : null, sent: false, outcome: undefined }
    if (record.type === 'barge-in' || record.type === 'cancel-response') {
      // Apply backend events already received (e.g. a response.done still queued) before deciding what is active.
      await this.eventChain
      this.assertOpen()
      const active = [...this.responses.values()].filter(r => r.status === 'created').at(-1)
      if (control.responseId !== undefined && (typeof control.responseId !== 'string' || control.responseId === '')) throw new LiveError('BAD_REQUEST', 'responseId must be a non-empty string', 400)
      if (active === undefined) record.outcome = 'no-active-response'
      else if (control.responseId !== undefined && control.responseId !== active.id) { record.outcome = 'response-not-active'; record.targetResponseId = control.responseId }
      else record.targetResponseId = active.id
    }
    if (record.outcome === undefined) {
      try {
        this.sendControl(control, record)
        record.sent = true
      } catch (error) {
        if (error instanceof LiveError) throw error
        throw new LiveError('RECONNECTING', `control not forwarded: ${error?.message ?? error}`, 503)
      }
    }
    this.touch()
    ;(this.controls ??= []).push(record)
    if (!record.sent) {
      this.resolveControl(record, record.outcome)
    } else if (['barge-in', 'cancel-response', 'playback-ack', 'commit'].includes(record.type)) {
      record.settled = new Promise(resolve => { record.resolve = resolve })
      record.timer = setTimeout(() => this.resolveControl(record, 'unconfirmed', { detail: `no server outcome within ${CONTROL_OUTCOME_MS} ms` }), CONTROL_OUTCOME_MS)
      record.timer.unref?.()
      const waitMs = control.wait === true ? Math.min(Math.max(Number(control.waitMs) || 2000, 0), 5000) : 0
      if (waitMs > 0) await Promise.race([record.settled, new Promise(resolve => setTimeout(resolve, waitMs))])
    } else {
      this.resolveControl(record, 'sent')
    }
    return { ok: true, controlId: record.controlId, type: record.type, sent: record.sent, targetResponseId: record.targetResponseId, outcome: record.outcome ?? 'pending', ...(record.reason ? { reason: record.reason } : {}) }
  }

  resolveControl(record, outcome, extra = {}) {
    if (record.outcome !== undefined && record.resolvedAt !== undefined) return
    record.outcome = outcome
    record.resolvedAt = new Date().toISOString()
    Object.assign(record, extra)
    clearTimeout(record.timer)
    record.resolve?.()
    this.publish({ type: 'live.control.result', controlId: record.controlId, control: record.type, sent: record.sent, targetResponseId: record.targetResponseId, outcome, ...extra })
  }

  /** Pending sent controls of these types, newest first, sent within the attribution window. */
  pendingControls(types) {
    return this.recentControls(types).filter(c => c.resolvedAt === undefined)
  }

  /** Sent controls of these types within the attribution window, resolved or not, newest first. */
  recentControls(types) {
    const now = Date.now()
    return (this.controls ?? []).filter(c => c.sent && types.includes(c.type) && now - c.sentAtMs <= CONTROL_OUTCOME_MS).reverse()
  }

  sendControl(control, record) {
    const duplex = this.wire === 'omni-duplex'
    if (!duplex && control?.type !== 'commit') {
      throw new LiveError('UNSUPPORTED_CAPABILITY', `${control?.type} is not available on the ${this.wire} wire`, 409)
    }
    switch (control?.type) {
      case 'commit':
        if (this.wire === 'omni-speech-ws') throw new LiveError('UNSUPPORTED_CAPABILITY', 'use live/text with done:true on the speech stream-input wire', 409)
        this.client.send({ type: 'input_audio_buffer.commit', final: true })
        this.inputEndedAt = Date.now()
        if (!duplex) this.turnOpen = false
        // A duplex session that does not auto-respond and has no server VAD only answers an explicit request.
        if (duplex && this.autoResponds === false && (this.sessionConfig?.turn_detection ?? null) === null) {
          this.client.send({ type: 'response.create' })
          this.evidence.responseRequestedAt = Date.now()
        }
        break
      case 'barge-in':
        this.client.send({ type: 'barge_in', event_id: record?.controlId })
        this.evidence.bargeInRequestedAt = Date.now()
        break
      case 'cancel-response':
        // Always response-targeted: the server treats an inactive response_id as a clean no-op / response_not_active.
        this.client.send({ type: 'response.cancel', response_id: record?.targetResponseId ?? control.responseId, event_id: record?.controlId })
        break
      case 'playback-ack': {
        const playedMs = Number(control.playedMs)
        if (typeof control.responseId !== 'string' || !(playedMs >= 0)) throw new LiveError('BAD_REQUEST', 'playback-ack needs responseId and playedMs', 400)
        this.client.send({ type: 'playback.ack', response_id: control.responseId, item_id: `item_${control.responseId}`, played_ms: Math.round(playedMs), committed_ms: Math.round(playedMs) })
        break
      }
      default:
        throw new LiveError('BAD_REQUEST', `unknown control type ${JSON.stringify(control?.type)}`, 400)
    }
  }

  /** tts.stream-input: incremental text → per-sentence audio. */
  async text(input) {
    this.assertOpen()
    if (this.wire !== 'omni-speech-ws') throw new LiveError('UNSUPPORTED_CAPABILITY', 'live/text is only for the speech stream-input wire', 409)
    const text = typeof input?.text === 'string' ? input.text : ''
    if (text.length > 20000) throw new LiveError('PAYLOAD_TOO_LARGE', 'text chunk too large', 413)
    this.textLog ??= []
    this.utterance ??= 0
    if (input?.params !== undefined) {
      // session.config is sticky and replaceable only between utterances (serving_speech_stream.py): refuse mid-utterance.
      if (this.utteranceOpen) throw new LiveError('UTTERANCE_IN_PROGRESS', 'params can change only before the first text of an utterance (after done:true)', 409)
      this.sessionParams = { ...this.sessionParams, ...input.params }
      const config = { ...this.sessionConfig, ...speechWsConfig(this.sessionParams), response_format: 'pcm', stream_audio: true }
      try { this.client.send({ type: 'session.config', ...config }) } catch (error) { throw new LiveError('RECONNECTING', `params not forwarded: ${error?.message ?? error}`, 503) }
      this.sessionConfig = config
      this.turnParams = [...(this.turnParams ?? []), { utterance: this.utterance, params: input.params }]
    }
    try {
      if (text.length > 0) this.client.send({ type: 'input.text', text })
      if (input?.done === true) { this.client.send({ type: 'input.done' }); this.inputEndedAt = Date.now() }
    } catch (error) {
      throw new LiveError('RECONNECTING', `text not forwarded: ${error?.message ?? error}`, 503)
    }
    if (text.length > 0) { this.textLog.push({ utterance: this.utterance, text }); this.utteranceOpen = true }
    if (input?.done === true) { this.utteranceOpen = false; this.utterance += 1 }
    this.textChunks = (this.textChunks ?? 0) + (text.length > 0 ? 1 : 0)
    this.touch()
    return { ok: true, chunks: this.textChunks, utterance: this.utterance }
  }

  responseOf(event, create) {
    const id = event.response_id ?? event.response?.id ?? (this.wire === 'omni-duplex' ? undefined : `turn-${this.turnIndex}`)
    if (typeof id !== 'string') return undefined
    let response = this.responses.get(id)
    if (response === undefined && create) {
      response = {
        id, status: 'created', transcript: '', audioChunks: 0, framesDuring: 0,
        stream: this.hub.openStream({ sessionId: this.sessionId, provider: this.route.provider, model: this.model.id, origin: 'live', responseId: id }),
      }
      this.responses.set(id, response)
      this.publish({ type: 'live.response', responseId: id, status: 'created' })
    }
    return response
  }

  async onBackendEvent(event) {
    try {
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
        case 'input_audio_buffer.speech_stopped':
        case 'input_audio_buffer.committed': {
          this.publish({ type: 'live.speech', event: event.type.split('.').at(-1).replace('speech_', ''), ...(event.audio_start_ms === undefined ? {} : { audioMs: event.audio_start_ms }) })
          for (const pending of this.pendingControls(['commit']).slice(-1)) this.resolveControl(pending, 'committed')
          this.noteServerReaction()
          break
        }
        case 'response.created':
          this.responseOf(event, true)
          this.noteServerReaction()
          break
        case 'response.audio.delta': {
          const response = this.responseOf(event, true)
          const payload = typeof event.delta === 'string' ? event.delta : event.audio
          if (response === undefined || response.status !== 'created' || typeof payload !== 'string' || payload.length === 0) break
          const epoch = Number.isInteger(event.metadata?.epoch) ? event.metadata.epoch : undefined
          await response.stream.pushPayload(Buffer.from(payload, 'base64'), {
            format: typeof event.format === 'string' ? event.format : event.format?.type ?? 'pcm16',
            sampleRate: event.sample_rate_hz ?? event.format?.rate ?? this.model.realtime.outputSampleRate,
            epoch,
          })
          response.audioChunks += 1
          if (this.faultPlan?.trigger === 'after-first-audio') this.scheduleTransportDrop()
          this.noteServerReaction()
          break
        }
        case 'transcription.delta': {
          // vLLM realtime ASR / omni turn wire: incremental transcript of the live input.
          if (typeof event.delta !== 'string' || event.delta.length === 0) break
          const turnId = `turn-${this.turnIndex}`
          const turn = this.transcriptTurn(turnId)
          turn.deltas += 1
          turn.text += event.delta
          if (this.inputEndedAt === undefined) turn.deltasBeforeInputEnd += 1
          this.publish({ type: 'text.delta', kind: this.wire === 'omni-turn' ? 'response' : 'transcript', streamId: turnId, responseId: turnId, text: event.delta })
          this.noteServerReaction()
          break
        }
        case 'transcription.done': {
          const turnId = `turn-${this.turnIndex}`
          const turn = this.transcriptTurn(turnId)
          turn.done = true
          turn.final = typeof event.text === 'string' ? event.text : turn.text
          this.publish({ type: 'live.transcript.done', responseId: turnId, text: turn.final })
          if (turn.deltas >= 2) this.observe('textStreaming', { state: 'verified', source: 'live', detail: `${turn.deltas} realtime transcription deltas (${turn.deltasBeforeInputEnd} before input end)` }, turnId)
          if (this.wire === 'vllm-asr') this.publish({ type: 'live.response', responseId: turnId, status: 'completed' })
          break
        }
        case 'response.audio.done': {
          if (this.wire !== 'omni-turn') break // duplex responses end on response.done
          const response = this.responseOf(event, false)
          if (response === undefined || response.status !== 'created') break
          response.status = 'completed'
          response.summary = await response.stream.end('completed')
          this.observeDelivery(response.summary, response.id)
          this.publish({ type: 'live.response', responseId: response.id, status: 'completed' })
          break
        }
        case 'audio.start': {
          if (this.wire !== 'omni-speech-ws') break
          const id = `utt-${event.utterance_index ?? 0}`
          // audio.start advertises a nominal 24000 Hz (serving_speech_stream.py:339-342); binary frames carry no rate, so an
          // explicitly configured outputSampleRate (catalog audio_io) wins, and JSON audio.chunk sample_rate wins over both.
          const configured = this.model.realtime.outputSampleRateExplicit ? this.model.realtime.outputSampleRate : undefined
          this.speechFormat = { sampleRate: configured ?? (Number(event.sample_rate) || this.model.realtime.outputSampleRate), format: event.format ?? 'pcm' }
          let response = this.responses.get(id)
          if (response === undefined) {
            response = { id, status: 'created', transcript: '', audioChunks: 0, framesDuring: 0, sentences: 0, stream: this.hub.openStream({ sessionId: this.sessionId, provider: this.route.provider, model: this.model.id, origin: 'live', responseId: id }) }
            this.responses.set(id, response)
            this.publish({ type: 'live.response', responseId: id, status: 'created' })
          }
          this.currentUtterance = id
          response.sentenceOffsetMs = response.stream.format?.sampleRate ? Math.round(response.stream.totalSamples / response.stream.format.sampleRate * 1000) : 0
          if (typeof event.sentence_text === 'string') { response.transcript += event.sentence_text; this.publish({ type: 'text.delta', kind: 'response', streamId: id, responseId: id, text: event.sentence_text }) }
          break
        }
        case 'audio.chunk': {
          if (this.wire !== 'omni-speech-ws') break
          // word_timestamps: a trailing empty-audio chunk carries the sentence alignment (list = aligned, [] = silence, null = failed).
          if (typeof event.audio_b64 === 'string' && event.audio_b64.length === 0 && this.sessionParams?.wordTimestamps === true) {
            const response = this.responses.get(`utt-${event.utterance_index ?? 0}`)
            if (response !== undefined) {
              const offset = response.sentenceOffsetMs ?? 0
              const entry = Array.isArray(event.timestamps)
                ? { sentenceIndex: event.sentence_index ?? null, state: event.timestamps.length > 0 ? 'aligned' : 'silence', words: event.timestamps.map(w => ({ word: String(w.word ?? ''), startMs: offset + Number(w.start_ms), endMs: offset + Number(w.end_ms) })) }
                : { sentenceIndex: event.sentence_index ?? null, state: 'failed', words: [] }
              response.wordTimestamps = [...(response.wordTimestamps ?? []), entry]
              this.publish({ type: 'live.words', responseId: response.id, ...entry })
            }
            break
          }
          if (typeof event.audio_b64 !== 'string' || event.audio_b64.length === 0) break
          await this.onBackendBinary(Buffer.from(event.audio_b64, 'base64'), Number(event.sample_rate) || undefined)
          break
        }
        case 'audio.done': {
          const response = this.responses.get(`utt-${event.utterance_index ?? 0}`)
          if (response !== undefined) response.sentences += 1
          if (event.error === true) this.publish({ type: 'live.error', code: 'SENTENCE_FAILED', message: `sentence ${event.sentence_index ?? '?'} failed`, fatal: false })
          break
        }
        case 'session.done': {
          if (this.wire !== 'omni-speech-ws') break
          const response = this.responses.get(`utt-${event.utterance_index ?? 0}`)
          if (response === undefined || response.status !== 'created') break
          response.status = 'completed'
          response.summary = await response.stream.end('completed')
          this.observeDelivery(response.summary, response.id)
          this.publish({ type: 'live.response', responseId: response.id, status: 'completed' })
          break
        }
        case 'response.audio_transcript.delta': {
          const response = this.responseOf(event, true)
          if (response === undefined || typeof event.delta !== 'string') break
          response.transcript += event.delta
          this.publish({ type: 'text.delta', kind: 'response', streamId: response.id, responseId: response.id, text: event.delta })
          break
        }
        case 'response.done': {
          const response = this.responseOf(event, true)
          if (response === undefined) break
          const status = event.response?.status === 'cancelled' ? 'cancelled' : 'completed'
          const reason = event.response?.status_details?.reason ?? null
          response.status = status
          response.reason = reason
          response.summary = await response.stream.end(status === 'completed' ? 'completed' : 'cancelled')
          if (status === 'completed') this.observeDelivery(response.summary, response.id)
          this.publish({ type: 'live.response', responseId: response.id, status, reason })
          for (const pending of this.pendingControls(['barge-in', 'cancel-response']).filter(c => c.targetResponseId === response.id)) {
            // A response that completed after the control was sent was not cancelled by it (tail race).
            this.resolveControl(pending, status === 'cancelled' ? 'cancelled' : 'response-already-completed', { reason })
          }
          if (status === 'cancelled' && BARGE_IN_REASONS.has(reason)) {
            this.observe('bargeIn', { state: 'verified', source: 'live', detail: `response ${response.id} cancelled (${reason})` }, response.id)
          }
          if (response.framesDuring > 0 && response.audioChunks > 0) {
            this.observe('fullDuplex', { state: 'verified', source: 'live', detail: `${response.framesDuring} input frames forwarded while ${response.audioChunks} response audio chunks arrived (${status})` }, response.id)
          }
          break
        }
        case 'playback.acknowledged':
          this.evidence.acks += 1
          this.publish({ type: 'live.playback.ack', responseId: event.response_id ?? null, playedMs: event.played_ms ?? null, committedMs: event.committed_ms ?? null })
          for (const pending of this.pendingControls(['playback-ack']).filter(c => c.targetResponseId === (event.response_id ?? null)).slice(-1)) this.resolveControl(pending, 'acknowledged')
          this.observe('playbackAck', { state: 'verified', source: 'live', detail: 'playback.acknowledged echo' }, event.response_id)
          break
        case 'output_audio_buffer.cleared':
        case 'response.epoch': {
          const epoch = event.epoch ?? event.metadata?.epoch
          if (Number.isInteger(epoch)) for (const r of this.responses.values()) r.stream.setEpoch(epoch, event.type)
          break
        }
        case 'error': {
          const code = String(event.error?.code ?? event.code ?? 'BACKEND_ERROR')
          const message = errorText(event)
          let controlId = typeof event.event_id === 'string' && (this.controls ?? []).some(c => c.controlId === event.event_id) ? event.event_id : undefined
          if (code === 'stale_fence' || /fence mismatch/.test(message)) {
            // barge_in after the targeted response ended: the server had nothing to cancel. Attributed, never counted as a cancel.
            const pending = controlId !== undefined ? (this.controls ?? []).find(c => c.controlId === controlId) : this.recentControls(['barge-in'])[0]
            if (pending !== undefined) {
              controlId = pending.controlId
              if (pending.resolvedAt === undefined) this.resolveControl(pending, 'stale', { reason: code })
              else pending.staleError = code
            }
          } else if (code === 'response_not_active') {
            const pending = controlId !== undefined ? (this.controls ?? []).find(c => c.controlId === controlId) : this.recentControls(['cancel-response'])[0]
            if (pending !== undefined) { controlId = pending.controlId; if (pending.resolvedAt === undefined) this.resolveControl(pending, 'response-not-active', { reason: code }) }
          } else if (/append reservation is stale/.test(message)) {
            // The server dropped an input append (reservation invalidated, e.g. by a barge_in clearing buffered input).
            // Exact seq attribution needs event_id echo, which the server only adds with server VAD: report the window.
            const recent = this.recentControls(['barge-in'])[0]
            const rejection = { code, message, at: new Date().toISOString(), lastForwardedSeq: this.expectedSeq - 1, ...(recent ? { controlId: recent.controlId } : {}) }
            ;(this.inputRejections ??= []).push(rejection)
            this.publish({ type: 'live.input.rejected', ...rejection })
            controlId ??= recent?.controlId
          }
          this.publish({ type: 'live.error', code, message, fatal: false, ...(controlId ? { controlId } : {}) })
          break
        }
        case 'session.closed':
          void this.close('backend-closed')
          break
        default:
          break
      }
    } catch (error) {
      this.deps.log(`dsh-dgx-audio: live event ${event.type} failed: ${error?.message ?? error}`)
      this.publish({ type: 'live.error', code: error?.code ?? 'LIVE_EVENT_FAILED', message: String(error?.message ?? error), fatal: false })
    }
  }

  transcriptTurn(id) {
    this.transcripts ??= new Map()
    let turn = this.transcripts.get(id)
    if (turn === undefined) { turn = { id, text: '', deltas: 0, deltasBeforeInputEnd: 0, done: false }; this.transcripts.set(id, turn) }
    return turn
  }

  observeDelivery(summary, responseId) {
    if (summary?.chunks > 0) this.observe('audioOutput', { state: 'verified', source: 'live', detail: `${summary.chunks} audio chunks` }, responseId)
    if (summary?.delivery === 'progressive') this.observe('audioOutputStreaming', { state: 'verified', source: 'live', observedDelivery: 'progressive', detail: `${summary.chunks} chunks before the response ended` }, responseId)
    else if (summary !== undefined) this.deps.capabilities.note(this.route, this.model, 'audioOutputStreaming', { observedDelivery: summary.delivery })
  }

  /** Raw PCM frames (speech stream-input wire). */
  async onBackendBinary(buf, chunkSampleRate) {
    if (this.wire !== 'omni-speech-ws') return
    const id = this.currentUtterance
    const response = id === undefined ? undefined : this.responses.get(id)
    if (response === undefined || response.status !== 'created') {
      this.publish({ type: 'live.error', code: 'ORPHAN_AUDIO', message: 'binary audio frame without audio.start', fatal: false })
      return
    }
    // Frames may split a sample: carry the odd byte into the next frame instead of dropping it.
    const rate = chunkSampleRate ?? this.speechFormat?.sampleRate ?? this.model.realtime.outputSampleRate
    if (response.framer === undefined || response.framerRate !== rate) {
      response.framer = new PcmStreamFramer({ format: 'pcm', sampleRate: rate })
      response.framerRate = rate
    }
    const frame = response.framer.push(buf)
    if (frame === undefined) return
    if (this.faultPlan?.trigger === 'after-first-audio') this.scheduleTransportDrop()
    await response.stream.pushPcm(frame.pcm, frame.format)
    response.audioChunks += 1
  }

  noteServerReaction() {
    if (this.evidence.framesBeforeServerReaction !== undefined) return
    this.evidence.framesBeforeServerReaction = this.frames
    if (this.frames >= 2) {
      this.observe('liveInput', { state: 'verified', source: 'live', detail: `backend reacted after ${this.frames} streamed frames, before input end` })
    }
  }

  /** Arm the test-only drop once (§K.12). */
  scheduleTransportDrop() {
    const plan = this.faultPlan
    if (plan === undefined || plan.scheduled) return
    plan.scheduled = true
    const timer = setTimeout(() => this.injectTransportDrop(), plan.afterMs)
    timer.unref?.()
  }

  /**
   * Close the backend socket without `session.close` and without marking the client closing, so the normal unexpected-loss
   * path (onSocketLost → session.resume) runs exactly as for a network drop. Published before `live.state reconnecting`.
   */
  injectTransportDrop() {
    const plan = this.faultPlan
    if (plan === undefined || plan.fired) return
    plan.fired = true
    const record = {
      kind: 'transport-drop', at: new Date().toISOString(), trigger: plan.trigger, afterMs: plan.afterMs, closeCode: plan.closeCode, resume: plan.resume,
      ...(plan.resume === 'delay' ? { resumeDelayMs: plan.resumeDelayMs } : {}),
      lastServerEventSeq: this.client?.lastSeq ?? null, framesForwarded: this.frames,
      activeResponseIds: [...this.responses.values()].filter(r => r.status === 'created').map(r => r.id),
    }
    this.faultInjections = [...(this.faultInjections ?? []), record]
    if (this.state !== 'ready' || this.reconnecting || this.client?.socket?.readyState !== 1) {
      record.outcome = 'skipped'
      record.detail = `session ${this.reconnecting ? 'reconnecting' : this.state}, socket not open`
      this.publish({ type: 'live.test.fault', ...record })
      return
    }
    record.outcome = 'dropped'
    this.publish({ type: 'live.test.fault', ...record })
    plan.pendingLoss = true
    try { this.client.socket.close(plan.closeCode, 'dsh-dgx-audio testFaults.transportDrop') } catch (error) { record.outcome = 'error'; record.detail = String(error?.message ?? error); plan.pendingLoss = false }
  }

  async onSocketLost(info) {
    if (this.state !== 'ready' || this.reconnecting) return
    this.reconnecting = true
    // A reconnect is not user idleness: the idle timer pauses until the bounded resume loop ends (resume → touch, fail → close).
    clearTimeout(this.idleTimer)
    const lostAt = Date.now()
    this.evidence.socketLosses = (this.evidence.socketLosses ?? 0) + 1
    const injected = this.faultPlan?.pendingLoss === true ? this.faultPlan : undefined
    if (injected) injected.pendingLoss = false
    this.publish({ type: 'live.state', state: 'reconnecting', code: info.code ?? null, ...(injected ? { testFault: 'transport-drop' } : {}) })
    const attempts = (this.evidence.resumeAttempts ??= [])
    const tokenMode = injected?.resume === 'invalid-token' ? 'invalid-test' : 'server-issued'
    let lastError
    for (const [index, retryDelay] of RESUME_RETRY_DELAYS_MS.entries()) {
      if (this.state !== 'ready') return
      const delay = index === 0 && injected?.resume === 'delay' ? injected.resumeDelayMs : retryDelay
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      if (this.state !== 'ready') return
      const attempt = { attempt: index + 1, delayMs: delay, startedAt: new Date().toISOString(), tokenMode, ...(injected ? { testFault: 'transport-drop' } : {}) }
      attempts.push(attempt)
      try {
        const override = tokenMode === 'invalid-test' ? { resumeToken: `${this.client.server.resumeToken ?? ''}.dsh-test-invalid` } : undefined
        const event = await this.client.resume(undefined, override)
        attempt.outcome = 'resumed'
        attempt.endedAt = new Date().toISOString()
        this.reconnecting = false
        this.evidence.lastResume = { lostAt, resumedAt: Date.now(), attempts: index + 1, duplicateEvents: this.client.duplicateEvents, attachmentGeneration: event.attachment_generation ?? null, ...(injected ? { testFault: 'transport-drop' } : {}) }
        this.observe('sessionResume', { state: 'verified', source: 'live', detail: `session.resumed after ${injected ? 'testFaults transport drop' : 'socket loss'} (attempt ${index + 1}); ${this.client.duplicateEvents} replayed events dropped` })
        this.publish({ type: 'live.state', state: 'ready', resumed: true, attempts: index + 1 })
        this.touch()
        return
      } catch (error) {
        lastError = error
        const code = String(error?.backendCode ?? '').toLowerCase()
        const retryable = RETRYABLE_RESUME_CODES.has(code) || error?.code === 'TRANSPORT'
        Object.assign(attempt, { outcome: error?.code === 'TRANSPORT' ? 'transport-error' : 'rejected', code: error?.code ?? null, backendCode: error?.backendCode ?? null, retryable, endedAt: new Date().toISOString(), message: String(error?.message ?? error).slice(0, 300) })
        this.publish({ type: 'live.error', code: error?.backendCode ?? error?.code ?? 'RESUME_FAILED', message: String(error?.message ?? error), fatal: !retryable })
        if (!retryable) break
      }
    }
    this.reconnecting = false
    await this.close('backend-lost', { code: lastError?.backendCode === 'session.resync_required' ? 'RESYNC_REQUIRED' : (lastError?.code ?? 'BACKEND_DISCONNECTED'), message: String(lastError?.message ?? 'resume failed'), ...(lastError?.backendCode ? { backendCode: lastError.backendCode } : {}) })
  }

  /**
   * @param {string} reason
   * @param {{ code: string, message: string }} [error]
   */
  close(reason, error) {
    this.closing ??= this.doClose(reason, error)
    return this.closing
  }

  async doClose(reason, error) {
    const wasReady = this.state === 'ready' && !this.reconnecting
    this.state = 'closed'
    this.reconnecting = false
    clearTimeout(this.idleTimer)
    if (wasReady) await this.client?.close().catch(() => {})
    else this.client?.socket?.close?.()
    await this.eventChain
    for (const pending of (this.controls ?? []).filter(c => c.resolvedAt === undefined)) this.resolveControl(pending, 'unconfirmed', { detail: 'session closed before a server outcome' })
    const responses = []
    for (const response of this.responses.values()) {
      if (response.status === 'created') {
        response.status = 'cancelled'
        response.summary = await response.stream.end('cancelled', { error: { code: 'LIVE_CLOSED', message: reason } })
      }
      responses.push({ responseId: response.id, status: response.status, reason: response.reason ?? null, transcript: response.transcript, recording: response.summary?.recording ?? null, audioChunks: response.audioChunks, inputFramesDuringOutput: response.framesDuring, delivery: response.summary?.delivery ?? null, ...(response.wordTimestamps ? { wordTimestamps: response.wordTimestamps } : {}) })
    }
    let input = null
    let inputPath
    try {
      const recording = await this.inputWriter?.finalize({ complete: true })
      if (recording !== undefined) { input = publicRecording(recording); inputPath = recording.path }
    } catch (e) {
      this.deps.log(`dsh-dgx-audio: cannot finalize live input recording: ${e?.message ?? e}`)
    }
    if (this.wire === 'omni-speech-ws' && (this.textLog?.length ?? 0) > 0) {
      // Streamed text-to-speech: the model-visible input is the accepted live/text, staged as a UTF-8 text receipt.
      try {
        const text = this.textLog.map(t => t.text).join('')
        const bytes = Buffer.from(text, 'utf8')
        const dir = join(this.deps.config().outputDir, safeSegment(this.sessionId, 'no-session'))
        await mkdir(dir, { recursive: true })
        inputPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeSegment(this.model.id)}-live-text.txt`)
        await writeFile(inputPath, bytes)
        input = { kind: 'text', name: `live-text-${this.liveId.slice(-12)}.txt`, bytes: bytes.byteLength, chars: [...text].length, utterances: this.utterance ?? 0, sha256: createHash('sha256').update(bytes).digest('hex') }
      } catch (e) {
        this.deps.log(`dsh-dgx-audio: cannot write live text input: ${e?.message ?? e}`)
      }
    }
    const transcriptTurns = [...(this.transcripts?.values() ?? [])].filter(t => (t.final ?? t.text).length > 0)
    const answered = responses.some(r => r.status === 'completed' || r.audioChunks > 0) || transcriptTurns.length > 0
    // Why the exchange is (not) recorded in the conversation; the mic shows this instead of a bare "unavailable".
    const sent = this.wire === 'omni-speech-ws' ? `${this.textChunks ?? 0} text chunk(s)` : `${this.frames} frame(s)`
    let receipt = input === null ? { state: 'skipped', reason: (this.frames === 0 && (this.textLog?.length ?? 0) === 0) ? 'no-input' : 'input-recording-failed' }
      : !answered ? { state: 'skipped', reason: 'no-response', detail: `${sent} sent, no response or transcript from the model${this.warnings?.length ? `; ${this.warnings.map(w => w.code).join(', ')}` : ''}` }
        : undefined
    if (input !== null && answered) {
      this.deps.turns?.register({
        inputSha256: input.sha256, sessionId: this.sessionId, liveId: this.liveId, provider: this.route.provider, model: this.model.id,
        input, task: taskOf(this.model), uiTask: uiTaskOf(this.model),
        // 0.4.7: provenance of the live model that produced the exchange (replayed results cite it, not the chat model).
        origin: (({ upstreamModel, catalogTasks, catalogTasksSource, deploymentId }) => ({ upstreamModel, catalogTasks, catalogTasksSource, deploymentId }))(modelProvenance(this.model)),
        ...(this.wire === 'omni-speech-ws' && Object.keys(this.sessionParams ?? {}).length > 0 ? { params: this.sessionParams, turnParams: this.turnParams ?? [] } : {}),
        responses: responses.length > 0
          ? responses.map(r => ({ responseId: r.responseId, status: r.status, reason: r.reason, transcript: r.transcript, recording: r.recording, audioChunks: r.audioChunks, delivery: r.delivery, ...(r.wordTimestamps ? { wordTimestamps: r.wordTimestamps } : {}) }))
          : transcriptTurns.map(t => ({ responseId: t.id, status: t.done ? 'completed' : 'incomplete', reason: null, transcript: t.final ?? t.text, recording: null, audioChunks: 0 })),
      })
      const uploads = this.deps.fileUploads?.()
      if (uploads?.uploadStream !== undefined) {
        try {
          const name = input.kind === 'text' ? input.name : `live-input-${input.recordingId.slice(-12)}.wav`
          const staged = await uploads.uploadStream({ sessionId: this.sessionId, data: createReadStream(inputPath), name })
          input = { ...input, receiptId: staged.receiptId, attachmentId: staged.file?.attachmentId ?? null }
          receipt = { state: 'staged', receiptId: staged.receiptId }
          if (staged.file?.attachmentId !== undefined && staged.file.attachmentId !== `sha256:${input.sha256}`) {
            // Replay is keyed by the bytes this host recorded; a store that rewrote them would never match.
            receipt = { ...receipt, warning: 'attachment-digest-mismatch', detail: `store ${staged.file.attachmentId} vs recorded sha256:${input.sha256}` }
          }
        } catch (e) {
          input = { ...input, receiptId: null, stagingError: String(e?.message ?? e) }
          receipt = { state: 'failed', reason: 'staging-failed', detail: String(e?.message ?? e) }
        }
      } else {
        receipt = { state: 'unavailable', reason: 'host-file-uploads-unavailable' }
      }
    }
    if (input !== null) input = { ...input, receipt }
    this.publish({ type: 'live.state', state: 'closed', reason, receipt, ...(error === undefined ? {} : { error }) })
    this.result = {
      ok: error === undefined,
      liveId: this.liveId,
      reason,
      input,
      responses,
      wire: this.wire,
      receipt,
      // Evidence observed by THIS connection only (the capability document is deployment-level history).
      observations: this.observations ?? [],
      controls: (this.controls ?? []).map(({ controlId, type, at, sent, targetResponseId, outcome, reason, resolvedAt, detail, staleError }) => ({ controlId, type, at, sent, targetResponseId, outcome, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), ...(staleError ? { staleError } : {}), resolvedAt })),
      inputIntegrity: { framesForwarded: this.frames, serverRejectedAppends: (this.inputRejections ?? []).length, rejections: this.inputRejections ?? [] },
      implementationLevel: this.client?.server?.capabilities?.implementation_level ?? null,
      warnings: this.warnings ?? [],
      transcripts: [...(this.transcripts?.values() ?? [])].map(t => ({ turnId: t.id, text: t.final ?? t.text, deltas: t.deltas, deltasBeforeInputEnd: t.deltasBeforeInputEnd, done: t.done })),
      resume: this.evidence.lastResume ?? null,
      socketLosses: this.evidence.socketLosses ?? 0,
      // 0.4.7 (§K.12): every resume attempt of THIS connection, and any test-only fault injected into it.
      resumeAttempts: this.evidence.resumeAttempts ?? [],
      faultInjections: this.faultInjections ?? [],
      stats: { frames: this.frames, inputBytes: this.inputBytes, overlapFrames: this.overlapFrames, sentEvents: this.client?.sentEvents ?? 0, receivedEvents: this.client?.receivedEvents ?? 0, duplicateEvents: this.client?.duplicateEvents ?? 0, framesBeforeServerReaction: this.evidence.framesBeforeServerReaction ?? null },
      ...(error === undefined ? {} : { error }),
    }
    return this.result
  }
}

/** UI params → speech stream-input session.config fields (only keys that are set). */
function speechWsConfig(params) {
  const out = {}
  for (const [key, field] of Object.entries(SPEECH_WS_FIELDS)) if (params?.[key] !== undefined && params[key] !== null) out[field] = params[key]
  return out
}
