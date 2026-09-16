// Interop with dsh-dgx-audio 0.4.0 (TASK_CONTRACT 0.2) and the model-library client service, plus the
// release I2-A findings (OWNER_HANDOFF_I2A.md #1, #2, #3, #4, #6). The capability fixture is generated from
// the frozen host package by parallel-work/microphone-ui/fixtures/gen-host040-capabilities.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CapabilityDocument } from '../src/client/audio/api.ts'
import { deriveFeatures } from '../src/client/audio/capabilities.ts'
import { ActivationBoard, combineGate, gateBlocks, parseGate } from '../src/client/audio/gate.ts'
import type { AudioModelLibraryFace } from '../src/client/audio/gate.ts'
import { LiveController, liveKindOf } from '../src/client/audio/live.ts'
import { TaskInputsController } from '../src/client/audio/task-controller.ts'
import { resolveOptions, taskView, voiceNames } from '../src/client/audio/tasks.ts'
import type { CaptureBackend, CaptureOpenOptions } from '../src/client/capture.ts'

const DOC = JSON.parse(readFileSync(new URL('./fixtures-host040-capabilities.json', import.meta.url), 'utf8')) as CapabilityDocument
const ROUTE = DOC.routes[0]!
const entry = (id: string) => ROUTE.models.find(m => m.id === id)!
const S = 'session-040' as SessionId

test('host 0.4.0 capability entries: uiTask, live kind and speech output are taken from the host, never invented', () => {
  const rows = Object.fromEntries(ROUTE.models.map((m) => {
    const view = taskView(m)
    return [m.id, [view.task, view.source, view.live, view.speaks, view.output.audio, view.adapterTask, view.wire]]
  }))
  assert.deepEqual(rows, {
    'omni-understand': ['audio-chat', 'declared', 'none', false, false, 'audio.understand', 'openai-chat-audio'],
    'omni-speech': ['omni-chat', 'declared', 'none', true, true, 'speech.s2s', 'omni-chat-s2s'],
    'asr-verbose': ['asr', 'declared', 'none', false, false, 'asr.transcribe', 'openai-transcriptions'],
    'asr-diarize': ['diarization', 'declared', 'none', false, false, 'asr.transcribe', 'openai-transcriptions'],
    'asr-translate': ['translation', 'declared', 'none', false, false, 'asr.translate', 'openai-translations'],
    'tts-custom': ['tts', 'declared', 'none', false, true, 'tts.speech', 'omni-speech-http'],
    'tts-clone': ['voice-clone', 'declared', 'none', false, true, 'tts.speech', 'omni-speech-http'],
    'music': ['music-generation', 'declared', 'none', false, true, 'audio.generate', 'omni-audio-generate'],
    'sound': ['sound-generation', 'declared', 'none', false, true, 'audio.generate', 'omni-audio-generate'],
    'rt-asr': ['realtime-asr', 'declared', 'transcription', false, false, 'asr.realtime', 'vllm-asr'],
    'rt-turn': ['s2s', 'declared', 'turn', true, true, 'speech.s2s.realtime', 'omni-turn'],
    'rt-duplex': ['duplex', 'declared', 'conversation', true, true, 'duplex', 'omni-duplex'],
    'rt-duplex-untested': ['duplex', 'declared', 'conversation', true, true, 'duplex', 'omni-duplex'],
    'tts-stream': ['tts-stream', 'declared', 'text-input', false, true, 'tts.stream-input', 'omni-speech-ws'],
  })
  assert.deepEqual(taskView(entry('asr-diarize')).output.speakers, true)
  const clone = taskView(entry('tts-clone'))
  assert.deepEqual(clone.input, { text: 'required', audio: 'none', referenceAudio: 'required', referenceText: 'optional', referenceAudio2: 'none', emotionAudio: 'none', imageReference: 'none', audioReference: 'none' })
  assert.deepEqual(clone.catalogTasks, ['tts_voice_clone'])
  // Every published parameter survives parsing, with its type and run-time value source.
  for (const m of ROUTE.models) assert.equal(taskView(m).params.length, (m as unknown as { params: unknown[] }).params.length, m.id)
  const params = Object.fromEntries(clone.params.map(p => [p.key, p]))
  assert.equal(params.voice!.type, 'string')
  assert.match((params.voice as { valuesFrom?: string }).valuesFrom!, /^\/api\/dsh-dgx-audio\/v1\/voices\?provider=dgx-all&model=tts-clone$/)
  assert.equal(params.maxNewTokens!.type, 'integer')
  assert.deepEqual(taskView(entry('asr-verbose')).params.map(p => `${p.key}:${p.type}`), ['language:string', 'prompt:text', 'responseFormat:enum', 'timestampGranularities:list'])
  assert.equal(liveKindOf('speech.s2s.realtime'), 'turn')
  assert.equal(liveKindOf('asr.realtime'), 'transcription')
  assert.equal(liveKindOf('tts.stream-input'), 'text-input')
})

