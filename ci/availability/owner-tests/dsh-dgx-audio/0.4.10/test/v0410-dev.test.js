// 0.4.10 (TASK_CONTRACT §K.16): findings from the Codex packaged-Desktop MiniCPM Live run 11:57 (pre13, host 0.4.8).
// (1) The panel changed from "server reports native full duplex" to "did not report" after the first response: the
//     per-response fullDuplex "verified" event carried no implementationLevel and the UI keeps the newest event per key.
// (2) Every playback-ack control ended "unconfirmed" although the server echoed each one: vLLM-Omni 58adeec wraps
//     playback.acknowledged as {type, event:{item_id:"item_<response_id>", played_ms, ...}}.
// Server event shapes below are copied from vllm-omni 58adeec (serving.py send_json / realtime_output.py). Mock transport.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAudioPlugin } from '../src/index.js'
import { pcm16, sleep, tempDir } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

function nightlyDuplexServer() {
  let seq = 0
  const received = []
  const server = wsServer((conn) => {
    let appends = 0
    let active
    let responses = 0
    const emit = e => conn.send({ ...e, server_event_seq: ++seq })
    conn.onMessage(async (m) => {
      received.push(m)
      if (m.type === 'session.update') emit({ type: 'session.created', incarnation: 1, resume_token: 't', session: { id: 'sess_demo_01', capabilities: { implementation_level: 'model_native_duplex', supports_barge_in: true, supports_playback_ack: true, supports_session_resume: true, supports_input_append: true } } })
      if (m.type === 'input_audio_buffer.append') {
        appends += 1
        // Two consecutive model-owned responses while input continues (as in the 11:57 run).
        if ((appends === 2 || appends === 6) && active === undefined) {
          responses += 1
          active = `resp-duplex-demo-0-${responses}`
          emit({ type: 'response.created', response: { id: active, status: 'in_progress' } })
          for (let i = 0; i < 2; i++) emit({ type: 'response.audio.delta', response_id: active, delta: pcm16(0.1, 24000).toString('base64'), sample_rate_hz: 24000 })
        }
        if ((appends === 4 || appends === 8) && active !== undefined) { emit({ type: 'response.done', response: { id: active, status: 'completed', status_details: { reason: 'stop' } } }); active = undefined }
      }
      if (m.type === 'barge_in' && active !== undefined) { emit({ type: 'response.done', response: { id: active, status: 'cancelled', status_details: { reason: 'barge_in' } } }); active = undefined }
      if (m.type === 'playback.ack') {
        const played = m.played_ms
        emit({ type: 'playback.acknowledged', event: { type: 'playback.acknowledged', session_id: 'sess_demo_01', epoch: 0, item_id: m.item_id, played_ms: played, committed_ms: played, truncate: m.truncate === true, playback: { generated_ms: 2400, sent_ms: 2400, played_ms: played, committed_ms: played }, history_committed: m.truncate === true } })
      }
    })
  })
  return server.then(s => Object.assign(s, { received }))
}

async function harness(tc) {
  const server = await nightlyDuplexServer()
  tc.after(() => server.close())
  const p = createAudioPlugin({ rowConfig: { outputDir: await tempDir('dgx-0410-'), hubLimits: { pingMs: 60_000 }, routes: [{ provider: 'dgx', displayName: 'DGX', baseURL: server.baseURL, models: [{ id: 'minicpmo45-duplex-catalog', upstreamModel: 'openbmb/MiniCPM-o-4_5', mode: 'realtime', realtime: { session: { extra_body: { native_duplex: true } } } }] }] }, log: () => {} })
  await p.ready
  tc.after(async () => { await p.live.closeAll('test'); p.dispose() })
  const events = []
  const ac = new AbortController()
  const reading = (async () => { try { for await (const e of p.hub.subscribe('s-0410', { signal: ac.signal })) events.push(e) } catch { /* aborted */ } })()
  tc.after(async () => { ac.abort(); await reading })
  const call = async (path, body, init) => {
    const route = p.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://h${path}`, init ?? { method: 'POST', body: JSON.stringify(body) }))
    return res.json()
  }
  const open = await call('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-0410', provider: 'dgx', model: 'minicpmo45-duplex-catalog' })
  let seq = 0
  const append = () => call(`/api/dsh-dgx-audio/v1/live/append?liveId=${open.liveId}&seq=${seq++}`, undefined, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  const control = body => call(`/api/dsh-dgx-audio/v1/live/control?liveId=${open.liveId}`, body)
  return { server, events, call, append, control, liveId: open.liveId }
}

