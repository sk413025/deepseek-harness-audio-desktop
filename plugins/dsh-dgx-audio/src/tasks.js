// Non-chat audio task wires (TASK_CONTRACT.md v0.2 §A/§B): vLLM-Omni /v1/audio/speech and /v1/audio/generate,
// vLLM /v1/audio/transcriptions|translations response formats, and local answers for auxiliary calls.
//
// Wire facts (pinned sources): speech SSE = `event: speech.audio.delta` {audio base64, response_format} …
// `speech.audio.done` {usage} | `speech.audio.error` {error}; stream_format=audio = raw chunked bytes; streaming
// requires response_format wav|pcm; a wav stream is one streaming header (0xFFFFFFFF sizes) then bare PCM, and pcm
// carries no rate (vLLM-Omni serving_speech.py:127-160, 2183-2433 @eb11446b). Audio generate defaults to
// stream_format=audio (protocol/audio.py:345-393). Transcription SSE chunks are object `transcription.chunk`
// (translation: `translation.chunk`) with choices[].delta.content and [DONE] (vLLM speech_to_text @2cf0a691).

import { LlmError } from './compat.js'
import { mimeOf, parseFileHandle, audioFormatOf } from './audio.js'
import { PcmStreamFramer } from './pcm.js'
import { readSse } from './sse.js'

/** Task-parameter schema per mode: what the UI may set through session-params (TASK_CONTRACT §D). */
export const TASK_PARAMS = Object.freeze({
  // Speech fields of vLLM-Omni OpenAICreateSpeechRequest (protocol/audio.py @5f25d986; same names in eb11446b/aff7d649,
  // sample_rate rc1+). Which model honors which field is catalog `request_options` data, not decided here.
  speech: {
    voice: 'string', instructions: 'string', language: 'string', taskType: ['CustomVoice', 'VoiceDesign', 'Base'],
    responseFormat: ['wav', 'pcm'], maxNewTokens: 'integer', refText: 'string',
    speed: { type: 'number', min: 0.25, max: 4 }, seed: 'integer', sampleRate: { type: 'integer', min: 1 },
    wordTimestamps: 'boolean', xVectorOnlyMode: 'boolean', nonStreamingMode: 'boolean', initialCodecChunkFrames: { type: 'integer', min: 0 },
    ambientSound: 'string', durationSeconds: { type: 'number', min: 0 }, extraParams: 'object',
  },
  'generate-audio': {
    audioLength: 'number', negativePrompt: 'string', guidanceScale: 'number', numInferenceSteps: 'integer', seed: 'integer',
  },
  transcribe: { language: 'string', prompt: 'string', responseFormat: ['json', 'text', 'verbose_json', 'srt', 'vtt', 'diarized_json'], timestampGranularities: 'string[]' },
  translate: { language: 'string', prompt: 'string', toLanguage: 'string', responseFormat: ['json', 'text', 'verbose_json', 'srt', 'vtt'] },
  chat: {},
  align: { wordSplit: ['auto', 'whitespace', 'char'] },
  // vLLM-Omni `_parse_video_form` (same fields eb11446b/aff7d649/5f25d986; `fps` int on eb11446b, float later).
  'generate-video': {
    seconds: { type: 'integer', min: 1 }, size: 'string', width: { type: 'integer', min: 1 }, height: { type: 'integer', min: 1 }, numFrames: { type: 'integer', min: 1 },
    fps: { type: 'number', min: 1 }, aspectRatio: 'string', quality: 'string', negativePrompt: 'string', numInferenceSteps: { type: 'integer', min: 1 },
    guidanceScale: 'number', guidanceScale2: 'number', flowShift: 'number', trueCfgScale: 'number', seed: 'integer',
    generateSound: 'boolean', soundDuration: { type: 'number', min: 0.001 }, extraParams: 'object',
  },
  realtime: { voice: 'string', instructions: 'string', overlapPolicy: ['listen_only', 'barge_in_on_speech'], turnDetection: ['none', 'server_vad'] },
})

