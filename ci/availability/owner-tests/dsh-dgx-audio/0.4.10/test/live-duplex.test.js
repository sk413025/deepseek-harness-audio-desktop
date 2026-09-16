// Live duplex over the host routes against a scripted WebSocket backend shaped like the DGX
// vLLM-Omni 0.28 MiniCPM-o 4.5 wire (SERVER_CONTRACT.md §2). Mock-transport evidence only.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { AudioHub } from '../src/audio-hub.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { resolveConfig } from '../src/config.js'
import { LiveSessionManager } from '../src/live.js'
import { createRouteHandlers } from '../src/routes.js'
import { resolveRecordingId } from '../src/recording.js'
import { LiveTurnRegistry } from '../src/live-turns.js'
import { DgxAudioAdapter } from '../src/adapter.js'
import { fileHandleText } from '@deepseek-ai/dsh-llm'
import { collect, fakeStore, scriptedServer } from './helpers/fixtures.js'
import { pcm16, sleep, tempDir, wav } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

const CAPS = {
  implementation_level: 'model_native_duplex', chunk_period_ms: 1000, supports_barge_in: true, supports_audio_truncate: true,
  supports_session_resume: true, supports_playback_ack: true, supports_input_append: true, supports_client_commit: true, input_modes: ['append_audio_chunk'],
}

/**
 * Scripted backend. Options: nightly (GA event names), requireRef, speakAfterAppends, chunks, chunkMs.
 */
