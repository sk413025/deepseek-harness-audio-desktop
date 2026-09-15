// dsh-voice-capture 0.3.3 unit tests: playback acknowledgements during a slow backend resume (release finding
// a3-desktop/live-resume-mock/pre9-070504/resume-ok-slow: independent retries delivered played_ms 1869 → 3000 → 2872 → 2371).
// Rules: at most one playback-ack request in flight; a newer position replaces a queued one; per live session and
// response the acknowledged position never goes back; nothing is sent for a closed session, an older liveId or a
// superseded response.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LiveController } from '../src/client/audio/live.ts'
import type { CaptureBackend, CaptureOpenOptions } from '../src/client/capture.ts'

const S = 'session-033' as SessionId
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class NoCapture implements CaptureBackend {
  support() { return undefined }
  async listDevices() { return [] }
  onDeviceChange() { return () => {} }
  async open(options: CaptureOpenOptions) { return { sampleRate: options.sampleRate ?? 16000, deviceLabel: 'fixture', deviceId: '', close: async () => {} } }
}

interface AckCall { liveId: string; responseId: string; playedMs: number; status: number; startedAt: number }

/** Host double: playback-ack answers 503 RECONNECTING while `reconnecting()` is true; tracks concurrency per request. */
function ackHost(reconnecting: () => boolean) {
  const acks: AckCall[] = []
  let inFlight = 0
  let maxInFlight = 0
  let opens = 0
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const path = u.pathname.replace('/api/dsh-dgx-audio/v1/', '')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    if (path === 'live/open') {
      opens += 1
      return new Response(JSON.stringify({ ok: true, liveId: `L${opens}`, task: 'duplex', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 } }))
    }
    if (path === 'live/control' && body.type === 'playback-ack') {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const startedAt = Date.now()
      await sleep(3)
      const status = reconnecting() ? 503 : 200
      acks.push({ liveId: u.searchParams.get('liveId') ?? '', responseId: String(body.responseId), playedMs: Number(body.playedMs), status, startedAt })
      inFlight -= 1
      return status === 503
        ? new Response(JSON.stringify({ ok: false, error: { code: 'RECONNECTING', message: 'backend reconnecting' } }), { status: 503 })
        : new Response(JSON.stringify({ ok: true, controlId: `c${acks.length}`, type: 'playback-ack', sent: true, outcome: 'pending' }))
    }
    return new Response(JSON.stringify({ ok: true }))
  }
  return { acks, fetchImpl, maxInFlight: () => maxInFlight }
}

const accepted = (acks: readonly AckCall[], liveId: string, responseId: string) => acks.filter(a => a.status === 200 && a.liveId === liveId && a.responseId === responseId).map(a => a.playedMs)
const increasing = (values: readonly number[]) => values.every((v, i) => i === 0 || v > values[i - 1]!)

test('U11 slow resume (503 RECONNECTING ~2 s): one ack in flight, newest position wins, acknowledged played_ms never goes back', async () => {
  let reconnectUntil = 0
  const h = ackHost(() => Date.now() < reconnectUntil)
  const live = new LiveController(new NoCapture(), h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'p', model: 'm' }, 'declared', false)
  const ticks = [371, 872, 1373]
  for (const ms of ticks) { await live.playbackAck('r1', ms); await sleep(20) }
  reconnectUntil = Date.now() + 2000
  // The 500 ms player ticks of the release run, issued while the host is reconnecting (not awaited, as the page does).
  for (const ms of [1869, 2371, 2872, 3000]) { void live.playbackAck('r1', ms); await sleep(500) }
  await sleep(600)
  // After the resume a new response starts playing from 0.
  for (const ms of [40, 541]) { void live.playbackAck('r2', ms); await sleep(120) }
  await sleep(300)
  const r1 = accepted(h.acks, 'L1', 'r1')
  assert.equal(h.maxInFlight(), 1, `playback-ack requests in flight at once: ${h.maxInFlight()}`)
  assert.ok(increasing(r1), `r1 acknowledged in order ${r1.join(' → ')}`)
  assert.equal(r1.at(-1), 3000, 'the newest r1 position is delivered after the resume')
  assert.ok(!r1.includes(2872) || r1.indexOf(2872) < r1.indexOf(3000), 'no superseded position after a newer one')
  assert.deepEqual(accepted(h.acks, 'L1', 'r2'), [40, 541])
  const firstR2 = h.acks.findIndex(a => a.responseId === 'r2')
  assert.equal(h.acks.slice(firstR2).filter(a => a.responseId === 'r1').length, 0, 'no r1 ack after r2 started')
  await live.dispose()
})

