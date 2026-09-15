#!/usr/bin/env node
// Launch the PUBLISHED packaged app (copied out of the release dmg) on a macOS runner with an isolated DSH_HOME and
// user-data directory, and check what a recipient's first start does:
//
//   --phase launch     plain executable + --remote-debugging-port (no test framework inside the app):
//                      offline seed install, window boot graph, the client bundles the app serves == released
//                      lib/client.js bytes, host routes of the bundled plugins answer with the released versions and
//                      product defaults, installed package files == release tarballs, clean quit, relaunch.
//   --phase lifecycle  Playwright (experimental Electron support) drives the real Plugins window:
//                      list, Install from File (only the native OS open-panel is stubbed in the main process),
//                      rejected bad packages, Remove, bundled Disable/Enable, main window boot graph follows.
//
// No model server, microphone, speaker or network service is used. Nothing here is DGX, real-microphone or
// audio-quality evidence. Usage:
//   desktop-smoke.mjs --phase launch|lifecycle --app <.app> --tag <tag> --tag-src <dir> --assets <dir> --out-dir <dir>
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { attachPage, freePort, sleep, targets, waitUntil } from '../lib/cdp.mjs'
import { EVIDENCE, parseArgs, readTarball, Report, required, run, sha256 } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'phase', 'app', 'tag', 'tag-src', 'assets', 'out-dir')
for (const key of ['app', 'tag-src', 'assets', 'out-dir']) args[key] = resolve(args[key])
const expected = JSON.parse(readFileSync(new URL('../expected.json', import.meta.url), 'utf8'))
const outDir = join(args['out-dir'], args.phase)
const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), `dsh-smoke-work-${args.phase}`) // large (pnpm store): never uploaded
mkdirSync(outDir, { recursive: true })
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
const plugins = JSON.parse(readFileSync(join(args['tag-src'], 'releases', args.tag, 'PLUGINS.json'), 'utf8')).plugins
const tarballs = new Map(plugins.map(p => [p.name, readTarball(join(args.assets, p.file))]))
const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(args.app, 'Contents', 'Info.plist')]).stdout)
const executable = join(args.app, 'Contents', 'MacOS', info.CFBundleExecutable)
const profile = expected.app.desktopProfile
const timeline = join(outDir, 'timeline.log')
const note = (text) => { const line = `${new Date().toISOString()} ${text}`; console.log(line); appendFileSync(timeline, line + '\n') }
const report = new Report(`desktop-smoke-${args.phase}`, {
  tag: args.tag, app: args.app, bundleIdentifier: info.CFBundleIdentifier, shortVersion: info.CFBundleShortVersionString,
  plugins: plugins.map(p => ({ name: p.name, version: p.version, sha256: p.sha256 })),
  runner: { imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, macOS: run('sw_vers', ['-productVersion']).stdout.trim(), machine: run('uname', ['-m']).stdout.trim() },
  notCovered: ['real DGX / vLLM-Omni model server', 'physical USB microphone capture', 'speaker playback and audio quality', 'Finder double-click with quarantine / Gatekeeper first open', 'notarization', 'second physical Mac'],
})
const L = EVIDENCE.hostedLaunch, U = EVIDENCE.hostedUi

const cleanups = []
process.on('uncaughtException', async (error) => { report.add('smoke.uncaught', 'fail', L, String(error?.stack ?? error).slice(0, 2000)); await finish() })
try {
  if (args.phase === 'launch') await launchPhase()
  else if (args.phase === 'lifecycle') await lifecyclePhase()
  else throw new Error(`unknown phase ${args.phase}`)
} catch (error) {
  report.add(`${args.phase}.aborted`, 'fail', args.phase === 'launch' ? L : U, String(error?.message ?? error).slice(0, 1500), { last: error?.last, stack: String(error?.stack ?? '').slice(0, 2000) })
}
await finish()

// ---------------------------------------------------------------------------------------------------------------------

