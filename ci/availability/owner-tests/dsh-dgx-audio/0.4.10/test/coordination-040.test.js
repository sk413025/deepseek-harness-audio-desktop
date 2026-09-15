// Cross-lane coordination in 0.4.0 (TASK_CONTRACT v0.2 §F–§H): logged inline options, result blocks, task mapping
// fields, deploymentId evidence separation, activity route, realtime-ASR receipt replay, resume URL, server-VAD policy.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fileHandleText } from '@deepseek-ai/dsh-llm'

import { createAudioPlugin } from '../src/index.js'
import { wavHeader } from '../src/pcm.js'
import { collect, fakeStore, pcm16, scriptedServer, sleep, tempDir, wav } from './helpers/fixtures.js'
import { wsServer } from './helpers/ws-server.js'

const user = (...blocks) => ({ role: 'user', content: blocks.map(b => (typeof b === 'string' ? { type: 'text', text: b } : b)) })
const optionsBlock = obj => `\`\`\`dsh-audio-options\n${JSON.stringify(obj)}\n\`\`\``
// 0.4.3: results are carried by a footer link line + GET result?id= (the legacy fence is still parsed for old messages).
async function resultOf(t, text) {
  const link = /\]\(\/api\/dsh-dgx-audio\/v1\/result\?id=([A-Za-z0-9._~-]{1,200})\)/.exec(text)
  if (link === null) return JSON.parse(/```dsh-audio-result\n(.*)\n```/.exec(text)[1])
  return (await t.call(`/api/dsh-dgx-audio/v1/result?id=${link[1]}`)).body
}

async function plugin(routes, extra = {}) {
  const outputDir = await tempDir('dgx-coord-')
  const p = createAudioPlugin({ rowConfig: { outputDir, hubLimits: { pingMs: 60_000 }, routes }, log: () => {}, attachments: () => extra.store?.store, fileUploads: extra.fileUploads === undefined ? undefined : () => extra.fileUploads })
  const call = async (path, init) => {
    const route = p.routes().find(r => r.path === path.split('?')[0])
    const res = await route.fetch(new Request(`http://h${path}`, init))
    return { status: res.status, body: await res.json() }
  }
  return { p, call, post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }), outputDir }
}

test('inline dsh-audio-options: validated, logged in the prompt, never model input, selects a named reference clip', async (tc) => {
  const header = wavHeader({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }, 4800)
  const server = await scriptedServer(async (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(Buffer.concat([header, pcm16(0.1, 24000)])) })
  tc.after(() => server.close())
  const refA = wav(0.2, 16000, 200)
  const refB = wav(0.3, 16000, 900)
  const a = await fakeStore(refA, 'other.wav')
  const b = await fakeStore(refB, 'reference-voice-20260915-020501.wav')
  const store = { fileHostPath: r => (r.name === a.ref.name ? a.path : b.path), async * readFileStream(r) { yield* (r.name === a.ref.name ? a.store : b.store).readFileStream(r) } }
  const t = await plugin([{ provider: 'tts', displayName: 'TTS', baseURL: server.url, models: [{ id: 'clone', mode: 'speech', streaming: { audio: 'off' }, speech: { taskType: 'Base', refAudio: 'attachment' } }] }], { store: { store } })
  const base = { provider: 'tts', model: 'clone', sessionId: 's' }
  const msg = user({ type: 'text', text: fileHandleText(b.ref, b.path) }, { type: 'text', text: fileHandleText(a.ref, a.path) }, `${optionsBlock({ v: 1, model: 'clone', voice: 'ryan', language: 'English', referenceAudio: 'reference-voice-20260915-020501.wav', referenceText: 'ref words' })}\nSay hello.`)
  const chunks = await collect(t.p.adapter.stream({ ...base, messages: [msg] }))
  const body = server.calls[0].json
  assert.deepEqual([body.input, body.voice, body.language, body.ref_text], ['Say hello.', 'ryan', 'English', 'ref words'])
  assert.equal(Buffer.from(body.ref_audio.split(',')[1], 'base64').equals(refB), true, 'the named clip, not the newest attachment')
  const text = chunks.find(c => c.type === 'block-end').block.text
  const result = await resultOf(t, text)
  assert.deepEqual([result.task, result.adapterTask, result.catalogTasks, result.outputs[0].role, result.outputs[0].delivery], ['voice-clone', 'tts.speech', ['tts_voice_clone'], 'speech', 'final-only'])
  assert.equal(result.params.voice, 'ryan')
  await assert.rejects(collect(t.p.adapter.stream({ ...base, messages: [user(`${optionsBlock({ pitch: 2 })}\nhi`)] })), e => e.code === 'INVALID_REQUEST' && /pitch/.test(e.message))
  await assert.rejects(collect(t.p.adapter.stream({ ...base, messages: [user(`${optionsBlock({ speed: 9 })}\nhi`)] })), e => e.code === 'INVALID_REQUEST' && /speed/.test(e.message), 'speed is range-checked (0.25–4)')
  await assert.rejects(collect(t.p.adapter.stream({ ...base, messages: [user(`${optionsBlock({ model: 'other' })}\nhi`)] })), e => e.code === 'INVALID_REQUEST')
  await assert.rejects(collect(t.p.adapter.stream({ ...base, messages: [user('```dsh-audio-options\n{oops\n```\nhi')] })), e => e.code === 'INVALID_REQUEST')
  // Chat routes: the block is removed from what the model sees.
  const chat = await scriptedServer(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }] })) })
  tc.after(() => chat.close())
  const c = await plugin([{ provider: 'c', displayName: 'C', baseURL: chat.url, models: [{ id: 'm', streaming: { text: 'off' } }] }])
  await collect(c.p.adapter.stream({ provider: 'c', model: 'm', messages: [user(`${optionsBlock({})}\nWhat is said?`)] }))
  assert.deepEqual(chat.calls[0].json.messages.at(-1).content, [{ type: 'text', text: 'What is said?' }])
})