test('options sent to the host carry only user-set values, coerced to the published types', () => {
  const view = taskView(entry('tts-clone'))
  assert.deepEqual(resolveOptions(view.params, {}, false), {}, 'defaults stay with the host')
  assert.deepEqual(
    resolveOptions(view.params, { voice: 'ryan', maxNewTokens: 512.6, taskType: 'Nope', language: '', instructions: 'calm' }, false),
    { voice: 'ryan', maxNewTokens: 513, instructions: 'calm' },
  )
  const asr = taskView(entry('asr-verbose'))
  assert.deepEqual(resolveOptions(asr.params, { timestampGranularities: 'segment, word,', responseFormat: 'srt' }, false), { timestampGranularities: ['segment', 'word'], responseFormat: 'srt' })
  assert.deepEqual(voiceNames({ voices: ['vivian', { name: 'ryan' }, { voice: 'aiden' }, 7], uploadedVoices: [{ name: 'ryan' }, { name: 'me' }] }), ['vivian', 'ryan', 'aiden', 'me'])
})

test('voice-clone request: reference transcript box replaces refText, an empty transcript is explicit, session params POST exact body', async () => {
  const requests: { url: string; body: unknown }[] = []
  let status = 200
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    if (status !== 200) return new Response(JSON.stringify({ ok: false, error: { code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message: 'parameter "voice" has an invalid value' } }), { status })
    return new Response(JSON.stringify({ ok: true, provider: 'dgx-all', model: 'tts-clone', params: {} }))
  }
  const controller = new TaskInputsController({ upload: async () => { throw new Error('unused') } }, { binding: () => undefined }, fetchImpl, () => Date.UTC(2026, 8, 15, 3, 0, 0))
  const view = taskView(entry('tts-clone'))
  const target = { provider: 'dgx-all', model: 'tts-clone', view }
  assert.equal(await controller.applyParams(S, target), true)
  assert.equal(requests.length, 0, 'nothing set, nothing sent')
  controller.setValue(S, 'tts-clone', 'voice', 'ryan')
  controller.setValue(S, 'tts-clone', 'refText', 'ignored: the reference box owns it')
  assert.equal(await controller.applyParams(S, target), true)
  assert.deepEqual(requests[0]!.body, { sessionId: S, provider: 'dgx-all', model: 'tts-clone', params: { voice: 'ryan' } })
  assert.match(requests[0]!.url, /\/api\/dsh-dgx-audio\/v1\/session-params$/)
  assert.equal(controller.source(S).getSnapshot().params, 'applied')
  controller.setReference(S, new Blob([new Uint8Array(20)], { type: 'audio/wav' }), 'recorded', 'reference-voice.wav')
  controller.setConsent(S, true)
  const block = controller.extras(S, 'tts-clone', view).block!
  const payload = JSON.parse(block.split('\n')[1]!) as { referenceAudio: string }
  assert.match(payload.referenceAudio, /^reference-voice-\d{8}-\d{6}\.wav$/)
  assert.deepEqual(payload, { v: 1, model: 'tts-clone', voice: 'ryan', referenceAudio: payload.referenceAudio, referenceText: '' })
  status = 400
  assert.equal(await controller.applyParams(S, target), false)
  assert.equal(controller.source(S).getSnapshot().params, 'failed')
  assert.match(controller.source(S).getSnapshot().paramsDetail!, /BAD_REQUEST/)
  status = 404
  await controller.applyParams(S, target)
  assert.equal(controller.source(S).getSnapshot().params, 'unsupported', 'hosts before 0.4.0 have no session-params route')
  controller.dispose()
})

