#!/usr/bin/env node
// Deterministic service-availability CI (no DGX, no microphone, loopback only).
// For the tree under test (a PR/push checkout or a release tag), stage each plugin's REAL source next to the owner's
// unit tests (the tree's own test/ when published, otherwise the pinned owner copy in owner-tests/ with PROVENANCE)
// and the CI scenario tests, run them with node --test, then:
//   - mutation controls: a deliberately broken copy of the host source must make the named scenario tests fail;
//   - known defects: failures predicted by scenarios.json knownDefects for exactly these source bytes are known-fail;
//   - scenario rows A1–A12: PASS only when every mapped test ran and passed; rows without executable tests are
//     reported NOT COVERED with the reason.
// Usage: run.mjs --tree <checkout> --out <dir> [--label <text>]
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVIDENCE, parseArgs, Report, required, sha256 } from '../lib/report.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = parseArgs()
required(args, 'tree', 'out')
const tree = resolve(args.tree)
const out = resolve(args.out)
mkdirSync(out, { recursive: true })
const spec = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))
const work = join(here, '.work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const C = 'deterministic-plugin-code' // evidence class: real plugin source + fake upstream/devices/clock

const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]) : []
const treeSha = (dir) => sha256(walk(dir).filter(f => !f.includes(`${'/'}node_modules${'/'}`)).map(f => relative(dir, f)).sort().map(p => `${sha256(readFileSync(join(dir, p)))}  ${p}\n`).join(''))
const commit = spawnSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null

const suitesReport = new Report('availability-suites', { tree, treeCommit: commit, label: args.label ?? null, node: process.version, evidenceClass: C })
const scenarioReport = new Report('availability-scenarios', { tree, treeCommit: commit, label: args.label ?? null, source: spec.source })
const results = {} // suite -> { ran, reason, tests: Map(title -> {status, message}) }

