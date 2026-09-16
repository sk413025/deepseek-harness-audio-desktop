// 0.4.7: verifiable resume path (test-only transport drop, §K.12) and fail-fast refusal records.
// Mock transport only: a journaled server session that keeps generating while detached, replays missed events plus
// duplicates on resume, and rejects stale/invalid tokens. Error codes in this backend are MOCK codes, not server facts.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileHandleText } from '@deepseek-ai/dsh-llm'

import { createAudioPlugin } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { collect, fakeStore, pcm16, sleep, tempDir } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

const CAPS = { implementation_level: 'model_native_duplex', supports_barge_in: true, supports_playback_ack: true, supports_session_resume: true, supports_input_append: true }

/** One server session across sockets. Options: graceMs, audioChunks, chunkGapMs, speakAfterAppends, holdResumeMs. */
function journaledBackend(options = {}) {
  const state = { seq: 0, journal: [], token: 'tok-1', incarnation: 1, attached: undefined, expired: false, graceTimer: undefined, connections: 0, resumes: [], appends: [], acks: [], audioGenerated: 0, closedByClient: false }
  const emit = (event) => {
    const stamped = { ...event, server_event_seq: ++state.seq }
    state.journal.push(stamped)
    if (state.attached?.open) state.attached.send(stamped)
  }
  async function speak(id) {
    emit({ type: 'response.created', response: { id, status: 'in_progress' } })
    for (let i = 0; i < (options.audioChunks ?? 6); i++) {
      emit({ type: 'response.audio.delta', response_id: id, delta: pcm16(0.1, 24000, 300 + i * 50).toString('base64'), sample_rate_hz: 24000 })
      state.audioGenerated += 1
      await sleep(options.chunkGapMs ?? 60) // generation continues while the client is detached
    }
    emit({ type: 'response.done', response: { id, status: 'completed' } })
    // A stale tail: audio for a response that is already done, with a fresh sequence number (must never be played).
    if (options.staleTail) emit({ type: 'response.audio.delta', response_id: id, delta: pcm16(0.1, 24000, 900).toString('base64'), sample_rate_hz: 24000 })
  }
  const detach = (conn) => {
    if (state.attached !== conn || state.closedByClient) return
    state.attached = undefined
    clearTimeout(state.graceTimer)
    state.graceTimer = setTimeout(() => { state.expired = true }, options.graceMs ?? 2000)
  }
  const serverPromise = wsServer((conn) => {
    state.connections += 1
    conn.onClose(() => detach(conn))
    conn.onMessage(async (message) => {
      switch (message.type) {
        case 'session.update':
          state.attached = conn
          conn.send({ type: 'session.created', incarnation: 1, resume_token: state.token, session: { id: 'srv_sess_7', capabilities: CAPS } })
          break
        case 'session.resume': {
          state.resumes.push({ ...message, url: conn.url.search })
          if (options.holdResumeMs) await sleep(options.holdResumeMs)
          if (state.expired) { conn.send({ type: 'error', error: { code: 'session_resume_expired', message: 'mock: grace elapsed' } }); return }
          if (message.session_id !== 'srv_sess_7' || message.resume_token !== state.token || message.incarnation !== state.incarnation) { conn.send({ type: 'error', error: { code: 'invalid_resume_token', message: 'mock: token mismatch' } }); return }
          clearTimeout(state.graceTimer)
          state.token = 'tok-2'
          state.incarnation = 2
          state.attached = conn
          conn.send({ type: 'session.resumed', incarnation: 2, resume_token: 'tok-2' })
          const cursor = message.last_received_server_event_seq
          for (const old of state.journal.filter(e => e.server_event_seq <= cursor).slice(-2)) conn.send(old) // duplicates
          const missed = state.journal.filter(e => e.server_event_seq > cursor)
          state.missedAudioReplayed = missed.filter(e => e.type === 'response.audio.delta').length
          for (const event of missed) conn.send(event) // missed while detached
          break
        }
        case 'input_audio_buffer.append':
          state.appends.push(message.audio_end_ms)
          if (state.appends.length === (options.speakAfterAppends ?? 2)) void speak('resp_1')
          break
        case 'playback.ack':
          state.acks.push(message)
          emit({ type: 'playback.acknowledged', response_id: message.response_id, played_ms: message.played_ms, committed_ms: message.committed_ms })
          break
        case 'session.close':
          state.closedByClient = true
          conn.send({ type: 'session.closed' })
          break
        default:
          break
      }
    })
  })
  return { state, serverPromise }
}

