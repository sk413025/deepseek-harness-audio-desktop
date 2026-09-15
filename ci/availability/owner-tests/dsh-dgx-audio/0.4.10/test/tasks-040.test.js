// dsh-dgx-audio 0.4.0 task wires (TASK_CONTRACT.md v0.2) against scripted local servers. Mock-transport evidence
// only: every wire shape below comes from pinned vLLM 2cf0a691 / vLLM-Omni eb11446b sources, not from a live model.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileHandleText } from '@deepseek-ai/dsh-llm'

import { createAudioPlugin } from '../src/index.js'
import { PcmStreamFramer, wavHeader } from '../src/pcm.js'
import { resolveRecordingId } from '../src/recording.js'
import { collect, fakeStore, pcm16, scriptedServer, sleep, tempDir, wav, wavFromPcm } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

const streamingWavHeader = (rate) => { const h = wavHeader({ encoding: 'pcm_s16le', sampleRate: rate, channels: 1 }, 0); h.writeUInt32LE(0xFFFFFFFF, 4); h.writeUInt32LE(0xFFFFFFFF, 40); return h }

async function makePlugin(routes, extra = {}) {
  const outputDir = await tempDir('dgx-040-')
  const fx = extra.store
  const plugin = createAudioPlugin({ rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes }, log: () => {}, attachments: () => fx?.store, fileUploads: extra.fileUploads })
  const events = []
  const controller = new AbortController()
  const done = (async () => { for await (const e of plugin.hub.subscribe(extra.sessionId ?? 's-040', { signal: controller.signal })) events.push({ ...e, atMs: performance.now() }) })()
  const call = async (path, init) => {
    const route = plugin.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://127.0.0.1:3080${path}`, init))
    return { status: res.status, body: await res.json() }
  }
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
  const readLog = async () => (await readFile(plugin.config().invocationLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  const stop = async () => { await plugin.live.closeAll('test'); controller.abort(); await done; plugin.dispose() }
  return { plugin, events, call, post, readLog, stop, outputDir }
}

const userMsg = (...blocks) => ({ role: 'user', content: blocks.map(b => (typeof b === 'string' ? { type: 'text', text: b } : b)) })

test('PcmStreamFramer: header-only first chunk, header split across bytes, odd-byte carry, float32 WAV, headerless pcm needs a rate', () => {
  const pcm = pcm16(0.01, 24000)
  const bytes = Buffer.concat([streamingWavHeader(24000), pcm])
  const byteByByte = new PcmStreamFramer({ format: 'wav' })
  const out = []
  for (const b of bytes) { const f = byteByByte.push(Buffer.of(b)); if (f) out.push(f.pcm) }
  assert.equal(Buffer.concat(out).equals(pcm), true)
  assert.equal(byteByByte.format.sampleRate, 24000)
  const headerOnly = new PcmStreamFramer({ format: 'wav' })
  assert.equal(headerOnly.push(streamingWavHeader(22050)), undefined)
  assert.equal(headerOnly.format.sampleRate, 22050)
  assert.equal(headerOnly.push(Buffer.from([1, 0, 2])).pcm.length, 2)
  assert.equal(headerOnly.leftoverBytes, 1)
  const floats = Buffer.alloc(8); floats.writeFloatLE(0.5, 0); floats.writeFloatLE(-0.5, 4)
  const fh = wavHeader({ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }, 8); fh.writeUInt16LE(3, 20); fh.writeUInt16LE(32, 34)
  assert.deepEqual([...new Int16Array(new Uint8Array(new PcmStreamFramer({ format: 'wav' }).push(Buffer.concat([fh, floats])).pcm).buffer)], [16384, -16384])
  assert.throws(() => new PcmStreamFramer({ format: 'pcm' }).push(pcm), e => e.code === 'MALFORMED_AUDIO')
  assert.equal(new PcmStreamFramer({ format: 'pcm', sampleRate: 24000 }).push(pcm).format.sampleRate, 24000)
  assert.throws(() => new PcmStreamFramer({ format: 'wav' }).push(Buffer.from('ID3xxxxxxxxxxxx')), e => e.code === 'MALFORMED_AUDIO')
})

test('tts.speech SSE: header-only first delta then PCM deltas stream progressively; reference clip, ref_text and session params reach the wire', async (tc) => {
  const parts = [pcm16(0.2, 24000, 300), pcm16(0.2, 24000, 500), pcm16(0.2, 24000, 700)]
  let doneAt
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('speech.audio.delta', { type: 'speech.audio.delta', audio: streamingWavHeader(24000).toString('base64'), response_format: 'wav' })
    for (const p of parts) { await sleep(150); send('speech.audio.delta', { type: 'speech.audio.delta', audio: p.toString('base64'), response_format: 'wav' }) }
    doneAt = performance.now()
    send('speech.audio.done', { type: 'speech.audio.done', usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42, input_token_details: { text_tokens: 10, audio_tokens: 20 } } })
    res.end()
  })
  tc.after(() => server.close())
  const ref = wav(0.5, 16000)
  const fx = await fakeStore(ref, 'my voice.wav')
  const t = await makePlugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.url, models: [{ id: 'qwen3-tts-base', upstreamModel: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', mode: 'speech', speech: { taskType: 'Base', refAudio: 'attachment', refText: 'prompt-prefix' } }] }], { store: fx })
  tc.after(() => t.stop())
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-040', provider: 'tts', model: 'qwen3-tts-base', params: { language: 'English', instructions: 'calm' } })).status, 200)
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-040', provider: 'tts', model: 'qwen3-tts-base', params: { bogus: 1 } })).status, 400)
  const chunks = await collect(t.plugin.adapter.stream({ provider: 'tts', model: 'qwen3-tts-base', sessionId: 's-040', messages: [userMsg({ type: 'text', text: fileHandleText(fx.ref, fx.path) }, 'This is the reference transcript.\n\nHello from the cloned voice.')] }))
  await sleep(20)
  const body = server.calls[0].json
  assert.equal(body.input, 'Hello from the cloned voice.')
  assert.equal(body.ref_text, 'This is the reference transcript.')
  assert.equal(Buffer.from(body.ref_audio.split(',')[1], 'base64').equals(ref), true)
  assert.match(body.ref_audio, /^data:audio\/wav;base64,/)
  assert.deepEqual([body.stream, body.stream_format, body.response_format, body.task_type, body.language, body.instructions], [true, 'sse', 'wav', 'Base', 'English', 'calm'])
  const chunkEvents = t.events.filter(e => e.type === 'audio.chunk')
  assert.equal(chunkEvents.length, 3, 'the header-only delta produces no chunk')
  assert.ok(chunkEvents[0].atMs < doneAt - 200)
  const end = t.events.find(e => e.type === 'audio.end')
  assert.equal(end.delivery, 'progressive')
  assert.equal(t.events.find(e => e.type === 'audio.start').task, 'tts.speech')
  const saved = await readFile(resolveRecordingId(t.outputDir, end.recording.recordingId))
  assert.equal(saved.equals(wavFromPcm(Buffer.concat(parts), 24000)), true)
  const text = chunks.find(c => c.type === 'block-end').block.text
  assert.match(text, /^Speech generated · Base · 0\.6 s\./)
  assert.match(text, /task parameters: instructions=calm · language=English · taskType=Base · responseFormat=wav · refAudio=[0-9a-f]{64}/)
  const log = (await t.readLog()).at(-1)
  assert.equal(log.transport, 'sse')
  assert.equal(log.inputAudio[0].sha256, fx.digest)
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 30, outputTokens: 12, totalTokens: 42 })
  assert.equal(t.plugin.capabilities.describe(t.plugin.config().routes[0], t.plugin.config().routes[0].models[0]).audioOutputStreaming.state, 'verified')
})

