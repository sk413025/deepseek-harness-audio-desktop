#!/usr/bin/env node
// Fixture-capture desktop scenario for full-duplex Live (AUDIO_TEST_LAYERING_20260915.md items 2–4).
// Capture source (options.source):
//   "inject" (default): test-only MediaStream from fixture-capture-source.page.js at getUserMedia, 1x pace;
//   "fake-device": the app was launched with --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop
//     (in the packaged Electron app this delivered digital silence on 2026-09-15; kept for engines where it works).
// Every stage after getUserMedia is production: AudioWorklet tap → resample → 200 ms frame queue → live/append → host →
// backend; replies → feed → progressive player → UI.
// This script only clicks the real controls (Live, Interrupt, End live session) and records timestamps; it never calls
// model APIs or replaces the controller. The page instrumentation is passive (wraps fetch/getUserMedia to observe).
//
// Usage: scenario-fixture-duplex.mjs <cdp-port> <app-url> <session-title-regex> <out-dir> <live-model-id> <fixture-dir> [options JSON]
//   options: { "source": "inject", "mode": "timeline" | "overlap", "timeline": <file> (default manifest roles.timeline),
//              "clips": { "A": <file>, "B": <file>, "C": <file> } (default manifest roles A/B/C),
//              "interrupt": true, "restart": true, "selectProvider": "...", "selectModel": "...", "backend": "mock" | "real" }
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach, sleep } from './cdp-lib.mjs'

const [portArg, baseUrl, titlePattern, outDir, liveModel, fixtureDir, optionsArg] = process.argv.slice(2)
const options = { backend: 'mock', capture: 'fixture', source: 'inject', mode: 'timeline', interrupt: true, restart: true, ...(optionsArg ? JSON.parse(optionsArg) : {}) }
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'))
// File names come from the fixture set's manifest roles (A/B/C/timeline/turn/silence); options may override them.
const roles = manifest.roles ?? {}
options.timeline ??= roles.timeline
options.clips ??= { A: roles.A, B: roles.B, C: roles.C }
const entryOf = name => { const e = manifest.files.find(f => f.file === name); if (!e) throw new Error(`fixture ${name} not in manifest`); if (createHash('sha256').update(readFileSync(join(fixtureDir, name))).digest('hex') !== e.sha256) throw new Error(`fixture ${name} sha256 mismatch`); return e }
const fixture = options.mode === 'timeline' ? entryOf(options.timeline) : { file: 'A/B/C overlap', durationSec: Object.values(options.clips).reduce((n, f) => n + entryOf(f).durationSec, 0), segments: Object.entries(options.clips).map(([k, f]) => ({ utterance: k, file: f, transcript: entryOf(f).transcript })) }
const clipFiles = options.mode === 'timeline' ? { T: options.timeline } : options.clips
mkdirSync(outDir, { recursive: true })
const q = selector => `document.querySelector(${JSON.stringify(selector)})`
const evidence = { schema: 'dsh-fixture-duplex@1', startedAt: new Date().toISOString(), labels: { capture: `fixture (${options.source === 'inject' ? 'test-only MediaStream injection at getUserMedia' : 'Chromium fake device file'})`, backend: options.backend, mode: options.mode },
  fixtureManifest: { schema: manifest.schema, license: manifest.license, generator: manifest.generator.tts + ' / ' + manifest.generator.voice },
  fixture: { mode: options.mode, files: Object.fromEntries(Object.entries(clipFiles).map(([k, f]) => [k, { file: f, sha256: entryOf(f).sha256, durationSec: entryOf(f).durationSec, transcript: entryOf(f).transcript }])), segments: fixture.segments ?? null }, liveModel, rows: [], marks: [] }
