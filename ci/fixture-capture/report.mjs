#!/usr/bin/env node
// Turn the fixture-capture harness output (owner rows + owner summary) of one release-app run into a CI report.
// Owner verdicts are copied, never re-judged; the only CI-side judgements are the negative-control expectation (as the
// owner states it) and the A6 late-permission verdict (owner FINAL_FROZEN_0.3.6 criteria), bound to installed bytes.
// Usage: report.mjs --out <run-release-app.sh --out dir> --report <report.json> --tag <tag>
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, Report, required, sha256 } from '../lib/report.mjs'

const args = parseArgs()
required(args, 'out', 'report', 'tag')
const out = args.out
const E = 'packaged-app-hosted-ui'
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const installed = existsSync(join(out, 'installed-sha256.txt')) ? readFileSync(join(out, 'installed-sha256.txt'), 'utf8') : ''
const summary = readJson(join(out, 'summary.json'))
const report = new Report('desktop-fixture-capture', {
  tag: args.tag,
  labels: { capture: 'fixture (test-only MediaStream injection at getUserMedia; microphone owner harness 1.0.0)', backend: 'mock (stream realtime MiniCPM mock + mock-upstream-040, loopback)', app: 'published release app, plugins as seeded by the release (profile desktop-audio)' },
  harness: { hashList: 'ci/fixture-capture/harness-1.0.0/FIXTURE_CAPTURE_HARNESS_1.0.0.SHA256SUMS', sha256: '8a6b428b13a9a1fd401eeb6f8e4f2bbd673fddaa0f3af03105250da60dd03a3e', verify: existsSync(join(out, 'harness-verify.txt')) ? readFileSync(join(out, 'harness-verify.txt'), 'utf8').trim().split('\n').length + ' files OK' : 'missing' },
  fixtureSet: summary?.fixtureSet ?? null,
  installedSha256: installed.trim().split('\n'),
  notCovered: ['real DGX models (backend=real)', 'physical microphone / OS audio processing (injection sits above WebRTC AEC/NS/AGC)', 'macOS TCC permission prompt', 'semantic quality'],
})

if (!existsSync(join(out, 'seed.json'))) report.add('fixture.setup', 'fail', E, 'harness setup did not reach the session seed (see run log)')
if (!summary) report.add('fixture.summary', 'fail', E, 'owner summary.json missing (a case or the analysis did not finish)', { stdout: existsSync(join(out, 'summary.stdout')) ? readFileSync(join(out, 'summary.stdout'), 'utf8').slice(-2000) : null })
report.add('fixture.analyzer-controls', existsSync(join(out, 'analyzer-controls.log')) ? 'pass' : 'fail', E, 'owner analyzer controls (test-analyze-capture.py) ran before the cases')

const positive = { 'overlap-abc': ['C0', 'C1', 'C2', 'O1', 'S1', 'P1', 'I1', 'E1'], 'timeline-interrupt': ['C0', 'C1', 'C2', 'O1', 'S1', 'P1', 'I1', 'E1'], 'turn-record-send': ['M1', 'M2', 'C2'] }
for (const [kase, rowIds] of Object.entries(positive)) {
  const evidence = readJson(join(out, kase, 'evidence.json'))
  const owner = Object.fromEntries((evidence?.rows ?? []).map(r => [r.id, r]))
  const rows = summary?.cases?.[kase]?.rows ?? {}
  for (const id of rowIds) {
    const result = rows[id] ?? owner[id]?.result ?? 'MISSING'
    const status = result === 'PASS' ? 'pass' : result === 'NOT RUN' ? 'skip' : 'fail'
    const detail = owner[id] ? { name: owner[id].name, ...Object.fromEntries(Object.entries(owner[id]).filter(([k]) => !['id', 'name', 'result'].includes(k)).map(([k, v]) => [k, JSON.stringify(v).length > 1500 ? `${JSON.stringify(v).slice(0, 1500)}…` : v])) } : undefined
    report.add(`${kase}.${id}`, status, E, `[capture=fixture, backend=mock] ${kase} ${id}${owner[id]?.name ? ` (${owner[id].name})` : ''}: ${result}${id === 'C2' && summary?.cases?.[kase] ? ` — envelope correlation ${summary.cases[kase].hostInput?.envelopeCorrelation ?? summary.cases[kase].requestAudio?.envelopeCorrelation}` : ''}`, detail)
  }
  if (evidence?.error) report.add(`${kase}.error`, 'fail', E, `${kase} scenario error: ${String(evidence.error).slice(0, 300)}`)
}

