// dsh-voice-capture next version (after 0.3.3): offline generator job UI state (R-MIC), CPU/unit only.
// The host offline-job mode is branch 0.5.0-dev (NOT frozen); event shapes follow its `offline.job` publish sites
// (src/offline-job.js) and design §3.2. Recovery after a host restart waits for the stream contract.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CapabilityModel } from '../src/client/audio/api.ts'
import { applyOfflineJobEvent, applyOfflineStreamEnd, jobsOf, offlineJobKey, recoveryActions } from '../src/client/audio/offline-jobs.ts'
import type { OfflineJobState } from '../src/client/audio/offline-jobs.ts'
import { taskView } from '../src/client/audio/tasks.ts'

const ev = (fields: Record<string, unknown>) => ({ type: 'offline.job', provider: 'dgx', model: 'gepard-offline', ...fields })
const k = (id: string) => offlineJobKey('dgx', 'gepard-offline', id)
const run = (events: readonly Record<string, unknown>[], start: Readonly<Record<string, OfflineJobState>> = {}) => events.reduce((jobs, e) => applyOfflineJobEvent(jobs, e), start)

test('V1 offline.job events: created → running with progress → reconnecting → completed with measured delivery', () => {
  const jobs = run([
    ev({ jobId: 'j1', status: 'created' }),
    ev({ jobId: 'j1', status: 'running' }),
    ev({ jobId: 'j1', status: 'running', framesGenerated: 4410, maxTokens: 900 }),
    ev({ jobId: 'j1', status: 'reconnecting', attempt: 2 }),
    ev({ jobId: 'j1', status: 'completed', delivery: 'final-only', finishReason: 'eos' }),
  ])
  assert.deepEqual(jobs[offlineJobKey('dgx', 'gepard-offline', 'j1')], { jobId: 'j1', provider: 'dgx', model: 'gepard-offline', status: 'completed', rawStatus: undefined, framesGenerated: 4410, maxTokens: 900, delivery: 'final-only', finishReason: 'eos', reconnectAttempt: 2, code: undefined, order: 0 })
})

test('V2 idempotent: replayed events after a reconnect never reopen a finished job, lower progress never wins, duplicates change nothing', () => {
  const done = run([ev({ jobId: 'j1', status: 'running', framesGenerated: 9000 }), ev({ jobId: 'j1', status: 'completed', delivery: 'progressive' })])
  assert.equal(run([ev({ jobId: 'j1', status: 'running', framesGenerated: 100 })], done), done, 'same object: nothing changed')
  assert.equal(run([ev({ jobId: 'j1', status: 'failed', code: 'X' })], done), done, 'the first terminal status is final')
  const running = run([ev({ jobId: 'j2', status: 'running', framesGenerated: 5000 })])
  assert.equal(run([ev({ jobId: 'j2', status: 'running', framesGenerated: 4000 })], running)[k('j2')]!.framesGenerated, 5000)
  assert.equal(run([ev({ jobId: 'j2', status: 'running', framesGenerated: 5000 })], running), running)
  const odd = run([ev({ jobId: 'j2', status: 'paused-by-worker' })], running)
  assert.deepEqual([odd[k('j2')]!.status, odd[k('j2')]!.rawStatus], ['running', 'paused-by-worker'], 'an unknown status never replaces a known one')
  assert.equal(run([{ type: 'offline.job', status: 'running' }, { type: 'video.progress', jobId: 'v', status: 'running' }], running), running, 'no jobId or another event type: ignored')
})

test('V2b the same worker job id on two routes is two jobs (E2E finding 08:38: every mock worker numbers job_1)', () => {
  const jobs = run([
    ev({ jobId: 'job_1', status: 'completed', delivery: 'progressive' }),
    { type: 'offline.job', provider: 'dgx-other', model: 'gepard-offline', jobId: 'job_1', status: 'running' },
    { type: 'offline.job', provider: 'dgx-other', model: 'gepard-offline', jobId: 'job_1', status: 'completed', delivery: 'final-only' },
  ])
  assert.deepEqual(jobsOf(jobs, 'dgx', 'gepard-offline').map(j => [j.status, j.delivery]), [['completed', 'progressive']])
  assert.deepEqual(jobsOf(jobs, 'dgx-other', 'gepard-offline').map(j => [j.status, j.delivery]), [['completed', 'final-only']])
})

