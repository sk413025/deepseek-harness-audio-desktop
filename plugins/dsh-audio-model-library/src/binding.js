// Turning catalog rows + controller recipes into dsh-dgx-audio model routes (CONTRACT §4–§5).
//
// Model entries follow dsh-dgx-audio TASK_CONTRACT v0.2 §B. Two binders apply them:
//  * ServiceBinder  — dsh-dgx-audio ≥ 0.4.0 in-process service `dshAudio` (contract 0.2): one route per
//    recipe (every cold model visible in the picker, fail-fast MODEL_NOT_READY until ready),
//    activation states, busy()/drain() preemption guard, resetCapabilities after a runtime swap.
//  * SettingsBinder — frozen dsh-dgx-audio 0.3.x: one library-owned provider route written into the
//    `dsh-dgx-audio` settings section for the single active recipe (validated by the adapter).

import { ADAPTER_NS } from './constants.js'
import { taskInfo } from './catalog.js'

export class LibraryError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

/** Adapter feature keys: `<mode>` or `realtime:<wire>`. */
export const ADAPTER_03_FEATURES = Object.freeze(['chat', 'transcribe', 'realtime:omni-duplex'])
export const ADAPTER_04_FEATURES = Object.freeze(['chat', 'transcribe', 'translate', 'speech', 'generate-audio', 'realtime:omni-duplex', 'realtime:vllm-asr', 'realtime:omni-turn', 'realtime:omni-speech-ws', 'encoding:pcm_f32le'])

/** Catalog task (audio-catalog vocabulary) → adapter task (TASK_CONTRACT §A). */
const ADAPTER_TASK = {
  audio_understanding_qa: 'audio.understand', spoken_chat_text_reply: 'audio.understand', audio_captioning: 'audio.understand',
  spoken_chat_speech_reply: 'speech.s2s', asr: 'asr.transcribe', timestamps: 'asr.transcribe', diarization: 'asr.transcribe',
  speech_translation: 'asr.translate', full_duplex_dialogue: 'duplex',
  tts: 'tts.speech', tts_preset_voice: 'tts.speech', tts_voice_clone: 'tts.speech', tts_voice_design: 'tts.speech', tts_instruct_style: 'tts.speech', tts_multi_speaker_dialogue: 'tts.speech',
  music_generation: 'audio.generate', sound_effect_generation: 'audio.generate', text_to_audio: 'audio.generate',
  text_to_video_with_audio: 'video.generate', image_to_video_with_audio: 'video.generate',
}
/** Adapter task by mode where the catalog task alone is ambiguous (`timestamps` is served by transcribe or align). */
const ADAPTER_TASK_FOR_MODE = { align: 'asr.align', 'generate-video': 'video.generate' }

/**
 * Catalog `adapter_models[].wire` names → the adapter mode they require (dsh-dgx-audio TASK_CONTRACT §A; `align` from
 * 0.4.3, `generate-video` from 0.4.4). A catalog wire outside this list (e.g. a "(proposed)" name) is refused in the
 * library and never renamed or dropped: dropping it would bind a model the host has not accepted for that wire.
 */
export const CATALOG_WIRE_MODES = Object.freeze({
  'openai-chat-audio': 'chat', 'omni-chat-s2s': 'chat', 'openai-transcriptions': 'transcribe', 'openai-translations': 'translate',
  'omni-speech-http': 'speech', 'omni-audio-generate': 'generate-audio', 'vllm-pooling-forced-align': 'align', 'omni-videos': 'generate-video',
  'omni-duplex': 'realtime', 'vllm-asr': 'realtime', 'omni-turn': 'realtime', 'omni-speech-ws': 'realtime',
})

