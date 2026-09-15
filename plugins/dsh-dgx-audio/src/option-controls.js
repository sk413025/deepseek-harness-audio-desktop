// Catalog per-variant request-option status → UI control obligations (TASK_CONTRACT §K.11, host 0.4.6).
//
// The catalog's `requestOptionsMap` entry `{option, status, raw, detail?}` records what a *source* says about one wire option
// for one variant. It is never a verified capability. `listed-by-source` offers an unverified control. ignored / rejected /
// unsupported / accepted-not-forwarded / unknown, a key the map does not mention, and a variant without a map never become
// active controls. The send path is unchanged (§K.8 host rule): user params are validated and sent, and the server stays
// the authority. This module only publishes what a UI may offer.

import { SPEECH_WS_FIELDS } from './tasks.js'
import { VIDEO_FORM_FIELDS } from './video.js'

export const OPTION_CONTROLS_CONTRACT = 'dsh-audio/option-controls@1'

/** Catalog 0515 status vocabulary (CONSUMER_ADOPTION_20260915T0515). Other syntactically valid statuses count as `unknown`. */
export const CATALOG_OPTION_STATUSES = Object.freeze([
  'listed-by-source', 'listed-restricted', 'required', 'required-conditional', 'ignored', 'rejected', 'unsupported',
  'accepted-not-forwarded', 'unknown', 'deploy-flag', 'input-description',
])

/** Host-derived obligation per UI key; `active` obligations are the only ones a UI may render as a usable control. */
export const OBLIGATIONS = Object.freeze({
  required: { active: true, mandatory: true, meaning: 'a source says the option is required: render and require a value (not verified for this model)' },
  'required-conditional': { active: true, mandatory: 'conditional', meaning: 'required under the condition in `conditions` (raw text): render; require when the condition holds' },
  'offer-restricted': { active: true, mandatory: false, meaning: 'listed with a value restriction (raw text): render with that restriction' },
  'offer-unverified': { active: true, mandatory: false, meaning: 'listed by a source: render, labelled "not verified for this model"' },
  'rejected-conditional': { active: false, mandatory: false, meaning: 'the server rejects some values (`conditions`) and no source lists the option: no control (leave the server default)' },
  rejected: { active: false, mandatory: false, meaning: 'the server refuses the option: no control' },
  unsupported: { active: false, mandatory: false, meaning: 'a source says the option is not supported: no control' },
  'not-forwarded': { active: false, mandatory: false, meaning: 'accepted by the API but not forwarded to the model: no control' },
  ignored: { active: false, mandatory: false, meaning: 'accepted without effect: no control' },
  conflict: { active: false, mandatory: false, meaning: 'a positive and an unconditional negative status name the same option: no control; report to the catalog' },
  unknown: { active: false, mandatory: false, meaning: 'support is unknown (see `reason`): show as unknown, never as a working control and never as unsupported' },
  unlisted: { active: false, mandatory: false, meaning: 'the variant map does not mention this option: support not established; hide by default, never call it unsupported' },
})

const POSITIVE = ['required', 'required-conditional', 'listed-restricted', 'listed-by-source']
const NEGATIVE = ['rejected', 'unsupported', 'accepted-not-forwarded', 'ignored']
const POSITIVE_OBLIGATION = { required: 'required', 'required-conditional': 'required-conditional', 'listed-restricted': 'offer-restricted', 'listed-by-source': 'offer-unverified' }
const NEGATIVE_OBLIGATION = { rejected: 'rejected', unsupported: 'unsupported', 'accepted-not-forwarded': 'not-forwarded', ignored: 'ignored' }
const CONDITION = /(!=|<=|>=|==|<|>|\bnot in\b|\bexcept\b|\bunless\b|\bother than\b)/i

