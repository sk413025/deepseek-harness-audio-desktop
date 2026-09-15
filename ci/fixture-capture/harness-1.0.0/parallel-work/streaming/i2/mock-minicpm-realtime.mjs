// Local mock of the vLLM-Omni 0.28 MiniCPM-o 4.5 realtime duplex wire, for validating the I2 runner
// branches before a real window. Semantics follow the pinned source (eb11446b) and SERVER_CONTRACT.md:
// - disconnect without session.close → resumable detach with a disconnect grace; events keep being journaled
// - session.resume needs server-issued session id + integer incarnation + current token; session.resumed has no
//   server_event_seq; journal entries after last_received_server_event_seq are replayed
// - turn_detection {type:"server_vad"} cancels an active response with reason "turn_detected" on speech
// - client barge_in → reason "barge_in"; playback.ack → playback.acknowledged
// It is a MOCK: energy-threshold "VAD", synthetic tones. Never evidence about the real server.
// Usage: node mock-minicpm-realtime.mjs [port]   (prints `MOCK_LISTENING <baseURL>`)
import { randomUUID } from 'node:crypto'
import { wsServer } from '../../../plugins/dsh-dgx-audio/test/helpers/ws-server.js'

const port = Number(process.argv[2] ?? 0)
const GRACE_MS = Number(process.env.MOCK_GRACE_MS ?? 30000)
const RESUME_DELAY_MS = Number(process.env.MOCK_RESUME_DELAY_MS ?? 0) // simulate a slow re-attach so held frames are exercised
const sessions = new Map()
const CAPS = {
  implementation_level: 'model_native_duplex', chunk_period_ms: 1000, supports_barge_in: true, supports_audio_truncate: true,
  supports_session_resume: true, supports_playback_ack: true, supports_input_append: true, supports_client_commit: true, input_modes: ['append_audio_chunk'],
}

function tone(ms, freq) {
  const n = Math.round(24000 * ms / 1000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * freq * i / 24000)), i * 2)
  return b
}

function rms(pcm) {
  let sum = 0
  const n = Math.floor(pcm.length / 2)
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v }
  return n === 0 ? 0 : Math.sqrt(sum / n)
}

class MockSession {
  constructor(conn, update) {
    this.id = `duplex-${randomUUID().replace(/-/g, '')}`
    this.incarnation = 1
    this.generation = 1
    this.token = `tok-${randomUUID()}`
    this.seq = 0
    this.journal = []
    this.conn = conn
    this.vad = update.turn_detection?.type === 'server_vad'
    this.speech = false
    this.silentFrames = 0
    this.response = undefined
    this.responses = 0
    this.epoch = 1
    this.graceTimer = undefined
  }

  emit(event) {
    const stamped = { ...event, server_event_seq: ++this.seq }
    this.journal.push(stamped)
    if (this.journal.length > 2000) this.journal.shift()
    if (this.conn?.open) this.conn.send(stamped)
  }

  onAppend(message) {
    const pcm = Buffer.from(message.audio, 'base64')
    const speaking = rms(pcm) > 500
    if (speaking) {
      this.silentFrames = 0
      if (!this.speech) {
        this.speech = true
        this.emit({ type: 'input_audio_buffer.speech_started', audio_start_ms: message.audio_end_ms ?? 0 })
        if (this.vad && this.response && !this.response.cancelled) this.cancel('turn_detected')
      }
    } else if (this.speech) {
      this.silentFrames += 1
      if (this.silentFrames >= 3) {
        this.speech = false
        this.emit({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: message.audio_end_ms ?? 0 })
        // vLLM-Omni serving.py _session_auto_responds: without extra_body.auto_response the server waits for response.create.
        if (!this.response && (this.autoResponds || this.vad)) void this.speak()
      }
    }
  }

  cancel(reason) {
    const r = this.response
    if (!r || r.cancelled) return false
    r.cancelled = true
    this.epoch += 1
    this.emit({ type: 'response.done', response: { id: r.id, status: 'cancelled', status_details: { reason } } })
    this.response = undefined
    return true
  }

  async speak() {
    const id = `resp-${this.id}-0-${randomUUID().slice(0, 8)}`
    const r = { id, cancelled: false }
    this.response = r
    this.responses += 1
    this.emit({ type: 'response.created', response: { id, status: 'in_progress' } })
    this.emit({ type: 'response.speak', response_id: id, metadata: { epoch: this.epoch, model_speak: true } })
    const words = ['The ', 'capital ', 'of ', 'France ', 'is ', 'Paris, ', 'a ', 'city.']
    for (let i = 0; i < words.length; i++) {
      await new Promise(res => setTimeout(res, 250))
      if (r.cancelled || !sessions.has(this.id)) return
      this.emit({ type: 'response.audio.delta', response_id: id, item_id: `item_${id}`, delta: tone(500, 300 + i * 40).toString('base64'), format: 'pcm16', sample_rate_hz: 24000, metadata: { epoch: this.epoch, audio_duration_ms: 500 } })
      this.emit({ type: 'response.audio_transcript.delta', response_id: id, delta: words[i] })
    }
    if (r.cancelled) return
    this.emit({ type: 'response.audio.done', response_id: id })
    this.emit({ type: 'response.done', response: { id, status: 'completed' } })
    this.emit({ type: 'rate_limits.updated' })
    this.response = undefined
  }