/**
 * vLLM-Omni /v1/audio/speech/stream `session.config` (StreamingSpeechSessionConfig, protocol/audio.py): same names on
 * eb11446b/aff7d649/5f25d986 except `seed` and `split_granularity` (rc1+). The session has no extra_params, ref_audio_2
 * or ambient_sound (catalog review §2.6). A config is sticky and may be replaced only between utterances.
 */
export const SPEECH_WS_PARAMS = Object.freeze({
  voice: 'string', instructions: 'string', language: 'string', taskType: ['CustomVoice', 'VoiceDesign', 'Base'],
  maxNewTokens: { type: 'integer', min: 1 }, speed: { type: 'number', min: 0.25, max: 4 }, seed: 'integer',
  initialCodecChunkFrames: { type: 'integer', min: 0 }, nonStreamingMode: 'boolean', refText: 'string', xVectorOnlyMode: 'boolean',
  wordTimestamps: 'boolean', splitGranularity: ['none', 'sentence', 'clause'],
})

/** UI param key → speech WS session.config field. */
export const SPEECH_WS_FIELDS = Object.freeze({
  voice: 'voice', instructions: 'instructions', language: 'language', taskType: 'task_type', maxNewTokens: 'max_new_tokens', speed: 'speed',
  seed: 'seed', initialCodecChunkFrames: 'initial_codec_chunk_frames', nonStreamingMode: 'non_streaming_mode', refText: 'ref_text',
  xVectorOnlyMode: 'x_vector_only_mode', wordTimestamps: 'word_timestamps', splitGranularity: 'split_granularity',
})

/** Parameter schema for one model entry (mode, and wire for realtime). */
export function paramSchemaOf(model) {
  if (model?.mode === 'realtime' && model.realtime?.wire === 'omni-speech-ws') return SPEECH_WS_PARAMS
  return TASK_PARAMS[model?.mode] ?? {}
}

/**
 * Validate UI-supplied task parameters for a model's mode; throws BAD_REQUEST-style errors.
 * @returns {Record<string, unknown>} the accepted params
 */
export function validateTaskParams(mode, params) {
  // `mode` may be a model entry, so wire-specific schemas (speech stream-input) apply.
  const schema = typeof mode === 'object' && mode !== null ? paramSchemaOf(mode) : TASK_PARAMS[mode] ?? {}
  const label = typeof mode === 'object' && mode !== null ? (mode.mode === 'realtime' ? `${mode.realtime?.wire ?? 'omni-duplex'} realtime` : mode.mode) : mode
  const accepted = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    const rule = schema[key]
    if (rule === undefined) throw Object.assign(new Error(`parameter "${key}" is not supported for ${label} models`), { code: 'BAD_REQUEST', reason: 'UNKNOWN_PARAM', key })
    if (value === null) continue
    const type = typeof rule === 'object' && !Array.isArray(rule) ? rule.type : rule
    const inRange = v => (rule.min === undefined || v >= rule.min) && (rule.max === undefined || v <= rule.max)
    const ok = Array.isArray(rule) ? rule.includes(value)
      : type === 'string' ? typeof value === 'string' && value.length <= 4000
        : type === 'number' ? Number.isFinite(value) && inRange(value)
          : type === 'integer' ? Number.isInteger(value) && inRange(value)
            : type === 'boolean' ? typeof value === 'boolean'
              : type === 'string[]' ? Array.isArray(value) && value.every(v => typeof v === 'string')
                : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 16_000
                  : false
    if (!ok) throw Object.assign(new Error(`parameter "${key}" has an invalid value`), { code: 'BAD_REQUEST', reason: 'INVALID_PARAM', key })
    accepted[key] = value
  }
  return accepted
}

const MODEL_CHANGED_NOTICE = /^\[model changed: [^\n]*\]$/

