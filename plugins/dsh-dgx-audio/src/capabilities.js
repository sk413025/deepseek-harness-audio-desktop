// Per-route/model capability registry (CONTRACT.md §2).
//
// Model architecture, serving implementation and this host's observations are kept apart:
// configuration may only *declare* a capability, a server handshake (realtime
// `session.created`) only makes it `advertised`, and only functional wire evidence observed
// by this host (a request, an explicit probe, a live session) makes it `verified`.
// Evidence is keyed by baseURL + upstream model and is ignored after either changes.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CAPABILITY_KEYS = Object.freeze([
  'textStreaming', 'audioOutput', 'audioOutputStreaming', 'liveInput', 'fullDuplex', 'bargeIn', 'playbackAck', 'sessionResume',
])
/** Weakest → strongest evidence. `advertised` = the server announced it; only `verified` means observed working. */
export const CAPABILITY_STATES = Object.freeze(['unsupported', 'untested', 'declared', 'advertised', 'verified'])

/** Declared value from config: `true` → declared, `false` → unsupported, absent → untested. */
function declaredState(value) {
  if (value === true || value === 'declared' || value === 'supported') return 'declared'
  if (value === false || value === 'unsupported') return 'unsupported'
  return 'untested'
}

export class CapabilityRegistry {
  /**
   * @param {{ file?: () => string | undefined, now?: () => number, log?: (m: string) => void }} [options]
   */
  constructor(options = {}) {
    this.file = options.file ?? (() => undefined)
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    /** @type {Map<string, Record<string, any>>} */
    this.evidence = new Map()
    this.loaded = false
    this.saving = Promise.resolve()
  }

  /**
   * Evidence key. Output modality is part of it: the same server/model can stream text
   * token-by-token for a text-only request yet send it as one delta when speech is requested
   * (observed on vLLM-Omni 0.28 MiniCPM-o 4.5, I1 2026-09-15).
   */
  static fingerprint(route, model) {
    const modality = model.mode === 'chat' && model.outputAudio === true ? 'text+audio'
      : model.mode === 'realtime' ? `live:${model.realtime?.wire ?? 'omni-duplex'}`
        : model.mode === 'speech' || model.mode === 'generate-audio' ? 'audio' : model.mode === 'generate-video' ? 'video' : 'text'
    // deploymentId (model-library S-4) separates two runtimes of one upstream model on the same URL.
    return `${route.baseURL.replace(/\/+$/, '')}|${model.upstreamModel ?? model.id}|${model.mode}|${modality}${model.deploymentId ? `|${model.deploymentId}` : ''}`
  }

  /** Load persisted evidence once; concurrent callers share one read. Observations made meanwhile win. */
  load() {
    this.loading ??= (async () => {
      const file = this.file()
      if (!file) return
      try {
        const json = JSON.parse(await readFile(file, 'utf8'))
        for (const [key, value] of Object.entries(json.evidence ?? {})) if (!this.evidence.has(key)) this.evidence.set(key, value)
      } catch { /* first run or unreadable evidence: start empty */ }
      this.loaded = true
    })()
    return this.loading
  }

  /**
   * Record one wire observation.
   * @param {any} route @param {any} model
   * @param {string} key - capability key.
   * @param {{ state: 'verified' | 'unsupported' | 'advertised', source: 'request' | 'probe' | 'live' | 'server-session', detail?: string, [extra: string]: any }} observation
   */
  observe(route, model, key, observation) {
    const fp = CapabilityRegistry.fingerprint(route, model)
    const entry = this.evidence.get(fp) ?? {}
    const previous = entry[key]
    // A later handshake never downgrades functional evidence already observed.
    if (observation.state === 'advertised' && previous?.state === 'verified') {
      entry[key] = { ...previous, advertisedAt: new Date(this.now()).toISOString(), ...(observation.implementationLevel === undefined ? {} : { implementationLevel: observation.implementationLevel }) }
    } else {
      entry[key] = { ...previous, ...observation, checkedAt: new Date(this.now()).toISOString() }
    }
    this.evidence.set(fp, entry)
    this.persist()
  }

  /** Merge a non-state fact (e.g. observedDelivery) without changing the state. */
  note(route, model, key, facts) {
    const fp = CapabilityRegistry.fingerprint(route, model)
    const entry = this.evidence.get(fp) ?? {}
    entry[key] = { ...entry[key], ...facts, checkedAt: new Date(this.now()).toISOString() }
    this.evidence.set(fp, entry)
    this.persist()
  }

  /** Stored evidence for one capability (undefined when none). */
  evidenceFor(route, model, key) {
    return this.evidence.get(CapabilityRegistry.fingerprint(route, model))?.[key]
  }

  /** Drop all evidence for the given routes/models (runtime swap that keeps URL and model id). */
  reset(pairs) {
    let removed = 0
    for (const { route, model } of pairs) if (this.evidence.delete(CapabilityRegistry.fingerprint(route, model))) removed += 1
    if (removed > 0) this.persist()
    return removed
  }

