// 0.4.3-dev: streamed text-to-speech receipts + replay, speech-stream session.config params (per session / per
// utterance) and word timestamps, durable result carrier (link line + GET result), voices normalization,
// requestOptions passthrough and session-params error keys. Mock transport only (mic HANDOFF_NEXT 04:12 §1–§4).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileHandleText } from '@deepseek-ai/dsh-llm'

import { createAudioPlugin } from '../src/index.js'
import { wavHeader } from '../src/pcm.js'
import { collect, fakeStore, pcm16, scriptedServer, sleep, tempDir } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

const RESULT_LINK = /\[🧾 ([^\]\n]{0,200}) result\]\(\/api\/dsh-dgx-audio\/v1\/result\?id=([A-Za-z0-9._~-]{1,200})\)/

async function makePlugin(routes, extra = {}) {
  const outputDir = extra.outputDir ?? await tempDir('dgx-043-')
  const plugin = createAudioPlugin({ rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes, ...extra.rowConfig }, log: () => {}, attachments: () => extra.store, fileUploads: () => extra.fileUploads })
  await plugin.ready
  const events = []
  const controller = new AbortController()
  const done = (async () => { try { for await (const e of plugin.hub.subscribe('s-043', { signal: controller.signal })) events.push({ ...e, atMs: performance.now() }) } catch { /* aborted */ } })()
  const call = async (path, init) => {
    const route = plugin.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://127.0.0.1:3080${path}`, init))
    const text = res.status === 204 || init?.method === 'HEAD' ? '' : await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
  const stop = async () => { await plugin.live.closeAll('test'); controller.abort(); await done; plugin.dispose() }
  return { plugin, events, call, post, stop, outputDir }
}

/** vLLM-Omni /v1/audio/speech/stream stand-in: sticky/replaceable session.config, per-sentence PCM, optional word timestamps. */
function speechStreamServer() {
  const received = []
  const state = { utteranceOpen: false, utterance: 0, config: undefined }
  const serverPromise = wsServer((conn) => {
    conn.onMessage(async (m) => {
      received.push(m)
      if (m.type === 'session.config') {
        if (state.utteranceOpen) { conn.send({ type: 'error', message: 'session.config cannot be applied while an utterance is in progress; send input.done first' }); return }
        state.config = m
      }
      if (m.type === 'input.text') state.utteranceOpen = true
      if (m.type === 'input.done') {
        const u = state.utterance
        state.utteranceOpen = false
        state.utterance += 1
        for (const [i, sentence] of ['Hello there.', ' Welcome.'].entries()) {
          conn.send({ type: 'audio.start', utterance_index: u, sentence_index: i, sentence_text: sentence, format: 'pcm', sample_rate: 24000 })
          if (state.config?.word_timestamps) {
            conn.send({ type: 'audio.chunk', utterance_index: u, sentence_index: i, chunk_id: 0, sample_rate: 24000, audio_b64: pcm16(0.5, 24000).toString('base64'), timestamps: null })
            conn.send({ type: 'audio.chunk', utterance_index: u, sentence_index: i, chunk_id: 1, sample_rate: 24000, audio_b64: '', timestamps: i === 0 ? [{ word: 'Hello', start_ms: 0, end_ms: 200 }, { word: 'there', start_ms: 220, end_ms: 480 }] : null })
          } else {
            conn.sendBinary(pcm16(0.5, 24000))
          }
          await sleep(30)
          conn.send({ type: 'audio.done', utterance_index: u, sentence_index: i })
        }
        conn.send({ type: 'session.done', utterance_index: u, total_sentences: 2 })
      }
    })
  })
  return serverPromise.then(server => Object.assign(server, { received }))
}