function newInstance(name) {
  const home = join(workDir, `${name}-home`)
  const userData = join(workDir, `${name}-userdata`)
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  const diagnostic = join(outDir, `${name}-startup-diagnostic.txt`)
  // A recipient starts the app from Finder (launchd environment), not from a CI shell. Runner variables leak into the
  // bundled pnpm otherwise: run 34927273171 showed CI=true switching pnpm to --frozen-lockfile (lifecycle.remove-local).
  const env = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', '__CF_USER_TEXT_ENCODING', 'XPC_FLAGS', 'XPC_SERVICE_NAME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', DSH_HOME: home, DSH_DESKTOP_DIAGNOSTIC_FILE: diagnostic, DSH_TELEMETRY_DISABLED: '1' })
  report.meta.appEnvironmentKeys = Object.keys(env).sort()
  return { name, home, userData, diagnostic, env }
}

async function launchPhase() {
  const first = newInstance('first-launch')
  const port = await freePort()
  let child = startApp(first, port)
  const boot = await waitForBoot(first, child, port, 'first-launch')
  await checkRunningApp(first, port, boot)
  const manifestBefore = readFileSync(join(first.home, 'profiles', profile, 'package.json'))
  await quit(child, first, 'first-launch')

  // Relaunch the same home: must boot without re-seeding and keep the installed package graph.
  const port2 = await freePort()
  child = startApp(first, port2, 'relaunch')
  const boot2 = await waitForBoot(first, child, port2, 'relaunch')
  const manifestAfter = readFileSync(join(first.home, 'profiles', profile, 'package.json'))
  report.expect('relaunch.profile-unchanged', sha256(manifestBefore) === sha256(manifestAfter), L, `relaunch booted in ${boot2.ms} ms with an unchanged profiles/${profile}/package.json`)
  const page = await attachPage(port2, url => url.startsWith('dsh-app://app/'))
  try {
    const ids = (await page.evaluate('(window.__DSH_BOOT__?.entries ?? []).map(e => e.id)')) ?? []
    report.expect('relaunch.client-plugins', expected.hostedSmoke.clientPlugins.every(id => ids.includes(id)), L, 'relaunch still loads every bundled client plugin', { ids })
    await page.screenshot(join(outDir, 'relaunch-main-window.png'))
  } finally { page.close() }
  await quit(child, first, 'relaunch')
}

