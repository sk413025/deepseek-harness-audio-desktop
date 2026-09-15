// Service-availability scenarios (SERVICE_AVAILABILITY_SCENARIOS A1, A3, A4, A5, A8, A9) against the REAL dsh-dgx-audio
// host code of the tree under test: DgxAudioAdapter, AudioHub, config resolution and invocation log, plus the real
// Cordis Context and dsh-llm LlmRuntime for the terminal chunk a recipient's session sees.
// Only the upstream model server is fake: a loopback HTTP/TCP listener that refuses, black-holes, drains, drops or
// finishes on command. No DGX, no network beyond 127.0.0.1, no microphone. Titles start with the scenario id; the CI
// mapping (ci/availability/scenarios.json) selects tests by these titles.
//
// Staged by ci/availability/run.mjs as <plugin>/test-ci/, next to the plugin's src/ and the owner's test/helpers/.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { fileHandleText } from '@deepseek-ai/dsh-llm'

import { DgxAudioAdapter } from '../src/adapter.js'
import { AudioHub } from '../src/audio-hub.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { CONFIG_DEFAULTS, resolveConfig } from '../src/config.js'
import * as plugin from '../src/index.js'
import { fakeStore, omni, pcm16, scriptedServer, sleep, tempDir, wav, wavFromPcm, writeSse } from '../test/helpers/fixtures.js'

async function setup(baseURL, { model = {}, config: configOverrides = {} } = {}) {
  const outDir = await tempDir('ci-avail-out-')
  const config = resolveConfig({
    outputDir: outDir,
    ...configOverrides,
    routes: [{ provider: 'lab', displayName: 'Lab', baseURL, models: [{ id: 'omni', sendModalities: true, outputAudio: true, ...model }] }],
  })
  const hub = new AudioHub({ outputDir: () => config.outputDir, limits: { pingMs: 60_000 } })
  const capabilities = new CapabilityRegistry({ file: () => config.capabilityFile })
  const input = wav(0.3)
  const fx = await fakeStore(input, 'question.wav')
  const adapter = new DgxAudioAdapter({ config: () => config, attachments: () => fx.store, log: () => {}, hub: () => hub, capabilities })
  const request = (extra = {}) => ({
    provider: 'lab', model: 'omni', sessionId: 'sess-a',
    messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }, { type: 'text', text: 'Answer' }] }],
    ...extra,
  })
  return { config, hub, adapter, request, fx, input, outDir }
}

/** Run one request to its terminal outcome: { outcome: 'finish'|'error', code, chunks, ms }. Never throws. */
async function runToEnd(s, extra = {}, onChunk) {
  const started = performance.now()
  const chunks = []
  try {
    for await (const chunk of s.adapter.stream(s.request(extra))) { chunks.push(chunk); onChunk?.(chunk, chunks) }
    return { outcome: chunks.at(-1)?.type === 'finish' ? 'finish' : 'ended-without-finish', chunks, ms: performance.now() - started }
  } catch (error) {
    return { outcome: 'error', code: error?.code, status: error?.failure?.status ?? error?.status, message: String(error?.message ?? error), chunks, ms: performance.now() - started }
  }
}

