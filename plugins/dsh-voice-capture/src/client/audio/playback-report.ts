/**
 * Playback reports for host evidence (TASK_CONTRACT §K.15, host dsh-dgx-audio ≥ 0.4.9; stream request R-MIC-PLAYBACK):
 * `POST /api/dsh-dgx-audio/v1/audio/playback {v: 1, sessionId, streamId, client, events}`.
 * The events come from the player's output clock. This module only batches and posts them. Evidence only: posting
 * never changes playback, and a failed post never blocks it.
 */
import { ROUTE_PREFIX, routeUrl } from './api.ts'
import type { FetchLike } from './api.ts'

/** One report event; times are client epoch ms from the output clock mapping. */
export type PlaybackReportEvent =
  | { readonly type: 'scheduled'; readonly at: number; readonly seq: number; readonly startSample: number; readonly samples: number; readonly whenAt: number }
  | { readonly type: 'started'; readonly at: number }
  | { readonly type: 'position'; readonly at: number; readonly playedSamples: number }
  | { readonly type: 'underrun'; readonly at: number; readonly seq?: number }
  | { readonly type: 'stopped'; readonly at: number; readonly playedSamples: number; readonly reason: string }
  | { readonly type: 'ended'; readonly at: number; readonly playedSamples: number }
  | { readonly type: 'error'; readonly at: number; readonly reason: string }

/** Output facts sent with each part. */
export interface PlaybackReportClient {
  readonly plugin: string
  readonly contextSampleRate: number | undefined
  readonly baseLatencyMs: number | undefined
  readonly outputLatencyMs: number | undefined
  readonly clockSource: string | undefined
}

/** Posting state of one stream (debug/evidence). */
export interface StreamReportState {
  readonly streamId: string
  readonly parts: number
  readonly eventsPosted: number
  readonly pending: number
  readonly closed: boolean
  /** `STREAM_UNKNOWN` (host restarted or the stream is too old): no more posts for this stream. */
  readonly unknown: boolean
  readonly lastError: string | undefined
}

/** Post the first part this long after the first played position, so evidence survives a crash. */
const FIRST_PART_MS = 1000
/** Then post again at this period while the stream plays. */
const PART_PERIOD_MS = 5000
/** Events per part (host limit 4096 events and 512 KiB). */
const MAX_EVENTS_PER_PART = 2000

interface StreamReport {
  readonly streamId: string
  pending: PlaybackReportEvent[]
  parts: number
  eventsPosted: number
  closed: boolean
  unknown: boolean
  lastError: string | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  posting: Promise<void> | undefined
  playedSeen: boolean
}

/** Timer functions (injectable for tests). */
export interface ReportTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

/** Batches and posts playback reports for one Session. */
export class PlaybackReporter {
  private readonly streams = new Map<string, StreamReport>()

  /**
   * @param fetchImpl - page fetch.
   * @param sessionId - feed Session of the streams.
   * @param client - output facts, read at each post.
   * @param timers - timer functions.
   * @param wallNow - client epoch ms, for `client.sentAt`.
   */
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly sessionId: string,
    private readonly client: () => PlaybackReportClient,
    private readonly timers: ReportTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => { clearTimeout(handle) } },
    private readonly wallNow: () => number = () => Date.now(),
  ) {}

  /**
   * Record one event of a stream.
   * @param streamId - `audio.start.streamId`.
   * @param event - report event.
   */
  event(streamId: string, event: PlaybackReportEvent): void {
    let stream = this.streams.get(streamId)
    if (stream === undefined) {
      stream = { streamId, pending: [], parts: 0, eventsPosted: 0, closed: false, unknown: false, lastError: undefined, timer: undefined, posting: undefined, playedSeen: false }
      this.streams.set(streamId, stream)
      // Keep a bounded number of finished streams for the debug state.
      for (const [id, old] of this.streams) {
        if (this.streams.size <= 32) break
        if (old.closed) this.streams.delete(id)
      }
    }
    if (stream.closed || stream.unknown) return
    stream.pending.push(event)
    if (!stream.playedSeen && event.type === 'position' && event.playedSamples > 0) {
      stream.playedSeen = true
      this.schedule(stream, FIRST_PART_MS)
    }
    if (stream.pending.length >= MAX_EVENTS_PER_PART) void this.post(stream)
  }

  /**
   * The stream's playback is over (ended, stopped or error): post everything not yet posted.
   * @param streamId - stream id.
   * @returns settles when the final part was posted or refused.
   */
  close(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId)
    if (stream === undefined || stream.closed) return Promise.resolve()
    stream.closed = true
    if (stream.timer !== undefined) this.timers.clearTimeout(stream.timer)
    stream.timer = undefined
    return this.post(stream)
  }

  /** @returns posting state per stream. */
  state(): readonly StreamReportState[] {
    return [...this.streams.values()].map(s => ({ streamId: s.streamId, parts: s.parts, eventsPosted: s.eventsPosted, pending: s.pending.length, closed: s.closed, unknown: s.unknown, lastError: s.lastError }))
  }

  /** Stop timers (Session composer gone); pending events are dropped. */
  dispose(): void {
    for (const stream of this.streams.values()) {
      if (stream.timer !== undefined) this.timers.clearTimeout(stream.timer)
      stream.timer = undefined
    }
  }

  private schedule(stream: StreamReport, ms: number): void {
    if (stream.timer !== undefined || stream.closed) return
    stream.timer = this.timers.setTimeout(() => {
      stream.timer = undefined
      void this.post(stream).then(() => { if (!stream.closed && !stream.unknown) this.schedule(stream, PART_PERIOD_MS) })
    }, ms)
  }

  private post(stream: StreamReport): Promise<void> {
    // One post at a time per stream; a later call sends what accumulated meanwhile.
    const run = async (): Promise<void> => {
      while (stream.pending.length > 0 && !stream.unknown) {
        const events = stream.pending.slice(0, MAX_EVENTS_PER_PART)
        const client = this.client()
        const body = { v: 1, sessionId: this.sessionId, streamId: stream.streamId, client: { ...client, sentAt: this.wallNow() }, events }
        let response: Response
        try {
          response = await this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/audio/playback`), {
            method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          })
        } catch (error) {
          // Network failure: keep the events for the next part (or lose them if this was the last).
          stream.lastError = error instanceof Error ? error.message : String(error)
          return
        }
        if (response.status === 404) {
          // STREAM_UNKNOWN (or a host without the route): never retried.
          stream.unknown = true
          stream.lastError = `HTTP 404 ${await errorCode(response)}`
          stream.pending = []
          return
        }
        if (!response.ok) {
          stream.lastError = `HTTP ${response.status} ${await errorCode(response)}`
          // A refused part (400) would be refused again: drop it, keep later events.
          if (response.status >= 400 && response.status < 500) stream.pending.splice(0, events.length)
          return
        }
        stream.pending.splice(0, events.length)
        stream.parts++
        stream.eventsPosted += events.length
        stream.lastError = undefined
      }
    }
    const previous = stream.posting ?? Promise.resolve()
    const next = previous.then(run)
    stream.posting = next
    return next
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    const code = (body as { error?: { code?: unknown } })?.error?.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}
