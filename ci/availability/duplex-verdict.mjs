// Full-duplex desktop verdicts from one recorded timeline (AUDIO_TEST_LAYERING_20260915.md, "Full-duplex fixture
// sequence clarification"). Four verdicts are kept apart and never merged into one PASS:
//   outputPresence  — valid, non-silent, decodable output audio that was actually played (not metadata, not silence)
//   simultaneousIO  — frames of a later clip (B) were sent AND acknowledged while output audio was actively playing,
//                     and output kept progressing after the later input (no "buffer input until output ends",
//                     no single old response replayed)
//   interrupt       — an Interrupt during an active response came back cancelled with the matching response.done,
//                     and nothing of that response started playing afterwards (a no-op outcome is not a pass)
//   cleanup         — End/close succeeded, capture stopped, no append after close, no playback after close
// A transport ACK proves acceptance, not comprehension; no semantic scoring happens here.
//
// Timeline (all times epoch ms from one clock; the packaged runner converts page/mock clocks before calling):
// {
//   clips:    { A: { startAt, endAt }, B: {...}, C: {...} }                       fixture playback into capture
//   frames:   [{ clip, seq, sentAt, ackAt|null, status }]                           live/append requests
//   chunks:   [{ responseId, receivedAt, bytes, decodable, rms }]                   output audio received by the page
//   playback: [{ responseId, startAt, endAt }]                                      output sources actually started
//   controls: [{ kind: 'interrupt'|'end', at, outcome, responseId, responseDone }]  UI controls and host results
//   close:    { at, ok, captureStoppedAt, appendsAfterClose, playbackAfterClose }
// }
export const DEFAULT_LIMITS = Object.freeze({ silenceRms: 0.005, minPlaybackMs: 100, minOverlapFrames: 3, interruptGraceMs: 300, captureStopMs: 3000 })

export function duplexVerdicts(timeline, limits = DEFAULT_LIMITS) {
  return {
    outputPresence: outputPresence(timeline, limits),
    simultaneousIO: simultaneousIO(timeline, limits),
    interrupt: interrupt(timeline, limits),
    cleanup: cleanup(timeline, limits),
  }
}

const verdict = (status, reason, facts = {}) => ({ status, reason, ...facts })

function outputPresence(t, limits) {
  const chunks = t.chunks ?? []
  if (chunks.length === 0) return verdict('fail', 'no output audio chunk received (metadata or text alone is not output)')
  const valid = chunks.filter(c => c.decodable === true && c.bytes > 0 && (c.rms ?? 0) > limits.silenceRms)
  if (valid.length === 0) return verdict('fail', 'output chunks were empty, undecodable or silent-only', { chunks: chunks.length })
  const played = (t.playback ?? []).filter(p => p.endAt - p.startAt >= limits.minPlaybackMs && valid.some(c => c.responseId === p.responseId))
  if (played.length === 0) return verdict('fail', 'valid output audio was received but never actually played', { validChunks: valid.length })
  return verdict('pass', `${valid.length} valid output chunks, ${played.length} played intervals`, { validChunks: valid.length, playedIntervals: played.length })
}

function activeAt(playback, at) { return playback.some(p => p.startAt <= at && at <= p.endAt) }

function simultaneousIO(t, limits) {
  const playback = t.playback ?? []
  const B = t.clips?.B
  if (B === undefined) return verdict('not-run', 'no clip B in this timeline')
  if (playback.length === 0) return verdict('fail', 'no output playback, so no overlap is possible')
  const bFrames = (t.frames ?? []).filter(f => f.clip === 'B')
  if (bFrames.length === 0) return verdict('fail', 'no frame of clip B was sent')
  const overlapping = bFrames.filter(f => f.ackAt !== null && f.ackAt !== undefined && activeAt(playback, f.sentAt) && activeAt(playback, f.ackAt))
  const lastPlaybackEnd = Math.max(...playback.map(p => p.endAt))
  const bufferedUntilOutputEnd = bFrames.every(f => f.ackAt === null || f.ackAt === undefined || f.ackAt >= lastPlaybackEnd)
  if (overlapping.length < limits.minOverlapFrames) {
    return verdict('fail', bufferedUntilOutputEnd ? 'clip B input was only acknowledged after output playback ended (input blocked/buffered)' : `only ${overlapping.length} clip B frames were sent and acknowledged during active playback`, { overlapping: overlapping.length, bFrames: bFrames.length })
  }
  const firstB = Math.min(...bFrames.map(f => f.sentAt))
  const responsesBeforeB = new Set((t.chunks ?? []).filter(c => c.receivedAt < firstB).map(c => c.responseId))
  const later = (t.chunks ?? []).filter(c => c.receivedAt > firstB && c.decodable && (c.rms ?? 0) > limits.silenceRms)
  const newResponseAfterB = later.some(c => !responsesBeforeB.has(c.responseId))
  const C = t.clips?.C
  const afterC = C === undefined ? undefined : (t.chunks ?? []).filter(c => c.receivedAt > C.startAt && c.decodable && (c.rms ?? 0) > limits.silenceRms)
  if (later.length === 0) return verdict('fail', 'no output progress after clip B input', { overlapping: overlapping.length })
  if (!newResponseAfterB) return verdict('fail', 'output after clip B only continued a response that started before B (old response replayed / no new progress)', { overlapping: overlapping.length })
  if (afterC !== undefined && afterC.length === 0) return verdict('fail', 'no output progress after clip C input', { overlapping: overlapping.length })
  return verdict('pass', `${overlapping.length} clip B frames sent and acknowledged during active playback; output progressed after B${afterC ? ' and C' : ''}`, { overlapping: overlapping.length, laterChunks: later.length })
}

function interrupt(t, limits) {
  const controls = (t.controls ?? []).filter(c => c.kind === 'interrupt')
  if (controls.length === 0) return verdict('not-run', 'no Interrupt was issued in this timeline')
  const control = controls[0]
  const playingAtInterrupt = activeAt(t.playback ?? [], control.at)
  if (!playingAtInterrupt) return verdict('fail', 'Interrupt was not issued during an active audible playback buffer (underrun gap or idle)')
  if (control.outcome !== 'cancelled' || control.responseDone !== 'cancelled') return verdict('fail', `Interrupt outcome ${control.outcome} / response.done ${control.responseDone} is not a cancellation`)
  const lateStart = (t.playback ?? []).filter(p => p.responseId === control.responseId && p.startAt > control.at + limits.interruptGraceMs)
  if (lateStart.length > 0) return verdict('fail', `${lateStart.length} playback sources of the interrupted response started after Interrupt`)
  return verdict('pass', 'Interrupt during active playback cancelled the matching response; nothing of it played afterwards')
}

function cleanup(t, limits) {
  const close = t.close
  if (close === undefined) return verdict('not-run', 'session was not ended in this timeline')
  if (close.ok !== true) return verdict('fail', 'End/close did not succeed')
  if (close.captureStoppedAt === null || close.captureStoppedAt === undefined || close.captureStoppedAt - close.at > limits.captureStopMs) return verdict('fail', 'capture was not stopped within the bound after End')
  if ((close.appendsAfterClose ?? 0) > 0) return verdict('fail', `${close.appendsAfterClose} appends were sent after close`)
  if ((close.playbackAfterClose ?? 0) > 0) return verdict('fail', `${close.playbackAfterClose} playback sources started after close`)
  return verdict('pass', 'End closed the session, released capture, no append or playback afterwards')
}
