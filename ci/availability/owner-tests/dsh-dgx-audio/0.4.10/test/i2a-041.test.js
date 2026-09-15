// 0.4.1: fixes for the release lane's I2-A real-app defects (OWNER_HANDOFF_I2A.md #1–#5), mock transport only.
// Root cause of #4 (no reply, receipt "unavailable"): native duplex + auto_response are session.update.extra_body
// fields in vLLM-Omni; the host never derived them from the configured query flag.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAudioPlugin } from '../src/index.js'
import { collect, pcm16, scriptedServer, sleep, tempDir } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

const NATIVE = { implementation_level: 'model_native_duplex', supports_session_resume: true, supports_input_append: true }
const ADAPTER = { implementation_level: 'serving_session_adapter', supports_session_resume: false, supports_input_append: true }

async function plugin(routes, extra = {}) {
  const outputDir = await tempDir('dgx-i2a-')
  const p = createAudioPlugin({ rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes }, log: () => {}, fileUploads: extra.fileUploads === undefined ? undefined : () => extra.fileUploads })
  const call = async (path, init) => {
    const route = p.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://h${path}`, init))
    return { status: res.status, body: await res.json() }
  }
  return { p, call, post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }) }
}

/** Duplex backend that records client events and answers session.update with the given capabilities. */
function duplexBackend({ caps = NATIVE, onUpdate } = {}) {
  const state = { updates: [], events: [], urls: [] }
  return wsServer((conn) => {
    state.urls.push(conn.url)
    conn.onMessage((m) => {
      state.events.push(m.type)
      if (m.type === 'session.update') {
        state.updates.push(m.session)
        if (onUpdate) { onUpdate(conn, m); return }
        conn.send({ type: 'session.created', incarnation: 1, resume_token: 't', session: { id: 'srv-1', capabilities: caps }, server_event_seq: 1 })
      }
    })
  }).then(server => Object.assign(server, { state }))
}

const liveModel = (realtime, extra = {}) => ({ id: 'live', name: 'MiniCPM Live', mode: 'realtime', realtime, ...extra })

async function openClose(t, body = {}) {
  const opened = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's', provider: 'd', model: 'live', ...body })
  if (opened.status !== 200) return { opened }
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${opened.body.liveId}`, {})).body
  return { opened, closed }
}

test('#4 root cause: native query flag → session.update.extra_body {flag, auto_response, force_listen_count} (both key spellings); explicit keys win', async (tc) => {
  const server = await duplexBackend()
  tc.after(() => server.close())
  const cases = [
    [{ query: { minicpmo45_native_duplex: '1' } }, { minicpmo45_native_duplex: true, auto_response: true, force_listen_count: 0 }],
    [{ query: { native_duplex: '1' } }, { native_duplex: true, auto_response: true, force_listen_count: 0 }],
    [{ query: { native_duplex: '1' }, session: { extra_body: { auto_response: false, force_listen_count: 2 } } }, { native_duplex: true, auto_response: false, force_listen_count: 2 }],
    [{ query: { native_duplex: '1' }, session: { extra_body: { native_duplex: false } } }, { native_duplex: false, auto_response: true }],
    [{}, { auto_response: true }], // generic duplex profile (Nemotron requires auto_response; official clients default it on)
    // Settings are often strings: a string "1" makes the server fall back (DGX owner wire table), so coerce to boolean.
    [{ session: { extra_body: { native_duplex: '1', auto_response: 'true' } } }, { native_duplex: true, auto_response: true, force_listen_count: 0 }],
  ]
  for (const [realtime, expected] of cases) {
    const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: server.baseURL, models: [liveModel(realtime)] }])
    const { opened, closed } = await openClose(t)
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    assert.deepEqual(server.state.updates.at(-1).extra_body, expected, JSON.stringify(realtime))
    assert.equal(closed.ok, true)
    await t.p.dispose?.()
  }
  // URL still carries duplex/autostart + the flag (unchanged from 0.4.0).
  assert.equal(server.state.urls[0].searchParams.get('autostart'), '0')
  assert.equal(server.state.urls[0].searchParams.get('minicpmo45_native_duplex'), '1')
})

test('#4: server that ignores the native request → live.warning NATIVE_DUPLEX_NOT_ENABLED; close says why nothing was recorded', async (tc) => {
  const server = await duplexBackend({ caps: ADAPTER })
  tc.after(() => server.close())
  const staged = []
  const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: server.baseURL, models: [liveModel({ query: { minicpmo45_native_duplex: '1' } })] }], { fileUploads: { uploadStream: async (x) => { staged.push(x); return { receiptId: 'r1', file: {} } } } })
  const events = []
  const feedAbort = new AbortController()
  const reading = (async () => { try { for await (const e of t.p.hub.subscribe('s', { signal: feedAbort.signal })) events.push(e) } catch { /* aborted */ } })()
  const opened = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's', provider: 'd', model: 'live' })
  assert.equal(opened.status, 200)
  for (let seq = 0; seq < 3; seq++) await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${opened.body.liveId}&seq=${seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${opened.body.liveId}`, {})).body
  await sleep(50)
  feedAbort.abort()
  await reading
  assert.equal(closed.implementationLevel, 'serving_session_adapter')
  assert.equal(closed.warnings[0].code, 'NATIVE_DUPLEX_NOT_ENABLED')
  assert.deepEqual({ state: closed.receipt.state, reason: closed.receipt.reason }, { state: 'skipped', reason: 'no-response' })
  assert.match(closed.receipt.detail, /3 frame\(s\) sent.*NATIVE_DUPLEX_NOT_ENABLED/)
  assert.equal(closed.input.receipt.reason, 'no-response')
  assert.equal(staged.length, 0, 'nothing is staged without a response')
  assert.ok(events.some(e => e.type === 'live.warning' && e.code === 'NATIVE_DUPLEX_NOT_ENABLED'), JSON.stringify(events.map(e => e.type)))
  assert.ok(events.some(e => e.type === 'live.state' && e.state === 'ready' && e.implementationLevel === 'serving_session_adapter' && e.warnings.length === 1))
  assert.ok(events.some(e => e.type === 'live.state' && e.state === 'closed' && e.receipt?.reason === 'no-response'))
})

