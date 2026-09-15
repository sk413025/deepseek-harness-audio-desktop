#!/usr/bin/env node
// Static verification of the published macOS dmg and the .app inside it (macOS only; nothing is launched here):
// digest binding, dmg checksum, layout, Info.plist identity, seed integrity (integrity.json), bundled plugin records vs
// releases/<tag>/PLUGINS.json and the release tarballs, app.asar / seed hashes vs MANIFEST.txt, Mach-O architectures,
// code signature state, Gatekeeper / notarization state vs the release's own claims, Electron fuses.
// Finally copies the app out of the read-only image for the launch smoke test.
//
// Usage: verify-desktop-artifact.mjs --tag <tag> --tag-src <dir> --assets <dir> --release-json <file> --work <dir>
//          --out <report.json> [--copy-app-to <dir>] [--plugins-json <override PLUGINS.json, negative controls only>]
import { existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { EVIDENCE, parseArgs, parseShaLines, Report, required, run, sha256, sha256File } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'tag', 'tag-src', 'assets', 'release-json', 'work', 'out')
for (const key of ['tag-src', 'assets', 'release-json', 'work', 'out', 'copy-app-to', 'plugins-json']) if (typeof args[key] === 'string') args[key] = resolve(args[key])
const expected = JSON.parse(readFileSync(new URL('../expected.json', import.meta.url), 'utf8'))
const { tag } = args
const report = new Report('verify-desktop-artifact', { tag, runner: runnerInfo() })
process.on('uncaughtException', (error) => {
  report.add('verifier.crashed', 'fail', EVIDENCE.packagedApp, String(error?.stack ?? error).slice(0, 1500))
  run('hdiutil', ['detach', '-force', join(args.work, 'mnt')])
  finish()
})
const A = EVIDENCE.artifact, P = EVIDENCE.packagedApp
const release = JSON.parse(readFileSync(args['release-json'], 'utf8'))
const relDir = join(args['tag-src'], 'releases', tag)
const plugins = JSON.parse(readFileSync(args['plugins-json'] ?? join(relDir, 'PLUGINS.json'), 'utf8')).plugins
const manifest = parseShaLines(readFileSync(join(relDir, 'MANIFEST.txt'), 'utf8'))

// 1. Which dmg, and are these the published bytes?
const dmgPattern = new RegExp(expected.dmg.namePattern)
const dmgAssets = release.assets.filter(asset => dmgPattern.test(asset.name))
report.expect('dmg.single-asset', dmgAssets.length === 1, A, `release has exactly one arm64 dmg (${dmgAssets.map(a => a.name).join(', ')})`)
if (dmgAssets.length !== 1) finish()
const dmgAsset = dmgAssets[0]
const nameParts = dmgPattern.exec(dmgAsset.name).groups
report.expect('dmg.name-tag', nameParts.tag === tag, A, `dmg file name carries tag ${nameParts.tag}`)
const dmgPath = join(args.assets, dmgAsset.name)
const dmgSha = await sha256File(dmgPath)
const apiDigest = dmgAsset.digest?.startsWith('sha256:') ? dmgAsset.digest.slice(7) : null
const sums = parseShaLines(readFileSync(join(args.assets, 'SHA256SUMS'), 'utf8'))
report.meta.dmg = { name: dmgAsset.name, bytes: dmgAsset.size, sha256: dmgSha, apiDigest, assetId: dmgAsset.id }
report.expect('dmg.digest', dmgSha === apiDigest, A, `downloaded dmg sha256 ${dmgSha.slice(0, 12)}… == GitHub API digest`)
report.expect('dmg.sha256sums', sums.entries.some(e => e.name === dmgAsset.name && e.sha256 === dmgSha), A, 'dmg sha256 == SHA256SUMS line')
const verify = run('hdiutil', ['verify', dmgPath])
report.expect('dmg.hdiutil-verify', verify.status === 0, A, 'hdiutil verify (image checksum) succeeds', { tail: (verify.stdout + verify.stderr).trim().split('\n').slice(-2) })