/** Streaming-mode vocabulary (catalog) → adapter capability keys that a recipe may *declare*. */
const DECLARES = {
  text_delta_sse: ['textStreaming'],
  progressive_audio_output_http: ['audioOutput', 'audioOutputStreaming'],
  progressive_audio_output_ws: ['audioOutput', 'audioOutputStreaming'],
  full_duplex_ws: ['liveInput', 'fullDuplex'],
  realtime_speech_to_speech_ws: ['liveInput'],
  realtime_transcription_ws: ['liveInput'],
  incremental_audio_input: ['liveInput'],
  barge_in_interruption: ['bargeIn'],
  resume_reconnect: ['sessionResume'],
}
const CAPABILITY_FOR_MODE = {
  chat: ['textStreaming'],
  'chat+audio': ['textStreaming', 'audioOutput', 'audioOutputStreaming'],
  speech: ['audioOutput', 'audioOutputStreaming'],
  'generate-audio': ['audioOutput', 'audioOutputStreaming'],
  transcribe: ['textStreaming'],
  translate: ['textStreaming'],
  realtime: ['liveInput', 'fullDuplex', 'bargeIn', 'sessionResume', 'playbackAck'],
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringDict = value => (plainObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) : undefined)

/**
 * §B/§K keys the library forwards from a catalog/recipe adapter model object; catalog metadata and nulls are dropped.
 * 0.1.3 adds the keys host 0.4.3/0.4.4 read: `requestOptions` (§K.5, verbatim), `align`, `video`, `params_required`
 * / `paramsRequired`, and the top-level catalog `wire` (validated by the host against the mode).
 */
const ADAPTER_MODEL_KEYS = new Set(['name', 'catalogId', 'catalogTasks', 'mode', 'tasks', 'streaming', 'capabilities', 'speech', 'asr', 'generate', 'realtime',
  'outputAudio', 'sendModalities', 'audioFormat', 'systemPrompt', 'systemPromptWithAudio', 'language', 'contextWindow', 'maxTokens', 'temperature', 'maxAudioPerRequest', 'extraBody',
  'requestOptions', 'requestOptionsMap', 'requestOptionsScope', 'requestOptionsEvidence', 'align', 'video', 'params_required', 'paramsRequired', 'wire'])

/**
 * §K.5 request options and the catalog's per-variant classification (checkpoint 0515), forwarded verbatim so the
 * library, the adapter's capability entry and the mic read the same state. A field that is malformed or over its
 * bound is dropped whole (absent = unknown), never truncated or re-classified; statuses are not interpreted here.
 */
export const REQUEST_OPTION_BOUNDS = Object.freeze({ entries: 400, text: 2000, evidenceJson: 16384 })
const boundedText = value => typeof value === 'string' && value.length <= REQUEST_OPTION_BOUNDS.text
const REQUEST_OPTION_FIELDS = {
  requestOptions: value => Array.isArray(value) && value.length <= REQUEST_OPTION_BOUNDS.entries,
  requestOptionsMap: value => Array.isArray(value) && value.length <= REQUEST_OPTION_BOUNDS.entries
    && value.every(e => plainObject(e) && boundedText(e.option) && boundedText(e.status) && boundedText(e.raw) && (e.detail === undefined || boundedText(e.detail))),
  requestOptionsScope: boundedText,
  requestOptionsEvidence: value => plainObject(value) && JSON.stringify(value).length <= REQUEST_OPTION_BOUNDS.evidenceJson,
}

function withoutNulls(value) {
  if (Array.isArray(value)) return value.filter(v => v !== null).map(withoutNulls)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]))
}

/**
 * Endpoint with its adapter model resolved: an inline `adapterModel`, or the row's catalog adapter model named by
 * `adapterModelId` (per-row request options such as clone task type or generation endpoint), cleaned for the adapter.
 */
