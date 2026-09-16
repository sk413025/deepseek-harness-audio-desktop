import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AudioRouteError, NdjsonDecoder, requestJson } from '../src/client/audio/api.ts'
import type { CapabilityDocument } from '../src/client/audio/api.ts'
import { CapabilityDirectory, deriveFeatures } from '../src/client/audio/capabilities.ts'
import { subscribeAudioEvents } from '../src/client/audio/events.ts'
import type { FeedState } from '../src/client/audio/events.ts'
import { LiveController, toPcm16 } from '../src/client/audio/live.ts'
import type { LiveInputRecording } from '../src/client/audio/live.ts'
import { ProgressivePlayer, decodePcm16 } from '../src/client/audio/player.ts'
import type { AudioOutput } from '../src/client/audio/player.ts'
import { recordingLinks } from '../src/client/audio/recordings.ts'
import type { CaptureBackend, CaptureOpenOptions } from '../src/client/capture.ts'

globalThis.location ??= { href: 'http://127.0.0.1:3299/' } as Location

const enc = new TextEncoder()
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const pcmChunk = (samples: number, value = 1000) => {
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true)
  return b64(bytes)
}

test('NDJSON decoder handles fragmented, coalesced, CRLF and malformed lines', () => {
  const decoder = new NdjsonDecoder(64)
  const text = '{"type":"hello","cursor":"c1"}\r\n{"type":"ping"}\n{"type":"audio.chunk","seq":0}\nnot json\n{"type":"par'
  const bytes = enc.encode(text)
  const values: unknown[] = []
  const errors: string[] = []
  for (let i = 0; i < bytes.length; i += 7) {
    const batch = decoder.push(bytes.subarray(i, i + 7))
    values.push(...batch.values)
    errors.push(...batch.errors)
  }
  const tail = decoder.push(enc.encode('tial"}\n'))
  values.push(...tail.values)
  assert.deepEqual(values.map(v => (v as { type: string }).type), ['hello', 'ping', 'audio.chunk', 'partial'])
  assert.equal(errors.length, 1)
  assert.match(decoder.push(enc.encode('x'.repeat(100))).errors[0]!, /exceeds/)
  assert.deepEqual(new NdjsonDecoder().end().values, [])
  const multibyte = new NdjsonDecoder()
  const line = enc.encode('{"text":"語音"}\n')
  assert.deepEqual([...multibyte.push(line.subarray(0, 10)).values, ...multibyte.push(line.subarray(10)).values], [{ text: '語音' }])
})

test('requestJson unwraps contract errors', async () => {
  const fake = async (_url: string) => new Response(JSON.stringify({ ok: false, error: { code: 'LIVE_CLOSED', message: 'gone' } }), { status: 410 })
  await assert.rejects(requestJson(fake, '/api/x'), (error: unknown) => error instanceof AudioRouteError && error.code === 'LIVE_CLOSED' && error.status === 410)
  const notJson = async () => new Response('<html>', { status: 404 })
  await assert.rejects(requestJson(notJson, '/api/x'), (error: unknown) => error instanceof AudioRouteError && error.code === 'HTTP_404')
})

class FakeOutput implements AudioOutput {
  currentTime = 10
  scheduled: { when: number; frames: number; stopped: boolean; end: () => void }[] = []
  resumed = 0
  closed = 0
  schedule(samples: readonly Float32Array[], _rate: number, when: number, onEnded: () => void) {
    const entry = { when, frames: samples[0]!.length, stopped: false, end: onEnded }
    this.scheduled.push(entry)
    return { stop: () => { if (!entry.stopped) { entry.stopped = true; onEnded() } } }
  }
  async resume() { this.resumed++ }
  async close() { this.closed++ }
}

