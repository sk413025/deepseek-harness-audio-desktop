// Plugin configuration: validated defaults with no site-specific endpoint, path or credential.
//
// A fresh install registers no provider and never contacts a server until the user
// configures a route. Output files default to the Harness home ($DSH_HOME or ~/.dsh).

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { SSE_DEFAULT_LIMITS } from './sse.js'
import { HUB_DEFAULT_LIMITS } from './audio-hub.js'
import { requestOptionsFieldErrors } from './option-controls.js'

export const QWEN_OMNI_SYSTEM_PROMPT = 'You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, capable of '
  + 'perceiving auditory and visual inputs, as well as generating text and speech.'

/** Per-model defaults; see README for every field. */
export const MODEL_DEFAULTS = Object.freeze({
  mode: 'chat', // chat → /chat/completions + input_audio; transcribe → /audio/transcriptions; realtime → live WebSocket session
  outputAudio: false, // request spoken output (vLLM-Omni modalities text+audio)
  sendModalities: false, // send the vLLM-Omni `modalities` field (required by vLLM-Omni when streaming)
  systemPromptWithAudio: 'auto', // auto: verified model rule or remembered server rejection → user-prefix, else system with one retry on that error; system / user-prefix: explicit
  contextWindow: 16384,
  maxAudioPerRequest: 5, // vLLM limit_mm_per_prompt default on the tested servers
  streaming: Object.freeze({ text: 'auto' }), // auto → SSE unless this host observed the server refuse it; sse; off
  capabilities: Object.freeze({}), // declared (not verified) capabilities, e.g. { audioOutputStreaming: true }
})

export const REALTIME_DEFAULTS = Object.freeze({
  path: '/realtime', // appended to the route baseURL (…/v1 → ws(s)://…/v1/realtime)
  query: Object.freeze({ duplex: '1', autostart: '0' }),
  session: Object.freeze({
    modalities: ['audio', 'text'],
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    turn_detection: null,
    overlap_policy: 'listen_only',
    playback_commit_policy: 'ack_only',
  }),
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  refAudioFile: undefined, // voice prompt WAV sent as session.ref_audio (required by MiniCPM-o 4.5 speech output)
  sessionIdPrefix: 'harness-',
  connectTimeoutMs: 15000,
})

export const CONFIG_DEFAULTS = Object.freeze({
  routes: Object.freeze([]),
  outputDir: undefined, // default: <DSH home>/dsh-dgx-audio/outputs
  invocationLog: undefined, // default: <outputDir>/invocations.jsonl; '' disables
  capabilityFile: undefined, // default: <outputDir>/capabilities.json; '' disables persistence
  outputLink: 'api', // api → /api/dsh-dgx-audio/v1/recording link; web → <webBaseUrl>/api/file?path=; path → saved path + Desktop patch-0002 image
  webBaseUrl: undefined,
  requestTimeoutMs: 900000,
  maxAudioBytes: 25 * 1024 * 1024,
  annotate: true, // append the evidence footer (endpoint, hashes, audio link)
  resultCarrier: 'link', // link: footer link line + GET result?id= (durable JSON next to recordings); fence: legacy ```dsh-audio-result block
  httpRoutes: true, // mount /api/dsh-dgx-audio/v1/* when the Connection service exists
  sseLimits: SSE_DEFAULT_LIMITS,
  hubLimits: HUB_DEFAULT_LIMITS,
  live: Object.freeze({ maxSessions: 2, idleTimeoutMs: 15000, maxFrameBytes: 64000, maxQueuedBytes: 1024 * 1024, maxSeconds: 600 }),
})

