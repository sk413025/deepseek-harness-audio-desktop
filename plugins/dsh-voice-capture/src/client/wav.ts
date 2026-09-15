/**
 * PCM helpers for complete-clip capture: band-limited resampling of mono
 * Float32 samples and RIFF/WAVE PCM16 encoding. Pure functions with no
 * browser dependency so the encoder is testable under Node.
 */

/** Encoded clip bytes plus the format facts shown in the preview. */
export interface EncodedWav {
  readonly bytes: Uint8Array
  readonly sampleRate: number
  readonly channels: 1
  readonly bitsPerSample: 16
  readonly frames: number
  readonly durationMs: number
}

/** Half-width of the windowed-sinc kernel, in input-rate zero crossings. */
const KERNEL_ZERO_CROSSINGS = 12

/**
 * Resample mono samples with a Blackman-windowed sinc kernel. Downsampling
 * lowers the cutoff to 0.95 x the output Nyquist frequency so content above
 * it is attenuated instead of aliasing into the speech band.
 * @param input - mono samples in [-1, 1].
 * @param fromRate - input sample rate in Hz.
 * @param toRate - output sample rate in Hz.
 * @returns a new array at `toRate` (the input itself when the rates match).
 */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const plan = resamplePlan(input, fromRate, toRate)
  if (plan === undefined) return input
  resampleRange(input, plan, 0, plan.output.length)
  return plan.output
}

/**
 * {@link resampleMono} in bounded slices that yield to the event loop, so a
 * long clip does not freeze the recording panel while it is prepared.
 * @param input - mono samples in [-1, 1].
 * @param fromRate - input sample rate in Hz.
 * @param toRate - output sample rate in Hz.
 * @param signal - optional cancellation checked between slices.
 * @returns the resampled samples.
 */
export async function resampleMonoAsync(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const plan = resamplePlan(input, fromRate, toRate)
  if (plan === undefined) return input
  const slice = 16384
  for (let start = 0; start < plan.output.length; start += slice) {
    signal?.throwIfAborted()
    resampleRange(input, plan, start, Math.min(plan.output.length, start + slice))
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  return plan.output
}

interface ResamplePlan {
  readonly output: Float32Array
  readonly halfWidth: number
  readonly step: number
  /** Kernel sampled every 1/TABLE_DENSITY input samples across [-halfWidth, halfWidth]. */
  readonly table: Float32Array
}

/** Kernel table resolution per input sample; linear interpolation between entries. */
const TABLE_DENSITY = 512

function resamplePlan(input: Float32Array, fromRate: number, toRate: number): ResamplePlan | undefined {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError(`invalid sample rates ${fromRate} -> ${toRate}`)
  if (fromRate === toRate || input.length === 0) return undefined
  const ratio = toRate / fromRate
  const cutoff = Math.min(1, ratio) * 0.95
  const halfWidth = KERNEL_ZERO_CROSSINGS / cutoff
  const table = new Float32Array(Math.ceil(2 * halfWidth * TABLE_DENSITY) + 2)
  for (let i = 0; i < table.length; i++) table[i] = kernel(i / TABLE_DENSITY - halfWidth, cutoff, halfWidth)
  return {
    output: new Float32Array(Math.max(1, Math.round(input.length * ratio))),
    halfWidth,
    step: 1 / ratio,
    table,
  }
}

function resampleRange(input: Float32Array, plan: ResamplePlan, from: number, to: number): void {
  const { output, halfWidth, step, table } = plan
  const last = input.length - 1
  const tableLast = table.length - 2
  for (let n = from; n < to; n++) {
    const center = n * step
    const kFirst = Math.max(0, Math.ceil(center - halfWidth))
    const kLast = Math.min(last, Math.floor(center + halfWidth))
    let sum = 0
    let weight = 0
    for (let k = kFirst; k <= kLast; k++) {
      const position = (k - center + halfWidth) * TABLE_DENSITY
      const index = Math.min(tableLast, Math.max(0, Math.floor(position)))
      const fraction = position - index
      const w = table[index]! + (table[index + 1]! - table[index]!) * fraction
      sum += input[k]! * w
      weight += w
    }
    output[n] = weight === 0 ? 0 : sum / weight
  }
}

function kernel(x: number, cutoff: number, halfWidth: number): number {
  if (Math.abs(x) >= halfWidth) return 0
  const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x)
  const phase = (x / halfWidth + 1) / 2
  const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * phase) + 0.08 * Math.cos(4 * Math.PI * phase)
  return sinc * blackman
}

/**
 * Encode mono samples as a canonical 44-byte-header PCM16 WAV.
 * @param samples - mono samples; values outside [-1, 1] are clipped.
 * @param sampleRate - sample rate written to the header.
 * @returns the complete file bytes and its format facts.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): EncodedWav {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`invalid sample rate ${sampleRate}`)
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return {
    bytes,
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    frames: samples.length,
    durationMs: Math.round(samples.length * 1000 / sampleRate),
  }
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i)
}

/** Parsed PCM16 WAV header fields used by tests and the fixture verifier. */
export interface WavHeader {
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
  readonly dataBytes: number
}

/**
 * Read a canonical PCM WAV header written by {@link encodeWavPcm16}.
 * @param bytes - file bytes.
 * @returns header fields, or undefined when the bytes are not a PCM RIFF/WAVE file.
 */
export function readWavHeader(bytes: Uint8Array): WavHeader | undefined {
  if (bytes.length < 44) return undefined
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE' || ascii(12) !== 'fmt ' || ascii(36) !== 'data') return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(20, true) !== 1) return undefined
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  }
}

/**
 * Concatenate captured frame chunks into one buffer.
 * @param chunks - captured mono chunks in arrival order.
 * @param frames - total frame count across the chunks.
 * @returns contiguous samples.
 */
export function joinChunks(chunks: readonly Float32Array[], frames: number): Float32Array {
  const joined = new Float32Array(frames)
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, frames - offset)
    joined.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset)
    offset += take
    if (offset >= frames) break
  }
  return joined
}

/**
 * Lowercase hex SHA-256 through Web Crypto.
 * @param bytes - data to hash.
 * @returns the digest, or undefined when SubtleCrypto is unavailable (non-secure context).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) return undefined
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