test('progressive player schedules by startSample, drops stale epochs and labels delivery truthfully', () => {
  const output = new FakeOutput()
  let clock = 1000
  // One coherent clock for performance.now, timeOrigin and the wall clock (0.3.5 compares output-clock play times with the end).
  const player = new ProgressivePlayer(() => output, () => clock, { timeOrigin: 0, wallNow: () => clock, startSampling: () => () => {} })
  player.handle({ type: 'audio.start', streamId: 's1', origin: 'chat' })
  player.handle({ type: 'audio.format', streamId: 's1', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 's1', seq: 0, epoch: 0, startSample: 0, samples: 2400, data: pcmChunk(2400) })
  clock = 1100
  player.handle({ type: 'audio.chunk', streamId: 's1', seq: 1, epoch: 0, startSample: 2400, samples: 2400, data: pcmChunk(2400) })
  assert.equal(output.scheduled.length, 2)
  assert.ok(Math.abs(output.scheduled[1]!.when - output.scheduled[0]!.when - 0.1) < 1e-9)
  let snapshot = player.source.getSnapshot()
  assert.equal(snapshot.phase, 'playing')
  assert.equal(snapshot.hostDelivery, 'pending')
  assert.equal(snapshot.firstChunkAt, 1000)
  output.currentTime = output.scheduled[0]!.when + 0.05
  assert.deepEqual(player.playedPosition(), { streamId: 's1', origin: 'chat', playedMs: 50 })
  player.handle({ type: 'audio.epoch', streamId: 's1', epoch: 1, reason: 'barge-in' })
  assert.ok(output.scheduled.every(entry => entry.stopped))
  player.handle({ type: 'audio.chunk', streamId: 's1', seq: 2, epoch: 0, startSample: 4800, samples: 2400, data: pcmChunk(2400) })
  assert.equal(player.source.getSnapshot().droppedChunks, 1)
  player.handle({ type: 'audio.chunk', streamId: 's1', seq: 3, epoch: 1, startSample: 7200, samples: 2400, data: pcmChunk(2400) })
  assert.equal(output.scheduled.length, 3)
  clock = 1500
  player.handle({ type: 'audio.end', streamId: 's1', status: 'completed', delivery: 'progressive', chunks: 4 })
  snapshot = player.source.getSnapshot()
  assert.equal(snapshot.hostDelivery, 'progressive')
  assert.equal(snapshot.playedBeforeEnd, true)
  assert.equal(snapshot.phase, 'playing')
  output.scheduled[2]!.end()
  assert.equal(player.source.getSnapshot().phase, 'ended')
})

test('final-only delivery is not reported as streaming; stop and autoplay silence later chunks', async () => {
  const output = new FakeOutput()
  const player = new ProgressivePlayer(() => output, () => 0)
  player.handle({ type: 'audio.start', streamId: 's2' })
  player.handle({ type: 'audio.format', streamId: 's2', encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 's2', seq: 0, epoch: 0, startSample: 0, samples: 16000, data: pcmChunk(16000) })
  player.handle({ type: 'audio.end', streamId: 's2', status: 'completed', delivery: 'final-only', chunks: 1 })
  assert.equal(player.source.getSnapshot().playedBeforeEnd, false)
  assert.equal(player.source.getSnapshot().hostDelivery, 'final-only')
  player.stop()
  assert.equal(player.source.getSnapshot().phase, 'stopped')
  player.setAutoplay(false)
  player.handle({ type: 'audio.start', streamId: 's3' })
  player.handle({ type: 'audio.format', streamId: 's3', encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 's3', seq: 0, epoch: 0, startSample: 0, samples: 160, data: pcmChunk(160) })
  assert.equal(output.scheduled.length, 1)
  assert.equal(player.source.getSnapshot().chunks, 1)
  await player.dispose()
  assert.equal(output.closed, 1)
})

test('late chunks re-anchor at the output clock and gaps are counted', () => {
  const output = new FakeOutput()
  const player = new ProgressivePlayer(() => output, () => 0)
  player.handle({ type: 'audio.start', streamId: 'g' })
  player.handle({ type: 'audio.format', streamId: 'g', encoding: 'pcm_s16le', sampleRate: 16000, channels: 2 })
  player.handle({ type: 'audio.chunk', streamId: 'g', seq: 0, epoch: 0, startSample: 0, samples: 1600, data: pcmChunk(3200) })
  assert.equal(output.scheduled[0]!.frames, 1600)
  output.currentTime += 5
  player.handle({ type: 'audio.gap', streamId: 'g', fromSeq: 1, toSeq: 3, reason: 'subscriber-overflow' })
  player.handle({ type: 'audio.chunk', streamId: 'g', seq: 4, epoch: 0, startSample: 64000, samples: 1600, data: pcmChunk(3200) })
  assert.ok(output.scheduled[1]!.when >= output.currentTime)
  assert.equal(player.source.getSnapshot().gaps, 1)
  const decoded = decodePcm16(pcmChunk(2, -16384), 1)
  assert.equal(decoded[0]![0], -0.5)
})