const row = (id, name, data, pass) => {
  const entry = { id, name, result: pass === null ? 'NOT RUN' : pass ? 'PASS' : 'FAIL', ...data }
  evidence.rows.push(entry)
  console.log(`${entry.result} ${id} ${name} ${JSON.stringify(data).slice(0, 400)}`)
}
const page = await attach(Number(portArg), url => url.startsWith('http') || url.startsWith('dsh-app:') || url === 'about:blank')
const exceptions = []
page.on((msg) => { if (msg.method === 'Runtime.exceptionThrown') exceptions.push({ at: Date.now(), text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text }) })
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
if (options.source === 'inject') {
  const config = { mode: options.mode, leadSec: 0.3, bTimeoutMs: options.bTimeoutMs ?? 15000, cDelayMs: options.cDelayMs ?? 3000, clips: Object.fromEntries(Object.entries(clipFiles).map(([k, f]) => [k, readFileSync(join(fixtureDir, f)).toString('base64')])) }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__dshFixtureCaptureConfig = ${JSON.stringify(config)};\n${readFileSync(new URL('./fixture-capture-source.page.js', import.meta.url), 'utf8')}` })
}
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const T = () => ({ epoch: Date.now(), mono: performance.now() })
    const state = { gum: [], requests: [], feed: [] }
    window.__fx = state
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const entry = { requested: T(), constraints: JSON.parse(JSON.stringify(constraints ?? null)) }
      state.gum.push(entry)
      const stream = await gum(constraints)
      entry.resolved = T()
      entry.tracks = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }))
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => { entry.ended = T() })
      return stream
    }
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('/api/dsh-dgx-audio/v1/live/')) return original(input, init)
      const u = new URL(url, location.href)
      const entry = { route: u.pathname.split('/v1/')[1], liveId: u.searchParams.get('liveId'), seq: u.searchParams.has('seq') ? Number(u.searchParams.get('seq')) : undefined, send: T() }
      if (typeof init?.body === 'string') { try { const b = JSON.parse(init.body); entry.type = b.type; entry.responseId = b.responseId; entry.playedMs = b.playedMs } catch {} }
      else if (init?.body && typeof init.body.byteLength === 'number') entry.bytes = init.body.byteLength
      state.requests.push(entry)
      try {
        const response = await original(input, init)
        entry.done = T()
        entry.status = response.status
        if (entry.route !== 'live/append') { try { entry.reply = JSON.parse(await response.clone().text()) } catch {} }
        return response
      } catch (error) { entry.done = T(); entry.status = 'error'; throw error }
    }
    window.__fxTapFeed = (sessionId) => {
      if (state.tapping) return
      state.tapping = true
      void (async () => {
        const response = await original(new URL('/api/dsh-dgx-audio/v1/events?sessionId=' + encodeURIComponent(sessionId), location.href), { credentials: 'include', headers: { accept: 'application/x-ndjson' } })
        const reader = response.body.getReader(); const dec = new TextDecoder(); let text = ''
        for (;;) {
          const { value, done } = await reader.read(); if (done) break
          text += dec.decode(value, { stream: true })
          let n
          while ((n = text.indexOf('\\n')) >= 0) {
            const line = text.slice(0, n).trim(); text = text.slice(n + 1); if (!line) continue
            let e; try { e = JSON.parse(line) } catch { continue }
            if (typeof e.type !== 'string' || !(e.type.startsWith('audio.') || e.type.startsWith('live.'))) continue
            const { data, delta, ...meta } = e
            if (e.type === 'audio.chunk' && typeof data === 'string') {
              // Decodability and content of every reply chunk (PCM s16le): sample count and RMS.
              try { const b = atob(data); let s = 0; const n = Math.floor(b.length / 2); for (let i = 0; i < n; i++) { let v = b.charCodeAt(2 * i) | (b.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; s += v * v } meta.decodedSamples = n; meta.rms = n ? Math.round(Math.sqrt(s / n)) : 0 } catch (err) { meta.decodeError = String(err) }
            }
            state.feed.push({ at: T(), ...meta })
          }
        }
      })()
    }
  })()`,
})
const mark = async (name, extra = {}) => { const m = { name, ...(await page.evaluate('({ epoch: Date.now(), mono: performance.now() })')), ...extra }; evidence.marks.push(m); return m }
await page.evaluate(`location.href = ${JSON.stringify(baseUrl)}; 1`)
await page.waitFor(`!!window.__DSH_BOOT__ && document.body.innerText.includes('Workspaces')`, { timeoutMs: 60000, label: 'app boot' })
const clickBox = async (box) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }) }
if (!(await page.evaluate(`document.body.innerText.includes('Ungrouped')`))) { await page.evaluate(`location.reload(); 1`); await page.waitFor(`document.body.innerText.includes('Ungrouped')`, { label: 'session list', timeoutMs: 30000 }) }
const visible = `new RegExp(${JSON.stringify(titlePattern)}, 'm').test(document.body.innerText)`
for (let attempt = 0; attempt < 4 && !(await page.evaluate(visible)); attempt++) {
  const r = await page.evaluate(`(() => { const el = [...document.querySelectorAll('[class*=projectRow]')].find(e => e.textContent.trim() === 'Ungrouped'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 } })()`)
  if (r !== null) await clickBox(r)
  await page.waitFor(visible, { label: 'session row', timeoutMs: 2500 }).catch(() => undefined)
}
const rowBox = await page.evaluate(`(() => { const re = new RegExp(${JSON.stringify(titlePattern)}); const el = [...document.querySelectorAll('div, span, a')].filter(e => re.test((e.textContent || '').trim()) && e.children.length <= 3).sort((a, b) => a.textContent.length - b.textContent.length)[0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
if (rowBox !== null) await clickBox(rowBox)
await page.waitFor(`document.querySelector('[data-testid=dsh-voice-capture-mic]')?.dataset.phase === 'idle'`, { label: 'session composer', timeoutMs: 30000 })
await page.send('Runtime.enable')
const rpc = readFileSync(new URL('./rpc-in-page.js', import.meta.url), 'utf8')
const sid = await page.evaluate(`${rpc}; (async () => { const r = await fetch('/api/session/list', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }) }); const j = await r.json(); return j.result.value.items[0].sessionId })()`)
evidence.sessionId = sid
evidence.app = await page.evaluate(`({ ua: navigator.userAgent, plugins: (window.__DSH_BOOT__?.entries ?? []).filter(e => /voice-capture|dgx-audio|model-library/.test(e.id)).map(e => ({ id: e.id, version: e.version ?? null })) })`)
if (options.selectProvider !== undefined) {
  await page.evaluate(`${rpc}; window.__dshRpc('session/selectModel', { sessionId: ${JSON.stringify(sid)}, provider: ${JSON.stringify(options.selectProvider)}, model: ${JSON.stringify(options.selectModel)} })`)
  await sleep(2000)
}
await page.evaluate(`window.__fxTapFeed(${JSON.stringify(sid)})`)
const panelState = () => page.evaluate(`(() => { const p = ${q('[data-testid=dsh-voice-capture-live-panel]')}; const c = ${q('[data-testid=dsh-voice-capture-live-control]')}; return { phase: p?.dataset.phase ?? null, stats: ${q('[data-testid=dsh-voice-capture-live-stats]')}?.innerText ?? null, control: c ? { type: c.dataset.type, outcome: c.dataset.outcome, confirmed: c.dataset.confirmed, target: c.dataset.target ?? null } : null } })()`)
const fx = () => page.evaluate('window.__fx')
const timelines = () => page.evaluate(`globalThis.__dshVoiceCapture ? globalThis.__dshVoiceCapture.playbackTimelines(${JSON.stringify(sid)}) : null`)
const clickButtonText = async (label) => {
  const box = await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-testid=dsh-voice-capture-live-panel] button')].find(x => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (box === null) return false
  await clickBox(box)
  return true
}
async function openLive(label) {
  await page.waitFor(`${q('[data-testid=dsh-voice-capture-live]')}?.dataset.kind !== undefined && !${q('[data-testid=dsh-voice-capture-live]')}.disabled`, { label: 'live button', timeoutMs: 60000 })
  const click = await mark(`${label}:live-click`)
  await page.clickSelector('[data-testid=dsh-voice-capture-live]')
  const choice = `[data-testid=dsh-voice-capture-live-choice][data-model="${liveModel}"]`
  await page.waitFor(`!!${q(choice)} || !!${q('[data-testid=dsh-voice-capture-live-panel]')}`, { label: 'chooser or panel', timeoutMs: 10000 })
  if (await page.evaluate(`!!${q(choice)}`)) await page.clickSelector(choice)
  await page.waitFor(`${q('[data-testid=dsh-voice-capture-live-panel]')}?.dataset.phase === 'live'`, { label: 'live', timeoutMs: 30000 })
  return click
}

try {
  const click1 = await openLive('s1')
  let playing = null
  let interruptMark = null
  if (options.mode === 'timeline' && options.interrupt) {
    // Wait until a live reply chunk is actually sounding (output clock), then press the real Interrupt button.
    playing = await page.waitFor(`(() => { const t = globalThis.__dshVoiceCapture?.playbackTimelines(${JSON.stringify(sid)}).inProgress.find(x => x.timeline.origin === 'live'); if (!t) return null; const now = Date.now(); const c = t.timeline.chunks.find(k => k.playStartAt !== undefined && k.playStartAt <= now && (k.playEndAt === undefined || k.playEndAt > now)); return c ? { streamId: t.timeline.streamId, seq: c.seq, playStartAt: c.playStartAt } : null })()`, { label: 'reply chunk sounding', timeoutMs: 30000, intervalMs: 50 }).catch(() => null)
    if (playing !== null) {
      await sleep(250)
      interruptMark = await mark('s1:interrupt-click', { streamId: playing.streamId })
      evidence.interruptClicked = await clickButtonText('Interrupt')
      await page.waitFor(`(() => { const c = ${q('[data-testid=dsh-voice-capture-live-control]')}; return !!c && c.dataset.outcome !== 'pending' && (c.dataset.outcome !== 'cancelled' || c.dataset.confirmed === 'true') })()`, { label: 'interrupt outcome', timeoutMs: 15000 }).catch(() => undefined)
      evidence.interruptControl = (await panelState()).control
    }
    const gumResolved = (await fx()).gum.filter(g => g.resolved).at(-1)?.resolved?.mono ?? click1.mono
    const remaining = Math.round(fixture.durationSec * 1000) - ((await page.evaluate('performance.now()')) - gumResolved) + 2500
    if (remaining > 0) await sleep(remaining)
  } else if (options.mode === 'timeline') {
    // Fixed timeline without Interrupt: let the whole fixture play at 1x, then End.
    const gumResolved = (await fx()).gum.filter(g => g.resolved).at(-1)?.resolved?.mono ?? click1.mono
    const remaining = Math.round(fixture.durationSec * 1000) - ((await page.evaluate('performance.now()')) - gumResolved) + (options.tailMs ?? 4000)
    if (remaining > 0) await sleep(remaining)
  } else {
    // Overlap-controlled A/B/C: the capture source plays B once A's reply is sounding, then C; wait for C to end (bounded).
    await page.waitFor(`(() => { const s = window.__dshFixtureCapture?.streams.filter(x => !x.warmup && x.clips.length).at(-1); const c = s?.clips.find(k => k.name === 'C'); return !!c && !!c.endedEpoch })()`, { label: 'clip C played', timeoutMs: 60000, intervalMs: 200 }).catch(() => undefined)
    await sleep(options.tailMs ?? 5000)
  }
  await mark('s1:end-click')
  await page.clickSelector('[data-testid=dsh-voice-capture-live-close]')
  await page.waitFor(`['closed', 'error'].includes(${q('[data-testid=dsh-voice-capture-live-panel]')}?.dataset.phase) && ${q('[data-testid=dsh-voice-capture-live-log]')}?.dataset.log !== 'logging'`, { label: 'closed', timeoutMs: 40000 }).catch(() => undefined)
  await mark('s1:closed', { panel: await panelState() })
  await page.screenshot(join(outDir, 's1-closed.png'))
  await sleep(1200)
  const appendsAfterClose1 = (await fx()).requests.filter(r => r.route === 'live/append' && r.send.mono > evidence.marks.find(m => m.name === 's1:closed').mono).length
  if (options.restart) {
    if (await page.evaluate(`!!${q('[data-testid=dsh-voice-capture-live-dismiss]')}`)) await page.clickSelector('[data-testid=dsh-voice-capture-live-dismiss]')
    await openLive('s2')
    await sleep(4000)
    await mark('s2:end-click')
    await page.clickSelector('[data-testid=dsh-voice-capture-live-close]')
    await page.waitFor(`['closed', 'error'].includes(${q('[data-testid=dsh-voice-capture-live-panel]')}?.dataset.phase)`, { label: 'closed 2', timeoutMs: 40000 }).catch(() => undefined)
    await mark('s2:closed', { panel: await panelState() })
  }
  await sleep(1500)

  // ---- Verdicts (separate rows; page-side monotonic + epoch stamps) ----
  const state = await fx()
  const capture = await page.evaluate('window.__dshFixtureCapture ?? null')
  const tl = await timelines()
  evidence.raw = { gum: state.gum, capture, requests: state.requests, feed: state.feed, timelines: tl, exceptions }
  const opens = state.requests.filter(r => r.route === 'live/open')
  const liveIds = opens.map(r => r.reply?.liveId).filter(Boolean)
  const [L1, L2] = liveIds
  const appends = id => state.requests.filter(r => r.route === 'live/append' && r.liveId === id)
  const a1 = appends(L1)
  const okAppends = a1.filter(r => r.status === 200)
  const capStream = capture?.streams.filter(x => !x.warmup && x.clips.length)[0] ?? null
  const clips = capStream?.clips ?? []
  // C0 capture path and 1x pace.
  // A frame is one seq: retries of the same seq (503 RECONNECTING under an injected fault) are counted separately.
  const okSeqs = okAppends.map(r => r.seq)
  const seqOk = okSeqs.every((seq, i) => seq === i)
  const retries = a1.filter(r => r.status !== 200).length
  const span = okAppends.length > 1 ? (okAppends.at(-1).send.mono - okAppends[0].send.mono) / (okAppends.length - 1) : null
  row('C0', 'capture: fixture enters at getUserMedia; production frames and transport run at 1x', {
    source: evidence.labels.capture, warmupStreams: capture?.streams.filter(x => x.warmup).length ?? null, clips: clips.map(c => ({ name: c.name, scheduledStartEpoch: c.scheduledStartEpoch, endedEpoch: c.endedEpoch ?? null, durationSec: Math.round(c.durationSec * 1000) / 1000 })),
    appendRequests: a1.length, framesOk: okAppends.length, retriedRequests: retries, seqContiguous: seqOk, meanSendIntervalMs: span === null ? null : Math.round(span * 10) / 10,
    note: 'host-received input content vs fixture: see capture-analysis.json (analyze-capture.py)',
  }, clips.length > 0 && okAppends.length >= 20 && seqOk && span !== null && span > 185 && span < 215)
  // C1 ACKs.
  const ackLatency = okAppends.map(r => r.done.mono - r.send.mono).sort((x, y) => x - y)
  const accepted = state.feed.filter(e => e.type === 'live.input.accepted' && e.liveId === L1).length
  const playbackAcks = state.requests.filter(r => r.route === 'live/control' && r.type === 'playback-ack' && r.liveId === L1)
  const ackResults = state.feed.filter(e => e.type === 'live.control.result' && e.control === 'playback-ack' && e.liveId === L1)
  row('C1', 'ACK: every frame (seq) answered 2xx in order and accepted by the host; playback-ack outcomes (transport acceptance only)', {
    retriedRequests: retries,
    appendAckP50Ms: ackLatency.length ? Math.round(ackLatency[Math.floor(ackLatency.length / 2)]) : null, appendAckMaxMs: ackLatency.length ? Math.round(ackLatency.at(-1)) : null, hostAccepted: accepted,
    playbackAckRequests: playbackAcks.length, playbackAckOutcomes: ackResults.reduce((m, e) => { m[e.outcome] = (m[e.outcome] ?? 0) + 1; return m }, {}),
  }, okAppends.length > 0 && seqOk && accepted >= okAppends.length - 2)
  // O1 output presence: nonempty decodable non-silent chunks that actually played.
  // Only streams of this run (the browser keeps finished timelines of earlier runs).
  const liveTimelines = [...(tl?.finished ?? []), ...(tl?.inProgress ?? [])].map(x => x.timeline).filter(t => t.origin === 'live' && t.startAt >= click1.epoch)
  const responses = state.feed.filter(e => e.type === 'live.response' && e.liveId === L1)
  const chunkEvents = state.feed.filter(e => e.type === 'audio.chunk')
  const perStream = liveTimelines.map((t) => {
    const done = responses.find(e => e.responseId === t.streamId && (e.status === 'completed' || e.status === 'cancelled'))
    const played = t.chunks.filter(c => c.playStartAt !== undefined).sort((x, y) => x.playStartAt - y.playStartAt)
    const firstPlay = played[0]?.playStartAt
    const lastEnd = played.length ? Math.max(...played.map(c => c.playEndAt ?? c.playStartAt)) : undefined
    const events = chunkEvents.filter(e => e.streamId === t.streamId)
    return { streamId: t.streamId, chunks: t.chunks.length, played: played.length, nonSilentChunks: events.filter(e => (e.rms ?? 0) > 100).length, decodeErrors: events.filter(e => e.decodeError).length,
      firstPlayAt: firstPlay ?? null, lastSoundAt: lastEnd ?? null, responseStatus: done?.status ?? null, responseDoneAt: done?.at.epoch ?? null, hostEndT: t.hostEndT ?? null,
      firstPlayBeforeDone: firstPlay !== undefined && (t.hostEndT ?? done?.at.epoch) !== undefined ? firstPlay < (t.hostEndT ?? done.at.epoch) : null }
  })
  evidence.streams = perStream
  const presence = perStream.filter(s => s.played >= 2 && s.nonSilentChunks >= 2 && s.decodeErrors === 0)
  row('O1', 'output presence: non-empty, decodable, non-silent reply chunks actually played (output clock), before the reply completed', { streams: perStream },
    presence.length > 0 && presence.some(s => s.firstPlayBeforeDone === true))
  // S1 simultaneous input/output: frames sent and ACKed while a reply buffer was sounding.
  const soundingWindows = liveTimelines.flatMap(t => t.chunks.filter(c => c.playStartAt !== undefined).map(c => [c.playStartAt, c.playEndAt ?? c.playStartAt]))
  const duringOutput = okAppends.filter(r => soundingWindows.some(([a, b]) => r.send.epoch >= a && r.done.epoch <= b))
  const bClip = clips.find(c => c.name === 'B')
  const bSpeechDuring = bClip === undefined ? null : okAppends.filter(r => r.send.epoch >= bClip.scheduledStartEpoch && r.send.epoch <= bClip.scheduledStartEpoch + bClip.durationSec * 1000 && soundingWindows.some(([a, b]) => r.send.epoch >= a && r.done.epoch <= b)).length
  row('S1', 'simultaneous input/output: microphone frames accepted while reply audio is sounding' + (options.mode === 'overlap' ? ' (B sent during A\'s reply)' : ''), {
    appendsAckedWhileSounding: duringOutput.length, bTrigger: capStream?.bTrigger ?? null, bFramesAckedWhileSounding: bSpeechDuring,
  }, duringOutput.length >= 3 && (options.mode !== 'overlap' || (capStream?.bTrigger?.reason === 'reply-sounding' && bSpeechDuring >= 3)))
  // P1 continued progress after later input: a response created after B (overlap) or after the Interrupt (timeline).
  const laterFrom = options.mode === 'overlap' ? bClip?.scheduledStartEpoch : interruptMark?.epoch
  const laterResponses = laterFrom === undefined ? [] : responses.filter(e => e.status === 'created' && e.at.epoch > laterFrom)
  const laterPlayed = perStream.filter(s => laterResponses.some(r => r.responseId === s.streamId) && s.played >= 1 && s.nonSilentChunks >= 1)
  row('P1', 'continued progress: a new reply is produced and played after the later utterance', { laterFromEpoch: laterFrom ?? null, laterResponses: laterResponses.map(r => r.responseId), laterPlayed: laterPlayed.map(s => s.streamId) },
    laterFrom === undefined ? null : laterPlayed.length >= 1)
  // I1 Interrupt (timeline mode).
  if (options.mode === 'timeline' && options.interrupt) {
    const cancelled = responses.find(e => e.status === 'cancelled')
    const target = liveTimelines.find(t => t.streamId === evidence.interruptControl?.target) ?? liveTimelines.find(t => t.streamId === playing?.streamId)
    const clickEpoch = interruptMark?.epoch
    const soundingAtClick = target?.chunks.find(c => c.playStartAt !== undefined && c.playStartAt <= clickEpoch && (c.playEndAt ?? Infinity) > clickEpoch) ?? null
    const soundAfterCancel = target === undefined || cancelled === undefined ? null : target.chunks.some(c => c.playStartAt !== undefined && c.playStartAt > cancelled.at.epoch + 30)
    row('I1', 'Interrupt pressed while a reply buffer is sounding → cancelled and confirmed, that reply stops', {
      interruptClicked: evidence.interruptClicked ?? false, control: evidence.interruptControl ?? null, soundingChunkAtClick: soundingAtClick && { seq: soundingAtClick.seq, playStartAt: soundingAtClick.playStartAt, playEndAt: soundingAtClick.playEndAt ?? null },
      cancelledResponse: cancelled?.responseId ?? null, cancelledAt: cancelled?.at.epoch ?? null, soundStartedAfterCancel: soundAfterCancel,
    }, evidence.interruptClicked === true && evidence.interruptControl?.outcome === 'cancelled' && evidence.interruptControl?.confirmed === 'true' && soundingAtClick !== null && soundAfterCancel === false)
  } else {
    row('I1', 'Interrupt', { reason: 'not part of this run (overlap case keeps Interrupt separate)' }, null)
  }
  // E1 cleanup: End closes, no frames after close, capture released, restart works.
  const close1 = state.requests.find(r => r.route === 'live/close' && r.liveId === L1)
  const a2 = L2 === undefined ? [] : appends(L2).filter(r => r.status === 200)
  const captureStopped = capture === null ? null : capture.streams.filter(x => !x.warmup).every(x => x.stopped !== undefined)
  row('E1', 'cleanup: End live session closes; no frames after close; capture released; Live restarts and frames flow', {
    liveIds, close1: close1 ? { status: close1.status, framesForwarded: close1.reply?.inputIntegrity?.framesForwarded ?? null } : null, appendsAfterClose1, captureStreamsStopped: captureStopped, restartAppendsOk: a2.length,
    closedStates: state.feed.filter(e => e.type === 'live.state' && e.state === 'closed').map(e => e.liveId),
  }, close1?.status === 200 && appendsAfterClose1 === 0 && captureStopped !== false && (!options.restart || (L2 !== undefined && L2 !== L1 && a2.length >= 10)))
  const t0 = click1.mono
  const rel = m => (m === undefined || m === null ? null : Math.round(m - t0))
  evidence.timeline = {
    origin: 'performance.now() at s1 Live click (ms); *Epoch fields are Date.now() ms',
    micGranted: rel(state.gum.find(g => g.resolved)?.resolved.mono), open: rel(opens[0]?.send.mono), openReply: rel(opens[0]?.done?.mono),
    clips: clips.map(c => ({ name: c.name, startEpoch: c.scheduledStartEpoch, endEpoch: c.endedEpoch ?? null })),
    appends: okAppends.map(r => ({ seq: r.seq, send: rel(r.send.mono), ack: rel(r.done.mono) })),
    chunkArrivals: chunkEvents.map(e => ({ streamId: e.streamId, seq: e.seq, at: rel(e.at.mono), rms: e.rms ?? null })),
    responses: responses.map(e => ({ responseId: e.responseId, status: e.status, at: rel(e.at.mono) })),
    playback: liveTimelines.map(t => ({ streamId: t.streamId, chunks: t.chunks.map(c => ({ seq: c.seq, startEpoch: c.playStartAt ?? null, endEpoch: c.playEndAt ?? null, skipped: c.skipped ?? null })) })),
    interruptClick: rel(interruptMark?.mono), controlResults: state.feed.filter(e => e.type === 'live.control.result' && e.control !== 'playback-ack').map(e => ({ control: e.control, outcome: e.outcome, at: rel(e.at.mono) })),
    endClick: rel(evidence.marks.find(m => m.name === 's1:end-click')?.mono), closeReply: rel(close1?.done?.mono), liveStates: state.feed.filter(e => e.type === 'live.state').map(e => ({ state: e.state, liveId: e.liveId, at: rel(e.at.mono) })),
  }
} catch (error) {
  evidence.error = String(error?.stack ?? error)
  console.error(error)
  await page.screenshot(join(outDir, 'error.png')).catch(() => undefined)
} finally {
  evidence.finishedAt = new Date().toISOString()
  evidence.exceptions = exceptions
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(`rows ${evidence.rows.map(r => `${r.id}:${r.result}`).join(' ')}${evidence.error ? ' (error)' : ''}`)
  page.close()
}
