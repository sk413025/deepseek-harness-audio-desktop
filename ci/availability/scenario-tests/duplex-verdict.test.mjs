// Verdict logic for full-duplex desktop runs, with the negative controls the user asked for (blocked input, dropped or
// silent output, metadata only, old response replayed, no-op Interrupt, dirty close). Synthetic timelines only: this
// proves the judge, not any app or model. Run in place by run.mjs (suite verdict-ci).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { duplexVerdicts } from '../duplex-verdict.mjs'

function good() {
  const t0 = 1_000_000
  const frames = []
  let seq = 0
  // A: 0–2 s, B: 3–5 s (starts while A's reply plays 2.5–6 s), C: 7–9 s
  for (const [clip, from, to] of [['A', 0, 2000], ['B', 3000, 5000], ['C', 7000, 9000]]) {
    for (let at = from; at < to; at += 200) frames.push({ clip, seq: ++seq, sentAt: t0 + at, ackAt: t0 + at + 40, status: 200 })
  }
  return {
    clips: { A: { startAt: t0, endAt: t0 + 2000 }, B: { startAt: t0 + 3000, endAt: t0 + 5000 }, C: { startAt: t0 + 7000, endAt: t0 + 9000 } },
    frames,
    chunks: [
      ...[2400, 2600, 2800, 3000].map(at => ({ responseId: 'r1', receivedAt: t0 + at, bytes: 9600, decodable: true, rms: 0.2 })),
      ...[5600, 5800, 6000].map(at => ({ responseId: 'r2', receivedAt: t0 + at, bytes: 9600, decodable: true, rms: 0.2 })),
      ...[9400, 9600].map(at => ({ responseId: 'r3', receivedAt: t0 + at, bytes: 9600, decodable: true, rms: 0.2 })),
    ],
    playback: [{ responseId: 'r1', startAt: t0 + 2500, endAt: t0 + 4600 }, { responseId: 'r2', startAt: t0 + 5700, endAt: t0 + 6600 }, { responseId: 'r3', startAt: t0 + 9500, endAt: t0 + 10200 }],
    controls: [{ kind: 'interrupt', at: t0 + 6000, outcome: 'cancelled', responseId: 'r2', responseDone: 'cancelled' }],
    close: { at: t0 + 11000, ok: true, captureStoppedAt: t0 + 11200, appendsAfterClose: 0, playbackAfterClose: 0 },
  }
}

test('D-verdict positive: all four verdicts pass on a well-formed duplex timeline', () => {
  const v = duplexVerdicts(good())
  for (const [name, result] of Object.entries(v)) assert.equal(result.status, 'pass', `${name}: ${result.reason}`)
})

test('D-verdict negative: input blocked until output ends fails simultaneousIO only', () => {
  const t = good()
  const end = Math.max(...t.playback.map(p => p.endAt))
  for (const frame of t.frames) if (frame.clip === 'B') frame.ackAt = end + 100
  const v = duplexVerdicts(t)
  assert.equal(v.simultaneousIO.status, 'fail')
  assert.match(v.simultaneousIO.reason, /blocked|buffered/)
  assert.equal(v.outputPresence.status, 'pass')
})

test('D-verdict negative: dropped output (no audio chunks) fails outputPresence and simultaneousIO progress', () => {
  const t = good()
  t.chunks = []
  const v = duplexVerdicts(t)
  assert.equal(v.outputPresence.status, 'fail')
  assert.equal(v.simultaneousIO.status, 'fail')
})

test('D-verdict negative: silent-only or undecodable output is not output', () => {
  const silent = good()
  for (const chunk of silent.chunks) chunk.rms = 0
  assert.equal(duplexVerdicts(silent).outputPresence.status, 'fail')
  const undecodable = good()
  for (const chunk of undecodable.chunks) chunk.decodable = false
  assert.equal(duplexVerdicts(undecodable).outputPresence.status, 'fail')
})

test('D-verdict negative: received but never played output fails outputPresence', () => {
  const t = good()
  t.playback = []
  assert.equal(duplexVerdicts(t).outputPresence.status, 'fail')
})

test('D-verdict negative: output after B that only continues the old response is not progress', () => {
  const t = good()
  t.chunks = t.chunks.map(c => ({ ...c, responseId: 'r1' }))
  t.playback = t.playback.map(p => ({ ...p, responseId: 'r1' }))
  const v = duplexVerdicts(t)
  assert.equal(v.simultaneousIO.status, 'fail')
  assert.match(v.simultaneousIO.reason, /old response|no new progress/)
})

test('D-verdict negative: Interrupt no-op, underrun gap, or late playback of the interrupted response is not a pass', () => {
  const noop = good()
  noop.controls[0].outcome = 'no-active-response'
  assert.equal(duplexVerdicts(noop).interrupt.status, 'fail')
  const gap = good()
  gap.controls[0].at = gap.playback[1].endAt + 500
  assert.match(duplexVerdicts(gap).interrupt.reason, /active audible playback/)
  const late = good()
  late.playback.push({ responseId: 'r2', startAt: late.controls[0].at + 1000, endAt: late.controls[0].at + 1200 })
  assert.equal(duplexVerdicts(late).interrupt.status, 'fail')
})

test('D-verdict negative: dirty close (append or playback after close, capture not released) fails cleanup', () => {
  for (const mutate of [c => { c.appendsAfterClose = 2 }, c => { c.playbackAfterClose = 1 }, c => { c.captureStoppedAt = null }, c => { c.ok = false }]) {
    const t = good()
    mutate(t.close)
    assert.equal(duplexVerdicts(t).cleanup.status, 'fail')
  }
})
