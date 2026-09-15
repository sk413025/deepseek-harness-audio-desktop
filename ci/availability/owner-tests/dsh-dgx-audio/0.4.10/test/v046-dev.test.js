// 0.4.6: catalog 0515 per-variant option statuses (requestOptionsMap / requestOptionsScope / requestOptionsEvidence) kept
// verbatim within bounds and turned into UI control obligations. A listed string is never "supported"; ignored / rejected /
// unsupported / unknown / unlisted never become active controls (TASK_CONTRACT §K.11). Pure config + capability document.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { AudioHub } from '../src/audio-hub.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { resolveConfig } from '../src/config.js'
import { LiveSessionManager } from '../src/live.js'
import { createRouteHandlers } from '../src/routes.js'
import { ioOf } from '../src/task-map.js'
import { tempDir } from './helpers/fixtures.js'

const fixture = JSON.parse(await readFile(new URL('./helpers/catalog-0515-option-variants.json', import.meta.url), 'utf8'))
const entry = id => structuredClone(fixture.entries.find(e => e.id === id))
const resolve = (...models) => resolveConfig({ outputDir: '/tmp/dgx-046', routes: [{ provider: 'lab', displayName: 'Lab', baseURL: 'http://127.0.0.1:9/v1', models }] })
const one = model => resolve(model).routes[0].models[0]

async function capabilityModels(models) {
  const config = resolveConfig({ outputDir: await tempDir('dgx-046-'), routes: [{ provider: 'lab', displayName: 'Lab', baseURL: 'http://127.0.0.1:9/v1', models }] })
  const hub = new AudioHub({ outputDir: () => config.outputDir, limits: { pingMs: 60_000 } })
  const capabilities = new CapabilityRegistry({ file: () => undefined })
  const live = new LiveSessionManager({ config: () => config, hub, capabilities, log: () => {} })
  const routes = createRouteHandlers({ config: () => config, hub, capabilities, live, log: () => {} })
  const res = await routes.find(r => r.path === '/api/dsh-dgx-audio/v1/capabilities').fetch(new Request('http://127.0.0.1:3080/api/dsh-dgx-audio/v1/capabilities'))
  return Object.fromEntries((await res.json()).routes[0].models.map(m => [m.id, m]))
}
const control = (doc, key) => doc.optionControls.controls.find(c => c.key === key)

test('catalog 0515 fixture is the pinned checkpoint', () => {
  assert.equal(fixture.sha256, 'ffa4946ed8a30bee6b4625dcc653b3990a3ab74b279f70246274bcea6e80dd67')
  assert.equal(fixture.catalogVersion, '1.0.0-full-census.202609150505')
})

test('requestOptionsMap / Scope / Evidence: accepted from real 0515 entries and published verbatim with optionControls', async () => {
  const docs = await capabilityModels(fixture.entries.map(e => structuredClone(e)))
  for (const e of fixture.entries) {
    const doc = docs[e.id]
    assert.deepEqual(doc.requestOptionsMap, e.requestOptionsMap, `${e.id} map verbatim`)
    assert.equal(doc.requestOptionsScope, e.requestOptionsScope, `${e.id} scope verbatim`)
    assert.deepEqual(doc.requestOptionsEvidence, e.requestOptionsEvidence, `${e.id} evidence verbatim`)
    assert.deepEqual(doc.requestOptions, e.requestOptions, `${e.id} raw list unchanged`)
    assert.equal(doc.optionControls?.contract, 'dsh-audio/option-controls@1')
    assert.equal(doc.optionControls.verified, false, 'a catalog status is never a verified capability')
    for (const c of doc.optionControls.controls) {
      assert.equal(c.verified, false)
      // Invariant: an active control never carries an unconditional negative status.
      if (c.active) assert.ok(!c.entries.some(x => ['ignored', 'rejected', 'unsupported', 'accepted-not-forwarded'].includes(x.status) && !x.conditional && x.sub === undefined), `${e.id}.${c.key}`)
      assert.equal(doc.io.obligations[c.key], c.obligation)
    }
  }
  // The catalog cut one raw string to a 200-char prefix of the full requestOptions entry: the source index is kept.
  const music = docs['minimax-music3-speech'].optionControls
  const cut = music.rawSources.findIndex(s => s?.match === 'prefix')
  assert.ok(cut >= 0 && docs['minimax-music3-speech'].requestOptions[music.rawSources[cut].index].startsWith(fixture.entries.find(e => e.id === 'minimax-music3-speech').requestOptionsMap[cut].raw))
  // Empty map with a scope sentence = unknown, not unsupported; no map = unknown; nothing active in either.
  const empty = docs['qwen3-asr-0-6b-realtime-asr'].optionControls
  assert.equal(empty.basis, 'catalog-map-empty')
  assert.ok(empty.controls.length > 0 && empty.controls.every(c => c.obligation === 'unknown' && c.reason === 'empty-map' && !c.active))
  assert.match(empty.source.scope, /unknown, not unsupported/)
  const bare = await capabilityModels([{ id: 'plain-tts', mode: 'speech' }])
  assert.equal(bare['plain-tts'].optionControls.basis, 'none')
  assert.ok(bare['plain-tts'].optionControls.controls.every(c => c.obligation === 'unknown' && c.reason === 'no-map' && !c.active))
})