export function resolveEndpoint(row, endpoint) {
  if (endpoint === undefined) return undefined
  let source = plainObject(endpoint.adapterModel) ? endpoint.adapterModel : undefined
  if (source === undefined && typeof endpoint.adapterModelId === 'string') {
    source = (row?.adapterModels ?? []).find(m => m.id === endpoint.adapterModelId)
    if (source === undefined) return { ...endpoint, missingAdapterModel: endpoint.adapterModelId }
  }
  if (source === undefined) return endpoint
  const cleaned = Object.fromEntries(Object.entries(withoutNulls(source)).filter(([key, value]) => ADAPTER_MODEL_KEYS.has(key) && value !== undefined))
  if (cleaned.wire !== undefined && typeof cleaned.wire !== 'string') delete cleaned.wire
  for (const [key, valid] of Object.entries(REQUEST_OPTION_FIELDS)) {
    if (cleaned[key] !== undefined && !valid(cleaned[key])) delete cleaned[key]
  }
  // §K.5: strings verbatim, other entries JSON-stringified (as the adapter does); an empty list stays empty (a scoped "none claimed").
  if (cleaned.requestOptions !== undefined) cleaned.requestOptions = cleaned.requestOptions.map(o => (typeof o === 'string' ? o : JSON.stringify(o)))
  // Catalog objects carry the realtime wire at top level; the adapter reads it from `realtime.wire`.
  if (cleaned.mode === 'realtime' && typeof source.wire === 'string') cleaned.realtime = { ...(plainObject(cleaned.realtime) ? cleaned.realtime : {}), wire: cleaned.realtime?.wire ?? source.wire }
  return { ...endpoint, adapterModel: cleaned }
}

/**
 * Library-side refusal for adapter model objects the host would reject. The host validates every route of a source
 * in one replace, so an entry it refuses must not reach it (it would unregister every other recipe).
 * @returns {string | null}
 */
function adapterModelReason(adapterModel, mode) {
  if (!plainObject(adapterModel)) return null
  const wire = adapterModel.wire
  if (wire !== undefined) {
    const expected = CATALOG_WIRE_MODES[wire]
    if (expected === undefined) return 'WIRE_NOT_IMPLEMENTED'
    if (expected !== mode) return 'WIRE_MODE_MISMATCH'
    if (expected === 'realtime' && adapterModel.realtime?.wire !== undefined && adapterModel.realtime.wire !== wire) return 'WIRE_MODE_MISMATCH'
  }
  if (mode === 'align' && !(typeof adapterModel.align?.timestampSegmentTime === 'number' && adapterModel.align.timestampSegmentTime > 0)) return 'ALIGN_CONFIG_MISSING'
  return null
}

/**
 * Which sample rates a realtime wire needs from the recipe/catalog (never guessed). Audio input wires need the input
 * rate; wires whose output audio carries no per-chunk rate need the output rate. Unknown wires need both.
 *  - omni-duplex: pcm16 appends in, pcm deltas out → input + output
 *  - omni-turn: audio in; output events carry `sample_rate_hz` (TASK_CONTRACT §B) → input
 *  - vllm-asr: audio in, text out → input
 *  - omni-speech-ws: text in; binary frames use `realtime.outputSampleRate` (TASK_CONTRACT 0.4.2 #6) → output
 */
export const RATE_REQUIREMENTS = Object.freeze({
  'realtime:omni-duplex': { input: true, output: true },
  'realtime:omni-turn': { input: true, output: false },
  'realtime:vllm-asr': { input: true, output: false },
  'realtime:omni-speech-ws': { input: false, output: true },
})

export function endpointMode(endpoint, task) {
  return endpoint?.adapterModel?.mode ?? endpoint?.adapterMode ?? taskInfo(task).mode
}

export function endpointFeature(endpoint, task) {
  const mode = endpointMode(endpoint, task)
  if (mode !== 'realtime') return mode
  return `realtime:${endpoint?.adapterModel?.realtime?.wire ?? endpoint?.wire ?? 'omni-duplex'}`
}

function groupKey(endpoint, task) {
  const mode = endpointMode(endpoint, task)
  const outputAudio = mode === 'chat' && (endpoint.adapterModel?.outputAudio ?? endpoint.outputAudio ?? taskInfo(task).outputAudio) === true
  if (typeof endpoint.modelKey === 'string' && /^[a-z0-9-]{1,24}$/.test(endpoint.modelKey)) return { key: endpoint.modelKey, mode, outputAudio }
  const wire = endpointFeature(endpoint, task).split(':')[1]
  const key = {
    chat: outputAudio ? 'speech' : 'chat', transcribe: 'transcribe', translate: 'translate', speech: 'tts', 'generate-audio': 'generate', align: 'align', 'generate-video': 'video',
    realtime: { 'omni-duplex': 'live', 'vllm-asr': 'live-asr', 'omni-turn': 'live-turn', 'omni-speech-ws': 'tts-stream' }[wire] ?? `live-${wire}`,
  }[mode] ?? mode
  return { key, mode, outputAudio }
}

