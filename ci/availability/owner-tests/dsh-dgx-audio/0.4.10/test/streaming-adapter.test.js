// Adapter over real HTTP/SSE: incremental text, progressive vs final-only audio, cancellation,
// fallback for non-streaming servers, malformed streams. Scripted local servers only; this is
// mock-transport evidence, not proof of any live vLLM/vLLM-Omni server.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileHandleText } from '@deepseek-ai/dsh-llm'

import { DgxAudioAdapter } from '../src/adapter.js'
import { AudioHub } from '../src/audio-hub.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { resolveConfig } from '../src/config.js'
import { resolveRecordingId, sha256File } from '../src/recording.js'
import { collect, fakeStore, omni, pcm16, scriptedServer, sleep, tempDir, wav, wavFromPcm, writeSse } from './helpers/fixtures.js'

async function setup(server, modelOverrides = {}, configOverrides = {}) {
  const outDir = await tempDir('dgx-audio-out-')
  const config = resolveConfig({
    outputDir: outDir,
    ...configOverrides,
    routes: [{ provider: 'p', displayName: 'P', baseURL: server.url, models: [{ id: 'omni', sendModalities: true, outputAudio: true, ...modelOverrides }] }],
  })
  const hub = new AudioHub({ outputDir: () => config.outputDir, limits: { pingMs: 60_000 } })
  const capabilities = new CapabilityRegistry({ file: () => config.capabilityFile })
  const input = wav(0.3)
  const fx = await fakeStore(input, 'question.wav')
  const adapter = new DgxAudioAdapter({ config: () => config, attachments: () => fx.store, log: () => {}, hub: () => hub, capabilities })
  const route = config.routes[0]
  const request = (extra = {}) => ({
    provider: 'p', model: modelOverrides.id ?? 'omni', sessionId: 'sess-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }, { type: 'text', text: 'Answer' }] }],
    ...extra,
  })
  return { config, hub, capabilities, adapter, route, model: route.models[0], request, fx, input, outDir }
}

async function readLog(config) {
  return (await readFile(config.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

/** Collect the hub feed for a session in the background. */
function watchFeed(hub, sessionId) {
  const events = []
  const controller = new AbortController()
  const done = (async () => {
    for await (const event of hub.subscribe(sessionId, { signal: controller.signal })) events.push({ ...event, receivedAt: performance.now() })
  })()
  return { events, stop: async () => { controller.abort(); await done } }
}

test('text deltas reach the Harness stream while the server is still generating', async () => {
  let serverDoneAt
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('One '), omni.text('two '), omni.text('three.'), omni.usage(), '[DONE]'], {
      delayMs: 150,
      onEach: (i) => { if (i === 5) serverDoneAt = performance.now() },
    })
  })
  const s = await setup(server, { outputAudio: false })
  const arrivals = []
  for await (const chunk of s.adapter.stream(s.request())) {
    if (chunk.type === 'text-delta') arrivals.push({ text: chunk.text, at: performance.now() })
  }
  await server.close()
  const sent = server.calls[0].json
  assert.equal(sent.stream, true)
  assert.deepEqual(sent.stream_options, { include_usage: true })
  assert.deepEqual(sent.modalities, ['text'])
  assert.deepEqual(arrivals.slice(0, 3).map(a => a.text), ['One ', 'two ', 'three.'])
  assert.ok(arrivals[0].at < serverDoneAt - 400, `first delta ${arrivals[0].at} must precede server [DONE] ${serverDoneAt} by the scripted gaps`)
  const log = (await readLog(s.config))[0]
  assert.equal(log.transport, 'sse')
  assert.equal(log.timeline.textDeltas, 3)
  assert.ok(log.timeline.firstTextMs < log.timeline.doneMs)
  assert.equal(s.capabilities.describe(s.route, s.model).textStreaming.state, 'verified')
  assert.equal(s.capabilities.describe(s.route, s.model).audioOutput.state, 'unsupported') // model entry requests no speech
})