test('bounds = library 0.1.3 REQUEST_OPTION_BOUNDS: a malformed field is dropped whole and reported; the model stays usable', () => {
  const base = entry('moss-ttsd-v1-0-speech-dialogue')
  const dropped = (patch, field) => {
    const model = one({ ...structuredClone(base), ...patch })
    assert.equal(model[field], undefined, `${field} dropped whole`)
    const doc = ioOf(model)
    assert.ok(model.requestOptionsInputErrors.some(e => e.field === field), `${field} error reported`)
    return { model, doc }
  }
  const { model } = dropped({ requestOptionsMap: 'ref_audio_2' }, 'requestOptionsMap')
  assert.equal(ioOf(model).input.referenceAudio2, 'none', 'no map → nothing active (raw strings are not read)')
  dropped({ requestOptionsMap: Array.from({ length: 401 }, () => ({ option: 'x', status: 'listed-by-source', raw: 'x' })) }, 'requestOptionsMap')
  dropped({ requestOptionsMap: [['ref_audio_2']] }, 'requestOptionsMap')
  dropped({ requestOptionsMap: [{ option: 'speed', status: 42, raw: 'speed' }] }, 'requestOptionsMap')
  dropped({ requestOptionsMap: [{ option: 'speed', status: 'listed-by-source' }] }, 'requestOptionsMap')
  dropped({ requestOptionsMap: [{ option: 'speed', status: 'listed-by-source', raw: 'r'.repeat(2001) }] }, 'requestOptionsMap')
  dropped({ requestOptionsMap: [{ option: 'x'.repeat(2001), status: 'listed-by-source', raw: '' }] }, 'requestOptionsMap')
  dropped({ requestOptionsScope: 7 }, 'requestOptionsScope')
  dropped({ requestOptionsScope: 's'.repeat(2001) }, 'requestOptionsScope')
  dropped({ requestOptionsEvidence: ['census'] }, 'requestOptionsEvidence')
  dropped({ requestOptionsEvidence: { source: 'census', blob: 'e'.repeat(16384) } }, 'requestOptionsEvidence')
  assert.equal(one({ ...structuredClone(base), requestOptionsScope: '' }).requestOptionsScope, undefined, 'a blank top-level string is "not set" (config-wide rule)')
  // Kept verbatim at the bound, nested nulls removed like library withoutNulls, unknown extra keys kept (never interpreted).
  const long = 'r'.repeat(2000)
  const kept = one({ ...structuredClone(base), requestOptionsMap: [{ option: 'speed', status: 'listed-by-source', raw: long, detail: null, note: 'x' }, null], requestOptionsEvidence: { source: 'census', row_sources: ['a', null], extra: 1 } })
  assert.deepEqual(kept.requestOptionsMap, [{ option: 'speed', status: 'listed-by-source', raw: long, note: 'x' }])
  assert.deepEqual(kept.requestOptionsEvidence, { source: 'census', row_sources: ['a'], extra: 1 })
  assert.equal(kept.requestOptionsInputErrors, undefined)
  assert.throws(() => one({ ...structuredClone(base), requestOptions: 'ref_audio_2' }), /requestOptions must be an array/, 'the 0.4.5 requestOptions rule is unchanged')
})