function realtimeFacts(endpoint) {
  const source = endpoint.adapterModel?.realtime ?? endpoint
  return { input: source.inputSampleRate, output: source.outputSampleRate }
}

/**
 * Whether the adapter can serve a row task through a recipe.
 * @returns {string | null} reason code, or null when bindable
 */
export function bindReason(task, endpoint, recipe, features) {
  if (recipe === undefined || recipe === null) return 'NO_RECIPE'
  if (endpoint === undefined) return 'NO_ENDPOINT_FOR_TASK'
  if (endpoint.missingAdapterModel !== undefined) return 'ADAPTER_MODEL_NOT_IN_CATALOG'
  const mode = endpointMode(endpoint, task)
  if (mode === 'other') return 'NO_ADAPTER_TASK'
  if (!features.includes(endpointFeature(endpoint, task))) return 'ADAPTER_MODE_UNSUPPORTED'
  const modelReason = adapterModelReason(endpoint.adapterModel, mode)
  if (modelReason !== null) return modelReason
  if (mode === 'align' && endpoint.adapterModel === undefined && !(typeof endpoint.align?.timestampSegmentTime === 'number' && endpoint.align.timestampSegmentTime > 0)) return 'ALIGN_CONFIG_MISSING'
  if (mode === 'realtime') {
    const rates = realtimeFacts(endpoint)
    const need = RATE_REQUIREMENTS[endpointFeature(endpoint, task)] ?? { input: true, output: true }
    if ((need.input && !Number.isInteger(rates.input)) || (need.output && !Number.isInteger(rates.output))) return 'SAMPLE_RATE_UNKNOWN'
    const encoding = endpoint.adapterModel?.realtime?.inputEncoding ?? endpoint.inputEncoding
    if (encoding !== undefined && encoding !== 'pcm16' && !features.includes(`encoding:${encoding}`)) return 'ADAPTER_MODE_UNSUPPORTED'
  }
  if (!Number.isInteger(recipe.port) || recipe.servedModels.length === 0) return 'RECIPE_INCOMPLETE'
  return null
}

/**
 * Per-task bindability of a row for one recipe (or none).
 * @returns {{ id: string, group: string, mode: string, feature: string, bindable: boolean, reason: string | null }[]}
 */
export function taskBindings(row, recipe, features) {
  return row.tasks.map((task) => {
    const endpoint = resolveEndpoint(row, recipe?.endpoints?.find(e => e.task === task))
    const reason = bindReason(task, endpoint, recipe, features)
    return { id: task, group: taskInfo(task).group, mode: endpointMode(endpoint, task), feature: endpointFeature(endpoint, task), bindable: reason === null, reason }
  })
}

/**
 * Build the route for one recipe.
 * @param {object} args
 * @param {any} args.server
 * @param {any} args.recipe normalized recipe
 * @param {any[]} args.rows catalog rows this recipe serves (normally one)
 * @param {string[] | undefined} args.tasks restrict to these catalog tasks (default: all bindable)
 * @param {readonly string[]} args.features adapter feature keys
 * @param {string} args.provider
 * @param {string | undefined} args.referenceVoiceFile
 * @param {boolean} [args.allowEmpty] return null instead of throwing when nothing is bindable
 */
