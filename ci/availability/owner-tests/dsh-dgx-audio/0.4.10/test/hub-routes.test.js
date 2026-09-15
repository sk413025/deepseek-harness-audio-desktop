// AudioHub bounding/reconnect semantics and the host Fetch routes (Request → Response).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { AudioHub, classifyDelivery } from '../src/audio-hub.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { resolveConfig } from '../src/config.js'
import { LiveSessionManager } from '../src/live.js'
import { createRouteHandlers, parseRange } from '../src/routes.js'
import { encodeRecordingId, resolveRecordingId } from '../src/recording.js'
import { apply } from '../src/index.js'
import { pcm16, sleep, tempDir, wavFromPcm } from './helpers/fixtures.js'

const fmt = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }

async function drainAvailable(iterator, count) {
  const out = []
  for (let i = 0; i < count; i++) out.push((await iterator.next()).value)
  return out
}

test('slow subscriber: oldest chunks become one audio.gap, control events survive, recording stays complete', async () => {
  const outDir = await tempDir()
  const hub = new AudioHub({ outputDir: () => outDir, limits: { subscriberItems: 6, subscriberBytes: 1 << 30, pingMs: 60_000 } })
  const slow = hub.subscribe('s')[Symbol.asyncIterator]()
  const stream = hub.openStream({ sessionId: 's', provider: 'p', model: 'm', origin: 'chat' })
  const parts = Array.from({ length: 12 }, (_, i) => pcm16(0.02, 24000, 200 + i * 50))
  for (const part of parts) await stream.pushPcm(part, fmt)
  const summary = await stream.end('completed')
  const events = []
  for (;;) {
    const { value } = await slow.next()
    events.push(value)
    if (value.type === 'audio.end') break
  }
  await slow.return()
  const types = events.map(e => e.type)
  assert.equal(types[0], 'hello')
  assert.ok(types.includes('audio.start') || types.includes('audio.gap'))
  assert.ok(types.includes('audio.end'))
  const gaps = events.filter(e => e.type === 'audio.gap')
  assert.ok(gaps.length >= 1)
  const delivered = events.filter(e => e.type === 'audio.chunk').map(e => e.seq)
  const skipped = gaps.flatMap(g => Array.from({ length: g.toSeq - g.fromSeq + 1 }, (_, i) => g.fromSeq + i))
  assert.deepEqual([...delivered, ...skipped].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i), 'every seq is either delivered or explicitly reported missing')
  assert.ok(events.length <= 8, 'subscriber buffer stayed bounded')
  // Persistence is independent of the UI drop.
  const saved = await readFile(summary.recordingPath)
  assert.equal(saved.equals(wavFromPcm(Buffer.concat(parts), 24000)), true)
  hub.dispose()
})

test('reconnect with after=cursor replays only newer events; expired backlog is an explicit gap; fresh join gets no old audio', async () => {
  const outDir = await tempDir()
  const hub = new AudioHub({ outputDir: () => outDir, limits: { backlogBytes: 1 << 30, pingMs: 60_000 } })
  const stream = hub.openStream({ sessionId: 's', provider: 'p', model: 'm', origin: 'live', responseId: 'resp_1' })
  await stream.pushPcm(pcm16(0.01, 24000), fmt)
  await stream.pushPcm(pcm16(0.01, 24000), fmt)
  const cursorAfterTwo = hub.feed('s').cursor
  await stream.pushPcm(pcm16(0.01, 24000), fmt)

  const resumed = hub.subscribe('s', { after: cursorAfterTwo })[Symbol.asyncIterator]()
  const [hello, third] = await drainAvailable(resumed, 2)
  assert.equal(hello.type, 'hello')
  assert.equal(third.type, 'audio.chunk')
  assert.equal(third.seq, 2)
  await resumed.return()

  const fresh = hub.subscribe('s')[Symbol.asyncIterator]()
  const joined = await drainAvailable(fresh, 3)
  assert.deepEqual(joined.map(e => e.type), ['hello', 'audio.start', 'audio.format'])
  await stream.pushPcm(pcm16(0.01, 24000), fmt)
  assert.equal((await fresh.next()).value.seq, 3)
  await fresh.return()

  hub.feed('s').backlog.splice(0, 3) // simulate expiry of the oldest retained events
  const late = hub.subscribe('s', { after: 1 })[Symbol.asyncIterator]()
  const [, gap] = await drainAvailable(late, 2)
  assert.equal(gap.type, 'audio.gap')
  assert.equal(gap.reason, 'backlog-expired')
  await late.return()
  stream.setEpoch(3, 'barge-in')
  assert.equal(hub.feed('s').backlog.at(-1).event.type, 'audio.epoch')
  await stream.end('cancelled')
  hub.dispose()
})

