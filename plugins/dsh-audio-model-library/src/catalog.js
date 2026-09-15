// Catalog consumption (audio-catalog.schema.json 1.x, owned by the catalog lane) and task taxonomy.
//
// The library never invents facts: missing fields become `null` ("not in catalog"), the catalog's
// literal "unknown" is kept as "unknown", and failed/blocked rows are never filtered out.

/** Task vocabulary group → adapter mode (CONTRACT §4). */
export const TASK_GROUPS = Object.freeze({
  audio_understanding_qa: { group: 'understanding', mode: 'chat', outputAudio: false },
  spoken_chat_text_reply: { group: 'understanding', mode: 'chat', outputAudio: false },
  audio_captioning: { group: 'understanding', mode: 'chat', outputAudio: false },
  spoken_chat_speech_reply: { group: 'speech-chat', mode: 'chat', outputAudio: true },
  asr: { group: 'transcription', mode: 'transcribe' },
  timestamps: { group: 'transcription', mode: 'transcribe' },
  diarization: { group: 'transcription', mode: 'transcribe' },
  speech_translation: { group: 'translation', mode: 'translate' },
  full_duplex_dialogue: { group: 'live', mode: 'realtime' },
  tts: { group: 'speech-synthesis', mode: 'speech' },
  tts_preset_voice: { group: 'speech-synthesis', mode: 'speech' },
  tts_voice_clone: { group: 'speech-synthesis', mode: 'speech' },
  tts_voice_design: { group: 'speech-synthesis', mode: 'speech' },
  tts_instruct_style: { group: 'speech-synthesis', mode: 'speech' },
  tts_multi_speaker_dialogue: { group: 'speech-synthesis', mode: 'speech' },
  speech_editing: { group: 'speech-synthesis', mode: 'speech' },
  music_generation: { group: 'audio-generation', mode: 'generate-audio' },
  sound_effect_generation: { group: 'audio-generation', mode: 'generate-audio' },
  text_to_audio: { group: 'audio-generation', mode: 'generate-audio' },
  audio_to_video: { group: 'audio-video', mode: 'other' },
  text_to_video_with_audio: { group: 'audio-video', mode: 'generate-video' },
  image_to_video_with_audio: { group: 'audio-video', mode: 'generate-video' },
  speech_to_video: { group: 'audio-video', mode: 'other' },
  audio_embedding: { group: 'analysis', mode: 'other' },
  audio_classification: { group: 'analysis', mode: 'other' },
  speech_enhancement: { group: 'audio-processing', mode: 'other' },
  source_separation: { group: 'audio-processing', mode: 'other' },
  vad: { group: 'analysis', mode: 'other' },
})

export function taskInfo(task) {
  return TASK_GROUPS[task] ?? { group: 'other', mode: 'other' }
}

export const LIFECYCLE_STATES = Object.freeze([
  'candidate', 'downloading', 'downloaded', 'preparing', 'ready-to-test', 'backend-pass', 'desktop-pass',
  'failed', 'blocked-access', 'blocked-runtime', 'blocked-capacity', 'out-of-scope-reviewed',
])

const str = value => (typeof value === 'string' && value !== '' ? value : null)
const int = value => (Number.isInteger(value) ? value : null)
const note = value => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 2000) : null)
// Owner overlays carry `performance` inside the verification object (DGX overlay 04:39: tasks.<task>.performance,
// streaming.<mode>.backend.performance); keep it with its layer.
const verification = value => (value && typeof value === 'object' ? { state: str(value.state) ?? 'unverified', evidence: Array.isArray(value.evidence) ? value.evidence.filter(e => typeof e === 'string').slice(0, 20) : [], at: str(value.at), owner: str(value.owner), notes: note(value.notes), performance: performanceOf(value.performance) } : { state: 'unverified', evidence: [], at: null, owner: null, notes: null, performance: null })
const counts = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => Number.isInteger(v))) : {})

/**
 * Speed evidence (CONTRACT §3.2, plugin 0.1.2). Only two metrics have a defined direction:
 *  - `audioSecondsPerWallSecond` = generated (or processed) audio seconds ÷ wall-clock seconds; ≥ 1 keeps up with real time.
 *  - `wallSecondsPerAudioSecond` = wall-clock seconds ÷ audio seconds (the common "RTF"); ≤ 1 keeps up with real time.
 * Any other metric name (`rtf`, `realtimeFactor`, …) is kept raw and never classified: the library does not guess
 * whether a number is a rate or its inverse. `measurementKind` and raw source labels are preserved.
 */
