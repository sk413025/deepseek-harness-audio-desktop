#!/usr/bin/env node
// Service availability in the PUBLISHED packaged app (macOS release/manual job).
// Real app + installed plugins; the only fakes are the upstream (loopback mock backend behind a TCP fault switch) and,
// for capture cases, the microphone owner's fixture capture adapter at the MediaStream boundary. Every check is
// labelled capture=none|fixture, backend=mock. Nothing here is real-DGX, physical-microphone or audio-quality evidence.
//
// Cases (ids match ci/availability/scenarios.json "packaged" entries):
//   a12.no-lab-paths            installed plugins, app seed and the used DSH_HOME contain no lab identifiers/window files
//   a12.endpoint-only           fresh home with only an endpoint in settings: real composer send → mock reply rendered
//   a8.output-stop-active-buffer Stop clicked while an output audio buffer is audibly scheduled → nothing plays after it
//   a1.send-to-absent-server    upstream absent: real composer send → explicit bounded error, prompt kept, logged TRANSPORT
//   a9.recovery-no-replay       upstream back: next send = exactly one upstream request, the failed prompt not replayed
//   capture.*                   NOT RUN until the microphone owner's fixture + capture adapter are provided (--capture-adapter)
//   probe.permission-path       info: what the hosted runner's real permission path does (no adapter)
//
// Usage: desktop-availability.mjs --app <.app> --tag <tag> --tag-src <dir> --out-dir <dir> [--capture-adapter <dir>]
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createFaultProxy } from '../availability/fakes/fault-proxy.mjs'
import { freePort, sleep, waitUntil } from '../lib/cdp.mjs'
import { parseArgs, Report, required, run, sha256 } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'app', 'tag', 'tag-src', 'out-dir')
for (const key of ['app', 'tag-src', 'out-dir']) args[key] = resolve(args[key])
const outDir = join(args['out-dir'], 'availability')
const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-availability-work')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
mkdirSync(workDir, { recursive: true })
const expected = JSON.parse(readFileSync(new URL('../expected.json', import.meta.url), 'utf8'))
const plugins = JSON.parse(readFileSync(join(args['tag-src'], 'releases', args.tag, 'PLUGINS.json'), 'utf8')).plugins
const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(args.app, 'Contents', 'Info.plist')]).stdout)
const executable = join(args.app, 'Contents', 'MacOS', info.CFBundleExecutable)
const profile = expected.app.desktopProfile
const U = 'packaged-app-hosted-ui'
const timelineFile = join(outDir, 'timeline.log')
const note = (text) => { const line = `${new Date().toISOString()} ${text}`; console.log(line); appendFileSync(timelineFile, line + '\n') }
const report = new Report('desktop-availability', {
  tag: args.tag, bundleIdentifier: info.CFBundleIdentifier, shortVersion: info.CFBundleShortVersionString,
  plugins: plugins.map(p => ({ name: p.name, version: p.version, sha256: p.sha256 })),
  labels: { backend: 'mock (loopback mock-backend.mjs behind a TCP fault switch)', capture: args['capture-adapter'] ? 'fixture (microphone owner adapter)' : 'none' },
  mockBackend: { file: 'ci/availability/fakes/mock-backend.mjs', sha256: sha256(readFileSync(new URL('../availability/fakes/mock-backend.mjs', import.meta.url))) },
  runner: { imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, macOS: run('sw_vers', ['-productVersion']).stdout.trim() },
  notCovered: ['real DGX model servers', 'physical USB microphone / macOS TCC prompt', 'speaker output and audio quality'],
})
// Observation only (no substitution): request log and output audio source timing, installed before app scripts run.
const OBSERVER = `(() => {
  if (window.__CI_OBS__) return
  const obs = window.__CI_OBS__ = { fetches: [], sources: [] }
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const entry = /\\/api\\/(dsh-dgx-audio|session)\\//.test(url) ? { at: Date.now(), url: url.replace(location.origin, '').slice(0, 160), method: init?.method ?? 'GET' } : null
    if (entry && obs.fetches.length < 2000) obs.fetches.push(entry)
    try { const response = await originalFetch(input, init); if (entry) { entry.status = response.status; entry.doneAt = Date.now() } return response }
    catch (error) { if (entry) { entry.error = String(error).slice(0, 120); entry.doneAt = Date.now() } throw error }
  }
  const start = AudioBufferSourceNode.prototype.start
  const stop = AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
    const ctx = this.context
    const now = Date.now()
    const lead = Math.max(0, (when || 0) - ctx.currentTime) * 1000
    const seconds = this.buffer ? (duration ?? (this.buffer.duration - (offset || 0))) : 0
    const record = { createdAt: now, expectedStartAt: now + lead, expectedEndAt: now + lead + seconds * 1000, seconds, stoppedAt: null, endedAt: null }
    if (obs.sources.length < 5000) obs.sources.push(record)
    this.addEventListener('ended', () => { record.endedAt = Date.now() })
    this.__ciRecord = record
    return start.call(this, when, offset, duration)
  }
  AudioBufferSourceNode.prototype.stop = function (...rest) {
    if (this.__ciRecord && this.__ciRecord.stoppedAt === null) this.__ciRecord.stoppedAt = Date.now()
    return stop.apply(this, rest)
  }
})()`