test('delivery classification and recording id validation', async () => {
  assert.equal(classifyDelivery({ chunks: 0, firstChunkAt: undefined, terminalAt: 10 }), 'none')
  assert.equal(classifyDelivery({ chunks: 1, firstChunkAt: 0, terminalAt: 5000 }), 'final-only')
  assert.equal(classifyDelivery({ chunks: 5, firstChunkAt: 900, terminalAt: 1000 }), 'final-only')
  assert.equal(classifyDelivery({ chunks: 2, firstChunkAt: 0, terminalAt: 1000 }), 'progressive')
  const root = await tempDir()
  assert.equal(resolveRecordingId(root, encodeRecordingId('../etc/passwd.wav')), undefined)
  assert.equal(resolveRecordingId(root, encodeRecordingId('/abs.wav')), undefined)
  assert.equal(resolveRecordingId(root, encodeRecordingId('s/x.txt')), undefined)
  assert.equal(resolveRecordingId(root, 'r1.$$$'), undefined)
  assert.ok(resolveRecordingId(root, encodeRecordingId('sess/日本 語.wav')).endsWith('日本 語.wav'))
  assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9])
  assert.deepEqual(parseRange('bytes=90-', 100), [90, 99])
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99])
  assert.equal(parseRange('bytes=200-', 100), 'invalid')
  assert.equal(parseRange('items=0-1', 100), 'invalid')
})

async function routesFor(configInput) {
  const config = resolveConfig({ outputDir: await tempDir(), ...configInput })
  const hub = new AudioHub({ outputDir: () => config.outputDir, limits: { pingMs: 60_000 } })
  const capabilities = new CapabilityRegistry({ file: () => undefined })
  const live = new LiveSessionManager({ config: () => config, hub, capabilities, log: () => {} })
  const routes = createRouteHandlers({ config: () => config, hub, capabilities, live, log: () => {} })
  const call = (path, init) => {
    const route = routes.find(r => r.path === path.split('?')[0])
    return route.fetch(new Request(`http://127.0.0.1:3080${path}`, init))
  }
  return { config, hub, capabilities, live, routes, call }
}

test('capabilities route: unconfigured install reports configured:false and contacts nothing', async () => {
  const r = await routesFor({})
  assert.deepEqual(r.routes.map(x => `${x.methods.join('|')} ${x.path}`), [
    'GET /api/dsh-dgx-audio/v1/capabilities',
    'POST /api/dsh-dgx-audio/v1/capabilities/probe',
    'GET /api/dsh-dgx-audio/v1/events',
    'GET|HEAD /api/dsh-dgx-audio/v1/recording',
    'POST /api/dsh-dgx-audio/v1/live/open',
    'POST /api/dsh-dgx-audio/v1/live/append',
    'POST /api/dsh-dgx-audio/v1/live/control',
    'POST /api/dsh-dgx-audio/v1/live/close',
    'POST /api/dsh-dgx-audio/v1/audio/playback',
    'POST /api/dsh-dgx-audio/v1/live/text',
    'POST /api/dsh-dgx-audio/v1/session-params',
    'GET /api/dsh-dgx-audio/v1/voices',
    'GET /api/dsh-dgx-audio/v1/activity',
    'GET|HEAD /api/dsh-dgx-audio/v1/result',
  ])
  const doc = await (await r.call('/api/dsh-dgx-audio/v1/capabilities')).json()
  const { PLUGIN_VERSION } = await import('../src/constants.js')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version, 'reported plugin version matches package.json')
  assert.deepEqual({ ...doc, adapterModes: undefined, realtimeWires: undefined }, { contractVersion: '0.1', taskContractVersion: '0.2', plugin: { name: 'dsh-dgx-audio', version: PLUGIN_VERSION }, configured: false, routes: [], adapterModes: undefined, realtimeWires: undefined })
  assert.deepEqual(doc.adapterModes, ['chat', 'transcribe', 'translate', 'speech', 'generate-audio', 'realtime', 'align', 'generate-video'])
})