export function buildRoute({ server, recipe, rows, tasks, features, provider, referenceVoiceFile, allowEmpty = false }) {
  if (typeof server.modelHost !== 'string' || server.modelHost === '') throw new LibraryError('NOT_CONFIGURED', `server ${server.id} has no model host configured`, 409)
  const groups = new Map()
  const reasons = []
  for (const row of rows) {
    const wanted = tasks === undefined || tasks.length === 0 ? row.tasks : tasks
    for (const task of wanted) {
      if (!row.tasks.includes(task)) throw new LibraryError('TASK_NOT_BINDABLE', `${row.id} does not list task ${task}`, 400)
      const endpoint = resolveEndpoint(row, recipe.endpoints.find(e => e.task === task))
      const reason = bindReason(task, endpoint, recipe, features)
      if (reason !== null) {
        if (tasks !== undefined && tasks.length > 0) throw new LibraryError('TASK_NOT_BINDABLE', `${task} cannot be used on ${recipe.displayName}: ${reason}`, 409, { task, reason })
        reasons.push({ task, reason })
        continue
      }
      const { key, mode, outputAudio } = groupKey(endpoint, task)
      const group = groups.get(key) ?? { key, mode, outputAudio, row, tasks: [], endpoints: [] }
      group.tasks.push(task)
      group.endpoints.push(endpoint)
      groups.set(key, group)
    }
  }
  if (groups.size === 0) {
    if (allowEmpty) return null
    throw new LibraryError('TASK_NOT_BINDABLE', `no task can be used with this adapter on ${recipe.displayName}`, 409, { reasons })
  }
  const upstreamModel = recipe.servedModels[0]
  const suffix = { chat: 'audio → text', speech: 'audio → text + speech', transcribe: 'transcription', translate: 'speech translation', tts: 'text → speech', generate: 'audio generation', align: 'forced alignment', video: 'video generation', live: 'live duplex', 'live-asr': 'live transcription', 'live-turn': 'live turn-based speech', 'tts-stream': 'streaming text → speech' }
  const models = [...groups.values()].map((group) => {
    const first = group.endpoints[0]
    const verbatim = plainObject(first.adapterModel) ? first.adapterModel : {}
    const entry = {
      ...verbatim,
      id: `${recipe.id}--${group.key}`,
      name: `${group.row.displayName ?? recipe.displayName} · ${suffix[group.key] ?? group.key}`,
      // The served name comes from this deployment (e.g. `--served-model-name`), never from the catalog repo id.
      upstreamModel: typeof first.upstreamModel === 'string' ? first.upstreamModel : upstreamModel,
      mode: group.mode,
    }
    const adapterTasks = ADAPTER_TASK_FOR_MODE[group.mode] ? [ADAPTER_TASK_FOR_MODE[group.mode]] : [...new Set(group.tasks.map(t => ADAPTER_TASK[t]).filter(Boolean))]
    if (adapterTasks.length > 0 && entry.tasks === undefined) entry.tasks = adapterTasks
    if (entry.catalogId === undefined) entry.catalogId = group.row.id
    if (entry.catalogTasks === undefined) entry.catalogTasks = [...group.tasks]
    // TASK_CONTRACT §I S-4: runtime identity is part of the adapter's evidence and switch key.
    if (entry.deploymentId === undefined) entry.deploymentId = deploymentIdOf(recipe)
    if (group.mode === 'chat') {
      entry.outputAudio = group.outputAudio
      entry.sendModalities = verbatim.sendModalities ?? (recipe.runtime?.engine === 'vllm-omni' || first.sendModalities === true)
      for (const key of ['audioFormat', 'systemPromptWithAudio', 'systemPrompt']) if (typeof first[key] === 'string' && entry[key] === undefined) entry[key] = first[key]
      if (Number.isInteger(first.maxAudioPerRequest) && entry.maxAudioPerRequest === undefined) entry.maxAudioPerRequest = first.maxAudioPerRequest
      if (plainObject(first.extraBody) && entry.extraBody === undefined) entry.extraBody = first.extraBody
    }
    if (group.mode === 'speech' && plainObject(first.speech) && entry.speech === undefined) entry.speech = first.speech
    if ((group.mode === 'transcribe' || group.mode === 'translate') && plainObject(first.asr) && entry.asr === undefined) entry.asr = first.asr
    if (group.mode === 'generate-audio' && plainObject(first.generate) && entry.generate === undefined) entry.generate = first.generate
    // Inline recipe endpoints (no catalog object) may carry the same §K objects.
    if (group.mode === 'align' && plainObject(first.align) && entry.align === undefined) entry.align = first.align
    if (group.mode === 'generate-video' && plainObject(first.video) && entry.video === undefined) entry.video = first.video
    if (entry.requestOptions === undefined && REQUEST_OPTION_FIELDS.requestOptions(first.requestOptions)) entry.requestOptions = first.requestOptions.map(o => (typeof o === 'string' ? o : JSON.stringify(o)))
    if (group.mode === 'realtime') {
      const base = plainObject(verbatim.realtime) ? verbatim.realtime : {}
      const rates = realtimeFacts(first)
      entry.realtime = {
        ...base,
        path: base.path ?? (typeof first.path === 'string' ? first.path : '/realtime'),
        query: base.query ?? stringDict(first.query) ?? {},
        ...(Number.isInteger(rates.input) ? { inputSampleRate: rates.input } : {}),
        ...(Number.isInteger(rates.output) ? { outputSampleRate: rates.output } : {}),
        sessionIdPrefix: base.sessionIdPrefix ?? 'harness-library-',
      }
      const wire = endpointFeature(first, group.tasks[0]).split(':')[1]
      if (wire !== 'omni-duplex' || base.wire !== undefined) entry.realtime.wire = wire
      for (const key of ['inputEncoding', 'frameMs']) if (first[key] !== undefined && entry.realtime[key] === undefined) entry.realtime[key] = first[key]
      if (plainObject(first.session) && entry.realtime.session === undefined) entry.realtime.session = first.session
      if (first.requiresReferenceAudio === true && typeof referenceVoiceFile === 'string') entry.realtime.refAudioFile = referenceVoiceFile
    }
    const capabilityScope = group.mode === 'chat' ? (group.outputAudio ? 'chat+audio' : 'chat') : group.mode
    // A realtime endpoint configured by the server owner declares live input (I2-A #1: an `untested` live
    // model was silently not offered). Declared only — the adapter/UI still label it "not verified".
    const declared = group.mode === 'realtime' ? { liveInput: true } : {}
    for (const endpoint of group.endpoints) {
      for (const mode of Array.isArray(endpoint.declares) ? endpoint.declares : []) {
        for (const capability of DECLARES[mode] ?? []) if (CAPABILITY_FOR_MODE[capabilityScope]?.includes(capability)) declared[capability] = true
      }
    }
    if (Object.keys(declared).length > 0) entry.capabilities = { ...(plainObject(entry.capabilities) ? entry.capabilities : {}), ...declared }
    return { entry, group }
  })
  const order = ['speech', 'chat', 'transcribe', 'translate', 'tts', 'generate', 'align', 'video', 'live', 'live-turn', 'live-asr', 'tts-stream']
  models.sort((a, b) => (order.indexOf(a.group.key) + 100) % 100 - (order.indexOf(b.group.key) + 100) % 100)
  const route = {
    provider,
    displayName: `${server.displayName} · ${recipe.displayName}`,
    baseURL: `${server.modelScheme ?? 'http'}://${server.modelHost}:${recipe.port}/v1`,
    ...(server.apiKeyEnv ? { apiKeyEnv: server.apiKeyEnv } : {}),
    models: models.map(m => m.entry),
  }
  const summary = {
    provider,
    serverId: server.id,
    recipeId: recipe.id,
    rowIds: [...new Set(models.map(m => m.group.row.id))],
    upstreamModel,
    baseURL: route.baseURL,
    runtime: recipe.runtime ?? {},
    models: models.map(({ entry, group }) => ({
      id: entry.id,
      name: entry.name,
      mode: entry.mode,
      tasks: group.tasks,
      liveOnly: entry.mode === 'realtime',
      deploymentId: entry.deploymentId,
      outputAudio: entry.outputAudio === true,
      ...(entry.wire !== undefined ? { catalogWire: entry.wire } : {}),
      // Exact join keys for consumers (mic): catalog row + revision + tasks + adapter model id, never a name match.
      catalogId: entry.catalogId,
      catalogRevision: group.row.revision ?? null,
      catalogTasks: entry.catalogTasks,
      adapterModelId: typeof group.endpoints[0].adapterModelId === 'string' && group.endpoints[0].missingAdapterModel === undefined ? group.endpoints[0].adapterModelId : null,
      // Declared by the catalog variant (listed by its source), never verified per model by the library.
      requestOptionCount: Array.isArray(entry.requestOptions) ? entry.requestOptions.length : null,
      requestOptionStatuses: Array.isArray(entry.requestOptionsMap) ? entry.requestOptionsMap.reduce((counts, e) => ({ ...counts, [e.status]: (counts[e.status] ?? 0) + 1 }), {}) : null,
      ...(entry.realtime ? {
        wire: entry.realtime.wire ?? 'omni-duplex',
        inputSampleRate: entry.realtime.inputSampleRate,
        outputSampleRate: entry.realtime.outputSampleRate,
        referenceAudio: entry.realtime.refAudioFile ? 'configured' : (group.endpoints[0].requiresReferenceAudio ? 'missing' : 'not-required'),
      } : {}),
      ...(Number.isInteger(group.endpoints[0].outputSampleRate) && !entry.realtime ? { outputSampleRate: group.endpoints[0].outputSampleRate } : {}),
    })),
    skipped: reasons,
  }
  return { route, summary }
}