const cleanups = []
const label = (capture) => `[capture=${capture}, backend=mock]`

try {
  await main()
} catch (error) {
  report.add('availability.aborted', 'fail', U, String(error?.message ?? error).split('\n')[0], { stack: String(error?.stack ?? '').slice(0, 2000) })
}
for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch { /* best effort */ } }
const document = report.write(join(outDir, 'report.json'))
console.log(`\n${document.report}: ${document.verdict.toUpperCase()} ${JSON.stringify(document.counts)}`)
process.exit(document.verdict === 'pass' ? 0 : 1)

async function main() {
  // Fake upstream + fault switch.
  const mockPort = await freePort()
  const mockLog = join(outDir, 'mock-backend.jsonl')
  writeFileSync(mockLog, '')
  const mock = spawn(process.execPath, [new URL('../availability/fakes/mock-backend.mjs', import.meta.url).pathname, String(mockPort), mockLog], { stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stderr.pipe(createWriteStream(join(outDir, 'mock-backend.stderr.log')))
  cleanups.push(() => mock.kill('SIGKILL'))
  await waitUntil('mock backend', async () => { try { return (await fetch(`http://127.0.0.1:${mockPort}/v1/models`)).ok } catch { return false } }, { timeoutMs: 10_000, intervalMs: 100 })
  const proxy = await createFaultProxy({ targetPort: mockPort })
  cleanups.push(async () => { writeFileSync(join(outDir, 'fault-proxy.json'), JSON.stringify(proxy.journal, null, 2)); await proxy.close() })
  const mockRequests = () => readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.kind === 'http' && String(r.path).includes('/chat/completions'))
  note(`mock backend 127.0.0.1:${mockPort}, fault proxy 127.0.0.1:${proxy.port}`)

  // Fresh recipient home: only an endpoint in settings (no lab tools, no window files, no SSH).
  const home = join(workDir, 'home')
  const userData = join(workDir, 'userdata')
  const workspace = join(workDir, 'workspace')
  for (const dir of [home, userData, workspace]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'settings.yaml'), [
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    'agent-default-model:',
    '  provider: ci-fake',
    '  model: ci-chat',
    'dsh-dgx-audio:',
    '  routes:',
    '    - provider: ci-fake',
    '      displayName: CI fake upstream (loopback mock, not a model)',
    `      baseURL: http://127.0.0.1:${proxy.port}/v1`,
    '      models:',
    '        - id: ci-chat',
    '          name: CI mock spoken chat',
    '          upstreamModel: mock-audio',
    '          mode: chat',
    '          outputAudio: true',
    '          sendModalities: true',
    '',
  ].join('\n'))
  const env = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', '__CF_USER_TEXT_ENCODING']) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_DIAGNOSTIC_FILE: join(outDir, 'startup-diagnostic.txt') })

  const { _electron } = await import('playwright-core')
  const app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], env, timeout: 420_000 })
  cleanups.push(async () => { try { app.process().kill('SIGKILL') } catch { /* gone */ } })
  app.process().stdout?.pipe(createWriteStream(join(outDir, 'app-stdout.log')))
  app.process().stderr?.pipe(createWriteStream(join(outDir, 'app-stderr.log')))
  await app.context().addInitScript({ content: OBSERVER })
  const findMain = () => app.windows().find(w => !w.isClosed() && w.url().startsWith('dsh-app://app/'))
  const booted = async () => (await waitUntil('booted main window', async () => {
    const page = findMain()
    return page && (await page.evaluate(() => Array.isArray(window.__DSH_BOOT__?.entries) && window.__DSH_BOOT__.entries.length > 0).catch(() => false)) ? page : undefined
  }, { timeoutMs: 420_000, intervalMs: 1000 })).value
  let page = await booted()
  await page.reload()
  page = await booted()
  const observerInstalled = await page.evaluate(() => window.__CI_OBS__ !== undefined)
  report.expect('availability.observer', observerInstalled, U, 'page observer installed (observation only: fetch log, output source start/stop/ended times)')
  const shot = name => page.screenshot({ path: join(outDir, `${name}.png`) }).catch(() => undefined)
  await dismissFirstRunDialogs(page)
  await shot('00-booted')

  // Session in a workspace (the directory picker is native; the RPC is what the picker's choice triggers), then the UI.
  const rpc = (method, request) => page.evaluate(async ([method, request]) => {
    const body = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }
    const response = await fetch(`/api/${method}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await response.json()
    if (!json.result?.ok) throw new Error(`${method}: ${JSON.stringify(json).slice(0, 400)}`)
    return json.result.value
  }, [method, request])
  let created
  for (const preset of ['dgx-audio', undefined]) {
    try { created = await rpc('session/create', { cwd: workspace, ...(preset ? { agentPreset: preset } : {}) }); report.add('availability.session', 'info', U, `session ${created.sessionId} created in the workspace (agent preset ${preset ?? 'default'})`); break } catch (error) { note(`session/create preset=${preset}: ${String(error.message).slice(0, 200)}`) }
  }
  if (!created) throw new Error('could not create a session')
  await rpc('session/selectModel', { sessionId: created.sessionId, provider: 'ci-fake', model: 'ci-chat' })
  await openSession(page, created.sessionId)
  await shot('01-session-open')
  const composer = page.locator('main [role=textbox], [role=textbox]').last()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  const micPresent = await page.locator('[data-testid=dsh-voice-capture-mic]').count()
  report.add('availability.session-ui', 'info', U, `session view open: composer visible, microphone control ${micPresent > 0 ? 'present' : 'absent'}`)

  const send = async (text) => {
    await composer.click()
    await page.keyboard.type(text, { delay: 5 })
    const at = Date.now()
    await page.keyboard.press('Enter')
    return at
  }
  const invocations = () => {
    const file = join(home, 'dsh-dgx-audio', 'outputs', 'invocations.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) : []
  }

  // a12.endpoint-only: normal inference through the real composer with only an endpoint configured.
  await proxy.setMode('up')
  const before12 = mockRequests().length
  await send('CI availability ping')
  const replied = await waitUntil('mock reply rendered', async () => page.evaluate(() => /Mock spoken reply/.test(document.querySelector('main')?.innerText ?? document.body.innerText)), { timeoutMs: 60_000, intervalMs: 500 }).then(r => r.ms).catch(() => null)
  await shot('02-endpoint-only-reply')
  report.expect('a12.endpoint-only', replied !== null && mockRequests().length === before12 + 1, U, `${label('none')} fresh home with only an endpoint: composer send reached the configured endpoint once and the reply rendered${replied !== null ? ` after ${replied} ms` : ''}`, { upstreamRequests: mockRequests().length - before12, lastInvocation: invocations().at(-1) ?? null })

  // a8.output-stop-active-buffer: Stop during an audibly scheduled output buffer (not an underrun gap).
  const stopCase = await stopDuringActiveBuffer(page, send)
  await shot('03-output-stop')
  report.add('a8.output-stop-active-buffer', stopCase.status, U, `${label('none')} ${stopCase.summary}`, stopCase.detail)

  // a1.send-to-absent-server: upstream absent before send.
  await waitIdle(page)
  await proxy.setMode('absent')
  const before1 = mockRequests().length
  const invBefore = invocations().length
  const sentAt = await send('CI availability offline check')
  const errorSeen = await waitUntil('explicit unavailable error in the conversation', async () => page.evaluate(() => {
    const text = document.querySelector('main')?.innerText ?? document.body.innerText
    const match = /(cannot reach[^\n]*|TRANSPORT[^\n]*|fetch failed[^\n]*|ECONNREFUSED[^\n]*)/i.exec(text)
    return match ? match[1].slice(0, 300) : null
  }), { timeoutMs: 30_000, intervalMs: 300 }).catch(() => null)
  await shot('04-absent-server')
  const promptKept = await page.evaluate(() => (document.querySelector('main')?.innerText ?? document.body.innerText).includes('CI availability offline check'))
  const failedRecord = invocations().slice(invBefore).find(record => record.ok === false)
  report.expect('a1.send-to-absent-server', errorSeen !== null && promptKept && failedRecord?.code === 'TRANSPORT' && mockRequests().length === before1, U,
    `${label('none')} upstream absent: explicit error "${errorSeen?.value ?? '(none)'}" after ${errorSeen?.ms ?? '?'} ms, prompt kept in the conversation=${promptKept}, host record ${failedRecord?.code ?? 'missing'}, upstream requests ${mockRequests().length - before1}`,
    { sentAt, error: errorSeen, failedRecord })
  const recovered = await waitIdle(page)
  report.add('a1.ui-returns-to-idle', recovered ? 'pass' : 'fail', U, `${label('none')} composer usable again after the failure: ${recovered}`)

  // a9.recovery-no-replay: service back; one explicit send = one upstream request; the failed prompt is not replayed.
  await proxy.setMode('up')
  await sleep(500)
  const before9 = mockRequests().length
  await send('CI availability recovered')
  const recoveredReply = await waitUntil('reply after recovery', async () => page.evaluate(() => ((document.querySelector('main')?.innerText ?? document.body.innerText).match(/Mock spoken reply/g) ?? []).length >= 2), { timeoutMs: 60_000, intervalMs: 500 }).catch(() => null)
  await sleep(1500)
  const after = mockRequests().slice(before9)
  const replayed = after.some(r => JSON.stringify(r.text ?? '').includes('offline check'))
  await shot('05-recovered')
  report.expect('a9.recovery-no-replay', recoveredReply !== null && after.length === 1 && !replayed, U, `${label('none')} after recovery: ${after.length} upstream request(s), failed prompt replayed=${replayed}, reply rendered=${recoveredReply !== null}`, { requests: after })

  // Capture-dependent cases: the microphone owner's fixture + adapter, never a CI-made microphone.
  for (const id of ['capture.a2-record-while-server-down', 'capture.a6-permission-delay-cancel', 'capture.mimo-record-stop-send-progressive', 'capture.duplex-abc-overlap-interrupt-cleanup']) {
    if (!args['capture-adapter']) report.add(id, 'skip', U, `NOT RUN: waiting for the microphone owner's fixed TTS fixtures + capture-source adapter (AUDIO_TEST_LAYERING_20260915.md); CI does not substitute its own microphone`)
  }

  // a12.no-lab-paths: installed plugin files, seed records and the used home.
  report.add('a12.no-lab-paths', ...labPathScan(home))

  // probe.permission-path (info only, last): what the real permission path does on this runner without any adapter.
  const permission = await app.evaluate(({ systemPreferences }) => ({ microphone: systemPreferences.getMediaAccessStatus('microphone') })).catch(error => ({ error: String(error) }))
  const gum = await page.evaluate(() => Promise.race([
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => { const label = stream.getAudioTracks()[0]?.label ?? ''; for (const track of stream.getTracks()) track.stop(); return { outcome: 'resolved', label } }, error => ({ outcome: 'rejected', name: error.name, message: String(error.message).slice(0, 200) })),
    new Promise(resolve => setTimeout(() => resolve({ outcome: 'pending after 4 s' }), 4000)),
  ])).catch(error => ({ outcome: 'evaluate failed', error: String(error).slice(0, 200) }))
  report.add('probe.permission-path', 'info', U, `hosted runner real permission path (no adapter): systemPreferences microphone=${permission.microphone ?? permission.error}; getUserMedia → ${gum.outcome}${gum.name ? ` ${gum.name}` : ''}${gum.label ? ` (${gum.label})` : ''}`, { permission, gum })
  await shot('06-final')
  await Promise.race([app.close(), sleep(60_000)])
}