test('tts.speech raw byte stream split mid-sample, non-stream binary, stream refusal fallback, error event, truncation, cancel', async (tc) => {
  const pcm = pcm16(0.3, 24000)
  const wire = Buffer.concat([streamingWavHeader(24000), pcm])
  let mode = 'raw'
  const server = await scriptedServer(async (req, res, call) => {
    const b = call.json
    if (mode === 'refuse' && b.stream) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Streaming requires response_format pcm or wav' } })); return }
    if (mode === 'error') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: speech.audio.error\ndata: ${JSON.stringify({ type: 'speech.audio.error', error: { message: 'talker crashed', code: 500 } })}\n\n`); return }
    if (mode === 'truncate') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: speech.audio.delta\ndata: ${JSON.stringify({ type: 'speech.audio.delta', audio: wire.toString('base64') })}\n\n`); return }
    if (b.stream_format === 'audio') {
      res.writeHead(200, { 'content-type': 'audio/wav' })
      for (let i = 0; i < wire.length; i += 1001) { if (res.destroyed) return; res.write(wire.subarray(i, i + 1001)); await sleep(mode === 'slow' ? 60 : 40) }
      res.end(); return
    }
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wavFromPcm(pcm, 24000))
  })
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.url, models: [
    { id: 'raw', upstreamModel: 'tts', mode: 'speech', streaming: { audio: 'raw' }, speech: { voice: 'vivian' } },
    { id: 'off', upstreamModel: 'tts', mode: 'speech', streaming: { audio: 'off' } },
    { id: 'auto', upstreamModel: 'tts', mode: 'speech' },
  ] }])
  tc.after(() => t.stop())
  const req = (model, extra = {}) => ({ provider: 'tts', model, sessionId: 's-040', messages: [userMsg('Speak this.')], ...extra })
  await collect(t.plugin.adapter.stream(req('raw')))
  let ends = t.events.filter(e => e.type === 'audio.end')
  assert.equal(ends.at(-1).delivery, 'progressive')
  assert.equal(server.calls[0].json.stream_format, 'audio')
  assert.equal(server.calls[0].json.voice, 'vivian')
  assert.equal((await readFile(resolveRecordingId(t.outputDir, ends.at(-1).recording.recordingId))).subarray(44).equals(pcm), true)
  await collect(t.plugin.adapter.stream(req('off')))
  ends = t.events.filter(e => e.type === 'audio.end')
  assert.equal(ends.at(-1).delivery, 'final-only')
  assert.equal(server.calls[1].json.stream, undefined)
  mode = 'refuse'
  const first = await collect(t.plugin.adapter.stream(req('auto')))
  assert.match(first.find(c => c.type === 'block-end').block.text, /complete response/)
  await collect(t.plugin.adapter.stream(req('auto')))
  assert.deepEqual(server.calls.slice(2).map(c => c.json.stream ?? false), [true, false, false], 'refused once, retried once, remembered')
  mode = 'error'
  await assert.rejects(collect(t.plugin.adapter.stream(req('raw', { model: 'auto' }))), e => e.code === 'SERVER' && /talker crashed/.test(e.message))
  mode = 'truncate'
  t.plugin.capabilities.reset([{ route: t.plugin.config().routes[0], model: t.plugin.config().routes[0].models[2] }])
  await assert.rejects(collect(t.plugin.adapter.stream(req('auto'))), e => e.code === 'STREAM_CLOSED')
  mode = 'slow'
  const controller = new AbortController()
  await assert.rejects(async () => {
    for await (const c of t.plugin.adapter.stream(req('raw', { signal: controller.signal }))) { void c }
  }, e => e.code === 'ABORTED').catch(() => {})
  const pending = collect(t.plugin.adapter.stream(req('raw', { signal: controller.signal })))
  await sleep(150)
  controller.abort()
  await assert.rejects(pending, e => e.code === 'ABORTED')
  await sleep(80)
  assert.equal(server.calls.at(-1).clientClosed, true)
  assert.equal(t.events.filter(e => e.type === 'audio.end').at(-1).status, 'cancelled')
})

