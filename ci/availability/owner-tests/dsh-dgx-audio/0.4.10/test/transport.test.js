// SSE framing, bounded queue, chat-stream decoding and PCM framing (no network).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SseDecoder, readSse } from '../src/sse.js'
import { BoundedAsyncQueue } from '../src/queue.js'
import { chatStreamEvents } from '../src/openai-stream.js'
import { decodeAudioPayload, wavToPcm } from '../src/pcm.js'
import { collect, omni, pcm16, wavFromPcm } from './helpers/fixtures.js'

function decodeAll(chunks, options) {
  const decoder = new SseDecoder(options)
  const events = chunks.flatMap(c => decoder.push(c))
  const tail = decoder.end()
  return { events: [...events, ...tail.events], truncated: tail.truncated }
}

test('SSE: byte-by-byte fragmentation (split UTF-8 and CR|LF) equals one coalesced read', () => {
  const text = ': keepalive\r\nevent: delta\r\ndata: {"t":"你好 👋"}\r\n\r\ndata: line1\ndata: line2\n\nid: 7\ndata: x\r\rdata: [DONE]\n\n'
  const bytes = Buffer.from(`﻿${text}`, 'utf8')
  const whole = decodeAll([bytes])
  const fragmented = decodeAll([...bytes].map(b => Uint8Array.of(b)))
  assert.deepEqual(fragmented, whole)
  assert.deepEqual(whole.events.map(e => e.data), ['{"t":"你好 👋"}', 'line1\nline2', 'x', '[DONE]'])
  assert.equal(whole.events[0].event, 'delta')
  assert.equal(whole.events[2].id, '7')
  assert.equal(whole.truncated, false)
})

test('SSE: unterminated final event is reported as truncation, not flushed', () => {
  const { events, truncated } = decodeAll([Buffer.from('data: a\n\ndata: partial')])
  assert.deepEqual(events.map(e => e.data), ['a'])
  assert.equal(truncated, true)
})

test('SSE: line and event limits bound memory', () => {
  assert.throws(() => decodeAll([Buffer.from(`data: ${'x'.repeat(200)}`)], { maxLineChars: 100 }), e => e.code === 'STREAM_LIMIT')
  assert.throws(() => decodeAll([Buffer.from(`data: ${'x'.repeat(60)}\ndata: ${'y'.repeat(60)}\n`)], { maxEventChars: 100 }), e => e.code === 'STREAM_LIMIT')
})

test('SSE: a coalesced read with 50 000 events decodes in linear time', () => {
  const bytes = Buffer.from('data: {"k":1}\n\n'.repeat(50_000))
  const started = performance.now()
  const { events } = decodeAll([bytes])
  assert.equal(events.length, 50_000)
  assert.ok(performance.now() - started < 2000, 'decoder must not be quadratic')
})

test('SSE: readSse cancels the underlying reader when the consumer stops early', async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('data: tick\n\n')) },
    cancel() { cancelled = true },
  })
  for await (const event of readSse(body)) { assert.equal(event.data, 'tick'); break }
  assert.equal(cancelled, true)
})

test('queue: block policy applies backpressure until the consumer pops', async () => {
  const q = new BoundedAsyncQueue({ maxItems: 2, overflow: 'block', sizeOf: () => 1 })
  await q.push(1); await q.push(2)
  let third = false
  const pending = q.push(3).then(() => { third = true })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(third, false)
  assert.equal(await q.next(), 1)
  await pending
  assert.equal(third, true)
  assert.equal(q.stats.blockedPushes, 1)
  assert.equal(q.stats.highWaterItems, 2)
})

test('queue: error and drop-oldest policies, byte bound, abort wakes blocked producers', async () => {
  const errorQ = new BoundedAsyncQueue({ maxItems: 10, maxBytes: 10, overflow: 'error' })
  await errorQ.push(Buffer.alloc(8))
  await assert.rejects(errorQ.push(Buffer.alloc(8)), e => e.code === 'BUFFER_OVERFLOW')
  // One oversized item is admitted into an empty queue instead of deadlocking.
  const big = new BoundedAsyncQueue({ maxBytes: 4 })
  await big.push(Buffer.alloc(16))

  const dropQ = new BoundedAsyncQueue({ maxItems: 3, overflow: 'drop-oldest', sizeOf: () => 1 })
  for (let i = 0; i < 5; i++) await dropQ.push(i)
  dropQ.close()
  assert.deepEqual(await collect(dropQ), [2, 3, 4])
  assert.equal(dropQ.stats.dropped, 2)

  const blockQ = new BoundedAsyncQueue({ maxItems: 1, sizeOf: () => 1 })
  await blockQ.push('a')
  const blocked = blockQ.push('b')
  blockQ.abort(Object.assign(new Error('cancelled'), { code: 'ABORTED' }))
  await assert.rejects(blocked, e => e.code === 'ABORTED')
  await assert.rejects(blockQ.next(), e => e.code === 'ABORTED')
})