const p = (key, wireKey, extra) => ({ key, wireKey, kind: 'param', ...extra })
const a = (key, wireKey, extra) => ({ key, wireKey, kind: 'attachment', ...extra })
const h = (wireKey, controlledBy, extra) => ({ key: null, wireKey, kind: 'host', controlledBy, ...extra })
const n = (wireKey, reason) => ({ key: null, wireKey, kind: 'not-sendable', reason })

// Same session keys on every non-speech realtime wire (live.js start(): voice/instructions/overlap_policy/turn_detection).
const REALTIME_SESSION = [
  p('voice', 'session.voice', { aliases: ['voice'] }), p('instructions', 'session.instructions', { aliases: ['instructions'] }),
  p('overlapPolicy', 'session.overlap_policy', { aliases: ['overlap_policy'] }), p('turnDetection', 'session.turn_detection', { aliases: ['turn_detection'] }),
  h('session.ref_audio', 'realtime.refAudioFile', { aliases: ['ref_audio'], satisfiedBy: 'realtime.refAudioFile' }), h('modalities', 'realtime.session'), h('model', 'upstreamModel'),
]

/**
 * UI key ↔ wire key per control family (`mode`, or `realtime:<wire>`), read from the send paths of this build (tasks.js,
 * adapter.js, live.js, video.js). `kind`: param | attachment (a UI control), host (set by the host or the deployment),
 * not-sendable (this adapter cannot put it on this wire).
 */
