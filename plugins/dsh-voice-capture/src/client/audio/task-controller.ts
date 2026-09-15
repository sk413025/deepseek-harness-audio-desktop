/**
 * Per-Session task inputs beyond the recorded clip: parameter values (kept per
 * model, so a value chosen for one model never reaches another), reference
 * clips per attachment slot (each with explicit consent) and text-input task requests
 * such as speech or music generation. Options travel as the logged inline
 * `dsh-audio-options` block (TASK_CONTRACT 0.2 §H, normative) in the same
 * prompt as the files they reference. User-set values are also applied with
 * `POST session-params` so the plain composer Send and Live sessions use them.
 */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPort, UploadPort } from '../controller.ts'
import { ROUTE_PREFIX, requestJson } from './api.ts'
import type { FetchLike } from './api.ts'
import { REFERENCE_SLOTS, optionsBlock, resolveOptions, withOptions } from './tasks.ts'
import type { ReferenceSlot, TaskValue, TaskView } from './tasks.ts'

/** Reference voice clip held in the browser until a request uses it. */
export interface ReferenceClip {
  readonly name: string
  readonly url: string
  readonly bytes: number
  readonly type: string
  readonly source: 'recorded' | 'file'
}

/** Published task-input state for one Session. */
export interface TaskInputsSnapshot {
  /** User-set values per Harness model id. */
  readonly values: Readonly<Record<string, Readonly<Record<string, TaskValue>>>>
  /** Clips per attachment slot and the consent given for each. */
  readonly references: Readonly<Partial<Record<ReferenceSlot, ReferenceClip>>>
  readonly consents: Readonly<Partial<Record<ReferenceSlot, boolean>>>
  /** The main reference slot (`referenceAudio`), mirrored for the reference box. */
  readonly reference: ReferenceClip | undefined
  readonly referenceConsent: boolean
  readonly referenceText: string
  readonly phase: 'idle' | 'sending'
  readonly error: { readonly code: 'upload-failed' | 'prompt-failed' | 'session-unavailable' | 'reference-too-large' | 'reference-type' | 'model-not-ready'; readonly detail: string } | undefined
  readonly lastSentAt: number | undefined
  /** `POST session-params` state for the values above. */
  readonly params: 'unset' | 'applying' | 'applied' | 'failed' | 'unsupported'
  readonly paramsDetail: string | undefined
}

/** One consented clip sent with a request. */
export interface RequestReference {
  readonly slot: ReferenceSlot
  readonly file: File
  readonly name: string
}

/** Extra prompt parts contributed to any audio request from this Session. */
export interface RequestExtras {
  /** Consented clips in slot order (`referenceAudio`, `referenceAudio2`, `emotionAudio`). */
  readonly references: readonly RequestReference[]
  readonly block: string | undefined
}

const EMPTY: TaskInputsSnapshot = {
  values: {}, references: {}, consents: {}, reference: undefined, referenceConsent: false, referenceText: '',
  phase: 'idle', error: undefined, lastSentAt: undefined, params: 'unset', paramsDetail: undefined,
}

/** File name prefix per slot; the adapter selects clips by these attachment names. */
const SLOT_PREFIX: Record<ReferenceSlot, string> = {
  referenceAudio: 'reference-voice',
  referenceAudio2: 'reference-voice-2',
  emotionAudio: 'emotion-reference',
  imageReference: 'image-reference',
  audioReference: 'audio-reference',
}

/** Delay before edited values are applied as session params. */
const PARAMS_DEBOUNCE_MS = 400

/** Parameter keys the reference box supplies itself. */
const REFERENCE_KEYS: ReadonlySet<string> = new Set(['refText'])

/** Target of a session-params request. */
export interface ParamsTarget {
  readonly provider: string
  readonly model: string
  readonly view: TaskView
  /** Keys never posted as session params for this model (an omni-duplex turn mode owns them). */
  readonly omitKeys?: ReadonlySet<string>
}

/** Largest accepted reference file (bytes). */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const REFERENCE_TYPES = /^audio\/(wav|x-wav|wave|mpeg|mp3|flac|x-flac|ogg|opus|webm|mp4|x-m4a|aac)$/
/** Image types the host forwards as `image_reference` (TASK_CONTRACT §K.7: png/jpg/webp/gif/bmp). */
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Page-wide task input controller. */
export class TaskInputsController {
  private readonly states = new Map<SessionId, {
    snapshot: TaskInputsSnapshot
    files: Partial<Record<ReferenceSlot, File>>
    abort: AbortController | undefined
    paramsTimer: ReturnType<typeof setTimeout> | undefined
    paramsRun: number
  }>()
  private readonly listeners = new Set<() => void>()
  private readonly sources = new Map<SessionId, { getSnapshot(): TaskInputsSnapshot; subscribe(l: () => void): () => void }>()