test('recording links are extracted from assistant text without transcripts', () => {
  const text = 'Answer.\n\n---\n[▶ DGX audio reply · 24000 Hz · 10.88 s](/api/dsh-dgx-audio/v1/recording?id=rec_abc-123)\n[dup](/api/dsh-dgx-audio/v1/recording?id=rec_abc-123) [x](/api/other?id=1)'
  assert.deepEqual(recordingLinks(text, 42), [{ seq: 42, recordingId: 'rec_abc-123', path: '/api/dsh-dgx-audio/v1/recording?id=rec_abc-123', label: '▶ DGX audio reply · 24000 Hz · 10.88 s' }])
  assert.deepEqual(recordingLinks('no links', 1), [])
})

const DOC: CapabilityDocument = {
  contractVersion: '0.1',
  configured: true,
  routes: [{
    provider: 'dgx-omni',
    models: [
      { id: 'minicpm', mode: 'realtime', capabilities: { liveInput: { state: 'advertised' }, bargeIn: { state: 'verified' }, audioOutputStreaming: { state: 'verified', observedDelivery: 'progressive' } } },
      { id: 'qwen', mode: 'chat', capabilities: { liveInput: { state: 'unsupported' }, audioOutputStreaming: { state: 'untested', observedDelivery: 'final-only' } } },
      { id: 'untested-live', mode: 'realtime', capabilities: { liveInput: { state: 'untested' } } },
    ],
  }],
}

test('capability features keep evidence layers distinct and offer live only for declared/advertised/verified', () => {
  const minicpm = deriveFeatures(DOC, 'ready', { provider: 'dgx-omni', model: 'minicpm' }, undefined)
  assert.equal(minicpm.liveOffered, true)
  assert.equal(minicpm.liveState, 'advertised')
  assert.equal(minicpm.bargeInState, 'verified')
  assert.equal(minicpm.observedDelivery, 'progressive')
  assert.deepEqual(minicpm.liveModel, { provider: 'dgx-omni', model: 'minicpm' })
  const qwen = deriveFeatures(DOC, 'ready', { provider: 'dgx-omni', model: 'qwen' }, undefined)
  assert.equal(qwen.observedDelivery, 'final-only')
  assert.equal(qwen.liveOffered, true, 'a realtime model of the same route is offered for the selected chat model')
  assert.deepEqual(qwen.liveModel, { provider: 'dgx-omni', model: 'minicpm' })
  assert.equal(qwen.liveState, 'advertised')
  const onlyUntested: CapabilityDocument = { ...DOC, routes: [{ provider: 'r', models: [DOC.routes[0]!.models[1]!, DOC.routes[0]!.models[2]!] }] }
  assert.equal(deriveFeatures(onlyUntested, 'ready', { provider: 'r', model: 'qwen' }, undefined).liveOffered, false)
  const other = deriveFeatures(DOC, 'ready', { provider: 'ollama', model: 'x' }, undefined)
  assert.equal(other.model, undefined)
  assert.equal(other.liveState, 'unsupported')
})

test('capability directory reads the document once, reports absent routes, and follows the model selection', async () => {
  let calls = 0
  const directory = new CapabilityDirectory(async () => { calls++; return new Response(JSON.stringify(DOC), { status: 200 }) }, () => 0, 10_000)
  let selection: unknown = { lastUsed: null, next: { provider: 'dgx-omni', model: 'qwen' } }
  const listeners = new Set<() => void>()
  const source = directory.featuresFor({ getSnapshot: () => selection, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } })
  const unsubscribe = source.subscribe(() => {})
  await directory.load()
  assert.equal(source.getSnapshot().routes, 'ready')
  assert.equal(source.getSnapshot().model?.id, 'qwen')
  const before = source.getSnapshot()
  assert.equal(source.getSnapshot(), before)
  selection = { lastUsed: null, next: { provider: 'dgx-omni', model: 'minicpm' } }
  for (const listener of listeners) listener()
  assert.equal(source.getSnapshot().liveOffered, true)
  assert.equal(calls, 1)
  unsubscribe()
  const absent = new CapabilityDirectory(async () => new Response('{"ok":false,"error":{"code":"NOT_FOUND","message":"x"}}', { status: 404 }))
  await absent.load()
  assert.equal(absent.featuresFor({ getSnapshot: () => undefined, subscribe: () => () => {} }).getSnapshot().routes, 'absent')
})

function streamResponse(lines: string[], { hold = false } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line))
      if (!hold) controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