async function readLog(config) {
  try { return (await readFile(config.invocationLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}

function watchFeed(hub, sessionId) {
  const events = []
  const controller = new AbortController()
  const done = (async () => { for await (const event of hub.subscribe(sessionId, { signal: controller.signal })) events.push(event) })()
  return { events, stop: async () => { controller.abort(); await done } }
}

async function closedPort() {
  const probe = createTcpServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

const posts = server => server.calls.filter(call => call.url.includes('/chat/completions'))

test('A1 server absent before send: TRANSPORT failure names the endpoint, is bounded and is logged once', async () => {
  const baseURL = `http://127.0.0.1:${await closedPort()}/v1`
  const s = await setup(baseURL)
  const result = await runToEnd(s)
  assert.equal(result.outcome, 'error')
  assert.equal(result.code, 'TRANSPORT')
  assert.match(result.message, new RegExp(baseURL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  assert.ok(result.ms < 5_000, `bounded failure (took ${Math.round(result.ms)} ms)`)
  const log = await readLog(s.config)
  assert.equal(log.length, 1)
  assert.equal(log[0].ok, false)
  assert.equal(log[0].code, 'TRANSPORT')
})

test('A1 server absent before send (real Cordis + LlmRuntime): the session gets one terminal error chunk with code TRANSPORT, not a silent end', async (tc) => {
  const baseURL = `http://127.0.0.1:${await closedPort()}/v1`
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(plugin, { outputDir: await tempDir('ci-avail-ctx-'), httpRoutes: false, routes: [{ provider: 'lab', displayName: 'Lab', baseURL, models: [{ id: 'omni', outputAudio: false }] }] })
  tc.after(() => ctx.dispose?.())
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'lab', model: 'omni', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk)
  const finishes = chunks.filter(chunk => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
  assert.equal(finishes[0].reason.failure.code, 'TRANSPORT')
})

test('A1 lab window closed behind a listener that never answers: DGX_TIMEOUT within requestTimeoutMs, connection released', async (tc) => {
  const sockets = new Set()
  const blackhole = createTcpServer(socket => { sockets.add(socket); socket.on('error', () => {}) })
  await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve))
  tc.after(() => { for (const socket of sockets) socket.destroy(); blackhole.close() })
  const s = await setup(`http://127.0.0.1:${blackhole.address().port}/v1`, { config: { requestTimeoutMs: 700 } })
  const result = await runToEnd(s)
  assert.equal(result.outcome, 'error')
  assert.equal(result.code, 'DGX_TIMEOUT')
  assert.ok(result.ms >= 600 && result.ms < 5_000, `bounded by requestTimeoutMs (took ${Math.round(result.ms)} ms)`)
  tc.diagnostic(`product default requestTimeoutMs = ${CONFIG_DEFAULTS.requestTimeoutMs} ms (whole request; no separate idle-stream timeout)`)
  assert.equal((await readLog(s.config)).at(-1).code, 'DGX_TIMEOUT')
})

test('A3 window closes between readiness and request: one POST answered 503 fails with SERVER 503, no automatic resend; the same input succeeds on one explicit retry', async (tc) => {
  let closing = false
  const server = await scriptedServer(async (req, res) => {
    if (closing) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' }); res.end(JSON.stringify({ error: { message: 'service window closed', code: 503 } })); return }
    await writeSse(res, [omni.role(), omni.text('ok'), '[DONE]'])
  })
  tc.after(() => server.close())
  const s = await setup(server.url, { model: { outputAudio: false } })
  const ready = await runToEnd(s)
  assert.equal(ready.outcome, 'finish', 'service ready before the window closes')
  closing = true
  const refused = await runToEnd(s)
  assert.equal(refused.outcome, 'error')
  assert.equal(refused.code, 'SERVER')
  assert.equal(refused.status, 503)
  assert.equal(posts(server).length, 2, 'the refused request was sent exactly once (no automatic resend)')
  closing = false
  const retried = await runToEnd(s)
  assert.equal(retried.outcome, 'finish')
  assert.equal(posts(server).length, 3, 'one explicit retry = one more upstream request')
  const audioOf = call => JSON.stringify(call.json?.messages?.at(-1)?.content?.find(part => part.type === 'input_audio') ?? null)
  assert.equal(audioOf(posts(server)[2]), audioOf(posts(server)[1]), 'the retained input is resent unchanged by the explicit retry')
  const log = await readLog(s.config)
  assert.deepEqual(log.map(entry => entry.ok), [true, false, true])
})

test('A4 planned drain: the accepted stream completes in full; a new request during the drain is refused promptly with 503', async (tc) => {
  let draining = false
  let firstDone = false
  const server = await scriptedServer(async (req, res, call) => {
    if (draining && posts(server).length > 1) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' }); res.end(JSON.stringify({ error: { message: 'draining for planned closure', code: 503 } })); return }
    await writeSse(res, [omni.role(), ...Array.from({ length: 12 }, (_, i) => omni.text(`d${i} `)), '[DONE]'], { delayMs: 60 })
    firstDone = true
  })
  tc.after(() => server.close())
  const s = await setup(server.url, { model: { outputAudio: false } })
  let second
  const first = runToEnd(s, {}, (chunk, chunks) => {
    if (chunk.type === 'text-delta' && second === undefined) { draining = true; second = runToEnd(s, { sessionId: 'sess-b' }) }
  })
  const refused = await (async () => { while (second === undefined) await sleep(5); return second })()
  assert.equal(refused.outcome, 'error')
  assert.equal(refused.code, 'SERVER')
  assert.equal(refused.status, 503)
  assert.equal(firstDone, false, 'the new request was refused while the accepted stream was still draining')
  const accepted = await first
  assert.equal(accepted.outcome, 'finish')
  assert.equal(accepted.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta ?? chunk.text).join('').includes('d11'), true, 'every accepted delta arrived')
  const log = await readLog(s.config)
  assert.equal(log.filter(entry => entry.ok).length, 1)
  assert.equal(log.filter(entry => !entry.ok).length, 1)
})

test('A4/A5 forced closure or backend crash mid-stream: specific failure, partial text and partial audio kept, marked interrupted, never resent', async (tc) => {
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    for (const payload of [omni.role(), omni.text('Partial answer'), omni.audio(wavFromPcm(pcm16(0.2, 24000), 24000)), omni.audio(wavFromPcm(pcm16(0.2, 24000), 24000))]) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      await sleep(40)
    }
    res.socket.destroy()
  })
  tc.after(() => server.close())
  const s = await setup(server.url)
  const feed = watchFeed(s.hub, 'sess-a')
  const result = await runToEnd(s)
  await sleep(150)
  await feed.stop()
  assert.equal(result.outcome, 'error')
  assert.ok(['STREAM_CLOSED', 'TRANSPORT', 'MALFORMED_STREAM'].includes(result.code), `specific stream failure code, got ${result.code}`)
  assert.ok(!result.chunks.some(chunk => chunk.type === 'finish'), 'no success finish after a crash')
  assert.equal(posts(server).length, 1, 'no automatic resend after the crash')
  const end = feed.events.find(event => event.type === 'audio.end')
  assert.ok(end !== undefined && end.status !== 'completed', `audio stream marked interrupted (status ${end?.status})`)
  const log = (await readLog(s.config)).at(-1)
  assert.equal(log.ok, false)
  assert.ok(log.partialText > 0, 'partial text length recorded')
  const files = await readdir(join(s.config.outputDir, 'sess-a'))
  assert.ok(files.some(file => file.endsWith('.partial.wav')), 'partial audio kept as .partial.wav')
  assert.ok(files.every(file => !file.endsWith('.part')), 'no dangling .part file')
})