/**
 * Harness context notices that are not the user's request: dsh-agent model-selection appends a user-role
 * `[model changed: …]` message (source { kind: 'plugin', form: 'notice' }) AFTER the prompt on the next request.
 */
export function isContextNotice(message) {
  if (message?.role !== 'user') return false
  if (message.source?.kind === 'plugin' && message.source?.form === 'notice') return true
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks.length > 0 && blocks.every(b => b.type === 'text' && MODEL_CHANGED_NOTICE.test(b.text.trim()))
}

/**
 * The pending user turn: every user message after the last assistant message, minus context notices,
 * as [index into options.messages, message] pairs (a task request never reads only the last user message).
 */
export function pendingUserMessages(messages) {
  const lastAssistant = messages.map(m => m.role).lastIndexOf('assistant')
  return messages.map((m, i) => [i, m]).filter(([i, m]) => i > lastAssistant && m.role === 'user' && !isContextNotice(m))
}

/** Text of the pending user turn, excluding file-handle blocks and dsh-audio-options blocks. */
export function pendingUserText(options) {
  return pendingUserMessages(options.messages)
    .flatMap(([, m]) => m.content)
    .filter(b => b.type === 'text' && parseFileHandle(b.text) === undefined)
    .map(b => b.text.replace(/```dsh-audio-options[^\n]*\n[\s\S]*?```/g, ''))
    .join('\n')
    .trim()
}

/** Newest audio attachment of the pending user turn, or the one with this name (verified and loaded by convertMessages). */
export function pendingUserAudio(converted, name) {
  const pending = converted.pendingAudio ?? []
  if (name === undefined) return pending.at(-1)
  const named = [...pending].reverse().find(a => a.name === name)
  if (named === undefined) throw new LlmError(`dsh-dgx-audio: attachment "${name}" is not part of this message`, 'INVALID_REQUEST')
  return named
}

/** Local answers for session-title/compaction on non-chat routes: no server call, no audio. */
export function * auxiliaryLocal(call, options) {
  const text = options.purpose === 'session-title'
    ? (pendingUserText(options).replace(/\s+/g, ' ').slice(0, 60) || `${call.model.mode} request`)
    : options.messages.map(m => m.content.filter(b => b.type === 'text' && parseFileHandle(b.text) === undefined).map(b => b.text).join(' ')).join('\n').slice(0, 4000)
  call.transport = 'local'
  call.endpoint = 'local:auxiliary'
  yield * call.delta('text', text)
}

/**
 * POST /v1/audio/speech with streaming per model/params and observed server behavior.
 * @param {import('./adapter.js').CallStateLike} call
 */