export const WIRE_KEY_TABLES = Object.freeze({
  speech: {
    endpoint: 'POST /v1/audio/speech',
    rows: [
      p('voice', 'voice'), p('instructions', 'instructions'), p('language', 'language'), p('taskType', 'task_type'), p('responseFormat', 'response_format'),
      p('maxNewTokens', 'max_new_tokens'), p('refText', 'ref_text'), p('speed', 'speed'), p('seed', 'seed'), p('sampleRate', 'sample_rate'),
      p('wordTimestamps', 'word_timestamps', { delivery: 'final-header', note: 'X-Word-Timestamps response header; the adapter sends a non-streaming request' }),
      p('xVectorOnlyMode', 'x_vector_only_mode'), p('nonStreamingMode', 'non_streaming_mode'), p('initialCodecChunkFrames', 'initial_codec_chunk_frames'),
      p('ambientSound', 'ambient_sound'), p('durationSeconds', 'duration_seconds'), p('extraParams', 'extra_params', { subOptions: true }),
      a('referenceAudio', 'ref_audio', { note: 'data URL; a list when referenceAudio names a list' }),
      a('referenceAudio2', 'ref_audio_2', { note: 'one data URL clip (second dialogue speaker)' }),
      a('emotionAudio', 'extra_params.emo_audio', { note: 'one data URL clip inside extra_params' }),
      h('input', 'prompt text of the pending user turn'), h('stream', 'model streaming.audio'), h('stream_format', 'model streaming.audio'), h('model', 'upstreamModel'),
      n('speaker_embedding', 'unsupported by the adapter (ADAPTER_GAPS §2)'),
    ],
  },
  'realtime:omni-speech-ws': {
    endpoint: 'WS /v1/audio/speech/stream session.config',
    rows: [
      ...Object.entries(SPEECH_WS_FIELDS).map(([key, wire]) => p(key, wire, key === 'wordTimestamps' ? { delivery: 'live.words', note: 'trailing empty audio.chunk per sentence → feed live.words and close responses[].wordTimestamps' } : undefined)),
      h('ref_audio', 'realtime.refAudioFile', { satisfiedBy: 'realtime.refAudioFile', note: 'one deployment clip per session, not per turn' }),
      h('input', 'live/text utterances'), h('response_format', 'always pcm'), h('stream_audio', 'always true'), h('stream', 'always streamed'), h('model', 'upstreamModel'),
      n('speaker_embedding', 'unsupported by the adapter'), n('extra_params', 'not in the server session config'), n('ref_audio_2', 'not in the server session config'),
      n('ambient_sound', 'not in the server session config'), n('sample_rate', 'not in the server session config'), n('duration_seconds', 'not in the server session config'),
    ],
  },
  transcribe: {
    endpoint: 'POST /v1/audio/transcriptions (multipart)',
    rows: [p('language', 'language'), p('prompt', 'prompt'), p('responseFormat', 'response_format'), p('timestampGranularities', 'timestamp_granularities[]'),
      h('file', 'newest audio of the pending turn'), h('stream', 'model streaming.text'), h('temperature', 'model temperature'), h('model', 'upstreamModel')],
  },
  translate: {
    endpoint: 'POST /v1/audio/translations (multipart)',
    rows: [p('language', 'language'), p('prompt', 'prompt'), p('responseFormat', 'response_format'), p('toLanguage', 'to_language'),
      h('file', 'newest audio of the pending turn'), h('stream', 'model streaming.text'), h('temperature', 'model temperature'), h('model', 'upstreamModel')],
  },
  'generate-audio': {
    endpoint: 'POST /v1/audio/generate',
    rows: [p('audioLength', 'audio_length'), p('negativePrompt', 'negative_prompt'), p('guidanceScale', 'guidance_scale'), p('numInferenceSteps', 'num_inference_steps'), p('seed', 'seed'),
      h('input', 'prompt text'), h('response_format', 'model generate.responseFormat'), h('stream_format', 'model streaming.audio'), h('model', 'upstreamModel')],
  },
  'generate-video': {
    endpoint: 'POST /v1/videos/sync | /v1/videos (multipart)',
    rows: [
      ...Object.entries(VIDEO_FORM_FIELDS).map(([key, wire]) => p(key, wire, key === 'extraParams' ? { subOptions: true } : undefined)),
      a('imageReference', 'image_reference', { note: '{"image_url": data URL}' }), a('audioReference', 'audio_reference', { note: '{"audio_url": data URL}' }),
      h('prompt', 'prompt text'), h('model', 'upstreamModel'), n('input_reference', 'file upload not implemented'), n('video_reference', 'not implemented'),
    ],
  },
  align: {
    endpoint: 'POST /pooling (STEP pooling, task token_classify)',
    rows: [p('wordSplit', null, { note: 'adapter-side word segmentation; no wire key' }), h('messages', 'audio_url + transcript with <timestamp> tokens'), h('task', 'token_classify'), h('chat_template', 'raw content template')],
  },
  'realtime:omni-duplex': { endpoint: 'WS /v1/realtime session.update', rows: REALTIME_SESSION },
  'realtime:omni-turn': { endpoint: 'WS /v1/realtime session.update', rows: REALTIME_SESSION },
  'realtime:vllm-asr': { endpoint: 'WS /v1/realtime session.update', rows: REALTIME_SESSION },
  // Chat variants: request options are Harness chat params and message parts; no per-variant UI controls here.
  chat: { endpoint: 'POST /v1/chat/completions', rows: [] },
})

/** Control family of a resolved model entry. */
export function controlFamilyOf(model) {
  return model?.mode === 'realtime' ? `realtime:${model.realtime?.wire ?? 'omni-duplex'}` : String(model?.mode)
}

const bare = key => String(key).replace(/\[\]$/, '')

function rowIndex(rows) {
  const index = new Map()
  for (const row of rows) for (const name of [row.wireKey, ...(row.aliases ?? [])]) if (name) index.set(bare(name), row)
  return index
}