function scriptedBackend(options = {}) {
  const state = { seq: 0, sessions: [], resumes: [], appends: 0, responseCount: 0, active: undefined, log: [] }
  const audioType = options.nightly ? 'response.output_audio.delta' : 'response.audio.delta'
  const transcriptType = options.nightly ? 'response.output_audio_transcript.delta' : 'response.audio_transcript.delta'
  const history = []
  const emit = (conn, event) => {
    const stamped = { ...event, server_event_seq: ++state.seq }
    history.push(stamped)
    conn.send(stamped)
  }
  async function speak(conn, responseId, { cancelOnBargeIn = false } = {}) {
    state.active = { id: responseId, cancelled: false }
    emit(conn, { type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
    emit(conn, { type: 'response.created', response: { id: responseId, status: 'in_progress' } })
    emit(conn, { type: 'response.speak', response_id: responseId, metadata: { epoch: 1, model_speak: true } })
    for (let i = 0; i < (options.chunks ?? 3); i++) {
      if (state.active.cancelled || !conn.open) break
      emit(conn, { type: audioType, response_id: responseId, item_id: `item_${responseId}`, delta: pcm16((options.chunkMs ?? 100) / 1000, 24000, 300 + i * 100).toString('base64'), format: 'pcm16', sample_rate_hz: 24000, metadata: { epoch: 1, audio_duration_ms: options.chunkMs ?? 100 } })
      emit(conn, { type: transcriptType, response_id: responseId, delta: `word${i} ` })
      await sleep(options.gapMs ?? 100)
    }
    if (state.active.cancelled) {
      emit(conn, { type: 'response.done', response: { id: responseId, status: 'cancelled', status_details: { reason: 'client_force_barge_in' } } })
    } else if (!cancelOnBargeIn) {
      emit(conn, { type: 'response.audio.done', response_id: responseId })
      emit(conn, { type: 'response.done', response: { id: responseId, status: 'completed' } })
    }
    state.active = undefined
  }
  const serverPromise = wsServer((conn) => {
    state.sessions.push({ url: conn.url })
    conn.onMessage(async (message) => {
      state.log.push(message.type)
      switch (message.type) {
        case 'session.update':
          if (options.requireRef && !String(message.session?.ref_audio ?? '').startsWith('data:audio/wav;base64,')) {
            emit(conn, { type: 'error', error: { code: 'ref_audio_required', message: 'ref_audio is required' } })
            return
          }
          state.sessionUpdate = message.session
          emit(conn, { type: 'session.created', incarnation: 1, attachment_generation: 1, resume_token: 'tok-1', session: { id: 'srv_sess_42', capabilities: CAPS, model: message.session.model } })
          break
        case 'session.resume':
          state.resumes.push(message)
          if (options.holdResumeMs) await sleep(options.holdResumeMs)
          if (options.resync) { conn.send({ type: 'session.resync_required', session_id: message.session_id, reason: 'journal_gap' }); return }
          if (state.resumes.length <= (options.resumeConflicts ?? 0)) { conn.send({ type: 'error', error: 'attachment still held', code: 'session_resume_conflict' }); return }
          if (message.session_id !== 'srv_sess_42' || !String(message.resume_token).startsWith('tok-') || !Number.isInteger(message.incarnation)) {
            emit(conn, { type: 'error', error: { code: 'session_resume_expired' } })
            return
          }
          conn.send({ type: 'session.resumed', incarnation: 2, resume_token: 'tok-2', server_event_seq: ++state.seq })
          // Replay the two events before the client's cursor (duplicates) and one genuinely new event.
          for (const old of history.filter(e => e.server_event_seq <= message.last_received_server_event_seq).slice(-2)) conn.send(old)
          emit(conn, { type: 'rate_limits.updated' })
          break
        case 'input_audio_buffer.append':
          state.appends += 1
          if (state.appends === (options.speakAfterAppends ?? 3)) void speak(conn, `resp_${++state.responseCount}`)
          break
        case 'barge_in':
          if (state.active) state.active.cancelled = true
          break
        case 'playback.ack':
          emit(conn, { type: 'playback.acknowledged', response_id: message.response_id, played_ms: message.played_ms, committed_ms: message.committed_ms })
          break
        case 'session.close':
          emit(conn, { type: 'session.closed' })
          break
        default:
          break
      }
    })
  })
  return { state, serverPromise, speak }
}

async function setup(backend, modelExtra = {}, liveConfig = {}, extraDeps = {}) {
  const server = await backend.serverPromise
  const outDir = await tempDir('dgx-live-')
  const refPath = join(outDir, 'voice ref 參考.wav')
  await writeFile(refPath, wav(0.2, 16000))
  const config = resolveConfig({
    outputDir: outDir,
    live: { idleTimeoutMs: 5000, ...liveConfig },
    routes: [{ provider: 'lab', displayName: 'Lab', baseURL: server.baseURL, models: [{ id: 'duplex', mode: 'realtime', upstreamModel: 'openbmb/MiniCPM-o-4_5', realtime: { refAudioFile: refPath, query: { minicpmo45_native_duplex: '1' }, sessionIdPrefix: 'mac-streaming-' }, ...modelExtra }] }],
  })
  const hub = new AudioHub({ outputDir: () => config.outputDir, limits: { pingMs: 60_000 } })
  const capabilities = new CapabilityRegistry()
  const live = new LiveSessionManager({ config: () => config, hub, capabilities, log: () => {}, ...extraDeps })
  const routes = createRouteHandlers({ config: () => config, hub, capabilities, live, log: () => {} })
  const call = async (path, init) => {
    const route = routes.find(r => r.path === path.split('?')[0])
    const response = await route.fetch(new Request(`http://127.0.0.1:3080${path}`, init))
    return { status: response.status, body: await response.json() }
  }
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
  const append = (liveId, seq, pcm) => call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm })
  const events = []
  const controller = new AbortController()
  const feedDone = (async () => { for await (const e of hub.subscribe('conv-1', { signal: controller.signal })) events.push(e) })()
  const caps = () => capabilities.describe(config.routes[0], config.routes[0].models[0])
  let tornDown
  const teardown = () => (tornDown ??= (async () => { await live.closeAll('test'); controller.abort(); await feedDone; await server.close() })())
  return { server, config, hub, capabilities, live, call, post, append, events, caps, teardown }
}