export async function * speechRequest(call, converted, signal) {
  const { route, model, upstreamModel, options } = call
  const params = { ...model.speech, ...call.taskParams }
  let input = pendingUserText(options)
  // model.speech.refText selects HOW ref_text is supplied ('prompt-prefix' | 'none'); only session params carry text.
  let refText = call.taskParams.refText
  if (model.speech?.refText === 'prompt-prefix' && refText === undefined) {
    const split = input.indexOf('\n\n')
    if (split > 0) { refText = input.slice(0, split).trim(); input = input.slice(split + 2).trim() }
  }
  // MOSS-SoundEffect takes the description in ambient_sound and allows an empty input (tts_adapters/moss_tts.py:330-335).
  if (input.length === 0 && !params.ambientSound) throw new LlmError(`dsh-dgx-audio: ${model.id} needs text to speak`, 'INVALID_REQUEST')
  const names = call.attachmentNames ?? {}
  const dataUrl = a => `data:${mimeOf(a.format)};base64,${a.data.toString('base64')}`
  const refs = model.speech?.refAudio === 'attachment'
    ? (Array.isArray(names.referenceAudio) ? names.referenceAudio.map(n => pendingUserAudio(converted, n)) : [pendingUserAudio(converted, names.referenceAudio)].filter(Boolean))
    : []
  const ref2 = names.referenceAudio2 !== undefined ? pendingUserAudio(converted, names.referenceAudio2) : undefined
  const emotion = names.emotionAudio !== undefined ? pendingUserAudio(converted, names.emotionAudio) : undefined
  const used = [...refs, ref2, emotion].filter(Boolean)
  call.record.inputAudio = call.record.inputAudio.filter(a => used.some(u => u.sha256 === a.sha256))
  const responseFormat = params.responseFormat ?? 'wav'
  // word_timestamps come back only on non-streaming responses (X-Word-Timestamps header; protocol/audio.py word_timestamps).
  let mode = params.wordTimestamps === true ? 'off' : streamingAudioMode(call, model.streaming?.audio ?? 'auto', 'sse')
  const endpoint = `${route.baseURL.replace(/\/+$/, '')}/audio/speech`
  const extraParams = { ...(params.extraParams ?? {}), ...(emotion ? { emo_audio: dataUrl(emotion) } : {}) }
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model: upstreamModel,
      input,
      response_format: responseFormat,
      ...(params.voice ? { voice: params.voice } : {}),
      ...(params.instructions ? { instructions: params.instructions } : {}),
      ...(params.language ? { language: params.language } : {}),
      ...(params.taskType ? { task_type: params.taskType } : {}),
      ...(params.maxNewTokens ? { max_new_tokens: params.maxNewTokens } : {}),
      ...(params.speed !== undefined ? { speed: params.speed } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.sampleRate !== undefined ? { sample_rate: params.sampleRate } : {}),
      ...(params.xVectorOnlyMode !== undefined ? { x_vector_only_mode: params.xVectorOnlyMode } : {}),
      ...(params.nonStreamingMode !== undefined ? { non_streaming_mode: params.nonStreamingMode } : {}),
      ...(params.initialCodecChunkFrames !== undefined ? { initial_codec_chunk_frames: params.initialCodecChunkFrames } : {}),
      ...(params.ambientSound ? { ambient_sound: params.ambientSound } : {}),
      ...(params.durationSeconds !== undefined ? { duration_seconds: params.durationSeconds } : {}),
      ...(params.wordTimestamps === true ? { word_timestamps: true } : {}),
      ...(Object.keys(extraParams).length > 0 ? { extra_params: extraParams } : {}),
      ...(refs.length === 1 && !Array.isArray(names.referenceAudio) ? { ref_audio: dataUrl(refs[0]) } : refs.length > 0 ? { ref_audio: refs.map(dataUrl) } : {}),
      ...(ref2 ? { ref_audio_2: dataUrl(ref2) } : {}),
      ...(refText ? { ref_text: refText } : {}),
      ...(mode === 'sse' ? { stream: true, stream_format: 'sse' } : mode === 'raw' ? { stream_format: 'audio' } : {}),
      ...(model.speech?.extraBody ?? {}),
    }
    const clip = a => ({ sha256: a.sha256, bytes: a.bytes, name: a.name })
    call.record.request = {
      endpoint,
      audioStream: mode,
      body: {
        ...body,
        input: `${input.slice(0, 160)}${input.length > 160 ? '…' : ''}`,
        ...(body.ref_audio ? { ref_audio: Array.isArray(body.ref_audio) ? refs.map(clip) : clip(refs[0]) } : {}),
        ...(body.ref_audio_2 ? { ref_audio_2: clip(ref2) } : {}),
        ...(body.extra_params?.emo_audio ? { extra_params: { ...body.extra_params, emo_audio: clip(emotion) } } : {}),
      },
    }
    call.taskParamsUsed = {
      voice: body.voice ?? null, instructions: body.instructions ?? null, language: body.language ?? null, taskType: body.task_type ?? null, responseFormat,
      refAudio: refs.length === 0 ? null : refs.length === 1 && !Array.isArray(names.referenceAudio) ? refs[0].sha256 : refs.map(r => r.sha256),
      refText: refText ? `${refText.slice(0, 60)}${refText.length > 60 ? '…' : ''}` : null,
      ...Object.fromEntries(['speed', 'seed', 'sampleRate', 'xVectorOnlyMode', 'nonStreamingMode', 'initialCodecChunkFrames', 'ambientSound', 'durationSeconds', 'wordTimestamps', 'extraParams'].filter(k => params[k] !== undefined).map(k => [k, params[k]])),
      ...(ref2 ? { refAudio2: ref2.sha256 } : {}),
      ...(emotion ? { emotionAudio: emotion.sha256 } : {}),
    }
    call.mark('requestSent')
    const response = await call.adapter.fetch(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { ...call.headers(), 'content-type': 'application/json' }, signal })
    call.mark('responseHeaders')
    const how = await acceptAudioResponse(call, response, endpoint, mode)
    if (how === 'retry-without-stream') { mode = 'off'; continue }
    if (params.wordTimestamps === true) call.wordTimestamps = readWordTimestamps(response)
    yield * consumeAudioResponse(call, response, how, { format: responseFormat, sampleRate: params.sampleRate ?? model.speech?.pcmSampleRate }, signal)
    const seconds = call.pendingDurationSeconds()
    const words = call.wordTimestamps
    const wordLine = words === undefined ? '' : words.state === 'aligned' ? ` · ${words.words.length} word timestamps` : ` · word timestamps ${words.state}`
    yield * call.delta('text', `Speech generated${params.voice ? ` · voice ${params.voice}` : ''}${params.taskType ? ` · ${params.taskType}` : ''}${seconds ? ` · ${seconds} s` : ''}${wordLine}.`)
    return
  }
}

