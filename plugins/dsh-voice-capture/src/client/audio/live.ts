/**
 * Explicit Live mode (CONTRACT §5): the user starts a live session, capture
 * frames are transmitted while recording continues, the user ends input
 * (commit) and later closes the session. The host owns the backend
 * connection; this client only calls the Harness routes. Nothing starts
 * without a user action and Live never replaces preview-and-send silently.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AudioRouteError, ROUTE_PREFIX, requestJson, routeUrl } from './api.ts'
import type { CapabilityState, FetchLike } from './api.ts'
import type { CaptureBackend, CaptureSession } from '../capture.ts'
import { turnSummaryOf } from './turn-mode.ts'
import type { TurnSummary } from './turn-mode.ts'
import { CaptureError } from '../capture.ts'
import type { ModelChoice } from './capabilities.ts'

/** Live lifecycle phase. */
export type LivePhase = 'idle' | 'opening' | 'live' | 'awaiting' | 'closing' | 'closed' | 'error'

/** One live response observed on the feed. */
export interface LiveResponse {
  readonly responseId: string
  readonly status: 'created' | 'completed' | 'cancelled'
  readonly reason?: string
}

/** Live panel kind (TASK_CONTRACT 0.2 §H). */
export type LiveKind = 'transcription' | 'conversation' | 'turn' | 'text-input'

/** One text stream of the live session: input transcript or response text. */
export interface LiveTextTurn {
  readonly id: string
  readonly kind: 'transcript' | 'response'
  readonly text: string
  /** Committed by `live.transcript.done`. */
  readonly final: boolean
}

/**
 * Panel kind for the task named by `live/open` (adapter id, or a proposal-era UI id).
 * @param task - opened task.
 * @returns kind, or undefined for an unknown task.
 */
export function liveKindOf(task: string | undefined): LiveKind | undefined {
  switch (task) {
    case 'asr.realtime':
    case 'realtime-asr':
      return 'transcription'
    case 'duplex':
      return 'conversation'
    case 'speech.s2s.realtime':
      return 'turn'
    case 'tts.stream-input':
      return 'text-input'
    default:
      return undefined
  }
}

/** One server-reported capability of the open session (from `session.created`, via the host's capability entry). */
export interface LiveServerFact {
  readonly state: CapabilityState
  readonly detail?: string
  readonly implementationLevel?: string
}

/** What the backend itself reported for this live session; absent until the host relays it. */
export interface LiveServerFacts {
  readonly liveInput?: LiveServerFact
  readonly fullDuplex?: LiveServerFact
  readonly bargeIn?: LiveServerFact
  readonly sessionResume?: LiveServerFact
}

function serverFacts(value: unknown): LiveServerFacts | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const fact = (key: string): { [k: string]: LiveServerFact } => {
    const entry = raw[key] as Record<string, unknown> | undefined
    if (typeof entry !== 'object' || entry === null || typeof entry.state !== 'string') return {}
    return { [key]: {
      state: entry.state as CapabilityState,
      ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
      ...(typeof entry.implementationLevel === 'string' ? { implementationLevel: entry.implementationLevel } : {}),
    } }
  }
  const facts = { ...fact('liveInput'), ...fact('fullDuplex'), ...fact('bargeIn'), ...fact('sessionResume') }
  return Object.keys(facts).length === 0 ? undefined : facts
}

/** Append a text piece; sentence pieces that arrive without separating whitespace get one space. */
function joinText(previous: string, next: string): string {
  if (previous === '' || next === '' || /\s$/.test(previous) || /^\s/.test(next)) return previous + next
  return /[.!?。！？]$/.test(previous) ? `${previous} ${next}` : previous + next
}

/** PCM16 encodings the UI can produce; the host converts to the wire encoding itself. */
const PCM16_ENCODINGS: ReadonlySet<string> = new Set(['pcm_s16le', 'pcm16', 's16le'])

/** Published live facts. */
export interface LiveSnapshot {
  readonly phase: LivePhase
  readonly liveId: string | undefined
  /** Opening waits for the microphone permission (asked before the host session is opened). */
  readonly waitingMic: boolean
  /** Turn settings the host actually sent (`turn` of live/open or `live.state ready`, host ≥ 0.4.12); undefined = not reported. */
  readonly turn: TurnSummary | undefined
  /** The turn mode this panel asked for (`send` of the chosen mode); undefined when no mode choice was offered. */
  readonly requestedTurnMode: string | undefined
  /** Capability evidence layer at open time (label source). */
  readonly evidence: CapabilityState
  /** Live transcription (no speech), duplex conversation, turn-based voice reply, or streamed text-to-speech. */
  readonly kind: LiveKind
  /** Adapter task and wire reported by `live/open`. */
  readonly task: string | undefined
  readonly wire: string | undefined
  /** Capabilities of this session as reported by the backend (`implementation_level`, input append, barge-in). */
  readonly server: LiveServerFacts | undefined
  readonly model: ModelChoice | undefined
  readonly elapsedMs: number
  readonly level: number
  readonly framesSent: number
  readonly framesAcked: number
  readonly bytesSent: number
  /** `live.input.accepted` events received. */
  readonly accepted: number
  /** Accepted events received while capture was still running. */
  readonly acceptedWhileCapturing: number
  /** Client `performance.now()` marks. */
  readonly captureStartedAt: number | undefined
  readonly firstAcceptedAt: number | undefined
  readonly inputEndedAt: number | undefined
  readonly responses: readonly LiveResponse[]
  /** All live text joined in arrival order (display). */
  readonly transcript: string
  readonly turns: readonly LiveTextTurn[]
  /** Text chunks accepted by `live/text` (text-input sessions). */
  readonly textChunks: number
  readonly textDone: boolean
  readonly speech: string | undefined
  readonly error: { readonly code: string; readonly message: string } | undefined
  /** The host reported a backend reconnect (`503 RECONNECTING`); queued frames and controls are held. */
  readonly reconnecting: boolean
  /** Transparent backend resumes reported by `live.state ready, resumed: true`. */
  readonly resumes: number
  /** Non-fatal backend notices (`live.error` with `fatal: false`). */
  readonly notice: string | undefined
  /** Frames captured but not yet accepted by the host (bounded; audio spoken while connecting is kept). */
  readonly queued: number
  readonly maxQueued: number
  readonly frameMs: number
  /** Conversation logging of the closed exchange through `input.receiptId`. */
  readonly log: 'none' | 'logging' | 'logged' | 'failed' | 'unavailable'
  /** `no-input`, `no-reply` (the host staged no receipt because nothing answered), `text-input`, or a staging error. */
  readonly logDetail: string | undefined
  /** Latest Interrupt / Cancel reply and its host outcome (TASK_CONTRACT §K.10). */
  readonly control: LiveControlState | undefined
  /** Capability observations of THIS connection (`live.capability`, §K.9), newest per key. */
  readonly observed: Readonly<Record<string, LiveObservation>>
  /** Appends the backend rejected after the host forwarded them (`live.input.rejected`). */
  readonly inputRejected: number
  /** Host input integrity from `live/close` (host 0.4.5). */
  readonly integrity: { readonly framesForwarded: number; readonly serverRejectedAppends: number } | undefined
  /** Word timestamps per sentence of streamed text-to-speech (`live.words`, §K.2). */
  readonly words: readonly LiveWords[]
  /** Result of the last per-utterance parameter change (`live/text {params}`). */
  readonly textParams: { readonly state: 'applied' | 'rejected'; readonly code?: string; readonly message?: string; readonly params: Readonly<Record<string, unknown>> } | undefined
  /** Whether an utterance of a streamed text-to-speech session is open (text sent, `done` not yet sent). */
  readonly utteranceOpen: boolean
}

