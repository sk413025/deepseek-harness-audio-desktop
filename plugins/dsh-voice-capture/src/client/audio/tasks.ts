/**
 * Task view of one adapter model (streaming TASK_CONTRACT 0.2 §F–§G). Controls
 * and labels derive from the capability document: the host computes `uiTask`,
 * `task` (adapter id), `wire`, `io`, `params` and `activation`; this lane maps
 * no names itself. When a model publishes none of them (host 0.3.x), the view
 * falls back to what its `mode` and declared outputs already state and never
 * invents a capability (for example, no speech output for a transcription model).
 */
import type { CapabilityModel, CapabilityState } from './api.ts'
import { NEGATIVE_OBLIGATIONS, offerFor, optionFacts, slotNeed } from './options.ts'
import type { OfferState, OptionFacts } from './options.ts'

/** Closed UI task list (`uiTask`, TASK_CONTRACT 0.2 §F). */
export const AUDIO_TASKS = [
  'chat', 'audio-chat', 'omni-chat', 'asr', 'translation', 'diarization', 'tts', 'voice-clone', 's2s',
  'realtime-asr', 'duplex', 'tts-stream', 'music-generation', 'sound-generation',
  'audio-edit', 'enhancement', 'separation', 'audio-embedding', 'video-generation', 'alignment',
] as const

/** One task variant. */
export type AudioTask = (typeof AUDIO_TASKS)[number]

/** Requirement level of one input. */
export type InputNeed = 'none' | 'optional' | 'required'

/** JSON object value (`extraParams`). */
export type TaskObject = { readonly [key: string]: unknown }

/** One option value sent in the options block. */
export type TaskValue = string | number | boolean | readonly string[] | TaskObject

/** Parameter descriptor published by the adapter (TASK_CONTRACT 0.2 §G/§J `params[]`; `label` optional). */
export type TaskParam =
  | { readonly key: string; readonly label?: string; readonly type: 'enum'; readonly values: readonly string[]; readonly valuesFrom?: string; readonly default?: string }
  | { readonly key: string; readonly label?: string; readonly type: 'number' | 'integer'; readonly min?: number; readonly max?: number; readonly step?: number; readonly default?: number }
  | { readonly key: string; readonly label?: string; readonly type: 'text' | 'string'; readonly maxLength?: number; readonly valuesFrom?: string; readonly default?: string }
  | { readonly key: string; readonly label?: string; readonly type: 'list'; readonly maxLength?: number; readonly default?: readonly string[] }
  | { readonly key: string; readonly label?: string; readonly type: 'boolean'; readonly default?: boolean }
  | { readonly key: string; readonly label?: string; readonly type: 'object'; readonly maxBytes?: number; readonly default?: TaskObject }

/** Attachment slots a request can name in the options block (TASK_CONTRACT 0.2 §J.2 speech, §K.7 video). */
export const REFERENCE_SLOTS = ['referenceAudio', 'referenceAudio2', 'emotionAudio', 'imageReference', 'audioReference'] as const

/** One reference attachment slot. */
export type ReferenceSlot = (typeof REFERENCE_SLOTS)[number]

/** Resolved task description used by every audio control. */
export interface TaskView {
  readonly task: AudioTask
  /** Whether `task` came from the adapter (`declared`) or was inferred from mode/outputs. */
  readonly source: 'declared' | 'inferred'
  readonly input: {
    readonly text: InputNeed
    readonly audio: InputNeed
    readonly referenceAudio: InputNeed
    readonly referenceText: InputNeed
    /** Second speaker clip (`ref_audio_2`) and emotion clip (`extra_params.emo_audio`); `none` unless the model states them. */
    readonly referenceAudio2: InputNeed
    readonly emotionAudio: InputNeed
    /** Video generation references (`io.input.image` / `io.input.audio` of `generate-video` entries). */
    readonly imageReference: InputNeed
    readonly audioReference: InputNeed
  }
  readonly output: {
    readonly text: boolean
    readonly audio: boolean
    readonly audioCount: 'one' | 'many'
    readonly segments: boolean
    readonly wordTimestamps: boolean
    readonly speakers: boolean
    readonly embedding: boolean
    readonly video: boolean
  }
  /** The model produces speech/audio the user hears as part of the exchange. */
  readonly speaks: boolean
  /**
   * Live panel kind: `transcription` (asr.realtime), `conversation` (duplex),
   * `turn` (speech.s2s.realtime, turn-based, never duplex), `text-input`
   * (tts.stream-input), or `none` for request/response models.
   */
  readonly live: 'transcription' | 'conversation' | 'turn' | 'text-input' | 'none'
  /** Adapter task id (`task`) when the host publishes it. */
  readonly adapterTask: string | undefined
  /** Wire profile when the host publishes it. */
  readonly wire: string | undefined
  /** Catalog task names when the host publishes them. */
  readonly catalogTasks: readonly string[]
  /** Option controls published by the host (§K.11), or `source: none` on hosts without them. */
  readonly options: OptionFacts
  readonly params: readonly TaskParam[]
  readonly limits: { readonly maxInputSeconds?: number; readonly maxReferenceSeconds?: number; readonly maxTextChars?: number }
}