async function plugin(t, backend, extra = {}) {
  const server = await backend.serverPromise
  t.after(() => server.close())
  const outputDir = await tempDir('dgx-047-')
  const rowConfig = {
    outputDir, hubLimits: { pingMs: 60_000 }, live: { idleTimeoutMs: 5000, ...extra.live }, ...(extra.testFaults ? { testFaults: extra.testFaults } : {}),
    routes: [{ provider: 'dgx', displayName: 'DGX', baseURL: server.baseURL, models: [{ id: 'duplex', mode: 'realtime', upstreamModel: 'openbmb/MiniCPM-o-4_5', deploymentId: 'mock-deploy-7', catalogTasks: ['full_duplex_dialogue'], realtime: { query: { native_duplex: '1' } } }, ...(extra.models ?? [])] }],
  }
  const p = createAudioPlugin({ rowConfig, log: () => {}, ...extra.plugin })
  await p.ready
  t.after(async () => { await p.live.closeAll('test'); p.dispose() })
  const events = []
  const ac = new AbortController()
  void (async () => { try { for await (const e of p.hub.subscribe('s-047', { signal: ac.signal })) events.push(e) } catch { /* aborted */ } })()
  t.after(() => ac.abort())
  const call = async (path, body, init) => {
    const route = p.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://h${path}`, init ?? { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: res.status, body: await res.json() }
  }
  const append = (liveId, seq) => call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, undefined, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  const until = async (predicate, label, ms = 4000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (predicate()) return; await sleep(25) }
    assert.fail(`timed out waiting for ${label}`)
  }
  return { p, server, events, call, append, until, outputDir }
}

