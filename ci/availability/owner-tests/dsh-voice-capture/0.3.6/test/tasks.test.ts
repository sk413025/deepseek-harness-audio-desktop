import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CapabilityModel } from '../src/client/audio/api.ts'
import { parseAudioResults, outputLabel, toPlainText, toSrt, toVtt, withoutMachineBlocks } from '../src/client/audio/results.ts'
import { TaskInputsController } from '../src/client/audio/task-controller.ts'
import { AUDIO_TASKS, inferTask, missingInputs, optionsBlock, resolveOptions, taskView } from '../src/client/audio/tasks.ts'

const S = 'session-t' as SessionId
const model = (extra: Partial<CapabilityModel> & Record<string, unknown>): CapabilityModel => ({ id: 'm', mode: 'chat', capabilities: {}, ...extra }) as CapabilityModel

test('task inference never invents speech: transcribe, realtime without audio output, audio input chat, omni', () => {
  assert.equal(inferTask(model({ mode: 'transcribe' })), 'asr')
  assert.equal(inferTask(model({ mode: 'realtime', capabilities: { audioOutput: { state: 'unsupported' }, fullDuplex: { state: 'unsupported' } } })), 'realtime-asr')
  assert.equal(inferTask(model({ mode: 'realtime', output: { audio: true } })), 'duplex')
  assert.equal(inferTask(model({ input: { formats: ['wav'] } })), 'audio-chat')
  assert.equal(inferTask(model({ output: { text: true, audio: true } })), 'omni-chat')
  assert.equal(inferTask(model({})), 'chat')
  const asr = taskView(model({ mode: 'transcribe' }))
  assert.equal(asr.speaks, false)
  assert.equal(asr.output.audio, false)
  assert.equal(asr.output.segments, true)
  assert.equal(asr.source, 'inferred')
  const rt = taskView(model({ mode: 'realtime', capabilities: { liveInput: { state: 'declared' } } }))
  assert.equal(rt.task, 'realtime-asr')
  assert.equal(rt.live, 'transcription')
  assert.equal(rt.speaks, false)
  assert.equal(taskView(model({ mode: 'realtime', output: { audio: true } })).live, 'conversation')
  assert.equal(AUDIO_TASKS.length, 20)
})

test('declared task, io and params override inference; malformed params are dropped', () => {
  const view = taskView(model({
    task: 'voice-clone',
    io: { input: { text: 'required', referenceAudio: 'required', referenceText: 'required' }, output: { audio: true, text: false } },
    params: [
      { key: 'voice', type: 'enum', values: ['A', 'B'], default: 'A' },
      { key: 'speed', type: 'number', min: 0.5, max: 2, default: 1 },
      { key: 'bad key', type: 'text' },
      { key: 'mood', type: 'enum', values: [1, 2] },
      { key: 'instructions', type: 'text', maxLength: 5 },
    ],
    limits: { maxTextChars: 10 },
  }))
  assert.equal(view.source, 'declared')
  assert.equal(view.task, 'voice-clone')
  assert.equal(view.speaks, false, 'generated speech is not a spoken conversation')
  assert.deepEqual(view.params.map(p => p.key), ['voice', 'speed', 'instructions'])
  assert.deepEqual(missingInputs(view, { text: '', hasAudio: false, hasReference: false, referenceConsent: false, referenceText: '' }), ['text', 'referenceAudio', 'referenceText'])
  assert.deepEqual(missingInputs(view, { text: 'x'.repeat(11), hasAudio: false, hasReference: true, referenceConsent: false, referenceText: 'hi' }), ['textTooLong', 'referenceConsent'])
  assert.deepEqual(missingInputs(view, { text: 'hello', hasAudio: false, hasReference: true, referenceConsent: true, referenceText: 'hi' }), [])
  assert.deepEqual(resolveOptions(view.params, { voice: 'Z', speed: 9, instructions: 'abcdefgh', extra: 1 }), { voice: 'A', speed: 2, instructions: 'abcde' })
  const block = optionsBlock('m', { voice: 'A' }, { name: 'reference-voice-1.wav', text: 'hi' })
  assert.match(block, /^```dsh-audio-options\n/)
  assert.deepEqual(JSON.parse(block.split('\n')[1]!), { v: 1, model: 'm', voice: 'A', referenceAudio: 'reference-voice-1.wav', referenceText: 'hi' })
})

test('result blocks parse transcripts, outputs and embeddings; exports are well formed', () => {
  const text = [
    'Hello world.',
    '```dsh-audio-result',
    JSON.stringify({ v: 1, task: 'diarization', language: 'en', durationSeconds: 3.5, segments: [{ start: 0, end: 1.25, text: 'Hello', speaker: 'S1' }, { start: 1.25, end: 3.5, text: 'world.', speaker: 'S2' }, { start: 'x', end: 1, text: 'bad' }] }),
    '```',
    '```dsh-audio-result',
    JSON.stringify({ v: 1, task: 'separation', outputs: [{ role: 'stem:vocals', recordingId: 'r1.abc', sampleRate: 44100, channels: 2 }, { role: 'x', recordingId: '../etc' }] }),
    '```',
    '```dsh-audio-result',
    '{not json',
    '```',
    '```dsh-audio-result',
    JSON.stringify({ v: 1, task: 'audio-embedding', embedding: { dims: 512, resultId: 'e1.xyz' } }),
    '```',
  ].join('\n')
  const results = parseAudioResults(text, 7)
  assert.equal(results.length, 3)
  const hidden = parseAudioResults('Answer <!-- dsh-audio-result {"v":1,"task":"tts","outputs":[{"role":"speech","recordingId":"r2.x"}]} --> tail', 8)
  assert.equal(hidden[0]!.outputs[0]!.recordingId, 'r2.x')
  assert.equal(withoutMachineBlocks('Answer <!-- dsh-audio-result {"v":1} -->'), 'Answer')
  assert.equal(results[0]!.segments.length, 2)
  assert.deepEqual(results[1]!.outputs, [{ kind: 'audio', role: 'stem:vocals', recordingId: 'r1.abc', sampleRate: 44100, channels: 2 }])
  assert.deepEqual(results[2]!.embedding, { dims: 512, resultId: 'e1.xyz' })
  assert.equal(withoutMachineBlocks(text), 'Hello world.')
  assert.equal(toSrt(results[0]!.segments), '1\n00:00:00,000 --> 00:00:01,250\n[S1] Hello\n\n2\n00:00:01,250 --> 00:00:03,500\n[S2] world.\n')
  assert.match(toVtt(results[0]!.segments), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.250\n<v S1>Hello\n/)
  assert.equal(toPlainText(results[0]!.segments), 'S1: Hello\nS2: world.')
  assert.equal(outputLabel('tts', 'speech'), 'generatedSpeech')
  assert.equal(outputLabel('omni-chat', 'speech'), 'speechReply')
  assert.equal(outputLabel('separation', 'stem:drums'), 'stem')
  assert.equal(outputLabel('music-generation', 'music'), 'generatedMusic')
})