test('duplex session: handshake is only advertised; overlapping input+output verifies duplex; recordings are coherent', async (tc) => {
  const backend = scriptedBackend({ requireRef: true, chunks: 4 })
  const t = await setup(backend)
  tc.after(() => t.teardown())
  const opened = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  const { liveId } = opened.body
  assert.deepEqual({ ...opened.body.input, wireEncoding: undefined }, { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000, wireEncoding: undefined })
  assert.equal(opened.body.input.wireEncoding, 'pcm16')
  assert.equal(opened.body.task, 'duplex')
  // Wire shape follows SERVER_CONTRACT.md §2.
  const url = backend.state.sessions[0].url
  assert.equal(url.pathname, '/v1/realtime')
  assert.equal(url.searchParams.get('duplex'), '1')
  assert.equal(url.searchParams.get('autostart'), '0')
  assert.equal(url.searchParams.get('model'), 'openbmb/MiniCPM-o-4_5')
  assert.equal(url.searchParams.get('minicpmo45_native_duplex'), '1')
  assert.match(url.searchParams.get('session_id'), /^mac-streaming-/)
  assert.equal(backend.state.sessionUpdate.input_audio_format, 'pcm16')
  assert.equal(backend.state.sessionUpdate.overlap_policy, 'listen_only')
  assert.equal(backend.state.sessionUpdate.playback_commit_policy, 'ack_only')
  // After the handshake alone nothing is verified.
  assert.equal(t.caps().fullDuplex.state, 'advertised')
  assert.equal(t.caps().fullDuplex.implementationLevel, 'model_native_duplex')
  assert.equal(t.caps().liveInput.state, 'advertised')
  assert.equal(t.caps().sessionResume.state, 'advertised')

  const frames = []
  for (let seq = 0; seq < 12; seq++) {
    const pcm = pcm16(0.2, 16000, 200 + seq * 10)
    frames.push(pcm)
    const r = await t.append(liveId, seq, pcm)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.seq, seq)
    await sleep(25)
  }
  await sleep(150)
  const accepted = t.events.filter(e => e.type === 'live.input.accepted')
  assert.deepEqual(accepted.map(e => e.seq), Array.from({ length: 12 }, (_, i) => i))
  const firstAudio = t.events.findIndex(e => e.type === 'audio.chunk')
  const acceptedAfterAudio = t.events.slice(firstAudio).filter(e => e.type === 'live.input.accepted').length
  assert.ok(acceptedAfterAudio > 0, 'input frames kept flowing while response audio arrived')
  assert.equal(t.caps().liveInput.state, 'verified')
  assert.equal(t.caps().fullDuplex.state, 'verified')
  assert.match(t.caps().fullDuplex.detail, /input frames forwarded while 4 response audio chunks/)
  const text = t.events.filter(e => e.type === 'text.delta').map(e => e.text).join('')
  assert.equal(text, 'word0 word1 word2 word3 ')
  const end = t.events.find(e => e.type === 'audio.end')
  assert.equal(end.streamId, 'resp_1')
  assert.equal(end.delivery, 'progressive')

  const ack = await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'playback-ack', responseId: 'resp_1', playedMs: 400 })
  assert.equal(ack.status, 200)
  await sleep(50)
  assert.equal(t.caps().playbackAck.state, 'verified')
  assert.equal(t.caps().bargeIn.state, 'advertised', 'barge-in not exercised → not verified')
  assert.equal(t.caps().sessionResume.state, 'advertised', 'resume not exercised → not verified')

  const closed = await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})
  assert.equal(closed.status, 200)
  assert.ok(backend.state.log.includes('session.close'))
  const inputPath = resolveRecordingId(t.config.outputDir, closed.body.input.recordingId)
  const inputWav = await readFile(inputPath)
  assert.equal(inputWav.subarray(44).equals(Buffer.concat(frames)), true, 'captured input recording is byte-identical to the forwarded frames')
  assert.equal(closed.body.responses[0].status, 'completed')
  assert.equal(closed.body.responses[0].transcript, 'word0 word1 word2 word3 ')
  assert.equal(closed.body.responses[0].recording.durationSeconds, 0.4)
  assert.ok(closed.body.responses[0].inputFramesDuringOutput > 0)
  assert.equal((await t.append(liveId, 12, frames[0])).status, 410)
  await t.teardown()
})