/** Staged live input returned by `live/close` (CONTRACT §5, adapter 0.3.0). */
export interface LiveInputRecording {
  /** Audio input recording id; absent for a streamed text-to-speech text receipt (host ≥ 0.4.3 `kind: text`). */
  readonly recordingId?: string
  readonly kind?: 'audio' | 'text'
  /** Staged file name, when the host names it (`live-text-<id>.txt`). */
  readonly name?: string
  readonly bytes: number
  readonly sha256: string
  readonly receiptId?: string | null
  readonly attachmentId?: string | null
  readonly stagingError?: string
}

/**
 * Display name of a staged live input: the host's own name, else one derived from the recording (audio) or the text sha.
 * @param input - close result input.
 * @returns file name.
 */
export function liveInputName(input: LiveInputRecording): string {
  if (typeof input.name === 'string' && input.name !== '') return input.name
  if (input.kind === 'text') return `live-text-${input.sha256.slice(0, 12)}.txt`
  return `live-input-${(input.recordingId ?? input.sha256).slice(-12)}.wav`
}

/** Host outcome vocabulary of Interrupt / Cancel reply (TASK_CONTRACT §K.10). */
export type ControlOutcome = 'pending' | 'no-active-response' | 'response-not-active' | 'cancelled' | 'response-already-completed' | 'stale' | 'unconfirmed' | 'error' | 'no-outcome'

/** One Interrupt / Cancel reply as the UI tracks it. */
export interface LiveControlState {
  readonly type: 'cancel-response' | 'barge-in'
  readonly controlId: string | undefined
  readonly sent: boolean | undefined
  readonly targetResponseId: string | undefined
  readonly outcome: ControlOutcome
  readonly reason?: string
  /** `cancelled` AND `live.response {status: cancelled}` for the same response of this liveId arrived. */
  readonly confirmed: boolean
}

/** One per-connection capability observation (`live.capability`). */
export interface LiveObservation {
  readonly key: string
  readonly state: CapabilityState
  readonly detail?: string
  readonly responseId?: string
  readonly implementationLevel?: string
  readonly at?: string
}

/** Word timestamps of one streamed sentence (`live.words`). */
export interface LiveWords {
  readonly responseId: string
  readonly sentenceIndex: number | null
  readonly state: 'aligned' | 'silence' | 'failed'
  readonly words: readonly { readonly word: string; readonly startMs: number; readonly endMs: number }[]
}

const OUTCOMES: ReadonlySet<string> = new Set(['no-active-response', 'response-not-active', 'cancelled', 'response-already-completed', 'stale', 'unconfirmed'])

/** Why the host did (not) stage a receipt for the closed exchange (host 0.4.2 `receipt`). */
export interface LiveReceipt {
  readonly state: 'staged' | 'skipped' | 'failed' | 'unavailable'
  readonly reason?: string
  readonly detail?: string
  readonly receiptId?: string
}

interface CloseResult {
  readonly input?: LiveInputRecording | null
  readonly receipt?: LiveReceipt
  readonly inputIntegrity?: { readonly framesForwarded?: number; readonly serverRejectedAppends?: number }
}

/**
 * Admit the staged live input as a normal file prompt so the exchange is logged.
 * @returns `logged`, or a failure detail.
 */
export type LogLiveExchange = (sessionId: SessionId, input: LiveInputRecording) => Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>

const IDLE: LiveSnapshot = {
  phase: 'idle', liveId: undefined, waitingMic: false, turn: undefined, requestedTurnMode: undefined, evidence: 'unsupported', kind: 'conversation', task: undefined, wire: undefined, server: undefined, model: undefined, elapsedMs: 0, level: 0,
  framesSent: 0, framesAcked: 0, bytesSent: 0, accepted: 0, acceptedWhileCapturing: 0,
  captureStartedAt: undefined, firstAcceptedAt: undefined, inputEndedAt: undefined,
  responses: [], transcript: '', turns: [], textChunks: 0, textDone: false, speech: undefined, error: undefined, reconnecting: false, resumes: 0, notice: undefined,
  queued: 0, maxQueued: 75, frameMs: 200, log: 'none', logDetail: undefined,
  control: undefined, observed: {}, inputRejected: 0, integrity: undefined, words: [], textParams: undefined, utteranceOpen: false,
}

