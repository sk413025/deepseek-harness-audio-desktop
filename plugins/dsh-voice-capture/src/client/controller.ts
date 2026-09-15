/**
 * Apply-world recording controller. It owns the only live capture, one
 * prepared clip per Session, and the upload/prompt of that clip. Components
 * read {@link VoiceSnapshot} through the per-Session observable returned by
 * {@link VoiceCaptureController.source} and act through bound callbacks;
 * MediaStream, AudioContext and Blob URLs never leave this module.
 *
 * Recording starts only from an explicit `start()` call (a user click) and
 * is never started by loading, navigation or configuration.
 */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AudioInputDevice, CaptureBackend, CaptureFailure, CaptureSession,
} from './capture.ts'
import { CaptureError } from './capture.ts'
import { encodeWavPcm16, joinChunks, resampleMonoAsync, sha256Hex } from './wav.ts'
import { withOptions } from './audio/tasks.ts'

/** Recording limits and output format. */
export interface VoiceCaptureSpec {
  /** Hard recording limit; capture stops automatically when reached. */
  readonly maxDurationMs: number
  /** Clips shorter than this are refused as accidental taps. */
  readonly minDurationMs: number
  /** Output WAV sample rate; 0 keeps the capture context rate. */
  readonly targetSampleRate: number
  /** Period of elapsed-time and level publications while recording. */
  readonly meterIntervalMs: number
}

/** Documented defaults; 16 kHz mono PCM16 matches the verified audio-attachment route. */
export const DEFAULT_SPEC: VoiceCaptureSpec = {
  maxDurationMs: 120_000,
  minDurationMs: 300,
  targetSampleRate: 16_000,
  meterIntervalMs: 100,
}

/** Recording panel phase for one Session. */
export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'encoding' | 'preview' | 'sending' | 'error'

/** Failure categories shown by the panel. */
export type VoiceErrorCode =
  | CaptureFailure
  | 'busy-elsewhere'
  | 'too-short'
  | 'encode-failed'
  | 'upload-failed'
  | 'prompt-failed'
  | 'session-unavailable'
  | 'model-not-ready'

/** Prepared clip shown in the preview. */
export interface VoiceClip {
  /** Blob URL for the preview player; revoked when the clip is released. */
  readonly url: string
  readonly name: string
  readonly mimeType: 'audio/wav'
  readonly bytes: number
  readonly durationMs: number
  readonly sampleRate: number
  readonly channels: 1
  /** SHA-256 of the exact bytes that preview plays and send uploads. */
  readonly sha256: string | undefined
  /** Whether capture ended because the duration limit was reached. */
  readonly limitReached: boolean
  /** Label of the device that produced the clip. */
  readonly deviceLabel: string
}

/** Upload progress while sending. */
export interface VoiceSendProgress {
  readonly stage: 'uploading' | 'submitting'
  readonly loaded: number
  readonly total: number | undefined
}

/** Last completed send, kept for the confirmation line and evidence. */
export interface VoiceSentReceipt {
  readonly name: string
  readonly bytes: number
  readonly sha256: string | undefined
  /** Host attachment identity and byte length admitted with the prompt. */
  readonly attachmentId: string
  readonly attachmentBytes: number
  readonly at: number
}

/** Immutable per-Session view published to components. */
export interface VoiceSnapshot {
  readonly phase: VoicePhase
  readonly supported: boolean
  readonly elapsedMs: number
  readonly limitMs: number
  /** RMS input level in [0, 1] while recording. */
  readonly level: number
  readonly devices: readonly AudioInputDevice[]
  /** Chosen input id; `''` is the system default. */
  readonly selectedDeviceId: string
  /** Label of the device being recorded. */
  readonly activeDeviceLabel: string
  readonly clip: VoiceClip | undefined
  readonly progress: VoiceSendProgress | undefined
  readonly error: { readonly code: VoiceErrorCode; readonly detail: string } | undefined
  readonly lastSent: VoiceSentReceipt | undefined
}

