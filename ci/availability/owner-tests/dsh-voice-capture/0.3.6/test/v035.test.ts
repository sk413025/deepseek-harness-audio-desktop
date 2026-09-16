// 0.3.5: actual playback timeline (output clock) and cancelled-stream silence.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AudioOutput } from '../src/client/audio/player.ts'
import { ProgressivePlayer } from '../src/client/audio/player.ts'
import { PlaybackTimelineStore, summarizeTimeline } from '../src/client/audio/playback-timeline.ts'
import type { PlaybackTimeline, TimelineStorage } from '../src/client/audio/playback-timeline.ts'

const pcm = (samples: number): string => Buffer.alloc(samples * 2).toString('base64')

/** Fake output whose clock is driven by the test; wall clock = 1_000_000 + output seconds × 1000. */
class ClockOutput implements AudioOutput {
  currentTime = 0
  running = true
  readonly scheduled: { when: number; frames: number; stopped: boolean; end: () => void }[] = []
  schedule(samples: readonly Float32Array[], _rate: number, when: number, onEnded: () => void) {
    const entry = { when, frames: samples[0]!.length, stopped: false, end: onEnded }
    this.scheduled.push(entry)
    return { stop: () => { if (!entry.stopped) { entry.stopped = true; onEnded() } } }
  }
  async resume() {}
  async close() {}
}

function rig() {
  const output = new ClockOutput()
  const finished: PlaybackTimeline[] = []
  const wall = () => 1_000_000 + Math.round(output.currentTime * 1000)
  const player = new ProgressivePlayer(() => output, () => output.currentTime * 1000, {
    wallNow: wall,
    timeOrigin: 1_000_000,
    startSampling: () => () => {},
    onTimeline: timeline => { finished.push(timeline) },
  })
  const advance = (seconds: number) => {
    output.currentTime += seconds
    player.sample()
  }
  return { output, player, finished, wall, advance }
}