test('transport drop mid-response → one resume with the server token; missed audio published once, replayed duplicates and stale audio dropped; no input or control resent', async (t) => {
  const backend = journaledBackend({ holdResumeMs: 150, staleTail: true })
  const h = await plugin(t, backend, { testFaults: { transportDrop: { trigger: 'after-first-audio', afterMs: 90, closeCode: 4001 } } })
  const doc = (await h.call('/api/dsh-dgx-audio/v1/capabilities')).body
  assert.deepEqual(doc.testFaults.transportDrop, { occurrence: 1, trigger: 'after-first-audio', afterMs: 90, closeCode: 4001, resume: 'normal' }, 'test configuration is visible')
  const { liveId } = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body
  assert.equal((await h.append(liveId, 0)).status, 200)
  assert.equal((await h.append(liveId, 1)).status, 200)
  await h.until(() => h.events.some(e => e.type === 'live.state' && e.state === 'reconnecting'), 'reconnecting')
  const during = await h.append(liveId, 2)
  assert.deepEqual([during.status, during.body.error.code], [503, 'RECONNECTING'], 'input during reconnect is refused, not buffered for a later resend')
  await h.until(() => h.events.some(e => e.type === 'live.state' && e.resumed === true), 'resumed')
  assert.equal((await h.append(liveId, 2)).status, 200, 'the same seq is accepted once after resume')
  await h.until(() => h.events.some(e => e.type === 'live.response' && e.status === 'completed'), 'response completed')
  const ack = (await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'playback-ack', responseId: 'resp_1', playedMs: 600 })).body
  assert.equal(ack.sent, true)
  await sleep(100)
  const closed = (await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body

  const order = ['live.test.fault', 'reconnecting', 'resumed'].map(kind => h.events.findIndex(e => e.liveId === liveId && (kind === 'live.test.fault' ? e.type === kind : kind === 'reconnecting' ? e.state === 'reconnecting' : e.resumed === true)))
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], `feed order ${order}`)
  const fault = closed.faultInjections[0]
  assert.deepEqual([closed.faultInjections.length, fault.kind, fault.outcome, fault.trigger, fault.closeCode, fault.activeResponseIds], [1, 'transport-drop', 'dropped', 'after-first-audio', 4001, ['resp_1']])
  assert.equal(backend.state.resumes.length, 1)
  assert.deepEqual([backend.state.resumes[0].session_id, backend.state.resumes[0].resume_token, backend.state.resumes[0].last_received_server_event_seq], ['srv_sess_7', 'tok-1', fault.lastServerEventSeq])
  assert.match(backend.state.resumes[0].url, /resume=1/)
  assert.deepEqual(closed.resumeAttempts.map(a => [a.attempt, a.outcome, a.tokenMode, a.testFault]), [[1, 'resumed', 'server-issued', 'transport-drop']])
  assert.equal(closed.socketLosses, 1)
  // No stale or duplicate audio: every generated delta reached the feed exactly once, including the ones missed while detached;
  // the stale tail after response.done (fresh seq) is not published.
  const response = closed.responses.find(r => r.responseId === 'resp_1')
  assert.ok(backend.state.missedAudioReplayed >= 1, 'some audio was generated while detached and delivered after resume')
  assert.equal(response.audioChunks, backend.state.audioGenerated)
  assert.equal(h.events.filter(e => e.type === 'audio.chunk').length, backend.state.audioGenerated)
  assert.ok(closed.stats.duplicateEvents >= 2, 'replayed duplicates were dropped by server_event_seq')
  assert.ok(Math.abs(response.recording.durationSeconds - backend.state.audioGenerated * 0.1) < 0.011, 'recording holds each delta once')
  // No resend: the server saw each accepted frame and the ack exactly once.
  assert.deepEqual([backend.state.appends.length, new Set(backend.state.appends).size, closed.inputIntegrity.framesForwarded], [3, 3, 3])
  assert.equal(backend.state.acks.length, 1)
  assert.ok(closed.observations.some(o => o.key === 'sessionResume' && o.state === 'verified'), 'per-connection resume observation')
  // One liveId only: the next session of the same model is not dropped.
  const second = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body.liveId
  await sleep(250)
  const secondClosed = (await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${second}`, {})).body
  assert.deepEqual([secondClosed.faultInjections, secondClosed.socketLosses], [[], 0])
})

test('negative: invalid resume token is rejected once, the session closes with the backend code, nothing is published after the drop', async (t) => {
  const backend = journaledBackend({ speakAfterAppends: 99 })
  const h = await plugin(t, backend, { testFaults: { transportDrop: { afterMs: 60, resume: 'invalid-token' } } })
  const { liveId } = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body
  await h.append(liveId, 0)
  await h.until(() => h.events.some(e => e.liveId === liveId && e.type === 'live.state' && e.state === 'closed'), 'closed')
  const closedEvent = h.events.find(e => e.liveId === liveId && e.type === 'live.state' && e.state === 'closed')
  assert.deepEqual([closedEvent.error.code, closedEvent.error.backendCode], ['RESUME_REJECTED', 'invalid_resume_token'])
  assert.deepEqual(backend.state.resumes.map(r => r.resume_token), ['tok-1.dsh-test-invalid'], 'one attempt, no retry of a non-retryable rejection')
  assert.equal((await h.append(liveId, 1)).status, 410)
  const closed = h.p.live.get(liveId).result
  assert.deepEqual(closed.resumeAttempts.map(a => [a.outcome, a.backendCode, a.retryable, a.tokenMode]), [['rejected', 'invalid_resume_token', false, 'invalid-test']])
  assert.equal(closed.observations.some(o => o.key === 'sessionResume' && o.state === 'verified'), false)
  assert.equal(h.events.filter(e => e.type === 'audio.chunk').length, 0)
})

test('negative: resume after the server grace (resume: delay) is refused as expired; the idle timer does not end the session during the reconnect', async (t) => {
  const backend = journaledBackend({ speakAfterAppends: 99, graceMs: 150 })
  const h = await plugin(t, backend, { live: { idleTimeoutMs: 250 }, testFaults: { transportDrop: { afterMs: 30, resume: 'delay', resumeDelayMs: 450 } } })
  const { liveId } = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body
  await h.until(() => h.events.some(e => e.liveId === liveId && e.type === 'live.state' && e.state === 'closed'), 'closed', 3000)
  const closedEvent = h.events.find(e => e.liveId === liveId && e.type === 'live.state' && e.state === 'closed')
  assert.deepEqual([closedEvent.reason, closedEvent.error.code, closedEvent.error.backendCode], ['backend-lost', 'RESUME_REJECTED', 'session_resume_expired'], 'not IDLE_TIMEOUT')
  const closed = h.p.live.get(liveId).result
  assert.deepEqual(closed.resumeAttempts.map(a => [a.delayMs, a.outcome, a.backendCode]), [[450, 'rejected', 'session_resume_expired']])
  assert.equal(closed.faultInjections[0].resumeDelayMs, 450)
})

test('product default: no testFaults → no drop and nothing in the capability document; strict test configuration; not in the Settings form', async (t) => {
  const backend = journaledBackend({ audioChunks: 3 })
  const h = await plugin(t, backend)
  assert.equal('testFaults' in (await h.call('/api/dsh-dgx-audio/v1/capabilities')).body, false)
  const { liveId } = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body
  await h.append(liveId, 0)
  await h.append(liveId, 1)
  await h.until(() => h.events.some(e => e.type === 'live.response' && e.status === 'completed'), 'completed')
  const closed = (await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  assert.deepEqual([closed.faultInjections, closed.resumeAttempts, closed.socketLosses, backend.state.resumes.length], [[], [], 0, 0])

  const base = { routes: [] }
  const bad = (testFaults, pattern) => assert.throws(() => resolveConfig({ ...base, testFaults }), pattern)
  bad({ socketKill: {} }, /testFaults.socketKill is not a supported test fault/)
  bad({ transportDrop: { trigger: 'now' } }, /trigger must be/)
  bad({ transportDrop: { closeCode: 1000 } }, /closeCode must be an integer in \[4000, 4999\]/)
  bad({ transportDrop: { resumeDelayMs: 5 } }, /resumeDelayMs needs resume: delay/)
  bad({ transportDrop: { afterMs: -1 } }, /afterMs must be/)
  bad({ transportDrop: { liveId: 'x' } }, /transportDrop.liveId is not supported/)
  assert.equal(resolveConfig({ ...base, testFaults: {} }).testFaults, undefined, 'empty = off')
  assert.equal(resolveConfig({ ...base, testFaults: { transportDrop: { resume: 'delay' } } }).testFaults.transportDrop.resumeDelayMs, 35000)
  const { default: z } = await import('@deepseek-ai/schemastery')
  const { settingsSchema } = await import('../src/settings.js')
  const schema = settingsSchema(z)
  assert.equal(JSON.stringify(schema.toJSON()).includes('testFaults'), false, 'not a Settings form field')
  assert.deepEqual(schema({ routes: [], testFaults: { transportDrop: { afterMs: 5 } } }).testFaults, { transportDrop: { afterMs: 5 } }, 'settings.yaml value reaches the config')
})

test('fail-fast refusals are logged as refusal records (origin, status, zeroUpstream, provenance), never as completed invocations', async (t) => {
  const backend = journaledBackend()
  let upstream = 0
  const h = await plugin(t, backend, {
    models: [{ id: 'chat', mode: 'chat', upstreamModel: 'openbmb/MiniCPM-o-4_5', deploymentId: 'mock-deploy-7', catalogTasks: ['spoken_chat_text_reply'] }],
    plugin: { fetch: async () => { upstream += 1; throw new Error('must not be called') } },
  })
  h.p.service.setActivation('dgx', 'chat', { state: 'cold', detail: 'mock' })
  h.p.service.setActivation('dgx', 'duplex', { state: 'activating' })
  await assert.rejects(collect(h.p.adapter.stream({ provider: 'dgx', model: 'chat', sessionId: 's-047', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })), e => e.code === 'MODEL_NOT_READY')
  const open = await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })
  assert.deepEqual([open.status, open.body.error.code], [409, 'MODEL_NOT_READY'])
  const records = (await readFile(join(h.outputDir, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  assert.equal(records.length, 2)
  const [stream, live] = records
  for (const r of records) {
    assert.deepEqual([r.record, r.invocation, r.status, r.zeroUpstream, r.upstreamRequests, 'ok' in r, 'endpoint' in r, 'transport' in r], ['refusal', false, 'refused', true, 0, false, false, false])
    assert.deepEqual([r.code, r.deploymentId, r.liveId, r.sessionId], ['MODEL_NOT_READY', 'mock-deploy-7', null, 's-047'])
  }
  assert.deepEqual([stream.origin, stream.model, stream.catalogTasks, stream.catalogTasksSource, stream.activation], ['adapter.stream', 'chat', ['spoken_chat_text_reply'], 'config', { state: 'cold', detail: 'mock' }])
  assert.deepEqual([live.origin, live.model, live.httpStatus, live.catalogTasks, live.activation.state], ['live.open', 'duplex', 409, ['full_duplex_dialogue'], 'activating'])
  assert.deepEqual([upstream, backend.state.connections], [0, 0], 'zero upstream requests and zero sockets')
})

test('live replay results cite the live model provenance (liveId, catalogTasks, deploymentId), not the conversation model', async (t) => {
  const backend = journaledBackend({ audioChunks: 2 })
  const staged = []
  const fileUploads = {
    async uploadStream({ data, name }) {
      const chunks = []
      for await (const c of data) chunks.push(c)
      staged.push({ name, bytes: Buffer.concat(chunks) })
      return { receiptId: `rcpt-${staged.length}` }
    },
  }
  const holder = {}
  const h = await plugin(t, backend, {
    models: [{ id: 'chat', mode: 'chat', upstreamModel: 'other/Chat', deploymentId: 'chat-deploy', catalogTasks: ['spoken_chat_text_reply'] }],
    plugin: { fileUploads: () => fileUploads, attachments: () => holder.store },
  })
  const { liveId } = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body
  await h.append(liveId, 0)
  await h.append(liveId, 1)
  await h.until(() => h.events.some(e => e.type === 'live.response' && e.status === 'completed'), 'completed')
  const closed = (await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  const fx = await fakeStore(staged[0].bytes, staged[0].name)
  holder.store = fx.store
  await writeFile(join(h.outputDir, 'unused'), '')
  const chunks = await collect(h.p.adapter.stream({ provider: 'dgx', model: 'chat', sessionId: 's-047', messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }] }] }))
  assert.ok(chunks.some(c => c.type === 'finish'))
  const record = (await readFile(join(h.outputDir, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.deepEqual([record.record, record.transport, record.liveId, record.model], ['invocation', 'live-replay', liveId, 'chat'])
  assert.deepEqual(record.liveOrigin, { provider: 'dgx', model: 'duplex', upstreamModel: 'openbmb/MiniCPM-o-4_5', catalogTasks: ['full_duplex_dialogue'], catalogTasksSource: 'config', deploymentId: 'mock-deploy-7' })
  const link = chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n').match(/result\?id=(res_[A-Za-z0-9_-]+)/)
  const result = (await h.call(`/api/dsh-dgx-audio/v1/result?id=${link[1]}`)).body
  assert.deepEqual([result.origin, result.liveId, result.model, result.catalogTasks, result.deploymentId, result.upstreamModel], ['live-replay', liveId, 'duplex', ['full_duplex_dialogue'], 'mock-deploy-7', 'openbmb/MiniCPM-o-4_5'])
  assert.equal(closed.input.receiptId, 'rcpt-1')
})

test('a slow resume after a real network loss (no test hook) is not cut short by the idle timer', async (t) => {
  const backend = journaledBackend({ speakAfterAppends: 99, holdResumeMs: 400 })
  const h = await plugin(t, backend, { live: { idleTimeoutMs: 250 } })
  const { liveId } = (await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-047', provider: 'dgx', model: 'duplex' })).body
  await h.append(liveId, 0)
  h.server.connections[0].destroy() // server-side TCP loss without a close handshake
  await h.until(() => h.events.some(e => e.liveId === liveId && e.type === 'live.state' && (e.resumed === true || e.state === 'closed')), 'resumed or closed', 3000)
  assert.equal(h.events.some(e => e.liveId === liveId && e.type === 'live.state' && e.state === 'closed'), false, 'not IDLE_TIMEOUT during the reconnect')
  assert.equal((await h.append(liveId, 1)).status, 200)
  const closed = (await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  assert.deepEqual([closed.socketLosses, closed.resume.attempts, backend.state.resumes.length], [1, 1, 1])
})