function startApp(instance, port, label = instance.name) {
  const stdout = createWriteStream(join(outDir, `${label}-stdout.log`))
  const stderr = createWriteStream(join(outDir, `${label}-stderr.log`))
  note(`start ${label}: ${executable} port ${port}`)
  const child = spawn(executable, [`--user-data-dir=${instance.userData}`, `--remote-debugging-port=${port}`], { env: instance.env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  child.startedAt = Date.now()
  child.exited = null
  child.on('exit', (code, signal) => { child.exited = { code, signal, afterMs: Date.now() - child.startedAt }; note(`${label} exited code=${code} signal=${signal}`) })
  cleanups.push(() => { if (child.exited === null) child.kill('SIGKILL') })
  return child
}

async function waitForBoot(instance, child, port, label) {
  try {
    const page = await waitUntil(`${label} app window target`, async () => {
      if (child.exited) throw Object.assign(new Error(`app exited early ${JSON.stringify(child.exited)}`), { fatal: true })
      return ((await targets(port)) ?? []).find(t => t.type === 'page' && t.url.startsWith('dsh-app://app/'))
    }, { timeoutMs: 420_000, intervalMs: 1000 })
    report.add(`${label}.window`, 'pass', L, `main window target ${page.value.url} after ${page.ms} ms`)
    const boot = await waitUntil(`${label} boot graph`, async () => {
      if (child.exited) throw new Error(`app exited ${JSON.stringify(child.exited)}`)
      const cdp = await attachPage(port, url => url.startsWith('dsh-app://app/'))
      try { return await cdp.evaluate('(() => { const b = window.__DSH_BOOT__; return b && Array.isArray(b.entries) && b.entries.length > 0 ? b.entries.map(e => ({ id: e.id, url: e.url, rev: e.rev })) : null })()') } finally { cdp.close() }
    }, { timeoutMs: 240_000, intervalMs: 2000 })
    report.add(`${label}.boot`, 'pass', L, `window.__DSH_BOOT__ has ${boot.value.length} client entries after ${boot.ms} ms more`)
    return { entries: boot.value, ms: page.ms + boot.ms }
  } catch (error) {
    const diagnostic = existsSync(instance.diagnostic) ? readFileSync(instance.diagnostic, 'utf8').slice(0, 4000) : null
    report.add(`${label}.boot`, 'fail', L, String(error.message), { last: error.last, exited: child.exited, diagnostic, stderrTail: tail(join(outDir, `${label}-stderr.log`)), targets: await targets(port) })
    await osScreenshot(`${label}-boot-failure`)
    throw error
  }
}

async function checkRunningApp(instance, port, boot) {
  const ids = boot.entries.map(e => e.id)
  report.meta.bootEntries = boot.entries
  const page = await attachPage(port, url => url.startsWith('dsh-app://app/'))
  try {
    // Client bundles served by the running app == lib/client.js bytes in the release tarballs.
    for (const name of expected.hostedSmoke.clientPlugins) {
      const entry = boot.entries.find(e => e.id === name)
      if (entry === undefined) { report.add(`app.client.${name}`, 'fail', L, `boot graph has no entry for ${name}`, { ids }); continue }
      const served = await page.evaluate(`(async () => { const r = await fetch(${JSON.stringify(entry.url)}); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return { status: r.status, type: r.headers.get('content-type'), base64: btoa(s) } })()`)
      const bytes = Buffer.from(served.base64, 'base64')
      const released = tarballs.get(name)?.files.get('lib/client.js')
      // The host rewrites the trailing `//# sourceMappingURL=` comment to its own versioned URL (run 34927273171:
      // served bundles were 55/61/59 B longer). Compare the code with that single comment line removed on both sides,
      // and record exactly where the bytes differ so any other rewrite stays visible.
      const stripMap = (buffer) => buffer.toString('utf8').replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, '')
      const exact = released !== undefined && sha256(bytes) === sha256(released)
      const codeEqual = released !== undefined && stripMap(bytes) === stripMap(released)
      const firstDiff = released === undefined ? -1 : (() => { const n = Math.min(bytes.length, released.length); for (let i = 0; i < n; i++) if (bytes[i] !== released[i]) return i; return n })()
      report.add(`app.client.${name}`, exact || codeEqual ? 'pass' : 'fail', L,
        exact ? `served ${entry.url} == released lib/client.js (${released.length} B)` : codeEqual ? `served bundle == released lib/client.js except the host-rewritten sourceMappingURL comment (code sha ${sha256(stripMap(released)).slice(0, 12)}…)` : 'served client bundle code differs from the released lib/client.js',
        { status: served.status, contentType: served.type, servedBytes: bytes.length, releasedBytes: released?.length ?? null, servedSha256: sha256(bytes), releasedSha256: released ? sha256(released) : null,
          firstDiffOffset: firstDiff, servedTail: bytes.subarray(Math.max(0, firstDiff - 40)).toString('utf8').slice(0, 200), releasedTail: released ? released.subarray(Math.max(0, firstDiff - 40)).toString('utf8').slice(0, 200) : null })
    }
    // Host routes of bundled plugins.
    for (const route of expected.hostedSmoke.hostRoutes) {
      const response = await page.evaluate(`(async () => { const r = await fetch(${JSON.stringify(route.path)}); return { status: r.status, text: (await r.text()).slice(0, 20000) } })()`)
      let body
      try { body = JSON.parse(response.text) } catch { body = undefined }
      const plugin = plugins.find(p => p.name === route.plugin)
      if (route.plugin === 'dsh-dgx-audio') {
        const ok = response.status === 200 && body?.plugin?.name === plugin.name && body?.plugin?.version === plugin.version
        report.expect(`app.route.${route.plugin}`, ok, L, `GET ${route.path} -> ${response.status}, plugin ${body?.plugin?.name}@${body?.plugin?.version} (release ${plugin.version})`, { body })
        report.expect('app.product-defaults', ok && body.testFaults === undefined && body.configured === false, L, 'fresh install: no audio server configured and no test fault hooks active (product defaults)', { configured: body?.configured, testFaults: body?.testFaults })
      } else {
        report.expect(`app.route.${route.plugin}`, response.status === 200 && body?.ok === true, L, `GET ${route.path} -> ${response.status} ok=${body?.ok}`, { body: body ?? response.text.slice(0, 500) })
      }
    }
    await sleep(1500)
    await page.screenshot(join(outDir, 'first-launch-main-window.png'))
    const surface = await page.evaluate(`({ title: document.title, text: document.body.innerText.slice(0, 1500), mic: !!document.querySelector('[data-testid=dsh-voice-capture-mic]') })`)
    report.add('app.surface', 'info', L, `document "${surface.title}", composer mic control rendered on start page: ${surface.mic}`, surface)
    report.add('app.console', page.events.length === 0 ? 'info' : 'warn', L, `${page.events.length} console errors/warnings/exceptions observed after attach`, { events: page.events.slice(0, 50) })
  } finally { page.close() }

  // Installed files on disk == release tarballs (offline seed install used the published bytes).
  const projectDir = join(instance.home, 'profiles', profile)
  const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
  report.meta.installedProfile = { dependencies: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([n]) => plugins.some(p => p.name === n))), bundles: manifest.dsh?.profile?.bundles }
  for (const plugin of plugins) {
    const installedDir = join(projectDir, 'node_modules', plugin.name)
    const spec = manifest.dependencies?.[plugin.name]
    const tarball = tarballs.get(plugin.name)
    const mismatched = []
    for (const [path, bytes] of tarball.files) {
      const file = join(installedDir, path)
      if (!existsSync(file) || sha256(readFileSync(file)) !== sha256(bytes)) mismatched.push(path)
    }
    report.expect(`install.${plugin.name}`, mismatched.length === 0 && typeof spec === 'string' && spec.includes(plugin.sha256.slice(0, 12)) && (manifest.dsh?.profile?.bundles ?? []).includes(plugin.name), L,
      `profiles/${profile}: ${plugin.name} installed from ${spec} with all ${tarball.files.size} files == release tarball`, { mismatched: mismatched.slice(0, 20) })
  }
  report.add('install.home-layout', 'info', L, 'isolated DSH_HOME layout after first launch', { tree: listTree(instance.home, 3) })
  await osScreenshot('first-launch-os-screen')
}

