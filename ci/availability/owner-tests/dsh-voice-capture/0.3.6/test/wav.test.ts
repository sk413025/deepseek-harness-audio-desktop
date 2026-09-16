import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeWavPcm16, joinChunks, readWavHeader, resampleMono, resampleMonoAsync, sha256Hex } from '../src/client/wav.ts'

function sine(frequency: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / rate)
  return out
}

function rms(samples: Float32Array, skip = 200): number {
  let sum = 0
  let n = 0
  for (let i = skip; i < samples.length - skip; i++) { sum += samples[i]! * samples[i]!; n++ }
  return Math.sqrt(sum / n)
}

test('PCM16 WAV header and sample encoding', () => {
  const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]), 16000)
  assert.equal(wav.bytes.byteLength, 44 + 12)
  assert.deepEqual(readWavHeader(wav.bytes), { channels: 1, sampleRate: 16000, bitsPerSample: 16, dataBytes: 12 })
  const view = new DataView(wav.bytes.buffer)
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => view.getInt16(44 + i * 2, true)), [0, 32767, -32768, 16384, 32767, -32768])
  assert.equal(new TextDecoder().decode(wav.bytes.subarray(0, 4)), 'RIFF')
  assert.equal(view.getUint32(4, true), wav.bytes.byteLength - 8)
  assert.equal(wav.durationMs, 0)
  assert.equal(readWavHeader(new Uint8Array(10)), undefined)
})

test('48 kHz to 16 kHz keeps speech-band tones and attenuates content above 8 kHz', () => {
  const pass = resampleMono(sine(1000, 48000, 0.5), 48000, 16000)
  assert.equal(pass.length, 8000)
  assert.ok(Math.abs(rms(pass) - 0.5 / Math.SQRT2) < 0.01, `1 kHz rms ${rms(pass)}`)
  const stop = resampleMono(sine(12000, 48000, 0.5), 48000, 16000)
  assert.ok(rms(stop) < 0.02, `12 kHz leaked rms ${rms(stop)}`)
})

test('upsampling and identity rates', async () => {
  const input = sine(440, 8000, 0.25)
  assert.equal(resampleMono(input, 8000, 8000), input)
  const up = resampleMono(input, 8000, 16000)
  assert.equal(up.length, 4000)
  assert.ok(Math.abs(rms(up) - 0.5 / Math.SQRT2) < 0.02)
  const asyncUp = await resampleMonoAsync(input, 8000, 16000)
  assert.deepEqual(asyncUp, up)
  assert.throws(() => resampleMono(input, 0, 16000), RangeError)
})

test('async resampling honors cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(resampleMonoAsync(sine(440, 48000, 1), 48000, 16000, controller.signal))
})

test('joinChunks and sha256Hex', async () => {
  const joined = joinChunks([new Float32Array([1, 2]), new Float32Array([3, 4, 5])], 4)
  assert.deepEqual([...joined], [1, 2, 3, 4])
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('two minutes of 48 kHz capture resample within a bounded time', () => {
  const input = sine(300, 48000, 120, 0.3)
  const started = performance.now()
  const out = resampleMono(input, 48000, 16000)
  const elapsed = performance.now() - started
  assert.equal(out.length, 16000 * 120)
  assert.ok(elapsed < 5000, `resampling took ${elapsed.toFixed(0)} ms`)
  console.log(`resample 120 s 48k->16k: ${elapsed.toFixed(0)} ms`)
})

test('44.1 kHz fractional ratio keeps a 1 kHz tone', () => {
  const out = resampleMono(sine(1000, 44100, 0.5), 44100, 16000)
  assert.equal(out.length, 8000)
  assert.ok(Math.abs(rms(out) - 0.5 / Math.SQRT2) < 0.01, `rms ${rms(out)}`)
})