/** Map one catalog `option` onto table rows: `[{ row, conditional, sub? }]`, empty when it names no wire key. */
function matchOption(entry, index) {
  const option = String(entry.option).trim()
  const detail = typeof entry.detail === 'string' ? entry.detail : ''
  const qualifier = detail.startsWith(option) ? detail.slice(option.length) : detail
  const exact = index.get(bare(option))
  if (exact) return [{ row: exact, conditional: CONDITION.test(qualifier) }]
  if (/^[\w.[\]]+(\/[\w.[\]]+)+$/.test(option)) {
    const parts = option.split('/').map(part => index.get(bare(part)))
    if (parts.every(Boolean)) return parts.map(row => ({ row, conditional: CONDITION.test(qualifier) }))
  }
  const lead = option.match(/^([A-Za-z_]\w*(?:\.\w+)*)(?:\[\])?(\s*(?:!=|<=|>=|==|<|>)|\s+(?:not in|other than|except)\b)/)
  if (lead && index.get(lead[1])) return [{ row: index.get(lead[1]), conditional: true }]
  const sub = option.match(/^extra_params(?:\.|\s+)(.+)$/)
  if (sub && index.get('extra_params')) return [{ row: index.get('extra_params'), conditional: CONDITION.test(sub[1]) || CONDITION.test(qualifier), sub: sub[1] }]
  return []
}

/** Where each map entry's `raw` sits in `requestOptions` (the catalog may cut `raw` to a prefix of the full entry). */
function rawSources(map, requestOptions) {
  const list = Array.isArray(requestOptions) ? requestOptions : []
  return map.map((entry) => {
    const exact = list.indexOf(entry.raw)
    if (exact >= 0) return { index: exact, match: 'exact' }
    const prefix = entry.raw === '' ? -1 : list.findIndex(full => full.startsWith(entry.raw))
    return prefix >= 0 ? { index: prefix, match: 'prefix' } : null
  })
}

const knownStatus = status => CATALOG_OPTION_STATUSES.includes(status)

function obligationOf(hits) {
  const direct = hits.filter(hit => hit.sub === undefined)
  const unconditionalNegative = direct.filter(hit => NEGATIVE.includes(hit.status) && !hit.conditional)
  const conditionalNegative = direct.filter(hit => NEGATIVE.includes(hit.status) && hit.conditional)
  const positive = direct.filter(hit => POSITIVE.includes(hit.status))
  const unknown = direct.filter(hit => hit.status === 'unknown' || !knownStatus(hit.status))
  // Every negative that did not decide the obligation stays visible as a condition (sub-options included): never relaxed silently.
  const subNegative = hits.filter(hit => hit.sub !== undefined && NEGATIVE.includes(hit.status))
  const conditions = [...direct.filter(hit => hit.status === 'required-conditional'), ...conditionalNegative, ...subNegative].map(hit => hit.condition)
  if (unconditionalNegative.length > 0 && positive.length > 0) return { obligation: 'conflict', reason: 'positive-and-negative-status', conditions }
  if (unconditionalNegative.length > 0) {
    const strongest = NEGATIVE.find(status => unconditionalNegative.some(hit => hit.status === status))
    return { obligation: NEGATIVE_OBLIGATION[strongest], reason: `catalog-${strongest}`, conditions }
  }
  if (positive.length > 0) {
    const strongest = POSITIVE.find(status => positive.some(hit => hit.status === status))
    return { obligation: POSITIVE_OBLIGATION[strongest], reason: `catalog-${strongest}`, conditions }
  }
  if (conditionalNegative.length > 0) return { obligation: 'rejected-conditional', reason: 'catalog-rejected-with-condition', conditions }
  if (unknown.length > 0) return { obligation: 'unknown', reason: unknown.some(hit => !knownStatus(hit.status)) ? 'unrecognized-catalog-status' : 'catalog-status-unknown', conditions }
  if (hits.some(hit => hit.sub !== undefined && POSITIVE.includes(hit.status))) return { obligation: 'offer-unverified', reason: 'sub-options-listed', conditions }
  return { obligation: 'unlisted', reason: 'not-in-variant-map', conditions }
}

/**
 * The published `optionControls` document for one resolved model entry. Pure; the same input gives the same output.
 * @param {Record<string, any>} model resolved model config (config.js)
 */