test('barge-in control cancels the active response and only then verifies bargeIn', async (tc) => {
  const backend = scriptedBackend({ chunks: 20, speakAfterAppends: 1 })
  const t = await setup(backend)
  tc.after(() => t.teardown())
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex', overlapPolicy: 'barge_in_on_speech' })).body
  assert.equal(backend.state.sessionUpdate.overlap_policy, 'barge_in_on_speech')
  await t.append(liveId, 0, pcm16(0.2))
  await sleep(120)
  assert.equal(t.caps().bargeIn.state, 'advertised')
  await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'barge-in' })
  await sleep(150)
  const response = t.events.find(e => e.type === 'live.response' && e.status === 'cancelled')
  assert.equal(response.reason, 'client_force_barge_in')
  const end = t.events.find(e => e.type === 'audio.end')
  assert.equal(end.status, 'cancelled')
  assert.ok(end.chunks < 20)
  assert.equal(t.caps().bargeIn.state, 'verified')
  assert.equal(t.caps().fullDuplex.state, 'advertised', 'one frame before output is not duplex overlap evidence')
  await t.teardown()
})

test('frame validation, ordering, backpressure and idle timeout', async (tc) => {
  const backend = scriptedBackend({ speakAfterAppends: 999 })
  const t = await setup(backend, {}, { idleTimeoutMs: 300, maxFrameBytes: 6400 })
  tc.after(() => t.teardown())
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })).body
  assert.equal((await t.append(liveId, 1, pcm16(0.1))).body.error.code, 'SEQ_OUT_OF_ORDER')
  assert.equal((await t.append(liveId, 0, Buffer.alloc(7))).status, 400)
  assert.equal((await t.append(liveId, 0, pcm16(0.5))).body.error.code, 'PAYLOAD_TOO_LARGE')
  assert.equal((await t.append(liveId, 0, pcm16(0.1))).status, 200)
  const session = t.live.get(liveId)
  let queued = 10 * 1024 * 1024
  Object.defineProperty(session.client, 'bufferedAmount', { get: () => queued, configurable: true })
  const full = await t.append(liveId, 1, pcm16(0.1))
  assert.equal(full.status, 429)
  assert.equal(full.body.error.code, 'BUFFER_FULL')
  queued = 0
  assert.equal((await t.append(liveId, 1, pcm16(0.1))).status, 200, 'the same seq is retried after backpressure clears')
  assert.equal((await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'nope' })).status, 400)
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/live/control?liveId=missing', { type: 'commit' })).status, 404)
  await sleep(450)
  const closed = t.events.find(e => e.type === 'live.state' && e.state === 'closed')
  assert.equal(closed.error.code, 'IDLE_TIMEOUT')
  assert.ok(backend.state.log.includes('session.close'))
  // Non-realtime models refuse live mode.
  const chatOnly = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'nope' })
  assert.equal(chatOnly.status, 404)
  await t.teardown()
})

test('missing ref_audio is a backend rejection with cleanup, not a hang', async (tc) => {
  const backend = scriptedBackend({ requireRef: true })
  const t = await setup(backend, { realtime: { refAudioFile: undefined, query: { minicpmo45_native_duplex: '1' } } })
  tc.after(() => t.teardown())
  const opened = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })
  assert.equal(opened.status, 502)
  assert.equal(opened.body.error.code, 'BACKEND_REJECTED')
  assert.match(opened.body.error.message, /ref_audio/)
  assert.equal([...t.live.sessions.values()].every(s => s.state === 'closed'), true)
  await t.teardown()
})