  /**
   * @param upload - file upload service.
   * @param sessions - Session bindings.
   * @param fetchImpl - page fetch for `session-params`.
   * @param now - wall clock.
   */
  constructor(
    private readonly upload: UploadPort,
    private readonly sessions: SessionPort,
    private readonly fetchImpl: FetchLike | undefined = undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Identity-stable observable for one Session.
   * @param sessionId - Session id.
   * @returns source.
   */
  source(sessionId: SessionId) {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = {
        getSnapshot: () => this.state(sessionId).snapshot,
        subscribe: (listener: () => void) => {
          this.listeners.add(listener)
          return () => { this.listeners.delete(listener) }
        },
      }
      this.sources.set(sessionId, source)
    }
    return source
  }

  /**
   * Set one parameter value for one model.
   * @param sessionId - Session id.
   * @param model - Harness model id the value belongs to.
   * @param key - parameter key.
   * @param value - raw value.
   * @param target - adapter model to apply session params to after a short delay.
   */
  setValue(sessionId: SessionId, model: string, key: string, value: TaskValue, target?: ParamsTarget): void {
    const state = this.state(sessionId)
    const current = state.snapshot.values[model] ?? {}
    this.update(sessionId, { values: { ...state.snapshot.values, [model]: { ...current, [key]: value } } })
    if (target === undefined || this.fetchImpl === undefined) return
    clearTimeout(state.paramsTimer)
    state.paramsTimer = setTimeout(() => { void this.applyParams(sessionId, target) }, PARAMS_DEBOUNCE_MS)
  }