test('tts.stream-input: session params from session-params + live/open, per-utterance replacement, mid-utterance refusal, word timestamps', async (tc) => {
  const server = await speechStreamServer()
  tc.after(() => server.close())
  const t = await makePlugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.baseURL, models: [{ id: 'ws', upstreamModel: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', mode: 'realtime', realtime: { wire: 'omni-speech-ws' } }] }])
  tc.after(() => t.stop())
  const bad = await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-043', provider: 'tts', model: 'ws', params: { speed: 9 } })
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.key], [400, 'INVALID_PARAM', 'speed'])
  const unknown = await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-043', provider: 'tts', model: 'ws', params: { ambientSound: 'rain' } })
  assert.deepEqual([unknown.status, unknown.body.error.code, unknown.body.error.key], [400, 'UNKNOWN_PARAM', 'ambientSound'], 'the WS session has no ambient_sound')
  assert.equal((await t.post('/api/dsh-dgx-audio/v1/session-params', { sessionId: 's-043', provider: 'tts', model: 'ws', params: { voice: 'vivian', language: 'English' } })).status, 200)
  // Catalog R6: Base clone over WS needs ref_text unless x_vector_only_mode — both are per-session params.
  const opened = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-043', provider: 'tts', model: 'ws', params: { speed: 1.2, seed: 3, splitGranularity: 'sentence', taskType: 'Base', refText: 'Reference words.', xVectorOnlyMode: false } })).body
  assert.equal(opened.task, 'tts.stream-input')
  const first = server.received[0]
  assert.deepEqual([first.type, first.voice, first.language, first.speed, first.seed, first.split_granularity, first.response_format, first.stream_audio], ['session.config', 'vivian', 'English', 1.2, 3, 'sentence', 'pcm', true])
  assert.deepEqual([first.task_type, first.ref_text, first.x_vector_only_mode], ['Base', 'Reference words.', false])

  await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'Hello there. ' })
  const mid = await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'x', params: { speed: 0.8 } })
  assert.deepEqual([mid.status, mid.body.error.code], [409, 'UTTERANCE_IN_PROGRESS'])
  await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'Welcome.', done: true })
  await sleep(250)
  const next = await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'Hello there.', done: true, params: { wordTimestamps: true, speed: 0.9 } })
  assert.equal(next.status, 200)
  await sleep(300)
  const configs = server.received.filter(m => m.type === 'session.config')
  assert.equal(configs.length, 2, 'one replacement, sent before the second utterance text')
  assert.deepEqual([configs[1].voice, configs[1].speed, configs[1].seed, configs[1].word_timestamps], ['vivian', 0.9, 3, true], 'replacement keeps sticky session values')
  assert.ok(server.received.indexOf(configs[1]) < server.received.findLastIndex(m => m.type === 'input.text'))
  const words = t.events.filter(e => e.type === 'live.words')
  assert.deepEqual(words.map(w => w.state), ['aligned', 'failed'])
  assert.deepEqual(words[0].words, [{ word: 'Hello', startMs: 0, endMs: 200 }, { word: 'there', startMs: 220, endMs: 480 }])
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${opened.liveId}`, {})).body
  const second = closed.responses.find(r => r.responseId === 'utt-1')
  assert.deepEqual(second.wordTimestamps.map(w => w.state), ['aligned', 'failed'])
})

test('tts.stream-input close stages the accepted text as a receipt; the receipt replays with no model call, even on the Live-only model', async (tc) => {
  const server = await speechStreamServer()
  tc.after(() => server.close())
  const staged = []
  const fileUploads = {
    async uploadStream({ sessionId, data, name }) {
      const chunks = []
      for await (const c of data) chunks.push(c)
      const bytes = Buffer.concat(chunks)
      staged.push({ sessionId, name, bytes })
      return { receiptId: 'rcpt-text-1', file: { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name, bytes: bytes.byteLength } }
    },
  }
  const holder = {}
  const t = await makePlugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.baseURL, models: [{ id: 'ws', mode: 'realtime', realtime: { wire: 'omni-speech-ws' } }] }], { fileUploads, get store() { return holder.store } })
  tc.after(() => t.stop())
  const opened = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 's-043', provider: 'tts', model: 'ws' })).body
  await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'Hello there. ' })
  await t.post(`/api/dsh-dgx-audio/v1/live/text?liveId=${opened.liveId}`, { text: 'Welcome.', done: true })
  await sleep(300)
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${opened.liveId}`, {})).body
  assert.equal(staged.length, 1)
  assert.equal(staged[0].bytes.toString('utf8'), 'Hello there. Welcome.')
  assert.match(staged[0].name, /^live-text-.*\.txt$/)
  assert.deepEqual([closed.input.kind, closed.input.bytes, closed.input.sha256, closed.input.receiptId], ['text', staged[0].bytes.byteLength, createHash('sha256').update(staged[0].bytes).digest('hex'), 'rcpt-text-1'])
  assert.deepEqual(closed.receipt, { state: 'staged', receiptId: 'rcpt-text-1' })

  // The mic prompts that receipt; Harness turns it into a file handle in the pending user turn.
  const fx = await fakeStore(staged[0].bytes, staged[0].name)
  const request = { provider: 'tts', model: 'ws', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }] }] }
  // A store that returns different bytes under the same content-addressed handle is not trusted (and does not bind the turn).
  holder.store = { fileHostPath: fx.store.fileHostPath, async * readFileStream() { yield Buffer.from('Hello there. Welcome!', 'utf8') } }
  await assert.rejects(collect(t.plugin.adapter.stream(request)), e => e.code === 'UNSUPPORTED_OPTION' && /Live-only/.test(e.message))
  holder.store = fx.store
  const before = server.received.length
  const chunks = await collect(t.plugin.adapter.stream(request))
  assert.equal(server.received.length, before, 'no backend traffic')
  const text = chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n')
  assert.match(text, /^Hello there\. Welcome\./)
  assert.match(text, /streamed text-to-speech exchange `tts\/ws`/)
  const link = RESULT_LINK.exec(text)
  assert.equal(link[1], 'tts-stream')
  const result = (await t.call(`/api/dsh-dgx-audio/v1/result?id=${link[2]}`)).body
  assert.deepEqual([result.origin, result.adapterTask, result.input.kind, result.outputs.length, result.resultId], ['live-replay', 'tts.stream-input', 'text', 1, link[2]])
  // Bound once: the same receipt again is an ordinary request, which a Live-only model refuses.
  await assert.rejects(collect(t.plugin.adapter.stream(request)), e => e.code === 'UNSUPPORTED_OPTION' && /Live-only/.test(e.message))
})

