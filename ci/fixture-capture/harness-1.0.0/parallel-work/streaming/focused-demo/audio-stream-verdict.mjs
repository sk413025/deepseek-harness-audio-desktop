#!/usr/bin/env node
// Desktop streamed-speech verdict (TASK_CONTRACT §K.15) from one Harness home's invocations.jsonl (host ≥ 0.4.9):
// the host `invocation.stream` evidence (per-chunk WAV arrival times, samples, rate) + the UI's `record: "playback"`
// reports (actual output-clock positions). Backend chunk counts, SSE or a playable final WAV alone never pass.
//
// usage: node audio-stream-verdict.mjs --invocations <invocations.jsonl> (--stream <streamId> | --session <id> [--model <id>])
//        [--min-lead-ms 250] [--out verdict.json]
// exit 0 = desktopStreamingPass, 1 = FAIL, 2 = input error. Speech quality is reported separately and never passes/fails it.
import { readFile, writeFile } from 'node:fs/promises'

export function verdict(lines, { streamId, sessionId, model, minLeadMs = 250 } = {}) {
  const invocations = lines.filter(l => l.record === 'invocation' && l.stream?.audio?.streamId)
  const inv = streamId !== undefined
    ? invocations.find(l => l.stream.audio.streamId === streamId)
    : invocations.filter(l => (sessionId === undefined || l.sessionId === sessionId) && (model === undefined || l.model === model)).at(-1)
  if (inv === undefined) return { error: 'no invocation with host stream evidence (host ≥ 0.4.9) matches' }
  const s = inv.stream
  const a = s.audio
  const id = a.streamId
  const reports = lines.filter(l => l.record === 'playback' && l.streamId === id)
  const events = reports.flatMap(r => r.events).sort((x, y) => x.at - y.at)
  const arrivals = a.arrivals ?? []
  const rate = a.format?.sampleRate ?? arrivals[0]?.sampleRate ?? 0
  const terminalAt = a.terminalAt
  const stopped = events.find(e => e.type === 'stopped')

  // Transport: what the Desktop host received.
  const t = {}
  t.completedOrStopped = a.status === 'completed' || (stopped !== undefined && a.status === 'cancelled')
  t.atLeastTwoChunks = a.chunks >= 2
  t.orderedContiguous = arrivals.every((x, i) => x.seq === i && x.startSample === (i === 0 ? 0 : arrivals[i - 1].startSample + arrivals[i - 1].samples))
  t.singleSampleRate = new Set(arrivals.map(x => `${x.sampleRate}/${x.channels}`)).size === 1
  t.progressiveArrival = a.firstChunkAt !== null && terminalAt - a.firstChunkAt > minLeadMs
  t.noDecodeErrors = !(Array.isArray(inv.audioErrors) && inv.audioErrors.length > 0)
  const transportPass = Object.values(t).every(Boolean)

  // Playback: what the UI actually played, on its output clock.
  const p = {}
  const positions = events.filter(e => e.type === 'position' && e.playedSamples > 0)
  const firstPlayed = positions[0]
  const received = (at) => arrivals.filter(x => x.t <= at).reduce((n, x) => n + x.samples, 0)
  p.reportPresent = reports.length > 0
  p.firstPlaybackBeforeCompletion = firstPlayed !== undefined && firstPlayed.at < terminalAt
  p.laterChunkPlayedAfterItArrived = firstPlayed !== undefined && arrivals.slice(1).some(x => x.t > firstPlayed.at && positions.some(q => q.at >= x.t && q.playedSamples > x.startSample))
  p.neverAheadOfReceivedAudio = arrivals.length > 0 && !a.arrivalsTruncated && positions.every(q => q.playedSamples <= received(q.at + 100))
  const cutoff = stopped?.at ?? Infinity
  const before = positions.filter(q => q.at <= cutoff)
  p.positionsMonotonic = before.every((q, i) => i === 0 || q.playedSamples >= before[i - 1].playedSamples)
  const scheduled = events.filter(e => e.type === 'scheduled').sort((x, y) => x.seq - y.seq)
  let overlaps = 0
  let gaps = 0
  for (let i = 1; i < scheduled.length; i++) {
    const prev = scheduled[i - 1]
    const prevEnd = prev.whenAt + (prev.samples / rate) * 1000
    if (scheduled[i].whenAt < prevEnd - 5) overlaps += 1
    else if (scheduled[i].whenAt > prevEnd + 20) gaps += 1
  }
  const expectedSeqs = arrivals.filter(x => x.t <= cutoff).map(x => x.seq)
  p.everyReceivedChunkScheduledInOrder = scheduled.length > 0 && expectedSeqs.every(seq => scheduled.some(e => e.seq === seq && e.startSample === arrivals[seq].startSample))
  p.noOverlaps = overlaps === 0
  const playbackPass = Object.values(p).every(Boolean)

  let stop = null
  if (stopped !== undefined) {
    const after = positions.filter(q => q.at > stopped.at + 50)
    stop = {
      at: stopped.at,
      playedSamples: stopped.playedSamples,
      localPlaybackHalted: after.every(q => q.playedSamples <= stopped.playedSamples + Math.round(rate * 0.05)),
      request: inv.ok === false && inv.code === 'ABORTED' ? 'cancelled' : inv.ok === true ? 'drained-to-completion' : `failed:${inv.code}`,
      hostStreamStatus: a.status,
    }
  }

  const q = a.quality ?? {}
  const flags = []
  if ((q.clippedRatio ?? 0) > 0.001) flags.push(`clipping ${(q.clippedRatio * 100).toFixed(2)}% of samples at full scale`)
  if ((q.boundaryJumpsOver8000 ?? 0) > 0) flags.push(`${q.boundaryJumpsOver8000} chunk boundary jump(s) > 8000 (possible clicks)`)
  if (gaps > 0 || events.some(e => e.type === 'underrun')) flags.push(`${gaps} scheduling gap(s) / ${events.filter(e => e.type === 'underrun').length} underrun(s)`)

  return {
    streamId: id,
    sessionId: inv.sessionId,
    model: inv.model,
    desktopStreamingPass: transportPass && playbackPass && (stop === null || stop.localPlaybackHalted),
    transport: {
      pass: transportPass, checks: t, status: a.status, chunks: a.chunks, sampleRate: rate, totalSamples: a.totalSamples,
      requestSentAt: s.requestSentAt, firstChunkAt: a.firstChunkAt, lastChunkAt: a.lastChunkAt, terminalAt,
      firstChunkAfterRequestMs: s.requestSentAt === null || a.firstChunkAt === null ? null : a.firstChunkAt - s.requestSentAt,
      arrivalGapsMs: arrivals.slice(1).map((x, i) => x.t - arrivals[i].t),
    },
    playback: {
      pass: playbackPass, checks: p, reports: reports.length,
      firstPlayedAt: firstPlayed?.at ?? null,
      firstPlayedBeforeCompletionMs: firstPlayed === undefined ? null : terminalAt - firstPlayed.at,
      firstPlayedAfterFirstChunkMs: firstPlayed === undefined || a.firstChunkAt === null ? null : firstPlayed.at - a.firstChunkAt,
      maxPlayedSamples: positions.reduce((m, x) => Math.max(m, x.playedSamples), 0),
      scheduledChunks: scheduled.length, overlaps, gaps,
    },
    stop,
    text: { delivery: s.text.delivery, deltas: s.text.deltas, streaming: s.text.delivery === 'progressive' },
    quality: { clippedSamples: q.clippedSamples ?? null, clippedRatio: q.clippedRatio ?? null, peak: q.peak ?? null, maxBoundaryJump: q.maxBoundaryJump ?? null, flags, intelligibility: 'human listening required (recording in outputAudio / partialRecording)' },
  }
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1] }
  const file = arg('invocations')
  if (file === undefined) { console.error('usage: --invocations <file> (--stream <id> | --session <id> [--model <id>]) [--min-lead-ms 250] [--out <file>]'); return 2 }
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  const result = verdict(lines, { streamId: arg('stream'), sessionId: arg('session'), model: arg('model'), minLeadMs: Number(arg('min-lead-ms') ?? 250) })
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (arg('out')) await writeFile(arg('out'), text)
  process.stdout.write(text)
  if (result.error) return 2
  return result.desktopStreamingPass ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2))
