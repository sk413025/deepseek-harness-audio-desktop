// 0.4.9 (TASK_CONTRACT §K.15): streamed speech evidence for the MiMo-Audio demo. Host arrival time + sample statistics
// of every per-chunk WAV, text delta arrivals classified honestly (one final chunk is not text streaming), and a client
// playback report stored beside them. Mock transport only; real Desktop playback is judged by the verdict script.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { createAudioPlugin } from '../src/index.js'
import { collect, omni, pcm16, scriptedServer, tempDir, wavFromPcm, writeSse } from './helpers/fixtures.js'

const PREFIX = '/api/dsh-dgx-audio/v1'

/** IEEE float 32-bit WAV (what soundfile writes for subtype FLOAT), with values beyond full scale. */
function floatWav(samples, rate) {
  const data = Buffer.alloc(samples.length * 4)
  samples.forEach((v, i) => data.writeFloatLE(v, i * 4))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

async function plugin(t, handler) {
  const server = await scriptedServer(handler)
  t.after(() => server.close())
  const outputDir = await tempDir('dgx-049-')
  const p = createAudioPlugin({
    rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes: [{ provider: 'dgx', displayName: 'DGX', baseURL: server.url, models: [{ id: 'mimo', upstreamModel: 'XiaomiMiMo/MiMo-Audio-7B-Instruct', mode: 'chat', outputAudio: true, sendModalities: true }] }] },
    log: () => {},
  })
  await p.ready
  t.after(() => p.dispose())
  const readLog = async () => (await readFile(p.config().invocationLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  const call = async (body, raw) => {
    const route = p.routes().find(r => r.path === `${PREFIX}/audio/playback`)
    const res = await route.fetch(new Request(`http://h${PREFIX}/audio/playback`, { method: 'POST', body: raw ?? JSON.stringify(body) }))
    return { status: res.status, body: await res.json() }
  }
  const ask = () => collect(p.adapter.stream({ provider: 'dgx', model: 'mimo', sessionId: 's-049', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
  return { p, server, readLog, call, ask }
}

test('progressive MiMo-like SSE: every per-chunk WAV (PCM16 and float32) is logged with host arrival time, contiguous samples and quality stats; text deltas logged apart from the footer', async (t) => {
  const c0 = pcm16(0.2, 24000, 300)
  const c1 = floatWav(Array.from({ length: 4800 }, (_, i) => (i < 100 ? 1.5 : 0.25 * Math.sin(i / 7))), 24000)
  const c2 = pcm16(0.2, 24000, 500)
  const h = await plugin(t, async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('今天'), omni.audio(wavFromPcm(c0, 24000)), omni.text('天气'), omni.audio(c1), omni.audio(wavFromPcm(c2, 24000), 'stop'), omni.usage(), '[DONE]'], { delayMs: 150 })
  })
  const chunks = await h.ask()
  const [log] = await h.readLog()
  const st = log.stream

  assert.equal(st.clock, 'host-epoch-ms')
  assert.ok(st.requestSentAt <= st.responseHeadersAt && st.responseHeadersAt <= st.text.firstAt)
  assert.deepEqual([st.text.deltas, st.text.chars, st.text.delivery], [2, 4, 'progressive'], 'the evidence footer is not a model text delta')
  assert.ok(st.text.arrivals[1][0] - st.text.arrivals[0][0] >= 250)

  const a = st.audio
  assert.match(a.streamId, /^as_/)
  assert.deepEqual(a.arrivals.map(x => x.seq), [0, 1, 2])
  assert.deepEqual(a.arrivals.map(x => x.startSample), [0, 4800, 9600], 'headers stripped, samples contiguous in order')
  assert.deepEqual(a.arrivals.map(x => x.sampleRate), [24000, 24000, 24000])
  assert.ok(a.arrivals[0].t < a.arrivals[1].t && a.arrivals[1].t < a.arrivals[2].t)
  assert.equal(a.arrivals[0].boundaryJump, null)
  assert.equal(typeof a.arrivals[1].boundaryJump, 'number')
  assert.equal(a.arrivals[0].clipped, 0)
  assert.equal(a.arrivals[1].clipped, 100, 'float samples beyond full scale are clamped and counted')
  assert.equal(a.quality.clippedSamples, 100)
  assert.ok(a.quality.clippedRatio > 0 && a.quality.clippedRatio < 0.01)
  assert.equal(a.delivery, 'progressive')
  assert.ok(a.firstChunkAt < a.terminalAt - 250)
  assert.equal(st.terminalAt, a.terminalAt)
  assert.equal(a.totalSamples, 14400)
  assert.match(chunks.find(c => c.type === 'block-end').block.text, /^今天天气/)
})

test('one final text chunk is `single`, several at once `burst`: neither is text streaming; audio chunks still logged', async (t) => {
  const h = await plugin(t, async (req, res) => {
    await writeSse(res, [omni.role(), omni.audio(wavFromPcm(pcm16(0.2, 24000), 24000)), omni.audio(wavFromPcm(pcm16(0.2, 24000), 24000)), omni.text('The whole answer at the end.'), omni.usage(), '[DONE]'], { delayMs: 200 })
  })
  await h.ask()
  const [log] = await h.readLog()
  assert.equal(log.stream.text.delivery, 'single')
  assert.equal(log.stream.audio.arrivals.length, 2)
  const caps = h.p.capabilities.describe(h.p.config().routes[0], h.p.config().routes[0].models[0])
  assert.notEqual(caps.textStreaming.state, 'verified')
  const { classifyTextDelivery } = await import('../src/adapter.js')
  assert.equal(typeof classifyTextDelivery, 'function', 'text delivery classifier exported')
  assert.equal(classifyTextDelivery([[1000, 3], [1100, 4], [1200, 2]]), 'burst')
  assert.equal(classifyTextDelivery([[1000, 3], [1300, 4]]), 'progressive')
  assert.equal(classifyTextDelivery([]), 'none')
})

test('playback report: stored as record "playback" with the host stream facts; unknown stream 404 and malformed reports 400 record nothing', async (t) => {
  const h = await plugin(t, async (req, res) => {
    await writeSse(res, [omni.role(), omni.text('a'), omni.audio(wavFromPcm(pcm16(0.2, 24000), 24000)), omni.audio(wavFromPcm(pcm16(0.2, 24000), 24000), 'stop'), '[DONE]'], { delayMs: 150 })
  })
  await h.ask()
  const [inv] = await h.readLog()
  const streamId = inv.stream.audio.streamId
  const first = inv.stream.audio.arrivals[0].t
  const events = [
    { type: 'scheduled', at: first + 5, seq: 0, startSample: 0, samples: 4800, whenAt: first + 105 },
    { type: 'position', at: first + 200, playedSamples: 2280 },
    { type: 'ended', at: first + 600, playedSamples: 9600 },
  ]
  const ok = await h.call({ v: 1, sessionId: 's-049', streamId, client: { plugin: 'dsh-voice-capture@test', outputLatencyMs: 12, clockSource: 'getOutputTimestamp' }, events })
  assert.deepEqual(ok, { status: 200, body: { ok: true, recorded: true, part: 1 } })
  const unknown = await h.call({ v: 1, sessionId: 's-049', streamId: 'as_nope', events })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error?.code ?? unknown.body.code, 'STREAM_UNKNOWN')
  for (const bad of [
    { v: 2, sessionId: 's-049', streamId, events },
    { v: 1, sessionId: 's-049', streamId, events: [] },
    { v: 1, sessionId: 's-049', streamId, events: [{ type: 'position', at: first }] },
    { v: 1, sessionId: 's-049', streamId, events: [{ type: 'teleport', at: first }] },
    { v: 1, sessionId: 's-049', streamId, events: [{ type: 'ended', at: 5 }] },
  ]) assert.equal((await h.call(bad)).status, 400, JSON.stringify(bad.events))
  assert.equal((await h.call(undefined, 'not json')).status, 400)

  const lines = await h.readLog()
  assert.deepEqual(lines.map(l => l.record), ['invocation', 'playback'], 'refused reports are not recorded')
  const pb = lines[1]
  assert.deepEqual([pb.invocation, pb.sessionId, pb.streamId, pb.model, pb.origin, pb.part], [false, 's-049', streamId, 'mimo', 'chat', 1])
  assert.deepEqual([pb.host.ended, pb.host.status, pb.host.delivery, pb.host.chunks, pb.host.totalSamples, pb.host.firstChunkAt], [true, 'completed', 'progressive', 2, 9600, first])
  assert.deepEqual(pb.events, events)
  assert.equal(pb.client.outputLatencyMs, 12)
})
