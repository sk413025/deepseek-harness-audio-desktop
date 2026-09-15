#!/usr/bin/env node
// Loopback mock of an OpenAI-compatible audio server for shared-audio-UI E2E tests.
// HTTP  POST /v1/chat/completions: text SSE; with modalities ["text","audio"] and stream:true it
//       also emits vLLM-Omni-shaped progressive audio (top-level modality:"audio", base64 WAV per
//       chunk in delta.content). Requests are logged with decoded input_audio sha256.
// WS    GET  /v1/realtime: scripted realtime duplex wire shaped like the MiniCPM-o 4.5 lab
//       server (session.update → session.created, input_audio_buffer.append, response.audio.delta,
//       playback.ack → playback.acknowledged, barge_in, session.close).
// Mock transport only: it is not evidence that any real model supports these modes.
// Optional env: DROP_AFTER_APPENDS=<n> abruptly destroys the realtime socket once after n appends;
// the next connection may `session.resume` (reply delayed by RESUME_DELAY_MS, default 800) and the
// session continues with the same server_event_seq sequence.
// Optional env: IMPLEMENTATION_LEVEL (default model_native_duplex) sets session.created implementation_level;
// BARGE_IN_BEHAVIOR=complete completes the active response instead of cancelling it on barge_in; RESPONSE_DELTAS (default 8).
// Usage: node mock-backend.mjs <port> <log.jsonl>
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [portArg, logPath] = process.argv.slice(2)
const port = Number(portArg)
const log = record => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function pcm16(seconds, rate, freq) {
  const samples = Math.round(seconds * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2)
  return buf
}
function wav(data, rate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const audioParts = body => (body.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'input_audio') : [])
  .map(p => { const bytes = Buffer.from(p.input_audio?.data ?? '', 'base64'); return { format: p.input_audio?.format, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
    const audio = audioParts(body)
    const wantAudio = Array.isArray(body.modalities) && body.modalities.includes('audio')
    log({ kind: 'http', path: req.url, model: body.model, stream: body.stream === true, modalities: body.modalities, inputAudio: audio, text: (body.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => String(p.text).slice(0, 120)) : [String(m.content ?? '').slice(0, 120)]).slice(-1) })
    if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"mock-audio"}]}'); return }
    const reply = audio.length === 0 ? 'Mock spoken reply: no audio received.' : `Mock spoken reply: received ${audio.at(-1).bytes} bytes sha256 ${audio.at(-1).sha256.slice(0, 16)}.`
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const words = reply.split(' ')
    for (let i = 0; i < words.length; i++) {
      send({ id: 'mock', object: 'chat.completion.chunk', modality: 'text', choices: [{ index: 0, delta: { content: (i === 0 ? '' : ' ') + words[i] }, finish_reason: null }] })
      await sleep(20)
    }
    if (wantAudio) {
      for (let i = 0; i < 6; i++) {
        send({ id: 'mock', object: 'chat.completion.chunk', modality: 'audio', choices: [{ index: 0, delta: { content: wav(pcm16(0.4, 24000, 330 + i * 40), 24000).toString('base64') }, finish_reason: null }] })
        log({ kind: 'http-audio-chunk', index: i })
        await sleep(300)
      }
    }
    send({ id: 'mock', object: 'chat.completion.chunk', modality: 'text', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length } })
    res.end('data: [DONE]\n\n')
  })
})