test('capability document: uiTask/catalogTasks/io per model; deploymentId keeps evidence of two runtimes apart; activity route', async (tc) => {
  const ws = await wsServer((conn) => { conn.onMessage((m) => { if (m.type === 'session.update') conn.send({ type: 'session.created', incarnation: 0, resume_token: 't', session: { id: 'srv-x', capabilities: {} } }) }) })
  tc.after(() => ws.close())
  const routes = [{ provider: 'lab', displayName: 'Lab', baseURL: ws.baseURL, models: [
    { id: 'asr-rt', mode: 'realtime', realtime: { wire: 'vllm-asr' } },
    { id: 'dia', mode: 'transcribe', asr: { responseFormat: 'diarized_json' } },
    { id: 'music', mode: 'generate-audio', generate: { kind: 'music' } },
    { id: 'duplex-0.28', mode: 'realtime', upstreamModel: 'openbmb/MiniCPM-o-4_5', deploymentId: 'minicpmo45-v0.28.0-3' },
    { id: 'duplex-nightly', mode: 'realtime', upstreamModel: 'openbmb/MiniCPM-o-4_5', deploymentId: 'minicpmo45-nightly-58adeec' },
  ] }]
  const t = await plugin(routes)
  const doc = (await t.call('/api/dsh-dgx-audio/v1/capabilities')).body
  const m = Object.fromEntries(doc.routes[0].models.map(x => [x.id, x]))
  assert.deepEqual([m['asr-rt'].uiTask, m['asr-rt'].catalogTasks, m['asr-rt'].io.output.audio, m['asr-rt'].io.live], ['realtime-asr', ['asr'], false, 'audio'])
  assert.deepEqual([m.dia.uiTask, m.dia.catalogTasks, m.dia.io.output.transcript.speakers], ['diarization', ['asr', 'diarization'], true])
  assert.deepEqual([m.music.uiTask, m.music.catalogTasks, m.music.io.input.text], ['music-generation', ['music_generation'], 'required'])
  assert.equal(m['duplex-nightly'].deploymentId, 'minicpmo45-nightly-58adeec')
  const [route] = t.p.config().routes
  const d028 = route.models.find(x => x.id === 'duplex-0.28')
  t.p.capabilities.observe(route, d028, 'bargeIn', { state: 'verified', source: 'live' })
  const again = (await t.call('/api/dsh-dgx-audio/v1/capabilities')).body.routes[0].models
  assert.equal(again.find(x => x.id === 'duplex-0.28').capabilities.bargeIn.state, 'verified')
  assert.equal(again.find(x => x.id === 'duplex-nightly').capabilities.bargeIn.state, 'untested', 'same URL and upstream model, different deployment: no shared evidence')
  const opened = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv', provider: 'lab', model: 'duplex-nightly' })).body
  const act = (await t.call('/api/dsh-dgx-audio/v1/activity?provider=lab')).body
  assert.deepEqual(act.live.map(l => [l.liveId, l.model, l.state, l.task]), [[opened.liveId, 'duplex-nightly', 'ready', 'duplex']])
  assert.deepEqual(act.inflight, [])
  await t.p.live.closeAll('test')
  t.p.dispose()
})

