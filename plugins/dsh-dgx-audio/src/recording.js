// Incremental WAV recording on disk plus opaque recording ids.
//
// Progressive audio is appended to `<name>.wav.part` as it arrives, so memory stays bounded
// no matter how long a response speaks. The header is rewritten with the final sizes on
// completion and the file is renamed. Recording ids never expose a filesystem path; they
// are validated back into the output directory before any read.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { samplesOf, wavHeader } from './pcm.js'

export class RecordingWriter {
  /**
   * @param {string} outputDir
   * @param {string} relativePath - `<session>/<file>.wav`, already sanitized.
   */
  static async open(outputDir, relativePath) {
    const path = join(outputDir, relativePath)
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(`${path}.part`, 'w')
    await handle.write(Buffer.alloc(44), 0, 44, 0)
    return new RecordingWriter(outputDir, relativePath, path, handle)
  }

  constructor(outputDir, relativePath, path, handle) {
    this.outputDir = outputDir
    this.relativePath = relativePath
    this.path = path
    this.handle = handle
    this.dataBytes = 0
    this.format = undefined
    this.chain = Promise.resolve()
    this.failed = undefined
    this.closed = false
  }

  /**
   * Queue PCM bytes for append; callers may await for disk backpressure.
   * @param {Buffer} pcm
   * @param {import('./pcm.js').PcmFormat} format
   */
  append(pcm, format) {
    if (this.closed) return Promise.resolve()
    this.format ??= format
    const position = 44 + this.dataBytes
    this.dataBytes += pcm.byteLength
    this.chain = this.chain.then(async () => {
      if (this.failed) return
      try { await this.handle.write(pcm, 0, pcm.byteLength, position) } catch (error) { this.failed = error }
    })
    return this.chain
  }

  /**
   * Write the real header, close and rename. Returns the recording descriptor.
   * @param {{ complete: boolean }} options
   */
  async finalize({ complete }) {
    if (this.closed) throw new Error('recording already finalized')
    this.closed = true
    await this.chain
    if (this.failed) {
      await this.handle.close().catch(() => {})
      await rm(`${this.path}.part`, { force: true })
      throw this.failed
    }
    const format = this.format
    if (format === undefined || this.dataBytes === 0) {
      await this.handle.close()
      await rm(`${this.path}.part`, { force: true })
      return undefined
    }
    await this.handle.write(wavHeader(format, this.dataBytes), 0, 44, 0)
    await this.handle.close()
    const finalPath = complete ? this.path : this.path.replace(/\.wav$/, '.partial.wav')
    await rename(`${this.path}.part`, finalPath)
    const relativePath = relative(this.outputDir, finalPath).split(sep).join('/')
    const bytes = 44 + this.dataBytes
    return {
      recordingId: encodeRecordingId(relativePath),
      path: finalPath,
      mime: 'audio/wav',
      bytes,
      sha256: await sha256File(finalPath),
      sampleRate: format.sampleRate,
      channels: format.channels,
      durationSeconds: Math.round((samplesOf(format, this.dataBytes) / format.sampleRate) * 1000) / 1000,
      complete,
    }
  }

  /** Drop the partial file (nothing was worth keeping). */
  async discard() {
    if (this.closed) return
    this.closed = true
    await this.chain
    await this.handle.close().catch(() => {})
    await rm(`${this.path}.part`, { force: true })
  }
}

/** @param {string} relativePath */
export function encodeRecordingId(relativePath) {
  return `r1.${Buffer.from(relativePath, 'utf8').toString('base64url')}`
}

/**
 * Resolve an opaque id to a file inside `outputDir`, or undefined when invalid.
 * @param {string} outputDir
 * @param {string | null} id
 */
export function resolveRecordingId(outputDir, id) {
  if (typeof id !== 'string' || !/^r1\.[A-Za-z0-9_-]{1,2048}$/.test(id)) return undefined
  const rel = Buffer.from(id.slice(3), 'base64url').toString('utf8')
  if (rel.includes('\0') || rel.startsWith('/') || rel.split('/').some(part => part === '..' || part === '') || !(rel.endsWith('.wav') || rel.endsWith('.mp4'))) return undefined
  const root = resolve(outputDir)
  const full = resolve(root, rel)
  if (!full.startsWith(root + sep)) return undefined
  return full
}

/** @param {string} path */
export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** @param {string} path */
export async function fileSize(path) {
  try { return (await stat(path)).size } catch { return undefined }
}

/** File-system-safe single path segment. */
export function safeSegment(value, fallback = 'none') {
  const text = value === undefined || value === null ? fallback : String(value)
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120)
  return cleaned.length > 0 ? cleaned : fallback
}