test('asr.translate SSE deltas; transcription verbose_json/srt render without streaming; auxiliary title on a speech route is local', async (tc) => {
  const server = await scriptedServer(async (req, res, call) => {
    const form = call.body.toString('latin1')
    if (req.url.endsWith('/audio/translations')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const w of ['Hello ', 'world.']) res.write(`data: ${JSON.stringify({ id: 'trsl-1', object: 'translation.chunk', model: 'whisper', choices: [{ delta: { content: w } }] })}\n\n`)
      res.end('data: [DONE]\n\n'); return
    }
    if (form.includes('verbose_json')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'hi there', language: 'en', segments: [{ start: 0, end: 1.25, text: ' hi' }, { start: 1.25, end: 2.5, text: ' there' }] })); return }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('1\n00:00:00,000 --> 00:00:01,000\nhi\n')
  })
  tc.after(() => server.close())
  const clip = wav(0.3)
  const fx = await fakeStore(clip, 'q.wav')
  const t = await makePlugin([{ provider: 'asr', displayName: 'ASR', baseURL: server.url, models: [
    { id: 'whisper-translate', upstreamModel: 'openai/whisper-large-v3', mode: 'translate', asr: { toLanguage: 'en' } },
    { id: 'whisper-verbose', upstreamModel: 'openai/whisper-large-v3', mode: 'transcribe', asr: { responseFormat: 'verbose_json', timestampGranularities: ['segment'] } },
    { id: 'whisper-srt', upstreamModel: 'openai/whisper-large-v3', mode: 'transcribe', asr: { responseFormat: 'srt' } },
    { id: 'tts', mode: 'speech' },
  ] }], { store: fx })
  tc.after(() => t.stop())
  const req = model => ({ provider: 'asr', model, sessionId: 's-040', messages: [userMsg({ type: 'text', text: fileHandleText(fx.ref, fx.path) })] })
  const tr = await collect(t.plugin.adapter.stream(req('whisper-translate')))
  assert.deepEqual(tr.filter(c => c.type === 'text-delta').slice(0, 2).map(c => c.text), ['Hello ', 'world.'])
  assert.equal(server.calls[0].url, '/v1/audio/translations')
  const f0 = server.calls[0].body.toString('latin1')
  assert.match(f0, /name="to_language"\r\n\r\nen/)
  assert.match(f0, /name="stream"\r\n\r\ntrue/)
  const verbose = await collect(t.plugin.adapter.stream(req('whisper-verbose')))
  const f1 = server.calls[1].body.toString('latin1')
  assert.doesNotMatch(f1, /name="stream"/)
  assert.match(f1, /name="timestamp_granularities\[\]"\r\n\r\nsegment/)
  assert.match(verbose.find(c => c.type === 'block-end').block.text, /^hi there\n\n- \[0:00\.00–0:01\.25\] hi\n- \[0:01\.25–0:02\.50\] there/)
  const srt = await collect(t.plugin.adapter.stream(req('whisper-srt')))
  assert.match(srt.find(c => c.type === 'block-end').block.text, /^```srt\n1\n00:00:00,000 --> 00:00:01,000\nhi\n```/)
  const calls = server.calls.length
  const title = await collect(t.plugin.adapter.stream({ provider: 'asr', model: 'tts', purpose: 'session-title', messages: [userMsg('Read the weather report aloud please')] }))
  assert.equal(server.calls.length, calls, 'auxiliary calls on non-chat routes never reach the server')
  assert.equal(title.find(c => c.type === 'block-end').block.text, 'Read the weather report aloud please')
})