test('activation gate: library and adapter states combine; any blocking report wins and is never shown as ready', () => {
  assert.equal(parseGate({ state: 'ready', detail: null, progress: null }, 'adapter')?.state, 'ready')
  assert.equal(parseGate({ state: 'warming' }, 'adapter'), undefined)
  const ready = { state: 'ready' } as const
  assert.deepEqual(combineGate({ state: 'loading', detail: 'starting' }, ready), { state: 'loading', detail: 'starting', source: 'library' })
  assert.deepEqual(combineGate({ state: 'ready' }, { state: 'cold' }), { state: 'cold', source: 'adapter' })
  assert.deepEqual(combineGate({ state: 'unknown' }, ready), { state: 'ready', source: 'adapter' })
  assert.deepEqual(combineGate({ state: 'static' }, ready), { state: 'static', source: 'library' })
  assert.deepEqual(combineGate(undefined, undefined), { state: 'unknown' })
  for (const state of ['cold', 'queued', 'stopping', 'loading', 'activating', 'unloading', 'busy', 'error', 'failed', 'live-only'] as const) {
    assert.equal(gateBlocks({ state } as never), true, state)
  }
  for (const state of ['ready', 'static', 'unknown'] as const) assert.equal(gateBlocks({ state }), false, state)

  let libraryState: unknown = { state: 'unknown' }
  const libraryListeners = new Set<() => void>()
  const opened: unknown[] = []
  let face: AudioModelLibraryFace | undefined
  let clock = 1000
  const board = new ActivationBoard(() => face, () => clock)
  let notified = 0
  const stop = board.subscribe(() => { notified++ })
  const tts = entry('tts-custom')
  assert.deepEqual(board.gate('dgx-all', 'tts-custom', tts), { state: 'ready', source: 'adapter' })
  assert.equal(board.handleModelState({ type: 'model.state', provider: 'dgx-all', model: 'tts-custom', state: 'activating', progress: 0.4, detail: 'loading weights' }), true)
  assert.deepEqual(board.gate('dgx-all', 'tts-custom', tts), { state: 'activating', source: 'adapter', detail: 'loading weights', progress: 0.4 })
  board.documentLoaded(500)
  assert.equal(board.gate('dgx-all', 'tts-custom', tts).state, 'activating', 'a document fetched before the event does not override it')
  clock = 2000
  board.documentLoaded(1500)
  assert.equal(board.gate('dgx-all', 'tts-custom', tts).state, 'ready')
  face = {
    status: () => ({ getSnapshot: () => libraryState, subscribe: (l) => { libraryListeners.add(l); return () => libraryListeners.delete(l) } }),
    document: () => ({ getSnapshot: () => null, subscribe: (l) => { libraryListeners.add(l); return () => libraryListeners.delete(l) } }),
    open: (options) => { opened.push(options) },
  }
  board.libraryChanged()
  assert.equal(libraryListeners.size, 1, 'follows the library store once it appears')
  libraryState = { state: 'busy', reason: 'benchmark-reservation', detail: 'reserved until 03:10' }
  const before = notified
  for (const listener of libraryListeners) listener()
  assert.ok(notified > before)
  assert.deepEqual(board.gate('dgx-all', 'tts-custom', tts), { state: 'busy', reason: 'benchmark-reservation', detail: 'reserved until 03:10', source: 'library', library: true })
  assert.equal(board.openLibrary('session-x'), true)
  assert.deepEqual(opened, [{ sessionId: 'session-x' }])
  stop()
  assert.equal(libraryListeners.size, 0)
})