test('result carrier: footer link line + durable GET/HEAD result; restart keeps it; invalid/unknown ids; fence on request', async (tc) => {
  const header = wavHeader({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }, 2400)
  const server = await scriptedServer(async (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(Buffer.concat([header, pcm16(0.05, 24000)])) })
  tc.after(() => server.close())
  const routes = [{ provider: 's', displayName: 'S', baseURL: server.url, models: [{ id: 'tts', mode: 'speech', streaming: { audio: 'off' } }] }]
  const t = await makePlugin(routes)
  const chunks = await collect(t.plugin.adapter.stream({ provider: 's', model: 'tts', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this aloud.' }] }] }))
  const text = chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n')
  assert.doesNotMatch(text, /```dsh-audio-result/, 'no fenced JSON in the conversation')
  const [, uiTask, id] = RESULT_LINK.exec(text)
  assert.equal(uiTask, 'tts')
  const got = await t.call(`/api/dsh-dgx-audio/v1/result?id=${id}`)
  assert.deepEqual([got.status, got.body.v, got.body.task, got.body.outputs[0].kind, got.body.resultId], [200, 1, 'tts', 'audio', id])
  const head = await t.call(`/api/dsh-dgx-audio/v1/result?id=${id}`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal((await t.call('/api/dsh-dgx-audio/v1/result?id=../../etc/passwd')).body.error.code, 'BAD_REQUEST')
  assert.equal((await t.call('/api/dsh-dgx-audio/v1/result?id=res_doesnotexist01')).body.error.code, 'RESULT_NOT_FOUND')
  await t.stop()
  const restarted = await makePlugin(routes, { outputDir: t.outputDir })
  tc.after(() => restarted.stop())
  assert.equal((await restarted.call(`/api/dsh-dgx-audio/v1/result?id=${id}`)).body.resultId, id, 'readable after a host restart')
  const fence = await makePlugin(routes, { rowConfig: { resultCarrier: 'fence' } })
  tc.after(() => fence.stop())
  const legacy = await collect(fence.plugin.adapter.stream({ provider: 's', model: 'tts', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: 'Again.' }] }] }))
  assert.match(legacy.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n'), /```dsh-audio-result\n/)
})

test('GET voices returns string[]; requestOptions pass through verbatim with clip-slot io facts', async (tc) => {
  const { normalizeVoiceNames } = await import('../src/routes.js')
  assert.equal(typeof normalizeVoiceNames, 'function', 'voices normalization is exported')
  assert.deepEqual(normalizeVoiceNames(['vivian', { name: 'ryan' }, { voice: 'aiden' }, { id: 'serena' }, 42, null, 'vivian', '']), ['vivian', 'ryan', 'aiden', 'serena'])
  const server = await scriptedServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ voices: [{ name: 'vivian', gender: 'f' }, 'ryan'], uploaded_voices: [{ name: 'mine', created_at: 5, ref_text: 'hi', consent: 'secret-id' }, { created_at: 1 }] }))
  })
  tc.after(() => server.close())
  const options = ['input', 'ref_audio (required)', 'ref_audio_2', 'extra_params.emo_audio', 'word_timestamps (needs --forced-aligner)', 'REJECTED: sample_rate']
  const t = await makePlugin([{ provider: 's', displayName: 'S', baseURL: server.url, models: [
    { id: 'ttsd', mode: 'speech', speech: { refAudio: 'attachment' }, requestOptions: options },
    { id: 'ttsd-map', mode: 'speech', speech: { refAudio: 'attachment' }, requestOptions: options, requestOptionsMap: options.slice(2, 5).map(raw => ({ option: raw.split(' ')[0], status: 'listed-by-source', raw })) },
    { id: 'plain', mode: 'speech' },
  ] }])
  tc.after(() => t.stop())
  const v = (await t.call('/api/dsh-dgx-audio/v1/voices?provider=s&model=ttsd')).body
  assert.deepEqual(v.voices, ['vivian', 'ryan'])
  assert.deepEqual(v.uploadedVoices, [{ name: 'mine', createdAt: 5, refText: 'hi', speakerDescription: null }])
  const doc = (await t.call('/api/dsh-dgx-audio/v1/capabilities')).body
  const ttsd = doc.routes[0].models.find(m => m.id === 'ttsd')
  const plain = doc.routes[0].models.find(m => m.id === 'plain')
  assert.deepEqual(ttsd.requestOptions, options, 'verbatim')
  // 0.4.6 (§K.11): raw strings alone are not classified; the clip slots come from requestOptionsMap statuses.
  assert.deepEqual([ttsd.io.input.referenceAudio2, ttsd.io.input.emotionAudio, ttsd.io.output.transcript.wordTimestamps], ['none', 'none', false])
  const mapped = doc.routes[0].models.find(m => m.id === 'ttsd-map')
  assert.deepEqual([mapped.io.input.referenceAudio2, mapped.io.input.emotionAudio, mapped.io.output.transcript.wordTimestamps], ['optional', 'optional', true])
  assert.equal('requestOptions' in plain, false)
  assert.deepEqual([plain.io.input.referenceAudio2, plain.io.input.emotionAudio, plain.io.output.transcript.wordTimestamps], ['none', 'none', false])
})