const VALID = {
  mode: ['chat', 'transcribe', 'translate', 'speech', 'generate-audio', 'realtime', 'align', 'generate-video'],
  systemPromptWithAudio: ['auto', 'system', 'user-prefix'],
}
const VALID_OUTPUT_LINK = ['api', 'web', 'path']
const VALID_TEXT_STREAMING = ['auto', 'sse', 'off']
const VALID_AUDIO_STREAMING = ['auto', 'sse', 'raw', 'off']
const VALID_WIRES = ['omni-duplex', 'vllm-asr', 'omni-turn', 'omni-speech-ws']
/** Catalog `adapter_models[].wire` names implemented by this adapter → the mode they require (TASK_CONTRACT §A). */
export const CATALOG_WIRE_MODES = Object.freeze({
  'openai-chat-audio': 'chat', 'omni-chat-s2s': 'chat', 'openai-transcriptions': 'transcribe', 'openai-translations': 'translate',
  'omni-speech-http': 'speech', 'omni-audio-generate': 'generate-audio', 'vllm-pooling-forced-align': 'align', 'omni-videos': 'generate-video',
  'omni-duplex': 'realtime', 'vllm-asr': 'realtime', 'omni-turn': 'realtime', 'omni-speech-ws': 'realtime',
})
const WIRE_DEFAULTS = Object.freeze({
  'omni-duplex': {},
  'vllm-asr': { query: {}, session: {} },
  'omni-turn': { query: {}, session: {} },
  'omni-speech-ws': { path: '/audio/speech/stream', query: {}, session: { response_format: 'pcm', stream_audio: true }, outputSampleRate: 24000 },
})

/** Harness home: `$DSH_HOME` (non-blank) or `~/.dsh`, mirroring dsh-home-paths. */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Shallow copy without undefined values or empty optional strings (settings forms produce both). */
function defined(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined && v !== ''))
}

function withoutNulls(value) {
  if (Array.isArray(value)) return value.filter(v => v !== null).map(withoutNulls)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]))
}

function fail(message) {
  throw new Error(`dsh-dgx-audio: ${message}`)
}