test('capabilities route: states are layered per model and realtime models are separate from chat', async () => {
  const r = await routesFor({
    routes: [{
      provider: 'lab', displayName: 'Lab', baseURL: 'http://127.0.0.1:9/v1',
      models: [
        { id: 'omni-final', outputAudio: true, sendModalities: true },
        { id: 'asr', mode: 'transcribe' },
        { id: 'duplex', mode: 'realtime', upstreamModel: 'openbmb/MiniCPM-o-4_5', capabilities: { fullDuplex: true } },
      ],
    }],
  })
  const doc = await (await r.call('/api/dsh-dgx-audio/v1/capabilities')).json()
  const [omniDoc, asr, duplex] = doc.routes[0].models
  assert.equal(doc.configured, true)
  assert.equal(doc.routes[0].authentication, 'none')
  assert.equal(omniDoc.capabilities.textStreaming.state, 'untested')
  assert.equal(omniDoc.capabilities.liveInput.state, 'unsupported')
  assert.equal(asr.capabilities.audioOutput.state, 'unsupported')
  assert.equal(duplex.capabilities.fullDuplex.state, 'declared')
  assert.equal(duplex.capabilities.sessionResume.state, 'untested')
  assert.deepEqual({ ...duplex.input.recommended, wireEncoding: undefined }, { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, container: 'raw', frameMs: 200, wireEncoding: undefined })
  assert.equal(duplex.input.recommended.wireEncoding, 'pcm16')
  // A server handshake is advertised, never verified.
  r.capabilities.observe(r.config.routes[0], r.config.routes[0].models[2], 'fullDuplex', { state: 'advertised', source: 'server-session', implementationLevel: 'model_native_duplex' })
  const after = await (await r.call('/api/dsh-dgx-audio/v1/capabilities')).json()
  assert.equal(after.routes[0].models[2].capabilities.fullDuplex.state, 'advertised')
  assert.equal(after.routes[0].models[2].capabilities.fullDuplex.implementationLevel, 'model_native_duplex')
})

test('events route streams NDJSON live and stops generation-independent on client abort', async () => {
  const r = await routesFor({})
  const controller = new AbortController()
  const response = await r.call('/api/dsh-dgx-audio/v1/events?sessionId=s-1', { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const nextEvent = async () => {
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline >= 0) { const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); return JSON.parse(line) }
      const { value, done } = await reader.read()
      if (done) return undefined
      buffered += decoder.decode(value, { stream: true })
    }
  }
  assert.equal((await nextEvent()).type, 'hello')
  const stream = r.hub.openStream({ sessionId: 's-1', provider: 'p', model: 'm', origin: 'chat' })
  await stream.pushPcm(pcm16(0.01, 24000), fmt)
  assert.equal((await nextEvent()).type, 'audio.start')
  assert.equal((await nextEvent()).type, 'audio.format')
  const chunk = await nextEvent()
  assert.equal(chunk.type, 'audio.chunk')
  assert.equal(Buffer.from(chunk.data, 'base64').byteLength, 480)
  await reader.cancel()
  await sleep(10)
  assert.equal(r.hub.feed('s-1').subscribers.size, 0)
  await stream.pushPcm(pcm16(0.01, 24000), fmt) // generation continues without subscribers
  const summary = await stream.end('completed')
  assert.equal(summary.chunks, 2)
  assert.equal((await r.call('/api/dsh-dgx-audio/v1/events')).status, 400)
  assert.equal((await r.call('/api/dsh-dgx-audio/v1/events?sessionId=x&after=-1')).status, 400)
})

