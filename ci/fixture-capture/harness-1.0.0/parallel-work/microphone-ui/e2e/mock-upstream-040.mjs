#!/usr/bin/env node
// Loopback mock of the OpenAI-compatible vLLM / vLLM-Omni endpoints that dsh-dgx-audio 0.4.0 calls, for
// dsh-voice-capture task-UI E2E (TASK_CONTRACT 0.2). Every request is logged to <log.jsonl> with the
// decoded audio sha256, so the scenario can prove which bytes and parameters reached the "server".
//   POST /v1/chat/completions         text SSE (+ progressive WAV audio chunks with modalities audio)
//   POST /v1/audio/speech             SSE speech.audio.delta (WAV stream header, then PCM) or a complete WAV
//   POST /v1/audio/transcriptions     multipart → verbose_json with segments
//   GET  /v1/audio/voices             { voices, uploaded_voices }
//   WS   /v1/realtime                 vllm-asr wire: session.created, commit(final) → transcription.delta/done
//   WS   /v1/audio/speech/stream      omni-speech-ws wire: session.config (per utterance), input.text/input.done → audio.* frames,
//                                     word_timestamps → trailing empty audio.chunk with timestamps, session.done per utterance
//   POST /v1/videos/sync              multipart → fixtures/synthetic-video-with-sound.mp4 (or -silent.mp4 when the prompt says "silent")
// Mock transport only: it is not evidence that any real model supports these tasks.
// Env: CHAT_AUDIO_CHUNKS (default 6), CHAT_CHUNK_MS (default 300).
// Usage: node mock-upstream-040.mjs <port> <log.jsonl>
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [portArg, logPath] = process.argv.slice(2)
const log = record => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const CHAT_AUDIO_CHUNKS = Number(process.env.CHAT_AUDIO_CHUNKS ?? 6)
const CHAT_CHUNK_MS = Number(process.env.CHAT_CHUNK_MS ?? 300)
// Optional (defaults keep earlier scenarios unchanged): CHAT_TONE_AMPLITUDE=0 makes the chat reply audio silent (for runs
// on a Mac where someone is recording or listening), CHAT_AUDIO_SECONDS sets each payload's length,
// CHAT_AUDIO_FINAL_ONLY=1 sends all reply audio as one payload after the last delay.
const CHAT_TONE_AMPLITUDE = Number(process.env.CHAT_TONE_AMPLITUDE ?? 6000)
const CHAT_AUDIO_SECONDS = Number(process.env.CHAT_AUDIO_SECONDS ?? 0.3)
const CHAT_AUDIO_FINAL_ONLY = process.env.CHAT_AUDIO_FINAL_ONLY === '1'

function pcm16(seconds, rate, freq, amplitude = 6000) {
  const samples = Math.round(seconds * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2)
  return buf
}
function wavHeader(rate, dataBytes) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(dataBytes === undefined ? 0xffffffff : 36 + dataBytes, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(dataBytes === undefined ? 0xffffffff : dataBytes, 40)
  return h
}
const wav = (data, rate) => Buffer.concat([wavHeader(rate, data.length), data])

