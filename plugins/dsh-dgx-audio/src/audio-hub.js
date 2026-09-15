// Session-scoped, rendering-only audio event feed (CONTRACT.md §3).
//
// Producers (a chat SSE stream, a live duplex session) never block on UI subscribers. Each
// subscriber has its own bounded buffer: when it falls behind, the oldest audio chunks are
// dropped and replaced by an explicit `audio.gap`, while control events (start/format/
// epoch/end) are always kept. Recordings are written independently and stay complete.

import { randomUUID } from 'node:crypto'
import { CONTRACT_VERSION } from './constants.js'
import { decodeAudioPayload, samplesOf, sameFormat } from './pcm.js'
import { RecordingWriter, safeSegment } from './recording.js'

export const HUB_DEFAULT_LIMITS = Object.freeze({
  subscriberItems: 256,
  subscriberBytes: 8 * 1024 * 1024,
  backlogBytes: 8 * 1024 * 1024,
  backlogMs: 120_000,
  pingMs: 15_000,
  maxSessions: 64,
})

/** Ended streams kept per session feed for late client playback reports. */
const RECENT_STREAMS = 32
/** Per-stream arrival entries kept for evidence (later chunks are counted, not listed). */
export const MAX_ARRIVALS = 2048

export class AudioHub {
  /**
   * @param {object} options
   * @param {() => string} options.outputDir
   * @param {(message: string) => void} [options.log]
   * @param {Partial<typeof HUB_DEFAULT_LIMITS>} [options.limits]
   * @param {() => number} [options.now]
   */
  constructor(options) {
    this.outputDir = options.outputDir
    this.log = options.log ?? (() => {})
    this.limits = { ...HUB_DEFAULT_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    /** @type {Map<string, Feed>} */
    this.feeds = new Map()
    this.disposed = false
  }

  /** @param {string} sessionId */
  feed(sessionId) {
    let feed = this.feeds.get(sessionId)
    if (feed === undefined) {
      if (this.feeds.size >= this.limits.maxSessions) this.evictIdleFeed()
      feed = new Feed(this, sessionId)
      this.feeds.set(sessionId, feed)
    }
    return feed
  }

  evictIdleFeed() {
    for (const [id, feed] of this.feeds) {
      if (feed.subscribers.size === 0 && feed.active.size === 0) { this.feeds.delete(id); return }
    }
  }

  /**
   * Start one audio stream (a model response that produces or may produce audio).
   * @param {{ sessionId: string, provider: string, model: string, origin: 'chat' | 'live', responseId?: string, fileStem?: string }} info
   */
  openStream(info) {
    return new AudioStream(this, this.feed(String(info.sessionId ?? 'no-session')), info)
  }

  /**
   * A stream of this session that is active or ended recently (bounded), for client playback reports (§K.15).
   * @param {string} sessionId
   * @param {string} streamId
   * @returns {AudioStream | undefined}
   */
  findStream(sessionId, streamId) {
    const feed = this.feeds.get(sessionId)
    return feed?.active.get(streamId) ?? feed?.recent.get(streamId)
  }

  /**
   * Subscribe to a session feed. Yields plain JSON-serializable events.
   * @param {string} sessionId
   * @param {{ after?: number, signal?: AbortSignal }} [options]
   */
  subscribe(sessionId, options = {}) {
    return this.feed(sessionId).subscribe(options)
  }

  /** Publish one event to every session feed (model state changes). */
  broadcast(event) {
    for (const feed of this.feeds.values()) feed.publish(event)
  }

  dispose() {
    this.disposed = true
    for (const feed of this.feeds.values()) feed.closeAll()
    this.feeds.clear()
  }
}

class Feed {
  constructor(hub, sessionId) {
    this.hub = hub
    this.sessionId = sessionId
    this.cursor = 0
    /** @type {{ event: any, size: number, at: number }[]} */
    this.backlog = []
    this.backlogBytes = 0
    /** @type {Set<Subscriber>} */
    this.subscribers = new Set()
    /** @type {Map<string, AudioStream>} */
    this.active = new Map()
    /** @type {Map<string, AudioStream>} ended streams, newest last (at most RECENT_STREAMS) */
    this.recent = new Map()
  }

  remember(stream) {
    this.recent.delete(stream.id)
    this.recent.set(stream.id, stream)
    while (this.recent.size > RECENT_STREAMS) this.recent.delete(this.recent.keys().next().value)
  }