/** Observable source consumed through the slot `hooks` compartment. */
export interface VoiceSource {
  getSnapshot(): VoiceSnapshot
  subscribe(listener: () => void): () => void
}

/** Upload capability (structural subset of `ctx.fileUpload`). */
export interface UploadPort {
  upload(
    sessionId: SessionId,
    data: Blob,
    name: string,
    signal: AbortSignal,
    onProgress: (progress: { readonly loaded: number; readonly total?: number }) => void,
  ): Promise<RemoteResult<FileUploadValue>>
}

/** Session capability (structural subset of `ctx.sessions`). */
export interface SessionPort {
  binding(id: SessionId): { readonly session: Pick<SessionFace, 'beginSubmission' | 'prompt'> } | undefined
}

/** Result of a send attempt. */
export type SendOutcome = 'sent' | 'cancelled' | 'failed' | 'ignored'

interface SessionState {
  phase: VoicePhase
  clip: (VoiceClip & { readonly data: Uint8Array }) | undefined
  progress: VoiceSendProgress | undefined
  error: { code: VoiceErrorCode; detail: string } | undefined
  lastSent: VoiceSentReceipt | undefined
  sendAbort: AbortController | undefined
  snapshot: VoiceSnapshot | undefined
}

interface ActiveCapture {
  readonly sessionId: SessionId
  /** Resolved once `open()` settles. */
  session: CaptureSession | undefined
  readonly chunks: Float32Array[]
  frames: number
  maxFrames: number
  level: number
  startedAt: number
  meter: ReturnType<typeof setInterval> | undefined
  finishing: boolean
  /** Set when stop/cancel arrives while the permission request is pending. */
  pendingStop: 'stop' | 'cancel' | undefined
}

/** Remember-device storage key (best effort; absent storage keeps the default). */
const DEVICE_KEY = 'dsh-voice-capture.deviceId'

/** Per-page recording controller shared by every Session composer. */
export class VoiceCaptureController {
  private readonly states = new Map<SessionId, SessionState>()
  private readonly sources = new Map<SessionId, VoiceSource>()
  private readonly listeners = new Set<() => void>()
  private devices: readonly AudioInputDevice[] = []
  private selectedDeviceId = ''
  private active: ActiveCapture | undefined
  private disposed = false
  private readonly unwatchDevices: () => void

  /**
   * @param backend - media access.
   * @param upload - file upload service.
   * @param sessions - Session bindings.
   * @param spec - limits and format.
   * @param clock - monotonic milliseconds (injectable for tests).
   * @param storage - device preference storage, when available.
   * @param micBusyElsewhere - whether another feature (Live mode) holds the microphone.
   */
  constructor(
    private readonly backend: CaptureBackend,
    private readonly upload: UploadPort,
    private readonly sessions: SessionPort,
    private readonly spec: VoiceCaptureSpec = DEFAULT_SPEC,
    private readonly clock: () => number = () => performance.now(),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeLocalStorage(),
    private readonly micBusyElsewhere: () => boolean = () => false,
  ) {
    this.selectedDeviceId = readPreference(storage)
    this.unwatchDevices = backend.support() === undefined
      ? backend.onDeviceChange(() => { void this.refreshDevices() })
      : () => {}
  }

