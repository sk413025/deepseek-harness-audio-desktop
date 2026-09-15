// 0.4.5: per-connection live evidence vs deployment-level capability history (release I4 run-045509 observation:
// `liveCapabilitiesAfter.bargeIn` of the catalog model carried the previous host-default session's checkedAt/response).
// Mock transport only.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAudioPlugin } from '../src/index.js'
import { pcm16, sleep, tempDir } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

/** Native duplex stand-in: speaks after 2 appends, cancels on barge_in, echoes playback.ack. */
function duplexServer() {
  let seq = 0
  return wsServer((conn) => {
    let appends = 0
    let active
    const emit = e => conn.send({ ...e, server_event_seq: ++seq })
    conn.onMessage(async (m) => {
      if (m.type === 'session.update') emit({ type: 'session.created', incarnation: 1, resume_token: 't', session: { id: `srv-${seq}`, capabilities: { implementation_level: 'model_native_duplex', supports_barge_in: true, supports_playback_ack: true, supports_session_resume: true, supports_input_append: true } } })
      if (m.type === 'input_audio_buffer.append') {
        appends += 1
        if (appends === 2 && active === undefined) {
          active = `resp-${seq}`
          emit({ type: 'response.created', response: { id: active, status: 'in_progress' } })
          for (let i = 0; i < 2; i++) emit({ type: 'response.audio.delta', response_id: active, delta: pcm16(0.1, 24000).toString('base64'), sample_rate_hz: 24000 })
        }
      }
      if (m.type === 'barge_in' && active !== undefined) { emit({ type: 'response.done', response: { id: active, status: 'cancelled', status_details: { reason: 'barge_in' } } }); active = undefined }
      if (m.type === 'playback.ack') emit({ type: 'playback.acknowledged', response_id: m.response_id, played_ms: m.played_ms, committed_ms: m.committed_ms })
    })
  })
}

test('I4: capability document = deployment history with observedBy; live/close observations + live.capability events = this connection only', async (tc) => {
  const server = await duplexServer()
  tc.after(() => server.close())
  const outputDir = await tempDir('dgx-045-')
  const models = [
    { id: 'minicpmo45-duplex', upstreamModel: 'openbmb/MiniCPM-o-4_5', mode: 'realtime', realtime: { query: { native_duplex: '1' } } },
    { id: 'minicpmo45-duplex-catalog', upstreamModel: 'openbmb/MiniCPM-o-4_5', mode: 'realtime', realtime: { query: { native_duplex: '1' } } },
  ]
  const p = createAudioPlugin({ rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes: [{ provider: 'dgx', displayName: 'DGX', baseURL: server.baseURL, models }] }, log: () => {} })
  await p.ready
  tc.after(async () => { await p.live.closeAll('test'); p.dispose() })
  const events = []
  const ac = new AbortController()
  const reading = (async () => { try { for await (const e of p.hub.subscribe('s-045', { signal: ac.signal })) events.push(e) } catch { /* aborted */ } })()
  const call = async (path, body, init) => {
    const route = p.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://h${path}`, init ?? { method: 'POST', body: JSON.stringify(body) }))
    return res.json()
  }
  const append = (liveId, seq) => call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, undefined, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })

  // Session A (host default entry): overlap, barge-in, playback ack.
  const a = await call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-045', provider: 'dgx', model: 'minicpmo45-duplex' })
  await append(a.liveId, 0)
  await append(a.liveId, 1)
  await sleep(80)
  const overlap = await append(a.liveId, 2)
  assert.equal(overlap.ok, true)
  const speaking = events.find(e => e.type === 'live.input.accepted' && e.liveId === a.liveId && e.seq === 2)
  assert.equal(speaking.overlapResponseIds.length, 1, 'accepted frame names the response it overlapped')
  const responseA = speaking.overlapResponseIds[0]
  await call(`/api/dsh-dgx-audio/v1/live/control?liveId=${a.liveId}`, { type: 'playback-ack', responseId: responseA, playedMs: 120 })
  await call(`/api/dsh-dgx-audio/v1/live/control?liveId=${a.liveId}`, { type: 'barge-in' })
  await sleep(120)
  const closedA = await call(`/api/dsh-dgx-audio/v1/live/close?liveId=${a.liveId}`, {})
  assert.ok(closedA.observations.some(o => o.key === 'bargeIn' && o.state === 'verified' && o.responseId === responseA))
  assert.ok(closedA.observations.some(o => o.key === 'playbackAck' && o.responseId === responseA))
  assert.ok(events.some(e => e.type === 'live.playback.ack' && e.liveId === a.liveId && e.responseId === responseA && e.playedMs === 120))

  // Session B (catalog entry, same deployment fingerprint): no barge-in, no ack.
  const b = await call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-045', provider: 'dgx', model: 'minicpmo45-duplex-catalog' })
  await append(b.liveId, 0)
  await append(b.liveId, 1)
  await sleep(80)
  const closedB = await call(`/api/dsh-dgx-audio/v1/live/close?liveId=${b.liveId}`, {})
  ac.abort()
  await reading
  // This connection's own evidence carries no barge-in or ack…
  assert.equal(closedB.observations.some(o => o.key === 'bargeIn' && o.state === 'verified'), false)
  assert.equal(closedB.observations.some(o => o.key === 'playbackAck' && o.state === 'verified'), false)
  assert.equal(events.some(e => e.type === 'live.capability' && e.liveId === b.liveId && e.key === 'bargeIn' && e.state === 'verified'), false)
  assert.ok(events.filter(e => e.type === 'live.capability').every(e => typeof e.liveId === 'string'))
  // …while the capability document keeps the deployment history, attributed to session A.
  const doc = await call('/api/dsh-dgx-audio/v1/capabilities', undefined, { method: 'GET' })
  const catalogCaps = doc.routes[0].models.find(m => m.id === 'minicpmo45-duplex-catalog').capabilities
  assert.deepEqual([catalogCaps.bargeIn.state, catalogCaps.bargeIn.scope, catalogCaps.bargeIn.observedBy.liveId, catalogCaps.bargeIn.observedBy.model, catalogCaps.bargeIn.observedBy.responseId], ['verified', 'deployment', a.liveId, 'minicpmo45-duplex', responseA])
  assert.equal(catalogCaps.liveInput.observedBy.liveId, b.liveId, 'a newer observation of the same key names the newer connection')
  assert.equal(doc.routes[0].models[0].capabilities.textStreaming.scope, null)
  assert.equal(events.find(e => e.type === 'live.state' && e.state === 'ready' && e.liveId === b.liveId).capabilitiesScope, 'deployment-history')
})

