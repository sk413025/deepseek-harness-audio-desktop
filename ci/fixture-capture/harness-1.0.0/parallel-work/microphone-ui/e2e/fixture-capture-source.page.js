// TEST-ONLY capture source (AUDIO_TEST_LAYERING_20260915.md item 2 fallback): injected by the E2E runner over CDP before
// the app page loads, never shipped in a plugin. It replaces only what navigator.mediaDevices.getUserMedia returns: a
// MediaStream from an AudioContext that plays fixture PCM at 1x wall-clock pace. Everything after getUserMedia is
// production code (capture.ts AudioWorklet tap → resample → 200 ms frame queue → live/append → host).
// Chromium's --use-file-for-fake-audio-capture was tried first and delivered digital silence in the packaged Electron app.
//
// Config (window.__dshFixtureCaptureConfig, set by the runner before this script):
//   { mode: 'timeline', clips: { T: base64Wav } }                      → play T from the start of each capture stream
//   { mode: 'overlap', clips: { A, B, C }, leadSec, bTimeoutMs, cDelayMs } → A at once; B as soon as a reply buffer is
//     sounding on the output clock (or at bTimeoutMs); C cDelayMs after B ends
// Streams stopped within 300 ms of creation (the plugin's permission warm-up) play nothing.
(() => {
  const config = window.__dshFixtureCaptureConfig
  if (!config) return
  const T = () => ({ epoch: Date.now(), mono: performance.now() })
  const state = { mode: config.mode, streams: [], errors: [] }
  window.__dshFixtureCapture = state
  const decodeB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer
  let context
  const buffers = {}
  async function ready() {
    if (!context) context = new AudioContext({ sampleRate: 48000 })
    if (context.state !== 'running') await context.resume()
    for (const [name, b64] of Object.entries(config.clips)) if (!buffers[name]) buffers[name] = await context.decodeAudioData(decodeB64(b64))
  }
  // Output-clock check for "a reply buffer is sounding" (mic ≥ 0.3.5 evidence global; read-only).
  const sounding = () => {
    const api = globalThis.__dshVoiceCapture
    if (!api) return null
    const now = Date.now()
    for (const entry of api.playbackTimelines().inProgress) {
      const chunk = entry.timeline.chunks.find(c => c.playStartAt !== undefined && c.playStartAt <= now && (c.playEndAt === undefined || c.playEndAt > now))
      if (chunk) return { streamId: entry.timeline.streamId, seq: chunk.seq, playStartAt: chunk.playStartAt }
    }
    return null
  }
  const epochOf = (when) => Date.now() + (when - context.currentTime) * 1000
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const record = { requested: T(), constraints: JSON.parse(JSON.stringify(constraints ?? null)), clips: [], source: 'test-only MediaStream injection (AudioContext → MediaStreamDestination)' }
    state.streams.push(record)
    await ready()
    const destination = context.createMediaStreamDestination()
    const stream = destination.stream
    const track = stream.getAudioTracks()[0]
    record.resolved = T()
    record.track = { label: track.label, settings: track.getSettings() }
    const nodes = []
    let stopped = false
    const play = (name, when) => {
      const source = context.createBufferSource()
      source.buffer = buffers[name]
      source.connect(destination)
      source.start(when)
      nodes.push(source)
      const clip = { name, scheduledStartEpoch: Math.round(epochOf(when)), durationSec: buffers[name].duration }
      record.clips.push(clip)
      source.onended = () => { clip.endedEpoch = Date.now() }
      return when + buffers[name].duration
    }
    track.addEventListener('ended', () => { stopped = true })
    const stopTrack = track.stop.bind(track)
    track.stop = () => { stopped = true; record.stopped = T(); for (const n of nodes) { try { n.stop() } catch {} } stopTrack() }
    // Do not start the fixture for a permission warm-up stream that is stopped at once.
    setTimeout(async () => {
      if (stopped) { record.warmup = true; return }
      try {
        if (config.mode === 'timeline') {
          play('T', context.currentTime + 0.02)
          return
        }
        const aEnd = play('A', context.currentTime + (config.leadSec ?? 0.3))
        await new Promise(r => setTimeout(r, Math.max(0, (aEnd - context.currentTime) * 1000)))
        const deadline = Date.now() + (config.bTimeoutMs ?? 15000)
        let hit = null
        while (!stopped && Date.now() < deadline && (hit = sounding()) === null) await new Promise(r => setTimeout(r, 25))
        if (stopped) return
        record.bTrigger = hit === null ? { reason: 'timeout', at: T() } : { reason: 'reply-sounding', at: T(), ...hit }
        const bEnd = play('B', context.currentTime + 0.01)
        await new Promise(r => setTimeout(r, Math.max(0, (bEnd - context.currentTime) * 1000) + (config.cDelayMs ?? 3000)))
        if (stopped) return
        play('C', context.currentTime + 0.01)
      } catch (error) { state.errors.push(String(error)) }
    }, 300)
    return stream
  }
})()