test('network fragmentation and coalescing do not change the decoded result', async () => {
  const payloads = [omni.role(), omni.text('分段'), omni.text(' stream ✓'), omni.usage(), '[DONE]']
  const variants = {
    byteByByte: bytes => [...bytes].map(b => Buffer.of(b)),
    threeWay: bytes => [bytes.subarray(0, 3), bytes.subarray(3, 17), bytes.subarray(17)],
  }
  const texts = []
  for (const [name, split] of Object.entries(variants)) {
    const server = await scriptedServer(async (req, res) => { await writeSse(res, payloads, { split, crlf: name === 'threeWay' }) })
    const s = await setup(server, { outputAudio: false }, { annotate: false })
    const chunks = await collect(s.adapter.stream(s.request()))
    await server.close()
    texts.push(chunks.find(c => c.type === 'block-end').block.text)
  }
  // Coalesced: every event in one write.
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join(''))
  })
  const s = await setup(server, { outputAudio: false }, { annotate: false })
  texts.push((await collect(s.adapter.stream(s.request()))).find(c => c.type === 'block-end').block.text)
  await server.close()
  assert.deepEqual(texts, ['分段 stream ✓', '分段 stream ✓', '分段 stream ✓'])
})

test('progressive audio: WAV-per-chunk payloads are published before completion and recorded coherently', async () => {
  const pcmParts = [pcm16(0.2, 24000, 300), pcm16(0.2, 24000, 500), pcm16(0.2, 24000, 700)]
  let doneAt
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('Speaking'), omni.textStop(), ...pcmParts.map((p, i) => omni.audio(wavFromPcm(p, 24000), i === 2 ? 'stop' : null)), omni.usage(), '[DONE]'], {
      delayMs: 200,
      onEach: (i) => { if (i === 7) doneAt = performance.now() },
    })
  })
  const s = await setup(server)
  const feed = watchFeed(s.hub, 'sess-1')
  const chunks = await collect(s.adapter.stream(s.request()))
  await sleep(20)
  await feed.stop()
  await server.close()

  assert.deepEqual(server.calls[0].json.modalities, ['text', 'audio'])
  const types = feed.events.map(e => e.type)
  assert.deepEqual(types.filter(t => t !== 'hello'), ['audio.start', 'audio.format', 'audio.chunk', 'audio.chunk', 'audio.chunk', 'audio.end'])
  const audioChunks = feed.events.filter(e => e.type === 'audio.chunk')
  assert.deepEqual(audioChunks.map(c => c.seq), [0, 1, 2])
  assert.deepEqual(audioChunks.map(c => c.startSample), [0, 4800, 9600])
  assert.ok(audioChunks[0].receivedAt < doneAt - 300, 'first audio chunk must be published well before the terminal event')
  const end = feed.events.find(e => e.type === 'audio.end')
  assert.equal(end.delivery, 'progressive')
  assert.equal(end.status, 'completed')
  assert.equal(end.chunks, 3)
  // The persisted recording equals the concatenated PCM (no per-chunk headers, no gaps).
  const path = resolveRecordingId(s.config.outputDir, end.recording.recordingId)
  const saved = await readFile(path)
  assert.equal(saved.equals(wavFromPcm(Buffer.concat(pcmParts), 24000)), true)
  assert.equal(end.recording.sha256, await sha256File(path))
  assert.equal(end.recording.durationSeconds, 0.6)
  assert.ok(!('path' in end.recording), 'client events never carry filesystem paths')
  // Footer links the portable recording route and states the delivery honestly.
  const text = chunks.find(c => c.type === 'block-end').block.text
  assert.match(text, /^Speaking/)
  assert.match(text, /audio out \(progressive, 3 payloads\)/)
  assert.match(text, /\]\(\/api\/dsh-dgx-audio\/v1\/recording\?id=r1\.[A-Za-z0-9_-]+\)/)
  assert.doesNotMatch(text, /Users|tmp|路徑/)
  const caps = s.capabilities.describe(s.route, s.model)
  assert.equal(caps.audioOutput.state, 'verified')
  assert.equal(caps.audioOutputStreaming.state, 'verified')
  assert.equal(caps.audioOutputStreaming.observedDelivery, 'progressive')
  const log = (await readLog(s.config))[0]
  assert.equal(log.timeline.audioPayloads, 3)
  assert.ok(log.timeline.firstAudioMs < log.timeline.doneMs - 300)
})

