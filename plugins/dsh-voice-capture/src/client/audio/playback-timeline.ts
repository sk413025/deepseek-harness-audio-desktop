/**
 * Actual playback timeline of one reply audio stream: when each chunk arrived, when it became audible on the output
 * clock and when it stopped, compared with the host's generation end (`audio.end.t`, same machine clock as the page).
 * Evidence for "played while generating" — chunk arrival alone never counts as playback.
 * Rendering-only: kept in page memory and this browser's storage; nothing is written to the Session log.
 */

/** One received chunk. All times are wall-clock ms (`Date.now()` scale). */
export interface TimelineChunk {
  readonly seq: number
  readonly startSample: number
  readonly samples: number
  /** Host publish time (`audio.chunk.t`), when present. */
  readonly hostT: number | undefined
  readonly receivedAt: number
  /** Output time (s) the chunk was scheduled at; undefined when it was not scheduled. */
  when: number | undefined
  /** Became audible on the output clock. */
  playStartAt: number | undefined
  /** Finished or was silenced. */
  playEndAt: number | undefined
  /** Why a chunk was not (fully) played. */
  skipped: 'stopped' | 'cancelled' | 'autoplay-off' | 'no-format' | 'old-epoch' | 'flushed' | undefined
  /** Scheduled at a new anchor because the output had passed its position (heard as a gap). */
  reanchored: boolean
}

/** Timeline of one stream. */
export interface PlaybackTimeline {
  readonly version: 1
  readonly streamId: string
  readonly origin: string | undefined
  readonly task: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly startAt: number
  readonly hostStartT: number | undefined
  sampleRate: number
  channels: number
  readonly chunks: TimelineChunk[]
  endAt: number | undefined
  hostEndT: number | undefined
  endStatus: 'completed' | 'cancelled' | 'error' | undefined
  hostDelivery: 'none' | 'final-only' | 'progressive' | undefined
  recordingId: string | undefined
  /** Reply bar Stop. */
  stopAt: number | undefined
  /** Scheduled audio silenced because the host ended the stream as cancelled. */
  cancelSilencedAt: number | undefined
  /** Clock the play marks came from. */
  clock: 'output-timestamp' | 'current-time' | undefined
  finalizedAt: number | undefined
}

/** Derived facts for labels and evidence. */
export interface TimelineSummary {
  readonly streamId: string
  readonly recordingId: string | undefined
  readonly task: string | undefined
  readonly verdict: 'pending' | 'progressive' | 'after-generation' | 'no-playback'
  readonly hostDelivery: PlaybackTimeline['hostDelivery']
  readonly sampleRate: number
  readonly chunksReceived: number
  readonly chunksScheduled: number
  readonly chunksPlayed: number
  readonly chunksPlayedBeforeGenerationEnd: number | undefined
  readonly firstChunkReceivedAt: number | undefined
  readonly firstPlaybackAt: number | undefined
  /** Host `audio.end.t`, else the client receipt of `audio.end`. */
  readonly generationEndAt: number | undefined
  readonly firstPlaybackBeforeGenerationEnd: boolean | undefined
  /** Generation end minus first playback (positive: sound started earlier). */
  readonly leadMs: number | undefined
  /** Played chunks start in stream order (startSample never goes back). */
  readonly inOrder: boolean
  readonly underruns: readonly { readonly afterSeq: number; readonly gapMs: number }[]
  readonly lastSoundAt: number | undefined
  readonly stopAt: number | undefined
  readonly stopKind: 'reply-stop' | 'cancelled' | undefined
  readonly soundAfterStop: boolean | undefined
  readonly playedSeconds: number
  readonly clock: PlaybackTimeline['clock']
}

/** A gap between played chunks longer than this is reported as an underrun. */
const UNDERRUN_MS = 20
/** Tolerance for a chunk start right at the Stop moment. */
const STOP_TOLERANCE_MS = 30

/**
 * Summarize a timeline.
 * @param timeline - stream timeline.
 * @returns derived facts.
 */