test('socket loss resumes with the server-issued session id, drops replayed events; nightly event names accepted', async (tc) => {
  const backend = scriptedBackend({ nightly: true, chunks: 2, speakAfterAppends: 2 })
  const t = await setup(backend)
  tc.after(() => t.teardown())
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })).body
  await t.append(liveId, 0, pcm16(0.2))
  await t.append(liveId, 1, pcm16(0.2))
  await t.append(liveId, 2, pcm16(0.2))
  for (let i = 0; i < 40 && !t.events.some(e => e.type === 'live.response' && e.status === 'completed'); i++) await sleep(50)
  await sleep(100)
  assert.equal(t.events.filter(e => e.type === 'audio.chunk').length, 2, 'response.output_audio.delta handled')
  assert.equal(t.events.filter(e => e.type === 'text.delta').length, 2, 'response.output_audio_transcript.delta handled')
  const session = t.live.get(liveId)
  const lastSeqBeforeDrop = session.client.lastSeq
  t.server.connections[0].destroy()
  await sleep(300)
  assert.equal(backend.state.resumes.length, 1)
  const resume = backend.state.resumes[0]
  assert.equal(resume.session_id, 'srv_sess_42', 'resume must use session.created.session.id, not the client-requested session_id')
  assert.equal(resume.resume_token, 'tok-1')
  assert.equal(resume.last_received_server_event_seq, lastSeqBeforeDrop)
  assert.equal(session.client.duplicateEvents, 2)
  assert.equal(session.client.server.resumeToken, 'tok-2')
  assert.equal(t.caps().sessionResume.state, 'verified')
  assert.ok(t.events.some(e => e.type === 'live.state' && e.resumed === true))
  assert.equal(t.events.filter(e => e.type === 'audio.chunk').length, 2, 'replayed audio is not published twice')
  assert.equal((await t.append(liveId, 3, pcm16(0.2))).status, 200)
  await t.teardown()
})

test('live provenance: close stages the captured input as a prompt receipt; the prompt replays the live answer without a second model call', async (tc) => {
  const backend = scriptedBackend({ chunks: 2, speakAfterAppends: 2 })
  const turns = new LiveTurnRegistry()
  const staged = []
  const fileUploads = {
    async uploadStream({ sessionId, data, name }) {
      const chunks = []
      for await (const c of data) chunks.push(c)
      const bytes = Buffer.concat(chunks)
      staged.push({ sessionId, name, bytes })
      const { createHash } = await import('node:crypto')
      return { receiptId: `rcpt-${staged.length}`, file: { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name, bytes: bytes.length } }
    },
  }
  const t = await setup(backend, {}, {}, { turns, fileUploads: () => fileUploads })
  tc.after(() => t.teardown())
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })).body
  for (let seq = 0; seq < 6; seq++) { await t.append(liveId, seq, pcm16(0.2, 16000, 300 + seq)); await sleep(60) }
  await sleep(400)
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  assert.equal(closed.input.receiptId, 'rcpt-1')
  assert.equal(closed.input.attachmentId, `sha256:${closed.input.sha256}`)
  assert.equal(staged[0].sessionId, 'conv-1')
  assert.match(staged[0].name, /\.wav$/)
  const inputBytes = await readFile(resolveRecordingId(t.config.outputDir, closed.input.recordingId))
  assert.equal(staged[0].bytes.equals(inputBytes), true, 'staged upload is byte-identical to the live input recording')

  // The UI now sends that file as a prompt to a chat model on the same adapter.
  const chat = await scriptedServer(async (req, res) => { res.writeHead(500); res.end('must not be called') })
  tc.after(() => chat.close())
  const config = { ...t.config, routes: [{ provider: 'lab-chat', displayName: 'Chat', baseURL: chat.url, models: [{ id: 'chat', mode: 'chat', maxAudioPerRequest: 5, contextWindow: 8192, streaming: { text: 'auto' }, capabilities: {} }] }] }
  const fx = await fakeStore(inputBytes, 'live-input.wav')
  const adapter = new DgxAudioAdapter({ config: () => config, attachments: () => fx.store, log: () => {}, hub: () => t.hub, capabilities: t.capabilities, turns })
  const request = { provider: 'lab-chat', model: 'chat', sessionId: 'conv-1', messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }] }] }
  const chunks = await collect(adapter.stream(request))
  assert.equal(chat.calls.length, 0, 'no second model call for an already-answered live turn')
  const text = chunks.find(c => c.type === 'block-end').block.text
  assert.match(text, /^word0 word1/)
  assert.match(text, /live duplex exchange `lab\/duplex`/)
  assert.match(text, /\]\(\/api\/dsh-dgx-audio\/v1\/recording\?id=r1\./)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  const log = (await readFile(t.config.invocationLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.equal(log.transport, 'live-replay')
  assert.equal(log.inputAudio[0].sha256, closed.input.sha256)
  // Bound once: a later request with the same audio is an ordinary model call.
  await assert.rejects(collect(adapter.stream(request)), e => e.code === 'SERVER')
  assert.equal(chat.calls.length, 1)
})