async function quit(child, instance, label) {
  const started = Date.now()
  child.kill('SIGTERM')
  for (let i = 0; i < 60 && child.exited === null; i++) await sleep(500)
  if (child.exited === null) { child.kill('SIGKILL'); await sleep(1000) }
  await sleep(2000)
  const leftovers = run('pgrep', ['-fl', instance.home]).stdout.trim()
  report.add(`${label}.quit`, child.exited?.signal === 'SIGKILL' ? 'warn' : 'pass', L, `app exited ${JSON.stringify(child.exited)} ${Date.now() - started} ms after SIGTERM; leftover processes using this home: ${leftovers === '' ? 'none' : leftovers.split('\n').length}`, { leftovers })
  if (leftovers !== '') run('pkill', ['-9', '-f', instance.home])
}

// ---------------------------------------------------------------------------------------------------------------------

async function lifecyclePhase() {
  const { _electron } = await import('playwright-core')
  const instance = newInstance('lifecycle')
  note('launching with playwright-core _electron')
  const app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${instance.userData}`], env: instance.env, timeout: 420_000 })
  cleanups.push(async () => { try { app.process().kill('SIGKILL') } catch { /* gone */ } })
  const proc = app.process()
  proc.stdout?.pipe(createWriteStream(join(outDir, 'lifecycle-stdout.log')))
  proc.stderr?.pipe(createWriteStream(join(outDir, 'lifecycle-stderr.log')))
  report.add('lifecycle.launch', 'pass', U, `playwright attached to the packaged app (pid ${proc.pid})`)

  // The main window's page can be replaced while the Desktop backend restarts (run 34927273171: Page.reload on a stale
  // handle after Enable). Always look the window up again and wait for its boot graph.
  const findMain = () => app.windows().find(w => !w.isClosed() && w.url().startsWith('dsh-app://app/'))
  const bootedMain = async (reload) => {
    if (reload) { try { await findMain()?.reload({ timeout: 60_000 }) } catch (error) { note(`main window reload: ${error.message.split('\n')[0]}; looking the window up again`) } }
    const found = await waitUntil('booted main window', async () => {
      const page = findMain()
      if (page === undefined) return undefined
      return (await page.evaluate(() => Array.isArray(window.__DSH_BOOT__?.entries) && window.__DSH_BOOT__.entries.length > 0).catch(() => false)) ? page : undefined
    }, { timeoutMs: 300_000, intervalMs: 1000 })
    return found
  }
  const bootIds = async (page) => page.evaluate(() => window.__DSH_BOOT__.entries.map(e => e.id))
  const main = await bootedMain(false)
  const initialIds = await bootIds(main.value)
  report.expect('lifecycle.boot', expected.hostedSmoke.clientPlugins.every(id => initialIds.includes(id)), U, `main window booted after ${main.ms} ms with every bundled client plugin`, { ids: initialIds })

  // Basic UI tour of the main window (exploratory: a missing element is a warning until selectors are confirmed).
  await (async () => {
    const page = main.value
    const shot = name => page.screenshot({ path: join(outDir, `ui-${name}.png`) }).catch(() => undefined)
    const clickText = async (pattern) => {
      const target = page.getByRole('button', { name: pattern }).or(page.getByText(pattern, { exact: false })).first()
      if (await target.count() === 0) return false
      await target.click({ timeout: 10_000 })
      return true
    }
    try {
      await shot('start')
      const notice = await page.getByText('Internal Testing Notice').count()
      if (notice > 0) {
        const dismissed = await clickText(/^Continue$/)
        await page.getByText('Internal Testing Notice').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)
        report.add('ui.first-run-notice', dismissed && await page.getByText('Internal Testing Notice').count() === 0 ? 'pass' : 'warn', U, 'first-run "Internal Testing Notice" dismissed with Continue')
      } else report.add('ui.first-run-notice', 'info', U, 'no first-run notice shown')
      await shot('after-notice')
      const composer = { audioModeChip: await page.locator('[data-testid=dsh-audio-mode-chip]').count(), mic: await page.locator('[data-testid=dsh-voice-capture-mic]').count() }
      report.add('ui.start-composer', composer.audioModeChip > 0 ? 'pass' : 'warn', U, `start page composer: release-kit audio mode chip ${composer.audioModeChip}, voice-capture mic ${composer.mic}`, composer)
      if (await clickText(/^Audio models$/)) {
        await sleep(2000)
        await shot('audio-models')
        report.add('ui.audio-models', 'pass', U, 'sidebar "Audio models" (dsh-audio-model-library) opened', { text: (await page.locator('main').first().innerText().catch(() => '')).slice(0, 600) })
      } else report.add('ui.audio-models', 'warn', U, 'sidebar "Audio models" entry not found')
      if (await clickText(/^Settings$/)) {
        await sleep(2000)
        await clickText(/^Plugins$/).catch(() => false)
        await sleep(1500)
        const card = await page.locator('[data-testid=dsh-audio-servers-card]').count()
        await shot('settings')
        report.add('ui.settings-audio-servers', card > 0 ? 'pass' : 'warn', U, `Settings: release-kit "Audio servers" card rendered ${card}`, { empty: await page.locator('[data-testid=dsh-audio-servers-empty]').count() })
      } else report.add('ui.settings-audio-servers', 'warn', U, 'sidebar "Settings" entry not found')
    } catch (error) {
      report.add('ui.tour', 'warn', U, `UI tour stopped: ${String(error?.message ?? error).split('\n')[0]}`)
      await shot('tour-error')
    }
  })()

  // Open Plugins… through the application menu item (what the menu bar / Cmd+, triggers).
  const clicked = await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) for (const item of top.submenu?.items ?? []) {
      if (item.accelerator === 'CmdOrCtrl+,') { item.click(); return { label: item.label, enabled: item.enabled } }
    }
    return null
  })
  report.expect('lifecycle.menu', clicked !== null && clicked.enabled, U, `application menu item "${clicked?.label}" (CmdOrCtrl+,) clicked`)
  const pm = (await waitUntil('plugin manager window', async () => app.windows().find(w => w.url().includes('plugin-manager.html')), { timeoutMs: 30_000, intervalMs: 500 })).value
  const idle = () => pm.waitForFunction(() => !document.querySelector('#install-file')?.disabled && document.querySelectorAll('#plugins li').length > 0, null, { timeout: 420_000 })
  await idle()
  const list = () => pm.evaluate(() => window.dshDesktop.plugins.list())
  const rows = () => pm.evaluate(() => [...document.querySelectorAll('#plugins li')].map(li => ({ name: li.querySelector('.package-name')?.textContent, version: li.querySelector('.package-version')?.textContent, source: li.querySelector('.package-source')?.textContent, buttons: [...li.querySelectorAll('button')].map(b => b.textContent) })))
  const initial = await list()
  report.meta.pluginListInitial = initial
  for (const plugin of plugins) {
    const item = initial.find(p => p.name === plugin.name)
    report.expect(`lifecycle.list.${plugin.name}`, item?.version === plugin.version && item?.source === 'bundled' && item?.state !== 'disabled', U, `Plugins window lists ${plugin.name} ${item?.version} source=${item?.source} state=${item?.state ?? 'active'}`)
  }
  const initialRows = await rows()
  report.expect('lifecycle.rows', plugins.every(p => initialRows.some(r => r.name === p.name && r.version === p.version)), U, `${initialRows.length} rows rendered in the Plugins window`, { rows: initialRows })
  await pm.screenshot({ path: join(outDir, 'plugins-window-initial.png') })

  // Probe packages built on the runner (never shipped): valid, not-a-plugin, corrupt.
  const probes = makeProbePackages()
  const stubDialog = (file) => app.evaluate(({ dialog }, path) => {
    globalThis.__ciDialogCalls = (globalThis.__ciDialogCalls ?? 0)
    dialog.showOpenDialog = async () => { globalThis.__ciDialogCalls++; return { canceled: false, filePaths: [path] } }
  }, file)
  const installFromFile = async (file, label) => {
    await stubDialog(file)
    const callsBefore = await app.evaluate(() => globalThis.__ciDialogCalls)
    const started = Date.now()
    await pm.click('#install-file')
    await pm.waitForFunction(() => document.querySelector('#install-file')?.disabled === true, null, { timeout: 5_000 }).catch(() => undefined)
    await idle()
    const status = await pm.textContent('#status')
    const calls = await app.evaluate(() => globalThis.__ciDialogCalls)
    await pm.screenshot({ path: join(outDir, `plugins-window-${label}.png`) })
    return { status, ms: Date.now() - started, dialogCalls: calls - callsBefore }
  }

  const good = await installFromFile(probes.good.path, 'install-probe')
  const afterGood = await list()
  const probeItem = afterGood.find(p => p.name === probes.good.name)
  const localFile = join(instance.home, 'profiles', profile, 'desktop-local-packages')
  const copied = existsSync(localFile) ? readdirSync(localFile).filter(f => f.startsWith(probes.good.name)) : []
  report.expect('lifecycle.install-from-file', good.dialogCalls === 1 && probeItem?.version === probes.good.version && probeItem?.source === 'local', U,
    `Install from File added ${probes.good.name}@${probeItem?.version} source=${probeItem?.source} in ${good.ms} ms (status "${good.status}")`, { ...good, copied, bundledStillListed: plugins.every(p => afterGood.some(i => i.name === p.name)) })
  report.expect('lifecycle.install-keeps-bundled', plugins.every(p => afterGood.some(i => i.name === p.name && i.version === p.version && i.state !== 'disabled')), U, 'bundled plugins unchanged after installing a local package')
  report.expect('lifecycle.install-copied-sha', copied.some(f => f.includes(probes.good.sha256.slice(0, 12))), U, `package file copied into desktop-local-packages as ${copied.join(', ')}`)

  const notPlugin = await installFromFile(probes.notPlugin.path, 'reject-not-plugin')
  const afterNotPlugin = await list()
  report.expect('lifecycle.reject-not-plugin', /dsh\.bundle\.patch|not a Harness plugin/i.test(notPlugin.status ?? '') && !afterNotPlugin.some(p => p.name === probes.notPlugin.name), U, `package without dsh.bundle.patch rejected: "${notPlugin.status}"`, notPlugin)
  const corrupt = await installFromFile(probes.corrupt.path, 'reject-corrupt')
  const afterCorrupt = await list()
  report.expect('lifecycle.reject-corrupt', /not an npm package tarball|unreadable|not a plugin package/i.test(corrupt.status ?? '') && afterCorrupt.length === afterGood.length, U, `corrupt .tgz rejected: "${corrupt.status}"`, corrupt)

  const clickRowButton = async (name) => {
    const row = pm.locator('#plugins li', { has: pm.locator('.package-name', { hasText: new RegExp(`^${name.replace(/[-.]/g, '\\$&')}$`) }) })
    const label = await row.locator('button').last().textContent()
    const started = Date.now()
    await row.locator('button').last().click()
    await pm.waitForFunction(() => document.querySelector('#install-file')?.disabled === true, null, { timeout: 5_000 }).catch(() => undefined)
    await idle()
    return { label, ms: Date.now() - started, status: await pm.textContent('#status') }
  }
  const stage = async (id, fn) => {
    try { await fn() } catch (error) { report.add(id, 'fail', U, `stage threw: ${String(error?.message ?? error).split('\n')[0]}`, { stack: String(error?.stack ?? '').slice(0, 1500) }) }
  }
  await stage('lifecycle.remove-local', async () => {
    const removed = await clickRowButton(probes.good.name)
    const afterRemove = await list()
    const copiedAfter = existsSync(localFile) ? readdirSync(localFile).filter(f => f.startsWith(probes.good.name)) : []
    report.expect('lifecycle.remove-local', !afterRemove.some(p => p.name === probes.good.name) && plugins.every(p => afterRemove.some(i => i.name === p.name)), U, `"${removed.label}" removed ${probes.good.name} in ${removed.ms} ms (status "${removed.status}")`, { ...removed, copiedAfter })
    await pm.screenshot({ path: join(outDir, 'plugins-window-removed.png') })
  })

  const target = 'dsh-audio-release-kit'
  await stage('lifecycle.disable-bundled', async () => {
    const disabled = await clickRowButton(target)
    const afterDisable = await list()
    await pm.screenshot({ path: join(outDir, 'plugins-window-bundled-disabled.png') })
    const idsDisabled = await bootIds((await bootedMain(true)).value)
    report.expect('lifecycle.disable-bundled', afterDisable.find(p => p.name === target)?.state === 'disabled' && !idsDisabled.includes(target), U, `"${disabled.label}" disabled bundled ${target}; main window boot graph no longer loads it`, { ...disabled, state: afterDisable.find(p => p.name === target), idsDisabled })
  })
  await stage('lifecycle.enable-bundled', async () => {
    const enabled = await clickRowButton(target)
    const afterEnable = await list()
    const idsEnabled = await bootIds((await bootedMain(true)).value)
    report.expect('lifecycle.enable-bundled', afterEnable.find(p => p.name === target)?.state !== 'disabled' && idsEnabled.includes(target), U, `"${enabled.label}" re-enabled ${target}; main window boot graph loads it again`, { ...enabled, state: afterEnable.find(p => p.name === target), idsEnabled })
    await pm.screenshot({ path: join(outDir, 'plugins-window-final.png') })
  })
  await stage('lifecycle.final-screens', async () => {
    await findMain()?.screenshot({ path: join(outDir, 'lifecycle-main-window-final.png') })
    await osScreenshot('lifecycle-os-screen')
  })

  const closeStarted = Date.now()
  await Promise.race([app.close(), sleep(60_000).then(() => { throw new Error('app.close() did not finish in 60 s') })])
  report.add('lifecycle.quit', 'pass', U, `app closed in ${Date.now() - closeStarted} ms`)
}

function makeProbePackages() {
  const root = join(workDir, 'probe-packages')
  const make = (label, manifest, extra = {}) => {
    const dir = join(root, label, 'package')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
    for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text)
    const path = join(root, `${manifest.name}-${manifest.version}.tgz`)
    const packed = run('tar', ['-czf', path, '-C', join(root, label), 'package'])
    if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`)
    return { name: manifest.name, version: manifest.version, path, sha256: sha256(readFileSync(path)) }
  }
  const good = make('good', { name: 'dsh-ci-probe-plugin', version: '0.0.1', description: 'CI probe package (never shipped)', private: true, license: 'MIT', dsh: { bundle: { patch: './cordis.patch.yml' } } }, { 'cordis.patch.yml': '[]\n' })
  const notPlugin = make('not-plugin', { name: 'dsh-ci-not-a-plugin', version: '0.0.1', private: true, license: 'MIT' })
  const corrupt = join(root, 'dsh-ci-corrupt-0.0.1.tgz')
  writeFileSync(corrupt, Buffer.from('this is not a gzip tarball\n'.repeat(20)))
  return { good, notPlugin, corrupt: { path: corrupt } }
}

