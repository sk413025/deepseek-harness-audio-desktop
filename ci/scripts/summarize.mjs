#!/usr/bin/env node
// Aggregate job reports into one evidence record bound to run / CI commit / tag / tag commit / asset digests, and a
// job summary that separates what this hosted run verified from what it cannot verify.
// Exit 1 when any required report is missing or failed — a missing report is never a pass.
// Usage: summarize.mjs --reports <dir> --target <target.json> --required <name,name,...> --out <evidence.json> [--summary <file>]
//          [--scope full|sources-only]  (sources-only: the macOS job did not run, so nothing about the app is claimed)
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs, required } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'reports', 'target', 'required', 'out')
const target = JSON.parse(readFileSync(args.target, 'utf8'))
const reports = []
const visit = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.name.endsWith('.json')) {
      try {
        const document = JSON.parse(readFileSync(path, 'utf8'))
        if (document?.schemaVersion === 1 && typeof document.report === 'string') reports.push({ path: relative(args.reports, path), document })
      } catch { /* not a report */ }
    }
  }
}
if (existsSync(args.reports)) visit(args.reports)

const requiredNames = String(args.required).split(',').filter(Boolean)
const byName = new Map(reports.map(r => [r.document.report, r]))
const rows = requiredNames.map(name => {
  const found = byName.get(name)
  return { report: name, verdict: found ? found.document.verdict : 'missing', counts: found?.document.counts ?? {}, path: found?.path ?? null }
})
const optional = reports.filter(r => !requiredNames.includes(r.document.report)).map(r => ({ report: r.document.report, verdict: r.document.verdict, counts: r.document.counts ?? {}, path: r.path }))
const ok = rows.every(r => r.verdict === 'pass')
const scope = args.scope === 'sources-only' ? 'sources-only' : 'full'

const pick = (name, key) => byName.get(name)?.document.meta?.[key]
const evidence = {
  schemaVersion: 1,
  verdict: ok ? (scope === 'full' ? 'pass' : 'pass-sources-only') : 'fail',
  scope,
  meaning: !ok
    ? 'At least one required check failed or did not report. Do not treat this release as CI-verified.'
    : scope === 'full'
      ? 'The published release assets, their tag tree and the packaged app passed the hosted checks listed below. This is NOT release acceptance: real DGX, real microphone, speaker/audio quality, Gatekeeper first open, notarization and a second physical Mac are outside this run.'
      : 'Only the release assets and their tag tree were checked (ubuntu). The macOS desktop job did not run, so nothing about the dmg or the packaged app is verified by this run.',
  binding: {
    ...target,
    dmg: pick('verify-desktop-artifact', 'dmg') ?? null,
    app: pick('verify-desktop-artifact', 'app') ?? null,
    bundledPlugins: pick('verify-desktop-artifact', 'bundledPlugins') ?? null,
    releasePlugins: pick('verify-release-sources', 'plugins') ?? null,
    upstreamCommit: pick('verify-release-sources', 'upstreamCommit') ?? null,
    runner: pick('verify-desktop-artifact', 'runner') ?? null,
  },
  required: rows,
  optional,
  knownDefectsReproduced: reports.flatMap(r => (r.document.checks ?? []).filter(c => c.status === 'known-fail').map(c => ({ report: r.document.report, check: c.id, summary: c.summary, patchSha: c.detail?.patchSha ?? null, firstSeen: c.detail?.firstSeen ?? null, fixedBy: c.detail?.fixedBy ?? null }))),
  evidenceClasses: [...new Set(reports.flatMap(r => r.document.checks?.map(c => c.evidence) ?? []))],
  notCovered: [
    'Real DGX / vLLM-Omni model servers (MiniCPM-o-4_5 duplex, MiMo-Audio-7B-Instruct): needs a controlled Mac on the lab network — attach external evidence, never infer from this run',
    'Physical USB microphone capture and macOS microphone permission prompt',
    'Speaker playback, MiMo progressive playback timing against a real server, audio quality',
    'Finder double-click of a quarantined download (Gatekeeper first open); notarization',
    'A second physical Mac / other macOS versions than the runner image',
  ],
  generatedAt: new Date().toISOString(),
}
writeFileSync(args.out, JSON.stringify(evidence, null, 2) + '\n')