test('queue: fail drains buffered items then throws; consumer early exit releases producers', async () => {
  const q = new BoundedAsyncQueue({ maxItems: 5, sizeOf: () => 1 })
  await q.push('x')
  q.fail(Object.assign(new Error('upstream broke'), { code: 'TRANSPORT' }))
  assert.equal(await q.next(), 'x')
  await assert.rejects(q.next(), e => e.code === 'TRANSPORT')

  const q2 = new BoundedAsyncQueue({ maxItems: 1, sizeOf: () => 1 })
  await q2.push(1)
  const producer = (async () => { await q2.push(2); await q2.push(3) })()
  for await (const item of q2) { assert.equal(item, 1); await new Promise(r => setTimeout(r, 5)); break }
  await assert.rejects(producer, e => e.code === 'QUEUE_CLOSED')
  assert.equal(q2.state, 'aborted')
})

async function * sseOf(payloads) {
  for (const p of payloads) yield { data: typeof p === 'string' ? p : JSON.stringify(p) }
}

test('chat stream: vLLM-Omni modality:"audio" content is audio, never text', async () => {
  const wavChunk = wavFromPcm(pcm16(0.05, 24000), 24000)
  const events = await collect(chatStreamEvents(sseOf([omni.role(), omni.text('Hel'), omni.text('lo'), omni.audio(wavChunk), omni.audio(wavChunk, 'stop'), omni.usage(), '[DONE]'])))
  const text = events.filter(e => e.type === 'text').map(e => e.text).join('')
  assert.equal(text, 'Hello')
  const audio = events.filter(e => e.type === 'audio')
  assert.equal(audio.length, 2)
  assert.equal(audio[0].carrier, 'modality-content')
  assert.equal(Buffer.from(audio[0].base64, 'base64').equals(wavChunk), true)
  assert.equal(events.filter(e => e.type === 'usage').length, 3)
  assert.deepEqual(events.at(-1), { type: 'done' })
})

test('chat stream: OpenAI delta.audio, server error chunk, malformed JSON, missing [DONE]', async () => {
  const oa = await collect(chatStreamEvents(sseOf([{ choices: [{ index: 0, delta: { audio: { data: 'AAAA', transcript: 'hi' } } }] }, '[DONE]']), { audioDefaults: { format: 'pcm16', sampleRate: 24000 } }))
  assert.deepEqual(oa.find(e => e.type === 'audio'), { type: 'audio', choice: 0, base64: 'AAAA', carrier: 'delta-audio', format: 'pcm16', sampleRate: 24000 })
  assert.equal(oa.find(e => e.type === 'transcript').text, 'hi')
  await assert.rejects(collect(chatStreamEvents(sseOf([omni.text('a'), { error: { message: 'boom', code: 500 } }]))), e => e.code === 'SERVER' && /boom/.test(e.message))
  await assert.rejects(collect(chatStreamEvents(sseOf(['{not json']))), e => e.code === 'MALFORMED_STREAM')
  await assert.rejects(collect(chatStreamEvents(sseOf([omni.text('a')]))), e => e.code === 'STREAM_CLOSED')
})

test('PCM framing: WAV PCM16 / float32 / extensible, headerless pcm16 needs a rate, others are not playable', () => {
  const pcm = pcm16(0.01, 24000)
  const decoded = wavToPcm(wavFromPcm(pcm, 24000))
  assert.deepEqual(decoded.format, { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  assert.equal(decoded.pcm.equals(pcm), true)

  const floats = Buffer.alloc(8); floats.writeFloatLE(0.5, 0); floats.writeFloatLE(-1, 4)
  const fhdr = wavFromPcm(floats, 16000); fhdr.writeUInt16LE(3, 20); fhdr.writeUInt16LE(32, 34)
  assert.deepEqual([...new Int16Array(new Uint8Array(wavToPcm(fhdr).pcm).buffer)], [16384, -32768])

  const ext = Buffer.alloc(68)
  ext.write('RIFF', 0); ext.writeUInt32LE(60, 4); ext.write('WAVE', 8); ext.write('fmt ', 12); ext.writeUInt32LE(40, 16)
  ext.writeUInt16LE(0xFFFE, 20); ext.writeUInt16LE(1, 22); ext.writeUInt32LE(48000, 24); ext.writeUInt32LE(96000, 28); ext.writeUInt16LE(2, 32); ext.writeUInt16LE(16, 34); ext.writeUInt16LE(22, 36); ext.writeUInt16LE(16, 38); ext.writeUInt32LE(4, 40); ext.writeUInt16LE(1, 44)
  ext.write('data', 60); ext.writeUInt32LE(0xFFFFFFFF, 64)
  const extPcm = Buffer.concat([ext, Buffer.from([1, 0, 2, 0, 3])]) // odd trailing byte + streaming size marker
  assert.deepEqual([...wavToPcm(extPcm).pcm], [1, 0, 2, 0])

  assert.equal(decodeAudioPayload(pcm, { format: 'pcm16', sampleRate: 24000 }).pcm.equals(pcm), true)
  assert.throws(() => decodeAudioPayload(pcm, { format: 'pcm16' }), e => e.code === 'MALFORMED_AUDIO')
  assert.throws(() => decodeAudioPayload(Buffer.from('ID3....'), { format: 'mp3' }), e => e.code === 'UNSUPPORTED_AUDIO')
  assert.throws(() => wavToPcm(Buffer.from('RIFF\0\0\0\0WAVEjunk')), e => e.code === 'MALFORMED_AUDIO')
})