test('asr.align (vLLM /pooling Qwen3-ForcedAligner, STEP pooling): prompt/audio_url body at the server root, argmax × segment time, result link', async (tc) => {
  const bins = 8
  const onehot = i => Array.from({ length: bins }, (_, j) => (j === i ? 5 : 0))
  const server = await scriptedServer(async (req, res, call) => {
    if (req.url !== '/pooling') { res.writeHead(404); res.end(); return }
    const words = (call.json.messages[0].content[0].text.match(/<timestamp><timestamp>/g) ?? []).length
    res.writeHead(200, { 'content-type': 'application/json' })
    // word i: start bin i, end bin i+1
    res.end(JSON.stringify({ data: [{ data: Array.from({ length: words * 2 }, (_, k) => onehot(Math.floor(k / 2) + (k % 2))) }] }))
  })
  tc.after(() => server.close())
  const audio = (await import('./helpers/fixtures.js')).wav(1, 16000, 300)
  const fx = await fakeStore(audio, 'speech.wav')
  const t = await makePlugin([{ provider: 'fa', displayName: 'FA', baseURL: server.url, models: [{ id: 'aligner', upstreamModel: 'Qwen/Qwen3-ForcedAligner-0.6B-hf', mode: 'align', wire: 'vllm-pooling-forced-align', align: { timestampSegmentTime: 80 } }] }], { store: fx.store })
  tc.after(() => t.stop())
  const chunks = await collect(t.plugin.adapter.stream({ provider: 'fa', model: 'aligner', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }, { type: 'text', text: "Ask not, can't." }] }] }))
  const body = server.calls[0].json
  assert.equal(server.calls[0].url, '/pooling', 'root path, not /v1/pooling')
  assert.deepEqual([body.task, body.chat_template, body.messages[0].content[1].type], ['token_classify', "{{ messages[0]['content'] }}", 'audio_url'])
  assert.equal(body.messages[0].content[0].text, "<|audio_start|><|audio_pad|><|audio_end|>Ask<timestamp><timestamp>not<timestamp><timestamp>can't<timestamp><timestamp>")
  assert.ok(Buffer.from(body.messages[0].content[1].audio_url.url.split(',')[1], 'base64').equals(audio))
  const text = chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n')
  assert.match(text, /^- \[0\.000–0\.080\] Ask\n- \[0\.080–0\.160\] not\n- \[0\.160–0\.240\] can't/)
  const [, uiTask, id] = RESULT_LINK.exec(text)
  assert.equal(uiTask, 'alignment')
  const result = (await t.call(`/api/dsh-dgx-audio/v1/result?id=${id}`)).body
  assert.deepEqual([result.adapterTask, result.catalogTasks, result.wordTimestamps.words[2]], ['asr.align', ['timestamps'], { word: "can't", startMs: 160, endMs: 240 }])
  const doc = (await t.call('/api/dsh-dgx-audio/v1/capabilities')).body.routes[0].models[0]
  assert.deepEqual([doc.task, doc.uiTask, doc.wire, doc.io.input.audio, doc.io.input.text, doc.capabilities.textStreaming.state, doc.capabilities.audioOutput.state], ['asr.align', 'alignment', 'vllm-pooling-forced-align', 'required', 'required', 'unsupported', 'unsupported'])
  // Server started without STEP pooling → a count mismatch names the flag.
  server.server.removeAllListeners('request')
  server.server.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ data: [onehot(1)] }] })) })
  await assert.rejects(collect(t.plugin.adapter.stream({ provider: 'fa', model: 'aligner', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(fx.ref, fx.path) }, { type: 'text', text: 'Ask not' }] }] })), /STEP pooling/)
  assert.throws(() => t.plugin.service.registerRouteSource('x', [{ provider: 'fa2', displayName: 'x', baseURL: server.url, models: [{ id: 'a', mode: 'align' }] }]), /timestampSegmentTime/)
})