test('0.3.1: client-side abrupt socket close resumes; frames during reconnect get a retryable 503; resume conflict is retried', async (tc) => {
  const backend = scriptedBackend({ speakAfterAppends: 999, resumeConflicts: 1, holdResumeMs: 150 })
  const t = await setup(backend)
  tc.after(() => t.teardown())
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })).body
  assert.equal((await t.append(liveId, 0, pcm16(0.2))).status, 200)
  const session = t.live.get(liveId)
  session.client.socket.close(4000, 'simulated network drop') // no session.close: a resumable detach on the server
  await sleep(60)
  const during = await t.append(liveId, 1, pcm16(0.2))
  assert.equal(during.status, 503)
  assert.equal(during.body.error.code, 'RECONNECTING')
  assert.equal((await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'commit' })).body.error.code, 'RECONNECTING')
  for (let i = 0; i < 60 && !t.events.some(e => e.type === 'live.state' && e.resumed); i++) await sleep(50)
  assert.ok(t.events.some(e => e.type === 'live.state' && e.state === 'reconnecting'))
  const conflict = t.events.find(e => e.type === 'live.error' && e.code === 'session_resume_conflict')
  assert.equal(conflict.fatal, false)
  assert.equal(backend.state.resumes.length, 2, 'one conflict, one successful retry')
  assert.equal(t.events.find(e => e.type === 'live.state' && e.resumed).attempts, 2)
  assert.equal(t.caps().sessionResume.state, 'verified')
  assert.equal((await t.append(liveId, 1, pcm16(0.2))).status, 200, 'the same seq succeeds after resume')
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  assert.equal(closed.socketLosses, 1)
  assert.equal(closed.resume.attempts, 2)
})

test('0.3.1: session.resync_required ends the live session with RESYNC_REQUIRED instead of retrying or hanging', async (tc) => {
  const backend = scriptedBackend({ speakAfterAppends: 999, resync: true })
  const t = await setup(backend)
  tc.after(() => t.teardown())
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv-1', provider: 'lab', model: 'duplex' })).body
  await t.append(liveId, 0, pcm16(0.2))
  t.server.connections[0].destroy()
  for (let i = 0; i < 40 && !t.events.some(e => e.type === 'live.state' && e.state === 'closed'); i++) await sleep(50)
  const closed = t.events.find(e => e.type === 'live.state' && e.state === 'closed')
  assert.equal(closed.error.code, 'RESYNC_REQUIRED')
  assert.equal(backend.state.resumes.length, 1, 'resync is not retried')
  assert.notEqual(t.caps().sessionResume.state, 'verified')
  assert.equal((await t.append(liveId, 1, pcm16(0.2))).status, 410)
})