test('#4: End input sends response.create only when the duplex session neither auto-responds nor uses server VAD', async (tc) => {
  const server = await duplexBackend()
  tc.after(() => server.close())
  const run = async (realtime, openBody = {}) => {
    server.state.events.length = 0
    const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: server.baseURL, models: [liveModel(realtime)] }])
    const opened = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's', provider: 'd', model: 'live', ...openBody })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${opened.body.liveId}&seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
    await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${opened.body.liveId}`, { type: 'commit' })
    await sleep(50)
    await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${opened.body.liveId}`, {})
    return server.state.events.filter(e => e === 'input_audio_buffer.commit' || e === 'response.create')
  }
  assert.deepEqual(await run({ query: { native_duplex: '1' } }), ['input_audio_buffer.commit'])
  assert.deepEqual(await run({ session: { extra_body: { auto_response: false } } }), ['input_audio_buffer.commit', 'response.create'])
  assert.deepEqual(await run({ session: { extra_body: { auto_response: false } } }, { turnDetection: 'server_vad' }), ['input_audio_buffer.commit'])
})

test('#1: a configured realtime model offers Live as declared (never verified) until evidence arrives', async () => {
  const t = await plugin([{
    provider: 'd', displayName: 'D', baseURL: 'http://127.0.0.1:9/v1', models: [
      liveModel({ query: { native_duplex: '1' } }),
      { id: 'asr', mode: 'realtime', realtime: { wire: 'vllm-asr', inputSampleRate: 16000 } },
      { id: 'tts-ws', mode: 'realtime', realtime: { wire: 'omni-speech-ws' } },
      { id: 'off', mode: 'realtime', capabilities: { liveInput: false } },
      { id: 'chat', mode: 'chat' },
    ],
  }])
  const doc = (await t.call('/api/dsh-dgx-audio/v1/capabilities', { method: 'GET' })).body
  const caps = id => doc.routes[0].models.find(m => m.id === id).capabilities
  assert.deepEqual([caps('live').liveInput.state, caps('live').liveInput.source], ['declared', 'config:mode'])
  assert.equal(caps('live').fullDuplex.state, 'declared')
  assert.equal(caps('live').audioOutput.state, 'declared')
  assert.equal(caps('live').bargeIn.state, 'untested')
  assert.equal(caps('live').sessionResume.state, 'untested')
  assert.equal(caps('asr').liveInput.state, 'declared')
  assert.equal(caps('asr').audioOutput.state, 'unsupported')
  assert.equal(caps('asr').fullDuplex.state, 'unsupported')
  assert.equal(caps('tts-ws').liveInput.state, 'unsupported')
  assert.equal(caps('off').liveInput.state, 'unsupported')
  assert.equal(caps('chat').liveInput.state, 'unsupported')
  assert.ok(Object.values(caps('live')).every(c => c.state !== 'verified'))
})