test('A5 stream stalls after headers: DGX_TIMEOUT bounded by requestTimeoutMs, upstream connection closed by the client', async (tc) => {
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.write(`data: ${JSON.stringify(omni.role())}\n\n`)
    res.write(`data: ${JSON.stringify(omni.text('first words'))}\n\n`)
    await new Promise(resolve => res.on('close', resolve))
  })
  tc.after(() => server.close())
  const s = await setup(server.url, { model: { outputAudio: false }, config: { requestTimeoutMs: 800 } })
  const result = await runToEnd(s)
  assert.equal(result.outcome, 'error')
  assert.equal(result.code, 'DGX_TIMEOUT')
  assert.ok(result.ms >= 700 && result.ms < 5_000, `bounded (took ${Math.round(result.ms)} ms)`)
  await sleep(100)
  assert.equal(posts(server)[0].clientClosed, true)
  assert.equal(posts(server).length, 1)
})

test('A8 Stop vs done, deterministic orderings: Stop after [DONE] is a no-op; Stop before a withheld [DONE] is ABORTED with the connection closed; coalesced last delta + [DONE] ends exactly once', async (tc) => {
  let mode = 'done-then-hold'
  let release
  const server = await scriptedServer(async (req, res, call) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    const send = payload => res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
    send(omni.role()); send(omni.text('a'))
    if (mode === 'done-then-hold') { send(omni.usage()); send('[DONE]'); await new Promise(resolve => { release = resolve; res.on('close', resolve) }); res.end(); return }
    if (mode === 'withhold-done') { send(omni.text('c')); await new Promise(resolve => res.on('close', resolve)); call.marks.closedBeforeDone = true; return }
    res.write(`data: ${JSON.stringify(omni.text('c'))}\n\ndata: [DONE]\n\n`); res.end()
  })
  tc.after(() => server.close())
  const s = await setup(server.url, { model: { outputAudio: false } })

  // 1. [DONE] received, then Stop: the completed reply stays completed, no extra record.
  const c1 = new AbortController()
  const r1 = await runToEnd(s, { signal: c1.signal, sessionId: 'stop-after-done' }, (chunk) => { if (chunk.type === 'finish') c1.abort() })
  release?.()
  assert.equal(r1.outcome, 'finish')
  // 2. last delta received, [DONE] withheld, Stop: ABORTED, upstream closed by the client, nothing resent.
  mode = 'withhold-done'
  const c2 = new AbortController()
  const r2 = await runToEnd(s, { signal: c2.signal, sessionId: 'stop-before-done' }, (chunk) => { if (chunk.type === 'text-delta' && (chunk.delta ?? chunk.text) === 'c') c2.abort() })
  assert.equal(r2.outcome, 'error')
  assert.equal(r2.code, 'ABORTED')
  await sleep(100)
  assert.equal(posts(server)[1].marks.closedBeforeDone, true)
  // 3. last delta and [DONE] coalesced in one read, Stop issued synchronously on the delta: exactly one terminal outcome.
  mode = 'coalesced'
  const c3 = new AbortController()
  const r3 = await runToEnd(s, { signal: c3.signal, sessionId: 'stop-coalesced' }, (chunk) => { if (chunk.type === 'text-delta' && (chunk.delta ?? chunk.text) === 'c') c3.abort() })
  assert.ok(r3.outcome === 'finish' || (r3.outcome === 'error' && r3.code === 'ABORTED'), `coalesced: ${r3.outcome} ${r3.code ?? ''}`)
  assert.ok(r3.chunks.filter(chunk => chunk.type === 'finish').length <= 1)
  tc.diagnostic(`coalesced outcome: ${r3.outcome} ${r3.code ?? ''}`)
  await sleep(100)
  assert.equal(posts(server).length, 3, 'no request resent')
  const log = await readLog(s.config)
  assert.equal(log.length, 3, 'one log record per request (Stop after done adds none)')
  assert.equal(log[0].ok, true)
  assert.equal(log[1].code, 'ABORTED')
})

