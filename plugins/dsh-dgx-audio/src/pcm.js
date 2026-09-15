// PCM / WAV framing for progressive audio.
//
// Backends differ in what one "audio chunk" is. vLLM-Omni chat streaming base64-encodes a
// complete WAV container per chunk. MiniCPM-o realtime deltas are headerless pcm16 with
// the rate carried beside the payload. A byte fragment is never assumed to be a
// separately decodable WAV: every payload is classified, and its format is checked for
// continuity before it is converted to one canonical PCM s16le stream.

import { LlmError } from './compat.js'

const PCM16_NAMES = new Set(['pcm', 'pcm16', 'pcm_s16le', 's16le', 'linear16'])
const F32_NAMES = new Set(['pcm_f32le', 'f32le', 'float32', 'pcm_f32'])

/**
 * @typedef {object} PcmFormat
 * @property {'pcm_s16le'} encoding
 * @property {number} sampleRate
 * @property {number} channels
 */

/**
 * @typedef {object} DecodedAudio
 * @property {PcmFormat} format
 * @property {Buffer} pcm - interleaved s16le samples.
 * @property {'wav' | 'pcm16' | 'f32'} source
 */

/**
 * Parse a RIFF/WAVE container into PCM s16le. Supports PCM 16-bit, IEEE float 32-bit
 * and WAVE_FORMAT_EXTENSIBLE carrying either.
 * @param {Buffer} data
 * @returns {DecodedAudio}
 */
export function wavToPcm(data) {
  if (data.byteLength < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new LlmError('audio payload is not a RIFF/WAVE container', 'MALFORMED_AUDIO')
  }
  let offset = 12
  let fmt
  while (offset + 8 <= data.byteLength) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      if (body + 16 > data.byteLength) break
      let audioFormat = data.readUInt16LE(body)
      if (audioFormat === 0xFFFE && size >= 40 && body + 26 <= data.byteLength) audioFormat = data.readUInt16LE(body + 24)
      fmt = {
        audioFormat,
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        bitsPerSample: data.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (fmt === undefined) break
      // Streaming writers may leave 0 or 0xFFFFFFFF; use the bytes actually present.
      const available = data.byteLength - body
      const length = size === 0 || size === 0xFFFFFFFF || size > available ? available : size
      const payload = data.subarray(body, body + length)
      if (fmt.channels < 1 || fmt.sampleRate < 1) break
      if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
        return { format: pcmFormat(fmt.sampleRate, fmt.channels), pcm: evenBytes(payload, 2 * fmt.channels), source: 'wav' }
      }
      if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        return { format: pcmFormat(fmt.sampleRate, fmt.channels), pcm: f32ToS16(evenBytes(payload, 4 * fmt.channels)), source: 'wav' }
      }
      throw new LlmError(`unsupported WAV encoding (format ${fmt.audioFormat}, ${fmt.bitsPerSample} bits)`, 'UNSUPPORTED_AUDIO')
    }
    offset = body + size + (size % 2)
  }
  throw new LlmError('WAV container has no usable fmt/data chunk', 'MALFORMED_AUDIO')
}

/**
 * Decode one backend audio payload to PCM s16le.
 * @param {Buffer} bytes
 * @param {{ format?: string, sampleRate?: number, channels?: number }} hint - wire format facts beside the payload.
 * @returns {DecodedAudio}
 */
export function decodeAudioPayload(bytes, hint = {}) {
  const name = String(hint.format ?? '').toLowerCase()
  const looksWav = bytes.byteLength >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
  if (looksWav || name === 'wav' || name === 'wave') return wavToPcm(bytes)
  if (PCM16_NAMES.has(name) || F32_NAMES.has(name)) {
    if (!(hint.sampleRate > 0)) {
      throw new LlmError(`headerless ${name} audio without a sample rate cannot be played`, 'MALFORMED_AUDIO')
    }
    const channels = hint.channels ?? 1
    if (F32_NAMES.has(name)) return { format: pcmFormat(hint.sampleRate, channels), pcm: f32ToS16(evenBytes(bytes, 4 * channels)), source: 'f32' }
    return { format: pcmFormat(hint.sampleRate, channels), pcm: evenBytes(bytes, 2 * channels), source: 'pcm16' }
  }
  throw new LlmError(`audio payload format "${hint.format ?? 'unknown'}" is not progressively playable (need wav or pcm16)`, 'UNSUPPORTED_AUDIO')
}

/** @returns {PcmFormat} */
export function pcmFormat(sampleRate, channels = 1) {
  return { encoding: 'pcm_s16le', sampleRate, channels }
}

/** @param {PcmFormat | undefined} a @param {PcmFormat | undefined} b */
export function sameFormat(a, b) {
  return a !== undefined && b !== undefined && a.sampleRate === b.sampleRate && a.channels === b.channels && a.encoding === b.encoding
}

function evenBytes(buf, frame) {
  const usable = buf.byteLength - (buf.byteLength % frame)
  return usable === buf.byteLength ? buf : buf.subarray(0, usable)
}

/** @param {Buffer} buf */
export function f32ToS16(buf) {
  const samples = buf.byteLength / 4
  const out = Buffer.allocUnsafe(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.max(-1, Math.min(1, buf.readFloatLE(i * 4)))
    out.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), i * 2)
  }
  return out
}

/**
 * 44-byte canonical WAV header for PCM s16le.
 * @param {PcmFormat} format
 * @param {number} dataBytes
 */