test('status → obligation: listed is an unverified offer; negatives, unknown, unlisted and raw-only strings are never active', () => {
  const speech = map => one({ id: 's', mode: 'speech', requestOptions: map.map(m => m.raw), requestOptionsMap: map })
  const doc = speech([
    { option: 'voice', status: 'listed-restricted', raw: "voice (only null or 'default')" },
    { option: 'voice other than default', status: 'rejected', detail: 'voice other than default', raw: 'REJECTED: voice other than default' },
    { option: 'speed != 1.0', status: 'rejected', detail: 'speed != 1.0', raw: 'REJECTED: speed != 1.0' },
    { option: 'seed', status: 'listed-by-source', raw: 'seed' },
    { option: 'language', status: 'ignored', detail: 'language', raw: 'IGNORED: language' },
    { option: 'instructions/language', status: 'unsupported', detail: 'instructions/language (not forwarded)', raw: 'NOT supported: instructions/language' },
    { option: 'task_type', status: 'accepted-not-forwarded', raw: 'task_type (accepted, not forwarded)' },
    { option: 'ref_text', status: 'required-conditional', raw: 'ref_text (required unless x_vector_only_mode)' },
    { option: 'ref_audio', status: 'required', raw: 'ref_audio (required)' },
    { option: 'sample_rate', status: 'listed-by-source', raw: 'sample_rate' },
    { option: 'sample_rate', status: 'rejected', detail: 'sample_rate', raw: 'REJECTED: sample_rate' },
    { option: 'max_new_tokens', status: 'unknown', raw: 'max_new_tokens (unvalidated)' },
    { option: 'response_format', status: 'future-status', raw: 'response_format' },
    { option: '--runner', status: 'deploy-flag', raw: '--runner pooling' },
    { option: 'short_edge', status: 'required', raw: 'short_edge (must be 768)' },
  ])
  const { optionControls: oc } = { optionControls: ioOf(doc).obligations }
  assert.deepEqual({ voice: oc.voice, speed: oc.speed, seed: oc.seed, language: oc.language, instructions: oc.instructions, taskType: oc.taskType, refText: oc.refText, referenceAudio: oc.referenceAudio, sampleRate: oc.sampleRate, maxNewTokens: oc.maxNewTokens, responseFormat: oc.responseFormat, wordTimestamps: oc.wordTimestamps }, {
    voice: 'offer-restricted', speed: 'rejected-conditional', seed: 'offer-unverified', language: 'unsupported', instructions: 'unsupported', taskType: 'not-forwarded',
    refText: 'required-conditional', referenceAudio: 'required', sampleRate: 'conflict', maxNewTokens: 'unknown', responseFormat: 'unknown', wordTimestamps: 'unlisted',
  })
})

test('references and word timestamps: from status on HTTP, with the WS differences (not-sendable, deployment clip, live.words)', async () => {
  const docs = await capabilityModels([
    entry('moss-ttsd-v1-0-speech-dialogue'), entry('moss-ttsd-v1-0-speech'), entry('indextts-2-speech'), entry('indextts-2-speech-ws'),
    entry('qwen3-tts-12hz-1-7b-customvoice-speech-word-timestamps'), entry('glm-tts-speech-ws'), entry('minimax-h3-video'),
  ])
  const dialogue = docs['moss-ttsd-v1-0-speech-dialogue']
  assert.equal(dialogue.io.input.referenceAudio2, 'optional')
  assert.equal(control(dialogue, 'referenceAudio2').obligation, 'offer-unverified')
  assert.equal(docs['moss-ttsd-v1-0-speech'].io.input.referenceAudio2, 'none')
  assert.equal(control(docs['moss-ttsd-v1-0-speech'], 'referenceAudio2').obligation, 'unlisted')
  const index = docs['indextts-2-speech']
  assert.equal(index.io.input.emotionAudio, 'optional')
  assert.deepEqual([control(index, 'emotionAudio').obligation, control(index, 'emotionAudio').wireKey], ['offer-unverified', 'extra_params.emo_audio'])
  assert.equal(control(index, 'refText').obligation, 'ignored')
  assert.equal(control(index, 'referenceAudio').obligation, 'required-conditional')
  assert.equal(control(index, 'extraParams').obligation, 'offer-unverified', 'listed extra_params.* sub-options offer the free-form object')
  const wt = docs['qwen3-tts-12hz-1-7b-customvoice-speech-word-timestamps']
  assert.equal(wt.io.output.transcript.wordTimestamps, true)
  assert.deepEqual([control(wt, 'wordTimestamps').obligation, control(wt, 'wordTimestamps').delivery], ['offer-unverified', 'final-header'])

  // WS: ref_audio is a deployment clip (realtime.refAudioFile), not a control; required without it = blocker.
  const ws = docs['indextts-2-speech-ws'].optionControls
  assert.equal(ws.family, 'realtime:omni-speech-ws')
  assert.equal(ws.controls.find(c => c.key === 'referenceAudio'), undefined)
  assert.deepEqual(ws.hostOptions.find(o => o.wireKey === 'ref_audio'), { index: 1, option: 'ref_audio', wireKey: 'ref_audio', status: 'required-conditional', controlledBy: 'realtime.refAudioFile', satisfiedBy: 'realtime.refAudioFile', satisfied: false })
  assert.ok(docs['glm-tts-speech-ws'].optionControls.blockers.some(b => b.wireKey === 'ref_audio' && b.status === 'required' && !b.conditional))
  const withClip = one({ ...entry('glm-tts-speech-ws'), realtime: { ...entry('glm-tts-speech-ws').realtime, refAudioFile: '/tmp/ref.wav' } })
  const { optionControlsOf } = await import('../src/option-controls.js')
  assert.equal(optionControlsOf(withClip).blockers.length, 0)
  // Video: a required option the adapter has no key for is a blocker, not a silent drop.
  assert.ok(docs['minimax-h3-video'].optionControls.blockers.some(b => b.option === 'short_edge' && b.reason === 'no adapter key for a required option'))

  // A WS map naming ref_audio_2 / extra_params.emo_audio / word_timestamps: the first two are not sendable on the session.
  const wsSynthetic = one({
    id: 'ws', mode: 'realtime', wire: 'omni-speech-ws', requestOptionsMap: [
      { option: 'ref_audio_2', status: 'listed-by-source', raw: 'ref_audio_2' },
      { option: 'extra_params.emo_audio', status: 'listed-by-source', raw: 'extra_params.emo_audio' },
      { option: 'word_timestamps', status: 'listed-by-source', raw: 'word_timestamps' },
    ],
  })
  const wsDoc = optionControlsOf(wsSynthetic)
  assert.deepEqual(wsDoc.notSendable.map(x => x.wireKey), ['ref_audio_2', 'extra_params'])
  assert.deepEqual([wsDoc.controls.find(c => c.key === 'wordTimestamps').obligation, wsDoc.controls.find(c => c.key === 'wordTimestamps').delivery], ['offer-unverified', 'live.words'])
  assert.equal(ioOf(wsSynthetic).output.transcript.wordTimestamps, true)
})

