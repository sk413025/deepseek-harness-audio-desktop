#!/usr/bin/env node
// Bind a GitHub Release to the git tree of its tag, without trusting either side:
//   release assets  <->  SHA256SUMS  <->  GitHub asset digests
//   plugin tarballs <->  releases/<tag>/MANIFEST.txt + PLUGINS.json
//   plugin tarballs <->  plugins/<name>/ files in the tag tree (byte-for-byte, and `npm pack` payload reproduction)
//   patches         <->  MANIFEST.txt hashes, UPSTREAM.md commit
// plus a privacy scan of shipped text. Runs on any OS (Node >= 22, npm, tar). Does not look inside the dmg.
//
// Usage: verify-release-sources.mjs --tag <tag> --tag-src <checkout of the tag> --assets <downloaded assets dir>
//          --release-json <gh api releases/tags/<tag> output> --out <report.json> [--skip-repack]
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { EVIDENCE, parseArgs, parseShaLines, readTarball, Report, required, run, sha256, sha256File } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'tag', 'tag-src', 'assets', 'release-json', 'out')
const expected = JSON.parse(readFileSync(new URL('../expected.json', import.meta.url), 'utf8'))
const { tag } = args
const src = args['tag-src']
const assets = args.assets
const report = new Report('verify-release-sources', { tag, tagSrc: src })
process.on('uncaughtException', (error) => { report.add('verifier.crashed', 'fail', EVIDENCE.source, String(error?.stack ?? error).slice(0, 1500)); finish() })
const S = EVIDENCE.source, A = EVIDENCE.artifact

const release = JSON.parse(readFileSync(args['release-json'], 'utf8'))
report.meta.release = { id: release.id, tag: release.tag_name, name: release.name, prerelease: release.prerelease, draft: release.draft, publishedAt: release.published_at }
report.expect('release.tag', release.tag_name === tag, A, `release JSON is for tag ${tag}`, { releaseTag: release.tag_name })
report.add('release.prerelease-flag', release.prerelease ? 'info' : 'warn', A, release.prerelease ? 'GitHub marks this release as a prerelease' : 'release is NOT marked prerelease; check STATUS.md claims')

// 1. Every asset: downloaded bytes == GitHub API digest == SHA256SUMS line.
const sumsPath = join(assets, 'SHA256SUMS')
const sums = existsSync(sumsPath) ? parseShaLines(readFileSync(sumsPath, 'utf8')) : { entries: [], other: [] }
report.expect('assets.sha256sums-present', existsSync(sumsPath), A, 'SHA256SUMS asset downloaded')
const sumByName = new Map(sums.entries.map(e => [e.name, e.sha256]))
const assetSha = new Map()
for (const asset of release.assets) {
  const file = join(assets, asset.name)
  if (!existsSync(file)) { report.add(`asset.${asset.name}`, 'skip', A, 'not downloaded in this job (pattern filter)'); continue }
  const actual = await sha256File(file)
  assetSha.set(asset.name, actual)
  const apiDigest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : undefined
  report.expect(`asset.${asset.name}.digest`, apiDigest === actual && statSync(file).size === asset.size, A,
    apiDigest === undefined ? 'GitHub API returned no sha256 digest' : `bytes match GitHub API digest ${apiDigest.slice(0, 12)}… (${asset.size} B)`, { actual, apiDigest, size: asset.size })
  if (asset.name !== 'SHA256SUMS') {
    report.expect(`asset.${asset.name}.sha256sums`, sumByName.get(asset.name) === actual, A, 'bytes match SHA256SUMS line', { expected: sumByName.get(asset.name) ?? null })
  }
}
for (const entry of sums.entries) {
  report.expect(`sha256sums.${entry.name}.published`, release.assets.some(a => a.name === entry.name), A, 'SHA256SUMS line refers to a published asset')
}

// 2. Release metadata in the tag tree.
const relDir = join(src, 'releases', tag)
report.expect('tag.release-dir', existsSync(relDir), S, `releases/${tag}/ exists in the tag tree`)
if (!existsSync(relDir)) finish()
const manifest = parseShaLines(readFileSync(join(relDir, 'MANIFEST.txt'), 'utf8'))
const plugins = JSON.parse(readFileSync(join(relDir, 'PLUGINS.json'), 'utf8')).plugins
report.meta.plugins = plugins.map(p => ({ name: p.name, version: p.version, sha256: p.sha256 }))
const upstream = readFileSync(join(src, 'desktop', 'UPSTREAM.md'), 'utf8')
const upstreamCommit = /\*\*Commit:\*\*\s*`([0-9a-f]{40})`/.exec(upstream)?.[1]
report.meta.upstreamCommit = upstreamCommit
report.expect('manifest.upstream-commit', manifest.other.includes(upstreamCommit ?? '<none>'), S, `MANIFEST.txt names upstream commit ${upstreamCommit}`)

