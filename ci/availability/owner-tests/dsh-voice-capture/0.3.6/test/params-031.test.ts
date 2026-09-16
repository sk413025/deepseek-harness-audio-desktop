// dsh-voice-capture 0.3.1 behaviour kept in 0.3.2 for hosts without option controls (TASK_CONTRACT 0.2 §J, host 0.4.2
// descriptors): per-model values, deployment-configured and server-reported parameters, word timestamps and host receipt
// reasons. Since 0.3.2 (§K.11) catalog request option strings never produce a control or an input slot.
// Fixtures: descriptors generated from the frozen host 0.4.2 package; request option strings copied from catalog.v1.json.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CapabilityDocument, CapabilityModel } from '../src/client/audio/api.ts'
import { LiveController } from '../src/client/audio/live.ts'
import { parseAudioResults } from '../src/client/audio/results.ts'
import { TaskInputsController } from '../src/client/audio/task-controller.ts'
import { rendersControl } from '../src/client/audio/options.ts'
import { missingInputs, offerOf, resolveOptions, taskView } from '../src/client/audio/tasks.ts'
import type { CaptureBackend, CaptureOpenOptions } from '../src/client/capture.ts'

const DOC = JSON.parse(readFileSync(new URL('./fixtures-host042-capabilities.json', import.meta.url), 'utf8')) as CapabilityDocument
const CATALOG = JSON.parse(readFileSync(new URL('./fixtures-catalog-request-options.json', import.meta.url), 'utf8')) as { rows: Record<string, { request_options: string[] }> }
const entry = (id: string) => DOC.routes[0]!.models.find(m => m.id === id)!
const withOptions = (id: string, row: string): CapabilityModel => ({ ...entry(id), requestOptions: CATALOG.rows[row]!.request_options } as CapabilityModel)
const S = 'session-031' as SessionId
/** Host ≥ 0.4.6 option controls for a few keys (§K.11 shape), everything else unlisted. */
const withControls = (base: CapabilityModel, active: Record<string, { kind?: 'param' | 'attachment'; mandatory?: boolean }>): CapabilityModel => ({
  ...base,
  optionControls: {
    contract: 'dsh-audio/option-controls@1', family: 'speech', endpoint: 'POST /v1/audio/speech', basis: 'catalog-map', verified: false, source: { map: 'requestOptionsMap', scope: null, evidence: null },
    controls: Object.entries(active).map(([key, c]) => ({ key, wireKey: key, kind: c.kind ?? 'param', obligation: c.mandatory === true ? 'required' : 'offer-unverified', active: true, mandatory: c.mandatory === true, verified: false, reason: 'catalog-listed-by-source', statuses: ['listed-by-source'], entries: [], conditions: [], deploymentDefault: false })),
    hostOptions: [], notSendable: [], unmapped: [], blockers: [], inputErrors: [],
  },
} as CapabilityModel)
const shownOf = (view: ReturnType<typeof taskView>, voices?: readonly string[]) => view.params.filter(p => rendersControl(offerOf(view, p, voices))).map(p => `${p.key}:${offerOf(view, p, voices)}`)

test('host 0.4.2 (no option controls): deployment-configured or server-reported parameters only; request option strings add nothing', () => {
  const plain = taskView(entry('tts-custom'))
  assert.equal(plain.options.source, 'none')
  assert.deepEqual(shownOf(plain), ['voice:offered-configured', 'taskType:offered-configured'], 'deployment-set keys only; speed/seed/wordTimestamps hidden without evidence')
  const clone = taskView(entry('tts-clone'))
  const voice = clone.params.find(p => p.key === 'voice')!
  assert.equal(offerOf(clone, voice), 'unknown')
  assert.equal(offerOf(clone, voice, []), 'unknown', 'an empty server list is not support')
  assert.equal(offerOf(clone, voice, ['vivian', 'ryan']), 'offered-server')
  // §K.11: strings (listed, annotated or "rejected:") are never read — the result equals the entry without them.
  for (const row of ['Qwen3-TTS-12Hz-1.7B-CustomVoice', 'MiniMax-Music3', 'MOSS-SoundEffect']) {
    assert.deepEqual(shownOf(taskView(withOptions('tts-custom', row))), shownOf(plain), row)
  }
  const duplex = taskView(entry('rt-duplex'))
  assert.deepEqual(shownOf(duplex), [], 'realtime params need evidence too')
})