test('V2c a Stop or failure ends the job line through its audio stream (host rc1 sends no terminal job event; E2E finding 08:43)', () => {
  const running = run([ev({ jobId: 'job_1', status: 'running' })])
  assert.equal(applyOfflineStreamEnd(running, 'dgx', 'gepard-offline', 'completed'), running, 'completed comes from the job event')
  assert.equal(applyOfflineStreamEnd(running, 'other', 'gepard-offline', 'cancelled'), running, 'another route is not touched')
  assert.deepEqual([jobsOf(applyOfflineStreamEnd(running, 'dgx', 'gepard-offline', 'cancelled'), 'dgx', 'gepard-offline')[0]!.status, jobsOf(applyOfflineStreamEnd(running, 'dgx', 'gepard-offline', 'error'), 'dgx', 'gepard-offline')[0]!.code], ['cancelled', 'STREAM_ERROR'])
  const done = run([ev({ jobId: 'job_1', status: 'completed' })])
  assert.equal(applyOfflineStreamEnd(done, 'dgx', 'gepard-offline', 'cancelled'), done, 'a finished job stays finished')
})

test('V3 actions: Stop is the existing turn Stop while running; recovery is never offered before the host publishes it', () => {
  const jobs = run([ev({ jobId: 'a', status: 'running' }), ev({ jobId: 'b', status: 'interrupted', code: 'HOST_RESTARTED' }), ev({ jobId: 'c', status: 'completed' })])
  assert.deepEqual(recoveryActions(jobs[k('a')]!), { stop: { available: true, via: 'turn-stop' }, recover: { available: false, reason: 'not-interrupted' } })
  assert.deepEqual(recoveryActions(jobs[k('b')]!), { stop: { available: false, via: undefined }, recover: { available: false, reason: 'contract-pending' } })
  assert.deepEqual(recoveryActions(jobs[k('c')]!).stop, { available: false, via: undefined })
  assert.deepEqual(jobsOf(jobs, 'dgx', 'gepard-offline').map(j => j.jobId), ['a', 'b', 'c'])
  assert.deepEqual(jobsOf(jobs, 'other-provider', 'gepard-offline').map(j => j.jobId), [])
})

test('V4 an offline-job model (host branch task-map) is a text request with audio output and no Live', () => {
  const entry = {
    id: 'gepard-offline', name: 'gepard offline job', mode: 'offline-job', task: 'tts.offline-job', uiTask: 'tts', wire: 'dsh-offline-job',
    io: { input: { text: 'required', audio: 'none', referenceAudio: 'none', referenceText: 'none' }, output: { text: false, audio: true, audioCount: 'one', transcript: { segments: false, wordTimestamps: false, speakers: false }, embedding: false }, live: 'none', generator: 'offline-job' },
    capabilities: {}, params: [],
  } as unknown as CapabilityModel
  const view = taskView(entry)
  assert.deepEqual([view.task, view.adapterTask, view.live, view.input.text, view.output.audio, view.speaks], ['tts', 'tts.offline-job', 'none', 'required', true, false])
})

// ---- Recover (R-MIC_RECOVER_UI_CONTRACT.md; host 0.5.0-rc.1 6a55ecf3…) -------------------------------------------------
import { OfflineRecoveryController, readRecovery, recoverableJobs, recoveryKey, recoveryView } from '../src/client/audio/offline-recover.ts'

const ACTIVITY = {
  ok: true, live: [], inflight: [],
  offlineJobs: {
    inflight: [], interruptedAtStartup: ['job-a', 'job-other'],
    recoverable: [
      { jobId: 'job-a', sessionId: 'S1', provider: 'dgx', model: 'gepard-offline', state: 'interrupted', startedAt: '2026-09-15T08:00:00Z', recovery: { status: 'not-started' } },
      { jobId: 'job-other', sessionId: 'S2', provider: 'dgx', model: 'gepard-offline', state: 'interrupted', startedAt: null, recovery: { status: 'not-started' } },
      { jobId: 'job-bad', provider: 'dgx', model: 'gepard-offline', state: 'interrupted', recovery: { status: 'not-started' } },
    ],
  },
}