export function wavHeader(format, dataBytes) {
  const header = Buffer.alloc(44)
  const blockAlign = format.channels * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(format.channels, 22)
  header.writeUInt32LE(format.sampleRate, 24)
  header.writeUInt32LE(format.sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/** @param {PcmFormat} format @param {number} bytes */
export function samplesOf(format, bytes) {
  return Math.floor(bytes / (2 * format.channels))
}

/**
 * Stateful framer for audio delivered as an arbitrary byte stream (vLLM-Omni speech/audio-generate raw
 * streams and speech SSE deltas). A WAV stream starts with a header (often with 0xFFFFFFFF sizes and
 * sometimes in its own chunk) followed by bare PCM; chunk boundaries may split a header or a sample.
 * Headerless PCM needs its rate from configuration because the stream carries none.
 */
export class PcmStreamFramer {
  /** @param {{ format?: 'wav' | 'pcm' | 'pcm16' | 'pcm_f32le', sampleRate?: number, channels?: number, maxHeaderBytes?: number }} [hint] */
  constructor(hint = {}) {
    this.hint = hint
    this.pending = Buffer.alloc(0)
    this.format = undefined
    this.sampleKind = undefined // 's16' | 'f32'
    this.maxHeaderBytes = hint.maxHeaderBytes ?? 64 * 1024
    this.bytesIn = 0
  }

  /**
   * @param {Buffer | Uint8Array} bytes
   * @returns {{ format: PcmFormat, pcm: Buffer } | undefined} whole frames available so far
   */
  push(bytes) {
    this.bytesIn += bytes.byteLength
    this.pending = this.pending.byteLength === 0 ? Buffer.from(bytes) : Buffer.concat([this.pending, Buffer.from(bytes)])
    if (this.format === undefined && !this.resolveFormat()) return undefined
    const frame = (this.sampleKind === 'f32' ? 4 : 2) * this.format.channels
    const usable = this.pending.byteLength - (this.pending.byteLength % frame)
    if (usable === 0) return undefined
    const raw = this.pending.subarray(0, usable)
    this.pending = Buffer.from(this.pending.subarray(usable))
    return { format: this.format, pcm: this.sampleKind === 'f32' ? f32ToS16(raw) : Buffer.from(raw) }
  }

  resolveFormat() {
    const buf = this.pending
    const name = String(this.hint.format ?? '').toLowerCase()
    const looksRiff = buf.byteLength >= 4 && buf.toString('ascii', 0, 4) === 'RIFF'
    if (looksRiff || (name === 'wav' && buf.byteLength < 4)) {
      if (buf.byteLength < 12) return false
      if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new LlmError('audio stream starts with RIFF but is not WAVE', 'MALFORMED_AUDIO')
      let offset = 12
      let fmt
      while (offset + 8 <= buf.byteLength) {
        const id = buf.toString('ascii', offset, offset + 4)
        const size = buf.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === 'fmt ') {
          if (body + 16 > buf.byteLength) return this.waitHeader()
          let audioFormat = buf.readUInt16LE(body)
          if (audioFormat === 0xFFFE && size >= 40) {
            if (body + 26 > buf.byteLength) return this.waitHeader()
            audioFormat = buf.readUInt16LE(body + 24)
          }
          fmt = { audioFormat, channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
          offset = body + size + (size % 2)
          continue
        }
        if (id === 'data') {
          if (fmt === undefined) throw new LlmError('WAV stream data chunk before fmt chunk', 'MALFORMED_AUDIO')
          if (fmt.audioFormat === 1 && fmt.bits === 16) this.sampleKind = 's16'
          else if (fmt.audioFormat === 3 && fmt.bits === 32) this.sampleKind = 'f32'
          else throw new LlmError(`unsupported WAV stream encoding (format ${fmt.audioFormat}, ${fmt.bits} bits)`, 'UNSUPPORTED_AUDIO')
          this.format = pcmFormat(fmt.sampleRate, fmt.channels)
          this.pending = Buffer.from(buf.subarray(body))
          return true
        }
        if (size === 0xFFFFFFFF) throw new LlmError(`WAV stream chunk ${id} has unknown size`, 'MALFORMED_AUDIO')
        offset = body + size + (size % 2)
      }
      return this.waitHeader()
    }
    if (name === 'wav') throw new LlmError('expected a WAV stream but the first bytes are not RIFF', 'MALFORMED_AUDIO')
    if (['pcm', 'pcm16', 'pcm_s16le', 's16le'].includes(name) || name === 'pcm_f32le') {
      if (!(this.hint.sampleRate > 0)) throw new LlmError(`headerless ${name} stream needs a configured sample rate`, 'MALFORMED_AUDIO')
      this.sampleKind = name === 'pcm_f32le' ? 'f32' : 's16'
      this.format = pcmFormat(this.hint.sampleRate, this.hint.channels ?? 1)
      return true
    }
    throw new LlmError(`audio stream format "${this.hint.format ?? 'unknown'}" is not progressively playable (need wav or pcm)`, 'UNSUPPORTED_AUDIO')
  }

  waitHeader() {
    if (this.pending.byteLength > this.maxHeaderBytes) throw new LlmError('WAV stream header exceeds limit', 'STREAM_LIMIT')
    return false
  }

  /** Bytes that never formed a whole sample (reported, not played). */
  get leftoverBytes() { return this.pending.byteLength }
}

/** PCM s16le → float32 little-endian (duplex wires that require pcm_f32le input). */
export function s16ToF32(buf) {
  const samples = Math.floor(buf.byteLength / 2)
  const out = Buffer.allocUnsafe(samples * 4)
  for (let i = 0; i < samples; i++) out.writeFloatLE(buf.readInt16LE(i * 2) / 32768, i * 4)
  return out
}