test('recording route serves WAV with Range/HEAD and rejects invalid ids', async () => {
  const r = await routesFor({})
  const stream = r.hub.openStream({ sessionId: 'sess ✓', provider: 'p', model: 'm', origin: 'chat' })
  await stream.pushPcm(pcm16(0.1, 24000), fmt)
  const { recording } = await stream.end('completed')
  const full = await r.call(recording.url)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'audio/wav')
  const body = Buffer.from(await full.arrayBuffer())
  assert.equal(body.byteLength, recording.bytes)
  const partial = await r.call(recording.url, { headers: { range: 'bytes=0-43' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 0-43/${recording.bytes}`)
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString('ascii', 0, 4), 'RIFF')
  const head = await r.call(recording.url, { method: 'HEAD' })
  assert.equal(head.headers.get('content-length'), String(recording.bytes))
  assert.equal((await r.call(recording.url, { headers: { range: 'bytes=999999-' } })).status, 416)
  assert.equal((await r.call(`/api/dsh-dgx-audio/v1/recording?id=${encodeRecordingId('../../secret.wav')}`)).status, 400)
  assert.equal((await r.call(`/api/dsh-dgx-audio/v1/recording?id=${encodeRecordingId('nope/missing.wav')}`)).status, 404)
})

test('probe route: reachability only on explicit call; unknown model is a 404 error body', async () => {
  const calls = []
  const config = resolveConfig({ outputDir: await tempDir(), routes: [{ provider: 'lab', displayName: 'Lab', baseURL: 'http://model.invalid/v1', models: [{ id: 'm1' }] }] })
  const hub = new AudioHub({ outputDir: () => config.outputDir })
  const capabilities = new CapabilityRegistry()
  const routes = createRouteHandlers({
    config: () => config, hub, capabilities, live: new LiveSessionManager({ config: () => config, hub, capabilities, log: () => {} }), log: () => {},
    fetch: async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }) },
  })
  await routes[0].fetch(new Request('http://h/api/dsh-dgx-audio/v1/capabilities'))
  assert.equal(calls.length, 0, 'reading capabilities never contacts the server')
  const probe = await routes[1].fetch(new Request('http://h/api/dsh-dgx-audio/v1/capabilities/probe', { method: 'POST', body: JSON.stringify({ provider: 'lab', model: 'm1', checks: ['reachability'] }) }))
  const body = await probe.json()
  assert.deepEqual(calls, ['http://model.invalid/v1/models'])
  assert.equal(body.probe.reachability.modelListed, true)
  const missing = await routes[1].fetch(new Request('http://h/x', { method: 'POST', body: JSON.stringify({ provider: 'lab', model: 'zzz' }) }))
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'UNKNOWN_ROUTE')
})

test('plugin apply: no private defaults, no adapter without routes, routes mounted only with Connection', async () => {
  const registered = []
  const adapters = []
  const effects = []
  let connectionCallback
  const ctx = {
    logger: { info: () => {} },
    llm: { registerAdapter: (providers, adapter) => { adapters.push(providers); return () => {} } },
    get: () => undefined,
    effect: (fn) => { effects.push(fn()) },
    inject: (deps, cb) => { if (deps[0] === 'connection') connectionCallback = cb; else assert.deepEqual(deps, ['settings']) },
  }
  apply(ctx, {})
  assert.equal(adapters.length, 0)
  connectionCallback({ ...ctx, connection: { fetch: { register: (route) => { registered.push(route.path); return async () => {} } } } })
  assert.equal(registered.length, 14) // 0.4.3: + result; 0.4.9: + audio/playback
  const config = resolveConfig({}, { env: { DSH_HOME: '/Users/someone else/家/.dsh' } })
  assert.equal(config.outputDir, '/Users/someone else/家/.dsh/dsh-dgx-audio/outputs')
  assert.deepEqual(config.routes, [])
  const source = await readFile(new URL('../src/config.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d|\/Users\/|\/home\//i, 'shipped defaults contain no site endpoint or home path')
  apply(ctx, { routes: [{ provider: 'lab', displayName: 'Lab', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'm' }, { id: 'd', mode: 'realtime' }] }] })
  assert.deepEqual(adapters, [['lab']])
  assert.throws(() => resolveConfig({ routes: [{ provider: 'x', displayName: 'X', baseURL: 'ftp://h', models: [{ id: 'm' }] }] }), /http\(s\)/)
  assert.throws(() => resolveConfig({ outputLink: 'web' }), /webBaseUrl/)
})