test('V5 listing: only this Session\'s jobs, identity fields complete, nothing started by listing', () => {
  assert.deepEqual(recoverableJobs(ACTIVITY, 'S1').map(j => [j.jobId, j.state, j.recovery.status]), [['job-a', 'interrupted', 'not-started']])
  assert.deepEqual(recoverableJobs({ ok: true }, 'S1'), [], 'a host without offlineJobs shows nothing')
  assert.equal(recoveryView(recoverableJobs(ACTIVITY, 'S1')[0]!.recovery).recover, 'recover')
})

test('V6 outcome views: verified vs not verified, no player or insert on mismatch, no retry on expired, refusals explained', () => {
  const recovered = readRecovery({ recovery: { status: 'recovered', resultId: 'res_1', recordingId: 'rec_1', integrity: 'match', contentVerified: true, frames: 22050, wasRunning: false }, resultLink: '- [🧾 tts result](/api/dsh-dgx-audio/v1/result?id=res_1)' }, 200)
  assert.deepEqual(recoveryView(recovered), { spinner: false, recover: undefined, player: true, badge: 'verified', insert: 'verified', message: 'recovered' })
  const unverified = readRecovery({ recovery: { status: 'recovered-unverified', integrity: 'unavailable', resultId: 'res_2', recordingId: 'rec_2' }, resultLink: 'x' }, 200)
  assert.deepEqual([recoveryView(unverified).badge, recoveryView(unverified).insert], ['unverified', 'unverified'])
  assert.deepEqual([recoveryView(readRecovery({ status: 'recovered', resultId: 'res_1' })).spinner, recoveryView(readRecovery({ status: 'recovered', resultId: 'res_1' })).badge], [true, undefined], 'a feed status without integrity facts waits for the stored outcome')
  assert.notEqual(recoveryKey({ provider: 'dgx-off-x', model: 'gepard', jobId: 'job_1' }), recoveryKey({ provider: 'dgx-off-m', model: 'gepard', jobId: 'job_1' }))
  const odd = readRecovery({ recovery: { status: 'recovered', recordingId: 'rec_3', integrity: 'unavailable', contentVerified: null } }, 200)
  assert.equal(recoveryView(odd).badge, 'unverified', 'recovered without a match is never shown verified')
  const mismatch = recoveryView(readRecovery({ recovery: { status: 'integrity-mismatch', contentVerified: false, recordingId: 'rec_4' }, resultLink: 'x' }, 200))
  assert.deepEqual([mismatch.player, mismatch.insert, mismatch.recover], [false, undefined, undefined])
  assert.deepEqual([recoveryView(readRecovery({ recovery: { status: 'expired', code: 'JOB_EXPIRED' } }, 200)).recover, recoveryView(readRecovery({ recovery: { status: 'retryable', code: 'NET' } }, 200)).recover], [undefined, 'recover-again'])
  assert.equal(recoveryView(readRecovery({ ok: false, error: { code: 'MODEL_NOT_READY', message: 'x' } }, 409)).message, 'refused-model-not-ready')
  assert.equal(recoveryView(readRecovery({ ok: false, error: { code: 'MODEL_NOT_READY', message: 'x' } }, 409)).recover, 'recover-again', 'activate the model, then Recover from the same card')
  assert.equal(recoveryView(readRecovery({ ok: false, error: { code: 'JOB_IDENTITY_MISMATCH', message: 'x' } }, 403)).recover, undefined)
  assert.equal(recoveryView(readRecovery({ ok: false, error: { code: 'JOB_ROUTE_CHANGED', message: 'x' } }, 409)).message, 'refused-route-changed')
  assert.equal(readRecovery({ recovery: { status: 'recovering' }, idempotent: true }, 202).idempotent, true)
})