test('audio.generate raw stream with diffusion params from session params; activation gate refuses cold models', async (tc) => {
  const pcm = pcm16(0.4, 44100)
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    const wire = Buffer.concat([streamingWavHeader(44100), pcm])
    for (let i = 0; i < wire.length; i += 8000) { res.write(wire.subarray(i, i + 8000)); await sleep(80) }
    res.end()
  })
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'gen', displayName: 'Gen', baseURL: server.url, models: [{ id: 'stable-audio', upstreamModel: 'stabilityai/stable-audio-open-1.0', mode: 'generate-audio' }] }])
  tc.after(() => t.stop())
  await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-040', provider: 'gen', model: 'stable-audio', params: { audioLength: 5, seed: 42, numInferenceSteps: 50, negativePrompt: 'noise' } })
  const chunks = await collect(t.plugin.adapter.stream({ provider: 'gen', model: 'stable-audio', sessionId: 's-040', messages: [userMsg('rain on a tin roof')] }))
  const body = server.calls[0].json
  assert.deepEqual([body.input, body.stream_format, body.audio_length, body.seed, body.num_inference_steps, body.negative_prompt], ['rain on a tin roof', 'audio', 5, 42, 50, 'noise'])
  assert.equal(t.events.find(e => e.type === 'audio.end').delivery, 'progressive')
  assert.match(chunks.find(c => c.type === 'block-end').block.text, /^Audio generated · 0\.4 s\./)
  const doc = await t.call('/api/dsh-dgx-audio/v1/capabilities')
  const m = doc.body.routes[0].models[0]
  assert.deepEqual([m.task, m.wire, m.output.text, m.output.audio, m.activation.state], ['audio.generate', 'omni-audio-generate', false, true, 'ready'])
  assert.equal(m.capabilities.textStreaming.state, 'unsupported')
  // A library-supplied route is cold until activated.
  const source = t.plugin.service.registerRouteSource('library', [{ provider: 'lib', displayName: 'Lib', baseURL: server.url, models: [{ id: 'gen2', mode: 'generate-audio' }] }])
  await source.ready
  await assert.rejects(collect(t.plugin.adapter.stream({ provider: 'lib', model: 'gen2', sessionId: 's-040', messages: [userMsg('x')] })), e => e.code === 'MODEL_NOT_READY')
  assert.equal(server.calls.length, 1, 'a cold model never reaches the server')
})

function vllmRealtimeServer({ omniTurn = false } = {}) {
  const log = []
  const promise = wsServer((conn) => {
    conn.send({ type: 'session.created', id: 'sess-abc', created: 1 }) // sent on accept, before any client message
    let generating = false
    let appended = 0
    let turn = 0
    conn.onMessage(async (m) => {
      log.push(m)
      if (m.type === 'session.update') { if (typeof m.model !== 'string' || m.session !== undefined) conn.send({ type: 'error', error: 'Missing required field: model', code: 'invalid_event' }); return }
      if (m.type === 'input_audio_buffer.commit' && m.final === false) { generating = true; appended = 0; turn += 1; return }
      if (m.type === 'input_audio_buffer.append') {
        if (!generating) { conn.send({ type: 'error', error: 'not generating', code: 'processing_error' }); return }
        appended += 1
        if (appended === 2 || appended === 4) conn.send({ type: 'transcription.delta', delta: `t${turn}w${appended} ` })
        if (omniTurn && (appended === 3 || appended === 5)) conn.send({ type: 'response.audio.delta', audio: pcm16(0.1, 24000).toString('base64'), sample_rate_hz: 24000 })
        return
      }
      if (m.type === 'input_audio_buffer.commit' && m.final === true) {
        generating = false
        await sleep(30)
        if (omniTurn) { conn.send({ type: 'response.audio.delta', audio: pcm16(0.1, 24000).toString('base64'), sample_rate_hz: 24000 }); await sleep(300) }
        conn.send({ type: 'transcription.done', text: `turn ${turn} final`, usage: { prompt_tokens: 5 } })
        if (omniTurn) conn.send({ type: 'response.audio.done' })
        return
      }
      conn.send({ type: 'error', error: `Unknown event type: ${m.type}`, code: 'unknown_event' })
    })
  })
  return { log, promise }
}

