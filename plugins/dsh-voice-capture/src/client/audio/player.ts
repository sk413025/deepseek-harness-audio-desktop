/**
 * Progressive reply playback for the audio event feed (CONTRACT §3). Chunks
 * are PCM s16le placed on one output timeline by `startSample / sampleRate`
 * from the stream anchor, so missing samples play as silence and reordering
 * cannot change placement. `audio.epoch` flushes queued audio from older
 * epochs; `audio.gap` re-anchors when the output has overtaken the stream.
 * Rendering-only: nothing here is written to the Session log.
 */

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

/** Feed events this player consumes (subset of CONTRACT §3). */
export type PlaybackEvent =
  | { type: 'audio.start'; streamId: string; sessionId?: string; origin?: 'chat' | 'live'; provider?: string; model?: string; task?: string }
  | { type: 'audio.format'; streamId: string; encoding: string; sampleRate: number; channels: number }
  | { type: 'audio.chunk'; streamId: string; seq: number; epoch: number; startSample: number; samples: number; data: string }
  | { type: 'audio.epoch'; streamId: string; epoch: number; reason?: string }
  | { type: 'audio.gap'; streamId: string; fromSeq: number; toSeq: number; reason: string }
  | { type: 'audio.end'; streamId: string; status: 'completed' | 'cancelled' | 'error'; delivery: 'none' | 'final-only' | 'progressive'; chunks: number; recording?: { url?: string; recordingId?: string } }

/** Published playback facts for the reply bar and evidence. */
export interface PlaybackSnapshot {
  readonly phase: 'idle' | 'receiving' | 'playing' | 'ended' | 'stopped' | 'error'
  readonly streamId: string | undefined
  readonly origin: 'chat' | 'live' | undefined
  /** Adapter task of the stream (`audio.start.task`, host 0.4.0+), e.g. `tts.speech` or `speech.s2s`. */
  readonly task: string | undefined
  /** Host classification from `audio.end`; `pending` until the stream ends. */
  readonly hostDelivery: 'pending' | 'none' | 'final-only' | 'progressive'
  /** Client observation: playback was scheduled before `audio.end` arrived with ≥ 2 chunks received. */
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
}

const IDLE: PlaybackSnapshot = {
  phase: 'idle', streamId: undefined, origin: undefined, task: undefined, hostDelivery: 'pending', playedBeforeEnd: false,
  chunks: 0, droppedChunks: 0, gaps: 0, epochFlushes: 0, sampleRate: 0, receivedSeconds: 0,
  firstChunkAt: undefined, playbackScheduledAt: undefined, endEventAt: undefined, status: undefined,
  autoplay: true, error: undefined,
}

/** Output lead time before the first scheduled sample, absorbing decode jitter. */
const LEAD_SECONDS = 0.12

interface StreamState {
  readonly streamId: string
  readonly origin: 'chat' | 'live' | undefined
  sampleRate: number
  channels: number
  epoch: number
  anchor: number | undefined
  anchorSample: number
  handles: Set<ScheduledAudio>
  stopped: boolean
  ended: boolean
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

/** Per-Session progressive player. */
export class ProgressivePlayer {
  private snapshot: PlaybackSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private stream: StreamState | undefined
  private output: AudioOutput | undefined

  /**
   * @param createOutput - lazily creates the output on the first scheduled chunk.
   * @param now - client monotonic clock in ms.
   */
  constructor(
    private readonly createOutput: () => AudioOutput,
    private readonly now: () => number = () => performance.now(),
  ) {}

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
        this.stream = { streamId: event.streamId, origin: event.origin, sampleRate: 0, channels: 1, epoch: 0, anchor: undefined, anchorSample: 0, handles: new Set(), stopped: false, ended: false }
        this.set({ ...IDLE, autoplay: this.snapshot.autoplay, phase: 'receiving', streamId: event.streamId, origin: event.origin, task: typeof event.task === 'string' ? event.task : undefined })
        return
      case 'audio.format': {
        const stream = this.current(event.streamId)
        if (stream === undefined) return
        stream.sampleRate = event.sampleRate
        stream.channels = Math.max(1, event.channels)
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
        this.stopHandles(stream)
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
        stream.ended = true
        const at = this.now()
        this.set({
          ...this.snapshot,
          hostDelivery: event.delivery,
          status: event.status,
          endEventAt: at,
          playedBeforeEnd: this.snapshot.playbackScheduledAt !== undefined && this.snapshot.chunks >= 2,
          phase: stream.stopped ? 'stopped' : event.status === 'error' ? 'error' : stream.handles.size === 0 ? 'ended' : 'playing',
        })
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
  playedPosition(): { readonly streamId: string; readonly origin: 'chat' | 'live' | undefined; readonly playedMs: number } | undefined {
    const stream = this.stream
    const output = this.output
    if (stream === undefined || output === undefined || stream.anchor === undefined || stream.sampleRate <= 0) return undefined
    const elapsed = output.currentTime - stream.anchor + stream.anchorSample / stream.sampleRate
    const played = Math.max(0, Math.min(elapsed, this.snapshot.receivedSeconds))
    return { streamId: stream.streamId, origin: stream.origin, playedMs: Math.round(played * 1000) }
  }

  /** Stop audible playback of the current stream; later chunks of it stay silent. */
  stop(): void {
    const stream = this.stream
    if (stream === undefined) return
    stream.stopped = true
    this.stopHandles(stream)
    this.set({ ...this.snapshot, phase: 'stopped' })
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

  private chunk(event: Extract<PlaybackEvent, { type: 'audio.chunk' }>): void {
    const stream = this.current(event.streamId)
    if (stream === undefined) return
    if (event.epoch < stream.epoch) {
      this.set({ ...this.snapshot, droppedChunks: this.snapshot.droppedChunks + 1 })
      return
    }
    const at = this.now()
    const firstChunkAt = this.snapshot.firstChunkAt ?? at
    const received = this.snapshot.receivedSeconds + (stream.sampleRate > 0 ? event.samples / stream.sampleRate : 0)
    if (stream.stopped || !this.snapshot.autoplay || stream.sampleRate <= 0) {
      this.set({ ...this.snapshot, chunks: this.snapshot.chunks + 1, firstChunkAt, receivedSeconds: received })
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
    }
    const samples = decodePcm16(event.data, stream.channels)
    const handle = output.schedule(samples, stream.sampleRate, when, () => {
      stream.handles.delete(handle)
      if (stream === this.stream && stream.ended && stream.handles.size === 0 && this.snapshot.phase === 'playing') {
        this.set({ ...this.snapshot, phase: 'ended' })
      }
    })
    stream.handles.add(handle)
    const scheduledAt = this.snapshot.playbackScheduledAt ?? at + Math.max(0, (when - output.currentTime) * 1000)
    this.set({
      ...this.snapshot,
      phase: stream.ended ? this.snapshot.phase : 'playing',
      chunks: this.snapshot.chunks + 1,
      firstChunkAt,
      playbackScheduledAt: scheduledAt,
      receivedSeconds: received,
    })
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
    if (this.stream !== undefined) this.stopHandles(this.stream)
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