const KEY_A = recoveryKey({ provider: 'dgx', model: 'gepard-offline', jobId: 'job-a' })

test('V7 explicit Recover: exact identity body, one request per click, status polling until terminal, insert once per result, no auto-recovery', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = []
  let statusPolls = 0
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://h/')
    const method = init?.method ?? 'GET'
    calls.push({ method, url: u.pathname + u.search, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) })
    if (u.pathname.endsWith('/activity')) return new Response(JSON.stringify(ACTIVITY))
    if (u.pathname.endsWith('/offline-job/recover') && method === 'POST') return new Response(JSON.stringify({ ok: true, recovery: { status: 'recovering' } }), { status: 202 })
    if (u.pathname.endsWith('/offline-job/recover')) {
      statusPolls += 1
      return new Response(JSON.stringify(statusPolls < 2
        ? { ok: true, recovery: { status: 'reattaching', wasRunning: true } }
        : { ok: true, recovery: { status: 'recovered', resultId: 'res_9', recordingId: 'rec_9', integrity: 'match', contentVerified: true, frames: 44100, wasRunning: true }, resultLink: '- [🧾 tts result](/api/dsh-dgx-audio/v1/result?id=res_9)' }))
    }
    return new Response('{}', { status: 404 })
  }
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
  const c = new OfflineRecoveryController('S1', fetchImpl, async () => {}, storage)
  await c.load()
  assert.deepEqual(calls.map(x => `${x.method} ${x.url.split('?')[0]}`), ['GET /api/dsh-dgx-audio/v1/activity'], 'loading lists only; no recovery started')
  const first = c.recover(KEY_A)
  const second = c.recover(KEY_A)
  await Promise.all([first, second])
  const posts = calls.filter(x => x.method === 'POST')
  assert.equal(posts.length, 1, 'a second click while one runs sends nothing')
  assert.deepEqual(posts[0]!.body, { jobId: 'job-a', sessionId: 'S1', provider: 'dgx', model: 'gepard-offline' })
  assert.ok(calls.filter(x => x.method === 'GET' && x.url.includes('/offline-job/recover?')).every(x => x.url.includes('jobId=job-a') && x.url.includes('sessionId=S1')))
  const entry = c.source.getSnapshot().entries[0]!
  assert.deepEqual([entry.outcome.status, entry.outcome.contentVerified, entry.busy], ['recovered', true, false])
  assert.equal(c.recover(KEY_A) instanceof Promise, true)
  assert.equal(calls.filter(x => x.method === 'POST').length, 1, 'a recovered job offers no Recover')
  const lines: string[] = []
  assert.equal(c.insert(KEY_A, l => lines.push(l)), true)
  assert.equal(c.insert(KEY_A, l => lines.push(l)), false, 'insert once per resultId')
  assert.deepEqual(lines, ['- [🧾 tts result](/api/dsh-dgx-audio/v1/result?id=res_9)'])
  // After a reload (new controller, same Session) the stored outcome is read again and the result stays inserted.
  const reloaded = new OfflineRecoveryController('S1', async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://h/')
    if (u.pathname.endsWith('/activity')) return new Response(JSON.stringify({ ...ACTIVITY, offlineJobs: { ...ACTIVITY.offlineJobs, recoverable: [{ ...ACTIVITY.offlineJobs.recoverable[0], recovery: { status: 'recovered', resultId: 'res_9', recordingId: 'rec_9', integrity: 'match', contentVerified: true } }] } }))
    return fetchImpl(url, init)
  }, async () => {}, storage)
  await reloaded.load()
  assert.deepEqual([reloaded.source.getSnapshot().entries[0]!.inserted, reloaded.insert(KEY_A, l => lines.push(l))], [true, false])
  reloaded.dispose()
  // Feed events update status; unknown jobs and other sessions are ignored.
  c.handleEvent({ type: 'offline.job.recovery', jobId: 'job-other', status: 'recovering' })
  assert.equal(c.source.getSnapshot().entries.length, 1)
  c.dispose()
})