export function deploymentIdOf(recipe) {
  const digest = typeof recipe.runtime?.imageDigest === 'string' && /^sha256:[0-9a-f]{12,64}$/.test(recipe.runtime.imageDigest) ? `@${recipe.runtime.imageDigest.slice(0, 19)}` : ''
  const version = typeof recipe.runtime?.version === 'string' ? `:${recipe.runtime.version}` : ''
  return `${recipe.id}${digest || version}`.replace(/[^A-Za-z0-9._:@-]/g, '-').slice(0, 200)
}

export function providerSlug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

// ------------------------------------------------------------------------------------- binders

function settingsDescriptor(settings) {
  const descriptors = typeof settings?.describe === 'function' ? settings.describe() : []
  return descriptors.find(d => d.ns === ADAPTER_NS)
}

export function adapterUserRoutes(settings) {
  const descriptor = settingsDescriptor(settings)
  const routes = descriptor?.user?.routes
  return { descriptor, routes: Array.isArray(routes) ? routes : [] }
}

/**
 * Replace (or remove, with route === null) the library-owned provider route in dsh-dgx-audio settings.
 * @param {{ owned: boolean }} ownership whether an existing route with that provider was written by the library
 */
export async function writeLibraryRoute(settings, provider, route, ownership) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { descriptor, routes } = adapterUserRoutes(settings)
    if (descriptor === undefined) throw new LibraryError('ADAPTER_MISSING', 'dsh-dgx-audio settings are not available in this host', 409)
    if (routes.some(r => r?.provider === provider) && !ownership.owned) {
      throw new LibraryError('PROVIDER_TAKEN', `a dsh-dgx-audio route named "${provider}" exists and was not created by the model library; choose another bindingProvider`, 409)
    }
    const next = routes.filter(r => r?.provider !== provider)
    if (route !== null) next.push(route)
    try {
      await settings.mutate(ADAPTER_NS, [{ op: 'set', path: ['routes'], value: next }], descriptor.revision)
      return next
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT' && attempt === 0) continue
      throw new LibraryError('BINDING_REJECTED', `dsh-dgx-audio refused the route: ${error?.message ?? error}`, 409)
    }
  }
  throw new LibraryError('BINDING_REJECTED', 'dsh-dgx-audio settings kept changing during the write', 409)
}