test('I2-A #1/#2: untested and unsupported live models are listed with their reason, offerable ones first; a live-only selection is flagged', () => {
  const features = deriveFeatures(DOC, 'ready', { provider: 'dgx-all', model: 'omni-speech' }, undefined)
  assert.deepEqual(features.liveCandidates.map(c => [c.model.model, c.kind, c.evidence, c.available]), [
    ['rt-duplex', 'conversation', 'declared', true],
    ['tts-stream', 'text-input', 'declared', true],
    ['rt-asr', 'transcription', 'untested', false],
    ['rt-turn', 'turn', 'untested', false],
    ['rt-duplex-untested', 'conversation', 'untested', false],
  ])
  assert.equal(features.liveOffered, true)
  assert.equal(features.liveModel?.model, 'rt-duplex')
  assert.equal(features.liveState, 'declared', 'declared stays declared, never verified')
  assert.equal(features.liveOnly, false)
  const untestedOnly: CapabilityDocument = { ...DOC, routes: [{ ...ROUTE, models: [entry('omni-speech'), entry('rt-duplex-untested')] }] }
  const hidden = deriveFeatures(untestedOnly, 'ready', { provider: 'dgx-all', model: 'omni-speech' }, undefined)
  assert.equal(hidden.liveOffered, false)
  assert.equal(hidden.liveCandidates.length, 1, 'the untested model is still shown, as unavailable')
  assert.equal(hidden.liveCandidates[0]!.evidence, 'untested')
  assert.equal(deriveFeatures(DOC, 'ready', { provider: 'dgx-all', model: 'rt-duplex' }, undefined).liveOnly, true)
})

class FakeCapture implements CaptureBackend {
  opens: CaptureOpenOptions[] = []
  support() { return undefined }
  async listDevices() { return [] }
  onDeviceChange() { return () => {} }
  async open(options: CaptureOpenOptions) {
    this.opens.push(options)
    return { sampleRate: options.sampleRate ?? 16000, deviceLabel: 'fixture', deviceId: '', close: async () => {} }
  }
}

function liveHost(open: Record<string, unknown>, close: Record<string, unknown> = { ok: true, input: null }, appendDelayMs = 0) {
  const requests: { path: string; body: unknown }[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/dsh-dgx-audio/v1/', '')
    const body = init?.body instanceof Uint8Array ? init.body.byteLength : init?.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ path, body })
    if (path === 'live/open') return new Response(JSON.stringify({ ok: true, liveId: 'L', ...open }))
    if (path === 'live/append' && appendDelayMs > 0) await new Promise(resolve => setTimeout(resolve, appendDelayMs))
    if (path === 'live/text') return new Response(JSON.stringify({ ok: true, chunks: requests.filter(r => r.path === 'live/text' && typeof (r.body as { text?: string }).text === 'string' && (r.body as { text: string }).text !== '').length }))
    if (path === 'live/close') return new Response(JSON.stringify(close))
    return new Response(JSON.stringify({ ok: true }))
  }
  return { requests, fetchImpl }
}

const PCM_INPUT = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000, wireEncoding: 'pcm16' }

test('live transcription (asr.realtime): transcript deltas and committed segments, no overlapPolicy, no speech controls', async () => {
  const host = liveHost({ task: 'asr.realtime', wire: 'vllm-asr', input: PCM_INPUT }, { ok: true, input: { recordingId: 'rec', bytes: 9, sha256: 'x', receiptId: 'rc', attachmentId: 'a' }, transcripts: [{ turnId: 'turn-0', text: 'And so my fellow Americans', done: true }] })
  const capture = new FakeCapture()
  const logged: string[] = []
  const live = new LiveController(capture, host.fetchImpl, () => false, async (_s, input) => { logged.push(String(input.receiptId)); return { ok: true } }, () => 0)
  await live.start(S, { provider: 'dgx-all', model: 'rt-asr' }, 'declared', false, 'transcription')
  assert.deepEqual(host.requests[0]!.body, { sessionId: S, provider: 'dgx-all', model: 'rt-asr' })
  const snap = () => live.source.getSnapshot()
  assert.equal(snap().kind, 'transcription')
  assert.equal(snap().task, 'asr.realtime')
  live.handleEvent({ type: 'text.delta', kind: 'transcript', streamId: 'turn-0', responseId: 'turn-0', text: 'And so ', liveId: 'L' })
  live.handleEvent({ type: 'text.delta', kind: 'transcript', streamId: 'turn-0', responseId: 'turn-0', text: 'my fellow', liveId: 'L' })
  live.handleEvent({ type: 'text.delta', kind: 'transcript', streamId: 'turn-9', responseId: 'turn-9', text: 'other live', liveId: 'OTHER' })
  assert.deepEqual(snap().turns, [{ id: 'turn-0', kind: 'transcript', text: 'And so my fellow', final: false }])
  live.handleEvent({ type: 'live.transcript.done', responseId: 'turn-0', text: 'And so my fellow Americans', liveId: 'L' })
  assert.deepEqual(snap().turns, [{ id: 'turn-0', kind: 'transcript', text: 'And so my fellow Americans', final: true }])
  assert.equal(snap().transcript, 'And so my fellow Americans')
  await live.endInput()
  await live.close()
  assert.deepEqual(logged, ['rc'])
})