test('asr.realtime (vLLM realtime wire): flat session.update, commit(final=false) per turn, transcript deltas before input end, no duplex claims', async (tc) => {
  const backend = vllmRealtimeServer()
  const server = await backend.promise
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'rt', displayName: 'RT', baseURL: server.baseURL, models: [{ id: 'voxtral-rt', upstreamModel: 'mistralai/Voxtral-Mini-4B-Realtime-2602', mode: 'realtime', realtime: { wire: 'vllm-asr' } }] }])
  tc.after(() => t.stop())
  const opened = await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-040', provider: 'rt', model: 'voxtral-rt', task: 'asr.realtime' })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  assert.deepEqual([opened.body.task, opened.body.wire], ['asr.realtime', 'vllm-asr'])
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-040', provider: 'rt', model: 'voxtral-rt', task: 'duplex' })).status, 409)
  const { liveId } = opened.body
  const append = (seq) => t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  for (let seq = 0; seq < 5; seq++) { assert.equal((await append(seq)).status, 200); await sleep(20) }
  assert.equal((await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'commit' })).status, 200)
  await sleep(120)
  assert.equal((await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'barge-in' })).body.error.code, 'UNSUPPORTED_CAPABILITY')
  for (let seq = 5; seq < 9; seq++) await append(seq) // second turn restarts generation
  await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'commit' })
  await sleep(120)
  assert.deepEqual(backend.log.slice(0, 2).map(m => [m.type, m.model ?? m.final]), [['session.update', 'mistralai/Voxtral-Mini-4B-Realtime-2602'], ['input_audio_buffer.commit', false]])
  assert.equal(backend.log.filter(m => m.type === 'input_audio_buffer.commit' && m.final === false).length, 2)
  assert.deepEqual(Object.keys(backend.log.find(m => m.type === 'input_audio_buffer.append')).sort(), ['audio', 'type'])
  const deltas = t.events.filter(e => e.type === 'text.delta')
  assert.deepEqual(deltas.map(d => [d.kind, d.text]), [['transcript', 't1w2 '], ['transcript', 't1w4 '], ['transcript', 't2w2 '], ['transcript', 't2w4 ']])
  assert.deepEqual(t.events.filter(e => e.type === 'live.transcript.done').map(e => e.text), ['turn 1 final', 'turn 2 final'])
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  assert.equal(closed.transcripts[0].deltasBeforeInputEnd, 2)
  assert.ok(!backend.log.some(m => m.type === 'session.close'), 'no unknown session.close on this wire')
  const caps = t.plugin.capabilities.describe(t.plugin.config().routes[0], t.plugin.config().routes[0].models[0])
  assert.deepEqual([caps.textStreaming.state, caps.liveInput.state, caps.fullDuplex.state, caps.audioOutput.state, caps.bargeIn.state], ['verified', 'verified', 'unsupported', 'unsupported', 'unsupported'])
})

test('speech.s2s.realtime (Qwen3-Omni turn wire): response.audio.delta{audio} streams progressively; never labeled duplex', async (tc) => {
  const backend = vllmRealtimeServer({ omniTurn: true })
  const server = await backend.promise
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'rt', displayName: 'RT', baseURL: server.baseURL, models: [{ id: 'qwen3-omni-rt', upstreamModel: 'Qwen/Qwen3-Omni-30B-A3B-Instruct', mode: 'realtime', realtime: { wire: 'omni-turn' } }] }])
  tc.after(() => t.stop())
  const { liveId, task } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-040', provider: 'rt', model: 'qwen3-omni-rt' })).body
  assert.equal(task, 'speech.s2s.realtime')
  for (let seq = 0; seq < 6; seq++) { await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) }); await sleep(120) }
  await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'commit' })
  await sleep(500)
  const end = t.events.find(e => e.type === 'audio.end')
  assert.deepEqual([end.streamId, end.status, end.chunks, end.delivery], ['turn-1', 'completed', 3, 'progressive'])
  assert.ok(t.events.filter(e => e.type === 'text.delta').every(d => d.kind === 'response'))
  const caps = t.plugin.capabilities.describe(t.plugin.config().routes[0], t.plugin.config().routes[0].models[0])
  assert.deepEqual([caps.audioOutputStreaming.state, caps.fullDuplex.state], ['verified', 'unsupported'])
})