export function summarizeTimeline(timeline: PlaybackTimeline): TimelineSummary {
  const played = timeline.chunks.filter(c => c.playStartAt !== undefined).sort((a, b) => a.playStartAt! - b.playStartAt!)
  const generationEndAt = timeline.hostEndT ?? timeline.endAt
  const firstPlaybackAt = played[0]?.playStartAt
  const underruns: { afterSeq: number; gapMs: number }[] = []
  for (let i = 1; i < played.length; i++) {
    const previousEnd = played[i - 1]!.playEndAt
    if (previousEnd === undefined) continue
    const gap = played[i]!.playStartAt! - previousEnd
    if (gap > UNDERRUN_MS) underruns.push({ afterSeq: played[i - 1]!.seq, gapMs: Math.round(gap) })
  }
  const stopAt = timeline.stopAt ?? timeline.cancelSilencedAt
  const ends = played.map(c => c.playEndAt ?? c.playStartAt!)
  const firstBeforeEnd = firstPlaybackAt !== undefined && generationEndAt !== undefined ? firstPlaybackAt < generationEndAt : undefined
  const verdict: TimelineSummary['verdict'] = timeline.endAt === undefined
    ? 'pending'
    : played.length === 0
      ? 'no-playback'
      : firstBeforeEnd === true && timeline.chunks.length >= 2 ? 'progressive' : 'after-generation'
  return {
    streamId: timeline.streamId,
    recordingId: timeline.recordingId,
    task: timeline.task,
    verdict,
    hostDelivery: timeline.hostDelivery,
    sampleRate: timeline.sampleRate,
    chunksReceived: timeline.chunks.length,
    chunksScheduled: timeline.chunks.filter(c => c.when !== undefined).length,
    chunksPlayed: played.length,
    chunksPlayedBeforeGenerationEnd: generationEndAt === undefined ? undefined : played.filter(c => c.playStartAt! < generationEndAt).length,
    firstChunkReceivedAt: timeline.chunks[0]?.receivedAt,
    firstPlaybackAt,
    generationEndAt,
    firstPlaybackBeforeGenerationEnd: firstBeforeEnd,
    leadMs: firstPlaybackAt !== undefined && generationEndAt !== undefined ? Math.round(generationEndAt - firstPlaybackAt) : undefined,
    inOrder: played.every((c, i) => i === 0 || c.startSample >= played[i - 1]!.startSample),
    underruns,
    lastSoundAt: ends.length === 0 ? undefined : Math.max(...ends),
    stopAt,
    stopKind: timeline.stopAt !== undefined ? 'reply-stop' : timeline.cancelSilencedAt !== undefined ? 'cancelled' : undefined,
    soundAfterStop: stopAt === undefined ? undefined : played.some(c => c.playStartAt! > stopAt + STOP_TOLERANCE_MS),
    playedSeconds: Math.round(played.reduce((sum, c) => sum + Math.max(0, ((c.playEndAt ?? c.playStartAt!) - c.playStartAt!) / 1000), 0) * 1000) / 1000,
    clock: timeline.clock,
  }
}

/** Minimal storage (localStorage or a test fake). */
export interface TimelineStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** One stored entry. */
export interface StoredTimeline {
  readonly sessionId: string
  readonly timeline: PlaybackTimeline
  readonly summary: TimelineSummary
}

const STORAGE_KEY = 'dsh-voice-capture:playback-timelines'
/** Kept entries across Sessions (newest last). */
const MAX_STORED = 30

/** Finished timelines of this page, persisted in this browser, looked up by Session or recording. */
export class PlaybackTimelineStore {
  private entries: StoredTimeline[]
  private readonly listeners = new Set<() => void>()
  private version = 0

  /** @param storage - browser storage; undefined keeps entries in memory only. */
  constructor(private readonly storage: TimelineStorage | undefined = safeLocalStorage()) {
    this.entries = this.read()
  }

  /** Observable source (snapshot changes on every add). */
  readonly source = {
    getSnapshot: (): number => this.version,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * Add a finished timeline.
   * @param sessionId - owning Session.
   * @param timeline - finished timeline.
   */
  add(sessionId: string, timeline: PlaybackTimeline): void {
    const entry: StoredTimeline = { sessionId, timeline: structuredCloneSafe(timeline), summary: summarizeTimeline(timeline) }
    this.entries = [...this.entries.filter(e => e.timeline.streamId !== timeline.streamId), entry].slice(-MAX_STORED)
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.entries))
    } catch {
      // Storage full or blocked: entries stay in memory for this page.
    }
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * @param sessionId - Session filter (all when undefined).
   * @returns entries, oldest first.
   */
  list(sessionId?: string): readonly StoredTimeline[] {
    return sessionId === undefined ? this.entries : this.entries.filter(e => e.sessionId === sessionId)
  }

  /**
   * @param recordingId - host recording id from `audio.end.recording`.
   * @returns the newest entry for that recording.
   */
  byRecording(recordingId: string): StoredTimeline | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.timeline.recordingId === recordingId) return this.entries[i]
    }
    return undefined
  }

  private read(): StoredTimeline[] {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY)
      if (raw === null || raw === undefined) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((e): e is StoredTimeline => typeof e === 'object' && e !== null && typeof (e as StoredTimeline).sessionId === 'string' && typeof (e as StoredTimeline).timeline?.streamId === 'string')
          .map(e => ({ ...e, summary: summarizeTimeline(e.timeline) }))
        : []
    } catch {
      return []
    }
  }
}

function safeLocalStorage(): TimelineStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