// Synthetic ISO-BMFF: ftyp + moov{ trak(vide avc1 WxH, mdhd) [+ trak(soun mp4a rate/ch, mdhd)] } + mdat.
function mp4({ width = 640, height = 360, seconds = 2, audio = { rate: 48000, channels: 2 } } = {}) {
  const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]) }
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b }
  const mdhd = timescale => box('mdhd', Buffer.alloc(12), u32(timescale), u32(timescale * seconds), Buffer.alloc(4))
  const hdlr = kind => box('hdlr', Buffer.alloc(8), Buffer.from(kind, 'latin1'), Buffer.alloc(12))
  const stsd = entry => box('stsd', Buffer.alloc(4), u32(1), entry)
  const video = () => { const e = Buffer.alloc(70); e.writeUInt16BE(width, 24); e.writeUInt16BE(height, 26); return box('trak', box('mdia', mdhd(24000), hdlr('vide'), box('minf', box('stbl', stsd(box('avc1', e)))))) }
  // Audio samples live in mdat after a 16-byte video filler: 3 samples in 2 chunks (2 + 1), sizes 5/7/9.
  const samples = [Buffer.from('aaaaa'), Buffer.from('bbbbbbb'), Buffer.from('ccccccccc')]
  const tables = mdatStart => [
    box('stsz', Buffer.alloc(4), u32(0), u32(3), u32(5), u32(7), u32(9)),
    box('stsc', Buffer.alloc(4), u32(2), u32(1), u32(2), u32(1), u32(2), u32(1), u32(1)),
    box('stco', Buffer.alloc(4), u32(2), u32(mdatStart + 8 + 16), u32(mdatStart + 8 + 16 + 12)),
  ]
  const sound = mdatStart => { const e = Buffer.alloc(28); e.writeUInt16BE(audio.channels, 16); e.writeUInt32BE(audio.rate * 65536, 24); return box('trak', box('mdia', mdhd(audio.rate), hdlr('soun'), box('minf', box('stbl', stsd(box('mp4a', e)), ...tables(mdatStart))))) }
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512))
  const mdatBody = Buffer.concat([Buffer.alloc(16, 0x76), ...samples, Buffer.alloc(8)])
  const moovLength = box('moov', video(), ...(audio ? [sound(0)] : [])).length // offsets have fixed width, so length is stable
  const mdatStart = ftyp.length + moovLength
  return Buffer.concat([ftyp, box('moov', video(), ...(audio ? [sound(mdatStart)] : [])), box('mdat', mdatBody)])
}
const AUDIO_SAMPLES_SHA256 = createHash('sha256').update('aaaaabbbbbbbccccccccc').digest('hex')