for (const [name, suite] of Object.entries(spec.suites)) {
  if (suite.inPlace) {
    // CI-owned logic tests that need no plugin source (e.g. the duplex judge and its negative controls).
    const run = runNodeTests(here, suite, name)
    const meta = { owner: suite.owner, tests: { source: 'ci', dir: `ci/availability/${suite.testDir}`, sha256: sha256(suite.files.map(f => readFileSync(join(here, f))).join('')) } }
    results[name] = { ran: true, meta, ...run }
    const counts = countStatuses(run.tests)
    suitesReport.add(`suite.${name}`, run.exitSignal ? 'fail' : 'info', C, `${suite.owner}: ${counts.pass} pass, ${counts.fail} fail of ${run.tests.size}; ${Math.round(run.ms / 1000)} s`, { ...meta, counts })
    continue
  }
  const pluginDir = join(tree, 'plugins', suite.plugin)
  if (!existsSync(join(pluginDir, 'package.json'))) { results[name] = { ran: false, reason: `plugins/${suite.plugin} not in the tree` }; continue }
  const version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version
  const stage = join(work, name)
  cpSync(pluginDir, stage, { recursive: true, filter: src => !src.includes('node_modules') })
  const meta = { plugin: suite.plugin, version, owner: suite.owner, pluginSourceSha256: treeSha(join(pluginDir, 'src')) }

  // Which tests: tree-published owner tests win; else the pinned owner copy for this version; CI tests always.
  if (suite.ciTests) {
    mkdirSync(join(stage, suite.testDir), { recursive: true })
    cpSync(join(here, suite.ciTests), join(stage, suite.testDir, suite.ciTests.split('/').pop()))
    meta.tests = { source: 'ci', file: suite.ciTests, sha256: sha256(readFileSync(join(here, suite.ciTests))) }
    const helperSuite = spec.suites[suite.helpersFrom]
    if (!existsSync(join(stage, 'test', 'helpers'))) {
      const pinned = helperSuite?.pinned?.[Object.keys(helperSuite.pinned).at(-1)]
      if (pinned) { cpSync(join(here, pinned.path, 'helpers'), join(stage, 'test', 'helpers'), { recursive: true }); meta.helpers = `${pinned.path}/helpers (owner harness, pinned)` }
    } else meta.helpers = 'tree test/helpers'
  } else if (existsSync(join(pluginDir, suite.testDir))) {
    meta.tests = { source: 'tree', dir: `plugins/${suite.plugin}/${suite.testDir}` }
  } else if (suite.pinned?.[version]) {
    const pinned = suite.pinned[version]
    rmSync(join(stage, suite.testDir), { recursive: true, force: true })
    cpSync(join(here, pinned.path), join(stage, suite.testDir), { recursive: true })
    meta.tests = { source: 'pinned-owner-copy', dir: `ci/availability/${pinned.path}`, provenance: `ci/availability/${pinned.provenance}`, note: pinned.note ?? null }
  } else {
    results[name] = { ran: false, reason: `no owner tests for ${suite.plugin}@${version} (tree has no ${suite.testDir}/, no pinned copy for this version)`, meta }
    suitesReport.add(`suite.${name}`, 'skip', C, results[name].reason, meta)
    continue
  }

  const run = runNodeTests(stage, suite, name)
  results[name] = { ran: true, meta, ...run }
  const counts = countStatuses(run.tests)
  const status = run.exitSignal ? 'fail' : 'info'
  suitesReport.add(`suite.${name}`, status, C, `${suite.plugin}@${version}: ${counts.pass} pass, ${counts.fail} fail of ${run.tests.size} (${meta.tests.source}); ${Math.round(run.ms / 1000)} s`, { ...meta, counts, exit: run.exit, exitSignal: run.exitSignal })

  // Mutation controls: the scenario tests must fail on a deliberately broken copy of the source.
  for (const mutation of suite.mutations ?? []) {
    const mstage = join(work, `${name}-mutant-${mutation.id}`)
    cpSync(stage, mstage, { recursive: true })
    const file = join(mstage, mutation.file)
    const text = readFileSync(file, 'utf8')
    if (!text.includes(mutation.find)) { suitesReport.add(`mutation.${name}.${mutation.id}`, 'fail', EVIDENCE.control, `mutation anchor not found in ${mutation.file} (source changed; update scenarios.json)`); continue }
    writeFileSync(file, text.replace(mutation.find, () => mutation.replace))
    const mrun = runNodeTests(mstage, suite, `${name}-mutant-${mutation.id}`, mutation.mustFail)
    const killed = mutation.mustFail.every(prefix => [...mrun.tests].some(([title, t]) => title.startsWith(prefix) && t.status === 'fail'))
    suitesReport.expect(`mutation.${name}.${mutation.id}`, killed, EVIDENCE.control, `mutant "${mutation.id}" ${killed ? 'is detected' : 'SURVIVES'}: ${mutation.mustFail.join(' | ')}`, { observed: [...mrun.tests].map(([title, t]) => ({ title: title.slice(0, 120), status: t.status })) })
  }
}

// Known defects bound to exact source bytes.
const knownFor = (suiteName, title) => spec.knownDefects.find(defect => defect.suite === suiteName && defect.tests.some(prefix => title.startsWith(prefix))
  && existsSync(join(tree, defect.affectedWhen.file)) && defect.affectedWhen.sha256.includes(sha256(readFileSync(join(tree, defect.affectedWhen.file)))))

// Unmapped failures still fail the suite report: a regression outside the scenario rows must not hide.
for (const [name, result] of Object.entries(results)) {
  if (!result.ran) continue
  for (const [title, t] of result.tests) {
    if (t.status !== 'fail') continue
    const defect = knownFor(name, title)
    if (defect) suitesReport.add(`test.${name}.${title.slice(0, 60)}`, 'known-fail', C, `KNOWN DEFECT ${defect.id}: ${title}`, { message: t.message, defect: { id: defect.id, fixedBy: defect.fixedBy, evidence: defect.evidence } })
    else suitesReport.add(`test.${name}.${title.slice(0, 60)}`, 'fail', C, `${name}: ${title}`, { message: t.message })
  }
  if (result.exitSignal) suitesReport.add(`suite.${name}.signal`, 'fail', C, `test process ended by ${result.exitSignal}`)
}