/**
 * Merge a Loader row / settings config over the defaults and validate it.
 * @param {any} raw
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function resolveConfig(raw = {}, options = {}) {
  const input = defined(raw)
  const config = { ...CONFIG_DEFAULTS, ...input }
  config.live = { ...CONFIG_DEFAULTS.live, ...input.live }
  config.sseLimits = { ...SSE_DEFAULT_LIMITS, ...input.sseLimits }
  config.hubLimits = { ...HUB_DEFAULT_LIMITS, ...input.hubLimits }
  if (!VALID_OUTPUT_LINK.includes(config.outputLink)) fail(`outputLink must be one of ${VALID_OUTPUT_LINK}`)
  if (!['link', 'fence'].includes(config.resultCarrier)) fail('resultCarrier must be "link" or "fence"')
  if (config.outputLink === 'web' && (typeof config.webBaseUrl !== 'string' || config.webBaseUrl === '')) fail('webBaseUrl is required when outputLink is "web"')
  config.outputDir = config.outputDir === undefined || config.outputDir === '' ? join(dshHome(options.env), 'dsh-dgx-audio', 'outputs') : String(config.outputDir)
  if (!isAbsolute(config.outputDir)) fail('outputDir must be an absolute path')
  if (config.invocationLog === undefined) config.invocationLog = join(config.outputDir, 'invocations.jsonl')
  if (config.capabilityFile === undefined) config.capabilityFile = join(config.outputDir, 'capabilities.json')
  for (const key of ['requestTimeoutMs', 'maxAudioBytes']) {
    if (!(Number.isFinite(config[key]) && config[key] > 0)) fail(`${key} must be a positive number`)
  }
  config.testFaults = resolveTestFaults(input.testFaults)
  if (config.testFaults === undefined) delete config.testFaults
  if (!Array.isArray(config.routes)) fail('routes must be an array')
  const providers = new Set()
  config.routes = config.routes.map((rawRoute) => {
    const route = defined(rawRoute)
    for (const key of ['provider', 'displayName', 'baseURL']) {
      if (typeof route?.[key] !== 'string' || route[key] === '') fail(`route.${key} is required`)
    }
    if (providers.has(route.provider)) fail(`duplicate provider route "${route.provider}"`)
    providers.add(route.provider)
    let url
    try { url = new URL(route.baseURL) } catch { fail(`route ${route.provider} baseURL is not a URL`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`route ${route.provider} baseURL must be http(s)`)
    if (route.apiKey !== undefined && typeof route.apiKey !== 'string') fail(`route ${route.provider} apiKey must be a string`)
    if (route.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(route.apiKeyEnv))) fail(`route ${route.provider} apiKeyEnv must be an environment variable name`)
    if (!Array.isArray(route.models) || route.models.length === 0) fail(`route ${route.provider} needs models`)
    const ids = new Set()
    return {
      ...route,
      models: route.models.map((rawModel) => {
        // JSON null on a top-level model field means "not assigned" (catalog adapter_models emit deploymentId: null).
        const model = Object.fromEntries(Object.entries(defined(rawModel)).filter(([, v]) => v !== null))
        const merged = {
          ...MODEL_DEFAULTS,
          ...model,
          streaming: { ...MODEL_DEFAULTS.streaming, ...model?.streaming },
          capabilities: { ...model?.capabilities },
        }
        if (typeof merged.id !== 'string' || merged.id === '') fail(`model id is required on ${route.provider}`)
        if (ids.has(merged.id)) fail(`duplicate model id "${merged.id}" on ${route.provider}`)
        ids.add(merged.id)
        if (model.requestOptions !== undefined) {
          // Catalog request_options copied verbatim; kept as strings, never interpreted by the adapter.
          if (!Array.isArray(model.requestOptions) || model.requestOptions.length > 400) fail(`${route.provider}/${merged.id} requestOptions must be an array (≤ 400 entries)`)
          merged.requestOptions = model.requestOptions.map(o => String(typeof o === 'string' ? o : JSON.stringify(o)).slice(0, 2000))
        }
        // 0.4.6: catalog per-variant option statuses, kept verbatim within the §K.11 bounds (never truncated or coerced).
        // Settings-form blanks (schemastery fills `[]` and `{row_sources: []}`) mean "not set"; a catalog empty map carries a scope.
        if (Array.isArray(model.requestOptionsMap) && model.requestOptionsMap.length === 0 && model.requestOptionsScope === undefined) delete merged.requestOptionsMap
        const evidence = model.requestOptionsEvidence
        if (evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) && Object.keys(evidence).every(k => k === 'row_sources') && !(evidence.row_sources?.length > 0)) delete merged.requestOptionsEvidence
        // Nested nulls are removed as library 0.1.3 withoutNulls does, so host(entry) equals host(library(entry)).
        for (const field of ['requestOptionsMap', 'requestOptionsEvidence']) if (merged[field] !== undefined) merged[field] = withoutNulls(merged[field])
        // An invalid field is dropped whole (absent = unknown, as library 0.1.3 does) and reported on optionControls.inputErrors.
        const optionErrors = requestOptionsFieldErrors(merged)
        for (const { field } of optionErrors) delete merged[field]
        if (optionErrors.length > 0) merged.requestOptionsInputErrors = optionErrors
        if (model.wire !== undefined) {
          // Catalog adapter_models carry a top-level `wire`; for realtime models it selects realtime.wire.
          const expected = CATALOG_WIRE_MODES[model.wire]
          if (expected === undefined) fail(`${route.provider}/${merged.id} wire "${model.wire}" is not implemented by this adapter (implemented: ${Object.keys(CATALOG_WIRE_MODES).join(', ')})`)
          if (merged.mode !== expected) fail(`${route.provider}/${merged.id} wire "${model.wire}" needs mode "${expected}", not "${merged.mode}"`)
          if (expected === 'realtime' && model.realtime?.wire !== undefined && model.realtime.wire !== model.wire) fail(`${route.provider}/${merged.id} wire "${model.wire}" conflicts with realtime.wire "${model.realtime.wire}"`)
        }
        for (const [key, allowed] of Object.entries(VALID)) {
          if (key in merged && !allowed.includes(merged[key])) fail(`${route.provider}/${merged.id} ${key} must be one of ${allowed}`)
        }
        if (!VALID_TEXT_STREAMING.includes(merged.streaming.text)) fail(`${route.provider}/${merged.id} streaming.text must be one of ${VALID_TEXT_STREAMING}`)
        if (merged.deploymentId !== undefined && (typeof merged.deploymentId !== 'string' || !/^[A-Za-z0-9._:@-]{1,200}$/.test(merged.deploymentId))) fail(`${route.provider}/${merged.id} deploymentId must match [A-Za-z0-9._:@-]{1,200}`)
        if (merged.generate?.kind !== undefined && !['music', 'sound'].includes(merged.generate.kind)) fail(`${route.provider}/${merged.id} generate.kind must be music or sound`)
        if (merged.streaming.audio !== undefined && !VALID_AUDIO_STREAMING.includes(merged.streaming.audio)) fail(`${route.provider}/${merged.id} streaming.audio must be one of ${VALID_AUDIO_STREAMING}`)
        if (merged.speech?.responseFormat === 'pcm' && !(merged.speech.pcmSampleRate > 0)) fail(`${route.provider}/${merged.id} speech.pcmSampleRate is required with responseFormat pcm`)
        if (merged.mode === 'align') {
          // Qwen3-ForcedAligner on vLLM /pooling (STEP pooling): logits per <timestamp> token; ms = argmax × segment time.
          const seg = merged.align?.timestampSegmentTime
          if (!(typeof seg === 'number' && seg > 0)) fail(`${route.provider}/${merged.id} align.timestampSegmentTime (ms per bin, from the checkpoint config.json) is required`)
          if (merged.align.wordSplit !== undefined && !['auto', 'whitespace', 'char'].includes(merged.align.wordSplit)) fail(`${route.provider}/${merged.id} align.wordSplit must be auto, whitespace or char`)
          if (merged.align.poolingPath !== undefined && !/^\/[A-Za-z0-9/_-]{1,200}$/.test(String(merged.align.poolingPath))) fail(`${route.provider}/${merged.id} align.poolingPath must be an absolute URL path`)
        }
        if (merged.mode === 'generate-video') {
          // Accepts the catalog adapter_models video object: { endpoint: "/v1/videos", sync: "/v1/videos/sync" | boolean,
          // generateSound: boolean | "unknown", imageReference/audioReference: "attachment" | null } (+ params_required).
          const v = merged.video ?? {}
          const path = x => typeof x === 'string' && /^\/[A-Za-z0-9/_.-]{1,200}$/.test(x)
          if (v.sync !== undefined && typeof v.sync !== 'boolean' && !path(v.sync)) fail(`${route.provider}/${merged.id} video.sync must be a boolean or an absolute path`)
          if (v.endpoint !== undefined && !path(v.endpoint)) fail(`${route.provider}/${merged.id} video.endpoint must be an absolute path`)
          if (v.async !== undefined && typeof v.async !== 'boolean') fail(`${route.provider}/${merged.id} video.async must be a boolean`)
          if (v.generateSound !== undefined && typeof v.generateSound !== 'boolean' && v.generateSound !== 'unknown') fail(`${route.provider}/${merged.id} video.generateSound must be true, false or "unknown"`)
          for (const key of ['imageReference', 'audioReference']) if (v[key] !== undefined && v[key] !== null && v[key] !== 'attachment') fail(`${route.provider}/${merged.id} video.${key} must be "attachment" or null`)
          for (const key of ['pollMs', 'maxSeconds']) if (v[key] !== undefined && !(Number.isInteger(v[key]) && v[key] > 0)) fail(`${route.provider}/${merged.id} video.${key} must be a positive integer`)
          const required = model.paramsRequired ?? model.params_required
          if (required !== undefined && !(Array.isArray(required) && required.every(k => typeof k === 'string'))) fail(`${route.provider}/${merged.id} params_required must be a list of names`)
          if (required !== undefined) merged.paramsRequired = required
        }
        if (merged.mode !== 'realtime') delete merged.realtime
        if (merged.mode === 'realtime') {
          const wire = model.realtime?.wire ?? (CATALOG_WIRE_MODES[model.wire] === 'realtime' ? model.wire : undefined) ?? 'omni-duplex'
          if (!VALID_WIRES.includes(wire)) fail(`${route.provider}/${merged.id} realtime.wire must be one of ${VALID_WIRES}`)
          const wireDefaults = WIRE_DEFAULTS[wire]
          merged.realtime = {
            ...REALTIME_DEFAULTS,
            ...wireDefaults,
            ...defined(model.realtime),
            wire,
            query: { ...(wireDefaults.query ?? REALTIME_DEFAULTS.query), ...model.realtime?.query },
            session: { ...(wireDefaults.session ?? REALTIME_DEFAULTS.session), ...model.realtime?.session },
          }
          if (!['pcm16', 'pcm_f32le'].includes(merged.realtime.inputEncoding ?? 'pcm16')) fail(`${route.provider}/${merged.id} realtime.inputEncoding must be pcm16 or pcm_f32le`)
          merged.realtime.outputSampleRateExplicit = Number.isInteger(model.realtime?.outputSampleRate)
          merged.realtime.inputEncoding ??= 'pcm16'
          merged.realtime.frameMs ??= 200
          if (merged.realtime.refAudioFile !== undefined && !isAbsolute(String(merged.realtime.refAudioFile))) {
            fail(`${route.provider}/${merged.id} realtime.refAudioFile must be an absolute path`)
          }
        }
        return merged
      }),
    }
  })
  return config
}

/** Accepted `testFaults.transportDrop` values (TASK_CONTRACT §K.12; test configuration only, absent by default). */
export const TRANSPORT_DROP_DEFAULTS = Object.freeze({ occurrence: 1, trigger: 'after-ready', afterMs: 1000, closeCode: 4000, resume: 'normal' })