/** Frames that may wait for transmission before the client gives up (15 s at 200 ms, ≈ 480 KB). */
const MAX_QUEUED_FRAMES = 75
/** Retries of one frame answered `429 BUFFER_FULL` (100 ms apart). */
const MAX_BUSY_RETRIES = 30
/** How long one request may keep receiving `503 RECONNECTING` before the session is reported failed. */
const RECONNECT_WAIT_MS = 15_000
/** Delay between retries of a request answered `503 RECONNECTING`. */
const RECONNECT_RETRY_MS = 250

interface OpenResult {
  readonly ok: true
  readonly liveId: string
  /** Adapter task id (TASK_CONTRACT 0.2 §H). */
  readonly task?: string
  readonly wire?: string
  readonly capabilities?: unknown
  /** Host ≥ 0.4.12 turn settings actually sent. */
  readonly turn?: unknown
  /** Audio input the UI must send (always PCM16; `wireEncoding` is the host's concern), or `encoding: "text"` for `live/text`. */
  readonly input: { readonly encoding: string; readonly sampleRate?: number; readonly channels?: number; readonly frameMs?: number; readonly maxFrameBytes?: number; readonly wireEncoding?: string; readonly route?: string }
}

/**
 * Convert Float32 samples to PCM s16le bytes.
 * @param samples - mono samples.
 * @returns little-endian bytes.
 */
export function toPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return bytes
}

async function routeError(response: Response): Promise<AudioRouteError> {
  const text = await response.text().catch(() => '')
  let code = `HTTP_${response.status}`
  let message = text.slice(0, 200)
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    code = parsed.error?.code ?? code
    message = parsed.error?.message ?? message
  } catch {
    // Non-JSON error body: keep the HTTP status code.
  }
  return new AudioRouteError(response.status, code, message)
}

/** One live session at a time per page. */
export class LiveController {
  private snapshot: LiveSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private sessionId: SessionId | undefined
  private capture: CaptureSession | undefined
  private frame: Float32Array = new Float32Array(0)
  private frameFill = 0
  private readonly queue: Uint8Array[] = []
  private seq = 0
  private sending: Promise<void> | undefined
  /**
   * Identity of the newest start. Dismiss, close, dispose, a failure or a host `closed` / `error` event invalidates it, so a
   * start still awaiting the microphone or the host never brings an ended session back to `live` (pre16 finding 12:29:
   * a late microphone permission revived a dismissed session without a liveId → CLIENT_BACKLOG, 0 frames sent).
   */
  private startToken = 0
  private abort: AbortController | undefined
  private meter: ReturnType<typeof setInterval> | undefined
  private capturedSamples = 0
  /** Responses of this connection the host reported cancelled (`live.response status: cancelled`). */
  private readonly cancelledResponses = new Set<string>()
  /** Newest player position waiting to be acknowledged; a newer position replaces it (one request in flight at a time). */
  private ackPending: { readonly liveId: string; readonly responseId: string; readonly playedMs: number } | undefined
  private ackDrain: Promise<void> | undefined
  /** Highest acknowledged position per `liveId responseId`; the response acknowledged last; responses superseded by a later one. */
  private readonly ackedMs = new Map<string, number>()
  private ackedResponse: string | undefined
  private readonly retiredResponses = new Set<string>()
  private lastTextParams: Readonly<Record<string, unknown>> | undefined
  private sampleRate = 16000