test('0.4.5 raw-string reading is gone: a listed string whose status is not positive never yields io support', () => {
  // The raw list names ref_audio_2 / extra_params.emo_audio / word_timestamps, but the variant map says unknown/ignored/rejected.
  const model = one({
    id: 'raw-vs-status', mode: 'speech',
    requestOptions: ['ref_audio_2', 'extra_params.emo_audio', 'word_timestamps (unvalidated)'],
    requestOptionsMap: [
      { option: 'ref_audio_2', status: 'unknown', raw: 'ref_audio_2' },
      { option: 'extra_params.emo_audio', status: 'ignored', raw: 'extra_params.emo_audio' },
      { option: 'word_timestamps', status: 'rejected', raw: 'word_timestamps (unvalidated)' },
    ],
  })
  const io = ioOf(model)
  assert.deepEqual([io.input.referenceAudio2, io.input.emotionAudio, io.output.transcript.wordTimestamps], ['none', 'none', false])
  assert.deepEqual([io.obligations.referenceAudio2, io.obligations.emotionAudio, io.obligations.wordTimestamps], ['unknown', 'ignored', 'rejected'])
  // Raw strings alone (no map) are not classified.
  const rawOnly = ioOf(one({ id: 'raw-only', mode: 'speech', requestOptions: ['ref_audio_2', 'word_timestamps'] }))
  assert.deepEqual([rawOnly.input.referenceAudio2, rawOnly.output.transcript.wordTimestamps, rawOnly.obligations.referenceAudio2], ['none', false, 'unknown'])
})

test('settings form: schema-filled blanks are "not set"; an entered map round-trips through schemastery unchanged', async () => {
  const { default: z } = await import('@deepseek-ai/schemastery')
  const { settingsSchema } = await import('../src/settings.js')
  const e = entry('indextts-2-speech')
  const value = settingsSchema(z)({ routes: [{ provider: 'p', displayName: 'P', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'blank', mode: 'speech' }, { ...e }] }] })
  const [blank, filled] = resolveConfig({ outputDir: '/tmp/dgx-046', ...value }).routes[0].models
  assert.deepEqual([filled.requestOptionsMap, filled.requestOptionsScope, filled.requestOptionsEvidence], [e.requestOptionsMap, e.requestOptionsScope, e.requestOptionsEvidence])
  assert.deepEqual([blank.requestOptionsMap, blank.requestOptionsEvidence], [undefined, undefined])
  const { optionControlsOf } = await import('../src/option-controls.js')
  assert.equal(optionControlsOf(blank).basis, 'none')
})