function multipart(req, raw) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(req.headers['content-type'] ?? ''))
  if (boundary === null) return {}
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  const fields = {}
  let start = raw.indexOf(marker)
  while (start !== -1) {
    const next = raw.indexOf(marker, start + marker.length)
    if (next === -1) break
    const part = raw.subarray(start + marker.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString('utf8')
    const body = part.subarray(split + 4)
    const name = /name="([^"]+)"/.exec(head)?.[1]
    const filename = /filename="([^"]*)"/.exec(head)?.[1]
    if (name !== undefined) fields[name] = filename === undefined ? body.toString('utf8') : { filename, bytes: body.length, sha256: sha(body) }
    start = next
  }
  return fields
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks)
    const path = (req.url ?? '').split('?')[0]
    const jsonBody = () => { try { return JSON.parse(raw.toString('utf8') || '{}') } catch { return {} } }
    if (path.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"mock"}]}'); return }
    if (path.endsWith('/audio/voices')) {
      log({ kind: 'http', path })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ voices: ['vivian', 'ryan'], uploaded_voices: [{ name: 'studio-voice', created_at: 1757900000, ref_text: null }] }))
      return
    }
    if (path.endsWith('/videos/sync')) {
      const form = multipart(req, raw)
      const refOf = (field) => {
        if (typeof form[field] !== 'string') return null
        try {
          const url = Object.values(JSON.parse(form[field]))[0]
          const bytes = Buffer.from(String(url).split(',')[1] ?? '', 'base64')
          return { mime: /^data:([^;]+)/.exec(String(url))?.[1] ?? null, bytes: bytes.length, sha256: sha(bytes) }
        } catch { return { invalid: true } }
      }
      const fields = Object.fromEntries(Object.entries(form).filter(([k, v]) => typeof v === 'string' && !['image_reference', 'audio_reference'].includes(k)))
      const silent = /silent/i.test(String(form.prompt ?? ''))
      log({ kind: 'http', path, fields, imageReference: refOf('image_reference'), audioReference: refOf('audio_reference'), answered: silent ? 'silent' : 'with-sound' })
      const mp4 = readFileSync(new URL(silent ? './fixtures/synthetic-video-silent.mp4' : './fixtures/synthetic-video-with-sound.mp4', import.meta.url))
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length })
      res.end(mp4)
      return
    }
    if (path.endsWith('/audio/transcriptions') || path.endsWith('/audio/translations')) {
      const form = multipart(req, raw)
      log({ kind: 'http', path, model: form.model, responseFormat: form.response_format, language: form.language ?? null, stream: form.stream ?? null, file: form.file })
      const segments = [
        { id: 0, start: 0, end: 1.4, text: ' And so, my fellow Americans,' },
        { id: 1, start: 1.4, end: 3.1, text: ' ask not what your country can do for you.' },
      ]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: segments.map(s => s.text).join('').trim(), language: 'en', duration: 3.1, segments }))
      return
    }
    if (path.endsWith('/audio/speech')) {
      const body = jsonBody()
      const ref = typeof body.ref_audio === 'string' ? Buffer.from(body.ref_audio.split(',')[1] ?? '', 'base64') : undefined
      const clipOf = value => { if (typeof value !== 'string') return null; const bytes = Buffer.from(value.split(',')[1] ?? '', 'base64'); return { bytes: bytes.length, sha256: sha(bytes) } }
      const perTurn = Object.fromEntries(['speed', 'seed', 'sample_rate', 'word_timestamps', 'x_vector_only_mode', 'non_streaming_mode', 'initial_codec_chunk_frames', 'ambient_sound', 'duration_seconds', 'max_new_tokens'].filter(k => body[k] !== undefined).map(k => [k, body[k]]))
      log({
        kind: 'http', path, model: body.model, input: body.input, voice: body.voice ?? null, language: body.language ?? null, taskType: body.task_type ?? null, instructions: body.instructions ?? null,
        refText: body.ref_text ?? null, refAudio: ref === undefined ? null : { bytes: ref.length, sha256: sha(ref) }, refAudio2: clipOf(body.ref_audio_2),
        extraParams: body.extra_params === undefined ? null : { ...body.extra_params, ...(body.extra_params.emo_audio ? { emo_audio: clipOf(body.extra_params.emo_audio) } : {}) },
        perTurn, responseFormat: body.response_format, stream: body.stream ?? null, streamFormat: body.stream_format ?? null,
      })
      if (body.word_timestamps === true) {
        // vLLM-Omni returns word alignment only on non-streaming responses, in the X-Word-Timestamps header.
        const words = String(body.input ?? '').split(/\s+/).filter(Boolean).map((word, i) => ({ word, start_ms: i * 330, end_ms: i * 330 + 300 }))
        res.writeHead(200, { 'content-type': 'audio/wav', 'x-word-timestamps': JSON.stringify(words) })
        res.end(wav(pcm16(Math.max(0.6, words.length * 0.33), 24000, 330), 24000))
        return
      }
      if (body.stream === true && body.stream_format === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
        send('speech.audio.delta', { audio: wavHeader(24000).toString('base64'), response_format: 'wav' })
        for (let i = 0; i < 5; i++) {
          send('speech.audio.delta', { audio: pcm16(0.3, 24000, 300 + i * 50).toString('base64'), response_format: 'wav' })
          await sleep(250)
        }
        send('speech.audio.done', { usage: { input_tokens: 5, output_tokens: 50, total_tokens: 55 } })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(wav(pcm16(1.5, 24000, 330), 24000))
      return
    }
    if (path.endsWith('/chat/completions')) {
      const body = jsonBody()
      const audio = (body.messages ?? []).flatMap(m => (Array.isArray(m.content) ? m.content.filter(p => p.type === 'input_audio') : []))
        .map(p => { const bytes = Buffer.from(p.input_audio?.data ?? '', 'base64'); return { bytes: bytes.length, sha256: sha(bytes) } })
      const wantAudio = Array.isArray(body.modalities) && body.modalities.includes('audio')
      log({ kind: 'http', path, model: body.model, stream: body.stream === true, modalities: body.modalities ?? null, inputAudio: audio })
      const reply = audio.length === 0 ? 'Mock reply: no audio received.' : `Mock reply: received ${audio.at(-1).bytes} bytes.`
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      send({ id: 'mock', object: 'chat.completion.chunk', modality: 'text', choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })
      if (wantAudio) {
        if (CHAT_AUDIO_FINAL_ONLY) {
          await sleep(CHAT_CHUNK_MS * CHAT_AUDIO_CHUNKS)
          send({ id: 'mock', object: 'chat.completion.chunk', modality: 'audio', choices: [{ index: 0, delta: { content: wav(pcm16(CHAT_AUDIO_SECONDS * CHAT_AUDIO_CHUNKS, 24000, 330, CHAT_TONE_AMPLITUDE), 24000).toString('base64') }, finish_reason: null }] })
        } else {
          for (let i = 0; i < CHAT_AUDIO_CHUNKS; i++) {
            await sleep(CHAT_CHUNK_MS)
            if (res.destroyed) break
            send({ id: 'mock', object: 'chat.completion.chunk', modality: 'audio', choices: [{ index: 0, delta: { content: wav(pcm16(CHAT_AUDIO_SECONDS, 24000, 330 + i * 40, CHAT_TONE_AMPLITUDE), 24000).toString('base64') }, finish_reason: null }] })
          }
        }
      }
      send({ id: 'mock', object: 'chat.completion.chunk', modality: 'text', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      res.end('data: [DONE]\n\n')
      return
    }
    log({ kind: 'http-404', path })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"not found"}}')
  })
})