// 2. Mount read-only and inspect.
const mount = join(args.work, 'mnt')
mkdirSync(mount, { recursive: true })
const attach = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmgPath])
report.expect('dmg.attach-readonly', attach.status === 0, A, 'dmg attaches read-only', { stderr: attach.stderr.slice(-500) })
if (attach.status !== 0) finish()
try {
  const top = readdirSync(mount).filter(name => !name.startsWith('.'))
  const missingTop = expected.dmg.requiredTopLevel.filter(name => !top.includes(name))
  const namePattern = new RegExp(expected.app.bundleNamePattern ?? `^${expected.app.bundleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  const apps = top.filter(name => name.endsWith('.app'))
  const appName = apps.length === 1 && namePattern.test(apps[0].slice(0, -4)) ? apps[0].slice(0, -4) : null
  report.meta.appName = apps.length === 1 ? apps[0].slice(0, -4) : apps
  report.expect('dmg.layout', missingTop.length === 0 && appName !== null && lstatSync(join(mount, 'Applications')).isSymbolicLink(), P, `dmg root has exactly one app matching ${namePattern}, Applications link, guide, examples (${top.join(' | ')})`, { top, missingTop, apps })
  if (appName === null) { run('hdiutil', ['detach', mount]); finish() }
  const appDir = join(mount, `${appName}.app`)
  const contents = join(appDir, 'Contents')

  const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')]).stdout)
  report.meta.app = { bundleIdentifier: info.CFBundleIdentifier, shortVersion: info.CFBundleShortVersionString, minimumSystemVersion: info.LSMinimumSystemVersion, executable: info.CFBundleExecutable }
  report.expect('app.bundle-id', info.CFBundleIdentifier === expected.app.bundleIdentifier, P, `CFBundleIdentifier ${info.CFBundleIdentifier}`)
  report.expect('app.version', info.CFBundleShortVersionString === nameParts.shortVersion, P, `CFBundleShortVersionString ${info.CFBundleShortVersionString} == dmg name version ${nameParts.shortVersion}`)
  report.expect('app.mic-usage-text', typeof info.NSMicrophoneUsageDescription === 'string' && info.NSMicrophoneUsageDescription.length > 10, P, 'NSMicrophoneUsageDescription present (required before macOS shows the mic prompt)')
  const osVersion = run('sw_vers', ['-productVersion']).stdout.trim()
  report.add('app.minimum-os', compareVersions(osVersion, info.LSMinimumSystemVersion) >= 0 ? 'pass' : 'fail', P, `runner macOS ${osVersion} >= LSMinimumSystemVersion ${info.LSMinimumSystemVersion}`)

  // Seed: desktop-release.json, integrity.json, bundled plugin records, MANIFEST.txt app hashes.
  const seed = join(contents, 'Resources', 'seed')
  const releaseJson = JSON.parse(readFileSync(join(seed, 'desktop-release.json'), 'utf8'))
  report.meta.app.runtime = releaseJson
  report.expect('seed.release-version', releaseJson.version === info.CFBundleShortVersionString, P, `seed desktop-release.json version ${releaseJson.version}`)
  const integrity = JSON.parse(readFileSync(join(seed, 'integrity.json'), 'utf8'))
  const integrityBad = []
  for (const file of integrity.files) {
    const path = join(seed, file.path)
    if (!existsSync(path)) { integrityBad.push({ path: file.path, problem: 'missing' }); continue }
    const actual = await sha256File(path)
    if (actual !== file.sha256 || lstatSync(path).size !== file.bytes) integrityBad.push({ path: file.path, problem: 'hash/size', actual })
  }
  report.expect('seed.integrity', integrityBad.length === 0, P, `all ${integrity.files.length} seed files match seed/integrity.json`, { bad: integrityBad.slice(0, 20) })

  const bundled = JSON.parse(readFileSync(join(seed, 'desktop-bundled-plugins.json'), 'utf8')).plugins
  report.meta.bundledPlugins = bundled
  const pluginKey = p => `${p.name}@${p.version}#${p.sha256}`
  const expectedKeys = plugins.map(pluginKey).sort()
  const bundledKeys = bundled.map(pluginKey).sort()
  report.expect('seed.bundled-equals-release', JSON.stringify(expectedKeys) === JSON.stringify(bundledKeys), P, `seed bundles exactly releases/${tag}/PLUGINS.json (${bundled.length} plugins)`, { expected: expectedKeys, bundled: bundledKeys })
  for (const record of bundled) {
    const seedFile = join(seed, 'desktop-local-packages', record.file)
    const seedSha = existsSync(seedFile) ? await sha256File(seedFile) : null
    const releaseAsset = plugins.find(p => p.name === record.name)
    const assetFile = releaseAsset ? join(args.assets, releaseAsset.file) : undefined
    const assetSha = assetFile && existsSync(assetFile) ? await sha256File(assetFile) : null
    report.expect(`seed.plugin.${record.name}`, seedSha === record.sha256 && assetSha === record.sha256, P,
      `seed tarball ${record.file} == record == release asset ${releaseAsset?.file ?? '(none)'}`, { seedSha, assetSha, record: record.sha256 })
  }
  const seedManifest = JSON.parse(readFileSync(join(seed, 'package.json'), 'utf8'))
  const profileBundles = seedManifest.dsh?.profile?.bundles ?? []
  report.expect('seed.profile-bundles', bundled.every(p => profileBundles.includes(p.name) && String(seedManifest.dependencies?.[p.name]).endsWith(p.file)), P, 'seed package.json depends on and bundles every plugin file')

  for (const entry of manifest.entries.filter(e => e.name.startsWith('app/'))) {
    const inApp = entry.name.replace(/^app\/[^/]+\.app\//, '')
    const path = join(appDir, inApp)
    const actual = existsSync(path) ? await sha256File(path) : null
    report.expect(`manifest.app.${inApp}`, actual === entry.sha256, P, `${inApp} == MANIFEST.txt ${entry.sha256.slice(0, 12)}…`, { actual })
  }

  // Mach-O architectures.
  const machO = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && isMachO(path)) machO.push(path)
    }
  }
  walk(appDir)
  const foreign = []
  for (const path of machO) {
    const archs = run('lipo', ['-archs', path]).stdout.trim().split(/\s+/)
    if (!archs.includes(expected.app.architecture)) foreign.push({ path: relative(appDir, path), archs })
  }
  const unexplained = foreign.filter(f => !expected.machO.allowedNonArm64.some(a => new RegExp(a.pathPattern).test(f.path)))
  report.expect('app.arch', unexplained.length === 0, P, `${machO.length} Mach-O files contain arm64 (${foreign.length - unexplained.length} allow-listed non-arm64 optional prebuilds)`, { foreign, unexplained })
  const mainArchs = run('lipo', ['-archs', join(contents, 'MacOS', info.CFBundleExecutable)]).stdout.trim()
  report.expect('app.main-executable-arch', mainArchs.split(/\s+/).includes('arm64'), P, `main executable archs: ${mainArchs}`)

  // Signature, Gatekeeper, notarization — compared with what the release claims (ad-hoc, not notarized).
  const display = run('codesign', ['-dv', '--verbose=2', appDir]).stderr
  const signature = /Signature=adhoc/.test(display) ? 'adhoc' : (/Authority=([^\n]+)/.exec(display)?.[1] ?? 'unknown')
  report.meta.app.signature = signature
  report.meta.app.teamIdentifier = /TeamIdentifier=([^\n]+)/.exec(display)?.[1]
  const deep = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir])
  report.expect('app.codesign-valid', deep.status === 0, P, `codesign --verify --deep --strict (${signature}) succeeds`, { tail: deep.stderr.trim().split('\n').slice(-3) })
  report.expect('app.signature-kind', signature === expected.app.signing, P, `signature kind ${signature} matches the declared ${expected.app.signing} signing`)
  const assess = run('spctl', ['-a', '-vv', '-t', 'exec', appDir])
  const accepted = assess.status === 0
  report.add('app.gatekeeper-state', accepted === expected.app.notarized ? 'pass' : 'warn', P,
    `spctl assessment ${accepted ? 'accepted' : 'rejected'} (exit ${assess.status}); release declares notarized=${expected.app.notarized} — Gatekeeper acceptance is NOT verified by this CI`, { output: (assess.stdout + assess.stderr).trim() })
  const staple = run('xcrun', ['stapler', 'validate', appDir])
  report.add('app.notarization-ticket', (staple.status === 0) === expected.app.notarized ? 'pass' : 'warn', P, `stapler validate exit ${staple.status} (no ticket expected for this local build)`)
  report.add('app.quarantine-xattr', 'info', P, 'extended attributes of the mounted app (runner downloads are not quarantined, so Finder first-open is not exercised)', { xattr: run('xattr', ['-l', appDir]).stdout.trim().split('\n').slice(0, 5) })

  // Electron fuses (needed to know whether automation can attach, and as a hardening record).
  const fuses = run('npx', ['--no-install', 'electron-fuses', 'read', '--app', appDir], { cwd: new URL('..', import.meta.url).pathname })
  const fuseMap = Object.fromEntries([...fuses.stdout.matchAll(/^\s+(\w+) is (Enabled|Disabled)/gm)].map(m => [m[1], m[2]]))
  report.meta.app.fuses = fuseMap
  report.add('app.fuses', fuses.status === 0 && Object.keys(fuseMap).length > 0 ? 'info' : 'warn', P,
    `Electron fuses: RunAsNode=${fuseMap.RunAsNode} NodeCliInspect=${fuseMap.EnableNodeCliInspectArguments} AsarIntegrity=${fuseMap.EnableEmbeddedAsarIntegrityValidation} OnlyLoadAppFromAsar=${fuseMap.OnlyLoadAppFromAsar}`, { stderr: fuses.stderr.slice(-300) })

  if (args['copy-app-to']) {
    mkdirSync(args['copy-app-to'], { recursive: true })
    // Later workflow steps use one fixed path; the published name stays in report.meta.appName.
    const target = join(args['copy-app-to'], `${expected.app.bundleName}.app`)
    rmSync(target, { recursive: true, force: true })
    const copy = run('ditto', [appDir, target])
    const again = run('codesign', ['--verify', '--deep', '--strict', target])
    report.expect('app.copy', copy.status === 0 && again.status === 0, P, `app "${appName}" copied out of the image with a still-valid signature: ${target}`)
    report.meta.appCopy = target
  }
} finally {
  const detach = run('hdiutil', ['detach', mount])
  if (detach.status !== 0) run('hdiutil', ['detach', '-force', mount])
}
finish()

function isMachO(path) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    if (readSync(fd, buffer, 0, 4, 0) < 4) return false
    const magic = buffer.readUInt32BE(0)
    return [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(magic)
      && !(magic === 0xcafebabe && path.endsWith('.class'))
  } finally { closeSync(fd) }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

function runnerInfo() {
  return {
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runnerName: process.env.RUNNER_NAME, runnerArch: process.env.RUNNER_ARCH,
    macOS: run('sw_vers', ['-productVersion']).stdout.trim(), build: run('sw_vers', ['-buildVersion']).stdout.trim(), machine: run('uname', ['-m']).stdout.trim(),
    hardware: run('sysctl', ['-n', 'machdep.cpu.brand_string']).stdout.trim(),
  }
}

function finish() {
  const document = report.write(args.out)
  console.log(`\n${document.report}: ${document.verdict.toUpperCase()} ${JSON.stringify(document.counts)}`)
  process.exit(document.verdict === 'pass' ? 0 : 1)
}