/** X-Word-Timestamps: JSON list of {word, start_ms, end_ms}; X-Word-Timestamps-Omitted past 4 KB (serving_speech.py:2541). */
function readWordTimestamps(response) {
  const raw = response.headers.get('x-word-timestamps')
  if (raw === null) return { state: response.headers.get('x-word-timestamps-omitted') !== null ? 'omitted' : 'missing', words: [] }
  try {
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return { state: 'invalid', words: [] }
    return { state: 'aligned', words: list.map(w => ({ word: String(w.word ?? ''), startMs: Number(w.start_ms), endMs: Number(w.end_ms) })) }
  } catch {
    return { state: 'invalid', words: [] }
  }
}

const ALIGN_CHAT_TEMPLATE = "{{ messages[0]['content'] }}"
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u

/** Reference words for the aligner: whitespace words, or one unit per CJK character (auto picks per token). */
export function alignWords(text, mode = 'auto') {
  // Letters, digits and in-word apostrophes survive; other punctuation/symbols separate words.
  const cleaned = text.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}\s'’]+/gu, ' ')
  if (mode === 'char') return [...cleaned].filter(ch => /[\p{L}\p{N}]/u.test(ch))
  const words = []
  for (const token of cleaned.split(/\s+/u).map(t => t.replace(/^['’]+|['’]+$/gu, '')).filter(Boolean)) {
    if (mode === 'auto' && CJK.test(token)) {
      // Keep Latin/digit runs inside a CJK token together; split the CJK characters.
      for (const part of token.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) words.push(part)
    } else {
      words.push(token)
    }
  }
  return words
}

/**
 * POST /pooling (vLLM `--runner pooling --convert classify`, STEP pooling on <timestamp>): Qwen3-ForcedAligner word
 * timestamps for an audio attachment and its reference transcript (vllm-main examples/pooling/token_classify/
 * forced_alignment_online.py). Response `data[0].data` = one logits row per <timestamp> token; ms = argmax × segment time.
 */