  publish(event) {
    this.cursor += 1
    const stamped = { ...event, cursor: this.cursor }
    const size = event.type === 'audio.chunk' ? event.data.length : 256
    const at = this.hub.now()
    this.backlog.push({ event: stamped, size, at })
    this.backlogBytes += size
    this.trimBacklog(at)
    for (const subscriber of this.subscribers) subscriber.offer(stamped, size)
    return stamped
  }

  trimBacklog(now) {
    const { backlogBytes, backlogMs } = this.hub.limits
    let drop = 0
    while (drop < this.backlog.length && (this.backlogBytes > backlogBytes || now - this.backlog[drop].at > backlogMs)) {
      this.backlogBytes -= this.backlog[drop].size
      drop += 1
    }
    if (drop > 0) this.backlog.splice(0, drop)
  }

  subscribe({ after, signal } = {}) {
    const subscriber = new Subscriber(this, signal)
    const hello = { type: 'hello', contractVersion: CONTRACT_VERSION, sessionId: this.sessionId, cursor: this.cursor, serverTime: this.hub.now() }
    subscriber.offer(hello, 256)
    if (Number.isInteger(after) && after >= 0 && after < this.cursor) {
      const oldest = this.backlog[0]?.event.cursor ?? this.cursor + 1
      if (after + 1 < oldest) {
        subscriber.offer({ type: 'audio.gap', streamId: null, fromCursor: after + 1, toCursor: oldest - 1, reason: 'backlog-expired', cursor: this.cursor }, 256)
      }
      for (const { event, size } of this.backlog) if (event.cursor > after) subscriber.offer(event, size)
    } else {
      // A fresh subscriber joins active streams mid-flight without replaying old audio.
      for (const stream of this.active.values()) for (const event of stream.joinEvents()) subscriber.offer(event, 256)
    }
    this.subscribers.add(subscriber)
    return subscriber.iterate()
  }

  closeAll() {
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
  }
}

class Subscriber {
  constructor(feed, signal) {
    this.feed = feed
    this.signal = signal
    /** @type {{ event: any, size: number }[]} */
    this.items = []
    this.bytes = 0
    this.closed = false
    this.wake = undefined
    this.dropped = 0
    this.onAbort = () => this.close()
    signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  offer(event, size) {
    if (this.closed) return
    this.items.push({ event, size })
    this.bytes += size
    const { subscriberItems, subscriberBytes } = this.feed.hub.limits
    while (this.items.length > subscriberItems || this.bytes > subscriberBytes) {
      if (!this.dropOldestChunk()) break
    }
    this.wake?.()
  }

  /** Replace the oldest run of chunks of one stream by a single gap marker. */
  dropOldestChunk() {
    const index = this.items.findIndex(item => item.event.type === 'audio.chunk')
    if (index < 0) return false
    const victim = this.items[index].event
    let end = index
    let toSeq = victim.seq
    while (end + 1 < this.items.length && this.items[end + 1].event.type === 'audio.chunk' && this.items[end + 1].event.streamId === victim.streamId) {
      end += 1
      toSeq = this.items[end].event.seq
      if (end - index >= 16) break
    }
    const removed = this.items.splice(index, end - index + 1)
    for (const item of removed) this.bytes -= item.size
    this.dropped += removed.length
    const previous = this.items[index - 1]?.event
    if (previous?.type === 'audio.gap' && previous.streamId === victim.streamId && previous.toSeq + 1 === victim.seq) {
      previous.toSeq = toSeq
    } else {
      this.items.splice(index, 0, { event: { type: 'audio.gap', streamId: victim.streamId, fromSeq: victim.seq, toSeq, reason: 'subscriber-overflow', cursor: victim.cursor }, size: 128 })
      this.bytes += 128
    }
    return true
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.signal?.removeEventListener('abort', this.onAbort)
    this.feed.subscribers.delete(this)
    this.wake?.()
  }

  async * iterate() {
    const pingMs = this.feed.hub.limits.pingMs
    try {
      for (;;) {
        if (this.items.length > 0) {
          const { event, size } = this.items.shift()
          this.bytes -= size
          yield event
          continue
        }
        if (this.closed) return
        const timedOut = await new Promise((resolve) => {
          const timer = setTimeout(() => { this.wake = undefined; resolve(true) }, pingMs)
          this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(false) }
        })
        if (timedOut && !this.closed) yield { type: 'ping', t: this.feed.hub.now() }
      }
    } finally {
      this.close()
    }
  }
}

export class AudioStream {
  /**
   * @param {AudioHub} hub
   * @param {Feed} feed
   * @param {{ sessionId: string, provider: string, model: string, origin: 'chat' | 'live', responseId?: string, fileStem?: string }} info
   */
  constructor(hub, feed, info) {
    this.hub = hub
    this.feed = feed
    this.info = info
    this.id = info.responseId ?? `as_${randomUUID()}`
    this.seq = 0
    this.epoch = 0
    this.format = undefined
    this.totalSamples = 0
    this.chunks = 0
    this.startedAt = hub.now()
    this.firstChunkAt = undefined
    this.lastChunkAt = undefined
    this.writer = undefined
    this.writerOpening = undefined
    this.segments = []
    this.ended = false
    // §K.15 evidence: host arrival time and sample statistics of every published chunk.
    this.arrivals = []
    this.quality = { peak: 0, clippedSamples: 0, maxBoundaryJump: 0, boundaryJumpsOver8000: 0 }
    this.lastSample = undefined
    feed.active.set(this.id, this)
    this.startEvent = feed.publish({
      type: 'audio.start', streamId: this.id, sessionId: feed.sessionId, provider: info.provider, model: info.model,
      origin: info.origin, ...(info.task === undefined ? {} : { task: info.task }), ...(info.responseId === undefined ? {} : { responseId: info.responseId }), t: this.startedAt,
    })
  }