/** dsh-dgx-audio 0.3.x: a single active recipe written to settings. */
export class SettingsBinder {
  constructor({ settings, provider }) {
    this.kind = 'settings'
    this.settings = settings
    this.provider = provider
    this.features = ADAPTER_03_FEATURES
  }

  get present() { return settingsDescriptor(this.settings()) !== undefined }

  providerFor() { return this.provider() }

  userRoutes() { return adapterUserRoutes(this.settings()).routes }

  checkOwnership(owned) {
    if (!owned && this.userRoutes().some(r => r?.provider === this.provider())) {
      throw new LibraryError('PROVIDER_TAKEN', `a dsh-dgx-audio route named "${this.provider()}" already exists`, 409)
    }
  }

  /** No local work accounting in 0.3.x: the controller's established-connection drain is the guard. */
  busy() { return { supported: false, total: 0, items: [] } }

  async drain() {}

  async apply(route, owned) {
    if (!this.present) throw new LibraryError('ADAPTER_MISSING', 'dsh-dgx-audio is not installed or its settings are unavailable', 409)
    await writeLibraryRoute(this.settings(), this.provider(), route, { owned })
  }

  async clear(owned) {
    if (owned && this.present) await writeLibraryRoute(this.settings(), this.provider(), null, { owned: true })
  }