test('video.generate (vLLM-Omni /v1/videos): sync multipart with references, MP4 sound-track facts + sample sha256, recording route serves video/mp4, async job + cancel', async (tc) => {
  const { inspectMp4 } = await import('../src/mp4.js')
  assert.deepEqual(inspectMp4(mp4()).audioTrack, { present: true, codec: 'mp4a', sampleRate: 48000, channels: 2, durationSeconds: 2, sha256: AUDIO_SAMPLES_SHA256, samples: 3, sampleBytes: 21 })
  assert.deepEqual([inspectMp4(mp4({ audio: null })).audioTrack.present, inspectMp4(Buffer.from('not an mp4')).ok], [false, false])
  let jobPolls = 0
  const deleted = []
  const forms = []
  const server = await scriptedServer(async (req, res, call) => {
    if (req.method === 'POST' && (req.url === '/v1/videos/sync' || req.url === '/v1/videos')) {
      const form = await new Response(call.body, { headers: { 'content-type': req.headers['content-type'] } }).formData()
      forms.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])))
      if (req.url === '/v1/videos/sync') { res.writeHead(200, { 'content-type': 'video/mp4', 'x-request-id': 'video_sync-1', 'x-inference-time-s': '12.5' }); res.end(mp4()); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'video_abc', object: 'video', status: 'queued', progress: 0 })); return
    }
    if (req.method === 'GET' && req.url === '/v1/videos/video_abc') {
      jobPolls += 1
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'video_abc', status: jobPolls >= 2 ? 'completed' : 'in_progress', progress: jobPolls >= 2 ? 100 : 40 })); return
    }
    if (req.method === 'GET' && req.url === '/v1/videos/video_abc/content') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4({ audio: null })); return }
    if (req.method === 'DELETE') { deleted.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"deleted":true}'); return }
    res.writeHead(404); res.end()
  })
  tc.after(() => server.close())
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])
  const { wav } = await import('./helpers/fixtures.js')
  const image = await fakeStore(png, 'first-frame.png')
  const voice = await fakeStore(wav(0.5, 16000, 400), 'line.wav')
  const store = { fileHostPath: r => (r.name === 'first-frame.png' ? image.path : voice.path), async * readFileStream(r) { yield * (r.name === 'first-frame.png' ? image : voice).store.readFileStream(r) } }
  const t = await makePlugin([{ provider: 'av', displayName: 'AV', baseURL: server.url, models: [
    { id: 'cosmos', upstreamModel: 'nvidia/Cosmos3-Nano', mode: 'generate-video', wire: 'omni-videos', video: { generateSound: true, soundDuration: 2 } },
    { id: 'ltx-job', upstreamModel: 'Lightricks/LTX-2', mode: 'generate-video', video: { sync: false, pollMs: 20 } },
  ] }], { store })
  tc.after(() => t.stop())
  const opt = obj => `\`\`\`dsh-audio-options\n${JSON.stringify(obj)}\n\`\`\``
  const chunks = await collect(t.plugin.adapter.stream({ provider: 'av', model: 'cosmos', sessionId: 's-043', messages: [{ role: 'user', content: [
    { type: 'text', text: fileHandleText(image.ref, image.path) }, { type: 'text', text: fileHandleText(voice.ref, voice.path) },
    { type: 'text', text: `${opt({ v: 1, seconds: 4, size: '640x360', seed: 11, imageReference: 'first-frame.png', audioReference: 'line.wav' })}\nA lighthouse at dusk, waves and gulls.` },
  ] }] }))
  const f = forms[0]
  assert.deepEqual([f.prompt, f.model, f.seconds, f.size, f.seed, f.generate_sound, f.sound_duration], ['A lighthouse at dusk, waves and gulls.', 'nvidia/Cosmos3-Nano', '4', '640x360', '11', 'true', '2'])
  assert.ok(Buffer.from(JSON.parse(f.image_reference).image_url.split(',')[1], 'base64').equals(png))
  assert.match(JSON.parse(f.audio_reference).audio_url, /^data:audio\/wav;base64,/)
  const text = chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n')
  assert.match(text, /^Video generated · 640×360 · 2 s · sound track mp4a 48000 Hz · 2 ch\./)
  const [, uiTask, id] = RESULT_LINK.exec(text)
  assert.equal(uiTask, 'video-generation')
  const result = (await t.call(`/api/dsh-dgx-audio/v1/result?id=${id}`)).body
  const out = result.outputs[0]
  assert.deepEqual([out.kind, out.delivery, out.width, out.audioTrack.sampleRate, out.audioTrack.sha256, result.server.requestId], ['video', 'final-only', 640, 48000, AUDIO_SAMPLES_SHA256, 'video_sync-1'])
  const served = await t.plugin.routes().find(r => r.path.endsWith('/recording')).fetch(new Request(`http://h/api/dsh-dgx-audio/v1/recording?id=${out.recordingId}`))
  assert.deepEqual([served.status, served.headers.get('content-type')], [200, 'video/mp4'])
  assert.equal(createHash('sha256').update(Buffer.from(await served.arrayBuffer())).digest('hex'), out.sha256)
  const doc = (await t.call('/api/dsh-dgx-audio/v1/capabilities')).body.routes[0].models
  const cosmos = doc.find(m => m.id === 'cosmos')
  assert.deepEqual([cosmos.task, cosmos.wire, cosmos.io.output.video, cosmos.capabilities.audioOutput.state, cosmos.capabilities.audioOutputStreaming.state], ['video.generate', 'omni-videos', true, 'verified', 'unsupported'])

  // The catalog adapter_models object (checkpoint 20260915T0430, wire suffix removed) binds as-is.
  const { resolveConfig } = await import('../src/config.js')
  const catalogEntry = { upstreamModel: 'Wan-AI/Wan2.2-S2V-14B', catalogId: 'vllm-omni:Wan-AI/Wan2.2-S2V-14B', deploymentId: null, id: 'wan2-2-s2v-14b-video', tasks: ['video.audio'], catalogTasks: ['speech_to_video', 'audio_to_video'], mode: 'generate-video', wire: 'omni-videos', delivery_expected: 'final-only', params_required: ['audioReference'], video: { audioReference: 'attachment', endpoint: '/v1/videos', imageReference: null, sync: '/v1/videos/sync' } }
  const wan = resolveConfig({ routes: [{ provider: 'c', displayName: 'C', baseURL: server.url, models: [catalogEntry, { ...catalogEntry, id: 'cosmos-cat', params_required: undefined, video: { endpoint: '/v1/videos', generateSound: 'unknown', imageReference: 'attachment', sync: '/v1/videos/sync' } }] }] }).routes[0].models
  const { ioOf } = await import('../src/task-map.js')
  assert.deepEqual([ioOf(wan[0]).input.audio, ioOf(wan[0]).input.image, ioOf(wan[1]).input.image, ioOf(wan[1]).input.audio], ['required', 'none', 'optional', 'none'])
  assert.throws(() => resolveConfig({ routes: [{ provider: 'c', displayName: 'C', baseURL: server.url, models: [{ ...catalogEntry, wire: 'omni-videos (proposed; not in streaming 0.4.2)' }] }] }), /not implemented by this adapter/)
  const cat = await makePlugin([{ provider: 'cat', displayName: 'Cat', baseURL: server.url, models: [catalogEntry, { ...catalogEntry, id: 'cosmos-cat', params_required: undefined, video: { endpoint: '/v1/videos', generateSound: 'unknown', sync: '/v1/videos/sync' } }] }], { store })
  tc.after(() => cat.stop())
  await assert.rejects(collect(cat.plugin.adapter.stream({ provider: 'cat', model: 'wan2-2-s2v-14b-video', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: 'A singer.' }] }] })), /needs an audio reference/)
  const before = forms.length
  await collect(cat.plugin.adapter.stream({ provider: 'cat', model: 'cosmos-cat', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: 'Rain on a roof.' }] }] }))
  assert.equal(forms.length, before + 1, 'catalog sync path /v1/videos/sync used')
  assert.equal('generate_sound' in forms.at(-1), false, 'generateSound "unknown" is not sent')

  // Async job: polled to completion (progress on the feed), content fetched; no sound track is reported as such.
  const jobText = (await collect(t.plugin.adapter.stream({ provider: 'av', model: 'ltx-job', sessionId: 's-043', messages: [{ role: 'user', content: [{ type: 'text', text: 'A quiet forest.' }] }] }))).filter(c => c.type === 'block-end').map(c => c.block.text).join('\n')
  assert.match(jobText, /no sound track/)
  assert.ok(t.events.some(e => e.type === 'video.progress' && e.progress === 40))
  // Stop during a job deletes it on the server.
  jobPolls = -1000
  const controller = new AbortController()
  const pending = collect(t.plugin.adapter.stream({ provider: 'av', model: 'ltx-job', sessionId: 's-043', signal: controller.signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'Another.' }] }] }))
  await sleep(80)
  controller.abort()
  await assert.rejects(pending)
  await sleep(50)
  assert.deepEqual(deleted, ['/v1/videos/video_abc'])
})