  detach() {
    this.conn = undefined
    clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => { if (this.response) this.response.cancelled = true; sessions.delete(this.id) }, GRACE_MS)
  }
}

const server = await wsServer((conn) => {
  let session
  let closedByClient = false
  conn.onClose(() => { if (session && !closedByClient && session.conn === conn) session.detach() })
  conn.onMessage(async (message) => {
    switch (message.type) {
      case 'session.update': {
        if (message.session?.turn_detection?.type === 'server_vad' && (message.session?.overlap_policy ?? 'listen_only') === 'listen_only') {
          // nightly 58adeec behavior observed in I2 02:21
          conn.send({ type: 'error', error: "overlap_policy='listen_only' conflicts with turn_detection; expected 'barge_in_on_speech'", code: 'invalid_session' })
          return
        }
        if (!String(message.session?.ref_audio ?? '').startsWith('data:audio/wav;base64,')) {
          conn.send({ type: 'error', error: 'MiniCPM-o native duplex audio output requires ref_audio', code: 'ref_audio_required' })
          return
        }
        session = new MockSession(conn, message.session)
        const extra = message.session?.extra_body ?? {}
        // protocol.py native_duplex_opt_in: native mode is a session.update extra_body opt-in, not a URL flag.
        session.native = extra.native_duplex === true || extra.minicpmo45_native_duplex === true
        session.autoResponds = extra.auto_response === true || extra.full_duplex === true
        sessions.set(session.id, session)
        const caps = session.native ? CAPS : { ...CAPS, implementation_level: 'serving_session_adapter', supports_session_resume: false }
        session.emit({ type: 'session.created', incarnation: session.incarnation, attachment_generation: session.generation, resume_token: session.token, session: { id: session.id, model: message.session.model, turn_detection: message.session.turn_detection ?? null, capabilities: caps } })
        return
      }
      case 'session.resume': {
        const target = sessions.get(message.session_id)
        if (!target) { conn.send({ type: 'error', error: `Unknown or expired duplex session: ${message.session_id}`, code: 'session_resume_expired' }); return }
        if (!Number.isInteger(message.incarnation) || !Number.isInteger(message.last_received_server_event_seq)) { conn.send({ type: 'error', error: 'session.resume requires session_id, incarnation, resume_token, and a non-negative event sequence', code: 'invalid_session_resume' }); return }
        if (message.resume_token !== target.token) { conn.send({ type: 'error', error: 'Invalid duplex session resume token', code: 'invalid_resume_token' }); return }
        if (RESUME_DELAY_MS > 0) await new Promise(res => setTimeout(res, RESUME_DELAY_MS))
        clearTimeout(target.graceTimer)
        target.generation += 1
        target.token = `tok-${randomUUID()}`
        target.conn = conn
        session = target
        conn.send({ type: 'session.resumed', session_id: target.id, incarnation: target.incarnation, attachment_generation: target.generation, resume_token: target.token })
        for (const entry of target.journal.filter(e => e.server_event_seq > message.last_received_server_event_seq)) conn.send(entry)
        return
      }
      case 'input_audio_buffer.append': session?.onAppend(message); return
      case 'input_audio_buffer.commit': session?.emit({ type: 'input_audio_buffer.committed' }); return
      case 'response.create': if (session && !session.response) void session.speak(); return
      case 'barge_in':
        if (!session?.cancel('barge_in')) conn.send({ type: 'error', error: 'duplex fence is stale', code: 'stale_fence' })
        return
      case 'playback.ack': session?.emit({ type: 'playback.acknowledged', response_id: message.response_id, played_ms: message.played_ms, committed_ms: message.committed_ms }); return
      case 'session.close':
        closedByClient = true
        if (session) { session.emit({ type: 'session.closed' }); sessions.delete(session.id) }
        return
      default:
        conn.send({ type: 'error', error: `Unknown duplex event: ${message.type}`, code: 'unknown_event' })
    }
  })
})
// wsServer answers plain HTTP with 426; replace that listener with /v1/models + 404 for the runner's reachability check.
server.server.removeAllListeners('request')
server.server.on('request', (req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'openbmb/MiniCPM-o-4_5' }] })); return }
  res.writeHead(404); res.end()
})
if (port && server.port !== port) console.error(`note: requested port ${port} ignored; using ${server.port}`)
console.log(`MOCK_LISTENING ${server.baseURL}`)