  /**
   * Identity-stable observable for one Session.
   * @param sessionId - Session whose composer renders the controls.
   * @returns the source (same object for the same id).
   */
  source(sessionId: SessionId): VoiceSource {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = {
        getSnapshot: () => this.snapshotOf(sessionId),
        subscribe: (listener) => {
          this.listeners.add(listener)
          return () => { this.listeners.delete(listener) }
        },
      }
      this.sources.set(sessionId, source)
    }
    return source
  }

  /**
   * Start recording for a Session. Only a direct user action may call this.
   * @param sessionId - Session that will own the clip.
   */
  async start(sessionId: SessionId): Promise<void> {
    if (this.disposed) return
    const state = this.state(sessionId)
    if (state.phase === 'requesting' || state.phase === 'recording' || state.phase === 'encoding' || state.phase === 'sending') return
    const unsupported = this.backend.support()
    if (unsupported !== undefined) {
      this.fail(sessionId, unsupported, '')
      return
    }
    if (this.active !== undefined || this.micBusyElsewhere()) {
      this.fail(sessionId, 'busy-elsewhere', '')
      return
    }
    this.releaseClip(state)
    state.error = undefined
    state.phase = 'requesting'
    const capture: ActiveCapture = {
      sessionId,
      session: undefined,
      chunks: [],
      frames: 0,
      maxFrames: Number.POSITIVE_INFINITY,
      level: 0,
      startedAt: this.clock(),
      meter: undefined,
      finishing: false,
      pendingStop: undefined,
    }
    this.active = capture
    this.publish(sessionId)
    let opened: CaptureSession
    try {
      opened = await this.backend.open({
        deviceId: this.selectedDeviceId,
        onFrames: chunk => this.onFrames(capture, chunk),
        onEnded: () => { void this.stop(sessionId) },
      })
    } catch (error) {
      if (this.active === capture) this.active = undefined
      if (state.phase !== 'requesting') return
      const failure = error instanceof CaptureError ? error.failure : 'capture-failed'
      // A remembered device that disappeared falls back to the system default next time.
      if (failure === 'no-device' && this.selectedDeviceId !== '') this.selectDevice('')
      this.fail(sessionId, failure, error instanceof Error ? error.message : String(error))
      void this.refreshDevices()
      return
    }
    capture.session = opened
    if (this.disposed || this.active !== capture || capture.pendingStop === 'cancel') {
      await opened.close()
      if (this.active === capture) this.active = undefined
      if (state.phase === 'requesting') {
        state.phase = 'idle'
        this.publish(sessionId)
      }
      return
    }
    capture.maxFrames = Math.floor(opened.sampleRate * this.spec.maxDurationMs / 1000)
    capture.startedAt = this.clock()
    state.phase = 'recording'
    capture.meter = setInterval(() => { this.publish(sessionId) }, this.spec.meterIntervalMs)
    this.publish(sessionId)
    void this.refreshDevices()
    if (capture.pendingStop === 'stop') await this.stop(sessionId)
  }

  /**
   * Stop recording and prepare the preview clip.
   * @param sessionId - Session that owns the capture.
   */
  async stop(sessionId: SessionId): Promise<void> {
    const capture = this.active
    if (capture === undefined || capture.sessionId !== sessionId) return
    if (capture.session === undefined) {
      capture.pendingStop = 'stop'
      return
    }
    await this.finish(capture, false)
  }

  /**
   * Discard the recording or clip, or abort an in-flight send (the clip is kept).
   * @param sessionId - Session whose panel issued the cancel.
   */
  async cancel(sessionId: SessionId): Promise<void> {
    const state = this.state(sessionId)
    const capture = this.active
    if (capture !== undefined && capture.sessionId === sessionId) {
      if (capture.session === undefined) {
        capture.pendingStop = 'cancel'
        state.phase = 'idle'
        this.publish(sessionId)
        return
      }
      this.active = undefined
      capture.finishing = true
      clearInterval(capture.meter)
      capture.chunks.length = 0
      await capture.session.close()
      state.phase = 'idle'
      this.publish(sessionId)
      return
    }
    if (state.phase === 'sending') {
      state.sendAbort?.abort()
      return
    }
    this.releaseClip(state)
    state.error = undefined
    state.phase = 'idle'
    this.publish(sessionId)
  }

  /**
   * Upload the prepared clip and prompt the Session with it.
   * @param sessionId - Session that owns the clip.
   * @param text - optional prompt text sent after the audio part.
   * @returns the settlement.
   */
  async send(
    sessionId: SessionId,
    text: string,
    extras: {
      readonly block?: string | undefined
      /** Consented reference clips (slot order), uploaded before the recording. */
      readonly references?: readonly { readonly file: File; readonly name: string }[] | undefined
      /** Single reference clip (0.3.0 form); ignored when `references` is given. */
      readonly reference?: { readonly file: File; readonly name: string } | undefined
      /** Activation check run before upload and again before admission; a reason blocks the send. */
      readonly blocked?: (() => string | undefined) | undefined
    } = {},
  ): Promise<SendOutcome> {
    const state = this.state(sessionId)
    const clip = state.clip
    if (state.phase !== 'preview' || clip === undefined) return 'ignored'
    const notReady = extras.blocked?.()
    if (notReady !== undefined) {
      state.error = { code: 'model-not-ready', detail: notReady }
      this.publish(sessionId)
      return 'failed'
    }
    const abort = new AbortController()
    state.sendAbort = abort
    state.error = undefined
    state.phase = 'sending'
    state.progress = { stage: 'uploading', loaded: 0, total: clip.bytes }
    this.publish(sessionId)
    const settleBack = (code: VoiceErrorCode | undefined, detail: string): SendOutcome => {
      state.sendAbort = undefined
      state.progress = undefined
      if (abort.signal.aborted) {
        state.phase = 'preview'
        this.publish(sessionId)
        return 'cancelled'
      }
      state.phase = 'preview'
      state.error = code === undefined ? undefined : { code, detail }
      this.publish(sessionId)
      return 'failed'
    }
    let uploaded: RemoteResult<FileUploadValue>
    try {
      const file = new File([clip.data as Uint8Array<ArrayBuffer>], clip.name, { type: clip.mimeType })
      uploaded = await this.upload.upload(sessionId, file, clip.name, abort.signal, (progress) => {
        if (state.sendAbort !== abort) return
        state.progress = { stage: 'uploading', loaded: progress.loaded, total: progress.total ?? clip.bytes }
        this.publish(sessionId)
      })
    } catch (error) {
      return settleBack('upload-failed', error instanceof Error ? error.message : String(error))
    }
    if (!uploaded.ok) return settleBack('upload-failed', `${uploaded.error.code}: ${uploaded.error.message}`)
    if (abort.signal.aborted) return settleBack(undefined, '')
    const referenceClips = extras.references ?? (extras.reference === undefined ? [] : [extras.reference])
    const references: FileUploadValue[] = []
    for (const clip of referenceClips) {
      try {
        const referenceUpload = await this.upload.upload(sessionId, clip.file, clip.name, abort.signal, () => {})
        if (!referenceUpload.ok) return settleBack('upload-failed', `${referenceUpload.error.code}: ${referenceUpload.error.message}`)
        references.push(referenceUpload.value)
      } catch (error) {
        return settleBack('upload-failed', error instanceof Error ? error.message : String(error))
      }
      if (abort.signal.aborted) return settleBack(undefined, '')
    }
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return settleBack('session-unavailable', '')
    const stillNotReady = extras.blocked?.()
    if (stillNotReady !== undefined) return settleBack('model-not-ready', stillNotReady)
    state.progress = { stage: 'submitting', loaded: clip.bytes, total: clip.bytes }
    this.publish(sessionId)
    const ref: FileAttachmentRef = uploaded.value.file
    const combined = withOptions(extras.block, text)
    const textParts = combined === '' ? [] : [combined]
    const submission = binding.session.beginSubmission({
      mode: 'queue',
      text: combined,
      attachments: [...references.map(reference => ({ type: 'file' as const, value: reference.file })), { type: 'file', value: ref }],
    })
    let admitted: RemoteResult<{ accepted: true }>
    try {
      admitted = await binding.session.prompt(
        [
          ...references.map(reference => ({ type: 'file' as const, receiptId: reference.receiptId })),
          { type: 'file', receiptId: uploaded.value.receiptId },
          ...textParts.map(part => ({ type: 'text' as const, text: part })),
        ],
        'queue',
        abort.signal,
        submission.requestId,
      )
    } catch (error) {
      submission.abandon()
      return settleBack('prompt-failed', error instanceof Error ? error.message : String(error))
    }
    if (!admitted.ok) return settleBack('prompt-failed', `${admitted.error.code}: ${admitted.error.message}`)
    state.sendAbort = undefined
    state.progress = undefined
    state.lastSent = {
      name: clip.name,
      bytes: clip.bytes,
      sha256: clip.sha256,
      attachmentId: String(ref.attachmentId),
      attachmentBytes: ref.bytes,
      at: Date.now(),
    }
    this.releaseClip(state)
    state.phase = 'idle'
    this.publish(sessionId)
    return 'sent'
  }

  /**
   * Take the prepared clip bytes out of the controller (reference-voice capture) and return to idle.
   * @param sessionId - Session that owns the clip.
   * @returns the WAV bytes and name, or undefined without a clip.
   */
  takeClip(sessionId: SessionId): { readonly data: Uint8Array; readonly name: string } | undefined {
    const state = this.state(sessionId)
    const clip = state.clip
    if (clip === undefined || state.phase !== 'preview') return undefined
    const taken = { data: clip.data, name: clip.name }
    this.releaseClip(state)
    state.phase = 'idle'
    this.publish(sessionId)
    return taken
  }

  /**
   * Choose the input device for the next recording.
   * @param deviceId - device id, `''` for the system default.
   */
  selectDevice(deviceId: string): void {
    this.selectedDeviceId = deviceId
    try {
      this.storage?.setItem(DEVICE_KEY, deviceId)
    } catch {
      // Storage quota or privacy mode refused the write; the in-memory choice still applies.
    }
    this.publishAll()
  }

  /**
   * Clear a displayed error without discarding a prepared clip.
   * @param sessionId - Session whose panel dismissed the error.
   */
  dismissError(sessionId: SessionId): void {
    const state = this.state(sessionId)
    state.error = undefined
    if (state.phase === 'error') state.phase = state.clip === undefined ? 'idle' : 'preview'
    this.publish(sessionId)
  }

  /**
   * The Session's composer left the page (navigation or view change): stop a
   * capture it owns so no track outlives its controls. The clip is kept.
   * @param sessionId - Session whose controls unmounted.
   */
  async detach(sessionId: SessionId): Promise<void> {
    const capture = this.active
    if (capture === undefined || capture.sessionId !== sessionId) return
    await this.stop(sessionId)
  }

  /** Re-read the input list (labels appear after permission). */
  async refreshDevices(): Promise<void> {
    if (this.disposed || this.backend.support() !== undefined) return
    try {
      this.devices = await this.backend.listDevices()
    } catch {
      // Enumeration rejected (policy or teardown); keep the last list.
      return
    }
    this.publishAll()
  }

  /** Release every capture, send and clip (plugin unload or page hide). */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unwatchDevices()
    const capture = this.active
    this.active = undefined
    if (capture !== undefined) {
      capture.finishing = true
      clearInterval(capture.meter)
      capture.pendingStop = 'cancel'
      await capture.session?.close()
    }
    for (const state of this.states.values()) {
      state.sendAbort?.abort()
      this.releaseClip(state)
      state.phase = 'idle'
    }
    this.publishAll()
    this.listeners.clear()
  }

  /** Whether a capture currently holds the microphone (for tests and diagnostics). */
  get capturing(): boolean {
    return this.active !== undefined
  }

  private onFrames(capture: ActiveCapture, chunk: Float32Array): void {
    if (capture.finishing || this.active !== capture) return
    const room = capture.maxFrames - capture.frames
    const take = Math.min(room, chunk.length)
    if (take > 0) {
      const kept = take === chunk.length ? chunk : chunk.slice(0, take)
      capture.chunks.push(kept)
      capture.frames += take
      let power = 0
      for (let i = 0; i < kept.length; i++) power += kept[i]! * kept[i]!
      const rms = Math.sqrt(power / Math.max(1, kept.length))
      capture.level = Math.max(Math.min(1, rms * 4), capture.level * 0.8)
    }
    if (capture.frames >= capture.maxFrames && capture.session !== undefined) void this.finish(capture, true)
  }

  private async finish(capture: ActiveCapture, limitReached: boolean): Promise<void> {
    if (capture.finishing) return
    capture.finishing = true
    clearInterval(capture.meter)
    const sessionId = capture.sessionId
    const state = this.state(sessionId)
    const opened = capture.session!
    this.active = undefined
    state.phase = 'encoding'
    this.publish(sessionId)
    await opened.close()
    const durationMs = capture.frames * 1000 / opened.sampleRate
    if (durationMs < this.spec.minDurationMs) {
      capture.chunks.length = 0
      this.fail(sessionId, 'too-short', '')
      return
    }
    try {
      const samples = joinChunks(capture.chunks, capture.frames)
      capture.chunks.length = 0
      const rate = this.spec.targetSampleRate === 0 ? opened.sampleRate : this.spec.targetSampleRate
      const resampled = await resampleMonoAsync(samples, opened.sampleRate, rate)
      const wav = encodeWavPcm16(resampled, rate)
      const sha256 = await sha256Hex(wav.bytes)
      if (this.disposed || state.phase !== 'encoding') return
      const blob = new Blob([wav.bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' })
      state.clip = {
        data: wav.bytes,
        url: URL.createObjectURL(blob),
        name: clipName(new Date()),
        mimeType: 'audio/wav',
        bytes: wav.bytes.byteLength,
        durationMs: wav.durationMs,
        sampleRate: wav.sampleRate,
        channels: 1,
        sha256,
        limitReached,
        deviceLabel: opened.deviceLabel,
      }
      state.phase = 'preview'
      this.publish(sessionId)
    } catch (error) {
      this.fail(sessionId, 'encode-failed', error instanceof Error ? error.message : String(error))
    }
  }

  private fail(sessionId: SessionId, code: VoiceErrorCode, detail: string): void {
    const state = this.state(sessionId)
    state.error = { code, detail }
    state.phase = state.clip === undefined ? 'error' : 'preview'
    this.publish(sessionId)
  }

  private releaseClip(state: SessionState): void {
    const clip = state.clip
    state.clip = undefined
    // Revoke after the preview element has had a render to detach from the URL.
    if (clip !== undefined) setTimeout(() => { URL.revokeObjectURL(clip.url) }, 0)
  }

  private state(sessionId: SessionId): SessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = {
        phase: 'idle',
        clip: undefined,
        progress: undefined,
        error: undefined,
        lastSent: undefined,
        sendAbort: undefined,
        snapshot: undefined,
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  private snapshotOf(sessionId: SessionId): VoiceSnapshot {
    const state = this.state(sessionId)
    if (state.snapshot !== undefined) return state.snapshot
    const capture = this.active?.sessionId === sessionId ? this.active : undefined
    const recording = capture !== undefined && state.phase === 'recording'
    const sampleRate = capture?.session?.sampleRate ?? 0
    const clip = state.clip === undefined ? undefined : withoutData(state.clip)
    state.snapshot = {
      phase: state.phase,
      supported: this.backend.support() === undefined,
      elapsedMs: recording && sampleRate > 0 ? Math.round(capture.frames * 1000 / sampleRate) : 0,
      limitMs: this.spec.maxDurationMs,
      level: recording ? capture.level : 0,
      devices: this.devices,
      selectedDeviceId: this.selectedDeviceId,
      activeDeviceLabel: capture?.session?.deviceLabel ?? '',
      clip,
      progress: state.progress,
      error: state.error,
      lastSent: state.lastSent,
    }
    return state.snapshot
  }

  private publish(sessionId: SessionId): void {
    const state = this.state(sessionId)
    state.snapshot = undefined
    for (const listener of [...this.listeners]) listener()
  }

  private publishAll(): void {
    for (const state of this.states.values()) state.snapshot = undefined
    for (const listener of [...this.listeners]) listener()
  }
}

function withoutData(clip: VoiceClip & { readonly data: Uint8Array }): VoiceClip {
  const { data: _data, ...rest } = clip
  return rest
}

function clipName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `recording-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.wav`
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // Accessing localStorage throws on opaque origins; the preference stays in memory.
    return undefined
  }
}

function readPreference(storage: Pick<Storage, 'getItem'> | undefined): string {
  try {
    return storage?.getItem(DEVICE_KEY) ?? ''
  } catch {
    // Privacy mode can refuse reads; use the system default.
    return ''
  }
}