test('voice turns (speech.s2s.realtime) open as the turn panel; barge-in is requested only on explicit request; non-PCM16 input is refused', async () => {
  const turn = liveHost({ task: 'speech.s2s.realtime', wire: 'omni-turn', input: PCM_INPUT })
  const live = new LiveController(new FakeCapture(), turn.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'dgx-all', model: 'rt-turn' }, 'declared', true, 'conversation')
  assert.equal(live.source.getSnapshot().kind, 'turn', 'the host task decides the panel')
  assert.deepEqual(turn.requests[0]!.body, { sessionId: S, provider: 'dgx-all', model: 'rt-turn', overlapPolicy: 'barge_in_on_speech' })
  await live.dispose()
  const f32 = liveHost({ task: 'duplex', wire: 'omni-duplex', input: { ...PCM_INPUT, encoding: 'pcm_f32le' } })
  const capture = new FakeCapture()
  const refused = new LiveController(capture, f32.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await refused.start(S, { provider: 'dgx-all', model: 'rt-duplex' }, 'declared', false)
  assert.equal(refused.source.getSnapshot().error?.code, 'UNSUPPORTED_INPUT')
  assert.equal(capture.opens.length, 0)
  assert.ok(f32.requests.some(r => r.path === 'live/close'))
})

test('streamed text-to-speech (tts.stream-input) sends text pieces and the end marker without opening the microphone', async () => {
  const host = liveHost({ task: 'tts.stream-input', wire: 'omni-speech-ws', input: { encoding: 'text', route: '/api/dsh-dgx-audio/v1/live/text' } }, { ok: true, input: null, responses: [] })
  const capture = new FakeCapture()
  const live = new LiveController(capture, host.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'dgx-all', model: 'tts-stream' }, 'declared', false, 'text-input')
  assert.equal(live.source.getSnapshot().phase, 'live')
  assert.equal(capture.opens.length, 0)
  assert.equal(await live.sendText('Hello there. '), true)
  assert.equal(await live.sendText(''), false, 'empty pieces are not sent')
  assert.equal(await live.sendText('How are you?'), true)
  await live.endInput()
  assert.deepEqual(host.requests.filter(r => r.path === 'live/text').map(r => r.body), [{ text: 'Hello there. ' }, { text: 'How are you?' }, { done: true }])
  assert.equal(live.source.getSnapshot().phase, 'awaiting')
  assert.equal(live.source.getSnapshot().textChunks, 2)
  await live.close()
  assert.equal(live.source.getSnapshot().log, 'unavailable')
  assert.equal(live.source.getSnapshot().logDetail, 'text-input')
})

test('I2-A #3: a busy server refuses Live before any open request; #4: a closed exchange without a reply says so', async () => {
  const host = liveHost({ task: 'duplex', wire: 'omni-duplex', input: PCM_INPUT }, { ok: true, input: { recordingId: 'rec_live', bytes: 411_244, sha256: 'jfk', receiptId: null } })
  const live = new LiveController(new FakeCapture(), host.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'dgx-all', model: 'rt-duplex' }, 'declared', false, 'conversation', async () => 'chat · omni-speech')
  assert.equal(host.requests.length, 0)
  assert.deepEqual(live.source.getSnapshot().error, { code: 'SERVER_BUSY', message: 'chat · omni-speech' })
  live.dismiss()
  await live.start(S, { provider: 'dgx-all', model: 'rt-duplex' }, 'declared', false, 'conversation', async () => undefined)
  assert.equal(live.source.getSnapshot().phase, 'live')
  await live.endInput()
  await live.close()
  assert.equal(live.source.getSnapshot().log, 'unavailable')
  assert.equal(live.source.getSnapshot().logDetail, 'no-reply')
})