  persist() {
    const file = this.file()
    if (!file) return
    const body = JSON.stringify({ version: 1, evidence: Object.fromEntries(this.evidence) }, null, 2)
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, body)
      } catch (error) {
        this.log(`dsh-dgx-audio: cannot save capability evidence: ${error?.message ?? error}`)
      }
    })
  }

  /**
   * Effective capability document for one model.
   * @param {any} route @param {any} model
   */
  describe(route, model) {
    const declared = model.capabilities ?? {}
    const observed = this.evidence.get(CapabilityRegistry.fingerprint(route, model)) ?? {}
    const out = {}
    for (const key of CAPABILITY_KEYS) {
      const structural = structuralState(model, key)
      const seen = observed[key]
      let state
      let source
      if (structural !== undefined) {
        state = structural.state
        source = 'config'
      } else if (seen?.state === 'verified' || seen?.state === 'unsupported' || seen?.state === 'advertised') {
        state = seen.state
        source = seen.source
      } else {
        state = declaredState(declared[key])
        source = state === 'untested' ? 'none' : 'config'
        if (state === 'untested' && modeDeclares(model, key)) {
          // I2-A #1: configuring a realtime model is itself the declaration; still never verified without evidence.
          state = 'declared'
          source = 'config:mode'
        }
      }
      const fromHistory = structural === undefined && seen !== undefined && seen.state === state && seen.source === source
      out[key] = {
        state,
        source,
        // Evidence-derived states are deployment history (every model entry with this fingerprint shares them):
        // `observedBy` names the connection that produced it. Never read this as "verified by the current connection".
        scope: structural !== undefined ? 'config' : fromHistory ? 'deployment' : state === 'untested' ? null : 'config',
        ...(fromHistory && seen.observedBy ? { observedBy: seen.observedBy } : {}),
        detail: structural?.detail ?? seen?.detail ?? (source === 'config:mode' ? `declared by the ${model.realtime?.wire ?? 'omni-duplex'} realtime configuration; not verified` : null),
        checkedAt: structural === undefined ? seen?.checkedAt ?? null : null,
        ...(key === 'audioOutputStreaming' ? { observedDelivery: seen?.observedDelivery ?? null } : {}),
        ...(key === 'fullDuplex' ? { implementationLevel: seen?.implementationLevel ?? null } : {}),
      }
    }
    return out
  }

  /**
   * Whether a request should use SSE for text: `off` → never; `sse` → always;
   * `auto` → unless this host has observed the server refuse streaming.
   */
  wantsTextStream(route, model) {
    const mode = model.streaming?.text ?? 'auto'
    if (mode === 'off') return false
    if (mode === 'sse') return true
    const seen = this.evidence.get(CapabilityRegistry.fingerprint(route, model))?.textStreaming
    return !(seen?.state === 'unsupported' && seen.source === 'request')
  }
}

/** Capabilities a realtime model entry declares by its wire alone (explicit `capabilities` config still wins). */
function modeDeclares(model, key) {
  if (model.mode !== 'realtime') return false
  const wire = model.realtime?.wire ?? 'omni-duplex'
  switch (key) {
    case 'liveInput': return wire !== 'omni-speech-ws'
    case 'audioOutput': return wire !== 'vllm-asr'
    case 'fullDuplex': return wire === 'omni-duplex'
    default: return false
  }
}

/** Capabilities fixed by the configured model shape, independent of any server. */
function structuralState(model, key) {
  const realtime = model.mode === 'realtime'
  const wire = model.realtime?.wire ?? 'omni-duplex'
  const audioOut = (model.mode === 'chat' && model.outputAudio) || model.mode === 'speech' || model.mode === 'generate-audio' || (realtime && wire !== 'vllm-asr') || (model.mode === 'generate-video' && model.video?.generateSound !== false)
  switch (key) {
    case 'audioOutput':
    case 'audioOutputStreaming':
      // No audio+video model streams progressively (catalog review §3): the sound track arrives inside the final MP4.
      if (key === 'audioOutputStreaming' && model.mode === 'generate-video') return { state: 'unsupported', detail: 'video with sound is delivered as one final MP4' }
      if (!audioOut) {
        const why = model.mode === 'transcribe' || model.mode === 'translate' ? `${model.mode} endpoint returns text only`
          : model.mode === 'align' ? 'forced aligner returns word timestamps only'
          : realtime ? 'realtime transcription wire returns text only' : 'model entry does not request speech output'
        return { state: 'unsupported', detail: why }
      }
      return undefined
    case 'textStreaming':
      if (model.streaming?.text === 'off') return { state: 'unsupported', detail: 'streaming.text is off for this model' }
      if (model.mode === 'speech' || model.mode === 'generate-audio') return { state: 'unsupported', detail: `${model.mode} returns audio, not text` }
      if (model.mode === 'align') return { state: 'unsupported', detail: '/pooling returns one JSON body (word timestamps), not a text stream' }
      if (model.mode === 'generate-video') return { state: 'unsupported', detail: '/v1/videos returns an MP4, not text' }
      if (wire === 'omni-speech-ws' && realtime) return { state: 'unsupported', detail: 'speech stream-input wire returns audio' }
      return undefined
    case 'liveInput':
      if (!realtime) return { state: 'unsupported', detail: `${model.mode} mode sends complete requests over HTTP` }
      if (wire === 'omni-speech-ws') return { state: 'unsupported', detail: 'speech stream-input takes incremental text, not live audio' }
      return undefined
    case 'fullDuplex':
    case 'bargeIn':
    case 'playbackAck':
    case 'sessionResume':
      if (!realtime) return { state: 'unsupported', detail: `${model.mode} mode sends complete requests over HTTP` }
      if (wire !== 'omni-duplex') return { state: 'unsupported', detail: `${wire} is a turn-based realtime wire, not the duplex protocol` }
      return undefined
    default:
      return undefined
  }
}