test('final-only audio (Qwen2.5-Omni without async_chunk): one WAV at the end is not called streaming', async () => {
  const reply = pcm16(0.5, 24000)
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('The '), omni.text('answer.'), omni.textStop(), omni.audio(wavFromPcm(reply, 24000), 'stop'), omni.usage(), '[DONE]'], { delayMs: 100 })
  })
  const s = await setup(server)
  const feed = watchFeed(s.hub, 'sess-1')
  const chunks = await collect(s.adapter.stream(s.request()))
  await sleep(20)
  await feed.stop()
  await server.close()
  const end = feed.events.find(e => e.type === 'audio.end')
  assert.equal(end.delivery, 'final-only')
  assert.equal(end.chunks, 1)
  const text = chunks.find(c => c.type === 'block-end').block.text
  assert.match(text, /audio out \(final-only, 1 payload\)/)
  assert.doesNotMatch(text, /streamed audio reply/)
  const caps = s.capabilities.describe(s.route, s.model)
  // 0.4.9 (§K.15): two text deltas 100 ms apart are a burst, not text streaming (was 'verified' up to 0.4.8).
  assert.equal(caps.textStreaming.state, 'untested')
  assert.equal(caps.audioOutput.state, 'verified')
  assert.equal(caps.audioOutputStreaming.state, 'untested')
  assert.equal(caps.audioOutputStreaming.observedDelivery, 'final-only')
})

test('cancel mid-stream aborts the HTTP request, ends the audio stream and keeps only a partial recording', async () => {
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('Start'), ...Array.from({ length: 20 }, () => omni.audio(wavFromPcm(pcm16(0.1, 24000), 24000))), '[DONE]'], { delayMs: 100 })
  })
  const s = await setup(server)
  const feed = watchFeed(s.hub, 'sess-1')
  const controller = new AbortController()
  const seen = []
  await assert.rejects(async () => {
    for await (const chunk of s.adapter.stream(s.request({ signal: controller.signal }))) {
      seen.push(chunk.type)
      if (chunk.type === 'text-delta') setTimeout(() => controller.abort(), 250)
    }
  }, e => e.code === 'ABORTED')
  await sleep(100)
  await feed.stop()
  await server.close()
  assert.equal(server.calls[0].clientClosed, true, 'server must observe the client closing the connection')
  assert.equal(server.calls[0].finished, false)
  const end = feed.events.find(e => e.type === 'audio.end')
  assert.equal(end.status, 'cancelled')
  assert.ok(end.chunks >= 1 && end.chunks < 20)
  assert.equal(end.recording, undefined, 'cancelled streams expose no completed recording')
  const files = await readdir(join(s.config.outputDir, 'sess-1'))
  assert.ok(files.every(f => !f.endsWith('.part')), 'no dangling .part files')
  assert.ok(files.some(f => f.endsWith('.partial.wav')))
  const log = (await readLog(s.config)).at(-1)
  assert.equal(log.ok, false)
  assert.equal(log.code, 'ABORTED')
  assert.ok(!seen.includes('finish'))
})

test('consumer that stops reading early releases the upstream connection', async () => {
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.role(), ...Array.from({ length: 50 }, (_, i) => omni.text(`t${i} `)), '[DONE]'], { delayMs: 50 })
  })
  const s = await setup(server, { outputAudio: false })
  for await (const chunk of s.adapter.stream(s.request())) { if (chunk.type === 'text-delta') break }
  await sleep(150)
  await server.close()
  assert.equal(server.calls[0].clientClosed, true)
  assert.equal((await readLog(s.config)).at(-1).code, 'ABORTED')
})