const negative = summary?.negativeControl
const negEvidence = readJson(join(out, 'negative-silent-input', 'evidence.json'))
const negRows = negative?.rows ?? Object.fromEntries((negEvidence?.rows ?? []).map(r => [r.id, r.result]))
const negCorrect = negRows.C0 === 'PASS' && negRows.O1 === 'FAIL' && negRows.S1 === 'FAIL'
report.expect('control.negative-silent-input', negCorrect, 'negative-control', `silent capture: frames flow (C0 ${negRows.C0}) but no output/overlap may be claimed (O1 ${negRows.O1}, S1 ${negRows.S1}; expected PASS/FAIL/FAIL)`, { rows: negRows })

// A6 in the packaged app (owner scenario-live-drain.mjs, DEMO3 sequence). Criteria from FINAL_FROZEN_0.3.6: no revived
// session, no backlog, microphone released; Live either runs after the permission (frames acknowledged) or ends cleanly.
const drain = readJson(join(out, 'live-late-permission-dismiss', 'evidence.json'))
const micSeed = /([0-9a-f]{64})\s+dsh-voice-capture-[^\s]+\.tgz/.exec(installed)?.[1] ?? null
const affected = ['79cfe8f28384e95152c7b9e70d8d783850cfdd2632e9fdf48ec8648a9c9eb1fc', '38d722c3f35983e64c5955a7b66fb9f70e6320eadc79a7d57df751b546f76b0c']
if (!drain) {
  report.add('a6.late-permission-dismiss', 'fail', E, 'late-permission scenario produced no evidence', { log: existsSync(join(out, 'live-late-permission-dismiss.log')) ? readFileSync(join(out, 'live-late-permission-dismiss.log'), 'utf8').slice(-1500) : null })
} else {
  const texts = [...(drain.samples ?? []).map(s => s.text ?? ''), drain.final?.text ?? '']
  const appendsOk = (drain.requests ?? []).filter(r => r.route === 'live/append' && r.status === 200).length
  const opens = (drain.requests ?? []).filter(r => r.route === 'live/open')
  const defectSignature = texts.some(t => /CLIENT_BACKLOG|streamed input not supported|LIVE_CLOSED/.test(t))
  const clean = !defectSignature && (drain.exceptions ?? []).length === 0 && (appendsOk >= 10 || ['idle', 'closed', null].includes(drain.final?.phase ?? null))
  const facts = { micPackageSha256: micSeed, finalPhase: drain.final?.phase, finalText: drain.final?.text, appendsOk, opens: opens.map(o => o.t), gum: drain.final?.gum, dismiss: drain.dismiss, exceptions: (drain.exceptions ?? []).slice(0, 3) }
  const label = '[capture=fixture, backend=mock, permission=simulated 17 s getUserMedia hold (not the macOS TCC prompt)]'
  if (affected.includes(micSeed)) {
    if (defectSignature) report.add('a6.late-permission-dismiss', 'known-fail', E, `${label} KNOWN DEFECT live-late-capture-revives-session reproduced on installed mic ${micSeed?.slice(0, 12)}…: "${texts.find(t => /CLIENT_BACKLOG|LIVE_CLOSED|streamed input/.test(t))?.slice(0, 160)}" (fixed by dsh-voice-capture 0.3.6)`, facts)
    else report.add('a6.late-permission-dismiss', clean ? 'warn' : 'fail', E, `${label} affected mic ${micSeed?.slice(0, 12)}… but the defect signature did not appear (${clean ? 'clean run — check the registry' : 'failed differently'})`, facts)
  } else {
    report.expect('a6.late-permission-dismiss', clean, E, `${label} late permission + Dismiss on mic ${micSeed?.slice(0, 12) ?? 'unknown'}…: ${clean ? `no revived session/backlog; ${appendsOk} frames acknowledged` : 'revived session, backlog or error'}`, facts)
  }
}

const document = report.write(args.report)
console.log(`\n${document.report}: ${document.verdict.toUpperCase()} ${JSON.stringify(document.counts)}`)
process.exit(document.verdict === 'pass' ? 0 : 1)