export async function * alignRequest(call, converted, signal) {
  const { route, model, upstreamModel, options } = call
  const audio = pendingUserAudio(converted)
  if (audio === undefined) throw new LlmError(`dsh-dgx-audio: ${model.id} aligns an audio attachment with its transcript — attach the audio and type the transcript`, 'NO_AUDIO_INPUT')
  const transcript = pendingUserText(options)
  const words = alignWords(transcript, call.taskParams.wordSplit ?? model.align.wordSplit ?? 'auto')
  if (words.length === 0) throw new LlmError(`dsh-dgx-audio: ${model.id} needs the reference transcript as text in the same message`, 'INVALID_REQUEST')
  call.record.inputAudio = call.record.inputAudio.filter(a => a.sha256 === audio.sha256).slice(-1)
  const prompt = `<|audio_start|><|audio_pad|><|audio_end|>${words.join('<timestamp><timestamp>')}<timestamp><timestamp>`
  const body = {
    model: upstreamModel,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'audio_url', audio_url: { url: `data:${mimeOf(audio.format)};base64,${audio.data.toString('base64')}` } }] }],
    task: 'token_classify',
    chat_template: ALIGN_CHAT_TEMPLATE,
  }
  // vLLM serves /pooling at the server root, not under /v1.
  const root = route.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')
  const endpoint = `${root}${model.align.poolingPath ?? '/pooling'}`
  call.endpoint = endpoint
  call.record.request = { endpoint, words: words.length, promptChars: prompt.length, audio: { sha256: audio.sha256, bytes: audio.bytes } }
  call.taskParamsUsed = { wordSplit: call.taskParams.wordSplit ?? model.align.wordSplit ?? 'auto', timestampSegmentTime: model.align.timestampSegmentTime }
  call.mark('requestSent')
  const response = await call.adapter.fetch(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { ...call.headers(), 'content-type': 'application/json' }, signal })
  call.mark('responseHeaders')
  call.status = response.status
  call.transport = 'json'
  const raw = await response.text()
  if (!response.ok) {
    const code = response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
    throw new LlmError(`dsh-dgx-audio: ${endpoint} returned HTTP ${response.status}: ${raw.slice(0, 600)}`, code, { status: response.status })
  }
  let rows
  try { rows = JSON.parse(raw).data?.[0]?.data } catch { rows = undefined }
  if (!Array.isArray(rows) || !rows.every(r => Array.isArray(r) && r.length > 0)) throw new LlmError(`dsh-dgx-audio: ${endpoint} did not return token logits (data[0].data)`, 'SERVER')
  if (rows.length !== words.length * 2) {
    throw new LlmError(`dsh-dgx-audio: expected ${words.length * 2} timestamp predictions, received ${rows.length}; start the server with STEP pooling on the checkpoint's timestamp token (--pooler-config {"tok_pooling_type":"STEP","step_tag_id":<timestamp_token_id>,"use_activation":false})`, 'SERVER')
  }
  const seg = model.align.timestampSegmentTime
  const argmax = row => row.reduce((best, v, i) => (v > row[best] ? i : best), 0)
  const aligned = words.map((word, i) => ({ word, startMs: Math.round(argmax(rows[2 * i]) * seg), endMs: Math.round(argmax(rows[2 * i + 1]) * seg) }))
  call.wordTimestamps = { state: 'aligned', words: aligned }
  const fmt = ms => (ms / 1000).toFixed(3)
  yield * call.delta('text', aligned.map(w => `- [${fmt(w.startMs)}–${fmt(w.endMs)}] ${w.word}`).join('\n'))
}