async function osScreenshot(name) {
  const path = join(outDir, `${name}.png`)
  const shot = run('screencapture', ['-x', path])
  report.add(`os-screenshot.${name}`, 'info', args.phase === 'launch' ? L : U, `screencapture exit ${shot.status}${existsSync(path) ? ` (${statSync(path).size} B)` : ''}; shows what the OS session displays (TCC may blank other apps' windows)`)
}

function tail(path, bytes = 3000) {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return text.slice(-bytes)
}

function listTree(root, depth) {
  const out = []
  const visit = (dir, level) => {
    if (level > depth || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'store', '.pnpm'].includes(entry.name)) { out.push(`${relative(root, join(dir, entry.name))}/ (skipped)`); continue }
      out.push(relative(root, join(dir, entry.name)) + (entry.isDirectory() ? '/' : ''))
      if (entry.isDirectory()) visit(join(dir, entry.name), level + 1)
      if (out.length > 300) return
    }
  }
  visit(root, 1)
  return out
}

async function finish() {
  for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch { /* best effort */ } }
  const document = report.write(join(outDir, 'report.json'))
  console.log(`\n${document.report}: ${document.verdict.toUpperCase()} ${JSON.stringify(document.counts)}`)
  process.exit(document.verdict === 'pass' ? 0 : 1)
}
