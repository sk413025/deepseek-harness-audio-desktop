#!/usr/bin/env node
// Fixture-capture desktop scenario for turn-based spoken chat (MiMo-style: record → stop → send; progressive audio OUTPUT;
// not streaming input or full duplex). capture=fixture (test-only MediaStream at getUserMedia, 1x), backend per option.
// Clicks the real Mic, Stop, Send recording and reply-bar Stop controls; never calls model APIs.
//   M1  recorded fixture reaches the host as the request audio; reply audio plays progressively (verdict tool on the home)
//   M2  Stop pressed while a non-silent reply buffer is sounding (not in an underrun gap) → silence at once, turn cancelled
// Usage: scenario-fixture-mimo.mjs <cdp-port> <app-url> <session-title-regex> <out-dir> <fixture-dir> <invocations.jsonl> <verdict.mjs> [options JSON]
//   options: { "fixture": <file> (default manifest roles.turn), "selectProvider": "...", "selectModel": "...", "backend": "mock" | "real" }
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach, sleep } from './cdp-lib.mjs'

const [portArg, baseUrl, titlePattern, outDir, fixtureDir, invocationsPath, verdictScript, optionsArg] = process.argv.slice(2)
const options = { backend: 'mock', ...(optionsArg ? JSON.parse(optionsArg) : {}) }
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'))
options.fixture ??= manifest.roles?.turn ?? 'mimo-question.wav'
const entry = manifest.files.find(f => f.file === options.fixture)
const wavBytes = readFileSync(join(fixtureDir, options.fixture))
if (!entry || createHash('sha256').update(wavBytes).digest('hex') !== entry.sha256) throw new Error('fixture missing or sha256 mismatch')
mkdirSync(outDir, { recursive: true })
const q = s => `document.querySelector(${JSON.stringify(s)})`
const evidence = { schema: 'dsh-fixture-mimo@1', startedAt: new Date().toISOString(), labels: { capture: 'fixture (test-only MediaStream injection at getUserMedia)', backend: options.backend }, fixture: { file: entry.file, sha256: entry.sha256, durationSec: entry.durationSec, transcript: entry.transcript }, fixtureLicense: manifest.license, rows: [] }
const row = (id, name, data, pass) => { const r = { id, name, result: pass === null ? 'NOT RUN' : pass ? 'PASS' : 'FAIL', ...data }; evidence.rows.push(r); console.log(`${r.result} ${id} ${name} ${JSON.stringify(data).slice(0, 500)}`) }
const lines = () => (existsSync(invocationsPath) ? readFileSync(invocationsPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const page = await attach(Number(portArg), u => u.startsWith('http') || u.startsWith('dsh-app:') || u === 'about:blank')
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__dshFixtureCaptureConfig = ${JSON.stringify({ mode: 'timeline', clips: { T: wavBytes.toString('base64') } })};\n${readFileSync(new URL('./fixture-capture-source.page.js', import.meta.url), 'utf8')}` })
await page.evaluate(`location.href = ${JSON.stringify(baseUrl)}; 1`)
await page.waitFor(`!!window.__DSH_BOOT__ && document.body.innerText.includes('Workspaces')`, { timeoutMs: 60000, label: 'app boot' })
const clickBox = async (box) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }) }
if (!(await page.evaluate(`document.body.innerText.includes('Ungrouped')`))) { await page.evaluate(`location.reload(); 1`); await page.waitFor(`document.body.innerText.includes('Ungrouped')`, { label: 'session list', timeoutMs: 30000 }) }
const visible = `new RegExp(${JSON.stringify(titlePattern)}, 'm').test(document.body.innerText)`
for (let i = 0; i < 4 && !(await page.evaluate(visible)); i++) { const r = await page.evaluate(`(() => { const el = [...document.querySelectorAll('[class*=projectRow]')].find(e => e.textContent.trim() === 'Ungrouped'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 } })()`); if (r) await clickBox(r); await sleep(1500) }
const rowBox = await page.evaluate(`(() => { const re = new RegExp(${JSON.stringify(titlePattern)}); const el = [...document.querySelectorAll('div, span, a')].filter(e => re.test((e.textContent || '').trim()) && e.children.length <= 3).sort((a, b) => a.textContent.length - b.textContent.length)[0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
if (rowBox) await clickBox(rowBox)
await page.waitFor(`${q('[data-testid=dsh-voice-capture-mic]')}?.dataset.phase === 'idle'`, { label: 'session composer', timeoutMs: 30000 })
const rpc = readFileSync(new URL('./rpc-in-page.js', import.meta.url), 'utf8')
const sid = await page.evaluate(`${rpc}; (async () => { const r = await fetch('/api/session/list', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }) }); const j = await r.json(); return j.result.value.items[0].sessionId })()`)
if (options.selectProvider) { await page.evaluate(`${rpc}; window.__dshRpc('session/selectModel', { sessionId: ${JSON.stringify(sid)}, provider: ${JSON.stringify(options.selectProvider)}, model: ${JSON.stringify(options.selectModel)} })`); await sleep(2000) }
await page.evaluate(readFileSync(new URL('../demo/playback-probe.page.js', import.meta.url), 'utf8'))
await page.evaluate(`globalThis.__dshPlaybackProbe.tapFeed(${JSON.stringify(sid)})`)
const timelines = () => page.evaluate(`globalThis.__dshVoiceCapture.playbackTimelines(${JSON.stringify(sid)})`)

async function recordAndSend(label) {
  await page.waitFor(`${q('[data-testid=dsh-voice-capture-mic]')}?.dataset.phase === 'idle' && !${q('[data-testid=dsh-voice-capture-mic]')}.disabled`, { label: `${label} mic idle`, timeoutMs: 60000 })
  const before = (await timelines()).finished.length
  const t = { micClick: Date.now() }
  await page.clickSelector('[data-testid=dsh-voice-capture-mic]')
  await page.waitFor(`!!${q('[data-testid=dsh-voice-capture-stop]')}`, { label: `${label} recording`, timeoutMs: 15000 })
  t.recording = Date.now()
  await sleep(Math.round(entry.durationSec * 1000) + 400)
  t.stopClick = Date.now()
  await page.clickSelector('[data-testid=dsh-voice-capture-stop]')
  await page.waitFor(`!!${q('[data-testid=dsh-voice-capture-send]')} && !${q('[data-testid=dsh-voice-capture-send]')}.disabled`, { label: `${label} preview`, timeoutMs: 20000 })
  t.details = await page.evaluate(`${q('[data-testid=dsh-voice-capture-details]')}?.innerText ?? null`)
  t.sendClick = Date.now()
  await page.clickSelector('[data-testid=dsh-voice-capture-send]')
  return { t, before }
}

try {
  // M1
  const first = await recordAndSend('M1')
  await page.waitFor(`globalThis.__dshVoiceCapture.playbackTimelines(${JSON.stringify(sid)}).finished.length > ${first.before}`, { label: 'M1 timeline', timeoutMs: 90000, intervalMs: 250 })
  await sleep(2500)
  const tl1 = (await timelines()).finished.at(-1)
  const inv1 = lines().filter(l => l.record === 'invocation' && l.stream?.audio?.streamId === tl1.timeline.streamId).at(-1) ?? null
  const out1 = join(outDir, 'verdict-M1.json')
  try { execFileSync(process.execPath, [verdictScript, '--invocations', invocationsPath, '--stream', tl1.timeline.streamId, '--out', out1], { stdio: 'pipe' }) } catch {}
  const v1 = JSON.parse(readFileSync(out1, 'utf8'))
  const inputAudio = inv1?.inputAudio ?? []
  const capture = await page.evaluate('window.__dshFixtureCapture')
  evidence.m1 = { timing: first.t, summary: tl1.summary, inputAudio, verdict: { pass: v1.desktopStreamingPass, transport: v1.transport?.checks, playback: v1.playback?.checks, flags: v1.quality?.flags }, captureStreams: capture.streams.map(s => ({ warmup: s.warmup ?? false, clips: s.clips.length, stopped: !!s.stopped })) }
  row('M1', 'record → stop → send with the fixture; request audio reaches the host; reply plays progressively (desktopStreamingPass)', {
    recordingDetails: first.t.details, requestAudio: inputAudio.map(a => ({ name: a.name, bytes: a.bytes ?? null, sha256: a.sha256 })), caption: tl1.summary.verdict, firstPlaybackBeforeEnd: tl1.summary.firstPlaybackBeforeGenerationEnd, chunks: `${tl1.summary.chunksPlayed}/${tl1.summary.chunksReceived}`,
    verdictPass: v1.desktopStreamingPass, verdictFlags: v1.quality?.flags ?? null,
  }, inputAudio.length > 0 && v1.desktopStreamingPass === true && tl1.summary.verdict === 'progressive')
  // M2: Stop inside a sounding, non-silent buffer.
  const second = await recordAndSend('M2')
  const hit = await page.waitFor(`(() => { const t = globalThis.__dshVoiceCapture.playbackTimelines(${JSON.stringify(sid)}).inProgress.find(x => x.timeline.origin === 'chat' && x.timeline.startAt >= ${second.t.sendClick}); if (!t) return null; const now = Date.now(); const c = t.timeline.chunks.find(k => k.playStartAt !== undefined && k.playStartAt + 40 <= now && (k.playEndAt === undefined) && k.when !== undefined); return c ? { streamId: t.timeline.streamId, seq: c.seq, playStartAt: c.playStartAt, samples: c.samples } : null })()`, { label: 'M2 sounding buffer', timeoutMs: 90000, intervalMs: 20 }).catch(() => null)
  let stopClick = null
  if (hit !== null) { stopClick = Date.now(); await page.clickSelector('[data-testid=dsh-voice-capture-reply-stop]') }
  await page.waitFor(`globalThis.__dshVoiceCapture.playbackTimelines(${JSON.stringify(sid)}).finished.some(x => x.timeline.streamId === ${JSON.stringify(hit?.streamId ?? '')})`, { label: 'M2 finished', timeoutMs: 60000, intervalMs: 250 }).catch(() => undefined)
  await sleep(2500)
  const tl2 = (await timelines()).finished.find(x => x.timeline.streamId === hit?.streamId) ?? null
  const probe = (await page.evaluate('globalThis.__dshPlaybackProbe.read()')).streams.find(s => s.streamId === hit?.streamId) ?? null
  const chunkEvent = probe?.chunkArrivals?.find(c => c.seq === hit?.seq) ?? null
  const stopAt = tl2?.timeline.stopAt ?? null
  const sounding = tl2?.timeline.chunks.find(c => c.seq === hit?.seq) ?? null
  const inside = sounding !== null && stopAt !== null && sounding.playStartAt <= stopAt && (sounding.playStartAt + (sounding.samples / (tl2.timeline.sampleRate || 24000)) * 1000) > stopAt
  const out2 = join(outDir, 'verdict-M2.json')
  try { execFileSync(process.execPath, [verdictScript, '--invocations', invocationsPath, '--stream', hit?.streamId ?? 'none', '--out', out2], { stdio: 'pipe' }) } catch {}
  const v2 = existsSync(out2) ? JSON.parse(readFileSync(out2, 'utf8')) : null
  const feedChunk = (await page.evaluate('globalThis.__dshPlaybackProbe.read()')).feed.find(e => e.type === 'audio.chunk' && e.streamId === hit?.streamId && e.seq === hit?.seq) ?? null
  evidence.m2 = { timing: second.t, hit, stopClick, timeline: tl2?.timeline ?? null, probe, verdictStop: v2?.stop ?? null }
  row('M2', 'reply-bar Stop during a sounding non-silent buffer (not an underrun gap) → no sound after Stop; turn cancelled', {
    stopClickAt: stopClick, soundingChunk: sounding && { seq: sounding.seq, playStartAt: sounding.playStartAt, nominalEndAt: Math.round(sounding.playStartAt + sounding.samples / (tl2.timeline.sampleRate || 24000) * 1000) }, stopAt, stopInsideBuffer: inside,
    chunkBytesPresent: feedChunk?.dataBase64Chars ?? null, soundAfterStop: tl2?.summary.soundAfterStop ?? null, verdictStop: v2?.stop ?? null,
  }, hit !== null && inside && (feedChunk?.dataBase64Chars ?? 0) > 0 && tl2?.summary.soundAfterStop === false && v2?.stop?.localPlaybackHalted === true)
} catch (error) {
  evidence.error = String(error?.stack ?? error)
  console.error(error)
  await page.screenshot(join(outDir, 'error.png')).catch(() => undefined)
} finally {
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(`rows ${evidence.rows.map(r => `${r.id}:${r.result}`).join(' ')}${evidence.error ? ' (error)' : ''}`)
  page.close()
}