/** POST /v1/audio/generate (text → music/sound). */
export async function * generateAudioRequest(call, converted, signal) {
  const { route, model, upstreamModel, options } = call
  const params = { ...model.generate, ...call.taskParams }
  const input = pendingUserText(options)
  if (input.length === 0) throw new LlmError(`dsh-dgx-audio: ${model.id} needs a text prompt`, 'INVALID_REQUEST')
  call.record.inputAudio = []
  const responseFormat = params.responseFormat ?? 'wav'
  let mode = streamingAudioMode(call, model.streaming?.audio ?? 'auto', 'raw')
  if (mode === 'sse') mode = 'raw' // runtime rejects sse for audio generate
  const endpoint = `${route.baseURL.replace(/\/+$/, '')}/audio/generate`
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model: upstreamModel,
      input,
      response_format: responseFormat,
      stream_format: mode === 'raw' ? 'audio' : null,
      ...(params.audioLength !== undefined ? { audio_length: params.audioLength } : {}),
      ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
      ...(params.guidanceScale !== undefined ? { guidance_scale: params.guidanceScale } : {}),
      ...(params.numInferenceSteps !== undefined ? { num_inference_steps: params.numInferenceSteps } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
    }
    call.record.request = { endpoint, audioStream: mode, body }
    call.taskParamsUsed = { audioLength: body.audio_length ?? null, negativePrompt: body.negative_prompt ?? null, guidanceScale: body.guidance_scale ?? null, numInferenceSteps: body.num_inference_steps ?? null, seed: body.seed ?? null, responseFormat }
    call.mark('requestSent')
    const response = await call.adapter.fetch(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { ...call.headers(), 'content-type': 'application/json' }, signal })
    call.mark('responseHeaders')
    const how = await acceptAudioResponse(call, response, endpoint, mode)
    if (how === 'retry-without-stream') { mode = 'off'; continue }
    yield * consumeAudioResponse(call, response, how, { format: responseFormat, sampleRate: model.generate?.pcmSampleRate }, signal)
    const seconds = call.pendingDurationSeconds()
    yield * call.delta('text', `Audio generated${seconds ? ` · ${seconds} s` : ''}.`)
    return
  }
}

function streamingAudioMode(call, configured, preferred) {
  if (configured === 'off') return 'off'
  const seen = call.capabilities?.evidenceFor(call.route, call.model, 'audioOutputStreaming')
  if (configured === 'auto' && seen?.state === 'unsupported' && seen.source === 'request') return 'off'
  return configured === 'auto' ? preferred : configured
}

async function acceptAudioResponse(call, response, endpoint, mode) {
  call.endpoint = endpoint
  call.status = response.status
  const type = String(response.headers.get('content-type') ?? '').toLowerCase()
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    const refused = mode !== 'off' && (response.status === 400 || response.status === 422) && /stream/i.test(raw)
    if (refused && (call.model.streaming?.audio ?? 'auto') === 'auto') {
      call.capabilities?.observe(call.route, call.model, 'audioOutputStreaming', { state: 'unsupported', source: 'request', detail: `HTTP ${response.status}: ${raw.slice(0, 160)}` })
      call.retriedWithoutStream = true
      return 'retry-without-stream'
    }
    const code = response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
    throw new LlmError(`dsh-dgx-audio: ${endpoint} returned HTTP ${response.status}: ${raw.slice(0, 800)}`, code, { status: response.status })
  }
  if (type.includes('text/event-stream')) return 'sse'
  if (type.includes('application/json')) {
    const raw = await response.text().catch(() => '')
    throw new LlmError(`dsh-dgx-audio: ${endpoint} answered JSON instead of audio: ${raw.slice(0, 300)}`, 'SERVER', { status: response.status })
  }
  return mode === 'raw' ? 'raw' : 'binary'
}