const NEEDS: readonly InputNeed[] = ['none', 'optional', 'required']

function need(value: unknown, fallback: InputNeed): InputNeed {
  return typeof value === 'string' && (NEEDS as readonly string[]).includes(value) ? value as InputNeed : fallback
}

function isTask(value: unknown): value is AudioTask {
  return typeof value === 'string' && (AUDIO_TASKS as readonly string[]).includes(value)
}

/** Default input needs per task when `io.input` is absent. */
const TASK_INPUTS: Record<AudioTask, Pick<TaskView['input'], 'text' | 'audio' | 'referenceAudio' | 'referenceText'>> = {
  'chat': { text: 'required', audio: 'none', referenceAudio: 'none', referenceText: 'none' },
  'audio-chat': { text: 'optional', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'omni-chat': { text: 'optional', audio: 'optional', referenceAudio: 'none', referenceText: 'none' },
  'asr': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'translation': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'diarization': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'tts': { text: 'required', audio: 'none', referenceAudio: 'none', referenceText: 'none' },
  'voice-clone': { text: 'required', audio: 'none', referenceAudio: 'required', referenceText: 'optional' },
  's2s': { text: 'none', audio: 'required', referenceAudio: 'optional', referenceText: 'none' },
  'realtime-asr': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'tts-stream': { text: 'required', audio: 'none', referenceAudio: 'none', referenceText: 'none' },
  'duplex': { text: 'none', audio: 'required', referenceAudio: 'optional', referenceText: 'none' },
  'music-generation': { text: 'required', audio: 'optional', referenceAudio: 'none', referenceText: 'none' },
  'sound-generation': { text: 'required', audio: 'none', referenceAudio: 'none', referenceText: 'none' },
  'audio-edit': { text: 'required', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'enhancement': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'separation': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'audio-embedding': { text: 'none', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
  'video-generation': { text: 'required', audio: 'none', referenceAudio: 'none', referenceText: 'none' },
  // The reference transcript is the message text; the audio is a recording or an attached file.
  'alignment': { text: 'required', audio: 'required', referenceAudio: 'none', referenceText: 'none' },
}

/** Tasks whose normal output is generated audio. */
const AUDIO_OUTPUT_TASKS: ReadonlySet<AudioTask> = new Set(['omni-chat', 'tts', 'voice-clone', 's2s', 'duplex', 'tts-stream', 'music-generation', 'sound-generation', 'audio-edit', 'enhancement', 'separation'])
/** Tasks whose audio is heard as the other side of a conversation. */
const SPEAKING_TASKS: ReadonlySet<AudioTask> = new Set(['omni-chat', 's2s', 'duplex'])

function stateOf(model: CapabilityModel, name: keyof CapabilityModel['capabilities']): CapabilityState {
  return model.capabilities[name]?.state ?? 'unsupported'
}

/**
 * Infer a task for a model without a declared `task`.
 * @param model - capability entry.
 * @returns the closest task the published facts support.
 */
export function inferTask(model: CapabilityModel): AudioTask {
  if (model.mode === 'transcribe') return 'asr'
  if (model.mode === 'realtime') {
    const speaks = model.output?.audio === true || stateOf(model, 'audioOutput') !== 'unsupported' || stateOf(model, 'fullDuplex') !== 'unsupported'
    return speaks ? 'duplex' : 'realtime-asr'
  }
  if (model.output?.audio === true) return 'omni-chat'
  if (model.input?.formats !== undefined && model.input.formats.length > 0) return 'audio-chat'
  return 'chat'
}

/**
 * Resolve the task view of a capability entry.
 * @param model - capability entry (possibly carrying proposal fields).
 * @returns the task view.
 */
export function taskView(model: CapabilityModel): TaskView {
  const raw = model as CapabilityModel & {
    uiTask?: unknown
    task?: unknown
    wire?: unknown
    catalogTasks?: unknown
    io?: { input?: Record<string, unknown>; output?: Record<string, unknown> & { transcript?: Record<string, unknown> }; live?: unknown }
    params?: unknown
    optionControls?: unknown
    requestOptionsMap?: unknown
    requestOptionsScope?: unknown
    limits?: Record<string, unknown>
  }
  // `uiTask` is authoritative (§F); a proposal-era `task` holding a UI name is accepted for older mocks.
  const declared = isTask(raw.uiTask) || isTask(raw.task)
  const task = isTask(raw.uiTask) ? raw.uiTask : isTask(raw.task) ? raw.task : inferTask(model)
  // With `uiTask` present `task` is the adapter id (`duplex` is spelled the same in both lists).
  const adapterTask = typeof raw.task === 'string' && (isTask(raw.uiTask) || !isTask(raw.task)) ? raw.task : undefined
  const wire = typeof raw.wire === 'string' ? raw.wire : undefined
  const base = TASK_INPUTS[task]
  const inputs = raw.io?.input ?? {}
  const options = optionFacts(raw)
  const video = task === 'video-generation'
  // Main inputs keep the host io (deployment config) unless the variant names an explicit negative for the key, e.g.
  // IndexTTS `ref_text` ignored; an active mandatory control tightens them to required.
  const mainNeed = (key: string, io: InputNeed): InputNeed => {
    const fact = options.byKey[key]
    if (fact !== undefined && NEGATIVE_OBLIGATIONS.has(fact.obligation)) return 'none'
    return fact?.active === true && fact.mandatory === true ? 'required' : io
  }
  const outputs = raw.io?.output ?? {}
  const transcript = outputs.transcript ?? {}
  const audioOut = typeof outputs.audio === 'boolean' ? outputs.audio : (model.output?.audio ?? AUDIO_OUTPUT_TASKS.has(task))
  const transcriptTask = task === 'asr' || task === 'translation' || task === 'diarization' || task === 'realtime-asr'
  const view: TaskView = {
    task,
    source: declared ? 'declared' : 'inferred',
    input: {
      text: need(inputs.text, base.text),
      // For video generation `io.input.audio` is the audio reference attachment, not a recording.
      audio: video ? 'none' : need(inputs.audio, base.audio),
      referenceAudio: mainNeed('referenceAudio', need(inputs.referenceAudio, base.referenceAudio)),
      referenceText: mainNeed('refText', need(inputs.referenceText, base.referenceText)),
      // The extra clips exist only through an active control (§K.11), never from io or request option strings alone.
      referenceAudio2: slotNeed(options, 'referenceAudio2', need(inputs.referenceAudio2, 'none')),
      emotionAudio: slotNeed(options, 'emotionAudio', need(inputs.emotionAudio, 'none')),
      imageReference: video ? slotNeed(options, 'imageReference', need(inputs.image, 'none')) : 'none',
      audioReference: video ? slotNeed(options, 'audioReference', need(inputs.audio, 'none')) : 'none',
    },
    output: {
      text: typeof outputs.text === 'boolean' ? outputs.text : (model.output?.text ?? (!AUDIO_OUTPUT_TASKS.has(task) || task === 'omni-chat' || task === 'duplex')),
      audio: audioOut,
      audioCount: outputs.audioCount === 'many' || task === 'separation' ? 'many' : 'one',
      segments: typeof transcript.segments === 'boolean' ? transcript.segments : transcriptTask,
      wordTimestamps: transcript.wordTimestamps === true,
      speakers: typeof transcript.speakers === 'boolean' ? transcript.speakers : task === 'diarization',
      embedding: typeof outputs.embedding === 'boolean' ? outputs.embedding : task === 'audio-embedding',
      video: typeof outputs.video === 'boolean' ? outputs.video : video,
    },
    speaks: audioOut && SPEAKING_TASKS.has(task),
    live: liveKind(model, task, adapterTask, raw.io?.live, audioOut),
    adapterTask,
    wire,
    catalogTasks: Array.isArray(raw.catalogTasks) ? raw.catalogTasks.filter((t): t is string => typeof t === 'string') : [],
    options,
    params: Array.isArray(raw.params) ? raw.params.map(toParam).filter((p): p is TaskParam => p !== undefined) : [],
    limits: {
      ...(typeof raw.limits?.maxInputSeconds === 'number' ? { maxInputSeconds: raw.limits.maxInputSeconds } : {}),
      ...(typeof raw.limits?.maxReferenceSeconds === 'number' ? { maxReferenceSeconds: raw.limits.maxReferenceSeconds } : {}),
      ...(typeof raw.limits?.maxTextChars === 'number' ? { maxTextChars: raw.limits.maxTextChars } : {}),
    },
  }
  return view
}

function liveKind(model: CapabilityModel, task: AudioTask, adapterTask: string | undefined, ioLive: unknown, audioOut: boolean): TaskView['live'] {
  if (ioLive === 'text' || adapterTask === 'tts.stream-input' || task === 'tts-stream') return 'text-input'
  const realtime = ioLive === 'audio' || model.mode === 'realtime'
  if (adapterTask === 'asr.realtime' || task === 'realtime-asr') return 'transcription'
  if (adapterTask === 'speech.s2s.realtime' || (realtime && task === 's2s')) return 'turn'
  if (adapterTask === 'duplex' || task === 'duplex') return audioOut ? 'conversation' : 'transcription'
  return 'none'
}

const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/

/** Run-time value lists may only come from adapter routes (e.g. `GET …/voices`). */
function valuesFromOf(p: Record<string, unknown>): string | undefined {
  return typeof p.valuesFrom === 'string' && p.valuesFrom.startsWith('/api/dsh-dgx-audio/v1/') ? p.valuesFrom : undefined
}

function toParam(value: unknown): TaskParam | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const p = value as Record<string, unknown>
  if (typeof p.key !== 'string' || !PARAM_KEY.test(p.key)) return undefined
  const common = { key: p.key, ...(typeof p.label === 'string' ? { label: p.label } : {}) }
  const num = (k: string): { [key: string]: number } => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? { [k]: p[k] as number } : {})
  switch (p.type) {
    case 'enum': {
      const values = Array.isArray(p.values) ? p.values.filter((v): v is string => typeof v === 'string') : []
      const valuesFrom = valuesFromOf(p)
      if (values.length === 0 && valuesFrom === undefined) return undefined
      return { ...common, type: 'enum', values, ...(valuesFrom === undefined ? {} : { valuesFrom }), ...(typeof p.default === 'string' ? { default: p.default } : {}) }
    }
    case 'number':
    case 'integer':
      return { ...common, type: p.type, ...num('min'), ...num('max'), ...num('step'), ...num('default') }
    case 'text':
    case 'string':
      return { ...common, type: p.type, ...num('maxLength'), ...(valuesFromOf(p) === undefined ? {} : { valuesFrom: valuesFromOf(p)! }), ...(typeof p.default === 'string' ? { default: p.default } : {}) }
    case 'list':
      return { ...common, type: 'list', ...num('maxLength'), ...(Array.isArray(p.default) ? { default: p.default.filter((v): v is string => typeof v === 'string') } : {}) }
    case 'boolean':
      return { ...common, type: 'boolean', ...(typeof p.default === 'boolean' ? { default: p.default } : {}) }
    case 'object':
      return { ...common, type: 'object', maxBytes: typeof p.maxBytes === 'number' ? p.maxBytes : 16_000, ...(isPlainObject(p.default) ? { default: p.default } : {}) }
    default:
      return undefined
  }
}

function isPlainObject(value: unknown): value is TaskObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a JSON object typed into an object parameter.
 * @param text - JSON text.
 * @returns the object, or undefined when the text is not a JSON object.
 */
export function parseJsonObject(text: string): TaskObject | undefined {
  if (text.trim() === '') return undefined
  try {
    const value = JSON.parse(text) as unknown
    return isPlainObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Offer state of one parameter (TASK_CONTRACT §K.11 option controls; see `options.ts`).
 * @param view - task view.
 * @param param - descriptor.
 * @param serverValues - choices the server reported for a `valuesFrom` parameter (undefined while unknown).
 * @returns offer state.
 */
export function offerOf(view: TaskView, param: TaskParam, serverValues?: readonly string[]): OfferState {
  const serverChoices = 'valuesFrom' in param && param.valuesFrom !== undefined && serverValues !== undefined && serverValues.length > 0
  return offerFor(view.options, param.key, param.default !== undefined, serverChoices)
}

/** User-side state checked before a task request. */
export interface TaskDraft {
  readonly text: string
  readonly hasAudio: boolean
  readonly hasReference: boolean
  readonly referenceConsent: boolean
  readonly referenceText: string
  /** User-set options (a sound description in `ambientSound` replaces the text input). */
  readonly options?: Readonly<Record<string, TaskValue>>
  /** Extra clip slots the model states, with whether a clip is held and consented. */
  readonly extraReferences?: Readonly<Partial<Record<'referenceAudio2' | 'emotionAudio' | 'imageReference' | 'audioReference', { readonly present: boolean; readonly consent: boolean }>>>
  /** Parameters whose active control is mandatory (`required`) that have no value yet. */
  readonly requiredOptionsMissing?: readonly string[]
}

/** One unmet requirement. */
export type MissingInput = 'text' | 'audio' | 'referenceAudio' | 'referenceConsent' | 'referenceText' | 'textTooLong' | 'referenceAudio2' | 'emotionAudio' | 'imageReference' | 'audioReference' | 'requiredOption'

/**
 * Requirements the draft does not satisfy yet.
 * @param view - task view.
 * @param draft - current inputs.
 * @returns missing requirement codes in display order.
 */
export function missingInputs(view: TaskView, draft: TaskDraft): MissingInput[] {
  const missing: MissingInput[] = []
  const ambient = draft.options?.ambientSound
  const describedByAmbient = typeof ambient === 'string' && ambient.trim() !== ''
  if (view.input.text === 'required' && draft.text.trim() === '' && !describedByAmbient) missing.push('text')
  if (view.limits.maxTextChars !== undefined && draft.text.length > view.limits.maxTextChars) missing.push('textTooLong')
  if (view.input.audio === 'required' && !draft.hasAudio) missing.push('audio')
  if (view.input.referenceAudio === 'required' && !draft.hasReference) missing.push('referenceAudio')
  if ((draft.requiredOptionsMissing?.length ?? 0) > 0) missing.push('requiredOption')
  for (const slot of ['referenceAudio2', 'emotionAudio', 'imageReference', 'audioReference'] as const) {
    if (view.input[slot] === 'required' && draft.extraReferences?.[slot]?.present !== true) missing.push(slot)
  }
  const extraWithoutConsent = Object.values(draft.extraReferences ?? {}).some(r => r?.present === true && !r.consent)
  if ((draft.hasReference && !draft.referenceConsent) || extraWithoutConsent) missing.push('referenceConsent')
  if (view.input.referenceText === 'required' && draft.referenceText.trim() === '') missing.push('referenceText')
  return missing
}

/**
 * Coerce option values against the descriptors; unknown keys are dropped, out-of-range numbers clamped.
 * @param params - descriptors.
 * @param values - user values keyed by param key.
 * @param includeDefaults - fill unset keys with descriptor defaults (display); requests send only user-set keys.
 * @returns validated options.
 */
export function resolveOptions(params: readonly TaskParam[], values: Readonly<Record<string, unknown>>, includeDefaults = true): Record<string, TaskValue> {
  const out: Record<string, TaskValue> = {}
  for (const param of params) {
    const value = values[param.key] ?? (includeDefaults ? param.default : undefined)
    if (value === undefined) continue
    switch (param.type) {
      case 'enum':
        // Server-provided voice lists load at run time; the adapter validates those values.
        if (typeof value === 'string' && (param.values.includes(value) || (param.valuesFrom !== undefined && value !== ''))) out[param.key] = value
        else if (includeDefaults && param.default !== undefined && param.values.includes(param.default)) out[param.key] = param.default
        break
      case 'number':
      case 'integer': {
        const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
        if (!Number.isFinite(raw)) break
        // Host 0.4.2 publishes integers as `number` with `step: 1`; its validator still requires an integer.
        const integral = param.type === 'integer' || (param.step !== undefined && Number.isInteger(param.step) && param.step >= 1)
        const unit = param.type === 'integer' ? 1 : (param.step ?? 1)
        let n = integral ? Math.round(raw / unit) * unit : raw
        // Clamp each bound on its own (0.3.0 let values below a min-only range through).
        if (param.min !== undefined) n = Math.max(param.min, n)
        if (param.max !== undefined) n = Math.min(param.max, n)
        out[param.key] = n
        break
      }
      case 'text':
      case 'string':
        if (typeof value === 'string' && value !== '') out[param.key] = param.maxLength === undefined ? value : value.slice(0, param.maxLength)
        break
      case 'list': {
        const items = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [])
          .filter((v): v is string => typeof v === 'string')
          .map(v => v.trim())
          .filter(v => v !== '')
        if (items.length > 0) out[param.key] = param.maxLength === undefined ? items : items.slice(0, param.maxLength)
        break
      }
      case 'boolean':
        if (typeof value === 'boolean') out[param.key] = value
        break
      case 'object': {
        const parsed = typeof value === 'string' ? parseJsonObject(value) : isPlainObject(value) ? value : undefined
        if (parsed !== undefined && Object.keys(parsed).length > 0 && JSON.stringify(parsed).length <= (param.maxBytes ?? 16_000)) out[param.key] = parsed
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Inline options block (TASK_CONTRACT 0.2 §H, normative carrier) placed before the request text.
 * @param model - Harness model id.
 * @param options - validated options.
 * @param reference - reference attachment name and optional transcript.
 * @returns fenced JSON block text.
 */
export function optionsBlock(
  model: string,
  options: Readonly<Record<string, TaskValue>>,
  reference?: { readonly name?: string; readonly text?: string; readonly referenceAudio2?: string; readonly emotionAudio?: string; readonly imageReference?: string; readonly audioReference?: string },
): string {
  const payload = {
    v: 1,
    model,
    ...options,
    // An empty referenceText is sent on purpose: it stops the adapter from reading a prompt prefix as the transcript.
    ...(reference?.name === undefined ? {} : { referenceAudio: reference.name, ...(reference.text === undefined ? {} : { referenceText: reference.text }) }),
    ...(reference?.referenceAudio2 === undefined ? {} : { referenceAudio2: reference.referenceAudio2 }),
    ...(reference?.emotionAudio === undefined ? {} : { emotionAudio: reference.emotionAudio }),
    ...(reference?.imageReference === undefined ? {} : { imageReference: reference.imageReference }),
    ...(reference?.audioReference === undefined ? {} : { audioReference: reference.audioReference }),
  }
  return '```dsh-audio-options\n' + JSON.stringify(payload) + '\n```'
}

/**
 * One prompt text part: the options block, a blank line, then the user's text (Harness joins adjacent text parts without a separator).
 * @param block - options block, or undefined for plain text.
 * @param text - request text.
 * @returns prompt text.
 */
export function withOptions(block: string | undefined, text: string): string {
  if (block === undefined) return text
  return text === '' ? block : `${block}\n\n${text}`
}

/**
 * Voice names from `GET …/voices` (`voices` passthrough entries may be strings or objects; `uploadedVoices[].name`).
 * @param body - route response.
 * @returns unique names in server order.
 */
export function voiceNames(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null) return []
  const record = body as { voices?: unknown; uploadedVoices?: unknown }
  const names: string[] = []
  for (const list of [record.voices, record.uploadedVoices]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const name = typeof item === 'string' ? item
        : typeof item === 'object' && item !== null
          ? ['name', 'voice', 'id'].map(k => (item as Record<string, unknown>)[k]).find((v): v is string => typeof v === 'string')
          : undefined
      if (name !== undefined && name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}