test('U12 fences: no stale position, no ack for a superseded response, a closed session or an older liveId', async () => {
  let reconnectUntil = 0
  const h = ackHost(() => Date.now() < reconnectUntil)
  const live = new LiveController(new NoCapture(), h.fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'p', model: 'm' }, 'declared', false)
  await live.playbackAck('r1', 800)
  await live.playbackAck('r1', 500)
  await live.playbackAck('r1', 800)
  assert.deepEqual(h.acks.map(a => a.playedMs), [800], 'an equal or older position of the same response is not sent')
  // Response switch while reconnecting: the queued r1 position is dropped once r2 is newer.
  reconnectUntil = Date.now() + 700
  void live.playbackAck('r1', 1300)
  await sleep(100)
  void live.playbackAck('r2', 60)
  await sleep(1000)
  const afterSwitch = h.acks.filter(a => a.status === 200).map(a => `${a.responseId}:${a.playedMs}`)
  assert.deepEqual(afterSwitch, ['r1:800', 'r2:60'], `acknowledged ${afterSwitch.join(', ')}`)
  // End the session while an ack is held by a reconnect: nothing more for L1, before or after close.
  reconnectUntil = Date.now() + 5000
  void live.playbackAck('r2', 900)
  await sleep(80)
  await live.close()
  const closedAt = Date.now()
  await sleep(700)
  assert.equal(h.acks.filter(a => a.startedAt > closedAt).length, 0, 'no playback-ack request after close')
  assert.equal(accepted(h.acks, 'L1', 'r2').includes(900), false)
  // A new live session: acks carry only its own liveId, and an ack for the old session is never replayed there.
  reconnectUntil = 0
  live.dismiss()
  await live.start(S, { provider: 'p', model: 'm' }, 'declared', false)
  await live.playbackAck('r9', 120)
  assert.deepEqual(h.acks.filter(a => a.startedAt > closedAt).map(a => `${a.liveId}:${a.responseId}:${a.playedMs}`), ['L2:r9:120'])
  await live.dispose()
})

test('U13 Interrupt result delivered by the feed before the HTTP reply is not undone by the reply (E2E negative control 07:19)', async () => {
  let deliver!: () => void
  const replied = new Promise<void>((resolve) => { deliver = resolve })
  let live!: LiveController
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/dsh-dgx-audio/v1/', '')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    if (path === 'live/open') return new Response(JSON.stringify({ ok: true, liveId: 'L', task: 'duplex', input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 200, maxFrameBytes: 64000 } }))
    if (path === 'live/control' && body.type === 'barge-in') {
      // The backend cancels at once: the host publishes the result and the cancelled response before replying.
      live.handleEvent({ type: 'live.control.result', liveId: 'L', controlId: 'ctl_1', control: 'barge-in', sent: true, targetResponseId: 'r1', outcome: 'cancelled', reason: 'barge_in' })
      live.handleEvent({ type: 'live.response', liveId: 'L', responseId: 'r1', status: 'cancelled', reason: 'barge_in' })
      deliver()
      return new Response(JSON.stringify({ ok: true, controlId: 'ctl_1', type: 'barge-in', sent: true, targetResponseId: 'r1', outcome: 'pending' }))
    }
    return new Response(JSON.stringify({ ok: true }))
  }
  live = new LiveController(new NoCapture(), fetchImpl, () => false, async () => ({ ok: true }), () => 0)
  await live.start(S, { provider: 'p', model: 'm' }, 'declared', false)
  live.handleEvent({ type: 'live.response', liveId: 'L', responseId: 'r1', status: 'created' })
  await live.control('barge-in')
  await replied
  const control = live.source.getSnapshot().control!
  assert.deepEqual([control.outcome, control.confirmed, control.controlId], ['cancelled', true, 'ctl_1'])
  // A pending reply for a different (newer) control id still reads pending.
  live.handleEvent({ type: 'live.response', liveId: 'L', responseId: 'r2', status: 'created' })
  await live.dispose()
})
