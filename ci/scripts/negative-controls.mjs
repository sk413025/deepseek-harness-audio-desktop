#!/usr/bin/env node
// Mutation controls: the verifiers must REJECT deliberately broken inputs. A verifier that passes these is broken.
//   --mode sources   copies the tag tree + downloaded plugin assets, applies one mutation at a time, runs
//                    verify-release-sources.mjs and requires exit 1 with the named failing check.
//   --mode artifact  runs verify-desktop-artifact.mjs against the real dmg with a PLUGINS.json whose hash was altered.
// Usage: negative-controls.mjs --mode sources|artifact --tag <tag> --tag-src <dir> --assets <dir> --release-json <file> --out <report.json>
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync, symlinkSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EVIDENCE, parseArgs, Report, required, run } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'mode', 'tag', 'tag-src', 'assets', 'release-json', 'out')
for (const key of ['tag-src', 'assets', 'release-json', 'out']) args[key] = resolve(args[key])
const here = new URL('.', import.meta.url).pathname
const report = new Report(`negative-controls-${args.mode}`, { tag: args.tag })
const C = EVIDENCE.control
const plugins = JSON.parse(readFileSync(join(args['tag-src'], 'releases', args.tag, 'PLUGINS.json'), 'utf8')).plugins

function stage() {
  const root = mkdtempSync(join(tmpdir(), 'ci-negative-'))
  const src = join(root, 'src')
  for (const part of ['releases', 'plugins', 'desktop']) cpSync(join(args['tag-src'], part), join(src, part), { recursive: true })
  const assets = join(root, 'assets')
  mkdirSync(assets)
  for (const name of readdirSync(args.assets)) {
    if (name.endsWith('.dmg')) symlinkSync(join(args.assets, name), join(assets, name))
    else cpSync(join(args.assets, name), join(assets, name))
  }
  return { root, src, assets }
}

function runSources(staged, label) {
  const out = join(staged.root, `${label}.json`)
  const result = run(process.execPath, [join(here, 'verify-release-sources.mjs'), '--tag', args.tag, '--tag-src', staged.src, '--assets', staged.assets, '--release-json', args['release-json'], '--out', out, '--skip-repack'])
  const document = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { checks: [] }
  return { status: result.status, failed: document.checks.filter(c => c.status === 'fail').map(c => c.id) }
}

if (args.mode === 'sources') {
  const baseline = stage()
  const clean = runSources(baseline, 'baseline')
  report.expect('control.baseline-passes', clean.status === 0, C, `unmodified copy passes (exit ${clean.status})`, clean)
  rmSync(baseline.root, { recursive: true, force: true })

  const dgx = plugins.find(p => p.name === 'dsh-dgx-audio') ?? plugins[0]
  const other = plugins.find(p => p.name !== dgx.name) ?? plugins[0]
  const mutations = [
    { id: 'tarball-byte-flip', expect: `asset.${dgx.file}.digest`, apply: s => { const f = join(s.assets, dgx.file); const b = readFileSync(f); b[b.length - 20] ^= 0xff; writeFileSync(f, b) } },
    { id: 'plugins-json-version', expect: `plugin.${other.name}.identity`, apply: s => { const f = join(s.src, 'releases', args.tag, 'PLUGINS.json'); const j = JSON.parse(readFileSync(f, 'utf8')); j.plugins.find(p => p.name === other.name).version = '9.9.9'; writeFileSync(f, JSON.stringify(j)) } },
    { id: 'tree-extra-file', expect: `plugin.${dgx.name}.tree-equals-tarball`, apply: s => writeFileSync(join(s.src, 'plugins', dgx.name, 'src', 'injected-by-ci.js'), 'export const injected = true\n') },
    { id: 'tree-privacy-leak', expect: 'tree.privacy', apply: s => appendFileSync(join(s.src, 'plugins', dgx.name, 'README.md'), '\nlocal path /Users/alice/private/home.wav and host 10.20.30.40\n') },
    { id: 'patch-changed', expect: 'patch.0002-local-ui-audio-player-for-local-audio-files.patch', apply: s => appendFileSync(join(s.src, 'desktop', 'patches', '0002-local-ui-audio-player-for-local-audio-files.patch'), '\n') },
  ]
  for (const mutation of mutations) {
    const staged = stage()
    try {
      mutation.apply(staged)
      const result = runSources(staged, mutation.id)
      report.expect(`control.${mutation.id}`, result.status === 1 && result.failed.includes(mutation.expect), C, `mutation rejected (exit ${result.status}) with failing check ${mutation.expect}`, result)
    } finally { rmSync(staged.root, { recursive: true, force: true }) }
  }
} else if (args.mode === 'artifact') {
  const staged = stage()
  try {
    const target = plugins.find(p => p.name === 'dsh-voice-capture') ?? plugins[0]
    const override = join(staged.root, 'PLUGINS.override.json')
    writeFileSync(override, JSON.stringify({ plugins: plugins.map(p => p.name === target.name ? { ...p, sha256: 'f'.repeat(64) } : p) }))
    const out = join(staged.root, 'artifact-negative.json')
    const result = run(process.execPath, [join(here, 'verify-desktop-artifact.mjs'), '--tag', args.tag, '--tag-src', staged.src, '--assets', args.assets, '--release-json', args['release-json'], '--work', join(staged.root, 'work'), '--out', out, '--plugins-json', override])
    const failed = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).checks.filter(c => c.status === 'fail').map(c => c.id) : []
    report.expect('control.seed-vs-altered-plugins-json', result.status === 1 && failed.includes('seed.bundled-equals-release'), C, `dmg seed checked against a PLUGINS.json with a wrong ${target.name} hash is rejected (exit ${result.status})`, { failed })
  } finally { rmSync(staged.root, { recursive: true, force: true }) }
} else throw new Error(`unknown mode ${args.mode}`)

const document = report.write(args.out)
console.log(`\n${document.report}: ${document.verdict.toUpperCase()} ${JSON.stringify(document.counts)}`)
process.exit(document.verdict === 'pass' ? 0 : 1)