/**
 * Test-only fault injection (§K.12). Absent or `{}` = off (the product default). Only settings.yaml / row config can set it;
 * the Settings form does not show it and no route can change it. Unknown keys or values refuse the configuration.
 */
function resolveTestFaults(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('testFaults must be an object (test configuration only)')
  const extra = Object.keys(value).find(k => k !== 'transportDrop')
  if (extra !== undefined) fail(`testFaults.${extra} is not a supported test fault (supported: transportDrop)`)
  const drop = value.transportDrop
  if (drop === undefined) return undefined
  if (drop === null || typeof drop !== 'object' || Array.isArray(drop)) fail('testFaults.transportDrop must be an object')
  const allowed = ['model', 'occurrence', 'trigger', 'afterMs', 'closeCode', 'resume', 'resumeDelayMs']
  const unknown = Object.keys(drop).find(k => !allowed.includes(k))
  if (unknown !== undefined) fail(`testFaults.transportDrop.${unknown} is not supported (supported: ${allowed.join(', ')})`)
  const spec = { ...TRANSPORT_DROP_DEFAULTS, ...drop }
  const int = (key, min, max) => { if (!(Number.isInteger(spec[key]) && spec[key] >= min && spec[key] <= max)) fail(`testFaults.transportDrop.${key} must be an integer in [${min}, ${max}]`) }
  if (spec.model !== undefined && (typeof spec.model !== 'string' || spec.model === '')) fail('testFaults.transportDrop.model must be a model id')
  int('occurrence', 1, 1000)
  if (!['after-ready', 'after-first-audio'].includes(spec.trigger)) fail('testFaults.transportDrop.trigger must be after-ready or after-first-audio')
  int('afterMs', 0, 600000)
  int('closeCode', 4000, 4999)
  if (!['normal', 'invalid-token', 'delay'].includes(spec.resume)) fail('testFaults.transportDrop.resume must be normal, invalid-token or delay')
  if (spec.resume === 'delay') { spec.resumeDelayMs ??= 35000; int('resumeDelayMs', 0, 120000) } else if (spec.resumeDelayMs !== undefined) fail('testFaults.transportDrop.resumeDelayMs needs resume: delay')
  return Object.freeze({ transportDrop: Object.freeze(spec) })
}

/**
 * Credential for one route: an explicit row-config `apiKey`, else the environment variable
 * named by `apiKeyEnv` (settings store only the reference), else none (keyless server).
 */
export function routeApiKey(route, env = process.env) {
  if (typeof route.apiKey === 'string' && route.apiKey.trim() !== '') return route.apiKey.trim()
  if (typeof route.apiKeyEnv === 'string' && route.apiKeyEnv !== '') {
    const value = env[route.apiKeyEnv]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}