// --- minimal RFC 6455 server (text frames out, masked text frames in) ---
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const frame = (opcode, payload) => {
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
    : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(payload.length), 2); return b })()
  return Buffer.concat([header, payload])
}
let wsCount = 0
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
  const path = (req.url ?? '').split('?')[0]
  const wire = path.endsWith('/audio/speech/stream') ? 'omni-speech-ws' : 'vllm-asr'
  const id = `mock_ws_${++wsCount}`
  log({ kind: 'ws-open', wire, url: req.url })
  let open = true
  let buffer = Buffer.alloc(0)
  const sendJson = (obj) => { if (open) socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))) }
  // vllm-asr state
  const turn = { appends: 0, bytes: 0, deltas: 0, active: false, words: ['And', 'so,', 'my', 'fellow', 'Americans,', 'ask', 'not'] }
  // omni-speech-ws state
  const speech = { utterance: 0, sentence: 0, pending: '', done: false, config: {} }
  if (wire === 'vllm-asr') sendJson({ type: 'session.created', id, created: Date.now() })
  const speak = async (text, utterance) => {
    sendJson({ type: 'audio.start', utterance_index: utterance, sentence_index: speech.sentence, sentence_text: text, format: 'pcm', sample_rate: 24000 })
    for (let i = 0; i < 3; i++) {
      await sleep(120)
      sendJson({ type: 'audio.chunk', utterance_index: utterance, sentence_index: speech.sentence, audio_b64: pcm16(0.25, 24000, 260 + speech.sentence * 60 + i * 20).toString('base64') })
    }
    if (speech.config.word_timestamps === true) {
      // vLLM-Omni streaming speech: a trailing empty-audio chunk carries the sentence alignment.
      const words = text.split(/\s+/).filter(Boolean).map((word, i) => ({ word, start_ms: i * 250, end_ms: i * 250 + 220 }))
      sendJson({ type: 'audio.chunk', utterance_index: utterance, sentence_index: speech.sentence, audio_b64: '', timestamps: words })
    }
    sendJson({ type: 'audio.done', utterance_index: utterance, sentence_index: speech.sentence })
    speech.sentence++
  }
  let speechChain = Promise.resolve()
  const onMessage = (message) => {
    log({ kind: 'ws', wire, type: message.type, ...(message.type === 'input_audio_buffer.append' ? { bytes: Buffer.from(message.audio ?? '', 'base64').length } : {}), ...(message.type === 'input.text' ? { text: message.text } : {}), ...(message.type === 'input_audio_buffer.commit' ? { final: message.final } : {}), ...(message.type === 'session.config' ? { config: message } : {}), ...(message.type === 'session.update' ? { model: message.model } : {}) })
    if (wire === 'vllm-asr') {
      if (message.type === 'input_audio_buffer.commit' && message.final === false) { turn.active = true; return }
      if (message.type === 'input_audio_buffer.append') {
        turn.appends++
        turn.bytes += Buffer.from(message.audio ?? '', 'base64').length
        if (turn.active && turn.appends % 3 === 0 && turn.deltas < turn.words.length) sendJson({ type: 'transcription.delta', delta: `${turn.deltas === 0 ? '' : ' '}${turn.words[turn.deltas++]}` })
        return
      }
      if (message.type === 'input_audio_buffer.commit' && message.final === true) {
        while (turn.deltas < turn.words.length) sendJson({ type: 'transcription.delta', delta: ` ${turn.words[turn.deltas++]}` })
        sendJson({ type: 'transcription.done', text: `${turn.words.join(' ')} (${turn.bytes} bytes)`, usage: { input_tokens: 1, output_tokens: turn.words.length } })
        turn.active = false
      }
      return
    }
    if (message.type === 'session.config') {
      speech.config = { ...message }
      return
    }
    if (message.type === 'input.text') {
      speech.pending += String(message.text ?? '')
      const sentences = speech.pending.match(/[^.!?]+[.!?]+\s*/g) ?? []
      const utterance = speech.utterance
      for (const sentence of sentences) speechChain = speechChain.then(() => speak(sentence.trim(), utterance))
      speech.pending = speech.pending.slice(sentences.join('').length)
      return
    }
    if (message.type === 'input.done') {
      const rest = speech.pending.trim()
      speech.pending = ''
      const utterance = speech.utterance
      speech.utterance += 1
      speechChain = speechChain.then(async () => {
        if (rest !== '') await speak(rest, utterance)
        sendJson({ type: 'session.done', utterance_index: utterance, total_sentences: speech.sentence })
      })
    }
  }
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data])
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 } else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      const masked = (buffer[1] & 0x80) !== 0
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x8) { open = false; log({ kind: 'ws-close', wire }); socket.end(Buffer.from([0x88, 0])); return }
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue }
      if (opcode === 0x1) { try { onMessage(JSON.parse(payload.toString('utf8'))) } catch { /* ignore malformed */ } }
    }
  })
  socket.on('close', () => { open = false })
  socket.on('error', () => { open = false })
})
server.listen(Number(portArg), '127.0.0.1', () => { console.log(`mock-upstream-040 on 127.0.0.1:${portArg}`) })