// A known defect whose bytes are present but whose tests all pass means the registry (or the tests) went stale.
for (const defect of spec.knownDefects) {
  const file = join(tree, defect.affectedWhen.file)
  if (!existsSync(file) || !defect.affectedWhen.sha256.includes(sha256(readFileSync(file)))) continue
  const result = results[defect.suite]
  if (!result?.ran) continue
  const selected = [...result.tests].filter(([title]) => defect.tests.some(prefix => title.startsWith(prefix)))
  if (selected.length > 0 && selected.every(([, t]) => t.status === 'pass')) suitesReport.add(`known-defect.${defect.id}`, 'warn', C, `known defect ${defect.id} NOT reproduced although the affected bytes are present; check the registry`)
  else if (selected.length === 0) suitesReport.add(`known-defect.${defect.id}`, 'fail', C, `known defect ${defect.id}: its negative-control tests are missing from the suite`)
}

// Scenario rows.
const rowSummary = []
for (const row of spec.rows) {
  const mapped = row.tests.map(selector => {
    const result = results[selector.suite]
    if (!result?.ran) return { ...selector, status: 'not-run', reason: result?.reason ?? 'suite not run' }
    const matches = [...result.tests].filter(([title]) => title.startsWith(selector.title))
    if (matches.length === 0) return { ...selector, status: 'missing', reason: 'no test with this title in the suite that ran' }
    const failing = matches.filter(([, t]) => t.status !== 'pass')
    if (failing.length === 0) return { ...selector, status: 'pass', matched: matches.map(([title]) => title) }
    const known = failing.every(([title]) => knownFor(selector.suite, title))
    return { ...selector, status: known ? 'known-fail' : 'fail', matched: matches.map(([title, t]) => ({ title, status: t.status })), defect: known ? knownFor(selector.suite, failing[0][0]).id : undefined }
  })
  const statuses = mapped.map(m => m.status)
  let status, summary
  if (row.tests.length === 0) { status = 'skip'; summary = `NOT COVERED by deterministic CI: ${row.notCovered.join('; ')}` }
  else if (statuses.includes('fail') || statuses.includes('missing')) { status = 'fail'; summary = `${statuses.filter(s => s === 'pass').length}/${statuses.length} mapped tests pass; failing or missing: ${mapped.filter(m => m.status === 'fail' || m.status === 'missing').map(m => `${m.suite}:${m.title}`).join(' | ')}` }
  else if (statuses.includes('known-fail')) { status = 'known-fail'; summary = `known defect reproduced (${[...new Set(mapped.filter(m => m.defect).map(m => m.defect))].join(', ')}); ${statuses.filter(s => s === 'pass').length}/${statuses.length} other mapped tests pass` }
  else if (statuses.every(s => s === 'not-run')) { status = 'skip'; summary = `NOT RUN in this tree: ${[...new Set(mapped.map(m => m.reason))].join('; ')}` }
  else if (statuses.includes('not-run')) { status = 'warn'; summary = `${statuses.filter(s => s === 'pass').length}/${statuses.length} mapped tests pass; not run here: ${mapped.filter(m => m.status === 'not-run').map(m => `${m.suite}:${m.title}`).join(' | ')}` }
  else { status = 'pass'; summary = `${statuses.length}/${statuses.length} mapped tests ran and passed` }
  // Rows whose acceptance needs the packaged app (duplex): passing judge tests are never reported as the row's PASS.
  if (row.layer === 'judge + packaged' && status === 'pass') { status = 'info'; summary = `JUDGE ONLY — ${statuses.length}/${statuses.length} verdict tests incl. negative controls pass; desktop acceptance for this row is NOT produced by this job (${(row.packaged ?? []).join('; ')})` }
  scenarioReport.add(`scenario.${row.id}`, status, C, `${row.id} ${row.title}: ${summary}`, { priority: row.priority, owners: row.owners, mapped, packaged: row.packaged ?? [], notCovered: row.notCovered ?? [] })
  rowSummary.push({ id: row.id, priority: row.priority, status, mapped: mapped.length, pass: statuses.filter(s => s === 'pass').length })
}
scenarioReport.meta.rows = rowSummary
scenarioReport.meta.suites = Object.fromEntries(Object.entries(results).map(([name, r]) => [name, r.ran ? { ...r.meta, counts: countStatuses(r.tests) } : { ran: false, reason: r.reason }]))

