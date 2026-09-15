// Dependency-free Server-Sent Events decoder (WHATWG "event stream interpretation").
//
// Network reads may split or coalesce events anywhere, including inside a UTF-8
// sequence or between the CR and LF of a CRLF pair. Lines and pending event data are
// bounded so a hostile or broken server cannot grow memory without limit. Framing is
// spec-strict: an event dispatches only on its blank-line terminator, so an
// unterminated tail at EOF is reported as truncation rather than flushed.

import { LlmError } from './compat.js'

export const SSE_DEFAULT_LIMITS = Object.freeze({
  // One vLLM-Omni audio event can carry a whole base64 WAV (≈1.9 MiB for 30 s of 24 kHz mono PCM16).
  maxLineChars: 48 * 1024 * 1024,
  maxEventChars: 48 * 1024 * 1024,
})

/**
 * @typedef {object} SseEvent
 * @property {string} event - `event:` field, `message` when absent.
 * @property {string} data - joined `data:` lines.
 * @property {string} [id]
 * @property {number} [retry]
 */

export class SseDecoder {
  /** @param {{ maxLineChars?: number, maxEventChars?: number, onComment?: (text: string) => void }} [options] */
  constructor(options = {}) {
    this.limits = { ...SSE_DEFAULT_LIMITS, ...options }
    this.onComment = options.onComment
    this.text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false })
    this.buffer = ''
    this.scanFrom = 0
    this.skipLeadingLF = false
    this.data = []
    this.dataChars = 0
    this.eventType = ''
    this.lastId = undefined
    this.sawField = false
    this.bytesIn = 0
    this.events = 0
  }

  /**
   * Feed one network read; returns every event completed by it, in order.
   * @param {Uint8Array | string} chunk
   * @returns {SseEvent[]}
   */
  push(chunk) {
    if (typeof chunk === 'string') {
      this.buffer += chunk
    } else {
      this.bytesIn += chunk.byteLength
      this.buffer += this.text.decode(chunk, { stream: true })
    }
    return this.drain()
  }

  /**
   * Signal end of input. Returns any event completed by the decoder flush and
   * reports whether an unterminated event or line remained.
   * @returns {{ events: SseEvent[], truncated: boolean }}
   */
  end() {
    this.buffer += this.text.decode()
    const events = this.drain()
    const truncated = this.buffer.length > 0 || this.sawField
    return { events, truncated }
  }

  /** @returns {SseEvent[]} */
  drain() {
    const out = []
    const buffer = this.buffer
    let start = 0
    if (this.skipLeadingLF && buffer.length > 0) {
      if (buffer.charCodeAt(0) === 10) start = 1
      this.skipLeadingLF = false
    }
    // Scan with an index and slice the remainder once: a coalesced read holding
    // thousands of small events must stay linear, not copy the tail per line.
    let i = Math.max(start, this.scanFrom)
    for (; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i)
      if (c !== 10 && c !== 13) continue
      const event = this.line(buffer.slice(start, i))
      if (event !== undefined) out.push(event)
      if (c === 13) {
        if (i + 1 < buffer.length) {
          if (buffer.charCodeAt(i + 1) === 10) i += 1
        } else {
          // CR at the end of this read: a LF at the start of the next read belongs to it.
          this.skipLeadingLF = true
        }
      }
      start = i + 1
    }
    this.buffer = start === 0 ? buffer : buffer.slice(start)
    this.scanFrom = this.buffer.length
    if (this.buffer.length > this.limits.maxLineChars) {
      throw new LlmError(`SSE line exceeds ${this.limits.maxLineChars} characters`, 'STREAM_LIMIT')
    }
    return out
  }

  /** @param {string} line */
  line(line) {
    if (this.events === 0 && this.data.length === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1)
    if (line.length === 0) return this.dispatch()
    if (line.charCodeAt(0) === 58) { // ':'
      this.onComment?.(line.slice(1).trimStart())
      return undefined
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1)
    this.sawField = true
    switch (field) {
      case 'data':
        this.dataChars += value.length + 1
        if (this.dataChars > this.limits.maxEventChars) {
          throw new LlmError(`SSE event exceeds ${this.limits.maxEventChars} characters`, 'STREAM_LIMIT')
        }
        this.data.push(value)
        break
      case 'event':
        this.eventType = value
        break
      case 'id':
        if (!value.includes('\0')) this.lastId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value)
        break
      default:
        break // unknown fields are ignored per spec
    }
    return undefined
  }

  dispatch() {
    const hadData = this.data.length > 0
    const event = hadData
      ? {
          event: this.eventType || 'message',
          data: this.data.join('\n'),
          ...(this.lastId === undefined ? {} : { id: this.lastId }),
          ...(this.retry === undefined ? {} : { retry: this.retry }),
        }
      : undefined
    this.data = []
    this.dataChars = 0
    this.eventType = ''
    this.retry = undefined
    this.sawField = false
    if (hadData) this.events += 1
    return event
  }
}

/**
 * Iterate SSE events from a fetch body (or any async iterable of bytes), honoring
 * cancellation. Returns `{ truncated }` via the generator return value.
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>} body
 * @param {{ signal?: AbortSignal, limits?: object, onComment?: (text: string) => void, onBytes?: (n: number) => void }} [options]
 * @returns {AsyncGenerator<SseEvent, { truncated: boolean, bytes: number }>}
 */
export async function * readSse(body, options = {}) {
  const decoder = new SseDecoder({ ...options.limits, onComment: options.onComment })
  const reader = typeof body?.getReader === 'function' ? body.getReader() : undefined
  const iterator = reader === undefined ? body[Symbol.asyncIterator]() : undefined
  let finished = false
  try {
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
      const { done, value } = reader !== undefined ? await reader.read() : await iterator.next()
      if (done) break
      options.onBytes?.(value.byteLength ?? value.length)
      for (const event of decoder.push(value)) yield event
    }
    const tail = decoder.end()
    for (const event of tail.events) yield event
    finished = true
    return { truncated: tail.truncated, bytes: decoder.bytesIn }
  } finally {
    if (!finished) {
      // Consumer stopped early, aborted, or a limit tripped: release the connection now.
      try {
        if (reader !== undefined) await reader.cancel()
        else await iterator.return?.()
      } catch { /* the transport may already be torn down */ }
    }
    reader?.releaseLock?.()
  }
}