test('range descriptors: integers published as number+step 1 are sent as integers; speed is clamped; extraParams must be a JSON object', () => {
  const view = taskView(entry('tts-custom'))
  assert.deepEqual(
    resolveOptions(view.params, { maxNewTokens: 512.6, seed: '41.5', speed: 9, sampleRate: 0, initialCodecChunkFrames: -3, wordTimestamps: true, extraParams: '{"cfg_scale": 2}' }, false),
    { maxNewTokens: 513, seed: 42, speed: 4, sampleRate: 1, initialCodecChunkFrames: 0, wordTimestamps: true, extraParams: { cfg_scale: 2 } },
  )
  assert.deepEqual(resolveOptions(view.params, { extraParams: '[1,2]', durationSeconds: -1 }, false), { durationSeconds: 0 })
  assert.deepEqual(resolveOptions(view.params, { extraParams: 'not json' }, false), {})
})

test('extra reference slots exist only through an active control; ambient sound replaces the text input', () => {
  assert.equal(taskView(entry('tts-clone')).input.referenceAudio2, 'none')
  assert.equal(taskView(withOptions('tts-clone', 'MOSS-TTSD')).input.referenceAudio2, 'none', 'a listed ref_audio_2 string is not a slot')
  const ttsd = taskView(withControls(entry('tts-clone'), { referenceAudio2: { kind: 'attachment' } }))
  assert.equal(ttsd.input.referenceAudio2, 'optional')
  assert.equal(ttsd.input.emotionAudio, 'none')
  const index = taskView(withControls(entry('tts-clone'), { emotionAudio: { kind: 'attachment' } }))
  assert.equal(index.input.emotionAudio, 'optional')
  const draft = { text: '', hasAudio: false, hasReference: true, referenceConsent: true, referenceText: '' }
  assert.deepEqual(missingInputs(index, { ...draft, text: 'hi', extraReferences: { emotionAudio: { present: true, consent: false } } }), ['referenceConsent'])
  const sound = taskView(entry('tts-custom'))
  assert.deepEqual(missingInputs(sound, { ...draft, hasReference: false }), ['text'])
  assert.deepEqual(missingInputs(sound, { ...draft, hasReference: false, options: { ambientSound: 'rain on a tin roof' } }), [])
})

test('values are kept per model; consented slots are uploaded in slot order and named in the options block', async () => {
  const uploads: string[] = []
  const prompts: unknown[] = []
  const controller = new TaskInputsController(
    { async upload(_s, data, name) { uploads.push(`${name}:${data.size}`); return { ok: true, value: { receiptId: `rcpt-${uploads.length}`, file: { attachmentId: `a${uploads.length}`, name, bytes: data.size } } } as never } },
    { binding: () => ({ session: {
      beginSubmission: () => ({ requestId: 'req' as never, abandon: () => {} }),
      prompt: async (content: unknown) => { prompts.push(content); return { ok: true, value: { accepted: true } } as never },
    } }) },
    undefined,
    () => Date.UTC(2026, 8, 15, 4, 10, 0),
  )
  const ttsd = taskView(withControls(entry('tts-clone'), { referenceAudio2: { kind: 'attachment' }, emotionAudio: { kind: 'attachment' } }))
  controller.setValue(S, 'tts-clone', 'seed', 7)
  controller.setValue(S, 'tts-custom', 'voice', 'ryan')
  assert.equal(JSON.parse(controller.extras(S, 'tts-custom', taskView(entry('tts-custom'))).block!.split('\n')[1]!).seed, undefined, 'no carry-over between models')
  const wav = (n: number) => new Blob([new Uint8Array(n)], { type: 'audio/wav' })
  controller.setReference(S, wav(10), 'file', 'a.wav', 'referenceAudio')
  controller.setReference(S, wav(20), 'file', 'b.wav', 'referenceAudio2')
  controller.setReference(S, wav(30), 'file', 'c.wav', 'emotionAudio')
  controller.setConsent(S, true, 'referenceAudio')
  controller.setConsent(S, true, 'referenceAudio2')
  assert.deepEqual(controller.extras(S, 'tts-clone', ttsd).references.map(r => r.slot), ['referenceAudio', 'referenceAudio2'], 'the unconsented emotion clip is not sent')
  controller.setConsent(S, true, 'emotionAudio')
  const extras = controller.extras(S, 'tts-clone', ttsd)
  const block = JSON.parse(extras.block!.split('\n')[1]!) as Record<string, string>
  assert.match(block.referenceAudio!, /^reference-voice-\d{8}-\d{6}\.wav$/)
  assert.match(block.referenceAudio2!, /^reference-voice-2-\d{8}-\d{6}\.wav$/)
  assert.match(block.emotionAudio!, /^emotion-reference-\d{8}-\d{6}\.wav$/)
  assert.equal(block.seed, 7 as unknown as string)
  assert.equal(await controller.generate(S, 'tts-clone', ttsd, 'Two voices.'), true)
  assert.deepEqual(uploads.map(u => u.split(':')[1]), ['10', '20', '30'])
  assert.deepEqual((prompts[0] as { type: string }[]).map(p => p.type), ['file', 'file', 'file', 'text'])
  controller.clearReference(S, 'referenceAudio2')
  assert.equal(controller.source(S).getSnapshot().references.referenceAudio2, undefined)
  assert.equal(controller.source(S).getSnapshot().reference?.name, block.referenceAudio, 'the main slot is mirrored for the reference box')
  controller.dispose()
})

