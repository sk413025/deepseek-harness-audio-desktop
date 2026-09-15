// Shared offline fixtures: synthetic audio, fake attachment store, scripted HTTP/SSE servers.
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Synthetic sine PCM s16le mono. */
export function pcm16(seconds, rate = 16000, freq = 440) {
  const samples = Math.round(seconds * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2)
  return buf
}

/** Canonical 44-byte PCM16 WAV. */
export function wav(seconds, rate = 16000, freq = 440) {
  const data = pcm16(seconds, rate, freq)
  return wavFromPcm(data, rate)
}

export function wavFromPcm(data, rate, channels = 1) {
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.byteLength, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2 * channels, 28); buf.writeUInt16LE(2 * channels, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(data.byteLength, 40)
  return Buffer.concat([buf, data])
}

export async function tempDir(prefix = 'dgx-audio-') {
  // A path with spaces and non-ASCII characters exercises portability.
  const root = await mkdtemp(join(tmpdir(), `${prefix}路徑 with space-`))
  return root
}

export async function fakeStore(bytes, name) {
  const root = await tempDir('dgx-audio-store-')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const path = join(root, 'files', digest.slice(0, 2), digest, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
  const ref = { attachmentId: `sha256:${digest}`, name, bytes: bytes.byteLength }
  const reads = []
  const store = {
    fileHostPath: r => join(root, 'files', String(r.attachmentId).slice(7, 9), String(r.attachmentId).slice(7), r.name),
    async * readFileStream(r) { reads.push(r); yield await readFile(store.fileHostPath(r)) },
  }
  return { root, ref, path, store, reads, digest }
}

export async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }

/**
 * Scripted HTTP server. `handler(req, res, body, ctx)` writes the response itself.
 * Records every request and whether the client closed the connection early.
 */
export function scriptedServer(handler) {
  const calls = []
  const sockets = new Set()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const call = { url: req.url, headers: req.headers, body, json: safeJson(body), clientClosed: false, finished: false, marks: {} }
    calls.push(call)
    res.on('close', () => { if (!res.writableFinished) call.clientClosed = true })
    try {
      await handler(req, res, call)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    }
    call.finished = res.writableFinished
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  })))
}

function safeJson(body) { try { return JSON.parse(body.toString('utf8')) } catch { return undefined } }

/** Write SSE `data:` events with optional per-event delay and arbitrary network splitting. */
export async function writeSse(res, payloads, { delayMs = 0, split, crlf = false, onEach } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.flushHeaders()
  const nl = crlf ? '\r\n' : '\n'
  for (let i = 0; i < payloads.length; i++) {
    if (res.destroyed) return false
    const p = payloads[i]
    const text = `data: ${typeof p === 'string' ? p : JSON.stringify(p)}${nl}${nl}`
    const bytes = Buffer.from(text, 'utf8')
    if (split !== undefined) {
      for (const piece of split(bytes)) { if (res.destroyed) return false; res.write(piece); await sleep(0) }
    } else {
      res.write(bytes)
    }
    onEach?.(i, p)
    if (delayMs > 0 && i < payloads.length - 1) await sleep(typeof delayMs === 'function' ? delayMs(i) : delayMs)
  }
  res.end()
  return true
}

/** vLLM-Omni 0.28 chat.completion.chunk shapes (serving_chat.py at eb11446b). */
export const omni = {
  role: (id = 'chatcmpl-omni') => ({ id, object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }], modality: 'text' }),
  text: (text, id = 'chatcmpl-omni') => ({ id, object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: null }], modality: 'text' }),
  textStop: (id = 'chatcmpl-omni') => ({ id, object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: '' }, finish_reason: null }], modality: 'text' }),
  audio: (wavBytes, finish = null, id = 'chatcmpl-omni') => ({ id, object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: wavBytes.toString('base64') }, finish_reason: finish }], modality: 'audio', usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }),
  usage: (id = 'chatcmpl-omni') => ({ id, object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
}
