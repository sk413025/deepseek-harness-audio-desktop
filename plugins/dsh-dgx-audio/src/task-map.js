// Single source for task naming across lanes (TASK_CONTRACT.md v0.2 §F): adapter task ids, the mic/UI task list
// (TASK_UI_CONTRACT_PROPOSAL.md) and catalog task ids (audio-catalog.schema.json 1.0.0) are all derived here from the
// model config, so no consumer infers capabilities from model names.

import { paramSchemaOf } from './tasks.js'
import { ioPresenceOf, optionControlsOf } from './option-controls.js'

export const ADAPTER_MODES = Object.freeze(['chat', 'transcribe', 'translate', 'speech', 'generate-audio', 'realtime', 'align', 'generate-video'])
export const REALTIME_WIRES = Object.freeze(['omni-duplex', 'vllm-asr', 'omni-turn', 'omni-speech-ws'])

/** Adapter task id (TASK_CONTRACT §A). */
export function taskOf(model) {
  switch (model.mode) {
    case 'chat': return model.outputAudio ? 'speech.s2s' : 'audio.understand'
    case 'transcribe': return 'asr.transcribe'
    case 'translate': return 'asr.translate'
    case 'speech': return 'tts.speech'
    case 'generate-audio': return 'audio.generate'
    case 'align': return 'asr.align'
    case 'generate-video': return 'video.generate'
    case 'realtime': return { 'vllm-asr': 'asr.realtime', 'omni-turn': 'speech.s2s.realtime', 'omni-speech-ws': 'tts.stream-input' }[model.realtime?.wire] ?? 'duplex'
    default: return model.mode
  }
}

/** Mic/UI task id (closed list in TASK_UI_CONTRACT_PROPOSAL §B, plus additive `tts-stream`). */
export function uiTaskOf(model) {
  switch (model.mode) {
    case 'chat': return model.outputAudio ? 'omni-chat' : 'audio-chat'
    case 'transcribe': return model.asr?.responseFormat === 'diarized_json' ? 'diarization' : 'asr'
    case 'translate': return 'translation'
    case 'speech': return model.speech?.refAudio === 'attachment' ? 'voice-clone' : 'tts'
    case 'generate-audio': return model.generate?.kind === 'sound' ? 'sound-generation' : 'music-generation'
    case 'align': return 'alignment'
    case 'generate-video': return 'video-generation'
    case 'realtime': return { 'vllm-asr': 'realtime-asr', 'omni-turn': 's2s', 'omni-speech-ws': 'tts-stream' }[model.realtime?.wire] ?? 'duplex'
    default: return 'chat'
  }
}

/** `config` when the entry lists catalogTasks itself; `derived` when inferred from mode/params (may over-claim for a row). */
export function catalogTasksSourceOf(model) {
  return Array.isArray(model.catalogTasks) && model.catalogTasks.length > 0 ? 'config' : 'derived'
}

/** Catalog task ids served by this model entry (config `catalogTasks` wins when the library supplies it). */
export function catalogTasksOf(model) {
  if (Array.isArray(model.catalogTasks) && model.catalogTasks.length > 0) return model.catalogTasks
  switch (model.mode) {
    case 'chat': return model.outputAudio ? ['spoken_chat_speech_reply'] : ['audio_understanding_qa', 'spoken_chat_text_reply']
    case 'transcribe': return ['asr', ...(model.asr?.responseFormat === 'verbose_json' ? ['timestamps'] : []), ...(model.asr?.responseFormat === 'diarized_json' ? ['diarization'] : [])]
    case 'translate': return ['speech_translation']
    case 'speech': {
      const type = model.speech?.taskType
      if (model.speech?.refAudio === 'attachment' || type === 'Base') return ['tts_voice_clone']
      if (type === 'VoiceDesign') return ['tts_voice_design']
      return ['tts', 'tts_preset_voice', 'tts_instruct_style']
    }
    case 'generate-audio': return model.generate?.kind === 'sound' ? ['sound_effect_generation', 'text_to_audio'] : ['music_generation']
    case 'align': return ['timestamps']
    case 'generate-video': return model.video?.generateSound === false ? [] : ['text_to_video_with_audio']
    case 'realtime': return { 'vllm-asr': ['asr'], 'omni-turn': ['spoken_chat_speech_reply'], 'omni-speech-ws': ['tts'] }[model.realtime?.wire] ?? ['full_duplex_dialogue']
    default: return []
  }
}