test('duplex float32 profile (Nemotron/PersonaPlex style): host converts pcm16 frames to pcm_f32le at the declared rate', async (tc) => {
  const received = []
  const server = await wsServer((conn) => {
    conn.onMessage((m) => {
      received.push(m)
      if (m.type === 'session.update') conn.send({ type: 'session.created', incarnation: 0, resume_token: 't', session: { id: 'srv', capabilities: { implementation_level: 'model_native_duplex', supports_barge_in: false } } })
      if (m.type === 'input_audio_buffer.append' && received.filter(x => x.type === 'input_audio_buffer.append').length === 2) {
        conn.send({ type: 'response.created', response: { id: 'r1' } })
        conn.send({ type: 'response.audio.delta', response_id: 'r1', delta: pcm16(0.08, 22050).toString('base64'), format: 'pcm16', sample_rate_hz: 22050 })
      }
    })
  })
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'nv', displayName: 'NV', baseURL: server.baseURL, models: [{ id: 'nemotron', mode: 'realtime', realtime: { inputEncoding: 'pcm_f32le', inputSampleRate: 16000, frameMs: 80, outputSampleRate: 22050, session: { modalities: ['audio', 'text'], input_audio_format: 'pcm_f32le' } } }] }])
  tc.after(() => t.stop())
  const opened = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-040', provider: 'nv', model: 'nemotron' })).body
  assert.deepEqual([opened.input.frameMs, opened.input.wireEncoding, opened.input.encoding], [80, 'pcm_f32le', 'pcm_s16le'])
  const frame = Buffer.alloc(2560); frame.writeInt16LE(16384, 0); frame.writeInt16LE(-32768, 2)
  for (let seq = 0; seq < 3; seq++) await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${opened.liveId}&seq=${seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: frame })
  await sleep(100)
  const append = received.find(m => m.type === 'input_audio_buffer.append')
  assert.deepEqual([append.format, append.sample_rate_hz, append.duration_ms], ['pcm_f32le', 16000, 80])
  const f32 = Buffer.from(append.audio, 'base64')
  assert.equal(f32.length, 5120)
  assert.deepEqual([f32.readFloatLE(0), f32.readFloatLE(4)], [0.5, -1])
  const fmt = t.events.find(e => e.type === 'audio.format')
  assert.equal(fmt.sampleRate, 22050)
})

test('tts.stream-input (vLLM-Omni /v1/audio/speech/stream): session.config, input.text/input.done, binary PCM frames per sentence', async (tc) => {
  const received = []
  const server = await wsServer((conn) => {
    conn.onMessage(async (m) => {
      received.push(m)
      if (m.type === 'input.done') {
        conn.send({ type: 'audio.start', utterance_index: 0, sentence_index: 0, sentence_text: 'Hello there.', format: 'pcm', sample_rate: 24000 })
        const pcm = pcm16(0.3, 24000)
        conn.sendBinary(pcm.subarray(0, 4801)) // odd split
        await sleep(200)
        conn.sendBinary(pcm.subarray(4801, 9600))
        await sleep(200)
        conn.sendBinary(pcm.subarray(9600))
        conn.send({ type: 'audio.done', utterance_index: 0, sentence_index: 0, total_bytes: pcm.length, error: false })
        conn.send({ type: 'session.done', utterance_index: 0, total_sentences: 1 })
      }
    })
  })
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.baseURL, models: [{ id: 'qwen3-tts-stream', upstreamModel: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', mode: 'realtime', realtime: { wire: 'omni-speech-ws', session: { voice: 'vivian' } } }] }])
  tc.after(() => t.stop())
  const opened = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-040', provider: 'tts', model: 'qwen3-tts-stream' })).body
  assert.deepEqual([opened.task, opened.input.encoding], ['tts.stream-input', 'text'])
  assert.equal((await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${opened.liveId}&seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.1) })).status, 409)
  await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'Hello ' })
  await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'there.', done: true })
  await sleep(600)
  assert.deepEqual(received.map(m => m.type), ['session.config', 'input.text', 'input.text', 'input.done'])
  assert.deepEqual([received[0].response_format, received[0].stream_audio, received[0].voice, received[0].model], ['pcm', true, 'vivian', 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'])
  const end = t.events.find(e => e.type === 'audio.end')
  assert.deepEqual([end.streamId, end.status, end.delivery, end.totalSamples], ['utt-0', 'completed', 'progressive', 7200])
  assert.equal(t.events.find(e => e.type === 'text.delta').text, 'Hello there.')
})

