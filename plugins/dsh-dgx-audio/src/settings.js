// Optional Harness user-settings section (`dsh-dgx-audio` namespace in $DSH_HOME settings).
//
// Settings let a recipient configure servers/models from the app without editing profile
// YAML or absolute paths. The section schema needs schemastery, which the Harness host graph
// already provides; the plugin declares no dependency on it (offline-installable package), so
// it is resolved at runtime and the plugin falls back to row config when unavailable.

export const SETTINGS_NS = 'dsh-dgx-audio'

/** @returns {Promise<any | undefined>} the schemastery factory, or undefined */
export async function loadSchemastery(importer = specifier => import(specifier)) {
  try {
    const mod = await importer('@deepseek-ai/schemastery')
    const z = mod?.default ?? mod
    return typeof z?.object === 'function' ? z : undefined
  } catch {
    return undefined
  }
}

/** User-facing configuration surface; site paths/limits stay in row config. */
export function settingsSchema(z) {
  const model = z.object({
    id: z.string().required().description('Model id shown in Harness'),
    name: z.string().description('Display name'),
    upstreamModel: z.string().description('Model id the server expects (defaults to id)'),
    mode: z.union(['chat', 'transcribe', 'translate', 'speech', 'generate-audio', 'realtime', 'align', 'generate-video']).default('chat'),
    catalogId: z.string().description('Catalog row id (informational)'),
    catalogTasks: z.array(z.string()).description('Catalog task ids served by this entry'),
    deploymentId: z.string().description('Runtime deployment identity (recipe/image); part of the capability evidence key'),
    tasks: z.array(z.string()),
    speech: z.dict(z.any()).description('speech mode: voice, taskType, language, instructions, responseFormat, pcmSampleRate, refAudio, refText, maxNewTokens'),
    asr: z.dict(z.any()).description('transcribe/translate: responseFormat, timestampGranularities, language, toLanguage, prompt'),
    video: z.dict(z.any()).description('generate-video (vLLM-Omni /v1/videos): sync (default true), pollMs, maxSeconds, and default form params (seconds, size, generateSound, soundDuration, …)'),
    align: z.dict(z.any()).description('align (vLLM /pooling forced aligner): timestampSegmentTime (ms per bin, required), wordSplit auto|whitespace|char, poolingPath'),
    generate: z.dict(z.any()).description('generate-audio: audioLength, negativePrompt, guidanceScale, numInferenceSteps, seed, responseFormat'),
    outputAudio: z.boolean().default(false).description('Request spoken replies'),
    sendModalities: z.boolean().default(false).description('Send vLLM-Omni `modalities` (required by vLLM-Omni)'),
    audioFormat: z.string().description('Requested reply audio format (server default: wav)'),
    systemPrompt: z.string(),
    systemPromptWithAudio: z.union(['auto', 'system', 'user-prefix']).default('auto').description('auto: verified model rule or remembered server rejection folds the system prompt into the user turn; explicit system/user-prefix always wins'),
    wire: z.string().description('Catalog wire name (adapter_models[].wire); selects realtime.wire for realtime models'),
    requestOptions: z.array(z.string()).description('Catalog request_options for this deployment, verbatim (published on the capability entry; not interpreted)'),
    requestOptionsMap: z.array(z.object({ option: z.string(), status: z.string(), raw: z.string(), detail: z.string() })).description('Catalog per-variant option statuses [{option, status, raw, detail?}], verbatim; drives optionControls (TASK_CONTRACT §K.11)'),
    requestOptionsScope: z.string().description('Catalog scope sentence for requestOptions/requestOptionsMap, verbatim'),
    requestOptionsEvidence: z.object({ source: z.string(), row_sources: z.array(z.string()) }).description('Catalog census sources for requestOptions, verbatim'),
    language: z.string(),
    contextWindow: z.natural().default(16384),
    maxTokens: z.natural(),
    temperature: z.number(),
    maxAudioPerRequest: z.natural().default(5),
    streaming: z.object({ text: z.union(['auto', 'sse', 'off']).default('auto'), audio: z.union(['auto', 'sse', 'raw', 'off']) }),
    capabilities: z.dict(z.boolean()).description('Declared (not verified) capabilities'),
    extraBody: z.dict(z.any()).description('Extra JSON fields for chat requests, e.g. chat_template_kwargs'),
    realtime: z.object({
      wire: z.union(['omni-duplex', 'vllm-asr', 'omni-turn', 'omni-speech-ws']),
      inputEncoding: z.union(['pcm16', 'pcm_f32le']),
      frameMs: z.natural(),
      path: z.string(),
      query: z.dict(z.string()),
      session: z.dict(z.any()),
      inputSampleRate: z.natural(),
      outputSampleRate: z.natural(),
      refAudioFile: z.string().description('Absolute path of a voice prompt WAV (MiniCPM-o speech output)'),
      sessionIdPrefix: z.string(),
    }),
  })
  const route = z.object({
    provider: z.string().required().description('Provider route key'),
    displayName: z.string().required(),
    baseURL: z.string().required().description('OpenAI-compatible base URL, e.g. http://host:port/v1'),
    apiKeyEnv: z.string().role('credential-ref').description('Environment variable holding the API key; leave empty for keyless servers'),
    models: z.array(model),
  })
  return z.object({
    routes: z.array(route).default([]),
    outputLink: z.union(['api', 'web', 'path']).default('api'),
    requestTimeoutMs: z.natural().default(900000),
    annotate: z.boolean().default(true),
    resultCarrier: z.union(['link', 'fence']).default('link').description('link: footer link line + GET result?id= (durable); fence: legacy dsh-audio-result block'),
  })
}

/** Drop settings keys the schema resolved to undefined so row config keeps its values. */
export function definedEntries(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined))
}