  syncAll() {}
  refusedReason() { return null }
  setActivation() {}
  resetCapabilities() {}
  dispose() {}
}

/** dsh-dgx-audio ≥ 0.4.0 `dshAudio` service (TASK_CONTRACT v0.2 §C). */
export class ServiceBinder {
  constructor({ service, owner, log = () => {} }) {
    this.kind = 'service'
    this.service = service
    this.log = log
    this.features = ServiceBinder.featuresOf(service)
    this.source = service.registerRouteSource(owner, [])
    Promise.resolve(this.source.ready).catch(error => log(`dsh-audio-model-library: route source failed: ${error?.message ?? error}`))
    this.routes = []
    this.routesKey = '[]'
    this.refused = new Map()
  }

  /** Adapter modes/wires from the adapter's own capability document (TASK_CONTRACT §G, S-1). */
  static featuresOf(service) {
    try {
      const doc = service.describe?.()
      const modes = Array.isArray(doc?.adapterModes) ? doc.adapterModes : undefined
      const wires = Array.isArray(doc?.realtimeWires) ? doc.realtimeWires : undefined
      if (modes === undefined) return ADAPTER_04_FEATURES
      // Contract 0.2 hosts convert pcm16 UI frames to pcm_f32le for f32 duplex profiles (TASK_CONTRACT §B/§I S-2).
      return [...modes.filter(m => m !== 'realtime'), ...(modes.includes('realtime') ? (wires ?? ['omni-duplex']).map(w => `realtime:${w}`) : []), ...(String(service.contractVersion).startsWith('0.2') ? ['encoding:pcm_f32le'] : [])]
    } catch {
      return ADAPTER_04_FEATURES
    }
  }

  get present() { return true }

  checkOwnership() {}

  busy(provider) {
    const report = this.service.busy(provider)
    const total = (report?.chatRequests ?? 0) + (report?.liveSessions ?? 0) + (report?.speechJobs ?? 0)
    return { supported: true, total, items: report?.items ?? [] }
  }

  async drain(provider, options) {
    await this.service.drain(provider, options)
  }

  /**
   * Register every recipe route at once (cold models included). The host validates the whole list in one replace; when
   * it refuses, routes are re-added one by one so a single refused recipe does not unregister the others.
   */
  syncAll(routes) {
    const key = JSON.stringify(routes)
    if (key === this.routesKey) return
    const cleanup = pending => Promise.resolve(pending).catch(error => this.log(`dsh-audio-model-library: route replace cleanup failed: ${error?.message ?? error}`))
    const refused = new Map()
    let accepted = routes
    try {
      cleanup(this.source.replace(routes)) // validates synchronously (throws before any mutation)
    } catch {
      accepted = []
      for (const route of routes) {
        try {
          cleanup(this.source.replace([...accepted, route]))
          accepted.push(route)
        } catch (error) {
          refused.set(route.provider, String(error?.message ?? error).slice(0, 600))
          this.log(`dsh-audio-model-library: dsh-dgx-audio refused route ${route.provider}: ${error?.message ?? error}`)
        }
      }
      cleanup(this.source.replace(accepted))
    }
    this.routesKey = key
    this.routes = accepted
    this.refused = refused
  }

  /** Host validation message for a route the adapter refused in the last sync, if any. */
  refusedReason(provider) {
    return this.refused?.get(provider) ?? null
  }

  setActivation(provider, modelIds, activation) {
    for (const modelId of modelIds) {
      const current = this.service.describe?.()?.routes?.find(r => r.provider === provider)?.models?.find(m => m.id === modelId)?.activation
      if (current?.state === activation.state && current?.detail === activation.detail) continue
      this.service.setActivation(provider, modelId, activation)
    }
  }

  resetCapabilities(provider) {
    this.service.resetCapabilities(provider)
  }

  dispose() {
    this.source.dispose()
  }
}