const lines = []
const knownNote = evidence.knownDefectsReproduced.length ? ` — ${evidence.knownDefectsReproduced.length} KNOWN DEFECT(S) reproduced` : ''
lines.push(`## Release artifact CI: ${!ok ? 'FAIL' : scope === 'full' ? 'PASS (hosted checks only)' : 'PASS — sources only, macOS desktop job NOT run'}${knownNote}`)
lines.push('')
lines.push(`- **Tag:** \`${target.tag}\` → commit \`${target.tagCommit}\`; release id ${target.releaseId} (prerelease=${target.prerelease})`)
lines.push(`- **CI scripts commit:** \`${target.ciCommit}\` (${target.event}); run ${target.runUrl}`)
if (evidence.binding.dmg) lines.push(`- **dmg:** \`${evidence.binding.dmg.name}\` sha256 \`${evidence.binding.dmg.sha256}\` (GitHub digest ${evidence.binding.dmg.apiDigest === evidence.binding.dmg.sha256 ? 'matches' : 'MISMATCH'})`)
if (evidence.binding.app) lines.push(`- **app:** ${evidence.binding.app.bundleIdentifier} ${evidence.binding.app.shortVersion}, signature ${evidence.binding.app.signature}`)
for (const plugin of evidence.binding.releasePlugins ?? []) lines.push(`  - ${plugin.name} ${plugin.version} \`${plugin.sha256.slice(0, 16)}…\``)
if (evidence.binding.runner) lines.push(`- **runner:** ${evidence.binding.runner.imageOS} ${evidence.binding.runner.imageVersion}, macOS ${evidence.binding.runner.macOS}, ${evidence.binding.runner.machine}`)
lines.push('')
lines.push('| report | verdict | pass | fail | known-fail | warn | info | skip |')
lines.push('|---|---|---|---|---|---|---|---|')
for (const row of [...rows, ...optional.map(r => ({ ...r, report: `${r.report} (optional)` }))]) {
  lines.push(`| ${row.report} | ${row.verdict === 'pass' ? '✅ pass' : row.verdict === 'missing' ? '⛔ missing' : '❌ fail'} | ${row.counts.pass ?? 0} | ${row.counts.fail ?? 0} | ${row.counts['known-fail'] ?? 0} | ${row.counts.warn ?? 0} | ${row.counts.info ?? 0} | ${row.counts.skip ?? 0} |`)
}
const failures = reports.flatMap(r => (r.document.checks ?? []).filter(c => c.status === 'fail').map(c => `- ❌ \`${r.document.report}\` ${c.id}: ${c.summary}`))
const warnings = reports.flatMap(r => (r.document.checks ?? []).filter(c => c.status === 'warn').map(c => `- ⚠️ \`${r.document.report}\` ${c.id}: ${c.summary}`))
if (failures.length) lines.push('', '### Failures', ...failures.slice(0, 60))
if (evidence.knownDefectsReproduced.length) lines.push('', '### Known defects reproduced on this build (expected by ci/expected.json knownDefects; they do not fail the run, they are not fixed)', ...evidence.knownDefectsReproduced.map(d => `- ❗ \`${d.report}\` ${d.check}: ${d.summary}`))
if (warnings.length) lines.push('', '### Warnings', ...warnings.slice(0, 40))
lines.push('', '### Not covered by this hosted run', ...evidence.notCovered.map(item => `- ${item}`))
const markdown = lines.join('\n') + '\n'
if (args.summary) appendFileSync(args.summary, markdown)
console.log(markdown)
process.exit(ok ? 0 : 1)