  /**
   * @param backend - microphone capture backend.
   * @param fetchImpl - page fetch.
   * @param micBusy - whether the record-and-send controller currently holds the microphone.
   * @param logExchange - admits the closed exchange's staged input to the Session.
   * @param now - client monotonic clock (ms).
   */
  constructor(
    private readonly backend: CaptureBackend,
    private readonly fetchImpl: FetchLike,
    private readonly micBusy: () => boolean,
    private readonly logExchange: LogLiveExchange,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Observable for the live panel. */
  readonly source = {
    getSnapshot: (): LiveSnapshot => this.snapshot,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** Whether capture or a live session is active. */
  get active(): boolean {
    return this.snapshot.phase === 'opening' || this.snapshot.phase === 'live' || this.snapshot.phase === 'awaiting' || this.snapshot.phase === 'closing'
  }

  /** Session that owns the live exchange, if any. */
  get owner(): SessionId | undefined {
    return this.active ? this.sessionId : undefined
  }

  /**
   * Open a live session and start transmitting capture frames. User action only.
   * @param sessionId - owning Session.
   * @param model - selected provider/model.
   * @param evidence - capability evidence layer shown with the control.
   * @param bargeIn - explicitly request `overlapPolicy: barge_in_on_speech`; otherwise the host default applies
   *   (nightly server VAD rejects `listen_only`, so the UI never sends it).
   * @param kind - panel kind from the live model's task view.
   * @param busy - reports unfinished work on the same server; a reason refuses the open instead of letting it time out.
   */
  async start(sessionId: SessionId, model: ModelChoice, evidence: CapabilityState, bargeIn: boolean, kind: LiveKind = 'conversation', busy?: () => Promise<string | undefined>, turnMode?: { readonly mode: string; readonly send: Readonly<Record<string, string>> }, preflight?: () => Promise<{ readonly code: string; readonly message: string } | undefined>): Promise<void> {
    if (this.active) return
    if (this.micBusy()) {
      this.set({ ...IDLE, phase: 'error', error: { code: 'MIC_BUSY', message: '' } })
      return
    }
    const token = ++this.startToken
    const stale = (): boolean => token !== this.startToken
    this.sessionId = sessionId
    this.seq = 0
    this.queue.length = 0
    this.capturedSamples = 0
    this.abort = new AbortController()
    this.cancelledResponses.clear()
    this.ackPending = undefined
    this.ackedMs.clear()
    this.ackedResponse = undefined
    this.retiredResponses.clear()
    this.lastTextParams = undefined
    this.set({ ...IDLE, phase: 'opening', evidence, kind, model, maxQueued: MAX_QUEUED_FRAMES, requestedTurnMode: turnMode?.mode })
    const busyReason = await busy?.()
    if (stale()) return
    if (busyReason !== undefined) {
      this.set({ ...this.snapshot, phase: 'error', error: { code: 'SERVER_BUSY', message: busyReason } })
      return
    }
    if (this.snapshot.phase !== 'opening') return
    // Session params for this model (e.g. clearing a stored turnDetection): a host refusal such as INVALID_PARAM_COMBINATION
    // is shown in this panel verbatim, before any microphone prompt or live/open.
    const refused = await preflight?.()
    if (stale() || this.snapshot.phase !== 'opening') return
    if (refused !== undefined) {
      this.set({ ...this.snapshot, phase: 'error', error: { code: refused.code, message: refused.message } })
      return
    }
    // Microphone permission first: the host starts its idle timeout at live/open, and a permission prompt answered later
    // than that would find the session already closed.
    if (kind !== 'text-input' && this.backend.prepare !== undefined) {
      this.set({ ...this.snapshot, waitingMic: true })
      try {
        await this.backend.prepare()
      } catch (error) {
        if (!stale()) this.fail(error)
        return
      }
      if (stale() || this.snapshot.phase !== 'opening') return
      this.set({ ...this.snapshot, waitingMic: false })
    }
    let opened: OpenResult
    try {
      opened = await requestJson<OpenResult>(this.fetchImpl, `${ROUTE_PREFIX}/live/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A turn mode choice posts exactly its `send` (native: nothing; server VAD: turnDetection) and never overlapPolicy.
        body: JSON.stringify({ sessionId, provider: model.provider, model: model.model, ...(turnMode !== undefined ? turnMode.send : bargeIn ? { overlapPolicy: 'barge_in_on_speech' } : {}) }),
        signal: this.abort.signal,
      })
    } catch (error) {
      if (!stale()) this.fail(error)
      return
    }
    if (stale() || this.snapshot.phase !== 'opening') {
      await this.post('close', opened.liveId, undefined).catch(() => undefined)
      return
    }
    const openedKind = liveKindOf(opened.task) ?? (opened.input.encoding === 'text' ? 'text-input' : this.snapshot.kind === 'text-input' ? 'conversation' : this.snapshot.kind)
    this.set({ ...this.snapshot, liveId: opened.liveId, kind: openedKind, task: opened.task, wire: opened.wire, server: serverFacts(opened.capabilities) ?? this.snapshot.server, turn: turnSummaryOf(opened.turn) ?? this.snapshot.turn })
    if (openedKind === 'text-input') {
      if (opened.input.encoding !== 'text') {
        await this.post('close', opened.liveId, undefined).catch(() => undefined)
        this.fail(new AudioRouteError(0, 'UNSUPPORTED_INPUT', `text session opened with input encoding ${opened.input.encoding}`))
        return
      }
      this.set({ ...this.snapshot, phase: 'live', captureStartedAt: this.now() })
      return
    }
    const sampleRate = opened.input.sampleRate
    if (!PCM16_ENCODINGS.has(opened.input.encoding) || sampleRate === undefined || opened.input.frameMs === undefined) {
      await this.post('close', opened.liveId, undefined).catch(() => undefined)
      this.fail(new AudioRouteError(0, 'UNSUPPORTED_INPUT', `live input ${opened.input.encoding} ${sampleRate ?? '?'} Hz is not PCM16`))
      return
    }
    this.sampleRate = sampleRate
    this.set({ ...this.snapshot, frameMs: opened.input.frameMs })
    const frameSamples = Math.max(1, Math.round(sampleRate * opened.input.frameMs / 1000))
    this.frame = new Float32Array(Math.min(frameSamples, Math.floor((opened.input.maxFrameBytes ?? frameSamples * 2) / 2)))
    this.frameFill = 0
    let capture: CaptureSession
    try {
      capture = await this.backend.open({
        deviceId: '',
        sampleRate,
        onFrames: chunk => this.onFrames(chunk),
        onEnded: () => { void this.endInput() },
      })
    } catch (error) {
      await this.post('close', opened.liveId, undefined).catch(() => undefined)
      if (!stale()) this.fail(error)
      return
    }
    if (stale() || this.snapshot.phase !== 'opening' || this.snapshot.liveId !== opened.liveId) {
      // The session ended (host idle close, dismissed, closed) while the microphone was opening: release the microphone
      // and the host session instead of reviving the panel.
      await capture.close()
      await this.post('close', opened.liveId, undefined).catch(() => undefined)
      return
    }
    this.capture = capture
    if (capture.sampleRate !== sampleRate) {
      await capture.close()
      this.capture = undefined
      await this.post('close', opened.liveId, undefined).catch(() => undefined)
      this.fail(new AudioRouteError(0, 'RATE_MISMATCH', `capture context did not run at ${sampleRate} Hz`))
      return
    }
    const startedAt = this.now()
    this.meter = setInterval(() => {
      this.set({ ...this.snapshot, elapsedMs: Math.round(this.capturedSamples * 1000 / this.sampleRate) })
    }, 200)
    this.set({ ...this.snapshot, phase: 'live', captureStartedAt: startedAt })
  }

  /**
   * Send text to a streamed text-to-speech session (`live/text`, tts.stream-input only).
   * @param text - text chunk ('' with `done` only ends input).
   * @param done - marks the end of the text input.
   * @returns whether the host accepted it.
   */
  async sendText(text: string, done = false, params?: Readonly<Record<string, unknown>>, endSession = done): Promise<boolean> {
    const liveId = this.snapshot.liveId
    if (liveId === undefined || this.snapshot.phase !== 'live' || this.snapshot.kind !== 'text-input') return false
    if (text === '' && !done) return false
    // Per-utterance params go only before the first text of an utterance (§K.2); the host keeps them for later utterances.
    const withParams = params !== undefined && Object.keys(params).length > 0 && !this.snapshot.utteranceOpen && JSON.stringify(params) !== JSON.stringify(this.lastTextParams)
    try {
      const result = await this.post('text', liveId, { ...(text === '' ? {} : { text }), ...(done ? { done: true } : {}), ...(withParams ? { params } : {}) }) as { chunks?: number } | undefined
      if (withParams) this.lastTextParams = params
      this.set({
        ...this.snapshot,
        textChunks: typeof result?.chunks === 'number' ? result.chunks : this.snapshot.textChunks + (text === '' ? 0 : 1),
        utteranceOpen: !done && (this.snapshot.utteranceOpen || text !== ''),
        ...(withParams ? { textParams: { state: 'applied' as const, params: params! } } : {}),
        ...(done && endSession ? { textDone: true, phase: 'awaiting' as const, inputEndedAt: this.now() } : {}),
      })
      return true
    } catch (error) {
      // A refused parameter change or an utterance still open is a notice, not the end of the session.
      if (error instanceof AudioRouteError && ['UTTERANCE_IN_PROGRESS', 'INVALID_PARAM', 'UNKNOWN_PARAM', 'BAD_REQUEST'].includes(error.code)) {
        this.set({ ...this.snapshot, textParams: { state: 'rejected', code: error.code, message: error.message, params: params ?? {} } })
        return false
      }
      this.fail(error)
      return false
    }
  }

  /** Stop capture, send the remaining frame and the input-end marker; the session stays open for responses. */
  async endInput(): Promise<void> {
    if (this.snapshot.phase !== 'live') return
    if (this.snapshot.kind === 'text-input') {
      if (this.snapshot.utteranceOpen) await this.sendText('', true)
      else this.set({ ...this.snapshot, textDone: true, phase: 'awaiting', inputEndedAt: this.now() })
      return
    }
    const liveId = this.snapshot.liveId!
    clearInterval(this.meter)
    await this.capture?.close()
    this.capture = undefined
    if (this.frameFill > 0) this.enqueue(this.frame.slice(0, this.frameFill))
    this.frameFill = 0
    this.set({ ...this.snapshot, phase: 'awaiting', inputEndedAt: this.now(), level: 0, elapsedMs: Math.round(this.capturedSamples * 1000 / this.sampleRate) })
    await this.sending
    if ((this.snapshot.phase as LivePhase) !== 'awaiting') return
    await this.post('control', liveId, { type: 'commit' }).catch(error => { this.fail(error) })
  }

  /**
   * Interrupt (`barge-in`) or cancel the active reply, and track the host's ACK / outcome (§K.10). The panel only calls a
   * reply interrupted after `outcome: cancelled` and the matching `live.response cancelled` of this connection.
   * @param type - `cancel-response` or `barge-in`.
   */
  async control(type: 'cancel-response' | 'barge-in'): Promise<void> {
    const liveId = this.snapshot.liveId
    if (liveId === undefined || !this.active) return
    const active = [...this.snapshot.responses].reverse().find(r => r.status === 'created')
    this.set({ ...this.snapshot, control: { type, controlId: undefined, sent: undefined, targetResponseId: active?.responseId, outcome: 'pending', confirmed: false } })
    let reply: { controlId?: unknown; sent?: unknown; targetResponseId?: unknown; outcome?: unknown; reason?: unknown } | undefined
    try {
      reply = await this.post('control', liveId, { type, ...(active === undefined ? {} : { responseId: active.responseId }) }) as typeof reply
    } catch (error) {
      if (error instanceof AudioRouteError && (error.code === 'LIVE_CLOSED' || error.status === 410)) {
        this.fail(error)
        return
      }
      this.set({ ...this.snapshot, control: { ...this.snapshot.control!, outcome: 'error', reason: error instanceof Error ? error.message : String(error) } })
      return
    }
    const current = this.snapshot.control
    if (current === undefined || current.type !== type) return
    const outcome = typeof reply?.outcome === 'string' ? reply.outcome : undefined
    const controlId = typeof reply?.controlId === 'string' ? reply.controlId : undefined
    // Hosts before 0.4.5 answer `{ ok: true }` without an outcome.
    const replied: ControlOutcome = outcome === undefined ? 'no-outcome' : outcome === 'sent' || outcome === 'pending' ? 'pending' : OUTCOMES.has(outcome) ? outcome as ControlOutcome : 'unconfirmed'
    // The host may publish this control's `live.control.result` before its HTTP reply (a backend that cancels at once);
    // the reply's `pending` must not undo that result.
    const resolvedByFeed = replied === 'pending' && current.outcome !== 'pending' && controlId !== undefined && current.controlId === controlId
    this.applyControl({
      controlId,
      sent: typeof reply?.sent === 'boolean' ? reply.sent : undefined,
      targetResponseId: typeof reply?.targetResponseId === 'string' ? reply.targetResponseId : current.targetResponseId,
      ...(resolvedByFeed ? {} : { outcome: replied }),
      ...(typeof reply?.reason === 'string' ? { reason: reply.reason } : {}),
    })
  }

  private applyControl(patch: Partial<LiveControlState>): void {
    const current = this.snapshot.control
    if (current === undefined) return
    const next = { ...current, ...patch }
    const confirmed = next.outcome === 'cancelled' && next.targetResponseId !== undefined && this.cancelledResponses.has(next.targetResponseId)
    this.set({ ...this.snapshot, control: { ...next, confirmed } })
  }

  /**
   * Report the real player position of a live response (never estimated from received bytes).
   * @param responseId - live response id (the playback stream id).
   * @param playedMs - played milliseconds from the output clock.
   */
  playbackAck(responseId: string, playedMs: number): Promise<void> {
    const liveId = this.snapshot.liveId
    if (liveId === undefined || !this.acksOpen(liveId)) return Promise.resolve()
    // Coalesce: only the newest position is kept; the drain sends one acknowledgement at a time, so a backend resume
    // (503 RECONNECTING) can never deliver older positions after newer ones.
    this.ackPending = { liveId, responseId, playedMs }
    this.ackDrain ??= this.drainAcks()
    return this.ackDrain
  }

  /** Acknowledgements are sent only while this live session is open (not while closing, closed or replaced). */
  private acksOpen(liveId: string): boolean {
    return this.snapshot.liveId === liveId && (this.snapshot.phase === 'live' || this.snapshot.phase === 'awaiting')
  }

  private async drainAcks(): Promise<void> {
    // Yield first, so `ackDrain` is assigned before the loop can finish and clear it.
    await Promise.resolve()
    try {
      for (let ack = this.nextAck(); ack !== undefined; ack = this.nextAck()) {
        const { liveId, responseId, playedMs } = ack
        const key = `${liveId} ${responseId}`
        const response = await this.sendWithRetry(() => this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/live/control?liveId=${encodeURIComponent(liveId)}`), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'playback-ack', responseId, playedMs }),
        }), false, () => !this.acksOpen(liveId) || this.ackPending !== undefined)
        if (!(response instanceof Response)) continue
        await response.body?.cancel().catch(() => undefined)
        this.ackedMs.set(key, Math.max(playedMs, this.ackedMs.get(key) ?? 0))
        if (this.ackedResponse !== undefined && this.ackedResponse !== key) this.retiredResponses.add(this.ackedResponse)
        this.ackedResponse = key
      }
    } finally {
      this.ackDrain = undefined
    }
    // A position queued while the loop was finishing starts a new drain (it keeps its own liveId fence).
    if (this.ackPending !== undefined) this.ackDrain ??= this.drainAcks()
  }

  /** Take the queued position unless it is stale: closed or older session, superseded response, or not newer. */
  private nextAck(): { readonly liveId: string; readonly responseId: string; readonly playedMs: number } | undefined {
    const ack = this.ackPending
    this.ackPending = undefined
    if (ack === undefined || !this.acksOpen(ack.liveId)) return undefined
    const key = `${ack.liveId} ${ack.responseId}`
    if (this.retiredResponses.has(key)) return undefined
    const acked = this.ackedMs.get(key)
    if (acked !== undefined && ack.playedMs <= acked) return undefined
    return ack
  }

  /** Close the live session (ends capture first when still live). */
  async close(): Promise<void> {
    const liveId = this.snapshot.liveId
    if (this.snapshot.phase === 'opening') {
      this.startToken++
      this.abort?.abort()
      // A host session already opened for this start (the microphone was still opening) is closed too.
      if (liveId !== undefined) void this.post('close', liveId, undefined).catch(() => undefined)
      this.set({ ...this.snapshot, phase: 'closed', waitingMic: false })
      return
    }
    if (this.snapshot.phase === 'live') await this.endInput()
    if (liveId === undefined || (this.snapshot.phase !== 'awaiting' && this.snapshot.phase !== 'error')) return
    this.set({ ...this.snapshot, phase: 'closing' })
    let result: CloseResult | undefined
    try {
      result = await this.post('close', liveId, undefined) as CloseResult
    } catch (error) {
      if (!(error instanceof AudioRouteError && (error.code === 'LIVE_CLOSED' || error.code === 'LIVE_NOT_FOUND'))) {
        this.fail(error)
        return
      }
    }
    this.recordIntegrity(result)
    await this.logResult(result?.input ?? undefined, result?.receipt)
  }

  private recordIntegrity(result: CloseResult | undefined): void {
    const integrity = result?.inputIntegrity
    if (integrity === undefined || typeof integrity.framesForwarded !== 'number') return
    this.set({ ...this.snapshot, integrity: { framesForwarded: integrity.framesForwarded, serverRejectedAppends: typeof integrity.serverRejectedAppends === 'number' ? integrity.serverRejectedAppends : 0 } })
  }

  private async collectClosedResult(liveId: string): Promise<void> {
    let result: CloseResult | undefined
    try {
      result = await this.post('close', liveId, undefined) as CloseResult
    } catch {
      // The host no longer knows the session: nothing to log.
      return
    }
    await this.logResult(result?.input ?? undefined, result?.receipt)
  }

  private async logResult(input: LiveInputRecording | undefined, receipt?: LiveReceipt): Promise<void> {
    const sessionId = this.sessionId
    if (input === undefined || sessionId === undefined || typeof input.receiptId !== 'string') {
      // Host 0.4.2 states why no receipt was staged; older hosts leave the UI to infer it.
      const detail = this.snapshot.kind === 'text-input' ? 'text-input'
        : receipt?.reason === 'no-response' ? 'no-reply'
          : receipt?.reason === 'no-input' ? 'no-input'
            : receipt?.reason !== undefined ? [receipt.reason, receipt.detail].filter(Boolean).join(': ')
              : input === undefined ? 'no-input'
                : typeof input.stagingError === 'string' && input.stagingError !== '' ? input.stagingError : 'no-reply'
      this.set({ ...this.snapshot, phase: this.snapshot.phase === 'closing' ? 'closed' : this.snapshot.phase, log: 'unavailable', logDetail: detail })
      return
    }
    this.set({ ...this.snapshot, phase: this.snapshot.phase === 'closing' ? 'closed' : this.snapshot.phase, log: 'logging' })
    const logged = await this.logExchange(sessionId, input).catch((error: unknown) => ({ ok: false as const, detail: String(error) }))
    this.set({ ...this.snapshot, log: logged.ok ? 'logged' : 'failed', logDetail: logged.ok ? undefined : logged.detail })
  }

  /** Return a closed or failed panel to idle. */
  dismiss(): void {
    if (this.active) return
    this.startToken++
    this.set(IDLE)
  }

  /**
   * Apply a feed event (`live.*`, and `text.delta` for this session's responses).
   * @param event - decoded feed event.
   */
  handleEvent(event: Record<string, unknown> & { type: string }): void {
    const liveId = this.snapshot.liveId
    if (liveId === undefined) return
    if (event.type.startsWith('live.') && event.liveId !== liveId) return
    switch (event.type) {
      case 'live.input.accepted': {
        const at = this.now()
        this.set({
          ...this.snapshot,
          accepted: this.snapshot.accepted + 1,
          acceptedWhileCapturing: this.snapshot.acceptedWhileCapturing + (this.snapshot.phase === 'live' ? 1 : 0),
          firstAcceptedAt: this.snapshot.firstAcceptedAt ?? at,
        })
        return
      }
      case 'live.error':
        if (event.fatal === true) return
        this.set({ ...this.snapshot, notice: `${String(event.code ?? '')} ${String(event.message ?? '')}`.trim() })
        return
      case 'live.speech':
        this.set({ ...this.snapshot, speech: String(event.event ?? '') })
        return
      case 'live.control.result': {
        const control = this.snapshot.control
        if (control === undefined) return
        const controlId = typeof event.controlId === 'string' ? event.controlId : undefined
        // Results of other controls on this connection (playback-ack, commit, an earlier Interrupt) never touch this one,
        // including while its own reply is still in flight (no controlId yet).
        if (typeof event.control === 'string' && event.control !== control.type) return
        if (control.controlId !== undefined && controlId !== undefined && controlId !== control.controlId) return
        if (control.targetResponseId !== undefined && typeof event.targetResponseId === 'string' && event.targetResponseId !== control.targetResponseId) return
        const outcome = typeof event.outcome === 'string' ? event.outcome : 'unconfirmed'
        if (outcome === 'sent') return
        this.applyControl({
          ...(controlId === undefined ? {} : { controlId }),
          ...(typeof event.sent === 'boolean' ? { sent: event.sent } : {}),
          ...(typeof event.targetResponseId === 'string' ? { targetResponseId: event.targetResponseId } : {}),
          outcome: OUTCOMES.has(outcome) ? outcome as ControlOutcome : 'unconfirmed',
          ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
        })
        return
      }
      case 'live.capability': {
        if (typeof event.key !== 'string' || typeof event.state !== 'string') return
        const observation: LiveObservation = {
          key: event.key,
          state: event.state as CapabilityState,
          ...(typeof event.detail === 'string' ? { detail: event.detail } : {}),
          ...(typeof event.responseId === 'string' ? { responseId: event.responseId } : {}),
          ...(typeof event.implementationLevel === 'string' ? { implementationLevel: event.implementationLevel } : {}),
          ...(typeof event.at === 'string' ? { at: event.at } : {}),
        }
        this.set({ ...this.snapshot, observed: { ...this.snapshot.observed, [event.key]: observation } })
        return
      }
      case 'live.input.rejected':
        this.set({ ...this.snapshot, inputRejected: this.snapshot.inputRejected + 1, notice: `${String(event.code ?? 'rejected')} ${String(event.message ?? '')}`.trim() })
        return
      case 'live.words': {
        const state = event.state === 'aligned' || event.state === 'silence' ? event.state : 'failed'
        const words = Array.isArray(event.words)
          ? event.words.flatMap((w) => {
              const item = w as { word?: unknown; startMs?: unknown; endMs?: unknown }
              const startMs = Number(item.startMs)
              const endMs = Number(item.endMs)
              return typeof item.word === 'string' && Number.isFinite(startMs) && Number.isFinite(endMs) ? [{ word: item.word, startMs, endMs }] : []
            })
          : []
        this.set({ ...this.snapshot, words: [...this.snapshot.words, { responseId: String(event.responseId ?? ''), sentenceIndex: typeof event.sentenceIndex === 'number' ? event.sentenceIndex : null, state, words }] })
        return
      }
      case 'live.response': {
        const responseId = String(event.responseId ?? '')
        const next: LiveResponse = { responseId, status: event.status as LiveResponse['status'], ...(typeof event.reason === 'string' ? { reason: event.reason } : {}) }
        const responses = this.snapshot.responses.some(r => r.responseId === responseId)
          ? this.snapshot.responses.map(r => (r.responseId === responseId ? next : r))
          : [...this.snapshot.responses, next]
        if (next.status === 'cancelled') this.cancelledResponses.add(responseId)
        this.set({ ...this.snapshot, responses })
        const control = this.snapshot.control
        if (control !== undefined && next.status === 'cancelled' && control.targetResponseId === responseId) this.applyControl({})
        return
      }
      case 'text.delta': {
        const responseId = typeof event.responseId === 'string' ? event.responseId : String(event.streamId ?? '')
        // Live deltas carry the liveId (host 0.4.0); older hosts only name a known response.
        if (event.liveId !== liveId && !this.snapshot.responses.some(r => r.responseId === responseId)) return
        const kind = event.kind === 'transcript' || (event.kind === undefined && this.snapshot.kind === 'transcription') ? 'transcript' : 'response'
        this.applyText(responseId, kind, String(event.text ?? ''), false)
        return
      }
      case 'live.transcript.done': {
        const turnId = String(event.responseId ?? event.turnId ?? '')
        const existing = this.snapshot.turns.find(t => t.id === turnId)
        this.applyText(turnId, existing?.kind ?? (this.snapshot.kind === 'transcription' ? 'transcript' : 'response'), typeof event.text === 'string' ? event.text : existing?.text ?? '', true)
        return
      }
      case 'live.state': {
        const state = event.state
        if (state === 'reconnecting') {
          if (this.active) this.set({ ...this.snapshot, reconnecting: true })
          return
        }
        if (state === 'ready' && event.resumed !== true) {
          const facts = serverFacts(event.capabilities)
          const turn = turnSummaryOf(event.turn)
          if (facts !== undefined || turn !== undefined) this.set({ ...this.snapshot, server: facts ?? this.snapshot.server, turn: turn ?? this.snapshot.turn })
          return
        }
        if (state === 'ready' && event.resumed === true) {
          const attempts = typeof event.attempts === 'number' ? event.attempts : undefined
          this.set({ ...this.snapshot, reconnecting: false, resumes: this.snapshot.resumes + 1, notice: `resumed${attempts === undefined ? '' : ` (${attempts})`}` })
          return
        }
        if (state === 'closed' || state === 'error') {
          this.startToken++
          clearInterval(this.meter)
          void this.capture?.close()
          this.capture = undefined
          this.queue.length = 0
          const error = typeof event.error === 'object' && event.error !== null ? event.error as { code?: unknown; message?: unknown } : undefined
          const wasActive = this.active && this.snapshot.phase !== 'closing'
          this.set({
            ...this.snapshot,
            phase: state === 'error' ? 'error' : 'closed',
            level: 0,
            reconnecting: false,
            error: error === undefined ? this.snapshot.error : { code: String(error.code ?? 'LIVE_CLOSED'), message: String(error.message ?? '') },
          })
          // The host closed the session (idle timeout, lost backend): fetch its idempotent close result so a
          // completed exchange is still logged in the conversation.
          if (wasActive && state === 'closed') void this.collectClosedResult(liveId)
        }
        return
      }
      default:
        return
    }
  }

  private applyText(id: string, kind: LiveTextTurn['kind'], text: string, final: boolean): void {
    const index = this.snapshot.turns.findIndex(t => t.id === id)
    const turns = index === -1
      ? [...this.snapshot.turns, { id, kind, text, final }]
      : this.snapshot.turns.map((t, i) => (i === index ? { ...t, text: final ? text : joinText(t.text, text), final: t.final || final } : t))
    this.set({ ...this.snapshot, turns, transcript: turns.map(t => t.text).join(turns.every(t => t.kind === 'transcript') ? ' ' : '\n').trim() })
  }

  /** Release capture and close the session on unload. */
  async dispose(): Promise<void> {
    this.startToken++
    const liveId = this.snapshot.liveId
    const wasActive = this.active
    clearInterval(this.meter)
    this.abort?.abort()
    await this.capture?.close()
    this.capture = undefined
    this.queue.length = 0
    if (wasActive && liveId !== undefined) await this.post('close', liveId, undefined).catch(() => undefined)
    this.set(IDLE)
  }

  private onFrames(chunk: Float32Array): void {
    if (this.snapshot.phase !== 'live') return
    let power = 0
    for (let i = 0; i < chunk.length; i++) power += chunk[i]! * chunk[i]!
    const level = Math.min(1, Math.sqrt(power / Math.max(1, chunk.length)) * 4)
    this.capturedSamples += chunk.length
    let offset = 0
    while (offset < chunk.length) {
      const take = Math.min(this.frame.length - this.frameFill, chunk.length - offset)
      this.frame.set(chunk.subarray(offset, offset + take), this.frameFill)
      this.frameFill += take
      offset += take
      if (this.frameFill === this.frame.length) {
        this.enqueue(this.frame.slice())
        this.frameFill = 0
      }
    }
    if (Math.abs(level - this.snapshot.level) > 0.05) this.set({ ...this.snapshot, level })
  }

  private enqueue(samples: Float32Array): void {
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
      this.fail(new AudioRouteError(0, 'CLIENT_BACKLOG', `more than ${MAX_QUEUED_FRAMES} frames waiting for the host`))
      return
    }
    this.queue.push(toPcm16(samples))
    this.set({ ...this.snapshot, queued: this.queue.length })
    if (this.sending === undefined) this.sending = this.pump().finally(() => { this.sending = undefined })
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0) {
      const liveId = this.snapshot.liveId
      if (liveId === undefined || !this.active) return
      const body = this.queue[0]!
      const seq = this.seq
      const response = await this.sendWithRetry(() => this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/live/append?liveId=${encodeURIComponent(liveId)}&seq=${seq}`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as Uint8Array<ArrayBuffer>,
        ...(this.abort === undefined ? {} : { signal: this.abort.signal }),
      }), true)
      if (response instanceof AudioRouteError || response instanceof Error) {
        this.fail(response)
        return
      }
      await response.body?.cancel()
      // Only a 2xx answer moves the frame from queued to sent.
      this.queue.shift()
      this.seq = seq + 1
      this.set({
        ...this.snapshot,
        queued: this.queue.length,
        framesSent: this.snapshot.framesSent + 1,
        framesAcked: this.snapshot.framesAcked + 1,
        bytesSent: this.snapshot.bytesSent + body.byteLength,
      })
    }
  }

  /**
   * Send one request, repeating the identical request on `429 BUFFER_FULL` (append only) and on
   * `503 RECONNECTING` (bounded by {@link RECONNECT_WAIT_MS}); every other non-2xx answer is returned as an error.
   * @param attempt - issues the request once.
   * @param retryBusy - whether `429` is retryable for this request.
   * @param superseded - checked after each reconnect wait; true drops the request (returns an `Error('superseded')`).
   * @returns the successful response or the terminal error.
   */
  private async sendWithRetry(attempt: () => Promise<Response>, retryBusy: boolean, superseded?: () => boolean): Promise<Response | Error> {
    let busyRetries = 0
    let reconnectSince: number | undefined
    for (;;) {
      const response = await attempt().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      if (response instanceof Error) return response
      if (response.ok) {
        if (this.snapshot.reconnecting) this.set({ ...this.snapshot, reconnecting: false })
        return response
      }
      const failure = await routeError(response)
      if (failure.status === 503 && failure.code === 'RECONNECTING' && this.active) {
        const now = Date.now()
        reconnectSince ??= now
        if (now - reconnectSince < RECONNECT_WAIT_MS) {
          if (!this.snapshot.reconnecting) this.set({ ...this.snapshot, reconnecting: true })
          await new Promise(resolve => setTimeout(resolve, RECONNECT_RETRY_MS))
          // A retry that a newer request replaced (or whose session ended) is dropped instead of repeated.
          if (superseded?.() === true) return new Error('superseded')
          continue
        }
      }
      if (retryBusy && failure.status === 429 && busyRetries < MAX_BUSY_RETRIES) {
        busyRetries++
        await new Promise(resolve => setTimeout(resolve, 100))
        continue
      }
      return failure
    }
  }

  private async post(route: 'control' | 'close' | 'text', liveId: string, body: unknown): Promise<unknown> {
    const response = await this.sendWithRetry(() => this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/live/${route}?liveId=${encodeURIComponent(liveId)}`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }), false)
    if (response instanceof Error) throw response
    const text = await response.text()
    return text === '' ? undefined : JSON.parse(text) as unknown
  }

  private fail(error: unknown): void {
    this.startToken++
    clearInterval(this.meter)
    void this.capture?.close()
    this.capture = undefined
    this.queue.length = 0
    const code = error instanceof AudioRouteError ? error.code : error instanceof CaptureError ? error.failure : 'LIVE_FAILED'
    const message = error instanceof Error ? error.message : String(error)
    this.set({ ...this.snapshot, phase: 'error', level: 0, error: { code, message } })
  }

  private set(next: LiveSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