// --- minimal RFC 6455 text-frame server for /v1/realtime ---
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DROP_AFTER_APPENDS = Number(process.env.DROP_AFTER_APPENDS ?? 0)
// IMPLEMENTATION_LEVEL=serving_session_adapter mimics the vLLM-Omni chat-fallback lane (no native duplex, no resume).
const IMPLEMENTATION_LEVEL = process.env.IMPLEMENTATION_LEVEL ?? 'model_native_duplex'
// BARGE_IN_BEHAVIOR=complete finishes the active response normally when barge_in arrives (the "already finished" race).
const BARGE_IN_BEHAVIOR = process.env.BARGE_IN_BEHAVIOR ?? 'cancel'
// RESPONSE_DELTAS sets the audio deltas per response (180 ms apart; default 8).
const RESPONSE_DELTAS = Number(process.env.RESPONSE_DELTAS ?? 8)
const RESUME_DELAY_MS = Number(process.env.RESUME_DELAY_MS ?? 800)
const realtimeSessions = new Map()
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
  let buffer = Buffer.alloc(0)
  let open = true
  let session = { id: `mock_sess_${realtimeSessions.size + 1}`, seq: 0, appends: 0, responses: 0, dropped: false, incarnation: 1, token: 'tok-1' }
  let active
  const sendJson = (obj) => {
    if (!open) return
    const payload = Buffer.from(JSON.stringify({ ...obj, server_event_seq: ++session.seq }))
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(payload.length), 2); return b })()
    socket.write(Buffer.concat([header, payload]))
  }
  const speak = async (id) => {
    active = { id, cancelled: false }
    sendJson({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
    sendJson({ type: 'response.created', response: { id, status: 'in_progress' } })
    for (let i = 0; i < RESPONSE_DELTAS; i++) {
      if (active.cancelled || active.finishNow || !open) break
      sendJson({ type: 'response.audio.delta', response_id: id, item_id: `item_${id}`, delta: pcm16(0.2, 24000, 280 + i * 30).toString('base64'), format: 'pcm16', sample_rate_hz: 24000, metadata: { epoch: 1, audio_duration_ms: 200 } })
      sendJson({ type: 'response.audio_transcript.delta', response_id: id, delta: `mock${i} ` })
      await sleep(180)
    }
    if (active.cancelled) sendJson({ type: 'response.done', response: { id, status: 'cancelled', status_details: { reason: 'client_force_barge_in' } } })
    else { sendJson({ type: 'response.audio.done', response_id: id }); sendJson({ type: 'response.done', response: { id, status: 'completed' } }) }
    active = undefined
  }
  const onMessage = (message) => {
    log({ kind: 'ws', type: message.type, ...(message.type === 'input_audio_buffer.append' ? { bytes: Buffer.from(message.audio ?? '', 'base64').length } : {}), ...(message.type === 'playback.ack' ? { responseId: message.response_id, playedMs: message.played_ms } : {}) })
    switch (message.type) {
      case 'session.update':
        realtimeSessions.set(session.id, session)
        sendJson({ type: 'session.created', incarnation: session.incarnation, resume_token: session.token, session: { id: session.id, model: message.session?.model, capabilities: { implementation_level: IMPLEMENTATION_LEVEL, supports_barge_in: IMPLEMENTATION_LEVEL === 'model_native_duplex', supports_playback_ack: true, supports_input_append: true, supports_client_commit: true, supports_session_resume: IMPLEMENTATION_LEVEL === 'model_native_duplex' } } })
        break
      case 'session.resume': {
        const known = realtimeSessions.get(message.session_id)
        if (known === undefined || message.resume_token !== known.token || message.incarnation !== known.incarnation) {
          sendJson({ type: 'error', error: { code: 'session_resume_expired', message: 'unknown session or token' } })
          break
        }
        session = known
        setTimeout(() => {
          session.incarnation += 1
          session.token = `tok-${session.incarnation}`
          sendJson({ type: 'session.resumed', session_id: session.id, incarnation: session.incarnation, resume_token: session.token, attachment_generation: session.incarnation })
          log({ kind: 'ws', type: 'session.resumed', incarnation: session.incarnation })
        }, RESUME_DELAY_MS)
        break
      }
      case 'input_audio_buffer.append':
        session.appends++
        if (DROP_AFTER_APPENDS > 0 && !session.dropped && session.appends === DROP_AFTER_APPENDS) {
          session.dropped = true
          log({ kind: 'ws', type: 'mock-socket-drop', afterAppends: session.appends })
          open = false
          socket.destroy()
          return
        }
        if (session.appends === (DROP_AFTER_APPENDS > 0 ? DROP_AFTER_APPENDS + 3 : 4)) void speak(`resp_${++session.responses}`)
        break
      case 'input_audio_buffer.commit':
        sendJson({ type: 'input_audio_buffer.committed' })
        break
      case 'barge_in':
        if (active && BARGE_IN_BEHAVIOR === 'complete') active.finishNow = true
        else if (active) active.cancelled = true
        break
      case 'playback.ack':
        sendJson({ type: 'playback.acknowledged', response_id: message.response_id, played_ms: message.played_ms })
        break
      case 'session.close':
        sendJson({ type: 'session.closed' })
        break
      default:
        break
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
      if (opcode === 0x8) { open = false; socket.end(Buffer.from([0x88, 0])); return }
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue }
      if (opcode === 0x1) { try { onMessage(JSON.parse(payload.toString('utf8'))) } catch { /* ignore malformed */ } }
    }
  })
  socket.on('close', () => { open = false })
  socket.on('error', () => { open = false })
})
server.listen(port, '127.0.0.1', () => { console.log(`mock-backend on 127.0.0.1:${port}`) })
