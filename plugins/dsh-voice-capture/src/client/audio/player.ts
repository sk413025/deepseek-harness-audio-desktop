/**
 * Progressive reply playback for the audio event feed (CONTRACT §3). Chunks
 * are PCM s16le placed on one output timeline by `startSample / sampleRate`
 * from the stream anchor, so missing samples play as silence and reordering
 * cannot change placement. `audio.epoch` flushes queued audio from older
 * epochs; `audio.gap` re-anchors when the output has overtaken the stream.
 * A stream the host ends as `cancelled` (turn Stop, barge-in) is silenced at once.
 * Every stream keeps an actual playback timeline from the output clock ({@link PlaybackTimeline}) and emits §K.15 playback
 * report events (`scheduled`, `started`, `position`, `underrun`, `stopped`, `ended`) with epoch ms from the output clock
 * mapping `performance.timeOrigin + outputTimestamp.performanceTime`.
 * Rendering-only: nothing here is written to the Session log.
 */
import { summarizeTimeline } from './playback-timeline.ts'
import type { PlaybackTimeline, TimelineChunk, TimelineSummary } from './playback-timeline.ts'
import type { PlaybackReportEvent } from './playback-report.ts'

/** One scheduled buffer on the output. */
export interface ScheduledAudio {
  /** Stop and release the buffer (idempotent). */
  stop(): void
}

/** Output device timeline (Web Audio in the browser, a fake in tests). */
export interface AudioOutput {
  /** Current output time in seconds. */
  readonly currentTime: number
  /**
   * Output clock: the output time audible at a `performance.now()` moment (Web Audio `getOutputTimestamp`, includes
   * output latency). Undefined when the output cannot tell; `currentTime` is used then.
   */
  outputTimestamp?(): { readonly contextTime: number; readonly performanceTime: number } | undefined
  /** False while the output is suspended (nothing is audible). */
  readonly running?: boolean
  /** Output facts for playback reports. */
  info?(): { readonly sampleRate: number; readonly baseLatency: number | undefined; readonly outputLatency: number | undefined }
  /**
   * Schedule interleaved PCM frames.
   * @param samples - per-channel Float32 data.
   * @param sampleRate - sample rate of the data.
   * @param when - output time in seconds.
   * @param onEnded - called once when the buffer finished or was stopped.
   * @returns a stop handle.
   */
  schedule(samples: readonly Float32Array[], sampleRate: number, when: number, onEnded: () => void): ScheduledAudio
  /** Resume a suspended output. */
  resume(): Promise<void>
  /** Release the output. */
  close(): Promise<void>
}

/** Feed events this player consumes (subset of CONTRACT §3). Host events carry `t` (host wall clock, ms). */
export type PlaybackEvent =
  | { type: 'audio.start'; streamId: string; sessionId?: string; origin?: 'chat' | 'live' | 'recover'; provider?: string; model?: string; task?: string; t?: number }
  | { type: 'audio.format'; streamId: string; encoding: string; sampleRate: number; channels: number }
  | { type: 'audio.chunk'; streamId: string; seq: number; epoch: number; startSample: number; samples: number; data: string; t?: number }
  | { type: 'audio.epoch'; streamId: string; epoch: number; reason?: string }
  | { type: 'audio.gap'; streamId: string; fromSeq: number; toSeq: number; reason: string }
  | { type: 'audio.end'; streamId: string; status: 'completed' | 'cancelled' | 'error'; delivery: 'none' | 'final-only' | 'progressive'; chunks: number; recording?: { url?: string; recordingId?: string }; t?: number }

/** Published playback facts for the reply bar and evidence. */
export interface PlaybackSnapshot {
  readonly phase: 'idle' | 'receiving' | 'playing' | 'ended' | 'stopped' | 'error'
  readonly streamId: string | undefined
  readonly origin: 'chat' | 'live' | 'recover' | undefined
  /** Adapter task of the stream (`audio.start.task`, host 0.4.0+), e.g. `tts.speech` or `speech.s2s`. */
  readonly task: string | undefined
  /** Host classification from `audio.end`; `pending` until the stream ends. */
  readonly hostDelivery: 'pending' | 'none' | 'final-only' | 'progressive'
  /** Client observation from the output clock: audio was audible before `audio.end` (host end time) with ≥ 2 chunks received. */
  readonly playedBeforeEnd: boolean
  readonly chunks: number
  readonly droppedChunks: number
  readonly gaps: number
  readonly epochFlushes: number
  readonly sampleRate: number
  readonly receivedSeconds: number
  /** Client `performance.now()` marks (ms). */
  readonly firstChunkAt: number | undefined
  readonly playbackScheduledAt: number | undefined
  readonly endEventAt: number | undefined
  readonly status: 'completed' | 'cancelled' | 'error' | undefined
  readonly autoplay: boolean
  readonly error: string | undefined
  /** Actual playback facts of the current stream (output clock); updated when a chunk starts or stops sounding. */
  readonly timeline: TimelineSummary | undefined
}

