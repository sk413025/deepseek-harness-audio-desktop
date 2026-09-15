#!/usr/bin/env node
// Hardware capture layer (AUDIO_TEST_LAYERING_20260915.md item 5): play a fixture WAV through the physical speaker with
// `afplay` (current system volume, unchanged) and record it with the actual USB microphone inside the packaged app.
// No person speaks; bounded duration; nothing is sent to a model (backend=none). Acoustic recordings are compared by
// alignment/correlation/level/clipping/dropouts, never by bytes. Echo cancellation / noise suppression / AGC settings are
// recorded because they can suppress speaker playback.
//
// Cases (in one already-running app page that holds microphone permission; no permission bypass):
//   H-raw      getUserMedia({echoCancellation:false, noiseSuppression:false, autoGainControl:false}) → PCM tap
//   H-default  getUserMedia({audio:true}) (Chromium defaults: AEC/NS/AGC on) → PCM tap
//   H-product  the plugin's Mic button → Stop → preview WAV (production capture.ts path; discarded, never sent)
// Usage: loopback-record.mjs <cdp-port> <fixture.wav> <out-dir> [cases=H-raw,H-default,H-product]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach, sleep } from '../e2e/cdp-lib.mjs'

const [portArg, fixture, outDir, casesArg] = process.argv.slice(2)
const CASES = (casesArg ?? 'H-raw,H-default,H-product').split(',')
mkdirSync(outDir, { recursive: true })
const page = await attach(Number(portArg), u => u.startsWith('dsh-app:') || u.startsWith('http'))
// Open the first session row matching SESSION_TITLE (for the Mic button case).
if (process.env.SESSION_TITLE) {
  const clickBox = async (box) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }) }
  await page.waitFor(`document.body.innerText.includes('Ungrouped')`, { label: 'session list', timeoutMs: 30000 })
  const re = JSON.stringify(process.env.SESSION_TITLE)
  for (let i = 0; i < 4 && !(await page.evaluate(`new RegExp(${re}).test(document.body.innerText)`)); i++) {
    const r = await page.evaluate(`(() => { const el = [...document.querySelectorAll('[class*=projectRow]')].find(e => e.textContent.trim() === 'Ungrouped'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 } })()`)
    if (r) await clickBox(r)
    await sleep(1500)
  }
  const box = await page.evaluate(`(() => { const re = new RegExp(${re}); const el = [...document.querySelectorAll('div, span, a')].filter(e => re.test((e.textContent || '').trim()) && e.children.length <= 3).sort((a, b) => a.textContent.length - b.textContent.length)[0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (box) await clickBox(box)
  await page.waitFor(`document.querySelector('[data-testid=dsh-voice-capture-mic]')?.dataset.phase === 'idle'`, { label: 'session composer', timeoutMs: 30000 })
}
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim() } catch (e) { return `error: ${e.message}` } }
const meta = {
  schema: 'dsh-hardware-loopback@1', startedAt: new Date().toISOString(), labels: { capture: 'physical (Mac speaker → USB microphone, acoustic)', backend: 'none' },
  fixture, afplay: '/usr/bin/afplay', systemVolume: sh('osascript', ['-e', 'get volume settings']),
  audioDevices: sh('system_profiler', ['SPAudioDataType']).split('\n').filter(l => /:\s*$|Default|Channels|SampleRate|Manufacturer|Transport/.test(l)).map(l => l.trim()).join(' | '),
  os: sh('sw_vers', ['-productVersion']), app: await page.evaluate(`({ ua: navigator.userAgent, voiceCapture: (window.__DSH_BOOT__?.entries ?? []).find(e => e.id === 'dsh-voice-capture')?.version ?? null })`),
  cases: [],
}
const fixtureDuration = Number(sh('/opt/anaconda3/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fixture])) || 10
const playFixture = () => new Promise((resolve) => {
  const startedAt = Date.now()
  const p = spawn('/usr/bin/afplay', [fixture], { stdio: 'ignore' })
  p.on('exit', (code) => resolve({ startedAt, endedAt: Date.now(), code }))
})
function wav16(pcmB64, rate, path) {
  const pcm = Buffer.from(pcmB64, 'base64')
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([h, pcm]))
}

// In-page PCM tap with given constraints: returns a controller on window.__loop.
await page.evaluate(`window.__loopStart = async (constraints) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
  const track = stream.getAudioTracks()[0]
  const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume()
  const src = ctx.createMediaStreamSource(stream)
  const chunks = []
  const node = ctx.createScriptProcessor(4096, src.channelCount || 1, 1)
  node.onaudioprocess = (e) => { const a = e.inputBuffer.getChannelData(0); chunks.push(new Float32Array(a)) }
  src.connect(node); node.connect(ctx.destination) // output of the processor node is silent (not copied)
  window.__loop = { stream, ctx, chunks, startedAt: Date.now(), label: track.label, settings: track.getSettings(), constraints }
  return { label: track.label, settings: track.getSettings(), startedAt: window.__loop.startedAt }
}
window.__loopStop = async () => {
  const l = window.__loop; l.stoppedAt = Date.now()
  l.stream.getTracks().forEach(t => t.stop()); await l.ctx.close()
  const n = l.chunks.reduce((s, c) => s + c.length, 0); const pcm = new Int16Array(n); let o = 0
  for (const c of l.chunks) { for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))) }
  let bin = ''; const bytes = new Uint8Array(pcm.buffer); for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return { b64: btoa(bin), frames: n, startedAt: l.startedAt, stoppedAt: l.stoppedAt, label: l.label, settings: l.settings, constraints: l.constraints }
}; 1`)

for (const id of CASES) {
  const entry = { id }
  try {
    if (id === 'H-raw' || id === 'H-default') {
      const constraints = id === 'H-raw' ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : true
      entry.track = await page.evaluate(`window.__loopStart(${JSON.stringify(constraints)})`)
      await sleep(700)
      entry.playback = await playFixture()
      await sleep(1200)
      const rec = await page.evaluate('window.__loopStop()')
      const file = `${id}.wav`
      wav16(rec.b64, 48000, join(outDir, file))
      Object.assign(entry, { file, recordStartedAt: rec.startedAt, recordStoppedAt: rec.stoppedAt, frames: rec.frames, settings: rec.settings, label: rec.label, constraints: rec.constraints })
    } else if (id === 'H-product') {
      await page.evaluate(`(() => { if (window.__gumWrapped) return; window.__gumWrapped = true; window.__gumLog = []; const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (c) => { const s = await g(c); window.__gumLog.push({ at: Date.now(), constraints: c, label: s.getAudioTracks()[0]?.label, settings: s.getAudioTracks()[0]?.getSettings() }); return s } })()`)
      await page.waitFor(`document.querySelector('[data-testid=dsh-voice-capture-mic]')?.dataset.phase === 'idle'`, { label: 'mic idle', timeoutMs: 20000 })
      await page.clickSelector('[data-testid=dsh-voice-capture-mic]')
      await page.waitFor(`!!document.querySelector('[data-testid=dsh-voice-capture-stop]')`, { label: 'recording', timeoutMs: 15000 })
      entry.recordClickAt = Date.now()
      await sleep(700)
      entry.playback = await playFixture()
      await sleep(1200)
      entry.stopClickAt = Date.now()
      await page.clickSelector('[data-testid=dsh-voice-capture-stop]')
      await page.waitFor(`!!document.querySelector('[data-testid=dsh-voice-capture-preview]')`, { label: 'preview', timeoutMs: 20000 })
      const clip = await page.evaluate(`(async () => { const el = document.querySelector('[data-testid=dsh-voice-capture-preview]'); const audio = el.tagName === 'AUDIO' ? el : el.querySelector('audio'); const r = await fetch(audio.src); const buf = new Uint8Array(await r.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768)); return { b64: btoa(bin), type: r.headers.get('content-type'), details: document.querySelector('[data-testid=dsh-voice-capture-details]')?.innerText ?? null, gum: window.__gumLog.at(-1) ?? null } })()`)
      const file = 'H-product.wav'
      writeFileSync(join(outDir, file), Buffer.from(clip.b64, 'base64'))
      Object.assign(entry, { file, previewType: clip.type, details: clip.details, gum: clip.gum })
      await page.clickSelector('[data-testid=dsh-voice-capture-discard]')
      entry.discarded = true
    }
    entry.analysis = JSON.parse(execFileSync('/opt/anaconda3/bin/python3', [new URL('../fixtures/analyze-capture.py', import.meta.url).pathname, fixture, join(outDir, entry.file), '--out', join(outDir, `${id}-analysis.json`), '--label', `${id}: speaker → USB microphone`], { encoding: 'utf8' }))
    const a = entry.analysis
    entry.verdict = {
      aligned: a.alignment.envelopeCorrelation !== null && a.alignment.envelopeCorrelation >= 0.6,
      audible: a.captured.rmsDbfs !== null && a.captured.rmsDbfs > -55,
      noClipping: a.captured.clippedRatio < 0.001,
      noDropouts: a.dropouts.length === 0,
      expectedLagSec: entry.playback && entry.recordStartedAt ? Math.round((entry.playback.startedAt - entry.recordStartedAt)) / 1000 : null,
    }
    entry.result = Object.entries(entry.verdict).filter(([k]) => k !== 'expectedLagSec').every(([, v]) => v) ? 'PASS' : 'FAIL'
  } catch (error) {
    entry.error = String(error?.stack ?? error)
    entry.result = 'FAIL'
  }
  meta.cases.push(entry)
  console.log(`${entry.result} ${id} ${JSON.stringify({ settings: entry.settings ?? entry.gum?.settings ?? null, alignment: entry.analysis?.alignment ?? null, captured: entry.analysis?.captured ?? null, dropouts: entry.analysis?.dropouts?.length ?? null, error: entry.error ?? null }).slice(0, 700)}`)
  await sleep(1500)
}
meta.finishedAt = new Date().toISOString()
writeFileSync(join(outDir, 'hardware-loopback.json'), JSON.stringify(meta, null, 2))
page.close()