test('non-streaming APIs keep working: refused stream is retried once as a complete request and remembered', async () => {
  const replyWav = wav(0.2, 24000)
  const server = await scriptedServer(async (req, res, call) => {
    if (call.json.stream) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stream is not supported for this model' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { content: 'full answer', audio: { data: replyWav.toString('base64') } }, finish_reason: 'stop' }] }))
  })
  const s = await setup(server)
  const first = await collect(s.adapter.stream(s.request()))
  const second = await collect(s.adapter.stream(s.request()))
  await server.close()
  assert.deepEqual(server.calls.map(c => c.json.stream), [true, false, false])
  for (const chunks of [first, second]) {
    const text = chunks.find(c => c.type === 'block-end').block.text
    assert.match(text, /^full answer/)
    assert.match(text, /complete response/)
    assert.match(text, /final-only, 1 payload/)
  }
  // Input attachment bytes are preserved byte-for-byte in the complete request too.
  const audioPart = server.calls[2].json.messages[0].content.find(p => p.type === 'input_audio')
  assert.equal(Buffer.from(audioPart.input_audio.data, 'base64').equals(s.input), true)
  assert.equal(s.capabilities.describe(s.route, s.model).textStreaming.state, 'unsupported')
  const logs = await readLog(s.config)
  assert.equal(logs[0].retriedWithoutStream, true)
  assert.equal(logs[1].transport, 'json')
})

test('streaming.text "off" never sends stream:true', async () => {
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }] }))
  })
  const s = await setup(server, { outputAudio: false, streaming: { text: 'off' } })
  await collect(s.adapter.stream(s.request()))
  await server.close()
  assert.equal(server.calls[0].json.stream, false)
  assert.equal(server.calls[0].json.stream_options, undefined)
  assert.equal(s.capabilities.describe(s.route, s.model).textStreaming.state, 'unsupported')
})

test('malformed, truncated, oversized and error streams fail with specific codes and no finish chunk', async () => {
  const cases = [
    ['MALFORMED_STREAM', async (req, res) => { await writeSse(res, [omni.text('a'), '{oops']) }, {}],
    ['STREAM_CLOSED', async (req, res) => { await writeSse(res, [omni.text('a'), omni.text('b')]) }, {}],
    ['SERVER', async (req, res) => { await writeSse(res, [omni.text('a'), { error: { message: 'engine died', code: 500 } }]) }, {}],
    ['STREAM_LIMIT', async (req, res) => { await writeSse(res, [omni.text('x'.repeat(5000)), '[DONE]']) }, { sseLimits: { maxLineChars: 1024, maxEventChars: 1024 } }],
  ]
  for (const [code, handler, configOverrides] of cases) {
    const server = await scriptedServer(handler)
    const s = await setup(server, { outputAudio: false }, configOverrides)
    const seen = []
    await assert.rejects(async () => { for await (const c of s.adapter.stream(s.request())) seen.push(c.type) }, e => e.code === code, code)
    await server.close()
    assert.ok(!seen.includes('finish'), code)
    assert.equal((await readLog(s.config)).at(-1).code, code)
  }
})

test('unplayable audio payloads are reported, not mislabeled as text or crashed on', async () => {
  const server = await scriptedServer(async (req, res) => {
    await writeSse(res, [omni.text('hi'), { choices: [{ index: 0, delta: { content: Buffer.from('ID3 not a wav').toString('base64') } }], modality: 'audio' }, '[DONE]'])
  })
  const s = await setup(server, { audioFormat: 'mp3' })
  const chunks = await collect(s.adapter.stream(s.request()))
  await server.close()
  const text = chunks.find(c => c.type === 'block-end').block.text
  assert.match(text, /^hi/)
  assert.doesNotMatch(text, /SUQz/) // base64 never leaks into the transcript
  const log = (await readLog(s.config))[0]
  assert.equal(log.audioErrors.length, 1)
  assert.equal(server.calls[0].json.audio.format, 'mp3')
})