export function optionControlsOf(model) {
  const family = controlFamilyOf(model)
  const table = WIRE_KEY_TABLES[family]
  const map = Array.isArray(model.requestOptionsMap) ? model.requestOptionsMap : undefined
  const basis = map === undefined ? (Array.isArray(model.requestOptions) && model.requestOptions.length > 0 ? 'raw-only' : 'none') : map.length === 0 ? 'catalog-map-empty' : 'catalog-map'
  const doc = {
    contract: OPTION_CONTROLS_CONTRACT,
    family,
    endpoint: table?.endpoint ?? null,
    basis,
    verified: false,
    source: { map: map === undefined ? null : 'requestOptionsMap', scope: typeof model.requestOptionsScope === 'string' ? model.requestOptionsScope : null, evidence: model.requestOptionsEvidence === undefined ? null : 'requestOptionsEvidence' },
    controls: [],
    hostOptions: [],
    notSendable: [],
    unmapped: [],
    blockers: [],
    inputErrors: Array.isArray(model.requestOptionsInputErrors) ? model.requestOptionsInputErrors : [],
    ...(map === undefined ? {} : { rawSources: rawSources(map, model.requestOptions) }),
  }
  const uiRows = (table?.rows ?? []).filter(row => row.kind === 'param' || row.kind === 'attachment')
  const hits = new Map(uiRows.map(row => [row.key, []]))
  if (map !== undefined && table !== undefined) {
    const index = rowIndex(table.rows)
    map.forEach((entry, i) => {
      if (entry.status === 'deploy-flag' || entry.status === 'input-description') {
        doc.unmapped.push({ index: i, option: entry.option, status: entry.status, reason: entry.status })
        return
      }
      const matches = matchOption(entry, index)
      if (matches.length === 0) {
        doc.unmapped.push({ index: i, option: entry.option, status: entry.status, reason: table.rows.length === 0 ? 'family-has-no-option-controls' : 'no-adapter-key' })
        // A source-required option this adapter has no key for cannot be satisfied through the adapter on this family.
        if (table.rows.length > 0 && (entry.status === 'required' || entry.status === 'required-conditional')) {
          doc.blockers.push({ index: i, wireKey: null, option: entry.option, status: entry.status, conditional: entry.status === 'required-conditional', reason: 'no adapter key for a required option' })
        }
        return
      }
      for (const { row, conditional, sub } of matches) {
        const hit = { index: i, status: entry.status, conditional, condition: entry.detail ?? entry.raw, ...(sub === undefined ? {} : { sub }) }
        if (row.kind === 'host') {
          const satisfied = row.satisfiedBy === undefined ? null : model.realtime?.refAudioFile !== undefined
          doc.hostOptions.push({ index: i, option: entry.option, wireKey: row.wireKey, status: entry.status, controlledBy: row.controlledBy, ...(row.satisfiedBy === undefined ? {} : { satisfiedBy: row.satisfiedBy, satisfied }) })
          if (satisfied === false && (entry.status === 'required' || entry.status === 'required-conditional')) {
            doc.blockers.push({ index: i, wireKey: row.wireKey, status: entry.status, conditional: entry.status === 'required-conditional', reason: `needs deployment ${row.satisfiedBy}` })
          }
        } else if (row.kind === 'not-sendable') {
          doc.notSendable.push({ index: i, option: entry.option, wireKey: row.wireKey, status: entry.status, reason: row.reason })
          if (entry.status === 'required' || entry.status === 'required-conditional') {
            doc.blockers.push({ index: i, wireKey: row.wireKey, status: entry.status, conditional: entry.status === 'required-conditional', reason: `adapter cannot send on this wire: ${row.reason}` })
          }
        } else {
          hits.get(row.key).push(hit)
        }
      }
    })
  } else if (map !== undefined) {
    map.forEach((entry, i) => doc.unmapped.push({ index: i, option: entry.option, status: entry.status, reason: 'no-wire-key-table' }))
  }
  const defaults = { ...model.speech, ...model.asr, ...model.generate, ...model.video, ...model.align }
  for (const row of uiRows) {
    const list = hits.get(row.key)
    const derived = basis === 'none' ? { obligation: 'unknown', reason: 'no-map', conditions: [] }
      : basis === 'raw-only' ? { obligation: 'unknown', reason: 'raw-request-options-not-classified', conditions: [] }
        : basis === 'catalog-map-empty' ? { obligation: 'unknown', reason: 'empty-map', conditions: [] }
          : obligationOf(list)
    const rule = OBLIGATIONS[derived.obligation]
    doc.controls.push({
      key: row.key,
      wireKey: row.wireKey,
      kind: row.kind,
      obligation: derived.obligation,
      active: rule.active,
      mandatory: rule.mandatory,
      verified: false,
      reason: derived.reason,
      statuses: [...new Set(list.map(hit => hit.status))],
      entries: list.map(hit => ({ index: hit.index, status: hit.status, conditional: hit.conditional, ...(hit.sub === undefined ? {} : { sub: hit.sub }) })),
      conditions: [...new Set(derived.conditions)],
      ...(row.delivery ? { delivery: row.delivery } : {}),
      ...(row.note ? { note: row.note } : {}),
      deploymentDefault: defaults[row.key] !== undefined && defaults[row.key] !== null,
    })
  }
  return doc
}

