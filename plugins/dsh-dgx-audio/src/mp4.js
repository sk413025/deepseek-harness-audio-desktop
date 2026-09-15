import { createHash } from 'node:crypto'

// Minimal ISO-BMFF (MP4) reader for audio+video results: track kinds, codec, audio sample rate/channels, durations
// and video size, read from moov boxes only (no decode, no dependency). Enough for the result block to state whether a
// generated video really carries a sound track (catalog review §3: record the audio track facts).


function * boxes(buf, start, end) {
  let offset = start
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) return
      size = Number(buf.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) return
    yield { type, start: offset, bodyStart: offset + header, end: offset + size }
    offset += size
  }
}

function find(buf, parent, type) {
  for (const box of boxes(buf, parent.bodyStart, parent.end)) if (box.type === type) return box
  return undefined
}

function trackFacts(buf, trak) {
  const mdia = find(buf, trak, 'mdia')
  if (mdia === undefined) return undefined
  const hdlr = find(buf, mdia, 'hdlr')
  const handler = hdlr && hdlr.bodyStart + 12 <= hdlr.end ? buf.toString('latin1', hdlr.bodyStart + 8, hdlr.bodyStart + 12) : undefined
  const mdhd = find(buf, mdia, 'mdhd')
  let durationSeconds = null
  if (mdhd !== undefined) {
    const version = buf.readUInt8(mdhd.bodyStart)
    const timescale = version === 1 ? buf.readUInt32BE(mdhd.bodyStart + 20) : buf.readUInt32BE(mdhd.bodyStart + 12)
    const duration = version === 1 ? Number(buf.readBigUInt64BE(mdhd.bodyStart + 24)) : buf.readUInt32BE(mdhd.bodyStart + 16)
    if (timescale > 0) durationSeconds = Math.round((duration / timescale) * 1000) / 1000
  }
  const stsd = find(buf, find(buf, find(buf, mdia, 'minf') ?? { bodyStart: 0, end: 0 }, 'stbl') ?? { bodyStart: 0, end: 0 }, 'stsd')
  let codec = null
  let entry
  if (stsd !== undefined && stsd.bodyStart + 16 <= stsd.end) {
    // stsd: version/flags(4) entry_count(4), then sample entries (boxes).
    entry = boxes(buf, stsd.bodyStart + 8, stsd.end).next().value
    codec = entry?.type ?? null
  }
  if (handler === 'soun') {
    // AudioSampleEntry: 6 reserved + 2 data_ref + 8 reserved + channelcount(2) + samplesize(2) + 4 + samplerate(16.16)
    const base = entry?.bodyStart
    const channels = base !== undefined && base + 28 <= entry.end ? buf.readUInt16BE(base + 16) : null
    const sampleRate = base !== undefined && base + 28 <= entry.end ? buf.readUInt32BE(base + 24) >>> 16 : null
    const stbl = find(buf, find(buf, mdia, 'minf') ?? { bodyStart: 0, end: 0 }, 'stbl')
    return { kind: 'audio', codec, sampleRate, channels, durationSeconds, ...sampleDigest(buf, stbl) }
  }
  if (handler === 'vide') {
    // VisualSampleEntry: 6 + 2 + 16 predefined/reserved + width(2) + height(2)
    const base = entry?.bodyStart
    const width = base !== undefined && base + 28 <= entry.end ? buf.readUInt16BE(base + 24) : null
    const height = base !== undefined && base + 28 <= entry.end ? buf.readUInt16BE(base + 26) : null
    return { kind: 'video', codec, width, height, durationSeconds }
  }
  return { kind: handler ?? 'unknown', codec, durationSeconds }
}

/**
 * sha256 over the track's encoded sample bytes in decode order, from stsz (sizes), stsc (samples per chunk) and
 * stco/co64 (chunk offsets). Identifies the audio track independently of the video stream and container layout.
 * @returns {{ sha256: string|null, samples: number|null, sampleBytes: number|null }}
 */
function sampleDigest(buf, stbl) {
  const none = { sha256: null, samples: null, sampleBytes: null }
  if (stbl === undefined) return none
  const stsz = find(buf, stbl, 'stsz')
  const stsc = find(buf, stbl, 'stsc')
  const stco = find(buf, stbl, 'stco') ?? find(buf, stbl, 'co64')
  if (stsz === undefined || stsc === undefined || stco === undefined) return none
  const fixed = buf.readUInt32BE(stsz.bodyStart + 4)
  const count = buf.readUInt32BE(stsz.bodyStart + 8)
  const sizeOf = i => (fixed !== 0 ? fixed : buf.readUInt32BE(stsz.bodyStart + 12 + 4 * i))
  const wide = stco.type === 'co64'
  const chunks = buf.readUInt32BE(stco.bodyStart + 4)
  const offsetOf = c => (wide ? Number(buf.readBigUInt64BE(stco.bodyStart + 8 + 8 * c)) : buf.readUInt32BE(stco.bodyStart + 8 + 4 * c))
  const entries = buf.readUInt32BE(stsc.bodyStart + 4)
  const runs = Array.from({ length: entries }, (_, e) => ({ firstChunk: buf.readUInt32BE(stsc.bodyStart + 8 + 12 * e), perChunk: buf.readUInt32BE(stsc.bodyStart + 12 + 12 * e) }))
  const hash = createHash('sha256')
  let sample = 0
  let bytes = 0
  for (let c = 0; c < chunks && sample < count; c++) {
    const run = runs.findLast(r => r.firstChunk <= c + 1)
    if (run === undefined) return none
    let offset = offsetOf(c)
    for (let k = 0; k < run.perChunk && sample < count; k++, sample++) {
      const size = sizeOf(sample)
      if (offset + size > buf.length) return none
      hash.update(buf.subarray(offset, offset + size))
      offset += size
      bytes += size
    }
  }
  return sample === count ? { sha256: hash.digest('hex'), samples: count, sampleBytes: bytes } : none
}

/**
 * @param {Buffer} buf - complete MP4 file
 * @returns {{ ok: boolean, tracks: any[], video: any | null, audioTrack: { present: boolean, codec?: string|null, sampleRate?: number|null, channels?: number|null, durationSeconds?: number|null } }}
 */
export function inspectMp4(buf) {
  try {
    const top = [...boxes(buf, 0, buf.length)]
    if (!top.some(b => b.type === 'ftyp')) return { ok: false, tracks: [], video: null, audioTrack: { present: false } }
    const moov = top.find(b => b.type === 'moov')
    if (moov === undefined) return { ok: false, tracks: [], video: null, audioTrack: { present: false } }
    const tracks = [...boxes(buf, moov.bodyStart, moov.end)].filter(b => b.type === 'trak').map(t => trackFacts(buf, t)).filter(Boolean)
    const audio = tracks.find(t => t.kind === 'audio')
    const video = tracks.find(t => t.kind === 'video') ?? null
    return { ok: true, tracks, video, audioTrack: audio === undefined ? { present: false } : { present: true, codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, durationSeconds: audio.durationSeconds, sha256: audio.sha256, samples: audio.samples, sampleBytes: audio.sampleBytes } }
  } catch {
    return { ok: false, tracks: [], video: null, audioTrack: { present: false } }
  }
}