/**
 * vLLM-Omni barge_in semantics (session_runner.py ~1086-1150, engine/duplex/session.py prepare_cancel_fence):
 * `barge_in` is not response-targeted; when the response is already finishing, the server completes it, raises a fence
 * mismatch (`stale_fence`) and clears buffered input so the next append's reservation is stale. `response.cancel` with an
 * inactive response_id answers `response_not_active` without touching input.
 */
function raceServer({ finishOnBargeIn }) {
  const received = []
  let seq = 0
  return wsServer((conn) => {
    let appends = 0
    let active
    let staleNextAppend = false
    const emit = e => conn.send({ ...e, server_event_seq: ++seq })
    conn.onMessage(async (m) => {
      received.push(m)
      if (m.type === 'session.update') emit({ type: 'session.created', incarnation: 0, resume_token: 't', session: { id: 'duplex-race', capabilities: { implementation_level: 'model_native_duplex', supports_barge_in: true, supports_playback_ack: true } } })
      if (m.type === 'input_audio_buffer.append') {
        appends += 1
        if (staleNextAppend) { staleNextAppend = false; emit({ type: 'error', code: 'failed_precondition', error: 'duplex append reservation is stale' }); return }
        if (appends === 2) {
          active = 'resp-duplex-race-0'
          emit({ type: 'response.created', response: { id: active, status: 'in_progress' } })
          emit({ type: 'response.audio.delta', response_id: active, delta: pcm16(0.1, 24000).toString('base64'), sample_rate_hz: 24000 })
          emit({ type: 'response.audio_transcript.delta', response_id: active, delta: ' Sure.' })
        }
      }
      if (m.type === 'barge_in') {
        if (active === undefined) return
        if (finishOnBargeIn()) {
          emit({ type: 'response.done', response: { id: active, status: 'completed', status_details: { reason: 'stop' } } })
          active = undefined
          emit({ type: 'error', code: 'stale_fence', error: "duplex fence mismatch: expected DuplexFence(session_id='duplex-race', epoch=0, turn_id=0, response_seq=0, incarnation=0), got DuplexFence(session_id='duplex-race', epoch=0, turn_id=1, response_seq=0, incarnation=0)" })
          staleNextAppend = true
        } else {
          emit({ type: 'response.done', response: { id: active, status: 'cancelled', status_details: { reason: 'barge_in' } } })
          active = undefined
        }
      }
      if (m.type === 'response.cancel') {
        if (active === undefined || m.response_id !== active) { emit({ type: 'error', code: 'response_not_active', error: `Response is not active: ${m.response_id}` }); return }
        emit({ type: 'response.done', response: { id: active, status: 'cancelled', status_details: { reason: 'client_cancelled' } } })
        active = undefined
      }
      if (m.type === 'playback.ack') emit({ type: 'playback.acknowledged', response_id: m.response_id, played_ms: m.played_ms, committed_ms: m.committed_ms })
    })
  }).then(server => Object.assign(server, { received }))
}