for (const plugin of plugins) {
  const id = `plugin.${plugin.name}`
  const manifestLine = manifest.entries.find(e => e.name === plugin.file)
  report.expect(`${id}.manifest`, manifestLine?.sha256 === plugin.sha256, S, `MANIFEST.txt and PLUGINS.json agree on ${plugin.file}`)
  const file = join(assets, plugin.file)
  if (!existsSync(file)) { report.add(`${id}.asset`, 'fail', A, `release has no asset ${plugin.file}`); continue }
  report.expect(`${id}.asset-sha`, assetSha.get(plugin.file) === plugin.sha256 && statSync(file).size === plugin.bytes, A, `release asset == PLUGINS.json sha ${plugin.sha256.slice(0, 12)}… / ${plugin.bytes} B`)
  let tarball
  try { tarball = readTarball(file) } catch (error) {
    report.add(`${id}.tarball-readable`, 'fail', A, `${plugin.file} is not a readable npm tarball: ${error.message}`)
    continue
  }
  const pkg = JSON.parse(tarball.files.get('package.json').toString('utf8'))
  report.expect(`${id}.identity`, pkg.name === plugin.name && pkg.version === plugin.version, A, `tarball package.json is ${pkg.name}@${pkg.version}`)
  report.expect(`${id}.bundle-patch`, typeof pkg.dsh?.bundle?.patch === 'string' && tarball.files.has(pkg.dsh.bundle.patch.replace(/^\.\//, '')), A, 'dsh.bundle.patch declared and shipped (Desktop rejects packages without it)')
  const nonRegistry = Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }).filter(([, spec]) => /^(workspace|link|file):/.test(String(spec)))
  report.expect(`${id}.installable-deps`, nonRegistry.length === 0, A, 'no workspace:/link:/file: dependencies', { nonRegistry })
  for (const [entry, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target === 'string') report.expect(`${id}.export.${entry}`, tarball.files.has(target.replace(/^\.\//, '')), A, `export ${entry} -> ${target} is shipped`)
  }
  const testScript = pkg.scripts?.test
  if (testScript !== undefined) {
    const referenced = /(test\/|scripts\/)/.exec(testScript)?.[1]
    const shipped = referenced === undefined || [...tarball.files.keys()].some(p => p.startsWith(referenced))
    const inTree = referenced === undefined || existsSync(join(src, 'plugins', plugin.name, referenced))
    report.add(`${id}.tests-published`, shipped || inTree ? 'pass' : 'warn', S, shipped || inTree ? 'scripts.test targets exist' : `scripts.test "${testScript}" refers to ${referenced} which is neither shipped nor in the repository (owner tests not published)`)
  }

  // 3. Tag tree plugins/<name>/ == tarball package/ contents, byte for byte.
  const treeDir = join(src, 'plugins', plugin.name)
  if (!existsSync(treeDir)) { report.add(`${id}.tree`, 'fail', S, `plugins/${plugin.name}/ missing from the tag tree`); continue }
  const treeFiles = walk(treeDir)
  const missing = [...tarball.files.keys()].filter(p => !treeFiles.includes(p))
  const differ = [...tarball.files.keys()].filter(p => treeFiles.includes(p) && sha256(readFileSync(join(treeDir, p))) !== sha256(tarball.files.get(p)))
  let extra = treeFiles.filter(p => !tarball.files.has(p))
  // Allowed extra: sources recovered from the shipped source map (documented in src/SOURCE_NOTE.md) — verify them.
  const mapName = 'lib/client.js.map'
  if (extra.length > 0 && extra.includes('src/SOURCE_NOTE.md') && tarball.files.has(mapName)) {
    const map = JSON.parse(tarball.files.get(mapName).toString('utf8'))
    const bySuffix = new Map(map.sources.map((s, i) => [s.replace(/^.*?\/packages\/third-party\/[^/]+\//, ''), map.sourcesContent?.[i]]))
    const recovered = extra.filter(p => p.startsWith('src/') && p !== 'src/SOURCE_NOTE.md')
    const mismatched = recovered.filter(p => bySuffix.get(p) !== readFileSync(join(treeDir, p), 'utf8'))
    const unlisted = [...bySuffix.keys()].filter(p => !p.includes('node_modules') && !treeFiles.includes(p))
    report.expect(`${id}.sourcemap-sources`, mismatched.length === 0 && unlisted.length === 0, S,
      `${recovered.length} src files equal lib/client.js.map sourcesContent`, { mismatched, unlisted })
    extra = extra.filter(p => !(p.startsWith('src/')))
  }
  report.expect(`${id}.tree-equals-tarball`, missing.length === 0 && differ.length === 0 && extra.length === 0, S,
    `plugins/${plugin.name}/ equals tarball contents (${tarball.files.size} files)`, { missing, differ, extra })

  // 4. `npm pack` of the tag tree reproduces the tarball payload (the uncompressed tar). The gzip layer depends on the
  // packer's zlib build, so a differing .tgz sha with an identical payload is reported, not failed.
  if (!args['skip-repack']) {
    const work = mkdtempSync(join(tmpdir(), 'ci-repack-'))
    try {
      cpSync(treeDir, join(work, 'pkg'), { recursive: true })
      const packed = run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', work], { cwd: join(work, 'pkg') })
      const name = packed.stdout.trim().split('\n').pop()
      if (packed.status !== 0 || !name) { report.add(`${id}.repack`, 'fail', S, 'npm pack failed', { stderr: packed.stderr.slice(-2000) }); continue }
      const repacked = readTarball(join(work, name))
      report.expect(`${id}.repack-payload`, repacked.payloadSha256 === tarball.payloadSha256, S, `npm pack payload == release payload ${tarball.payloadSha256.slice(0, 12)}…`, { release: tarball.payloadSha256, repacked: repacked.payloadSha256 })
      report.add(`${id}.repack-gzip`, repacked.gzipSha256 === tarball.gzipSha256 ? 'pass' : 'info', S,
        repacked.gzipSha256 === tarball.gzipSha256 ? 'npm pack reproduces the .tgz sha exactly' : 'gzip layer differs (packer zlib/Node version); payload decides', { npm: run('npm', ['-v']).stdout.trim(), node: process.version, repackedGzip: repacked.gzipSha256 })
    } finally { rmSync(work, { recursive: true, force: true }) }
  }
  privacyScan(`${id}.privacy`, [...tarball.files].map(([p, b]) => [`${plugin.file}:${p}`, b]))
}

// 5. Patch stack hashes.
for (const entry of manifest.entries.filter(e => e.name.startsWith('desktop-local-build/patches/'))) {
  const file = join(src, 'desktop', 'patches', entry.name.split('/').pop())
  report.expect(`patch.${entry.name.split('/').pop()}`, existsSync(file) && sha256(readFileSync(file)) === entry.sha256, S, `desktop/patches file == MANIFEST.txt ${entry.sha256.slice(0, 12)}…`)
}
const patchFiles = readdirSync(join(src, 'desktop', 'patches')).filter(f => f.endsWith('.patch'))
report.expect('patch.all-listed', patchFiles.every(f => manifest.entries.some(e => e.name.endsWith(`/${f}`))), S, `all ${patchFiles.length} patches are listed in MANIFEST.txt`)

// 6. Privacy scan of the tag tree (excluding CI tooling, whose scanner patterns would match themselves).
privacyScan('tree.privacy', walk(src).filter(p => !p.startsWith('.git/') && !p.startsWith('ci/') && !p.startsWith('.github/')).map(p => [p, readFileSync(join(src, p))]))

// 7. Documented release claims that CI must not contradict.
const status = readFileSync(join(relDir, 'STATUS.md'), 'utf8')
report.expect('status.prerelease-claim', /PRERELEASE/i.test(status) && /not notarized/i.test(status), S, 'STATUS.md declares prerelease and not notarized')
report.add('status.pending-items', 'info', S, 'STATUS.md pending rows (not covered by hosted CI)', { pending: status.split('\n').filter(l => /pending|SUSPECT|not passed/i.test(l)).map(l => l.slice(0, 200)) })

finish()

function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) out.push(relative(root, path).split('\\').join('/'))
    }
  }
  visit(root)
  return out.sort()
}

function privacyScan(id, files) {
  const patterns = [
    ['home-path', /(?:\/Users|\/home)\/(?!runner\/|USER\/|you\/)[A-Za-z0-9_][A-Za-z0-9._-]+\//g],
    ['private-ipv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
    ['token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ]
  const allowed = new Map(expected.privacy.allowedPrivateIpv4Examples.map(entry => [entry.value, entry.reason]))
  const hits = []
  const allowedHits = []
  for (const [name, buffer] of files) {
    if (buffer.includes(0)) continue // binary
    const text = buffer.toString('utf8')
    for (const [kind, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        const hit = { file: name, kind, match: match[0].slice(0, 80) }
        if (kind === 'private-ipv4' && allowed.has(match[0])) allowedHits.push({ ...hit, reason: allowed.get(match[0]) })
        else hits.push(hit)
      }
    }
  }
  report.expect(id, hits.length === 0, EVIDENCE.source,
    hits.length === 0 ? `no builder home path, private IP or token in ${files.length} files (${allowedHits.length} allow-listed placeholder IPs)` : `${hits.length} privacy hits`,
    { hits: hits.slice(0, 50), allowListed: allowedHits.slice(0, 20) })
}

function finish() {
  const document = report.write(args.out)
  console.log(`\n${document.report}: ${document.verdict.toUpperCase()} ${JSON.stringify(document.counts)}`)
  process.exit(document.verdict === 'pass' ? 0 : 1)
}