test('fullDuplex: every per-connection event keeps the server-reported implementation level (UI label stays native after each response)', async (tc) => {
  const h = await harness(tc)
  for (let i = 0; i < 9; i++) { await h.append(); await sleep(15) }
  await sleep(80)
  const duplexEvents = h.events.filter(e => e.type === 'live.capability' && e.key === 'fullDuplex')
  assert.deepEqual(duplexEvents.map(e => e.state), ['advertised', 'verified', 'verified'], 'advertised at session.created, verified per overlapped response')
  assert.deepEqual(duplexEvents.map(e => e.implementationLevel), ['model_native_duplex', 'model_native_duplex', 'model_native_duplex'])
  // A UI that keeps the newest event per key (mic 0.3.3) now still has the level.
  const newest = duplexEvents.at(-1)
  assert.equal(newest.state === 'verified' && newest.implementationLevel !== undefined, true)
  const closed = await h.call(`/api/dsh-dgx-audio/v1/live/close?liveId=${h.liveId}`, {})
  assert.ok(closed.observations.filter(o => o.key === 'fullDuplex').every(o => o.implementationLevel === 'model_native_duplex'))
})

test('playback ack (nightly 58adeec wrapped shape): each control resolves "acknowledged" with played/committed ms; truncate passes through; one playbackAck observation', async (tc) => {
  const h = await harness(tc)
  await h.append(); await h.append()
  await sleep(60)
  const rid = h.events.find(e => e.type === 'live.response' && e.status === 'created').responseId
  const r1 = await h.control({ type: 'playback-ack', responseId: rid, playedMs: 109 })
  const r2 = await h.control({ type: 'playback-ack', responseId: rid, playedMs: 605 })
  const r3 = await h.control({ type: 'playback-ack', responseId: rid, playedMs: 700, truncate: true, wait: true, waitMs: 1000 })
  assert.equal(r3.outcome, 'acknowledged')
  await sleep(50)
  const results = h.events.filter(e => e.type === 'live.control.result' && e.control === 'playback-ack')
  assert.deepEqual(results.map(r => [r.controlId, r.outcome, r.playedMs]), [[r1.controlId, 'acknowledged', 109], [r2.controlId, 'acknowledged', 605], [r3.controlId, 'acknowledged', 700]], 'no "unconfirmed" for an echoed ack')
  assert.equal(results[2].truncate, true)
  assert.equal(results[2].historyCommitted, true)
  const sentTruncate = h.server.received.filter(m => m.type === 'playback.ack').map(m => m.truncate === true)
  assert.deepEqual(sentTruncate, [false, false, true])
  const acks = h.events.filter(e => e.type === 'live.playback.ack')
  assert.deepEqual(acks.map(a => [a.responseId, a.itemId, a.playedMs, a.committedMs]), [[rid, `item_${rid}`, 109, 109], [rid, `item_${rid}`, 605, 605], [rid, `item_${rid}`, 700, 700]])
  assert.deepEqual(acks[2].playback, { generatedMs: 2400, sentMs: 2400, playedMs: 700, committedMs: 700 })
  assert.equal(h.events.filter(e => e.type === 'live.capability' && e.key === 'playbackAck' && e.state === 'verified').length, 1, 'one verified observation per connection, not one per ack')
  const bad = await h.control({ type: 'playback-ack', responseId: rid, playedMs: 1, truncate: 'yes' })
  assert.equal(bad.error?.code ?? bad.code, 'BAD_REQUEST')
})

test('Interrupt between responses is a clean no-op (normal inactive state, not a failure); during a response it cancels', async (tc) => {
  const h = await harness(tc)
  for (let i = 0; i < 4; i++) await h.append()
  await sleep(60)
  const idle = await h.control({ type: 'barge-in', wait: true })
  assert.deepEqual([idle.sent, idle.outcome], [false, 'no-active-response'])
  assert.equal(h.server.received.filter(m => m.type === 'barge_in').length, 0, 'nothing sent: no stale fence, no cleared input')
  await h.append(); await h.append()
  await sleep(60)
  const active = await h.control({ type: 'barge-in', wait: true, waitMs: 1000 })
  assert.deepEqual([active.sent, active.outcome], [true, 'cancelled'])
})

test('playbackAckOf: wrapped, flat and item-only shapes', async () => {
  const { playbackAckOf } = await import('../src/live.js')
  assert.equal(typeof playbackAckOf, 'function')
  assert.deepEqual(playbackAckOf({ type: 'playback.acknowledged', event: { item_id: 'item_resp_01', played_ms: 1000, committed_ms: 900, truncate: false, playback: { generated_ms: 2400, sent_ms: 2400, played_ms: 1000, committed_ms: 900 }, history_committed: false } }),
    { responseId: 'resp_01', itemId: 'item_resp_01', playedMs: 1000, committedMs: 900, truncate: false, historyCommitted: false, playback: { generatedMs: 2400, sentMs: 2400, playedMs: 1000, committedMs: 900 } })
  assert.deepEqual(playbackAckOf({ type: 'playback.acknowledged', response_id: 'r', played_ms: 5, committed_ms: 5 }),
    { responseId: 'r', itemId: null, playedMs: 5, committedMs: 5, truncate: false, historyCommitted: null, playback: null })
  assert.equal(playbackAckOf({ type: 'playback.acknowledged', event: { item_id: 'custom', played_ms: 1 } }).responseId, null)
})