export const SPEED_METRICS = Object.freeze({
  audioSecondsPerWallSecond: { unit: 'audio-s/wall-s', formula: 'audio_seconds / wall_seconds', belowRealtime: v => v < 1 },
  wallSecondsPerAudioSecond: { unit: 'wall-s/audio-s', formula: 'wall_seconds / audio_seconds', belowRealtime: v => v > 1 },
})
/** Latency metrics: shown with unit/formula, never classified against real time. */
export const LATENCY_METRICS = Object.freeze({
  firstAudioMs: { unit: 'ms', formula: 'request start → first audio chunk' },
  firstTextMs: { unit: 'ms', formula: 'request start → first text delta' },
})
export const MEASUREMENT_KINDS = Object.freeze(['functional', 'benchmark', 'estimate', 'upstream-doc', 'unknown'])

function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null }

function classify(metric, value, range) {
  if (LATENCY_METRICS[metric] !== undefined) return 'latency'
  const def = SPEED_METRICS[metric]
  if (def === undefined) return 'unclassified'
  const values = range ?? [value]
  const below = values.map(v => def.belowRealtime(v))
  if (below.every(Boolean)) return 'below-realtime'
  if (below.every(v => !v)) return 'at-or-above-realtime'
  return 'mixed'
}

function speedMetric(raw, inherited = {}) {
  if (raw === null || typeof raw !== 'object') return null
  const metric = str(raw.metric)
  const value = finite(raw.value)
  const range = Array.isArray(raw.range) && raw.range.length === 2 && raw.range.every(v => finite(v) !== null) ? [Math.min(raw.range[0], raw.range[1]), Math.max(raw.range[0], raw.range[1])] : null
  if (metric === null || (value === null && range === null)) return null
  const def = SPEED_METRICS[metric]
  const latency = LATENCY_METRICS[metric]
  const kind = str(raw.measurementKind ?? inherited.measurementKind)
  return {
    metric,
    value,
    range,
    category: def ? 'speed-ratio' : latency ? 'latency' : 'other',
    unit: def?.unit ?? str(raw.unit) ?? latency?.unit ?? null,
    formula: def?.formula ?? str(raw.formula) ?? latency?.formula ?? null,
    definedByLibrary: def !== undefined || latency !== undefined,
    classification: classify(metric, value, range),
    measurementKind: MEASUREMENT_KINDS.includes(kind) ? kind : 'unknown',
    statistic: str(raw.statistic),
    n: int(raw.n),
    phase: str(raw.phase),
    hardware: str(raw.hardware ?? inherited.hardware),
    runtime: str(raw.runtime ?? inherited.runtime),
    conditions: note(raw.conditions),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter(e => typeof e === 'string').slice(0, 10) : [],
    owner: str(raw.owner ?? inherited.owner),
    at: str(raw.at ?? inherited.at),
    rawLabel: str(raw.rawLabel),
    rawValue: str(raw.rawValue) ?? (typeof raw.rawValue === 'number' ? String(raw.rawValue) : null),
  }
}

/**
 * Normalize a `performance` object. Accepted shapes: `{ metrics: [ … ] }` (preferred), a single metric object, or the
 * 0.1.1 shorthand `{ realtimeFactor }`, which has no defined direction and is therefore kept as an unclassified metric.
 * @returns {{ metrics: any[] } | null}
 */
export function performanceOf(value) {
  if (value === null || typeof value !== 'object') return null
  const inherited = { measurementKind: value.measurementKind, hardware: value.hardware, runtime: value.runtime, owner: value.owner, at: value.at }
  const list = []
  if (Array.isArray(value.metrics)) for (const m of value.metrics) { const parsed = speedMetric(m, inherited); if (parsed) list.push(parsed) }
  else if (typeof value.metric === 'string') { const parsed = speedMetric(value, inherited); if (parsed) list.push(parsed) }
  for (const name of Object.keys(SPEED_METRICS)) {
    if (finite(value[name]) !== null) list.push(speedMetric({ ...value, metric: name, value: value[name] }, inherited))
  }
  if (finite(value.realtimeFactor) !== null) list.push(speedMetric({ metric: 'realtimeFactor', value: value.realtimeFactor, rawLabel: 'realtimeFactor', measurementKind: value.measurementKind, conditions: value.basis }, inherited))
  return list.length > 0 ? { metrics: list } : null
}