async function dismissFirstRunDialogs(page) {
  for (const [text, button] of [['Internal Testing Notice', /^Continue$/], ['Add an API key to get started', /^Configure later$/]]) {
    const dialog = page.getByText(text)
    await dialog.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined)
    if (await dialog.count() > 0) {
      await page.getByRole('button', { name: button }).click({ timeout: 10_000 }).catch(() => undefined)
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)
      note(`dismissed first-run dialog: ${text}`)
    }
  }
}

async function openSession(page, sessionId) {
  // A new workspace session shows up in the sidebar tree; its group may start collapsed.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const opened = await page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId)
    if (opened) return
    const rows = page.locator('[role=treeitem]')
    const count = await rows.count()
    const titles = []
    for (let i = 0; i < count; i++) titles.push((await rows.nth(i).innerText().catch(() => '')).trim())
    const sessionIndex = titles.findLastIndex(t => /New Session|CI availability/i.test(t))
    if (sessionIndex >= 0) { await rows.nth(sessionIndex).click().catch(() => undefined) }
    else if (count > 0) { for (let i = 0; i < count; i++) if (/workspace/i.test(titles[i])) await rows.nth(i).click().catch(() => undefined) }
    await sleep(1000)
    if (await page.locator('main [role=textbox]').count() > 0 && sessionIndex >= 0) return
  }
  const dump = await page.evaluate(() => ({ treeitems: [...document.querySelectorAll('[role=treeitem]')].map(e => e.innerText.slice(0, 80)), text: document.body.innerText.slice(0, 1500) }))
  throw new Error(`could not open session ${sessionId} in the UI: ${JSON.stringify(dump).slice(0, 1500)}`)
}