test('word timestamps and used params are read from the result block', () => {
  const text = 'Speech generated · 3 word timestamps.\n```dsh-audio-result\n' + JSON.stringify({
    v: 1, task: 'tts', outputs: [{ kind: 'audio', role: 'speech', recordingId: 'rec_1', delivery: 'final-only' }],
    params: { speed: 1.25, wordTimestamps: true },
    wordTimestamps: { state: 'aligned', words: [{ word: 'Hello', startMs: 0, endMs: 320 }, { word: 'there', startMs: 330, endMs: 600 }, { word: 'bad', startMs: 'x', endMs: 1 }] },
  }) + '\n```'
  const [result] = parseAudioResults(text, 3)
  assert.deepEqual(result!.wordTimestamps, { state: 'aligned', words: [{ word: 'Hello', startMs: 0, endMs: 320 }, { word: 'there', startMs: 330, endMs: 600 }] })
  assert.deepEqual(result!.params, { speed: 1.25, wordTimestamps: true })
  const [omitted] = parseAudioResults('```dsh-audio-result\n{"v":1,"task":"tts","outputs":[],"wordTimestamps":{"state":"omitted","words":[]}}\n```', 4)
  assert.equal(omitted!.wordTimestamps!.state, 'omitted')
})

class NoCapture implements CaptureBackend {
  support() { return undefined }
  async listDevices() { return [] }
  onDeviceChange() { return () => {} }
  async open(options: CaptureOpenOptions) { return { sampleRate: options.sampleRate ?? 16000, deviceLabel: 'fixture', deviceId: '', close: async () => {} } }
}

test('host 0.4.2 receipt reasons explain an exchange that was not recorded', async () => {
  const close = { ok: true, input: { recordingId: 'rec', bytes: 10, sha256: 'x', receiptId: null }, receipt: { state: 'unavailable', reason: 'host-file-uploads-unavailable' } }
  const fetchImpl = async (url: string) => {
    if (url.includes('/live/open')) return new Response(JSON.stringify({ ok: true, liveId: 'L', task: 'duplex', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 } }))
    if (url.includes('/live/close')) return new Response(JSON.stringify(close))
    return new Response('{"ok":true}')
  }
  const live = new LiveController(new NoCapture(), fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'p', model: 'm' }, 'declared', false)
  await live.endInput()
  await live.close()
  assert.equal(live.source.getSnapshot().logDetail, 'host-file-uploads-unavailable')
  live.dismiss()
  close.receipt = { state: 'skipped', reason: 'no-response' }
  await live.start(S, { provider: 'p', model: 'm' }, 'declared', false)
  await live.endInput()
  await live.close()
  assert.equal(live.source.getSnapshot().logDetail, 'no-reply')
})

test('the playback feed keeps the adapter task, so generated speech is not labelled a spoken reply', async () => {
  const { ProgressivePlayer } = await import('../src/client/audio/player.ts')
  const output = { now: () => 0, schedule: () => ({ stop: () => {} }), resume: async () => {}, close: async () => {} }
  const player = new ProgressivePlayer((() => output) as never)
  player.handle({ type: 'audio.start', streamId: 's1', origin: 'chat', task: 'tts.speech' })
  assert.equal(player.source.getSnapshot().task, 'tts.speech')
  player.handle({ type: 'audio.start', streamId: 's2', origin: 'chat' })
  assert.equal(player.source.getSnapshot().task, undefined, 'older hosts send no task')
  await player.dispose()
})