test('event feed reconnects with the last cursor and stops on 404', async () => {
  const urls: string[] = []
  const events: string[] = []
  const states: FeedState[] = []
  let call = 0
  const fetchImpl = async (url: string) => {
    urls.push(url)
    call++
    if (call === 1) return streamResponse(['{"type":"hello","cursor":"c0"}\n{"type":"audio.start","cursor":"c1","streamId":"s"}\n{"type":"audio.ch', 'unk","cursor":"c2","streamId":"s"}\n'])
    if (call === 2) return streamResponse(['{"type":"audio.end","cursor":"c3","streamId":"s"}\n'])
    return new Response('', { status: 404 })
  }
  await new Promise<void>((resolve) => {
    subscribeAudioEvents(fetchImpl, 'session 1', {
      onEvent: event => events.push(event.type),
      onState: (state) => { states.push(state); if (state === 'absent') resolve() },
    }, async () => {})
  })
  assert.deepEqual(events, ['hello', 'audio.start', 'audio.chunk', 'audio.end'])
  assert.match(urls[0]!, /events\?sessionId=session\+1$/)
  assert.match(urls[1]!, /after=c2/)
  assert.match(urls[2]!, /after=c3/)
  assert.ok(states.includes('open') && states.includes('retrying'))
  const aborted: FeedState[] = []
  const stop = subscribeAudioEvents(async (_url, init) => {
    await new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))))
    return new Response('')
  }, 's', { onEvent: () => {}, onState: state => aborted.push(state) })
  stop()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(aborted.at(-1), 'closed')
})

class FakeCapture implements CaptureBackend {
  options: CaptureOpenOptions | undefined
  closed = 0
  sampleRate = 16000
  support() { return undefined }
  async listDevices() { return [] }
  onDeviceChange() { return () => {} }
  async open(options: CaptureOpenOptions) {
    this.options = options
    return { sampleRate: options.sampleRate ?? this.sampleRate, deviceLabel: 'fixture', deviceId: '', close: async () => { this.closed++ } }
  }
}

test('live mode transmits 200 ms PCM frames in order, retries 429, commits, closes and logs the staged input', async () => {
  const requests: { url: string; body: unknown }[] = []
  let busyOnce = true
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const body = init?.body instanceof Uint8Array ? init.body.byteLength : init?.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ url, body })
    if (path.endsWith('/live/open')) return new Response(JSON.stringify({ ok: true, liveId: 'L1', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 } }))
    if (path.endsWith('/live/append')) {
      if (busyOnce) { busyOnce = false; return new Response('{"ok":false,"error":{"code":"BUFFER_FULL","message":"wait"}}', { status: 429 }) }
      return new Response(JSON.stringify({ ok: true }))
    }
    if (path.endsWith('/live/control')) return new Response(JSON.stringify({ ok: true }))
    if (path.endsWith('/live/close')) return new Response(JSON.stringify({ ok: true, input: { recordingId: 'rec_live_input_0001', bytes: 12844, sha256: 'ab', receiptId: 'rcpt-1', attachmentId: 'sha256:ab' }, responses: [] }))
    return new Response('', { status: 404 })
  }
  const capture = new FakeCapture()
  const logged: LiveInputRecording[] = []
  const live = new LiveController(capture, fetchImpl, () => false, async (_sessionId, input) => { logged.push(input); return { ok: true } }, () => 0)
  await live.start('S' as SessionId, { provider: 'dgx-omni', model: 'minicpm' }, 'advertised', false)
  assert.equal(live.source.getSnapshot().phase, 'live')
  assert.equal(capture.options?.sampleRate, 16000)
  // No overlapPolicy unless the user asks for barge-in: nightly server VAD rejects listen_only (I2 02:21).
  assert.deepEqual(requests[0]!.body, { sessionId: 'S', provider: 'dgx-omni', model: 'minicpm' })
  capture.options!.onFrames(new Float32Array(3200 * 2 + 100).fill(0.25))
  live.handleEvent({ type: 'live.input.accepted', liveId: 'L1', seq: 0 })
  live.handleEvent({ type: 'live.input.accepted', liveId: 'OTHER', seq: 0 })
  live.handleEvent({ type: 'live.response', liveId: 'L1', responseId: 'r1', status: 'created' })
  live.handleEvent({ type: 'text.delta', streamId: 'r1', responseId: 'r1', text: 'hel' })
  live.handleEvent({ type: 'text.delta', streamId: 'x', responseId: 'x', text: 'ignored' })
  live.handleEvent({ type: 'live.error', liveId: 'L1', code: 'stale_fence', message: 'no active response', fatal: false })
  await new Promise(resolve => setTimeout(resolve, 150))
  await live.endInput()
  await live.playbackAck('r1', 320)
  await live.close()
  const appends = requests.filter(r => r.url.includes('/live/append'))
  assert.deepEqual(appends.map(r => new URL(r.url).searchParams.get('seq')), ['0', '0', '1', '2'])
  assert.deepEqual(appends.map(r => r.body), [6400, 6400, 6400, 200])
  const controls = requests.filter(r => r.url.includes('/live/control')).map(r => r.body)
  assert.deepEqual(controls, [{ type: 'commit' }, { type: 'playback-ack', responseId: 'r1', playedMs: 320 }])
  const snapshot = live.source.getSnapshot()
  assert.equal(snapshot.phase, 'closed')
  assert.equal(snapshot.accepted, 1)
  assert.equal(snapshot.acceptedWhileCapturing, 1)
  assert.equal(snapshot.transcript, 'hel')
  assert.equal(snapshot.framesAcked, 3)
  assert.match(snapshot.notice ?? '', /stale_fence/)
  assert.equal(snapshot.log, 'logged')
  assert.equal(logged[0]!.receiptId, 'rcpt-1')
  assert.equal(capture.closed, 1)
  assert.ok(requests.findIndex(r => r.url.includes('/live/control')) > requests.findLastIndex(r => r.url.includes('/live/append')))
  assert.deepEqual([...toPcm16(new Float32Array([1, -1, 0]))], [0xff, 0x7f, 0x00, 0x80, 0x00, 0x00])
})