test('A8 Stop racing completion sweep: 24 abort offsets around [DONE]; every request ends exactly once (finish or ABORTED), one log record each, nothing resent', async (tc) => {
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('a'), omni.text('b'), omni.text('c'), omni.usage(), '[DONE]'], { delayMs: 2 })
  })
  tc.after(() => server.close())
  const s = await setup(server.url, { model: { outputAudio: false } })
  const outcomes = []
  for (let offset = 0; offset < 24; offset++) {
    const controller = new AbortController()
    const result = await runToEnd(s, { signal: controller.signal, sessionId: `race-${offset}` }, (chunk) => {
      if (chunk.type === 'text-delta' && (chunk.delta ?? chunk.text) === 'b') setTimeout(() => controller.abort(), offset)
    })
    controller.abort()
    outcomes.push(result.outcome === 'error' ? result.code : result.outcome)
    assert.ok(result.outcome === 'finish' || (result.outcome === 'error' && result.code === 'ABORTED'), `offset ${offset}: ${result.outcome} ${result.code ?? ''}`)
    assert.ok(result.chunks.filter(chunk => chunk.type === 'finish').length <= 1)
  }
  await sleep(100)
  tc.diagnostic(`outcomes by offset (ms): ${JSON.stringify(outcomes)}`)
  assert.equal(posts(server).length, 24)
  assert.equal((await readLog(s.config)).length, 24)
})

test('A9 recovery: after a crash the service returns; the failed request is never replayed and one explicit retry is one upstream request', async (tc) => {
  let crash = true
  const server = await scriptedServer(async (req, res) => {
    if (crash) { res.socket.destroy(); return }
    await writeSse(res, [omni.role(), omni.text('recovered'), '[DONE]'])
  })
  tc.after(() => server.close())
  const s = await setup(server.url, { model: { outputAudio: false } })
  const failed = await runToEnd(s)
  assert.equal(failed.outcome, 'error')
  await sleep(300)
  assert.equal(posts(server).length, 1, 'no automatic resend while the service is down')
  crash = false
  await sleep(300)
  assert.equal(posts(server).length, 1, 'recovery alone triggers no replay')
  const retried = await runToEnd(s)
  assert.equal(retried.outcome, 'finish')
  assert.equal(posts(server).length, 2)
  assert.deepEqual((await readLog(s.config)).map(entry => entry.ok), [false, true])
})