test('I2-A #6: audio spoken while the host is slow is buffered (bound unchanged at 75 frames) and the panel can show it', async () => {
  const host = liveHost({ task: 'duplex', wire: 'omni-duplex', input: PCM_INPUT }, { ok: true, input: null }, 30)
  const capture = new FakeCapture()
  const live = new LiveController(capture, host.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'dgx-all', model: 'rt-duplex' }, 'declared', false)
  assert.equal(live.source.getSnapshot().maxQueued, 75)
  assert.equal(live.source.getSnapshot().frameMs, 200)
  capture.opens[0]!.onFrames(new Float32Array(3200 * 5).fill(0.1))
  assert.equal(live.source.getSnapshot().framesAcked, 0)
  assert.ok(live.source.getSnapshot().queued >= 4, `queued ${live.source.getSnapshot().queued}`)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(live.source.getSnapshot().queued, 0)
  assert.equal(live.source.getSnapshot().framesAcked, 5)
  await live.dispose()
})

test('live panel facts come from the session the server created: native duplex, fallback reason, and input delivery stay separate', async () => {
  const fallbackCaps = {
    liveInput: { state: 'verified', source: 'live', detail: 'backend acknowledged frames' },
    fullDuplex: { state: 'unsupported', source: 'server-session', implementationLevel: 'serving_session_adapter', detail: 'server implementation_level serving_session_adapter' },
    bargeIn: { state: 'advertised' },
  }
  const host = liveHost({ task: 'duplex', wire: 'omni-duplex', input: PCM_INPUT, capabilities: fallbackCaps })
  const live = new LiveController(new FakeCapture(), host.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'dgx-all', model: 'rt-duplex' }, 'declared', false)
  assert.deepEqual(live.source.getSnapshot().server?.fullDuplex, { state: 'unsupported', detail: 'server implementation_level serving_session_adapter', implementationLevel: 'serving_session_adapter' })
  assert.equal(live.source.getSnapshot().server?.liveInput?.state, 'verified')
  live.handleEvent({ type: 'live.state', state: 'ready', liveId: 'L', capabilities: { fullDuplex: { state: 'advertised', implementationLevel: 'model_native_duplex' } } })
  assert.equal(live.source.getSnapshot().server?.fullDuplex?.implementationLevel, 'model_native_duplex')
  await live.dispose()
  const asr = liveHost({ task: 'asr.realtime', wire: 'vllm-asr', input: PCM_INPUT, capabilities: { liveInput: { state: 'declared' }, fullDuplex: { state: 'unsupported', detail: 'vllm-asr is a turn-based realtime wire, not the duplex protocol' } } })
  const transcription = new LiveController(new FakeCapture(), asr.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await transcription.start(S, { provider: 'dgx-all', model: 'rt-asr' }, 'declared', false, 'transcription')
  assert.equal(transcription.source.getSnapshot().phase, 'live', 'a non-duplex wire is not blocked by native-duplex facts')
  await transcription.dispose()
})

test('streamed sentence pieces of one utterance are joined with a space, word deltas are not', () => {
  const live = new LiveController(new FakeCapture(), async () => new Response('{}'), () => false, async () => ({ ok: true }), () => 0)
  ;(live as unknown as { snapshot: { liveId: string } }).snapshot.liveId = 'L'
  live.handleEvent({ type: 'text.delta', kind: 'response', responseId: 'utt-0', text: 'Hello there.', liveId: 'L' })
  live.handleEvent({ type: 'text.delta', kind: 'response', responseId: 'utt-0', text: 'How are you?', liveId: 'L' })
  live.handleEvent({ type: 'text.delta', kind: 'transcript', responseId: 'turn-1', text: 'And so', liveId: 'L' })
  live.handleEvent({ type: 'text.delta', kind: 'transcript', responseId: 'turn-1', text: ', my', liveId: 'L' })
  assert.deepEqual(live.source.getSnapshot().turns.map(t => t.text), ['Hello there. How are you?', 'And so, my'])
})