test('realtime-ASR receipt: close stages the capture and the prompt replays the final transcript without a model call', async (tc) => {
  const server = await wsServer((conn) => {
    conn.send({ type: 'session.created', id: 'sess-1' })
    conn.onMessage(async (m) => {
      if (m.type === 'input_audio_buffer.append') conn.send({ type: 'transcription.delta', delta: 'hello ' })
      if (m.type === 'input_audio_buffer.commit' && m.final) { await sleep(20); conn.send({ type: 'transcription.done', text: 'hello world' }) }
    })
  })
  tc.after(() => server.close())
  const staged = []
  const fileUploads = { async uploadStream({ data, name }) { const parts = []; for await (const c of data) parts.push(c); const bytes = Buffer.concat(parts); staged.push({ bytes, name }); return { receiptId: 'rc-1', file: { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name, bytes: bytes.length } } } }
  const t = await plugin([{ provider: 'rt', displayName: 'RT', baseURL: server.baseURL, models: [{ id: 'asr-rt', mode: 'realtime', realtime: { wire: 'vllm-asr' } }, { id: 'chat', mode: 'chat' }] }], { fileUploads })
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv', provider: 'rt', model: 'asr-rt' })).body
  for (let seq = 0; seq < 3; seq++) await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=${seq}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  await t.post(`/api/dsh-dgx-audio/v1/live/control?liveId=${liveId}`, { type: 'commit' })
  await sleep(100)
  const closed = (await t.post(`/api/dsh-dgx-audio/v1/live/close?liveId=${liveId}`, {})).body
  assert.ok(closed.input, JSON.stringify(closed))
  assert.equal(closed.input.receiptId, 'rc-1')
  assert.deepEqual(closed.transcripts.map(x => x.text), ['hello world'])
  const fx = await fakeStore(staged[0].bytes, staged[0].name)
  const adapterStore = createAudioPlugin // keep lint quiet about unused import patterns
  void adapterStore
  const replayAdapter = t.p.adapter
  replayAdapter.deps = { ...replayAdapter.deps, attachments: () => fx.store }
  const chunks = await collect(replayAdapter.stream({ provider: 'rt', model: 'chat', sessionId: 'conv', messages: [user({ type: 'text', text: fileHandleText(fx.ref, fx.path) })] }))
  assert.match(chunks.find(c => c.type === 'block-end').block.text, /^hello world/)
  t.p.dispose()
})

test('resume URL carries resume=1 and the server session id; server_vad defaults overlap_policy to barge_in_on_speech', async (tc) => {
  const opens = []
  let first = true
  const server = await wsServer((conn) => {
    opens.push(conn.url)
    conn.onMessage((m) => {
      if (m.type === 'session.update') { conn.update = m.session; conn.send({ type: 'session.created', incarnation: 2, resume_token: 'tok', session: { id: 'srv-77', capabilities: { supports_session_resume: true } }, server_event_seq: 1 }) }
      if (m.type === 'session.resume') conn.send({ type: 'session.resumed', session_id: m.session_id, incarnation: 2, resume_token: 'tok2' })
      if (m.type === 'input_audio_buffer.append' && first) { first = false; setTimeout(() => conn.destroy(), 10) }
    })
  })
  tc.after(() => server.close())
  const t = await plugin([{ provider: 'd', displayName: 'D', baseURL: server.baseURL, models: [{ id: 'duplex', mode: 'realtime' }] }])
  const { liveId } = (await t.post('/api/dsh-dgx-audio/v1/live/open', { sessionId: 'conv', provider: 'd', model: 'duplex', turnDetection: 'server_vad' })).body
  assert.equal(server.connections[0].update.overlap_policy, 'barge_in_on_speech')
  assert.deepEqual(server.connections[0].update.turn_detection, { type: 'server_vad', interrupt_response: true })
  await t.call(`/api/dsh-dgx-audio/v1/live/append?liveId=${liveId}&seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm16(0.2) })
  await sleep(700)
  const resumeUrl = opens[1]
  assert.equal(resumeUrl.searchParams.get('resume'), '1')
  assert.equal(resumeUrl.searchParams.get('session_id'), 'srv-77')
  assert.equal(resumeUrl.searchParams.get('autostart'), '0')
  await t.p.live.closeAll('test')
  t.p.dispose()
})