const IDLE: PlaybackSnapshot = {
  phase: 'idle', streamId: undefined, origin: undefined, task: undefined, hostDelivery: 'pending', playedBeforeEnd: false,
  chunks: 0, droppedChunks: 0, gaps: 0, epochFlushes: 0, sampleRate: 0, receivedSeconds: 0,
  firstChunkAt: undefined, playbackScheduledAt: undefined, endEventAt: undefined, status: undefined,
  autoplay: true, error: undefined, timeline: undefined,
}

/** Output lead time before the first scheduled sample, absorbing decode jitter. */
const LEAD_SECONDS = 0.12
/** Output clock sampling period while a stream has audio scheduled. */
const SAMPLE_MS = 25
/** Report a played position at this period while audio is sounding (contract: every 200–250 ms). */
const POSITION_MS = 200

interface StreamState {
  readonly streamId: string
  readonly origin: 'chat' | 'live' | 'recover' | undefined
  sampleRate: number
  channels: number
  epoch: number
  anchor: number | undefined
  anchorSample: number
  handles: Set<ScheduledAudio>
  stopped: boolean
  ended: boolean
  readonly timeline: PlaybackTimeline
  /** End sample of the audio scheduled so far (feed sample positions). */
  scheduledEnd: number
  /** Played samples last reported (positions never go back). */
  lastPlayed: number
  reportStarted: boolean
  lastPositionAt: number | undefined
  reportClosed: boolean
  /** Scheduled chunks not yet reported: `whenAt` waits for a valid output clock (a new AudioContext is not running yet). */
  unreported: { readonly seq: number; readonly startSample: number; readonly samples: number; readonly when: number }[]
}

interface ClockReading {
  readonly contextTime: number
  readonly perf: number
  readonly source: 'output-timestamp' | 'current-time'
}

/** Player options. */
export interface PlayerOptions {
  /** Wall clock in ms (`Date.now()` scale, the host `t` scale). */
  readonly wallNow?: () => number
  /** Start periodic output clock sampling; returns the stop function. */
  readonly startSampling?: (tick: () => void) => () => void
  /** Called once per stream when its timeline is final (all audio played, silenced or skipped after the end). */
  readonly onTimeline?: (timeline: PlaybackTimeline) => void
  /** `performance.timeOrigin` (epoch ms of `performance.now()` zero). */
  readonly timeOrigin?: number
  /** §K.15 playback report event of a stream. */
  readonly onReport?: (streamId: string, event: PlaybackReportEvent) => void
  /** The stream's report is complete (ended, stopped, replaced). */
  readonly onReportEnd?: (streamId: string) => void
  /** Stream origins that get playback reports (default: all). */
  readonly reportOrigins?: ReadonlySet<string>
}

const defaultSampling = (tick: () => void): (() => void) => {
  const id = setInterval(tick, SAMPLE_MS)
  ;(id as unknown as { unref?: () => void }).unref?.()
  return () => { clearInterval(id) }
}

/**
 * Decode base64 PCM s16le into per-channel Float32 arrays.
 * @param data - base64 payload.
 * @param channels - interleaved channel count.
 * @returns channel arrays.
 */
export function decodePcm16(data: string, channels: number): Float32Array[] {
  const binary = atob(data)
  const frames = Math.floor(binary.length / 2 / channels)
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels; c++) {
      const offset = (frame * channels + c) * 2
      let value = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8)
      if (value >= 0x8000) value -= 0x10000
      out[c]![frame] = value / 0x8000
    }
  }
  return out
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Per-Session progressive player. */
export class ProgressivePlayer {
  private snapshot: PlaybackSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private stream: StreamState | undefined
  private output: AudioOutput | undefined
  private stopSampling: (() => void) | undefined
  private readonly wallNow: () => number
  private readonly startSampling: (tick: () => void) => () => void
  private readonly onTimeline: ((timeline: PlaybackTimeline) => void) | undefined
  private readonly timeOrigin: number
  private readonly onReport: ((streamId: string, event: PlaybackReportEvent) => void) | undefined
  private readonly onReportEnd: ((streamId: string) => void) | undefined
  private readonly reportOrigins: ReadonlySet<string> | undefined
  /** Origins whose audio is silenced locally (Live after the user pressed End live session) until allowed again. */
  private readonly silencedOrigins = new Set<string>()

