// Shared helpers for the release-artifact CI scripts: hashing, subprocesses, tarball reading and a check report.
// Dependency-free (Node >= 22). Every check carries an evidence class so a hosted-runner PASS is never read as
// real-device, real-DGX or real-microphone acceptance.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Evidence classes used in reports (see ci/README.md). */
export const EVIDENCE = {
  source: 'source-tree',            // files in the git tree of the tag
  artifact: 'release-artifact',     // bytes of the published release assets
  packagedApp: 'packaged-app-static', // the .app inside the published dmg, inspected without running it
  hostedLaunch: 'packaged-app-hosted-launch', // the published app actually launched on a GitHub-hosted macOS runner
  hostedUi: 'packaged-app-hosted-ui', // real Desktop UI/IPC driven on the hosted runner (only the OS file dialog stubbed)
  control: 'negative-control',      // a deliberately broken input that must be rejected
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key.slice(2)] = true
    else { args[key.slice(2)] = next; i++ }
  }
  return args
}

export function required(args, ...names) {
  for (const name of names) if (args[name] === undefined || args[name] === true) throw new Error(`--${name} is required`)
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message }
}

/** Read an npm tarball fully in memory: { payloadSha256, files: Map<relativePath, Buffer> } (paths below package/). */
export function readTarball(path) {
  const gz = readFileSync(path)
  const tar = gunzipSync(gz)
  const files = new Map()
  let offset = 0
  let longName
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    let name = field(0, 100)
    const prefix = field(345, 155)
    if (prefix) name = `${prefix}/${name}`
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue }
    if (longName !== undefined) { name = longName; longName = undefined }
    if (type === 'x' || type === 'g') continue // pax headers: npm tarballs do not need them for plain paths
    if (type !== '0' && type !== '\0') continue
    if (!name.startsWith('package/')) throw new Error(`${path}: entry outside package/: ${name}`)
    files.set(name.slice('package/'.length), Buffer.from(body))
  }
  return { gzipSha256: sha256(gz), payloadSha256: sha256(tar), files }
}

export class Report {
  constructor(name, meta = {}) {
    this.name = name
    this.meta = { ...meta, startedAt: new Date().toISOString() }
    this.checks = []
  }

  /**
   * @param {string} id stable check id
   * @param {'pass'|'fail'|'known-fail'|'warn'|'info'|'skip'} status  known-fail: a failure that ci/expected.json knownDefects
   *   predicts for exactly this build (kept visible, does not fail the report)
   * @param {string} evidence one of EVIDENCE
   * @param {string} summary one line
   * @param {object} [detail]
   */
  add(id, status, evidence, summary, detail) {
    const check = { id, status, evidence, summary, ...(detail === undefined ? {} : { detail }) }
    this.checks.push(check)
    const mark = { pass: 'PASS', fail: 'FAIL', 'known-fail': 'KNOWN-FAIL', warn: 'WARN', info: 'INFO', skip: 'SKIP' }[status]
    console.log(`${mark} [${evidence}] ${id}: ${summary}`)
    return check
  }

  expect(id, condition, evidence, summary, detail) {
    return this.add(id, condition ? 'pass' : 'fail', evidence, summary, detail)
  }

  get failures() { return this.checks.filter(check => check.status === 'fail') }

  write(path) {
    mkdirSync(dirname(path), { recursive: true })
    const counts = {}
    for (const check of this.checks) counts[check.status] = (counts[check.status] ?? 0) + 1
    const document = { schemaVersion: 1, report: this.name, meta: { ...this.meta, finishedAt: new Date().toISOString() }, counts, verdict: this.failures.length === 0 ? 'pass' : 'fail', checks: this.checks }
    writeFileSync(path, JSON.stringify(document, null, 2) + '\n')
    return document
  }
}

/** Parse `sha  name` lines (SHA256SUMS / MANIFEST.txt); comment and bare lines are returned separately. */
export function parseShaLines(text) {
  const entries = []
  const other = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line)
    if (match) entries.push({ sha256: match[1], name: match[2] })
    else other.push(line)
  }
  return { entries, other }
}