test('live mode reports a closed session (410) and refuses while the microphone records', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('/live/open')) return new Response(JSON.stringify({ ok: true, liveId: 'L2', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 6400 } }))
    if (url.includes('/live/append')) return new Response('{"ok":false,"error":{"code":"LIVE_CLOSED","message":"idle"}}', { status: 410 })
    return new Response('{"ok":true}')
  }
  const capture = new FakeCapture()
  const live = new LiveController(capture, fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start('S' as SessionId, { provider: 'p', model: 'm' }, 'verified', true)
  capture.options!.onFrames(new Float32Array(3200))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(live.source.getSnapshot().phase, 'error')
  assert.equal(live.source.getSnapshot().error?.code, 'LIVE_CLOSED')
  assert.equal(capture.closed, 1)
  live.dismiss()
  const busy = new LiveController(capture, fetchImpl, () => true, async () => ({ ok: true }), () => 0)
  await busy.start('S' as SessionId, { provider: 'p', model: 'm' }, 'verified', false)
  assert.equal(busy.source.getSnapshot().error?.code, 'MIC_BUSY')
  live.handleEvent({ type: 'live.state', liveId: 'L2', state: 'closed', error: { code: 'IDLE_TIMEOUT', message: '' } })
})

test('reply recordings Definition publishes Turn data under its own kind and folds assistant messages', async () => {
  const { voiceAudioDefinition, selectReplyRecordings } = await import('../src/client/audio/recordings.ts')
  const def = voiceAudioDefinition
  const start = { event: { type: 'turn/start', seq: 5, data: { turn: 2 } } }
  assert.deepEqual(def.match(start.event as never), { id: '2', role: 'start' })
  let state = def.start({} as never, start as never, {} as never)
  const message = { event: { type: 'assistant/message', seq: 9, data: { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'hi\n[▶ reply](/api/dsh-dgx-audio/v1/recording?id=r1.abc_DEF-9)' }] } } } }
  assert.deepEqual(def.match(message.event as never), { id: '2', role: 'update' })
  state = def.update({ state } as never, message as never)
  assert.equal(state.recordings.length, 1)
  assert.equal(def.update({ state } as never, message as never), state)
  const published = def.buildLocationData!({ state } as never, 'turn', null)
  assert.equal(published?.key, def.kind, 'Location data key must equal the Definition kind')
  assert.equal(def.buildLocationData!({ state } as never, 'turn', published), published)
  assert.equal(def.buildLocationData!({ state } as never, 'step', null), null)
  const owner = { turn: { data: { get: (key: string) => (key === 'voiceAudio' ? published?.value : undefined) } }, seq: 9, openFile: () => {} }
  assert.equal(selectReplyRecordings(owner as never)?.recordings[0]?.recordingId, 'r1.abc_DEF-9')
  assert.equal(selectReplyRecordings({ ...owner, seq: 8 } as never), null)
})