async function waitIdle(page) {
  return waitUntil('conversation idle', async () => page.evaluate(() => {
    const box = [...document.querySelectorAll('[role=textbox]')].at(-1)
    const busy = /Stop generating|Generating|Running/i.test(document.querySelector('main')?.innerText ?? '')
    return box !== undefined && box.getAttribute('aria-disabled') !== 'true' && !busy
  }), { timeoutMs: 45_000, intervalMs: 500 }).then(() => true).catch(() => false)
}

async function stopDuringActiveBuffer(page, send) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await waitIdle(page)
    const startMark = Date.now()
    await send(`CI availability stop test ${attempt}`)
    // Wait until an output source is audibly scheduled right now and the reply bar offers Stop.
    const active = await waitUntil('active output buffer with Stop available', async () => page.evaluate((since) => {
      const now = Date.now()
      const playing = window.__CI_OBS__.sources.filter(s => s.createdAt >= since && s.expectedStartAt <= now && now < s.expectedEndAt - 150 && s.stoppedAt === null && s.endedAt === null)
      const stop = document.querySelector('[data-testid=dsh-voice-capture-reply-stop]')
      return playing.length > 0 && stop !== null ? { playing: playing.length, now } : null
    }, startMark), { timeoutMs: 60_000, intervalMs: 50 }).catch(() => null)
    if (active === null) continue
    const stopAt = Date.now()
    await page.locator('[data-testid=dsh-voice-capture-reply-stop]').first().click({ timeout: 5_000 })
    await sleep(3000)
    const facts = await page.evaluate(([since, stopAt]) => {
      const sources = window.__CI_OBS__.sources.filter(s => s.createdAt >= since)
      return {
        sources: sources.length,
        activeAtStop: sources.filter(s => s.expectedStartAt <= stopAt && stopAt < s.expectedEndAt && (s.endedAt === null || s.endedAt > stopAt)).map(s => ({ stoppedAt: s.stoppedAt, endedAt: s.endedAt, expectedEndAt: s.expectedEndAt })),
        startedAfterStop: sources.filter(s => s.expectedStartAt > stopAt + 100 && (s.stoppedAt === null || s.stoppedAt > s.expectedStartAt)).length,
        phase: document.querySelector('[data-testid=dsh-voice-capture-reply-bar]')?.dataset.phase ?? null,
      }
    }, [startMark, stopAt])
    const cutPromptly = facts.activeAtStop.length > 0 && facts.activeAtStop.every(s => (s.stoppedAt !== null && s.stoppedAt - stopAt < 500) || (s.endedAt !== null && s.endedAt - stopAt < 500))
    const ok = facts.activeAtStop.length > 0 && cutPromptly && facts.startedAfterStop === 0 && facts.phase !== 'playing'
    return { status: ok ? 'pass' : 'fail', summary: `Stop at an active output buffer (${facts.activeAtStop.length} sounding): cut within 500 ms=${cutPromptly}, sources started after Stop=${facts.startedAfterStop}, reply bar phase ${facts.phase}`, detail: { attempt, stopAt, ...facts } }
  }
  return { status: 'fail', summary: 'could not observe an actively sounding output buffer with Stop available (two attempts)', detail: {} }
}