async function * consumeAudioResponse(call, response, how, hint, signal) {
  call.transport = how === 'sse' ? 'sse' : how === 'raw' ? 'raw-audio' : 'binary'
  const framer = new PcmStreamFramer(hint)
  const feed = async (bytes) => {
    call.timeline.audioNetworkChunks = (call.timeline.audioNetworkChunks ?? 0) + 1
    const frame = framer.push(bytes)
    if (frame !== undefined) await call.acceptPcm(frame.pcm, frame.format)
  }
  if (how === 'sse') {
    let done = false
    for await (const event of readSse(response.body, { signal, limits: call.config.sseLimits, onBytes: (n) => { call.timeline.bytesIn += n } })) {
      call.timeline.sseEvents += 1
      let data
      try { data = JSON.parse(event.data) } catch (error) { throw new LlmError(`malformed speech SSE payload: ${event.data.slice(0, 120)}`, 'MALFORMED_STREAM', { cause: error }) }
      const type = data.type ?? event.event
      if (type === 'speech.audio.delta') {
        if (typeof data.audio === 'string' && data.audio.length > 0) await feed(Buffer.from(data.audio, 'base64'))
      } else if (type === 'speech.audio.done') {
        call.usage = data.usage ? { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens, total_tokens: data.usage.total_tokens } : undefined
        done = true
        call.mark('done')
        break
      } else if (type === 'speech.audio.error') {
        const status = Number(data.error?.code)
        throw new LlmError(`backend speech error: ${String(data.error?.message ?? 'unknown').slice(0, 400)}`, status >= 400 && status < 500 ? 'INVALID_REQUEST' : 'SERVER', Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {})
      }
    }
    if (!done) throw new LlmError('speech SSE ended without speech.audio.done', 'STREAM_CLOSED')
  } else if (how === 'raw') {
    const reader = response.body.getReader()
    let finished = false
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        const { done, value } = await reader.read()
        if (done) break
        call.timeline.bytesIn += value.byteLength
        await feed(value)
      }
      finished = true
    } finally {
      if (!finished) await reader.cancel().catch(() => {})
      reader.releaseLock?.()
    }
    call.mark('done')
  } else {
    const bytes = Buffer.from(await response.arrayBuffer())
    call.timeline.bytesIn += bytes.byteLength
    call.mark('done')
    await feed(bytes)
  }
  if (framer.leftoverBytes > 0) {
    call.audioErrors ??= []
    call.audioErrors.push(`${framer.leftoverBytes} trailing bytes did not form a whole sample`)
  }
  if (framer.format === undefined) throw new LlmError(`dsh-dgx-audio: ${call.endpoint} returned no decodable audio`, 'SERVER')
}

/** Render a transcription/translation response body by response_format. */
export function renderAsrBody(responseFormat, raw) {
  if (responseFormat === 'text' || responseFormat === 'srt' || responseFormat === 'vtt') {
    return { text: responseFormat === 'text' ? raw.trim() : `\`\`\`${responseFormat}\n${raw.trim()}\n\`\`\``, usage: undefined }
  }
  let json
  try { json = JSON.parse(raw) } catch (error) { throw new LlmError(`transcription returned non-JSON for ${responseFormat}: ${raw.slice(0, 200)}`, 'SERVER', { cause: error }) }
  const text = String(json.text ?? '')
  if (responseFormat === 'verbose_json' && Array.isArray(json.segments) && json.segments.length > 0) {
    const lines = json.segments.map(s => `- [${fmtTime(s.start)}–${fmtTime(s.end)}] ${String(s.text ?? '').trim()}`)
    return { text: `${text}\n\n${lines.join('\n')}`, usage: json.usage, language: json.language, segments: json.segments.map(s => ({ start: s.start, end: s.end, text: String(s.text ?? '').trim() })) }
  }
  if (responseFormat === 'diarized_json' && Array.isArray(json.segments) && json.segments.length > 0) {
    const lines = json.segments.map(s => `- ${s.speaker ?? 'speaker'} [${fmtTime(s.start)}–${fmtTime(s.end)}]: ${String(s.text ?? '').trim()}`)
    return { text: lines.join('\n'), usage: json.usage, segments: json.segments.map(s => ({ start: s.start, end: s.end, text: String(s.text ?? '').trim(), speaker: s.speaker ?? null })) }
  }
  return { text, usage: json.usage }
}

function fmtTime(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s)) return '?'
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

export { audioFormatOf }