test('live mode holds the same frame and control through 503 RECONNECTING without counting them as sent', async () => {
  const requests: { url: string; status: number }[] = []
  let appendReconnects = 2
  let commitReconnects = 1
  const reconnecting = () => new Response('{"ok":false,"error":{"code":"RECONNECTING","message":"retry the same request later"}}', { status: 503 })
  const fetchImpl = async (url: string, init?: RequestInit) => {
    let response: Response
    if (url.includes('/live/open')) response = new Response(JSON.stringify({ ok: true, liveId: 'L3', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 } }))
    else if (url.includes('/live/append')) response = appendReconnects-- > 0 ? reconnecting() : new Response('{"ok":true}')
    else if (url.includes('/live/control') && String(init?.body).includes('commit')) response = commitReconnects-- > 0 ? reconnecting() : new Response('{"ok":true}')
    else response = new Response('{"ok":true}')
    requests.push({ url, status: response.status })
    return response
  }
  const capture = new FakeCapture()
  const live = new LiveController(capture, fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start('S' as SessionId, { provider: 'p', model: 'm' }, 'declared', false)
  const seen: boolean[] = []
  live.source.subscribe(() => { seen.push(live.source.getSnapshot().reconnecting) })
  capture.options!.onFrames(new Float32Array(3200))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(live.source.getSnapshot().framesSent, 0, 'a frame answered 503 is not sent yet')
  assert.equal(live.source.getSnapshot().reconnecting, true)
  assert.equal(live.source.getSnapshot().phase, 'live')
  assert.equal(capture.closed, 0, 'capture keeps running while the host reconnects')
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(live.source.getSnapshot().framesSent, 1)
  assert.equal(live.source.getSnapshot().reconnecting, false)
  await live.endInput()
  await live.close()
  const appends = requests.filter(r => r.url.includes('/live/append'))
  assert.deepEqual(appends.map(r => [new URL(r.url).searchParams.get('seq'), r.status]), [['0', 503], ['0', 503], ['0', 200]])
  assert.deepEqual(requests.filter(r => r.url.includes('/live/control')).map(r => r.status), [503, 200])
  assert.equal(live.source.getSnapshot().phase, 'closed')
  assert.ok(seen.includes(true) && seen.at(-1) === false)
})

test('live mode follows host reconnect/resume states and logs an exchange the host closed on its own', async () => {
  const requests: string[] = []
  const fetchImpl = async (url: string) => {
    requests.push(new URL(url).pathname)
    if (url.includes('/live/open')) return new Response(JSON.stringify({ ok: true, liveId: 'L4', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 } }))
    if (url.includes('/live/close')) return new Response(JSON.stringify({ ok: false, liveId: 'L4', reason: 'backend-lost', input: { recordingId: 'rec_live_input_0004', bytes: 6444, sha256: 'cd', receiptId: 'rcpt-4', attachmentId: 'sha256:cd' }, responses: [], error: { code: 'RESYNC_REQUIRED', message: 'resume failed' } }))
    return new Response('{"ok":true}')
  }
  const capture = new FakeCapture()
  const logged: LiveInputRecording[] = []
  const live = new LiveController(capture, fetchImpl, () => false, async (_s, input) => { logged.push(input); return { ok: true } }, () => 0)
  await live.start('S' as SessionId, { provider: 'p', model: 'm' }, 'advertised', false)
  live.handleEvent({ type: 'live.state', liveId: 'L4', state: 'reconnecting', code: 1006 })
  assert.equal(live.source.getSnapshot().reconnecting, true)
  assert.equal(live.source.getSnapshot().phase, 'live')
  live.handleEvent({ type: 'live.state', liveId: 'L4', state: 'ready', resumed: true, attempts: 2 })
  assert.equal(live.source.getSnapshot().reconnecting, false)
  assert.equal(live.source.getSnapshot().resumes, 1)
  live.handleEvent({ type: 'live.state', liveId: 'L4', state: 'reconnecting' })
  live.handleEvent({ type: 'live.error', liveId: 'L4', code: 'session_resume_conflict', message: 'retrying', fatal: false })
  live.handleEvent({ type: 'live.state', liveId: 'L4', state: 'closed', error: { code: 'RESYNC_REQUIRED', message: 'resume failed' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  const snapshot = live.source.getSnapshot()
  assert.equal(snapshot.phase, 'closed')
  assert.equal(snapshot.reconnecting, false)
  assert.equal(snapshot.error?.code, 'RESYNC_REQUIRED')
  assert.equal(capture.closed, 1)
  assert.equal(snapshot.log, 'logged')
  assert.equal(logged[0]!.receiptId, 'rcpt-4')
  assert.deepEqual(requests.filter(path => path.endsWith('/live/close')).length, 1)
})