  /**
   * @param createOutput - lazily creates the output on the first scheduled chunk.
   * @param now - client monotonic clock in ms.
   * @param options - wall clock, sampling and timeline sink.
   */
  constructor(
    private readonly createOutput: () => AudioOutput,
    private readonly now: () => number = () => performance.now(),
    options: PlayerOptions = {},
  ) {
    this.wallNow = options.wallNow ?? (() => Date.now())
    this.startSampling = options.startSampling ?? defaultSampling
    this.onTimeline = options.onTimeline
    this.timeOrigin = options.timeOrigin ?? performance.timeOrigin
    this.onReport = options.onReport
    this.onReportEnd = options.onReportEnd
    this.reportOrigins = options.reportOrigins
  }

  /** Observable source for the reply bar. */
  readonly source = {
    getSnapshot: (): PlaybackSnapshot => this.snapshot,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * Apply one feed event.
   * @param event - validated playback event.
   */
  handle(event: PlaybackEvent): void {
    switch (event.type) {
      case 'audio.start':
        this.flush()
        this.stream = {
          streamId: event.streamId, origin: event.origin, sampleRate: 0, channels: 1, epoch: 0, anchor: undefined, anchorSample: 0, handles: new Set(), stopped: false, ended: false,
          scheduledEnd: 0, lastPlayed: 0, reportStarted: false, lastPositionAt: undefined, reportClosed: false, unreported: [],
          timeline: {
            version: 1, streamId: event.streamId, origin: event.origin, task: typeof event.task === 'string' ? event.task : undefined,
            provider: typeof event.provider === 'string' ? event.provider : undefined, model: typeof event.model === 'string' ? event.model : undefined,
            startAt: this.wallNow(), hostStartT: num(event.t), sampleRate: 0, channels: 1, chunks: [], endAt: undefined, hostEndT: undefined,
            endStatus: undefined, hostDelivery: undefined, recordingId: undefined, stopAt: undefined, cancelSilencedAt: undefined, clock: undefined, finalizedAt: undefined,
          },
        }
        this.set({ ...IDLE, autoplay: this.snapshot.autoplay, phase: 'receiving', streamId: event.streamId, origin: event.origin, task: typeof event.task === 'string' ? event.task : undefined })
        if (event.origin !== undefined && this.silencedOrigins.has(event.origin)) {
          // A late stream of a closed Live session: never audible.
          this.stream.timeline.stopAt = this.wallNow()
          this.stream.stopped = true
          this.set({ ...this.snapshot, phase: 'stopped' })
        }
        return
      case 'audio.format': {
        const stream = this.current(event.streamId)
        if (stream === undefined) return
        stream.sampleRate = event.sampleRate
        stream.channels = Math.max(1, event.channels)
        stream.timeline.sampleRate = event.sampleRate
        stream.timeline.channels = stream.channels
        this.set({ ...this.snapshot, sampleRate: event.sampleRate })
        return
      }
      case 'audio.chunk':
        this.chunk(event)
        return
      case 'audio.epoch': {
        const stream = this.current(event.streamId)
        if (stream === undefined || event.epoch <= stream.epoch) return
        stream.epoch = event.epoch
        this.silence(stream, 'flushed', 'epoch')
        stream.anchor = undefined
        this.set({ ...this.snapshot, epochFlushes: this.snapshot.epochFlushes + 1 })
        return
      }
      case 'audio.gap': {
        const stream = this.current(event.streamId)
        if (stream === undefined) return
        // Re-anchor on the next chunk only when the output already passed the stream position.
        if (stream.anchor !== undefined && this.output !== undefined && this.output.currentTime > stream.anchor) stream.anchor = undefined
        this.set({ ...this.snapshot, gaps: this.snapshot.gaps + 1 })
        return
      }
      case 'audio.end': {
        const stream = this.current(event.streamId)
        if (stream === undefined) return
        this.sampleStream(stream)
        stream.ended = true
        const at = this.now()
        const timeline = stream.timeline
        timeline.endAt = this.wallNow()
        timeline.hostEndT = num(event.t)
        timeline.endStatus = event.status
        timeline.hostDelivery = event.delivery
        timeline.recordingId = typeof event.recording?.recordingId === 'string' ? event.recording.recordingId : undefined
        if (event.status === 'cancelled' && !stream.stopped) {
          // The host cancelled the reply (turn Stop, barge-in): audio already scheduled must not keep sounding.
          this.silence(stream, 'cancelled', 'cancelled')
          stream.stopped = true
          timeline.cancelSilencedAt = timeline.endAt
        }
        this.set({
          ...this.snapshot,
          hostDelivery: event.delivery,
          status: event.status,
          endEventAt: at,
          playedBeforeEnd: this.snapshot.chunks >= 2 && timeline.chunks.some(c => c.playStartAt !== undefined && c.playStartAt < (timeline.hostEndT ?? timeline.endAt!)),
          phase: stream.stopped ? 'stopped' : event.status === 'error' ? 'error' : stream.handles.size === 0 ? 'ended' : 'playing',
          timeline: summarizeTimeline(timeline),
        })
        this.maybeFinalize(stream)
        return
      }
      default:
        return
    }
  }

  /**
   * Actual played position of the current stream, from the output clock (not from received bytes).
   * @returns stream id and played milliseconds, or undefined when nothing has been scheduled.
   */
  playedPosition(): { readonly streamId: string; readonly origin: 'chat' | 'live' | 'recover' | undefined; readonly playedMs: number } | undefined {
    const stream = this.stream
    const output = this.output
    if (stream === undefined || output === undefined || stream.anchor === undefined || stream.sampleRate <= 0) return undefined
    const elapsed = output.currentTime - stream.anchor + stream.anchorSample / stream.sampleRate
    const played = Math.max(0, Math.min(elapsed, this.snapshot.receivedSeconds))
    return { streamId: stream.streamId, origin: stream.origin, playedMs: Math.round(played * 1000) }
  }

  /** Output facts for playback reports (undefined values before the first scheduled chunk). */
  outputFacts(): { readonly contextSampleRate: number | undefined; readonly baseLatencyMs: number | undefined; readonly outputLatencyMs: number | undefined; readonly clockSource: string | undefined } {
    const info = this.output?.info?.()
    const ms = (seconds: number | undefined) => (seconds === undefined || !Number.isFinite(seconds) ? undefined : Math.round(seconds * 10000) / 10)
    const source = this.output === undefined ? undefined : this.clock(this.output).source
    return {
      contextSampleRate: info?.sampleRate,
      baseLatencyMs: ms(info?.baseLatency),
      outputLatencyMs: ms(info?.outputLatency),
      clockSource: source === 'output-timestamp' ? 'AudioContext.getOutputTimestamp' : source === 'current-time' ? 'AudioContext.currentTime' : undefined,
    }
  }

  /** Timeline of the stream in progress (a copy), for evidence readers. */
  currentTimeline(): PlaybackTimeline | undefined {
    return this.stream === undefined ? undefined : JSON.parse(JSON.stringify(this.stream.timeline)) as PlaybackTimeline
  }

  /** Stop audible playback of the current stream; later chunks of it stay silent. */
  stop(): void {
    const stream = this.stream
    if (stream === undefined) return
    if (!stream.stopped) {
      stream.timeline.stopAt = this.wallNow()
      this.silence(stream, 'stopped', 'user')
    }
    stream.stopped = true
    this.set({ ...this.snapshot, phase: 'stopped', timeline: summarizeTimeline(stream.timeline) })
    this.maybeFinalize(stream)
  }

  /**
   * Silence one origin at once and keep later streams of it silent (End live session: local playback stops without waiting
   * for the network close; the host's cancelled end may come seconds later).
   * @param origin - stream origin, e.g. `live`.
   */
  silenceOrigin(origin: string): void {
    this.silencedOrigins.add(origin)
    if (this.stream?.origin === origin) this.stop()
  }

  /**
   * Allow an origin again (a new Live session starts).
   * @param origin - stream origin.
   */
  allowOrigin(origin: string): void {
    this.silencedOrigins.delete(origin)
  }

  /**
   * Toggle automatic playback of incoming replies.
   * @param enabled - whether chunks are scheduled audibly.
   */
  setAutoplay(enabled: boolean): void {
    if (!enabled) this.stop()
    this.set({ ...this.snapshot, autoplay: enabled })
  }

  /** Release the output (Session composer closed or plugin unload). */
  async dispose(): Promise<void> {
    this.flush()
    const output = this.output
    this.output = undefined
    await output?.close()
  }

  /**
   * Read the output clock once and mark chunks that started or finished sounding.
   * Runs periodically while audio is scheduled; exposed for tests.
   */
  sample(): void {
    const stream = this.stream
    if (stream !== undefined) this.sampleStream(stream)
  }

  private sampleStream(stream: StreamState): void {
    const output = this.output
    if (output === undefined) return
    this.flushScheduled(stream, false)
    const pending = stream.timeline.chunks.filter(c => c.when !== undefined && c.skipped === undefined && c.playEndAt === undefined)
    if (pending.length === 0) return
    const clock = this.clock(output)
    const audible = output.running !== false
    let changed = false
    for (const chunk of pending) {
      const rate = stream.timeline.sampleRate > 0 ? stream.timeline.sampleRate : 1
      if (chunk.playStartAt === undefined && audible && clock.contextTime >= chunk.when!) {
        chunk.playStartAt = this.epochOf(clock, chunk.when!)
        stream.timeline.clock ??= clock.source
        changed = true
      }
      const naturalEnd = chunk.when! + chunk.samples / rate
      if (chunk.playStartAt !== undefined && clock.contextTime >= naturalEnd) {
        chunk.playEndAt = Math.max(chunk.playStartAt, this.epochOf(clock, naturalEnd))
        changed = true
      }
    }
    // §K.15 positions: the samples of this stream actually played, from the output clock.
    if (!stream.stopped && audible && stream.anchor !== undefined) {
      const at = this.epochOf(clock, clock.contextTime)
      if (!stream.reportStarted && clock.contextTime >= stream.anchor) {
        stream.reportStarted = true
        this.report(stream, { type: 'started', at: this.epochOf(clock, stream.anchor) })
        this.reportPosition(stream, clock, at)
      } else if (stream.reportStarted && (stream.lastPositionAt === undefined || at - stream.lastPositionAt >= POSITION_MS)) {
        this.reportPosition(stream, clock, at)
      }
    }
    if (changed) {
      if (stream === this.stream) this.set({ ...this.snapshot, timeline: summarizeTimeline(stream.timeline) })
      this.maybeFinalize(stream)
    }
  }

  /**
   * Report scheduled chunks once the output clock maps output time to wall time reliably (running, and the output
   * timestamp available when the output has one). `force` reports with the best clock at hand (stop/end).
   */
  private flushScheduled(stream: StreamState, force: boolean): void {
    const output = this.output
    if (output === undefined || stream.unreported.length === 0) return
    const clock = this.clock(output)
    const valid = output.running !== false && (clock.source === 'output-timestamp' || output.outputTimestamp === undefined)
    if (!valid && !force) return
    const at = this.epochOf(clock, clock.contextTime)
    for (const chunk of stream.unreported) {
      this.report(stream, { type: 'scheduled', at, seq: chunk.seq, startSample: chunk.startSample, samples: chunk.samples, whenAt: this.epochOf(clock, chunk.when) })
    }
    stream.unreported = []
  }

  private clock(output: AudioOutput): ClockReading {
    const stamp = output.outputTimestamp?.()
    return stamp !== undefined && stamp.performanceTime > 0
      ? { contextTime: stamp.contextTime, perf: stamp.performanceTime, source: 'output-timestamp' }
      : { contextTime: output.currentTime, perf: this.now(), source: 'current-time' }
  }

  /** Epoch ms at which an output time is (or was) audible. */
  private epochOf(clock: ClockReading, outputTime: number): number {
    return Math.round(this.timeOrigin + clock.perf + (outputTime - clock.contextTime) * 1000)
  }

  private playedSamples(stream: StreamState, contextTime: number): number {
    if (stream.anchor === undefined || stream.sampleRate <= 0) return stream.lastPlayed
    const played = Math.min(stream.scheduledEnd, Math.round(stream.anchorSample + Math.max(0, contextTime - stream.anchor) * stream.sampleRate))
    stream.lastPlayed = Math.max(stream.lastPlayed, played)
    return stream.lastPlayed
  }

  private reportPosition(stream: StreamState, clock: ClockReading, at: number): void {
    stream.lastPositionAt = at
    this.report(stream, { type: 'position', at, playedSamples: this.playedSamples(stream, clock.contextTime) })
  }

  private report(stream: StreamState, event: PlaybackReportEvent): void {
    if (stream.reportClosed || !this.reports(stream)) return
    this.onReport?.(stream.streamId, event)
  }

  private closeReport(stream: StreamState): void {
    if (stream.reportClosed) return
    stream.reportClosed = true
    if (stream.scheduledEnd > 0 && this.reports(stream)) this.onReportEnd?.(stream.streamId)
  }

  private reports(stream: StreamState): boolean {
    return this.reportOrigins === undefined || (stream.origin !== undefined && this.reportOrigins.has(stream.origin))
  }

  /** Stop every scheduled buffer of a stream and record which chunks were cut or never sounded. */
  private silence(stream: StreamState, skip: 'stopped' | 'cancelled' | 'flushed', reason: 'user' | 'cancelled' | 'new-stream' | 'epoch'): void {
    this.sampleStream(stream)
    this.flushScheduled(stream, true)
    const at = this.wallNow()
    const output = this.output
    if (output !== undefined && stream.scheduledEnd > 0 && !stream.reportClosed) {
      const clock = this.clock(output)
      this.report(stream, { type: 'stopped', at: this.epochOf(clock, clock.contextTime), playedSamples: this.playedSamples(stream, clock.contextTime), reason })
    }
    for (const chunk of stream.timeline.chunks) {
      if (chunk.when === undefined || chunk.skipped !== undefined || chunk.playEndAt !== undefined) continue
      if (chunk.playStartAt === undefined) chunk.skipped = skip
      else chunk.playEndAt = Math.max(chunk.playStartAt, at)
    }
    this.stopHandles(stream)
    // An epoch flush continues the same stream with newer audio; every other silence ends its report.
    if (reason !== 'epoch') this.closeReport(stream)
    else stream.anchor = undefined
  }

  private chunk(event: Extract<PlaybackEvent, { type: 'audio.chunk' }>): void {
    const stream = this.current(event.streamId)
    if (stream === undefined) return
    const entry: TimelineChunk = {
      seq: event.seq, startSample: event.startSample, samples: event.samples, hostT: num(event.t), receivedAt: this.wallNow(),
      when: undefined, playStartAt: undefined, playEndAt: undefined, skipped: undefined, reanchored: false,
    }
    stream.timeline.chunks.push(entry)
    if (event.epoch < stream.epoch) {
      entry.skipped = 'old-epoch'
      this.set({ ...this.snapshot, droppedChunks: this.snapshot.droppedChunks + 1 })
      return
    }
    const at = this.now()
    const firstChunkAt = this.snapshot.firstChunkAt ?? at
    const received = this.snapshot.receivedSeconds + (stream.sampleRate > 0 ? event.samples / stream.sampleRate : 0)
    if (stream.stopped || !this.snapshot.autoplay || stream.sampleRate <= 0) {
      entry.skipped = stream.stopped ? (stream.timeline.cancelSilencedAt !== undefined ? 'cancelled' : 'stopped') : !this.snapshot.autoplay ? 'autoplay-off' : 'no-format'
      this.set({ ...this.snapshot, chunks: this.snapshot.chunks + 1, firstChunkAt, receivedSeconds: received, timeline: summarizeTimeline(stream.timeline) })
      return
    }
    let output = this.output
    if (output === undefined) {
      output = this.createOutput()
      this.output = output
      void output.resume()
    }
    if (stream.anchor === undefined) {
      stream.anchor = output.currentTime + LEAD_SECONDS
      stream.anchorSample = event.startSample
    }
    const offset = (event.startSample - stream.anchorSample) / stream.sampleRate
    let when = stream.anchor + offset
    if (when < output.currentTime) {
      // Late chunk: re-anchor so audio continues now instead of being skipped.
      stream.anchor = output.currentTime + LEAD_SECONDS
      stream.anchorSample = event.startSample
      when = stream.anchor
      entry.reanchored = true
      if (stream.reportStarted) this.report(stream, { type: 'underrun', at: this.epochOf(this.clock(output), output.currentTime), seq: event.seq })
    }
    const samples = decodePcm16(event.data, stream.channels)
    entry.when = when
    stream.scheduledEnd = Math.max(stream.scheduledEnd, event.startSample + event.samples)
    stream.unreported.push({ seq: event.seq, startSample: event.startSample, samples: event.samples, when })
    this.flushScheduled(stream, false)
    const handle = output.schedule(samples, stream.sampleRate, when, () => {
      stream.handles.delete(handle)
      this.sampleStream(stream)
      if (stream === this.stream && stream.ended && stream.handles.size === 0 && this.snapshot.phase === 'playing') {
        this.set({ ...this.snapshot, phase: 'ended' })
      }
    })
    stream.handles.add(handle)
    this.stopSampling ??= this.startSampling(() => { this.sample() })
    const scheduledAt = this.snapshot.playbackScheduledAt ?? at + Math.max(0, (when - output.currentTime) * 1000)
    this.set({
      ...this.snapshot,
      phase: stream.ended ? this.snapshot.phase : 'playing',
      chunks: this.snapshot.chunks + 1,
      firstChunkAt,
      playbackScheduledAt: scheduledAt,
      receivedSeconds: received,
      timeline: summarizeTimeline(stream.timeline),
    })
  }

  /** Publish the timeline once the stream ended and no chunk is still waiting to sound. */
  private maybeFinalize(stream: StreamState): void {
    const timeline = stream.timeline
    if (timeline.finalizedAt !== undefined || timeline.endAt === undefined) return
    if (timeline.chunks.some(c => c.when !== undefined && c.skipped === undefined && c.playEndAt === undefined)) return
    if (!stream.stopped && !stream.reportClosed && stream.scheduledEnd > 0 && this.output !== undefined) {
      this.flushScheduled(stream, true)
      const clock = this.clock(this.output)
      // Last position at the end of the audio, then `ended`.
      const at = this.epochOf(clock, clock.contextTime)
      if (stream.lastPositionAt === undefined || at > stream.lastPositionAt) this.reportPosition(stream, clock, at)
      else this.playedSamples(stream, clock.contextTime)
      this.report(stream, { type: 'ended', at, playedSamples: stream.lastPlayed })
    }
    this.closeReport(stream)
    this.finalize(stream)
  }

  private finalize(stream: StreamState): void {
    const timeline = stream.timeline
    if (timeline.finalizedAt !== undefined) return
    timeline.finalizedAt = this.wallNow()
    if (stream === this.stream && this.stopSampling !== undefined) {
      this.stopSampling()
      this.stopSampling = undefined
    }
    this.onTimeline?.(JSON.parse(JSON.stringify(timeline)) as PlaybackTimeline)
  }

  private current(streamId: string): StreamState | undefined {
    return this.stream?.streamId === streamId ? this.stream : undefined
  }

  private stopHandles(stream: StreamState): void {
    const handles = [...stream.handles]
    stream.handles.clear()
    for (const handle of handles) handle.stop()
  }

  private flush(): void {
    const stream = this.stream
    if (stream !== undefined) {
      this.silence(stream, 'flushed', 'new-stream')
      // A replaced or disposed stream publishes what it has, even without an end event.
      stream.timeline.endAt ??= this.wallNow()
      this.finalize(stream)
    }
    if (this.stopSampling !== undefined) {
      this.stopSampling()
      this.stopSampling = undefined
    }
    this.stream = undefined
  }

  private set(next: PlaybackSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Web Audio output.
 * @returns an output bound to a new AudioContext.
 */
export function webAudioOutput(): AudioOutput {
  const context = new AudioContext()
  return {
    get currentTime() { return context.currentTime },
    get running() { return context.state === 'running' },
    info: () => ({ sampleRate: context.sampleRate, baseLatency: context.baseLatency, outputLatency: context.outputLatency }),
    outputTimestamp() {
      const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : undefined
      return stamp?.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0
        ? { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime }
        : undefined
    },
    schedule(samples, sampleRate, when, onEnded) {
      const buffer = context.createBuffer(samples.length, samples[0]?.length ?? 0, sampleRate)
      samples.forEach((channel, index) => { buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index) })
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(context.destination)
      let done = false
      const finish = () => {
        if (done) return
        done = true
        node.disconnect()
        onEnded()
      }
      node.onended = finish
      node.start(Math.max(when, context.currentTime))
      return {
        stop() {
          try {
            node.stop()
          } catch {
            // Not started yet or already stopped; onended/finish still releases it.
          }
          finish()
        },
      }
    },
    resume: () => context.resume(),
    close: () => context.close(),
  }
}