/** Input/output shape for UI controls (TASK_UI_CONTRACT_PROPOSAL §B `io`). */
export function ioOf(model) {
  const controls = optionControlsOf(model)
  // 0.4.6: `obligations` (UI key → §K.11 obligation) on every mode; legacy tri-states stay for 0.4.x consumers.
  return { ...ioShapeOf(model, controls), obligations: obligationsOf(controls) }
}

function ioShapeOf(model, controls) {
  const none = { text: 'none', audio: 'none', referenceAudio: 'none', referenceText: 'none' }
  const transcript = { segments: false, wordTimestamps: false, speakers: false }
  switch (model.mode) {
    case 'chat': return { input: { ...none, text: 'optional', audio: 'optional' }, output: { text: true, audio: model.outputAudio === true, audioCount: 'one', transcript, embedding: false } }
    case 'transcribe':
    case 'translate': {
      const fmt = model.asr?.responseFormat
      return { input: { ...none, audio: 'required', text: 'none' }, output: { text: true, audio: false, audioCount: 'one', transcript: { segments: fmt === 'verbose_json' || fmt === 'diarized_json', wordTimestamps: (model.asr?.timestampGranularities ?? []).includes('word'), speakers: fmt === 'diarized_json' }, embedding: false } }
    }
    case 'speech': {
      const clone = model.speech?.refAudio === 'attachment'
      return {
        input: {
          ...none, text: 'required', referenceAudio: clone ? (model.speech?.taskType === 'Base' ? 'required' : 'optional') : 'none', referenceText: model.speech?.refText === 'prompt-prefix' || clone ? 'optional' : 'none',
          // 0.4.6: extra clip slots from the catalog status (§K.11), never from a listed string: only an active control counts.
          referenceAudio2: ioPresenceOf(controls, 'referenceAudio2'), emotionAudio: ioPresenceOf(controls, 'emotionAudio'),
        },
        output: { text: false, audio: true, audioCount: 'one', transcript: { ...transcript, wordTimestamps: ioPresenceOf(controls, 'wordTimestamps') !== 'none' }, embedding: false },
      }
    }
    case 'generate-audio': return { input: { ...none, text: 'required' }, output: { text: false, audio: true, audioCount: 'one', transcript, embedding: false } }
    case 'generate-video': {
      const slot = key => ((model.paramsRequired ?? []).includes(key) ? 'required' : model.video?.[key] === 'attachment' ? 'optional' : 'none')
      return { input: { ...none, text: 'required', image: slot('imageReference'), audio: slot('audioReference') }, output: { text: true, audio: model.video?.generateSound !== false, video: true, audioCount: 'one', transcript, embedding: false } }
    }
    case 'align': return { input: { ...none, audio: 'required', text: 'required' }, output: { text: true, audio: false, audioCount: 'one', transcript: { ...transcript, wordTimestamps: true }, embedding: false } }
    case 'realtime': {
      const wire = model.realtime?.wire ?? 'omni-duplex'
      if (wire === 'omni-speech-ws') return { input: { ...none, text: 'required' }, output: { text: false, audio: true, audioCount: 'many', transcript: { ...transcript, wordTimestamps: ioPresenceOf(controls, 'wordTimestamps') !== 'none' }, embedding: false }, live: 'text' }
      return { input: { ...none, audio: 'required' }, output: { text: true, audio: wire !== 'vllm-asr', audioCount: 'many', transcript, embedding: false }, live: 'audio' }
    }
    default: return { input: none, output: { text: true, audio: false, audioCount: 'one', transcript, embedding: false } }
  }
}

