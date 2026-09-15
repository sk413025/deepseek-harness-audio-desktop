#!/usr/bin/env node
// Live input drain check for the pre16 regression (CLIENT_BACKLOG, 0 frames sent): open Live from the UI with a fixture
// input, then sample the Live panel, the page request log (release's live-evidence.mjs observer installed at runtime, as in
// DEMO3) and page exceptions. Loopback mocks only.
// Usage: scenario-live-drain.mjs <cdp-port> <app-url> <session-title-regex> <out-dir> <fixture.wav> <live-model-id> [options JSON]
//   options: { "gumDelayMs": 0, "sampleMs": 20000, "observer": true, "closeAfter": true }
//   gumDelayMs delays the first getUserMedia of the page (a permission prompt answered later); dismissAtMs clicks the
//   Live panel Dismiss button at that time after the Live click (if shown).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveRequestInstrumentation } from '../../../desktop-local-build/tools/live-evidence.mjs'
import { attach, sleep } from './cdp-lib.mjs'

const [portArg, baseUrl, titlePattern, outDir, fixturePath, liveModel, optionsArg] = process.argv.slice(2)
const options = { gumDelayMs: 0, sampleMs: 20000, observer: true, closeAfter: true, ...(optionsArg ? JSON.parse(optionsArg) : {}) }
mkdirSync(outDir, { recursive: true })
const q = selector => `document.querySelector(${JSON.stringify(selector)})`
const fixtureBase64 = readFileSync(fixturePath).toString('base64')
const page = await attach(Number(portArg), url => url.startsWith('http') || url.startsWith('dsh-app:') || url === 'about:blank')
const exceptions = []
page.on((msg) => {
  if (msg.method === 'Runtime.exceptionThrown') exceptions.push({ at: Date.now(), text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text })
})
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: options.injectGum === false ? `(() => {
    // Passive: the capture source is the Chromium fake audio device (app launched with --use-file-for-fake-audio-capture).
    const state = { gum: [] }
    window.__drain = state
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const entry = { requestedAt: Date.now(), constraints: JSON.parse(JSON.stringify(constraints ?? null)) }
      state.gum.push(entry)
      const stream = await original(constraints)
      entry.resolvedAt = Date.now()
      entry.tracks = stream.getAudioTracks().map(t => ({ label: t.label, settings: t.getSettings() }))
      return stream
    }
  })()` : `(() => {
    const state = { gum: [] }
    window.__drain = state
    const fixture = Uint8Array.from(atob(${JSON.stringify(fixtureBase64)}), c => c.charCodeAt(0))
    navigator.mediaDevices.getUserMedia = async () => {
      state.gum.push({ requestedAt: Date.now() })
      // A permission prompt delays only the first request of the page (later requests are already granted).
      if (${Number(options.gumDelayMs)} > 0 && state.gum.length === 1) await new Promise(r => setTimeout(r, ${Number(options.gumDelayMs)}))
      if (!state.context) state.context = new AudioContext({ sampleRate: 48000 })
      await state.context.resume()
      if (!state.buffer) state.buffer = await state.context.decodeAudioData(fixture.slice().buffer)
      const source = state.context.createBufferSource()
      source.buffer = state.buffer
      source.loop = true
      const destination = state.context.createMediaStreamDestination()
      source.connect(destination)
      source.start()
      state.gum.at(-1).resolvedAt = Date.now()
      const stream = destination.stream
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); try { source.stop() } catch {} source.disconnect() } }
      return stream
    }
  })()`,
})
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
const box = await page.evaluate(`(() => { const re = new RegExp(${JSON.stringify(titlePattern)}); const el = [...document.querySelectorAll('div, span, a')].filter(e => re.test((e.textContent || '').trim()) && e.children.length <= 3).sort((a, b) => a.textContent.length - b.textContent.length)[0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
if (box !== null) await clickBox(box)
await page.waitFor(`document.querySelector('[data-testid=dsh-voice-capture-mic]')?.dataset.phase === 'idle'`, { label: 'session composer', timeoutMs: 30000 })
await page.send('Runtime.enable')
if (options.selectProvider !== undefined) {
  const rpc = readFileSync(new URL('./rpc-in-page.js', import.meta.url), 'utf8')
  const sid = await page.evaluate(`${rpc}; (async () => { const r = await fetch('/api/session/list', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }) }); const j = await r.json(); return j.result.value.items[0].sessionId })()`)
  await page.evaluate(`${rpc}; window.__dshRpc('session/selectModel', { sessionId: ${JSON.stringify(sid)}, provider: ${JSON.stringify(options.selectProvider)}, model: ${JSON.stringify(options.selectModel)} })`)
  await sleep(2000)
}
if (options.observer) await page.evaluate(liveRequestInstrumentation())

const evidence = { startedAt: new Date().toISOString(), options, liveModel, samples: [] }
await page.waitFor(`${q('[data-testid=dsh-voice-capture-live]')}?.dataset.kind !== undefined`, { label: 'live button', timeoutMs: 30000 })
await sleep(1500)
await page.waitFor(`!!${q('[data-testid=dsh-voice-capture-live]')} && !${q('[data-testid=dsh-voice-capture-live]')}.disabled`, { label: 'live button enabled', timeoutMs: 60000 })
evidence.clickAt = Date.now()
await page.clickSelector('[data-testid=dsh-voice-capture-live]')
const choice = `[data-testid=dsh-voice-capture-live-choice][data-model="${liveModel}"]`
await page.waitFor(`!!${q(choice)} || !!${q('[data-testid=dsh-voice-capture-live-panel]')}`, { label: 'chooser or panel', timeoutMs: 10000 }).catch(async (error) => { await page.screenshot(join(outDir, 'no-panel.png')); throw error })
if (await page.evaluate(`!!${q(choice)}`)) await page.clickSelector(choice)
const snapshot = () => page.evaluate(`(() => {
  const p = ${q('[data-testid=dsh-voice-capture-live-panel]')}
  const ready = ${q('[data-testid=dsh-voice-capture-live-ready]')}
  const reqs = globalThis.__dshLiveRequests ?? []
  return { t: Date.now(), phase: p?.dataset.phase ?? null, evidence: ${q('[data-testid=dsh-voice-capture-live-evidence]')}?.dataset.state ?? null, queued: ready?.dataset.queued ?? null, ready: ready?.dataset.ready ?? null,
    stats: ${q('[data-testid=dsh-voice-capture-live-stats]')}?.innerText ?? null, text: p ? p.innerText.split('\\n').slice(0, 3).join(' | ') : null,
    requests: reqs.reduce((m, r) => { m[r.route] = (m[r.route] ?? 0) + 1; return m }, {}), gum: window.__drain.gum }
})()`)
const deadline = Date.now() + options.sampleMs
let dismissed = false
while (Date.now() < deadline) {
  if (options.dismissAtMs !== undefined && !dismissed && Date.now() - evidence.clickAt >= options.dismissAtMs) {
    dismissed = true
    evidence.dismiss = { at: Date.now(), clicked: await page.evaluate(`(() => { const b = ${q('[data-testid=dsh-voice-capture-live-dismiss]')}; if (!b) return false; b.click(); return true })()`) }
  }
  const s = await snapshot()
  const key = JSON.stringify({ ...s, t: 0 })
  if (evidence.samples.length === 0 || key !== JSON.stringify({ ...evidence.samples.at(-1), t: 0 })) evidence.samples.push(s)
  if (options.stopOnEnd !== false && (s.phase === 'error' || s.phase === 'closed')) break
  await sleep(250)
}
evidence.final = await snapshot()
evidence.requests = await page.evaluate(`(globalThis.__dshLiveRequests ?? []).map(r => ({ t: r.t, route: r.route, seq: r.seq ?? null, status: r.status ?? null, respondedAt: r.respondedAt ?? null, liveId: r.liveId }))`)
evidence.exceptions = exceptions
await page.screenshot(join(outDir, 'live-drain.png'))
if (options.closeAfter && ['live', 'awaiting'].includes(evidence.final.phase)) {
  await page.clickSelector('[data-testid=dsh-voice-capture-live-close]').catch(() => undefined)
  await sleep(3000)
}
evidence.finishedAt = new Date().toISOString()
writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
const appends = evidence.requests.filter(r => r.route === 'live/append')
console.log(JSON.stringify({ finalPhase: evidence.final.phase, text: evidence.final.text, queued: evidence.final.queued, stats: evidence.final.stats, appendsLogged: appends.length, appendsOk: appends.filter(r => r.status === 200).length, routes: evidence.final.requests, gum: evidence.final.gum, exceptions: exceptions.slice(0, 3) }))
page.close()