const start = (player: ProgressivePlayer, id: string, t: number) => {
  player.handle({ type: 'audio.start', streamId: id, origin: 'chat', task: 'speech.s2s', t })
  player.handle({ type: 'audio.format', streamId: id, encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
}

test('W1 progressive: first chunk sounds before the host generation end; later chunks play in order; timeline finalized once', () => {
  const { player, finished, wall, advance } = rig()
  start(player, 'p', wall())
  // Three 1 s chunks arriving every 0.7 s (faster than realtime), end 0.3 s after the last one.
  for (let seq = 0; seq < 3; seq++) {
    player.handle({ type: 'audio.chunk', streamId: 'p', seq, epoch: 0, startSample: seq * 24000, samples: 24000, data: pcm(24000), t: wall() })
    advance(0.7)
  }
  advance(-0.4) // end arrives 0.3 s after the last chunk
  player.handle({ type: 'audio.end', streamId: 'p', status: 'completed', delivery: 'progressive', chunks: 3, recording: { recordingId: 'rec_p' }, t: wall() })
  let summary = player.source.getSnapshot().timeline!
  assert.equal(summary.firstPlaybackBeforeGenerationEnd, true)
  assert.equal(summary.firstPlaybackAt, 1_000_120, 'first sample audible after the 0.12 s lead')
  assert.equal(summary.chunksPlayedBeforeGenerationEnd, 2)
  assert.equal(finished.length, 0, 'not final while audio still sounds')
  advance(3)
  summary = player.source.getSnapshot().timeline!
  assert.equal(summary.verdict, 'progressive')
  assert.equal(summary.chunksPlayed, 3)
  assert.equal(summary.inOrder, true)
  assert.deepEqual(summary.underruns, [])
  assert.equal(summary.playedSeconds, 3)
  assert.equal(finished.length, 1)
  assert.equal(finished[0]!.recordingId, 'rec_p')
  advance(1)
  assert.equal(finished.length, 1, 'finalized once')
})

test('W2 final-only delivery is labelled "after generation" even though a chunk was scheduled', () => {
  const { player, wall, advance } = rig()
  start(player, 'f', wall())
  advance(5)
  player.handle({ type: 'audio.chunk', streamId: 'f', seq: 0, epoch: 0, startSample: 0, samples: 48000, data: pcm(48000), t: wall() })
  player.handle({ type: 'audio.end', streamId: 'f', status: 'completed', delivery: 'final-only', chunks: 1, t: wall() + 5 })
  advance(3)
  const summary = player.source.getSnapshot().timeline!
  assert.equal(summary.verdict, 'after-generation')
  assert.equal(summary.firstPlaybackBeforeGenerationEnd, false)
  assert.equal(summary.chunksPlayed, 1)
})

test('W3 reply Stop: sounding chunk cut at Stop, queued chunk never sounds, later chunks skipped, no sound after Stop', () => {
  const { output, player, finished, wall, advance } = rig()
  start(player, 's', wall())
  player.handle({ type: 'audio.chunk', streamId: 's', seq: 0, epoch: 0, startSample: 0, samples: 24000, data: pcm(24000), t: wall() })
  player.handle({ type: 'audio.chunk', streamId: 's', seq: 1, epoch: 0, startSample: 24000, samples: 24000, data: pcm(24000), t: wall() })
  advance(0.5)
  player.stop()
  assert.ok(output.scheduled.every(s => s.stopped))
  player.handle({ type: 'audio.chunk', streamId: 's', seq: 2, epoch: 0, startSample: 48000, samples: 24000, data: pcm(24000), t: wall() })
  assert.equal(output.scheduled.length, 2, 'nothing scheduled after Stop')
  advance(2)
  player.handle({ type: 'audio.end', streamId: 's', status: 'completed', delivery: 'progressive', chunks: 3, t: wall() })
  const timeline = finished[0]!
  const summary = summarizeTimeline(timeline)
  assert.equal(summary.stopKind, 'reply-stop')
  assert.equal(summary.soundAfterStop, false)
  assert.equal(summary.chunksPlayed, 1)
  assert.equal(timeline.chunks[0]!.playEndAt, 1_000_500)
  assert.equal(timeline.chunks[1]!.skipped, 'stopped')
  assert.equal(timeline.chunks[2]!.skipped, 'stopped')
  assert.equal(player.source.getSnapshot().phase, 'stopped')
})

test('W4 host-cancelled stream (turn Stop / barge-in) silences scheduled audio at once (0.3.4 kept playing it)', () => {
  const { output, player, finished, wall, advance } = rig()
  start(player, 'c', wall())
  // One long payload (like MiMo): 4 s of audio scheduled.
  player.handle({ type: 'audio.chunk', streamId: 'c', seq: 0, epoch: 0, startSample: 0, samples: 96000, data: pcm(96000), t: wall() })
  advance(1)
  player.handle({ type: 'audio.end', streamId: 'c', status: 'cancelled', delivery: 'final-only', chunks: 1, t: wall() })
  assert.equal(output.scheduled[0]!.stopped, true, 'scheduled buffer stopped on cancelled end')
  const snapshot = player.source.getSnapshot()
  assert.equal(snapshot.phase, 'stopped')
  assert.equal(finished.length, 1)
  const summary = summarizeTimeline(finished[0]!)
  assert.equal(summary.stopKind, 'cancelled')
  assert.equal(summary.soundAfterStop, false)
  assert.equal(finished[0]!.chunks[0]!.playEndAt, 1_001_000)
  // A late chunk of the cancelled stream stays silent.
  player.handle({ type: 'audio.chunk', streamId: 'c', seq: 1, epoch: 0, startSample: 96000, samples: 2400, data: pcm(2400), t: wall() })
  assert.equal(output.scheduled.length, 1)
})

test('W5 backend slower than realtime: late chunk re-anchors, the audible pause is reported as an underrun, order kept', () => {
  const { player, wall, advance } = rig()
  start(player, 'u', wall())
  player.handle({ type: 'audio.chunk', streamId: 'u', seq: 0, epoch: 0, startSample: 0, samples: 24000, data: pcm(24000), t: wall() })
  advance(1.5) // chunk 0 (0.12–1.12 s) finished; next arrives 0.38 s later than its slot
  player.handle({ type: 'audio.chunk', streamId: 'u', seq: 1, epoch: 0, startSample: 24000, samples: 24000, data: pcm(24000), t: wall() })
  player.handle({ type: 'audio.end', streamId: 'u', status: 'completed', delivery: 'progressive', chunks: 2, t: wall() })
  advance(2)
  const summary = player.source.getSnapshot().timeline!
  assert.equal(summary.chunksPlayed, 2)
  assert.equal(summary.inOrder, true)
  assert.equal(summary.underruns.length, 1)
  assert.equal(summary.underruns[0]!.gapMs, 500)
  assert.equal(summary.verdict, 'progressive')
})

test('W6 store keeps finished timelines per Session, finds them by recording id, survives a reload, tolerates bad storage', () => {
  const data = new Map<string, string>()
  const storage: TimelineStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } }
  const { player, finished, wall, advance } = rig()
  start(player, 'r', wall())
  player.handle({ type: 'audio.chunk', streamId: 'r', seq: 0, epoch: 0, startSample: 0, samples: 2400, data: pcm(2400), t: wall() })
  player.handle({ type: 'audio.chunk', streamId: 'r', seq: 1, epoch: 0, startSample: 2400, samples: 2400, data: pcm(2400), t: wall() })
  player.handle({ type: 'audio.end', streamId: 'r', status: 'completed', delivery: 'progressive', chunks: 2, recording: { recordingId: 'rec_r' }, t: wall() + 1000 })
  advance(1)
  const store = new PlaybackTimelineStore(storage)
  let notified = 0
  store.source.subscribe(() => { notified++ })
  store.add('sess-1', finished[0]!)
  assert.equal(notified, 1)
  const reloaded = new PlaybackTimelineStore(storage)
  assert.equal(reloaded.list('sess-1').length, 1)
  assert.equal(reloaded.list('other').length, 0)
  assert.equal(reloaded.byRecording('rec_r')?.summary.verdict, 'progressive')
  data.set('dsh-voice-capture:playback-timelines', '{not json')
  assert.equal(new PlaybackTimelineStore(storage).list().length, 0)
  const throwing = new PlaybackTimelineStore({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
  throwing.add('s', finished[0]!)
  assert.equal(throwing.list().length, 1)
})

test('W7 autoplay off: chunks received but none played → no-playback; a suspended output marks nothing as audible', () => {
  const { output, player, wall, advance } = rig()
  player.setAutoplay(false)
  start(player, 'a', wall())
  player.handle({ type: 'audio.chunk', streamId: 'a', seq: 0, epoch: 0, startSample: 0, samples: 2400, data: pcm(2400), t: wall() })
  player.handle({ type: 'audio.end', streamId: 'a', status: 'completed', delivery: 'final-only', chunks: 1, t: wall() })
  assert.equal(player.source.getSnapshot().timeline!.verdict, 'no-playback')
  assert.equal(player.source.getSnapshot().timeline!.chunksReceived, 1)

  player.setAutoplay(true)
  start(player, 'b', wall())
  output.running = false
  player.handle({ type: 'audio.chunk', streamId: 'b', seq: 0, epoch: 0, startSample: 0, samples: 2400, data: pcm(2400), t: wall() })
  advance(1)
  assert.equal(player.source.getSnapshot().timeline!.chunksPlayed, 0, 'suspended output is not playback')
  output.running = true
  advance(0.01)
  assert.equal(player.source.getSnapshot().timeline!.chunksPlayed, 1)
})

// ---- §K.15 playback reports (R-MIC-PLAYBACK) ----
import { PlaybackReporter } from '../src/client/audio/playback-report.ts'
import type { PlaybackReportEvent } from '../src/client/audio/playback-report.ts'

function reportRig() {
  const output = new ClockOutput()
  const events: { streamId: string; event: PlaybackReportEvent }[] = []
  const closed: string[] = []
  const player = new ProgressivePlayer(() => output, () => output.currentTime * 1000, {
    wallNow: () => 1_000_000 + Math.round(output.currentTime * 1000),
    timeOrigin: 1_000_000,
    startSampling: () => () => {},
    onReport: (streamId, event) => { events.push({ streamId, event }) },
    onReportEnd: (streamId) => { closed.push(streamId) },
  })
  const advance = (seconds: number, step = 0.025) => {
    const target = output.currentTime + seconds
    while (output.currentTime + 1e-9 < target) {
      output.currentTime = Math.min(target, output.currentTime + step)
      player.sample()
    }
  }
  return { output, player, events, closed, advance }
}

test('X1 progressive stream: scheduled for every seq, started, output-clock positions every ~200 ms before audio.end, ended', () => {
  const { player, events, closed, advance } = reportRig()
  player.handle({ type: 'audio.start', streamId: 'x', origin: 'chat', t: 1_000_000 })
  player.handle({ type: 'audio.format', streamId: 'x', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  for (let seq = 0; seq < 4; seq++) {
    player.handle({ type: 'audio.chunk', streamId: 'x', seq, epoch: 0, startSample: seq * 12000, samples: 12000, data: pcm(12000), t: 1_000_000 })
    advance(0.4) // 0.5 s of audio every 0.4 s
  }
  const endAt = 1_000_000 + 1600
  player.handle({ type: 'audio.end', streamId: 'x', status: 'completed', delivery: 'progressive', chunks: 4, t: endAt })
  advance(1.5)
  const list = events.map(e => e.event)
  const scheduled = list.filter(e => e.type === 'scheduled')
  assert.deepEqual(scheduled.map(e => e.type === 'scheduled' && [e.seq, e.startSample, e.samples]), [[0, 0, 12000], [1, 12000, 12000], [2, 24000, 12000], [3, 36000, 12000]])
  const first = scheduled[0]!
  assert.equal(first.type === 'scheduled' && first.whenAt, 1_000_120, 'whenAt = epoch of the scheduled output time')
  assert.deepEqual(list.find(e => e.type === 'started'), { type: 'started', at: 1_000_120 })
  const positions = list.filter((e): e is Extract<PlaybackReportEvent, { type: 'position' }> => e.type === 'position')
  const beforeEnd = positions.filter(p => p.at < endAt && p.playedSamples > 0)
  assert.ok(beforeEnd.length >= 5, `positions before audio.end: ${beforeEnd.length}`)
  assert.ok(positions.every((p, i) => i === 0 || (p.playedSamples >= positions[i - 1]!.playedSamples && p.at > positions[i - 1]!.at)), 'monotonic')
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i]!.at - positions[i - 1]!.at >= 200 || i === positions.length - 1, 'period ≥ 200 ms except the final position')
  // Played samples follow the output clock, never the receipt: (position time − audible start) × 24 kHz, capped at the audio.
  for (const p of positions) assert.equal(p.playedSamples, Math.min(48000, Math.round((p.at - 1_000_120) * 24)), `position at ${p.at}`)
  assert.ok(positions.every(p => p.playedSamples <= 48000))
  const ended = list.at(-1)!
  assert.deepEqual(ended, { type: 'ended', at: ended.at, playedSamples: 48000 })
  assert.deepEqual(closed, ['x'])
  assert.equal(player.source.getSnapshot().playedBeforeEnd, true, 'audible before the end → streaming label allowed')
})

test('X2 Stop posts stopped with the played samples and no later position; scheduling alone is not "played before end"', () => {
  const { player, events, closed, advance } = reportRig()
  player.handle({ type: 'audio.start', streamId: 'y', origin: 'chat' })
  player.handle({ type: 'audio.format', streamId: 'y', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 'y', seq: 0, epoch: 0, startSample: 0, samples: 48000, data: pcm(48000) })
  player.handle({ type: 'audio.chunk', streamId: 'y', seq: 1, epoch: 0, startSample: 48000, samples: 48000, data: pcm(48000) })
  advance(0.62)
  player.stop()
  const stopped = events.map(e => e.event).find(e => e.type === 'stopped')
  assert.deepEqual(stopped, { type: 'stopped', at: 1_000_620, playedSamples: 12000, reason: 'user' })
  const count = events.length
  advance(2)
  player.handle({ type: 'audio.chunk', streamId: 'y', seq: 2, epoch: 0, startSample: 96000, samples: 2400, data: pcm(2400) })
  player.handle({ type: 'audio.end', streamId: 'y', status: 'cancelled', delivery: 'progressive', chunks: 3 })
  assert.equal(events.length, count, 'nothing reported after stopped')
  assert.deepEqual(closed, ['y'])

  // A chunk scheduled but ended before it ever sounded does not count as played before the end.
  const second = reportRig()
  second.player.handle({ type: 'audio.start', streamId: 'z', origin: 'chat' })
  second.player.handle({ type: 'audio.format', streamId: 'z', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  second.player.handle({ type: 'audio.chunk', streamId: 'z', seq: 0, epoch: 0, startSample: 0, samples: 2400, data: pcm(2400) })
  second.player.handle({ type: 'audio.chunk', streamId: 'z', seq: 1, epoch: 0, startSample: 2400, samples: 2400, data: pcm(2400) })
  second.player.handle({ type: 'audio.end', streamId: 'z', status: 'completed', delivery: 'progressive', chunks: 2, t: 1_000_050 })
  assert.equal(second.player.source.getSnapshot().playedBeforeEnd, false)
})

test('X3 reporter: first part ~1 s after the first played position, final part on close, v1 body, 404 never retried, 400 dropped', async () => {
  const posts: { status: number; body: Record<string, unknown> }[] = []
  let status = 200
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    posts.push({ status, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return new Response(JSON.stringify(status === 200 ? { ok: true, recorded: true, part: posts.length } : { ok: false, error: { code: status === 404 ? 'STREAM_UNKNOWN' : 'BAD_REQUEST' } }), { status })
  }
  const timers: { callback: () => void; ms: number }[] = []
  const reporter = new PlaybackReporter(fetchImpl, 'sess', () => ({ plugin: 'dsh-voice-capture@0.3.5', contextSampleRate: 48000, baseLatencyMs: 5, outputLatencyMs: 12, clockSource: 'AudioContext.getOutputTimestamp' }),
    { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length as never }, clearTimeout: () => {} }, () => 42)
  reporter.event('s1', { type: 'scheduled', at: 1, seq: 0, startSample: 0, samples: 10, whenAt: 2 })
  reporter.event('s1', { type: 'position', at: 3, playedSamples: 0 })
  assert.equal(timers.length, 0, 'no part before audio actually played')
  reporter.event('s1', { type: 'position', at: 4, playedSamples: 5 })
  assert.equal(timers[0]!.ms, 1000)
  timers[0]!.callback()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0]!.body, {
    v: 1, sessionId: 'sess', streamId: 's1',
    client: { plugin: 'dsh-voice-capture@0.3.5', contextSampleRate: 48000, baseLatencyMs: 5, outputLatencyMs: 12, clockSource: 'AudioContext.getOutputTimestamp', sentAt: 42 },
    events: [{ type: 'scheduled', at: 1, seq: 0, startSample: 0, samples: 10, whenAt: 2 }, { type: 'position', at: 3, playedSamples: 0 }, { type: 'position', at: 4, playedSamples: 5 }],
  })
  reporter.event('s1', { type: 'ended', at: 9, playedSamples: 10 })
  await reporter.close('s1')
  assert.equal(posts.length, 2)
  assert.deepEqual((posts[1]!.body.events as unknown[]).length, 1)
  assert.deepEqual(reporter.state()[0], { streamId: 's1', parts: 2, eventsPosted: 4, pending: 0, closed: true, unknown: false, lastError: undefined })

  status = 404
  reporter.event('s2', { type: 'position', at: 5, playedSamples: 7 })
  reporter.event('s2', { type: 'stopped', at: 6, playedSamples: 7, reason: 'user' })
  await reporter.close('s2')
  const after404 = posts.length
  reporter.event('s2', { type: 'position', at: 7, playedSamples: 8 })
  await reporter.close('s2')
  assert.equal(posts.length, after404, 'a 404 stream is never posted again')
  assert.equal(reporter.state().find(s => s.streamId === 's2')?.unknown, true)
  assert.match(reporter.state().find(s => s.streamId === 's2')!.lastError!, /404 STREAM_UNKNOWN/)

  status = 400
  reporter.event('s3', { type: 'position', at: 8, playedSamples: 1 })
  await reporter.close('s3')
  assert.equal(reporter.state().find(s => s.streamId === 's3')?.pending, 0, 'a refused part is dropped, not resent')
})

test('X4 underrun is reported when a late chunk re-anchors; positions continue from the new anchor without going back', () => {
  const { player, events, advance } = reportRig()
  player.handle({ type: 'audio.start', streamId: 'u', origin: 'chat' })
  player.handle({ type: 'audio.format', streamId: 'u', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 'u', seq: 0, epoch: 0, startSample: 0, samples: 12000, data: pcm(12000) })
  advance(1)
  player.handle({ type: 'audio.chunk', streamId: 'u', seq: 1, epoch: 0, startSample: 12000, samples: 12000, data: pcm(12000) })
  advance(1)
  const list = events.map(e => e.event)
  const underrun = list.find(e => e.type === 'underrun')
  assert.deepEqual(underrun, { type: 'underrun', at: 1_001_000, seq: 1 })
  const positions = list.filter((e): e is Extract<PlaybackReportEvent, { type: 'position' }> => e.type === 'position')
  assert.ok(positions.every((p, i) => i === 0 || p.playedSamples >= positions[i - 1]!.playedSamples))
  assert.equal(positions.at(-1)!.playedSamples, 24000)
})

test('X5 a new output whose clock is not valid yet: the scheduled report waits and its whenAt matches the audible start (Desktop finding 11:53)', () => {
  // Output timestamp unavailable until the context runs (performanceTime 0), as right after `new AudioContext()`.
  const output = new ClockOutput()
  output.running = false
  const stamp = { contextTime: 0, performanceTime: 0 }
  const out = Object.assign(output, { outputTimestamp: () => stamp })
  const events: PlaybackReportEvent[] = []
  let perf = 5_000
  const player = new ProgressivePlayer(() => out, () => perf, { timeOrigin: 1_000_000, wallNow: () => 1_000_000 + perf, startSampling: () => () => {}, onReport: (_id, event) => { events.push(event) } })
  player.handle({ type: 'audio.start', streamId: 'v', origin: 'chat' })
  player.handle({ type: 'audio.format', streamId: 'v', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 'v', seq: 0, epoch: 0, startSample: 0, samples: 7200, data: pcm(7200) })
  player.sample()
  assert.equal(events.filter(e => e.type === 'scheduled').length, 0, 'no scheduled report while the clock is not valid')
  // The context starts 95 ms later: output time 0 is audible at perf 5095.
  perf = 5_095
  output.running = true
  stamp.contextTime = 0
  stamp.performanceTime = 5_095
  player.sample()
  const scheduled = events.find(e => e.type === 'scheduled')
  assert.deepEqual(scheduled, { type: 'scheduled', at: 1_005_095, seq: 0, startSample: 0, samples: 7200, whenAt: 1_005_215 })
  player.handle({ type: 'audio.chunk', streamId: 'v', seq: 1, epoch: 0, startSample: 7200, samples: 7200, data: pcm(7200) })
  const second = events.filter(e => e.type === 'scheduled')[1]
  assert.equal(second?.type === 'scheduled' && second.whenAt, 1_005_515, 'contiguous: no gap between the reported chunks')
})

test('X6 reports only for the configured origins: a Live stream plays and keeps its timeline but posts no report', () => {
  const output = new ClockOutput()
  const events: PlaybackReportEvent[] = []
  const closed: string[] = []
  const player = new ProgressivePlayer(() => output, () => output.currentTime * 1000, {
    timeOrigin: 1_000_000, wallNow: () => 1_000_000 + Math.round(output.currentTime * 1000), startSampling: () => () => {},
    onReport: (_id, event) => { events.push(event) }, onReportEnd: (id) => { closed.push(id) }, reportOrigins: new Set(['chat']),
  })
  player.handle({ type: 'audio.start', streamId: 'live-1', origin: 'live' })
  player.handle({ type: 'audio.format', streamId: 'live-1', encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  player.handle({ type: 'audio.chunk', streamId: 'live-1', seq: 0, epoch: 0, startSample: 0, samples: 2400, data: pcm(2400) })
  player.handle({ type: 'audio.chunk', streamId: 'live-1', seq: 1, epoch: 0, startSample: 2400, samples: 2400, data: pcm(2400) })
  output.currentTime = 0.2
  player.sample()
  player.handle({ type: 'audio.end', streamId: 'live-1', status: 'cancelled', delivery: 'progressive', chunks: 2 })
  assert.deepEqual(events, [])
  assert.deepEqual(closed, [])
  assert.equal(output.scheduled.every(s => s.stopped), true, 'cancelled Live response still silenced')
  assert.equal(player.source.getSnapshot().timeline?.chunksPlayed, 1)
})