  joinEvents() {
    const events = [this.startEvent]
    if (this.format !== undefined) events.push({ type: 'audio.format', streamId: this.id, ...this.format, cursor: this.feed.cursor })
    if (this.epoch > 0) events.push({ type: 'audio.epoch', streamId: this.id, epoch: this.epoch, reason: 'join', cursor: this.feed.cursor })
    return events
  }

  /**
   * Accept one backend audio payload: decode, record, publish.
   * @param {Buffer} bytes
   * @param {{ format?: string, sampleRate?: number, channels?: number, epoch?: number }} [hint]
   * @returns {Promise<{ samples: number, format: import('./pcm.js').PcmFormat }>}
   */
  async pushPayload(bytes, hint = {}) {
    if (this.ended) throw new Error(`audio stream ${this.id} already ended`)
    const decoded = decodeAudioPayload(bytes, hint)
    return this.pushPcm(decoded.pcm, decoded.format, hint.epoch)
  }

  /**
   * @param {Buffer} pcm
   * @param {import('./pcm.js').PcmFormat} format
   * @param {number} [epoch]
   */
  async pushPcm(pcm, format, epoch) {
    if (this.ended) throw new Error(`audio stream ${this.id} already ended`)
    if (Number.isInteger(epoch) && epoch > this.epoch) this.setEpoch(epoch, 'backend')
    const now = this.hub.now()
    if (!sameFormat(this.format, format)) {
      if (this.format !== undefined) await this.rotateWriter()
      this.format = format
      this.feed.publish({ type: 'audio.format', streamId: this.id, ...format })
    }
    const samples = samplesOf(format, pcm.byteLength)
    if (samples === 0) return { samples, format }
    this.firstChunkAt ??= now
    this.lastChunkAt = now
    const stats = pcmStats(pcm, format.channels, this.lastSample)
    this.lastSample = stats.lastSample
    this.quality.peak = Math.max(this.quality.peak, stats.peak)
    this.quality.clippedSamples += stats.clipped
    if (stats.jump !== null) {
      this.quality.maxBoundaryJump = Math.max(this.quality.maxBoundaryJump, stats.jump)
      if (stats.jump > 8000) this.quality.boundaryJumpsOver8000 += 1
    }
    if (this.arrivals.length < MAX_ARRIVALS) {
      this.arrivals.push({ seq: this.seq, t: now, startSample: this.totalSamples, samples, sampleRate: format.sampleRate, channels: format.channels, peak: stats.peak, clipped: stats.clipped, boundaryJump: stats.jump })
    }
    const writer = await this.ensureWriter()
    const written = writer.append(pcm, format)
    this.feed.publish({
      type: 'audio.chunk', streamId: this.id, seq: this.seq, epoch: this.epoch, startSample: this.totalSamples, samples,
      data: pcm.toString('base64'), t: now,
    })
    this.seq += 1
    this.chunks += 1
    this.totalSamples += samples
    await written
    return { samples, format }
  }

  setEpoch(epoch, reason) {
    if (!(epoch > this.epoch)) return
    this.epoch = epoch
    this.feed.publish({ type: 'audio.epoch', streamId: this.id, epoch, reason })
  }

  async ensureWriter() {
    if (this.writer !== undefined) return this.writer
    this.writerOpening ??= (async () => {
      const stem = this.info.fileStem ?? `${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}-${safeSegment(this.info.model)}`
      const part = this.segments.length === 0 ? '' : `-part${this.segments.length + 1}`
      const rel = `${safeSegment(this.feed.sessionId, 'no-session')}/${stem}${part}.wav`
      this.writer = await RecordingWriter.open(this.hub.outputDir(), rel)
      return this.writer
    })()
    try { return await this.writerOpening } finally { this.writerOpening = undefined }
  }