/** Legacy `io` tri-state from a control: only an active control is ever `optional`/`required`. */
export function ioPresenceOf(controls, key) {
  const control = controls.controls.find(c => c.key === key)
  if (control === undefined || !control.active) return 'none'
  return control.obligation === 'required' ? 'required' : 'optional'
}

/** Bounds shared with dsh-audio-model-library 0.1.3 `REQUEST_OPTION_BOUNDS` (binding.js), so both lanes accept the same values. */
export const REQUEST_OPTION_BOUNDS = Object.freeze({ entries: 400, text: 2000, evidenceJson: 16384 })

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const boundedText = value => typeof value === 'string' && value.length <= REQUEST_OPTION_BOUNDS.text

/**
 * Check the three catalog fields against §K.11 bounds. Returns `[{ field, message }]`; the caller drops each invalid field
 * whole (absent = unknown, as the library does) and publishes the errors. Valid values are kept verbatim.
 */
export function requestOptionsFieldErrors(model) {
  const errors = []
  const map = model.requestOptionsMap
  if (map !== undefined) {
    if (!Array.isArray(map) || map.length > REQUEST_OPTION_BOUNDS.entries) errors.push({ field: 'requestOptionsMap', message: `must be an array of ≤ ${REQUEST_OPTION_BOUNDS.entries} entries` })
    else {
      const bad = map.findIndex(e => !(plainObject(e) && boundedText(e.option) && boundedText(e.status) && boundedText(e.raw) && (e.detail === undefined || boundedText(e.detail))))
      if (bad >= 0) errors.push({ field: 'requestOptionsMap', message: `entry ${bad} must be an object with string option, status, raw (and optional detail), each ≤ ${REQUEST_OPTION_BOUNDS.text} characters` })
    }
  }
  if (model.requestOptionsScope !== undefined && !boundedText(model.requestOptionsScope)) errors.push({ field: 'requestOptionsScope', message: `must be a string of ≤ ${REQUEST_OPTION_BOUNDS.text} characters` })
  const evidence = model.requestOptionsEvidence
  if (evidence !== undefined && !(plainObject(evidence) && JSON.stringify(evidence).length <= REQUEST_OPTION_BOUNDS.evidenceJson)) errors.push({ field: 'requestOptionsEvidence', message: `must be an object of ≤ ${REQUEST_OPTION_BOUNDS.evidenceJson} JSON characters` })
  return errors
}