/** UI key → host-derived obligation (§K.11) for the io consumer; the full per-key record is `optionControls.controls`. */
function obligationsOf(controls) {
  return Object.fromEntries(controls.controls.map(c => [c.key, c.obligation]))
}

const TEXT_KEYS = new Set(['instructions', 'refText', 'prompt', 'negativePrompt', 'ambientSound'])

/**
 * 0.4.5 raw-string reading, kept for comparison only (no longer feeds `io`, §K.11).
 * `none` | `optional` | `required` for one wire field from catalog request_options strings: an entry naming the field
 * first; `required` when that entry says so; `none` when absent or listed under a `rejected:` entry.
 */
export function optionPresence(requestOptions, field) {
  if (!Array.isArray(requestOptions)) return 'none'
  let presence = 'none'
  for (const raw of requestOptions) {
    const entry = String(raw).trim()
    if (/^(rejected|unsupported|ignored|not supported)\b/i.test(entry)) {
      if (new RegExp(`(^|[\\s:,(])${field.replace('.', '\\.')}\\b`).test(entry)) return 'none'
      continue
    }
    if (entry === field || entry.startsWith(`${field} `) || entry.startsWith(`${field}(`) || entry.startsWith(`${field}:`) || entry.startsWith(`${field}=`)) {
      presence = /\brequired\b/i.test(entry) && !/\bnot required\b/i.test(entry) ? 'required' : 'optional'
    }
  }
  return presence
}

/** Parameter list for UI rendering, with model defaults. */
export function paramsListOf(model, provider) {
  const schema = paramSchemaOf(model)
  const defaults = { ...model.speech, ...model.asr, ...model.generate }
  return Object.entries(schema).map(([key, rule]) => {
    const entry = { key }
    if (Array.isArray(rule)) Object.assign(entry, { type: 'enum', values: rule })
    else if (rule === 'string') Object.assign(entry, { type: TEXT_KEYS.has(key) ? 'text' : 'string', maxLength: 4000 })
    else if (rule === 'string[]') Object.assign(entry, { type: 'list' })
    else if (typeof rule === 'object') Object.assign(entry, { type: rule.type === 'integer' ? 'number' : rule.type, ...(rule.type === 'integer' ? { step: 1 } : {}), ...(rule.min === undefined ? {} : { min: rule.min }), ...(rule.max === undefined ? {} : { max: rule.max }) })
    else Object.assign(entry, { type: rule === 'integer' ? 'number' : rule, ...(rule === 'integer' ? { step: 1 } : {}) })
    if (key === 'voice' && (model.mode === 'speech' || model.mode === 'realtime')) {
      entry.valuesFrom = `/api/dsh-dgx-audio/v1/voices?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model.id)}`
      entry.source = 'voices' // mic HANDOFF 02:29 descriptor ask: values come from GET voices
    }
    if (defaults[key] !== undefined && typeof defaults[key] !== 'object') entry.default = defaults[key]
    return entry
  })
}

const OPTIONS_BLOCK = /```dsh-audio-options[^\n]*\n([\s\S]*?)```/g

/**
 * Extract the logged inline options block(s) from user text (TASK_UI_CONTRACT_PROPOSAL §C carrier 2).
 * @returns {{ text: string, options: Record<string, unknown> | undefined, error?: string }}
 */
export function extractOptionsBlock(text) {
  let options
  let error
  const stripped = text.replace(OPTIONS_BLOCK, (_, body) => {
    try {
      const parsed = JSON.parse(body)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      options = { ...options, ...parsed }
    } catch (e) {
      error = `dsh-audio-options block is not valid JSON: ${e.message}`
    }
    return ''
  })
  return { text: stripped.trim(), options, ...(error === undefined ? {} : { error }) }
}