/**
 * Validate the document header and return the normalized catalog.
 * @param {any} doc
 * @returns {{ ok: true, catalog: any } | { ok: false, error: { code: string, message: string } }}
 */
export function normalizeCatalog(doc, source) {
  if (doc === null || doc === undefined) return { ok: true, catalog: null }
  if (typeof doc !== 'object' || !Array.isArray(doc.rows)) return { ok: false, error: { code: 'CATALOG_INVALID', message: 'catalog has no rows array' } }
  if (typeof doc.schema_version !== 'string' || !doc.schema_version.startsWith('1.')) {
    return { ok: false, error: { code: 'CATALOG_SCHEMA_UNSUPPORTED', message: `catalog schema_version ${JSON.stringify(doc.schema_version)} is not 1.x` } }
  }
  const rows = []
  const seen = new Set()
  for (const raw of doc.rows) {
    const row = normalizeRow(raw)
    if (row === null || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return {
    ok: true,
    catalog: {
      source,
      schemaVersion: doc.schema_version,
      catalogVersion: str(doc.catalog_version),
      completeness: str(doc.completeness) ?? 'unknown',
      generatedAt: str(doc.generated_at),
      rows,
    },
  }
}

export function normalizeRow(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') return null
  const model = raw.model ?? {}
  const runtime = raw.runtime ?? {}
  const download = raw.download ?? {}
  const status = raw.status ?? {}
  const acceptance = raw.acceptance ?? {}
  return {
    id: raw.id,
    displayName: str(raw.display_name) ?? str(model.hf_repo) ?? raw.id,
    family: str(raw.family),
    role: str(raw.audio_role) ?? 'primary',
    repo: str(model.hf_repo),
    revision: str(model.revision),
    variant: model.variant && typeof model.variant === 'object' ? model.variant : null,
    synonymOf: str(model.synonym_of),
    access: str(model.access) ?? 'unknown',
    accessPrerequisite: str(model.access_prerequisite),
    license: str(model.license),
    hubBytes: int(model.hub_total_bytes),
    engine: str(runtime.engine),
    architecture: str(runtime.architecture),
    catalogRecipeId: str(runtime.docker_recipe_id),
    testedImage: str(runtime.tested_image),
    testedRuntimeCommit: str(runtime.tested_runtime_commit),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.filter(t => typeof t === 'string') : [],
    modalities: {
      input: Array.isArray(raw.modalities?.input) ? raw.modalities.input : [],
      output: Array.isArray(raw.modalities?.output) ? raw.modalities.output : [],
    },
    endpoints: Array.isArray(raw.endpoints)
      ? raw.endpoints.map(e => ({
          task: str(e?.task), path: str(e?.path), protocol: str(e?.protocol) ?? 'unknown',
          inputSampleRate: e?.input_audio?.sample_rate_hz ?? null, outputSampleRate: e?.output_audio?.sample_rate_hz ?? null,
          options: Array.isArray(e?.options) ? e.options.filter(o => typeof o === 'string') : [],
        }))
      : [],
    streamingModes: Array.isArray(raw.streaming_modes)
      ? raw.streaming_modes.filter(m => typeof m?.mode === 'string').map(m => ({
          mode: m.mode,
          runtimeSupport: str(m.runtime_support) ?? 'unknown',
          nativeModelClaim: str(m.native_model_claim) ?? 'unknown',
          backend: verification(m.backend),
          desktop: verification(m.desktop),
          performance: performanceOf(m.performance),
        }))
      : [],
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map(d => ({ asset: str(d?.repo_or_asset), role: str(d?.role), required: d?.required === true, catalogRow: str(d?.catalog_row), downloadState: str(d?.download_state) }))
      : [],
    download: {
      state: str(download.state) ?? 'unknown',
      localBytes: int(download.local_bytes),
      expectedBytes: int(download.expected_bytes),
      verifiedAt: str(download.verified_at),
    },
    lifecycle: LIFECYCLE_STATES.includes(status.lifecycle) ? status.lifecycle : 'unknown',
    lifecycleReason: str(status.reason),
    blockedPrerequisite: str(status.blocked_prerequisite),
    acceptance: {
      backend: verification(acceptance.backend),
      desktop: verification(acceptance.desktop),
      missingModes: Array.isArray(acceptance.missing_modes) ? acceptance.missing_modes.filter(m => typeof m === 'string') : [],
      failedAttempts: Array.isArray(acceptance.failed_attempts) ? acceptance.failed_attempts.length : 0,
    },
    // Per-task evidence overlays (catalog `task_acceptance`) and the catalog's own roll-up (`acceptance_summary`).
    taskAcceptance: raw.task_acceptance && typeof raw.task_acceptance === 'object' && !Array.isArray(raw.task_acceptance)
      ? Object.fromEntries(Object.entries(raw.task_acceptance).filter(([task, v]) => typeof task === 'string' && v && typeof v === 'object').map(([task, v]) => [task, { backend: verification(v.backend), desktop: verification(v.desktop), performance: performanceOf(v.performance) }]))
      : {},
    acceptanceSummary: raw.acceptance_summary && typeof raw.acceptance_summary === 'object'
      ? {
          tasksTotal: int(raw.acceptance_summary.tasks_total), tasksBackend: counts(raw.acceptance_summary.tasks_backend), tasksDesktop: counts(raw.acceptance_summary.tasks_desktop),
          modesTotal: int(raw.acceptance_summary.modes_total), modesBackend: counts(raw.acceptance_summary.modes_backend), modesDesktop: counts(raw.acceptance_summary.modes_desktop),
          rowComplete: raw.acceptance_summary.row_complete === true,
        }
      : null,
    performance: performanceOf(raw.performance),
    hardware: {
      feasibility: str(raw.hardware?.feasibility) ?? 'unknown',
      estimatedWeightGiB: typeof raw.hardware?.estimated_weight_gib === 'number' ? raw.hardware.estimated_weight_gib : null,
    },
    sources: Array.isArray(raw.sources) ? raw.sources.slice(0, 20).map(s => ({ kind: str(s?.kind), ref: str(s?.ref), commit: str(s?.commit) })) : [],
    // Catalog-generated adapter model objects (TASK_CONTRACT §B/§E), referenced by recipes through `adapterModelId`.
    adapterModels: Array.isArray(raw.adapter_models) ? raw.adapter_models.filter(m => m !== null && typeof m === 'object' && typeof m.id === 'string') : [],
    // Per-variant Desktop/backend evidence (`adapter_model_acceptance`), kept apart from the row roll-up.
    adapterModelAcceptance: plain(raw.adapter_model_acceptance)
      ? Object.fromEntries(Object.entries(raw.adapter_model_acceptance).filter(([, v]) => plain(v)).map(([id, v]) => [id, { backend: verification(v.backend), desktop: verification(v.desktop) }]))
      : {},
    // Quantized/partition identity (checkpoint 0515): results never transfer between a quantized row and its base.
    weightIdentity: plain(model.weight_identity)
      ? {
          precision: str(model.weight_identity.precision), quantizationMethod: str(model.weight_identity.quantization_method),
          baseCheckpoint: str(model.weight_identity.base_checkpoint), baseRows: strings(model.weight_identity.base_rows_in_catalog),
          publisherRelation: str(model.weight_identity.publisher_relation), resultScope: str(model.weight_identity.result_scope),
        }
      : null,
    quantizedVariants: strings(model.quantized_variants_in_catalog),
    runtimeDefects: Array.isArray(raw.runtime_defects)
      ? raw.runtime_defects.filter(plain).slice(0, 20).map(d => ({
          id: str(d.defect_id), summary: str(d.summary)?.slice(0, 1200) ?? null,
          upstreamIssue: plain(d.upstream_issue) ? { url: str(d.upstream_issue.url), state: str(d.upstream_issue.state) } : null,
          upstreamFix: plain(d.upstream_fix) ? { url: str(d.upstream_fix.url), state: str(d.upstream_fix.state) } : null,
        }))
      : [],
    // Owner rate corrections: recorded vs corrected values with the unmodified raw files they came from.
    performanceProvenance: Array.isArray(raw.performance_provenance)
      ? raw.performance_provenance.filter(plain).slice(0, 50).map(p => ({
          scope: str(p.scope), key: str(p.key), layer: str(p.layer), metric: str(p.metric),
          ownerValue: Array.isArray(p.owner_value) || typeof p.owner_value === 'number' ? p.owner_value : null,
          note: str(p.owner_correction_note), reason: str(p.reason)?.slice(0, 600) ?? null, rawPolicy: str(p.raw_policy),
          correctionFile: str(p.correction_file), correctionSha256: str(p.correction_file_sha256), items: Array.isArray(p.items) ? p.items.length : 0,
        }))
      : [],
    dependencyCompleteness: plain(raw.dependency_completeness) ? { complete: raw.dependency_completeness.complete === true, open: Array.isArray(raw.dependency_completeness.open) ? raw.dependency_completeness.open.length : 0 } : null,
    notes: str(raw.notes),
  }
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value) {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []
}

/** Public recipe fields → normalized recipe. Endpoint binding facts are kept as published. */
export function normalizeRecipe(raw) {
  if (raw === null || typeof raw !== 'object' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(raw.id ?? ''))) return null
  return {
    id: raw.id,
    displayName: str(raw.displayName) ?? raw.id,
    catalogIds: Array.isArray(raw.catalogIds) ? raw.catalogIds.filter(c => typeof c === 'string') : [],
    runtime: raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {},
    port: int(raw.port),
    servedModels: Array.isArray(raw.servedModels) ? raw.servedModels.filter(m => typeof m === 'string') : [],
    typicalLoadSeconds: typeof raw.typicalLoadSeconds === 'number' ? raw.typicalLoadSeconds : null,
    startTimeoutSeconds: typeof raw.startTimeoutSeconds === 'number' ? raw.startTimeoutSeconds : null,
    memoryGiB: typeof raw.memoryGiB === 'number' ? raw.memoryGiB : null,
    notes: note(raw.notes),
    performance: performanceOf(raw.performance),
    endpoints: Array.isArray(raw.endpoints) ? raw.endpoints.filter(e => e && typeof e === 'object' && typeof e.task === 'string') : [],
  }
}

/**
 * Recipes on this server that serve a catalog row: the controller's `catalogIds`, or the
 * catalog's `runtime.docker_recipe_id`.
 */
export function recipesForRow(row, recipes) {
  return recipes.filter(recipe => recipe.catalogIds.includes(row.id) || (row.catalogRecipeId !== null && row.catalogRecipeId === recipe.id))
}

/** Rows that exist only as resident static routes (no catalog): used in static-endpoint mode. */
export function staticRow(route, model) {
  const mode = model.mode ?? 'chat'
  const task = mode === 'transcribe' ? 'asr' : mode === 'realtime' ? 'full_duplex_dialogue' : model.outputAudio ? 'spoken_chat_speech_reply' : 'audio_understanding_qa'
  return normalizeRow({
    id: `static:${route.provider}/${model.id}`,
    display_name: model.name ?? model.id,
    audio_role: 'primary',
    model: { hf_repo: model.upstreamModel ?? model.id, revision: 'unknown', access: 'unknown' },
    runtime: { engine: 'unknown', architecture: 'unknown' },
    tasks: [task],
    status: { lifecycle: 'unknown' },
    notes: `Configured manually in dsh-dgx-audio route "${route.provider}"; not in the catalog.`,
  })
}

// Text evidence that output speed is below real time. Only used to *label* owner/catalog notes; never to block.
const BELOW_REALTIME = /(below|slower than|less than|under)\s+real[- ]?time|\b0?\.\d+\s*(?:-\s*0?\.\d+\s*)?[x×]\s*real[- ]?time|not usable as live/i

/**
 * Informational advisories for one row and its recipes (CONTRACT §3, 0.1.1). Functional results and speed are kept
 * apart: `task-*`/`mode-*`/`row-*` report what the evidence says about function; `below-realtime` reports speed and names
 * its basis (`structured` factor or `note-text`). Nothing here changes bindability or activation.
 */
export function advisoriesFor(row, recipes = []) {
  const out = []
  const push = entry => out.push({ derived: 'structured', ...entry })
  // Every structured metric is reported as `speed-metric`; only a defined metric on one side of real time adds a
  // `below-realtime` advisory. Undefined metrics stay raw (`classification: unclassified`).
  const speedMetrics = (performance, base) => {
    // Accept normalized (`performanceOf`) or raw source objects.
    const normalized = Array.isArray(performance?.metrics) && performance.metrics.every(m => typeof m?.classification === 'string') ? performance : performanceOf(performance)
    for (const metric of normalized?.metrics ?? []) {
      push({ kind: 'speed-metric', ...base, metric })
      if (metric.classification === 'below-realtime') push({ kind: 'below-realtime', ...base, metric, text: metric.conditions })
    }
  }
  const speedFromText = (text, base) => {
    if (typeof text === 'string' && BELOW_REALTIME.test(text)) out.push({ kind: 'below-realtime', derived: 'note-text', text, ...base })
  }
  const backend = row.acceptance?.backend
  if (backend && ['fail', 'blocked'].includes(backend.state)) push({ kind: `row-${backend.state}`, scope: 'row', layer: 'backend', source: 'catalog', text: backend.notes ?? row.lifecycleReason })
  speedFromText(backend?.notes, { scope: 'row', layer: 'backend', source: 'catalog' })
  for (const [task, value] of Object.entries(row.taskAcceptance ?? {})) {
    for (const layer of ['backend', 'desktop']) {
      const v = value[layer]
      if (v && ['pass', 'fail', 'blocked', 'unsupported_reviewed'].includes(v.state)) push({ kind: `task-${v.state}`, scope: 'task', task, layer, source: 'catalog', text: v.notes })
      speedFromText(v?.notes, { scope: 'task', task, layer, source: 'catalog' })
    }
  }
  for (const mode of row.streamingModes ?? []) {
    for (const layer of ['backend', 'desktop']) {
      const v = mode[layer]
      if (v && ['fail', 'unsupported_reviewed'].includes(v.state)) push({ kind: `mode-${v.state}`, scope: 'mode', mode: mode.mode, layer, source: 'catalog', text: v.notes })
      speedFromText(v?.notes, { scope: 'mode', mode: mode.mode, layer, source: 'catalog' })
    }
  }
  speedMetrics(row.performance, { scope: 'row', source: 'catalog' })
  speedMetrics(row.acceptance?.backend?.performance, { scope: 'row', layer: 'backend', source: 'catalog' })
  speedMetrics(row.acceptance?.desktop?.performance, { scope: 'row', layer: 'desktop', source: 'catalog' })
  for (const [task, value] of Object.entries(row.taskAcceptance ?? {})) {
    speedMetrics(value.performance, { scope: 'task', task, source: 'catalog' })
    for (const layer of ['backend', 'desktop']) speedMetrics(value[layer]?.performance, { scope: 'task', task, layer, source: 'catalog' })
  }
  for (const mode of row.streamingModes ?? []) {
    speedMetrics(mode.performance, { scope: 'mode', mode: mode.mode, source: 'catalog' })
    for (const layer of ['backend', 'desktop']) speedMetrics(mode[layer]?.performance, { scope: 'mode', mode: mode.mode, layer, source: 'catalog' })
  }
  for (const recipe of recipes) {
    if (recipe.notes) {
      push({ kind: 'owner-note', scope: 'recipe', recipeId: recipe.id, source: 'recipe', text: recipe.notes })
      speedFromText(recipe.notes, { scope: 'recipe', recipeId: recipe.id, source: 'recipe' })
    }
    speedMetrics(recipe.performance, { scope: 'recipe', recipeId: recipe.id, source: 'recipe' })
    for (const endpoint of recipe.endpoints ?? []) {
      const text = note(endpoint.notes)
      if (text) {
        push({ kind: 'owner-note', scope: 'task', task: endpoint.task, recipeId: recipe.id, source: 'recipe', text })
        speedFromText(text, { scope: 'task', task: endpoint.task, recipeId: recipe.id, source: 'recipe' })
      }
      speedMetrics(performanceOf(endpoint.performance), { scope: 'task', task: endpoint.task, recipeId: recipe.id, source: 'recipe' })
    }
  }
  return out
}

