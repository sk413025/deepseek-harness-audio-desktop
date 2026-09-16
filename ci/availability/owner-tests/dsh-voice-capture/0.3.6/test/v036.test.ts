// dsh-voice-capture 0.3.6: a Live start must never revive a session that ended while the microphone was opening
// (pre16 packaged Desktop 12:29: live/open ok → microphone permission answered after the host's 15 s idle close → panel
// dismissed → capture opened → phase `live` without a liveId → 0 frames sent, CLIENT_BACKLOG). Microphone permission is
// now asked before live/open.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LiveController } from '../src/client/audio/live.ts'
import { CaptureError } from '../src/client/capture.ts'
import type { CaptureBackend, CaptureOpenOptions } from '../src/client/capture.ts'

const S = 'session-036' as SessionId
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function gate() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Capture double whose permission and open can be held open, like a macOS permission prompt. */
class GatedCapture implements CaptureBackend {
  prepared = 0
  opened = 0
  closed = 0
  frames: ((chunk: Float32Array) => void) | undefined
  prepareGate: ReturnType<typeof gate> | undefined
  openGate: ReturnType<typeof gate> | undefined
  constructor(private readonly withPrepare: boolean) {
    if (!withPrepare) (this as { prepare?: unknown }).prepare = undefined
  }
  support() { return undefined }
  async listDevices() { return [] }
  onDeviceChange() { return () => {} }
  async prepare() {
    this.prepared++
    if (this.prepareGate) await this.prepareGate.promise
  }
  async open(options: CaptureOpenOptions) {
    this.opened++
    this.frames = options.onFrames
    if (this.openGate) await this.openGate.promise
    return { sampleRate: options.sampleRate ?? 16000, deviceLabel: 'fixture', deviceId: '', close: async () => { this.closed++ } }
  }
}

function host() {
  const calls: { route: string; at: number }[] = []
  const fetchImpl = async (url: string) => {
    const route = new URL(url, 'http://localhost/').pathname.split('/v1/')[1] ?? url
    calls.push({ route, at: Date.now() })
    if (route === 'live/open') return new Response(JSON.stringify({ ok: true, liveId: 'L1', task: 'duplex', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 }, capabilities: { liveInput: { state: 'advertised' } } }))
    if (route === 'live/append') return new Response(JSON.stringify({ ok: true }))
    if (route === 'live/close') return new Response(JSON.stringify({ ok: false, liveId: 'L1', reason: 'idle', input: null, responses: [], receipt: { state: 'skipped', reason: 'no-input' } }))
    return new Response(JSON.stringify({ ok: true }))
  }
  return { calls, fetchImpl, count: (route: string) => calls.filter(c => c.route === route).length }
}

const frame = () => new Float32Array(3200)

test('Z1 DEMO3 sequence: host idle close while the microphone opens, panel dismissed, then capture opens → no revived session, no backlog, microphone released', async () => {
  const h = host()
  const capture = new GatedCapture(false)
  capture.openGate = gate()
  const live = new LiveController(capture, h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  const started = live.start(S, { provider: 'p', model: 'm' }, 'advertised', false)
  while (capture.opened === 0) await tick()
  assert.equal(live.source.getSnapshot().liveId, 'L1')
  live.handleEvent({ type: 'live.state', liveId: 'L1', state: 'closed' })
  assert.equal(live.source.getSnapshot().phase, 'closed')
  await tick()
  live.dismiss()
  assert.equal(live.source.getSnapshot().phase, 'idle')
  capture.openGate.resolve()
  await started
  const snapshot = live.source.getSnapshot()
  assert.equal(snapshot.phase, 'idle', `phase after the late capture: ${snapshot.phase}`)
  assert.equal(capture.closed, 1, 'the late capture is closed at once')
  for (let i = 0; i < 80; i++) capture.frames?.(frame())
  await tick()
  assert.equal(live.source.getSnapshot().phase, 'idle')
  assert.equal(live.source.getSnapshot().error, undefined, 'no CLIENT_BACKLOG')
  assert.equal(h.count('live/append'), 0)
})

test('Z2 host idle close while the microphone opens (panel not dismissed) → stays closed, no append to the dead session', async () => {
  const h = host()
  const capture = new GatedCapture(false)
  capture.openGate = gate()
  const live = new LiveController(capture, h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  const started = live.start(S, { provider: 'p', model: 'm' }, 'advertised', false)
  while (capture.opened === 0) await tick()
  live.handleEvent({ type: 'live.state', liveId: 'L1', state: 'closed' })
  capture.openGate.resolve()
  await started
  for (let i = 0; i < 3; i++) capture.frames?.(frame())
  await tick()
  assert.equal(live.source.getSnapshot().phase, 'closed')
  assert.equal(capture.closed, 1)
  assert.equal(h.count('live/append'), 0)
})

test('Z3 microphone permission is answered before live/open (the host idle timer never runs during the prompt); then frames flow', async () => {
  const h = host()
  const capture = new GatedCapture(true)
  capture.prepareGate = gate()
  const live = new LiveController(capture, h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  const started = live.start(S, { provider: 'p', model: 'm' }, 'advertised', false)
  while (capture.prepared === 0) await tick()
  await tick()
  assert.equal(h.count('live/open'), 0, 'no host session while the permission prompt is open')
  assert.equal(live.source.getSnapshot().waitingMic, true)
  assert.equal(live.source.getSnapshot().phase, 'opening')
  capture.prepareGate.resolve()
  await started
  assert.equal(h.count('live/open'), 1)
  assert.equal(live.source.getSnapshot().phase, 'live')
  assert.equal(live.source.getSnapshot().waitingMic, false)
  capture.frames?.(frame())
  for (let i = 0; i < 20 && h.count('live/append') === 0; i++) await tick()
  assert.equal(h.count('live/append'), 1)
  await live.dispose()
})

test('Z4 permission denied → error before any host session is opened', async () => {
  const h = host()
  const capture = new GatedCapture(true)
  capture.prepareGate = gate()
  const live = new LiveController(capture, h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  const started = live.start(S, { provider: 'p', model: 'm' }, 'advertised', false)
  while (capture.prepared === 0) await tick()
  capture.prepareGate.reject(new CaptureError('permission-denied', 'denied'))
  await started
  assert.equal(live.source.getSnapshot().phase, 'error')
  assert.equal(live.source.getSnapshot().error?.code, 'permission-denied')
  assert.equal(h.count('live/open'), 0)
  assert.equal(capture.opened, 0)
})

test('Z5 End live session while the microphone still opens: the opened host session is closed and the late capture released', async () => {
  const h = host()
  const capture = new GatedCapture(false)
  capture.openGate = gate()
  const live = new LiveController(capture, h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  const started = live.start(S, { provider: 'p', model: 'm' }, 'advertised', false)
  while (capture.opened === 0) await tick()
  await live.close()
  await tick()
  assert.equal(live.source.getSnapshot().phase, 'closed')
  assert.ok(h.count('live/close') >= 1, 'host session closed')
  capture.openGate.resolve()
  await started
  assert.equal(live.source.getSnapshot().phase, 'closed')
  assert.equal(capture.closed, 1)
  assert.equal(h.count('live/append'), 0)
})