test('text-input task request uploads the consented reference and sends options before the text', async () => {
  const uploads: string[] = []
  const prompts: unknown[] = []
  const submissions: unknown[] = []
  const controller = new TaskInputsController(
    { async upload(_s, data, name) { uploads.push(`${name}:${data.size}`); return { ok: true, value: { receiptId: 'rcpt-ref', file: { attachmentId: 'sha256:ref', name, bytes: data.size } } } as never } },
    { binding: () => ({ session: {
      beginSubmission: (input: unknown) => { submissions.push(input); return { requestId: 'req' as never, abandon: () => {} } },
      prompt: async (content: unknown) => { prompts.push(content); return { ok: true, value: { accepted: true } } as never },
    } }) },
    undefined,
    () => Date.UTC(2026, 8, 15, 2, 30, 0),
  )
  const view = taskView(model({ task: 'voice-clone', params: [{ key: 'voice', type: 'enum', values: ['A', 'B'], default: 'A' }] }))
  controller.setReference(S, new Blob([new Uint8Array(100)], { type: 'audio/wav' }), 'file', 'my voice.WAV')
  controller.setValue(S, 'm', 'voice', 'B')
  assert.deepEqual(controller.extras(S, 'm', view).references, [], 'no reference without consent')
  controller.setConsent(S, true)
  controller.setReferenceText(S, 'reference words')
  const ok = await controller.generate(S, 'm', view, 'Say hello')
  assert.equal(ok, true)
  const name = controller.source(S).getSnapshot().reference!.name
  assert.match(name, /^reference-voice-\d{8}-\d{6}\.wav$/)
  assert.deepEqual(uploads, [`${name}:100`])
  const content = prompts[0] as { type: string; text?: string; receiptId?: string }[]
  assert.deepEqual(content.map(part => part.type), ['file', 'text'])
  assert.equal(content[0]!.receiptId, 'rcpt-ref')
  assert.deepEqual(JSON.parse(content[1]!.text!.split('\n')[1]!), { v: 1, model: 'm', voice: 'B', referenceAudio: name, referenceText: 'reference words' })
  assert.match(content[1]!.text!, /\n```\n\nSay hello$/)
  controller.setReference(S, new Blob([new Uint8Array(10)], { type: 'text/plain' }), 'file', 'x.txt')
  assert.equal(controller.source(S).getSnapshot().error?.code, 'reference-type')
  controller.dispose()
})

test('stored result links are folded into Turn data and hide duplicate recordings of the same message', async () => {
  const { voiceAudioDefinition, selectReplyRecordings, resultLinks } = await import('../src/client/audio/recordings.ts')
  const { parseResultDocument } = await import('../src/client/audio/results.ts')
  assert.deepEqual(resultLinks('- [🧾 asr result](/api/dsh-dgx-audio/v1/result?id=m1.result-abc) [x](/api/dsh-dgx-audio/v1/result?id=../x)', 4), [{ seq: 4, resultId: 'm1.result-abc', label: '🧾 asr result' }])
  let state = voiceAudioDefinition.start({} as never, { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } } as never, {} as never)
  state = voiceAudioDefinition.update({ state } as never, { event: { type: 'assistant/message', seq: 5, data: { turn: 1, message: { content: [{ type: 'text', text: 'ok\n- [🧾 tts result](/api/dsh-dgx-audio/v1/result?id=m1.result-1)\n- [▶ audio](/api/dsh-dgx-audio/v1/recording?id=r1.same)' }] } } } } as never)
  const published = voiceAudioDefinition.buildLocationData!({ state } as never, 'turn', null)
  const owner = { turn: { data: { get: () => published?.value } }, seq: 5, openFile: () => {} }
  const match = selectReplyRecordings(owner as never)
  assert.equal(match?.resultLinks.length, 1)
  assert.equal(match?.recordings.length, 0)
  assert.equal(parseResultDocument({ v: 1, task: 'asr', segments: [{ start: 0, end: 1, text: 'hi' }] }, 5)?.segments.length, 1)
  assert.equal(parseResultDocument({ nope: true }, 5), undefined)
})