test('dshAudio service: route source + activation, busy/drain, A→B→A switch closes stale live sessions, resets evidence and params', async (tc) => {
  let slow = true
  const httpServer = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let i = 0; i < (slow ? 20 : 2); i++) { if (res.destroyed) return; res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `w${i} ` } }], modality: 'text' })}\n\n`); await sleep(50) }
    res.end('data: [DONE]\n\n')
  })
  tc.after(() => httpServer.close())
  const wsBackend = await wsServer((conn) => {
    conn.onMessage((m) => { if (m.type === 'session.update') conn.send({ type: 'session.created', incarnation: 0, resume_token: 't', session: { id: 'srv', capabilities: { implementation_level: 'model_native_duplex' } } }) })
  })
  tc.after(() => wsBackend.close())
  const t = await makePlugin([])
  tc.after(() => t.stop())
  const svc = t.plugin.service
  const notices = []
  svc.subscribe(e => notices.push(e.type))
  const routeA = [{ provider: 'dgx', displayName: 'DGX', baseURL: httpServer.url, models: [{ id: 'chat-a', upstreamModel: 'model-a' }, { id: 'live', mode: 'realtime', upstreamModel: 'duplex-a', realtime: { refAudioFile: undefined } }] }]
  routeA[0].models[1].realtime = { query: {} }
  const liveBase = { ...routeA[0], baseURL: wsBackend.baseURL }
  const source = svc.registerRouteSource('model-library', [{ ...routeA[0], models: [routeA[0].models[0]] }, { ...liveBase, provider: 'dgx-live', models: [routeA[0].models[1]] }])
  await source.ready
  assert.throws(() => svc.registerRouteSource('model-library', []), /already registered/)
  assert.throws(() => svc.registerRouteSource('other', [{ provider: 'dgx', displayName: 'x', baseURL: 'http://h/v1', models: [{ id: 'm' }] }]), /duplicate provider/)
  assert.deepEqual(t.plugin.config().routes.map(r => r.provider), ['dgx', 'dgx-live'], 'a refused source leaves routes untouched')
  const req = { provider: 'dgx', model: 'chat-a', sessionId: 's-040', messages: [userMsg('hi')] }
  await assert.rejects(collect(t.plugin.adapter.stream(req)), e => e.code === 'MODEL_NOT_READY')
  svc.setActivation('dgx', 'chat-a', { state: 'ready', runtime: { image: 'vllm-omni:0.28.0' } })
  svc.setActivation('dgx-live', 'live', { state: 'ready' })
  await sleep(20)
  assert.deepEqual(t.events.filter(e => e.type === 'model.state').map(e => [e.provider, e.state]), [['dgx', 'ready'], ['dgx-live', 'ready']])
  const opened = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-040', provider: 'dgx-live', model: 'live' })).body
  assert.ok(opened.liveId)
  // busy + drain without cancel waits for the in-flight request
  const inflight = collect(t.plugin.adapter.stream(req))
  await sleep(120)
  const busy = svc.busy('dgx')
  assert.equal(busy.chatRequests, 1)
  assert.equal(svc.busy('dgx-live').liveSessions, 1)
  let drained = false
  const drain = svc.drain('dgx').then(r => { drained = r.drained })
  await sleep(100)
  assert.equal(drained, false, 'drain waits for active work')
  await assert.rejects(collect(t.plugin.adapter.stream(req)), e => e.code === 'MODEL_NOT_READY')
  await inflight
  await drain
  assert.equal(drained, true)
  // drain with cancel aborts in-flight work
  svc.setActivation('dgx', 'chat-a', { state: 'ready' })
  const cancelled = collect(t.plugin.adapter.stream(req))
  await sleep(100)
  await svc.drain('dgx', { cancel: true })
  await assert.rejects(cancelled, e => e.code === 'ABORTED' && /switched or unloaded/.test(e.message))
  // evidence + params belong to A
  const [rA] = t.plugin.config().routes
  t.plugin.capabilities.observe(rA, rA.models[0], 'textStreaming', { state: 'verified', source: 'request' })
  await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-040', provider: 'dgx-live', model: 'live', params: { voice: 'x' } })
  // A → B: same provider ids, different model/runtime
  await source.replace([{ ...routeA[0], models: [{ id: 'chat-a', upstreamModel: 'model-b' }] }, { ...liveBase, provider: 'dgx-live', models: [{ id: 'live', mode: 'realtime', upstreamModel: 'duplex-b', realtime: { query: {} } }] }])
  await sleep(50)
  const closedEvt = t.events.find(e => e.type === 'live.state' && e.state === 'closed' && e.liveId === opened.liveId)
  assert.equal(closedEvt.error.code, 'MODEL_SWITCHED')
  const [rB] = t.plugin.config().routes
  assert.equal(t.plugin.capabilities.describe(rB, rB.models[0]).textStreaming.state, 'untested', 'no evidence leaks from model A to model B')
  assert.equal(t.plugin.sessionParams.get('s-040', 'dgx-live', 'live'), undefined)
  assert.equal(svc.describe().routes[0].models[0].upstreamModel, 'model-b')
  // B → A: A's own evidence is still keyed to A; reset removes it
  await source.replace([{ ...routeA[0], models: [routeA[0].models[0]] }, { ...liveBase, provider: 'dgx-live', models: [routeA[0].models[1]] }])
  const [rA2] = t.plugin.config().routes
  assert.equal(t.plugin.capabilities.describe(rA2, rA2.models[0]).textStreaming.state, 'verified')
  assert.equal(svc.resetCapabilities('dgx', 'chat-a').removed, 1)
  assert.equal(t.plugin.capabilities.describe(rA2, rA2.models[0]).textStreaming.state, 'untested')
  await source.dispose()
  assert.deepEqual(t.plugin.config().routes, [])
  assert.ok(notices.includes('routes-changed') && notices.includes('activation') && notices.includes('capabilities'))
})

test('voices passthrough and session-params validation', async (tc) => {
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ voices: ['vivian', 'ryan'], uploaded_voices: [{ name: 'mine', consent: 'secret-consent-id', created_at: 1, file_size: 10, ref_text: 'hello' }] }))
  })
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.url, models: [{ id: 'q', mode: 'speech' }, { id: 'c', mode: 'chat' }] }])
  tc.after(() => t.stop())
  const v = await t.call('/api/dsh-dgx-audio/v1/voices?provider=tts&model=q')
  assert.deepEqual(v.body.voices, ['vivian', 'ryan'])
  assert.deepEqual(v.body.uploadedVoices, [{ name: 'mine', createdAt: 1, refText: 'hello', speakerDescription: null }], 'consent ids are not forwarded to the UI')
  assert.equal(server.calls[0].url, '/v1/audio/voices')
  assert.equal((await t.call('/api/dsh-dgx-audio/v1/voices?provider=tts&model=c')).status, 409)
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's', provider: 'tts', model: 'q', params: { taskType: 'Nope' } })).status, 400)
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's', provider: 'tts', model: 'missing', params: {} })).status, 404)
  const ok = await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's', provider: 'tts', model: 'q', params: { voice: 'ryan', taskType: 'CustomVoice' } })
  assert.deepEqual(ok.body.params, { voice: 'ryan', taskType: 'CustomVoice' })
  const doc = (await t.call('/api/dsh-dgx-audio/v1/capabilities')).body.routes[0].models[0]
  assert.deepEqual(doc.params.map(p => p.key).sort(), ['ambientSound', 'durationSeconds', 'extraParams', 'initialCodecChunkFrames', 'instructions', 'language', 'maxNewTokens', 'nonStreamingMode', 'refText', 'responseFormat', 'sampleRate', 'seed', 'speed', 'taskType', 'voice', 'wordTimestamps', 'xVectorOnlyMode'])
  assert.equal(doc.params.find(p => p.key === 'voice').valuesFrom, '/api/dsh-dgx-audio/v1/voices?provider=tts&model=q')
  assert.deepEqual(doc.params.find(p => p.key === 'taskType'), { key: 'taskType', type: 'enum', values: ['CustomVoice', 'VoiceDesign', 'Base'] })
})

test('restart: capability evidence, live-turn bindings and recording links survive a plugin restart on the same output dir', async () => {
  const outputDir = await tempDir('dgx-restart-')
  const routes = [{ provider: 'p', displayName: 'P', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'tts', mode: 'speech' }] }]
  const first = createAudioPlugin({ rowConfig: { outputDir, routes }, log: () => {} })
  const [route] = first.config().routes
  first.capabilities.observe(route, route.models[0], 'audioOutputStreaming', { state: 'verified', source: 'request', observedDelivery: 'progressive' })
  const stream = first.hub.openStream({ sessionId: 'sess', provider: 'p', model: 'tts', origin: 'chat' })
  await stream.pushPcm(pcm16(0.1, 24000), { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  const { recording } = await stream.end('completed')
  await first.capabilities.saving
  first.dispose()
  const second = createAudioPlugin({ rowConfig: { outputDir, routes }, log: () => {} })
  await second.ready
  const [route2] = second.config().routes
  assert.equal(second.capabilities.describe(route2, route2.models[0]).audioOutputStreaming.state, 'verified')
  const res = await second.routes().find(r => r.path.endsWith('/recording')).fetch(new Request(`http://h${recording.url}`))
  assert.equal(res.status, 200)
  assert.equal(Buffer.from(await res.arrayBuffer()).length, recording.bytes)
  second.dispose()
})