  /**
   * Apply the user-set values with `POST session-params` (TASK_CONTRACT 0.2 §D).
   * @param sessionId - Session id.
   * @param target - selected adapter model.
   * @param options - `omitKeys`: keys never posted for this model (an omni-duplex turn mode owns them); `force`: post even an
   *   empty set, which replaces (clears) a stale stored set such as an earlier `turnDetection`; `extra`: fields added verbatim
   *   (a turn mode's `send`); `onRefused`: receives the host's code and message when the set is not applied.
   * @returns whether the host accepted them (true when nothing was set and nothing was forced).
   */
  async applyParams(sessionId: SessionId, target: ParamsTarget, options: { readonly omitKeys?: ReadonlySet<string>; readonly force?: boolean; readonly extra?: Readonly<Record<string, string>>; readonly onRefused?: (refusal: { readonly code: string; readonly message: string }) => void } = {}): Promise<boolean> {
    const state = this.state(sessionId)
    clearTimeout(state.paramsTimer)
    state.paramsTimer = undefined
    if (this.fetchImpl === undefined) return true
    const all = state.snapshot.values[target.model] ?? {}
    const omit = options.omitKeys ?? target.omitKeys
    const values = omit === undefined ? all : Object.fromEntries(Object.entries(all).filter(([key]) => !omit.has(key)))
    const params = { ...this.requestOptions(values, target.view), ...options.extra }
    if (Object.keys(values).length === 0 && Object.keys(options.extra ?? {}).length === 0 && options.force !== true) return true
    const run = ++state.paramsRun
    this.update(sessionId, { params: 'applying', paramsDetail: undefined })
    try {
      await requestJson<{ ok: true }>(this.fetchImpl, `${ROUTE_PREFIX}/session-params`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, provider: target.provider, model: target.model, params }),
      })
      if (run === state.paramsRun) this.update(sessionId, { params: 'applied', paramsDetail: undefined })
      return true
    } catch (error) {
      const status = (error as { status?: number }).status
      const code = (error as { code?: string }).code
      options.onRefused?.({ code: code ?? 'PARAMS_FAILED', message: error instanceof Error ? error.message : String(error) })
      if (run === state.paramsRun) {
        this.update(sessionId, {
          params: status === 404 || status === 405 ? 'unsupported' : 'failed',
          paramsDetail: `${code ?? ''} ${error instanceof Error ? error.message : String(error)}`.trim(),
        })
      }
      return false
    }
  }

  /**
   * Hold a reference clip (recorded bytes or a picked file) for one slot. Consent for that slot resets.
   * @param sessionId - Session id.
   * @param data - clip content.
   * @param source - how the clip was obtained.
   * @param originalName - picked file name (extension kept).
   * @param slot - attachment slot.
   */
  setReference(sessionId: SessionId, data: Blob, source: 'recorded' | 'file', originalName = 'reference.wav', slot: ReferenceSlot = 'referenceAudio'): void {
    if (data.size > MAX_REFERENCE_BYTES) {
      this.update(sessionId, { error: { code: 'reference-too-large', detail: String(data.size) } })
      return
    }
    const type = data.type === '' ? (slot === 'imageReference' ? 'image/png' : 'audio/wav') : data.type
    if (!(slot === 'imageReference' ? IMAGE_TYPES : REFERENCE_TYPES).test(type)) {
      this.update(sessionId, { error: { code: 'reference-type', detail: type } })
      return
    }
    this.clearReference(sessionId, slot)
    const extension = /\.([A-Za-z0-9]{2,5})$/.exec(originalName)?.[1]?.toLowerCase() ?? 'wav'
    const name = `${SLOT_PREFIX[slot]}-${stamp(new Date(this.now()))}.${extension}`
    const file = new File([data], name, { type })
    const state = this.state(sessionId)
    state.files[slot] = file
    this.update(sessionId, {
      references: { ...state.snapshot.references, [slot]: { name, url: URL.createObjectURL(file), bytes: file.size, type, source } },
      consents: { ...state.snapshot.consents, [slot]: false },
      error: undefined,
    })
  }

  /**
   * Drop the clip of one slot.
   * @param sessionId - Session id.
   * @param slot - attachment slot.
   */
  clearReference(sessionId: SessionId, slot: ReferenceSlot = 'referenceAudio'): void {
    const state = this.state(sessionId)
    const url = state.snapshot.references[slot]?.url
    delete state.files[slot]
    if (url !== undefined) setTimeout(() => { URL.revokeObjectURL(url) }, 0)
    const references = { ...state.snapshot.references }
    delete references[slot]
    this.update(sessionId, { references, consents: { ...state.snapshot.consents, [slot]: false } })
  }

  /**
   * Record the user's permission to use the voice in one slot.
   * @param sessionId - Session id.
   * @param consent - checkbox state.
   * @param slot - attachment slot.
   */
  setConsent(sessionId: SessionId, consent: boolean, slot: ReferenceSlot = 'referenceAudio'): void {
    this.update(sessionId, { consents: { ...this.state(sessionId).snapshot.consents, [slot]: consent } })
  }

  /**
   * Transcript of the reference clip.
   * @param sessionId - Session id.
   * @param text - transcript text.
   */
  setReferenceText(sessionId: SessionId, text: string): void {
    this.update(sessionId, { referenceText: text })
  }

  /** @param sessionId - Session id. */
  dismissError(sessionId: SessionId): void {
    this.update(sessionId, { error: undefined })
  }

  /**
   * Extra parts for a request to `model` (options block and consented reference clip).
   * @param sessionId - Session id.
   * @param model - Harness model id.
   * @param view - task view.
   * @returns extras (undefined members when not applicable).
   */
  extras(sessionId: SessionId, model: string, view: TaskView): RequestExtras {
    const state = this.state(sessionId)
    const options = this.requestOptions(state.snapshot.values[model] ?? {}, view)
    // A slot is used only when the model states it and the user consented for that clip.
    const references = REFERENCE_SLOTS.flatMap((slot): RequestReference[] => {
      const file = state.files[slot]
      return view.input[slot] !== 'none' && file !== undefined && state.snapshot.consents[slot] === true ? [{ slot, file, name: file.name }] : []
    })
    const nameOf = (slot: ReferenceSlot) => references.find(r => r.slot === slot)?.name
    const main = nameOf('referenceAudio')
    const referenceText = view.input.referenceText === 'none' || main === undefined ? undefined : state.snapshot.referenceText.trim()
    const hasOptions = Object.keys(options).length > 0 || references.length > 0
    return {
      references,
      block: hasOptions
        ? optionsBlock(model, options, references.length === 0 ? undefined : {
            ...(main === undefined ? {} : { name: main }),
            ...(referenceText === undefined ? {} : { text: referenceText }),
            ...(nameOf('referenceAudio2') === undefined ? {} : { referenceAudio2: nameOf('referenceAudio2')! }),
            ...(nameOf('emotionAudio') === undefined ? {} : { emotionAudio: nameOf('emotionAudio')! }),
            ...(nameOf('imageReference') === undefined ? {} : { imageReference: nameOf('imageReference')! }),
            ...(nameOf('audioReference') === undefined ? {} : { audioReference: nameOf('audioReference')! }),
          })
        : undefined,
    }
  }

  /** User-set values valid for the model (defaults stay with the host; reference keys come from the reference box). */
  private requestOptions(values: Readonly<Record<string, TaskValue>>, view: TaskView): Record<string, TaskValue> {
    const params = view.input.referenceText === 'none' ? view.params : view.params.filter(p => !REFERENCE_KEYS.has(p.key))
    return resolveOptions(params, values, false)
  }

  /**
   * Send a text-input task request (e.g. speech or music generation) with its options and reference clip.
   * @param sessionId - Session id.
   * @param model - Harness model id.
   * @param view - task view.
   * @param text - request text (the composer draft).
   * @param blocked - activation check run before upload and again before admission.
   * @returns whether the prompt was admitted.
   */
  async generate(sessionId: SessionId, model: string, view: TaskView, text: string, blocked?: () => string | undefined): Promise<boolean> {
    const state = this.state(sessionId)
    if (state.snapshot.phase === 'sending') return false
    const notReady = blocked?.()
    if (notReady !== undefined) return this.failed(sessionId, 'model-not-ready', notReady)
    const extras = this.extras(sessionId, model, view)
    const abort = new AbortController()
    state.abort = abort
    this.update(sessionId, { phase: 'sending', error: undefined })
    const uploads: { receiptId: string; ref: FileAttachmentRef }[] = []
    for (const reference of extras.references) {
      try {
        const uploaded = await this.upload.upload(sessionId, reference.file, reference.name, abort.signal, () => {})
        if (!uploaded.ok) return this.failed(sessionId, 'upload-failed', `${uploaded.error.code}: ${uploaded.error.message}`)
        uploads.push({ receiptId: uploaded.value.receiptId, ref: uploaded.value.file })
      } catch (error) {
        return this.failed(sessionId, abort.signal.aborted ? undefined : 'upload-failed', String(error))
      }
    }
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return this.failed(sessionId, 'session-unavailable', '')
    const stillNotReady = blocked?.()
    if (stillNotReady !== undefined) return this.failed(sessionId, 'model-not-ready', stillNotReady)
    const combined = withOptions(extras.block, text)
    const textParts = combined === '' ? [] : [combined]
    const submission = binding.session.beginSubmission({
      mode: 'queue',
      text: combined,
      attachments: uploads.map(u => ({ type: 'file' as const, value: u.ref })),
    })
    try {
      const result = await binding.session.prompt([
        ...uploads.map(u => ({ type: 'file' as const, receiptId: u.receiptId as never })),
        ...textParts.map(part => ({ type: 'text' as const, text: part })),
      ], 'queue', abort.signal, submission.requestId)
      if (!result.ok) return this.failed(sessionId, 'prompt-failed', `${result.error.code}: ${result.error.message}`)
    } catch (error) {
      submission.abandon()
      return this.failed(sessionId, abort.signal.aborted ? undefined : 'prompt-failed', String(error))
    }
    state.abort = undefined
    this.update(sessionId, { phase: 'idle', lastSentAt: this.now() })
    return true
  }

  /** @param sessionId - Session id whose in-flight request is cancelled. */
  cancel(sessionId: SessionId): void {
    this.state(sessionId).abort?.abort()
  }

  /** Release every reference URL (plugin unload). */
  dispose(): void {
    for (const [sessionId, state] of this.states) {
      state.abort?.abort()
      clearTimeout(state.paramsTimer)
      for (const slot of REFERENCE_SLOTS) if (state.snapshot.references[slot] !== undefined) this.clearReference(sessionId, slot)
    }
  }

  private failed(sessionId: SessionId, code: TaskInputsSnapshot['error'] extends infer E ? E extends { code: infer C } ? C | undefined : never : never, detail: string): false {
    const state = this.state(sessionId)
    state.abort = undefined
    this.update(sessionId, { phase: 'idle', error: code === undefined ? undefined : { code, detail } })
    return false
  }

  private state(sessionId: SessionId) {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { snapshot: EMPTY, files: {}, abort: undefined, paramsTimer: undefined, paramsRun: 0 }
      this.states.set(sessionId, state)
    }
    return state
  }

  private update(sessionId: SessionId, patch: Partial<TaskInputsSnapshot>): void {
    const state = this.state(sessionId)
    const next = { ...state.snapshot, ...patch }
    state.snapshot = { ...next, reference: next.references.referenceAudio, referenceConsent: next.consents.referenceAudio === true }
    for (const listener of [...this.listeners]) listener()
  }
}
