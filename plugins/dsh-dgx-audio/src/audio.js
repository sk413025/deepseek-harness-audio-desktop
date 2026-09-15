// Audio attachment recovery and WAV inspection.
//
// DeepSeek Harness 0.1.5-rc.1 never hands file bytes to an adapter: LlmRuntime
// replaces every FileBlock with `fileHandleText()` before dispatch. This module
// parses that handle back into the durable attachment reference and reads the
// bytes through the attachment store, which verifies sha256 and length.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`

// Matches the saved-path variant of fileHandleText() in @deepseek-ai/dsh-llm (content.ts).
const HANDLE_WITH_PATH = new RegExp(
  String.raw`^\[File (${QUOTED}) \((\d+) bytes, sha256:([0-9a-f]{8})\): verbatim read-only copy saved at (${QUOTED})\.`,
)
// Matches the no-readable-path variant of the same function.
const HANDLE_WITHOUT_PATH = new RegExp(String.raw`^\[File (${QUOTED}) \((\d+) bytes, sha256:([0-9a-f]{8})\) was uploaded, but`)

const AUDIO_FORMATS = new Map([
  ['.wav', 'wav'], ['.wave', 'wav'], ['.mp3', 'mp3'], ['.flac', 'flac'], ['.ogg', 'ogg'], ['.oga', 'ogg'],
  ['.opus', 'ogg'], ['.m4a', 'm4a'], ['.aac', 'aac'], ['.webm', 'webm'],
])

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm' }

/**
 * Audio format implied by a file name, or undefined for non-audio files.
 * @param {string} name
 * @returns {string | undefined}
 */
export function audioFormatOf(name) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? undefined : AUDIO_FORMATS.get(name.slice(dot).toLowerCase())
}

/** @param {string} format */
export function mimeOf(format) {
  return MIME[format] ?? 'application/octet-stream'
}

/**
 * Parse one Harness file handle text block.
 * @param {string} text
 * @returns {{ name: string, bytes: number, digestPrefix: string, path?: string } | undefined}
 */
export function parseFileHandle(text) {
  const withPath = HANDLE_WITH_PATH.exec(text)
  if (withPath) {
    return { name: JSON.parse(withPath[1]), bytes: Number(withPath[2]), digestPrefix: withPath[3], path: JSON.parse(withPath[4]) }
  }
  const withoutPath = HANDLE_WITHOUT_PATH.exec(text)
  if (withoutPath) return { name: JSON.parse(withoutPath[1]), bytes: Number(withoutPath[2]), digestPrefix: withoutPath[3] }
  return undefined
}

/**
 * Rebuild the durable FileAttachmentRef from a handle whose saved path follows
 * attachment-local's layout `<root>/files/<sha[0:2]>/<sha256>/<name>`.
 * @param {{ name: string, bytes: number, digestPrefix: string, path: string }} handle
 */
export function attachmentRefFromHandle(handle) {
  const digest = basename(dirname(handle.path))
  if (!/^[0-9a-f]{64}$/.test(digest) || !digest.startsWith(handle.digestPrefix) || basename(handle.path) !== handle.name) {
    return undefined
  }
  return { attachmentId: `sha256:${digest}`, name: handle.name, bytes: handle.bytes }
}

/**
 * Load the exact bytes of one audio attachment named by a handle.
 * Prefers the Harness attachment store (verified read); falls back to reading
 * the saved path and checking sha256 + length locally.
 * @param {{ name: string, bytes: number, digestPrefix: string, path?: string }} handle
 * @param {any} attachments - `ctx.attachments`, when composed.
 * @param {AbortSignal | undefined} signal
 */
export async function loadAudioAttachment(handle, attachments, signal) {
  const format = audioFormatOf(handle.name)
  const loaded = await loadAttachmentBytes(handle, attachments, signal)
  return { ...loaded, format: format ?? 'wav', wav: format === 'wav' ? inspectWav(loaded.data) : undefined }
}

/**
 * Exact bytes of one attachment named by a handle (any type), verified by the Harness attachment store when available,
 * otherwise by a local sha256 + length check against the content-addressed store path.
 * @returns {Promise<{ name: string, data: Buffer, bytes: number, sha256: string, verifiedBy: string }>}
 */
export async function loadAttachmentBytes(handle, attachments, signal) {
  if (handle.path === undefined) {
    throw Object.assign(new Error(`attachment "${handle.name}" has no readable saved path in this execution environment`), { code: 'ATTACHMENT_UNREADABLE' })
  }
  const ref = attachmentRefFromHandle(/** @type {any} */ (handle))
  if (ref === undefined) {
    throw Object.assign(new Error(`handle for "${handle.name}" does not point into the Harness attachment store`), { code: 'ATTACHMENT_REF_INVALID' })
  }
  let data
  let verifiedBy
  if (attachments?.readFileStream !== undefined) {
    const expectedPath = attachments.fileHostPath?.(ref)
    if (expectedPath !== undefined && expectedPath !== handle.path) {
      throw Object.assign(new Error(`handle path for "${handle.name}" does not match the attachment store location`), { code: 'ATTACHMENT_REF_INVALID' })
    }
    const chunks = []
    for await (const chunk of attachments.readFileStream(ref, signal)) chunks.push(chunk)
    data = Buffer.concat(chunks)
    verifiedBy = 'dsh-attachments.readFileStream (sha256+length)'
  } else {
    data = await readFile(handle.path, { signal })
    const digest = createHash('sha256').update(data).digest('hex')
    if (`sha256:${digest}` !== ref.attachmentId || data.byteLength !== ref.bytes) {
      throw Object.assign(new Error(`attachment "${handle.name}" failed sha256/length verification`), { code: 'ATTACHMENT_CORRUPT' })
    }
    verifiedBy = 'local sha256+length'
  }
  return { name: handle.name, data, bytes: data.byteLength, sha256: String(ref.attachmentId).slice('sha256:'.length), verifiedBy }
}

/**
 * Minimal RIFF/WAVE header inspection (PCM or float); undefined when not WAV.
 * @param {Buffer} data
 */
export function inspectWav(data) {
  if (data.byteLength < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return undefined
  let offset = 12
  let fmt
  let dataBytes
  while (offset + 8 <= data.byteLength) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= data.byteLength) {
      fmt = {
        audioFormat: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        byteRate: data.readUInt32LE(body + 8),
        bitsPerSample: data.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      // Streaming writers may leave 0 or 0xFFFFFFFF; use the bytes actually present.
      dataBytes = size === 0 || size === 0xFFFFFFFF || body + size > data.byteLength ? data.byteLength - body : size
      break
    }
    offset = body + size + (size % 2)
  }
  if (fmt === undefined || dataBytes === undefined || fmt.byteRate === 0) return undefined
  return { ...fmt, dataBytes, durationSeconds: Math.round((dataBytes / fmt.byteRate) * 1000) / 1000 }
}

/** @param {Buffer | Uint8Array} data */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}