const a = suitesReport.write(join(out, 'availability-suites.json'))
const b = scenarioReport.write(join(out, 'availability-scenarios.json'))
writeFileSync(join(out, 'availability-scenarios.md'), markdownTable(rowSummary, b))
console.log(`\navailability-suites: ${a.verdict.toUpperCase()} ${JSON.stringify(a.counts)}\navailability-scenarios: ${b.verdict.toUpperCase()} ${JSON.stringify(b.counts)}`)
process.exit(a.verdict === 'pass' && b.verdict === 'pass' ? 0 : 1)

function runNodeTests(stage, suite, label, namePatterns) {
  const files = suite.inPlace ? suite.files.map(f => join(stage, f)) : walk(join(stage, suite.testDir)).filter(file => new RegExp(`${suite.glob.split('/').pop().replace('.', '\\.').replace('*', '.*')}$`).test(file) && dirname(file) === join(stage, suite.testDir)).sort()
  const junit = join(out, `${label}.junit.xml`)
  const argv = [...(suite.runner === 'tsx' ? ['--import', 'tsx/esm'] : []), '--test', `--test-timeout=${suite.timeoutMs}`, '--test-force-exit',
    ...(namePatterns ?? []).flatMap(p => ['--test-name-pattern', p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]),
    '--test-reporter=junit', `--test-reporter-destination=${junit}`, '--test-reporter=spec', `--test-reporter-destination=${join(out, `${label}.spec.txt`)}`, ...files]
  const started = Date.now()
  const proc = spawnSync(process.execPath, argv, { cwd: stage, encoding: 'utf8', env: { ...process.env, NODE_PATH: join(here, 'node_modules') }, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 })
  const ms = Date.now() - started
  const tests = parseJunit(existsSync(junit) ? readFileSync(junit, 'utf8') : '')
  return { exit: proc.status, exitSignal: proc.signal ?? null, ms, tests, stderr: proc.stderr?.slice(-2000) }
}

function parseJunit(xml) {
  const tests = new Map()
  const decode = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&')
  for (const match of xml.matchAll(/<testcase\s+name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const title = decode(match[1])
    const body = match[3] ?? ''
    const failure = /<failure[^>]*message="([^"]*)"/.exec(body)
    const status = failure ? 'fail' : /<skipped/.test(body) ? 'skipped' : 'pass'
    tests.set(title, { status, message: failure ? decode(failure[1]).slice(0, 600) : undefined })
  }
  return tests
}

function countStatuses(tests) {
  const counts = { pass: 0, fail: 0, skipped: 0 }
  for (const t of tests.values()) counts[t.status] = (counts[t.status] ?? 0) + 1
  return counts
}

function markdownTable(rows, document) {
  const icon = { pass: '✅ PASS', fail: '❌ FAIL', 'known-fail': '❗ KNOWN-FAIL', warn: '⚠️ PARTIAL', skip: '⛔ NOT COVERED', info: '🧪 JUDGE ONLY' }
  const lines = ['| Row | P | Result | Mapped tests passed | Detail |', '|---|---|---|---|---|']
  for (const check of document.checks) {
    const row = rows.find(r => `scenario.${r.id}` === check.id)
    lines.push(`| ${row.id} | ${row.priority} | ${icon[check.status] ?? check.status} | ${row.pass}/${row.mapped} | ${check.summary.replace(/\|/g, '\\|').slice(0, 300)} |`)
  }
  return lines.join('\n') + '\n'
}