  async rotateWriter() {
    if (this.writer === undefined) return
    const recording = await this.writer.finalize({ complete: true })
    if (recording !== undefined) this.segments.push(recording)
    this.writer = undefined
  }

  /**
   * Terminal event. Classifies delivery and finalizes the recording.
   * @param {'completed' | 'cancelled' | 'error'} status
   * @param {{ terminalAt?: number, error?: { code: string, message: string } }} [options]
   */
  async end(status, options = {}) {
    if (this.ended) return this.summary
    this.ended = true
    this.feed.active.delete(this.id)
    this.feed.remember(this)
    const terminalAt = options.terminalAt ?? this.hub.now()
    let recording
    try {
      if (this.writer !== undefined) {
        const finished = await this.writer.finalize({ complete: status === 'completed' })
        if (finished !== undefined) this.segments.push(finished)
      }
      recording = this.segments.find(s => s.complete) ?? (status === 'completed' ? undefined : this.segments[0])
    } catch (error) {
      this.hub.log(`dsh-dgx-audio: cannot finalize recording for ${this.id}: ${error?.message ?? error}`)
    }
    const delivery = classifyDelivery({
      chunks: this.chunks,
      firstChunkAt: this.firstChunkAt,
      terminalAt,
      firstChunkSeconds: this.firstChunkSeconds,
    })
    this.summary = {
      streamId: this.id,
      status,
      delivery,
      chunks: this.chunks,
      totalSamples: this.totalSamples,
      format: this.format ?? null,
      startedAt: this.startedAt,
      firstChunkAt: this.firstChunkAt ?? null,
      lastChunkAt: this.lastChunkAt ?? null,
      terminalAt,
      recording: recording === undefined ? null : publicRecording(recording),
      recordingPath: recording?.path ?? null,
      segments: this.segments.length,
      arrivals: this.arrivals,
      arrivalsTruncated: this.chunks > this.arrivals.length,
      quality: { ...this.quality, clippedRatio: this.totalSamples === 0 ? 0 : round6(this.quality.clippedSamples / (this.totalSamples * (this.format?.channels ?? 1))) },
    }
    this.feed.publish({
      type: 'audio.end', streamId: this.id, status, delivery, chunks: this.chunks, totalSamples: this.totalSamples,
      ...(this.firstChunkAt === undefined ? {} : { firstChunkAt: this.firstChunkAt, lastChunkAt: this.lastChunkAt }),
      ...(status === 'completed' && recording !== undefined ? { recording: publicRecording(recording) } : {}),
      ...(options.error === undefined ? {} : { error: options.error }),
      t: terminalAt,
    })
    return this.summary
  }
}

/**
 * Sample statistics of one s16le chunk (transport-independent quality signals, §K.15): peak |sample|, samples at full
 * scale (clipped), and the jump from the previous chunk's last sample to this chunk's first (first channel).
 */
export function pcmStats(pcm, channels, previousLast) {
  const frames = Math.floor(pcm.byteLength / (2 * channels))
  let peak = 0
  let clipped = 0
  for (let i = 0; i + 1 < frames * 2 * channels; i += 2) {
    const v = pcm.readInt16LE(i)
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    if (v >= 32767 || v <= -32768) clipped += 1
  }
  const first = frames > 0 ? pcm.readInt16LE(0) : undefined
  const lastSample = frames > 0 ? pcm.readInt16LE((frames - 1) * 2 * channels) : previousLast
  const jump = previousLast === undefined || first === undefined ? null : Math.abs(first - previousLast)
  return { peak, clipped, jump, lastSample }
}

function round6(x) { return Math.round(x * 1e6) / 1e6 }

/**
 * CONTRACT.md §3: `progressive` iff ≥ 2 non-empty payloads arrived and the first one came
 * before the terminal event by more than 250 ms. One payload at the end is `final-only`.
 */
export function classifyDelivery({ chunks, firstChunkAt, terminalAt }) {
  if (chunks === 0 || firstChunkAt === undefined) return 'none'
  if (chunks >= 2 && terminalAt - firstChunkAt > 250) return 'progressive'
  return 'final-only'
}

/** Recording fields safe to send to a client (no filesystem path). */
export function publicRecording(recording) {
  const { path: _path, ...rest } = recording
  return { ...rest, url: `/api/dsh-dgx-audio/v1/recording?id=${recording.recordingId}` }
}