async function liveHarness(tc, server) {
  const outputDir = await tempDir('dgx-045-race-')
  const p = createAudioPlugin({ rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes: [{ provider: 'dgx', displayName: 'DGX', baseURL: server.baseURL, models: [{ id: 'duplex', upstreamModel: 'openbmb/MiniCPM-o-4_5', mode: 'realtime', realtime: { query: { native_duplex: '1' } } }] }] }, log: () => {} })
  await p.ready
  const events = []
  const ac = new AbortController()
  const reading = (async () => { try { for await (const e of p.hub.subscribe('s-race', { signal: ac.signal })) events.push(e) } catch { /* aborted */ } })()
  const call = async (path, body, init) => (await p.routes().find(r => r.path === path.split('?')[0]).fetch(new Request(`http://h${path}`, init ?? { method: 'POST', body: JSON.stringify(body) }))).json()
  const append = (liveId, seq) => call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, undefined, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  tc.after(async () => { ac.abort(); await reading; await p.live.closeAll('test'); p.dispose() })
  return { p, events, call, append, stopFeed: async () => { await sleep(50); ac.abort(); await reading } }
}

test('I4 tail race replay: Interrupt reaching the server after the response finished → response-already-completed, stale_fence and the dropped append attributed; never a barge-in PASS', async (tc) => {
  const server = await raceServer({ finishOnBargeIn: () => true })
  tc.after(() => server.close())
  const h = await liveHarness(tc, server)
  const { liveId } = await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-race', provider: 'dgx', model: 'duplex' })
  await h.append(liveId, 0)
  await h.append(liveId, 1)
  await sleep(80)
  // Click Interrupt at the first reply text " Sure." (the response is still active on the host).
  const reply = await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'barge-in', wait: true, waitMs: 1000 })
  assert.deepEqual([reply.ok, reply.sent, reply.targetResponseId, reply.outcome], [true, true, 'resp-duplex-race-0', 'response-already-completed'])
  assert.match(reply.controlId, /^ctl_/)
  await sleep(80)
  await h.append(liveId, 2) // the server rejects this one (reservation invalidated by barge_in)
  await sleep(80)
  const closed = await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})
  await h.stopFeed()
  const stale = h.events.find(e => e.type === 'live.error' && e.code === 'stale_fence')
  assert.equal(stale.controlId, reply.controlId, 'stale_fence is attributed to the Interrupt, not swallowed')
  const rejected = h.events.find(e => e.type === 'live.input.rejected')
  assert.deepEqual([rejected.liveId, rejected.controlId, rejected.lastForwardedSeq], [liveId, reply.controlId, 2])
  assert.deepEqual(closed.controls.map(c => [c.controlId, c.type, c.sent, c.outcome, c.staleError]), [[reply.controlId, 'barge-in', true, 'response-already-completed', 'stale_fence']])
  assert.deepEqual([closed.inputIntegrity.framesForwarded, closed.inputIntegrity.serverRejectedAppends], [3, 1])
  assert.equal(closed.responses[0].status, 'completed')
  assert.equal(closed.observations.some(o => o.key === 'bargeIn' && o.state === 'verified'), false, 'a completed response is never a barge-in PASS')
  assert.ok(h.events.some(e => e.type === 'live.control.result' && e.liveId === liveId && e.controlId === reply.controlId && e.outcome === 'response-already-completed'))
})

test('controls: no active response is a clean no-op (nothing sent); wrong responseId refused; real barge-in cancels; targeted cancel and ack outcomes', async (tc) => {
  let finish = false
  const server = await raceServer({ finishOnBargeIn: () => finish })
  tc.after(() => server.close())
  const h = await liveHarness(tc, server)
  const { liveId } = await h.call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-race', provider: 'dgx', model: 'duplex' })
  const early = await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'barge-in' })
  assert.deepEqual([early.sent, early.outcome, early.targetResponseId], [false, 'no-active-response', null])
  assert.equal(server.received.some(m => m.type === 'barge_in'), false, 'no barge_in reaches the server, so no stale_fence and no cleared input')
  await h.append(liveId, 0)
  await h.append(liveId, 1)
  await sleep(80)
  const wrong = await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'barge-in', responseId: 'resp-from-an-old-turn' })
  assert.deepEqual([wrong.sent, wrong.outcome], [false, 'response-not-active'])
  const ack = await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'playback-ack', responseId: 'resp-duplex-race-0', playedMs: 90, wait: true, waitMs: 1000 })
  assert.equal(ack.outcome, 'acknowledged')
  const cut = await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'barge-in', responseId: 'resp-duplex-race-0', wait: true, waitMs: 1000 })
  assert.deepEqual([cut.sent, cut.outcome, cut.reason], [true, 'cancelled', 'barge_in'])
  const afterCancel = await h.call(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'cancel-response', responseId: 'resp-duplex-race-0' })
  assert.deepEqual([afterCancel.sent, afterCancel.outcome], [false, 'no-active-response'])
  const closed = await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})
  await h.stopFeed()
  assert.ok(closed.observations.some(o => o.key === 'bargeIn' && o.state === 'verified' && o.responseId === 'resp-duplex-race-0'))
  assert.equal(closed.inputIntegrity.serverRejectedAppends, 0)
  assert.deepEqual(closed.controls.map(c => c.outcome), ['no-active-response', 'response-not-active', 'acknowledged', 'cancelled', 'no-active-response'])
  assert.equal(h.events.filter(e => e.type === 'live.error').length, 0)
})