test('#2: a Live-only model used as the conversation model names the chat models to pick; titles stay local', async () => {
  const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: 'http://127.0.0.1:9/v1', models: [liveModel({}), { id: 'speech', name: 'MiniCPM speech', mode: 'chat', outputAudio: true }] }])
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello there, what is this?' }] }]
  await assert.rejects(collect(t.p.adapter.stream({ provider: 'd', model: 'live', messages })), (e) => {
    assert.equal(e.code, 'UNSUPPORTED_OPTION')
    assert.match(e.message, /Live-only model/)
    assert.match(e.message, /press Live/)
    assert.match(e.message, /"MiniCPM speech" \(speech\)/)
    return true
  })
  const title = await collect(t.p.adapter.stream({ provider: 'd', model: 'live', purpose: 'title', messages }))
  assert.ok(title.length > 0, 'auxiliary purpose answered locally without network')
})

test('#3: live/open refuses PROVIDER_BUSY while a reply streams from the same server; allowConcurrent overrides; config_timeout → BACKEND_BUSY', async (tc) => {
  const server = await duplexBackend()
  tc.after(() => server.close())
  const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: server.baseURL, models: [liveModel({}), { id: 'speech', mode: 'chat', outputAudio: true }] }])
  const job = t.p.work.begin({ kind: 'chat', provider: 'd', model: 'speech', sessionId: 's' })
  const refused = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's', provider: 'd', model: 'live' })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'PROVIDER_BUSY')
  assert.match(refused.body.error.message, /still answering.*wait for that reply to finish or stop it/)
  assert.deepEqual(refused.body.error.details.items.map(i => [i.kind, i.model]), [['chat', 'speech']])
  assert.equal(server.state.updates.length, 0, 'no backend connection attempted')
  const { opened } = await openClose(t, { allowConcurrent: true })
  assert.equal(opened.status, 200)
  job.end()

  const slow = await duplexBackend({ onUpdate: conn => conn.send({ type: 'error', error: 'Timeout waiting for session.create', code: 'config_timeout' }) })
  tc.after(() => slow.close())
  const t2 = await plugin([{ provider: 'd', displayName: 'D', baseURL: slow.baseURL, models: [liveModel({})] }])
  const busy = await t2.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's', provider: 'd', model: 'live' })
  assert.equal(busy.status, 503)
  assert.equal(busy.body.error.code, 'BACKEND_BUSY')
  assert.match(busy.body.error.message, /config_timeout.*retry/)
})

test('#5: Stop aborts the upstream HTTP request promptly, before headers and mid-stream (host side of the M3 cancel check)', async (tc) => {
  let phase = 'before-headers'
  const server = await scriptedServer(async (req, res, call) => {
    call.phase = phase
    if (phase === 'before-headers') { await new Promise(resolve => res.on('close', resolve)); call.closedAt = Date.now(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Once upon' } }] })}\n\n`)
    await new Promise(resolve => res.on('close', resolve))
    call.closedAt = Date.now()
  })
  tc.after(() => server.close())
  const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: server.url, models: [{ id: 'chat', mode: 'chat', streaming: { text: 'sse' } }] }])
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Tell me a long story about the sea' }] }]

  for (const [name, afterMs] of [['before-headers', 150], ['mid-stream', undefined]]) {
    phase = name
    const controller = new AbortController()
    const started = Date.now()
    const it = t.p.adapter.stream({ provider: 'd', model: 'chat', messages, signal: controller.signal })
    let abortedAt
    const consume = (async () => {
      try {
        for await (const chunk of it) {
          if (name === 'mid-stream' && chunk.type === 'text-delta' && abortedAt === undefined) { abortedAt = Date.now(); controller.abort() }
        }
      } catch { /* aborted */ }
    })()
    if (afterMs !== undefined) { await sleep(afterMs); abortedAt = Date.now(); controller.abort() }
    await consume
    await sleep(100)
    const call = server.calls.at(-1)
    assert.equal(call.phase, name)
    assert.ok(call.clientClosed || call.closedAt !== undefined, `${name}: upstream connection closed`)
    assert.ok(call.closedAt - abortedAt < 1000, `${name}: closed ${call.closedAt - abortedAt} ms after Stop (started ${abortedAt - started} ms in)`)
    assert.equal(t.p.service.busy('d').chatRequests, 0, `${name}: work released`)
  }
})
