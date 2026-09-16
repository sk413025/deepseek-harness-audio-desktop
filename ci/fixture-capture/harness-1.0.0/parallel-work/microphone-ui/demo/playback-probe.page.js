// dsh-voice-capture playback probe (page side). Passive, read-only instrumentation for real Desktop acceptance.
//
// Measures ACTUAL playback on the Web Audio output clock, not chunk arrival:
// - every AudioBufferSourceNode.start/stop call: pass-through wrappers that only record;
// - per buffer: actual start and end, from AudioContext.getOutputTimestamp() (the output clock including output
//   latency), polled every 20 ms;
// - optionally, a separate read-only subscription to the host audio feed `GET /api/dsh-dgx-audio/v1/events?sessionId=`,
//   recording the arrival time and host `t` of audio.start/format/chunk/end (chunk data is not kept).
//
// All times are wall-clock ms on this Mac (the host's `t` uses Date.now() on the same machine), so
// "first actual playback before generation end" can be compared exactly with the host `audio.end.t`.
// It changes nothing the page does and sends no model request. A page reload removes it; install again after a reload.
(() => {
  const VERSION = 'dsh-playback-probe@1'
  if (globalThis.__dshPlaybackProbe?.version === VERSION) return globalThis.__dshPlaybackProbe.status()
  const wallOfPerf = (perf) => Date.now() - performance.now() + perf
  const contexts = new Map() // BaseAudioContext -> { id, ... }
  const buffers = []
  const feed = []
  const feeds = new Map() // sessionId -> AbortController
  const installedAt = Date.now()

  const contextInfo = (context) => {
    let info = contexts.get(context)
    if (info === undefined) {
      info = { id: contexts.size + 1, context }
      contexts.set(context, info)
    }
    return info
  }
  const outputNow = (context) => {
    // Output clock: which context time is audible at which performance time.
    if (typeof context.getOutputTimestamp === 'function') {
      const ts = context.getOutputTimestamp()
      if (ts && ts.performanceTime > 0) return { contextTime: ts.contextTime, perf: ts.performanceTime, source: 'outputTimestamp' }
    }
    return { contextTime: context.currentTime - (context.outputLatency || 0), perf: performance.now(), source: 'currentTime-outputLatency' }
  }

  const proto = globalThis.AudioBufferSourceNode?.prototype
  const scheduled = globalThis.AudioScheduledSourceNode?.prototype
  if (proto === undefined || scheduled === undefined) throw new Error('Web Audio is not available in this page')
  const originalStart = proto.start
  const originalStop = scheduled.stop
  proto.start = function start(when = 0, offset, duration) {
    const context = this.context
    const info = contextInfo(context)
    const record = {
      i: buffers.length,
      context: info.id,
      calledAt: Date.now(),
      contextTimeAtCall: context.currentTime,
      contextState: context.state,
      when: Math.max(Number(when) || 0, context.currentTime),
      duration: this.buffer ? this.buffer.duration : null,
      sampleRate: this.buffer ? this.buffer.sampleRate : null,
      channels: this.buffer ? this.buffer.numberOfChannels : null,
      frames: this.buffer ? this.buffer.length : null,
      startedAt: null,
      clockSource: null,
      stopCalledAt: null,
      stoppedBeforeStart: false,
      endedEventAt: null,
      endedAt: null,
    }
    buffers.push(record)
    this.__dshProbeRecord = record
    this.addEventListener('ended', () => { record.endedEventAt = Date.now() })
    return originalStart.apply(this, arguments)
  }
  scheduled.stop = function stop() {
    const record = this.__dshProbeRecord
    if (record !== undefined && record.stopCalledAt === null) {
      record.stopCalledAt = Date.now()
      poll()
      if (record.startedAt === null) record.stoppedBeforeStart = true
    }
    return originalStop.apply(this, arguments)
  }

  function poll() {
    for (const record of buffers) {
      if (record.endedAt !== null || record.stoppedBeforeStart) continue
      const info = [...contexts.values()].find(c => c.id === record.context)
      if (info === undefined) continue
      const out = outputNow(info.context)
      if (record.startedAt === null && out.contextTime >= record.when && info.context.state === 'running') {
        record.startedAt = Math.round(wallOfPerf(out.perf - (out.contextTime - record.when) * 1000))
        record.clockSource = out.source
      }
      if (record.startedAt !== null && record.endedAt === null) {
        const naturalEnd = record.when + (record.duration ?? 0)
        if (record.stopCalledAt !== null) record.endedAt = Math.max(record.startedAt, Math.min(record.stopCalledAt, Math.round(wallOfPerf(out.perf - (out.contextTime - naturalEnd) * 1000))))
        else if (out.contextTime >= naturalEnd) record.endedAt = Math.round(wallOfPerf(out.perf - (out.contextTime - naturalEnd) * 1000))
      }
    }
  }
  const timer = setInterval(poll, 20)

  function tapFeed(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '' || feeds.has(sessionId)) return false
    const abort = new AbortController()
    feeds.set(sessionId, abort)
    void (async () => {
      let after
      while (!abort.signal.aborted) {
        try {
          const query = new URLSearchParams({ sessionId })
          if (after !== undefined) query.set('after', after)
          const response = await fetch(new URL(`/api/dsh-dgx-audio/v1/events?${query}`, location.href), { credentials: 'include', signal: abort.signal, headers: { accept: 'application/x-ndjson' } })
          if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let text = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
            let newline
            while ((newline = text.indexOf('\n')) >= 0) {
              const line = text.slice(0, newline).trim()
              text = text.slice(newline + 1)
              if (line === '') continue
              let event
              try { event = JSON.parse(line) } catch { continue }
              if (typeof event.cursor === 'string') after = event.cursor
              if (typeof event.type !== 'string' || !event.type.startsWith('audio.')) continue
              const { data, ...meta } = event
              feed.push({ sessionId, arrivedAt: Date.now(), ...meta, ...(typeof data === 'string' ? { dataBase64Chars: data.length } : {}) })
            }
          }
        } catch (error) {
          if (abort.signal.aborted) break
          feed.push({ sessionId, arrivedAt: Date.now(), type: 'probe.feed-retry', detail: String(error?.message ?? error) })
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    })()
    return true
  }

  function summarize() {
    const streams = []
    const starts = feed.filter(e => e.type === 'audio.start')
    for (const start of starts) {
      // Events of this stream occurrence: same Session and stream id, from this start up to the next start of that id.
      const again = starts.find(s => s !== start && s.sessionId === start.sessionId && s.streamId === start.streamId && s.arrivedAt > start.arrivedAt)
      const events = feed.filter(e => e.streamId === start.streamId && e.sessionId === start.sessionId && e.arrivedAt >= start.arrivedAt && (again === undefined || e.arrivedAt < again.arrivedAt))
      const end = events.find(e => e.type === 'audio.end')
      const chunks = events.filter(e => e.type === 'audio.chunk')
      // Buffers are page-wide: attribute those scheduled from this start until the next stream starts (any Session).
      const next = starts.find(s => s.arrivedAt > start.arrivedAt)
      const windowEnd = next?.arrivedAt ?? Infinity
      const own = buffers.filter(b => b.calledAt >= start.arrivedAt && b.calledAt < windowEnd)
      const overlapsOtherStream = starts.some(s => s !== start && s.arrivedAt >= start.arrivedAt && end !== undefined && s.arrivedAt <= end.arrivedAt)
      const started = own.filter(b => b.startedAt !== null).sort((a, b) => a.startedAt - b.startedAt)
      const generationEnd = end?.t ?? null
      const firstStop = own.map(b => b.stopCalledAt).filter(v => v !== null).sort((a, b) => a - b)[0] ?? null
      const underruns = []
      for (let k = 1; k < started.length; k++) {
        const prevEnd = started[k - 1].endedAt ?? (started[k - 1].startedAt + (started[k - 1].duration ?? 0) * 1000)
        const gap = started[k].startedAt - prevEnd
        if (gap > 20) underruns.push({ afterBuffer: started[k - 1].i, gapMs: Math.round(gap) })
      }
      const callOrder = own.map(b => b.i)
      const startOrder = started.map(b => b.i)
      const firstActual = started[0]?.startedAt ?? null
      streams.push({
        sessionId: start.sessionId,
        streamId: start.streamId,
        task: start.task ?? null,
        origin: start.origin ?? null,
        hostStartT: start.t ?? null,
        hostFirstChunkT: chunks[0]?.t ?? null,
        hostLastChunkT: chunks.at(-1)?.t ?? null,
        hostEndT: generationEnd,
        endStatus: end?.status ?? null,
        hostDelivery: end?.delivery ?? null,
        overlapsOtherStream,
        chunksReceived: chunks.length,
        sampleRates: [...new Set(events.filter(e => e.type === 'audio.format').map(e => e.sampleRate))],
        chunkArrivals: chunks.map(c => ({ seq: c.seq, startSample: c.startSample, samples: c.samples, hostT: c.t, arrivedAt: c.arrivedAt })),
        buffersScheduled: own.length,
        buffersPlayed: started.length,
        bufferSampleRates: [...new Set(own.map(b => b.sampleRate))],
        firstActualPlaybackAt: firstActual,
        firstActualPlaybackBeforeGenerationEnd: firstActual !== null && generationEnd !== null ? firstActual < generationEnd : null,
        leadOfFirstPlaybackOverGenerationEndMs: firstActual !== null && generationEnd !== null ? generationEnd - firstActual : null,
        buffersStartedBeforeGenerationEnd: generationEnd === null ? null : started.filter(b => b.startedAt < generationEnd).length,
        playedInCallOrder: JSON.stringify(startOrder) === JSON.stringify(callOrder.filter(i => startOrder.includes(i))),
        whenNonDecreasing: own.every((b, k) => k === 0 || b.when >= own[k - 1].when - 1e-6),
        underruns,
        lastActualSoundAt: started.length === 0 ? null : Math.max(...started.map(b => b.endedAt ?? b.startedAt)),
        firstStopCalledAt: firstStop,
        buffersStoppedBeforeStart: own.filter(b => b.stoppedBeforeStart).length,
        soundStartedAfterStop: firstStop === null ? null : started.some(b => b.startedAt > firstStop + 30),
        playedSeconds: Math.round(started.reduce((sum, b) => sum + Math.max(0, ((b.endedAt ?? b.startedAt) - b.startedAt) / 1000), 0) * 1000) / 1000,
      })
    }
    return streams
  }

  function status() {
    return { version: VERSION, installedAt, contexts: contexts.size, buffers: buffers.length, feedEvents: feed.length, tappedSessions: [...feeds.keys()] }
  }

  globalThis.__dshPlaybackProbe = {
    version: VERSION,
    status,
    tapFeed,
    read: () => {
      poll()
      return {
        version: VERSION,
        installedAt,
        readAt: Date.now(),
        location: location.href,
        contexts: [...contexts.values()].map(c => ({ id: c.id, state: c.context.state, sampleRate: c.context.sampleRate, baseLatency: c.context.baseLatency ?? null, outputLatency: c.context.outputLatency ?? null })),
        buffers: buffers.map(b => ({ ...b })),
        feed: feed.map(e => ({ ...e })),
        streams: summarize(),
      }
    },
    uninstall: () => {
      clearInterval(timer)
      proto.start = originalStart
      scheduled.stop = originalStop
      for (const abort of feeds.values()) abort.abort()
      delete globalThis.__dshPlaybackProbe
      return true
    },
  }
  return status()
})()