function labPathScan(home) {
  const patterns = [
    ['builder-home', /\/Users\/(?!runner\/)[A-Za-z0-9_][A-Za-z0-9._-]+\//],
    ['tailnet-ip', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
    ['lab-host', /\bdgx-spark\b|\bSBPLab\b/],
    ['window-guard', /window-guard|OPEN_WINDOW|WINDOW_OPEN|\.window-open\b/],
  ]
  const roots = [
    ...plugins.map(p => join(home, 'profiles', profile, 'node_modules', p.name)),
    join(home, 'settings.yaml'),
  ]
  const hits = []
  let files = 0
  const scan = (path) => {
    const stat = statSync(path)
    if (stat.isDirectory()) { for (const entry of readdirSync(path)) if (entry !== 'node_modules') scan(join(path, entry)); return }
    if (stat.size > 8 * 1024 * 1024) return
    files++
    const text = readFileSync(path).toString('utf8')
    for (const [kind, pattern] of patterns) { const match = pattern.exec(text); if (match) hits.push({ file: relative(home, path), kind, match: match[0].slice(0, 60) }) }
  }
  for (const root of roots) if (existsSync(root)) scan(root)
  const windowFiles = []
  const walkNames = (dir, depth) => { if (depth > 5 || !existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'node_modules' || entry.name === 'store') continue; if (/^(OPEN|DONE|LEASE)(\.|$)|window/i.test(entry.name)) windowFiles.push(relative(home, join(dir, entry.name))); if (entry.isDirectory()) walkNames(join(dir, entry.name), depth + 1) } }
  walkNames(home, 0)
  const ok = hits.length === 0 && windowFiles.length === 0
  return [ok ? 'pass' : 'fail', U, `${label('none')} ${files} installed plugin/settings files and the used home: ${hits.length} lab identifiers, ${windowFiles.length} window/lease files`, { hits: hits.slice(0, 30), windowFiles: windowFiles.slice(0, 30) }]
}

