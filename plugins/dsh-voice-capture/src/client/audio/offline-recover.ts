/**
 * Explicit recovery of interrupted offline generator jobs (stream `R-MIC_RECOVER_UI_CONTRACT.md`, host
 * dsh-dgx-audio 0.5.0-rc.1 `offline-job/recover`).
 *
 * - Recoverable jobs come from `GET activity` → `offlineJobs.recoverable[]` (listing never contacts a model server) and
 *   are shown only in the Session whose `sessionId` matches.
 * - Recovery starts only from the user's Recover button: `POST offline-job/recover {jobId, sessionId, provider, model}`
 *   exactly as listed. Nothing is recovered on load, Session open or model selection; no job id is built here; no
 *   generation is ever re-POSTed.
 * - One recovery per job at a time on this page as well; a second click while one runs does nothing.
 * - Outcomes are shown as the host states them; `recovered-unverified` and `integrity-mismatch` are never verified.
 * - Insert into conversation puts the host's `resultLink` line into the composer once per `resultId` (no model call).
 */
import { AudioRouteError, ROUTE_PREFIX, requestJson, routeUrl } from './api.ts'
import type { FetchLike } from './api.ts'

export const RECOVERY_STATUSES = [
  'not-started', 'recovering', 'fetching', 'reattaching',
  'recovered', 'recovered-unverified', 'expired', 'failed', 'cancelled', 'integrity-mismatch', 'retryable',
] as const
export type RecoveryStatus = typeof RECOVERY_STATUSES[number]

/**
 * Identity key of a recoverable job: provider, model and the worker's job id (two workers may reuse an id).
 * @param job - job identity.
 * @returns key.
 */
export function recoveryKey(job: { readonly provider: string; readonly model: string; readonly jobId: string }): string {
  return `${job.provider}\u0000${job.model}\u0000${job.jobId}`
}

/** Statuses during which the page polls the status route. */
export const RECOVERY_RUNNING: ReadonlySet<RecoveryStatus> = new Set<RecoveryStatus>(['recovering', 'fetching', 'reattaching'])

export interface RecoverableJob {
  readonly jobId: string
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly state: 'interrupted' | 'detached'
  readonly startedAt: string | undefined
  readonly recovery: RecoveryOutcome
}

/** Host view of one recovery, or a refusal before any request. */
export interface RecoveryOutcome {
  readonly status: RecoveryStatus | 'refused' | 'unknown'
  readonly code: string | undefined
  readonly message: string | undefined
  readonly resultId: string | undefined
  readonly recordingId: string | undefined
  readonly resultLink: string | undefined
  readonly integrity: string | undefined
  /** true verified, false failed verification, null not checked. */
  readonly contentVerified: boolean | null | undefined
  readonly frames: number | undefined
  readonly wasRunning: boolean | undefined
  readonly idempotent: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * Normalise a recovery body (`{recovery: {...}, resultLink?, idempotent?}`), the `recovery` object of a listing, or an
 * error body (`{ok: false, error: {code, message}}`).
 * @param body - JSON body.
 * @param httpStatus - HTTP status, when the body is a reply.
 * @returns outcome.
 */
export function readRecovery(body: unknown, httpStatus?: number): RecoveryOutcome {
  const b = (body ?? {}) as Record<string, unknown>
  const error = b.error as { code?: unknown; message?: unknown } | undefined
  if (httpStatus !== undefined && httpStatus >= 400) {
    return { status: 'refused', code: str(error?.code) ?? `HTTP_${httpStatus}`, message: str(error?.message), resultId: undefined, recordingId: undefined, resultLink: undefined, integrity: undefined, contentVerified: undefined, frames: undefined, wasRunning: undefined, idempotent: false }
  }
  const r = (b.recovery !== undefined && typeof b.recovery === 'object' && b.recovery !== null ? b.recovery : b) as Record<string, unknown>
  const status = typeof r.status === 'string' && (RECOVERY_STATUSES as readonly string[]).includes(r.status) ? r.status as RecoveryStatus : 'unknown'
  return {
    status,
    code: str(r.code),
    message: str(r.message),
    resultId: str(r.resultId),
    recordingId: str(r.recordingId),
    resultLink: str(b.resultLink) ?? str(r.resultLink),
    integrity: str(r.integrity),
    contentVerified: typeof r.contentVerified === 'boolean' || r.contentVerified === null ? r.contentVerified as boolean | null : undefined,
    frames: typeof r.frames === 'number' ? r.frames : undefined,
    wasRunning: typeof r.wasRunning === 'boolean' ? r.wasRunning : undefined,
    idempotent: b.idempotent === true || r.idempotent === true,
  }
}

/**
 * Recoverable jobs of one Session from a `GET activity` body.
 * @param activity - activity body.
 * @param sessionId - Session shown.
 * @returns jobs whose `sessionId` matches exactly; entries missing an identity field are dropped.
 */
export function recoverableJobs(activity: unknown, sessionId: string): readonly RecoverableJob[] {
  const list = ((activity as { offlineJobs?: { recoverable?: unknown } } | undefined)?.offlineJobs?.recoverable)
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    const j = item as Record<string, unknown> | null
    const jobId = str(j?.jobId); const sid = str(j?.sessionId); const provider = str(j?.provider); const model = str(j?.model)
    if (jobId === undefined || sid === undefined || provider === undefined || model === undefined || sid !== sessionId) return []
    if (j!.state !== 'interrupted' && j!.state !== 'detached') return []
    return [{ jobId, sessionId: sid, provider, model, state: j!.state, startedAt: str(j!.startedAt), recovery: readRecovery(j!.recovery ?? { status: 'not-started' }) }]
  })
}

/** Refusals that another click cannot change (contract §3: identity, unknown job, malformed request). */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(['JOB_IDENTITY_MISMATCH', 'JOB_NOT_RECOVERABLE', 'BAD_REQUEST'])

/** What the card shows for an outcome (contract §3). */
export interface RecoveryView {
  readonly spinner: boolean
  /** Recover (first time) or Recover again (retryable); none while running or after a final outcome. */
  readonly recover: 'recover' | 'recover-again' | undefined
  readonly player: boolean
  readonly badge: 'verified' | 'unverified' | undefined
  /** Insert into conversation: allowed (verified), allowed with the not-verified label, or not offered. */
  readonly insert: 'verified' | 'unverified' | undefined
  /** Locale key suffix of the status line. */
  readonly message: string
}

/**
 * Card state for an outcome.
 * @param outcome - recovery outcome.
 * @returns view.
 */
export function recoveryView(outcome: RecoveryOutcome): RecoveryView {
  const none = { spinner: false, recover: undefined, player: false, badge: undefined, insert: undefined } as const
  switch (outcome.status) {
    case 'not-started': return { ...none, recover: 'recover', message: 'interrupted' }
    case 'recovering': case 'fetching': case 'reattaching': return { ...none, spinner: true, message: outcome.status }
    case 'recovered':
      // A feed event carries only the status: wait for the stored outcome instead of flashing "not verified".
      if (outcome.integrity === undefined && outcome.contentVerified === undefined) return { ...none, spinner: true, message: 'fetching' }
      // Verified only with the host's match; anything else is shown as not verified.
      return outcome.integrity === 'match' && outcome.contentVerified !== false
        ? { ...none, player: outcome.recordingId !== undefined, badge: 'verified', insert: outcome.resultLink === undefined ? undefined : 'verified', message: 'recovered' }
        : { ...none, player: outcome.recordingId !== undefined, badge: 'unverified', insert: outcome.resultLink === undefined ? undefined : 'unverified', message: 'recovered-unverified' }
    case 'recovered-unverified': return { ...none, player: outcome.recordingId !== undefined, badge: 'unverified', insert: outcome.resultLink === undefined ? undefined : 'unverified', message: 'recovered-unverified' }
    case 'expired': return { ...none, message: 'expired' }
    case 'failed': return { ...none, message: 'failed' }
    case 'cancelled': return { ...none, message: 'cancelled' }
    case 'integrity-mismatch': return { ...none, message: 'integrity-mismatch' }
    case 'retryable': return { ...none, recover: 'recover-again', message: 'retryable' }
    case 'refused':
      // Refusals happen before any worker request. Transient causes (model not ready, route changed back, turn still
      // running) can be tried again from the card; identity and unknown-job refusals cannot.
      return {
        ...none,
        recover: PERMANENT_REFUSALS.has(outcome.code ?? '') ? undefined : 'recover-again',
        message: outcome.code === 'MODEL_NOT_READY' ? 'refused-model-not-ready' : outcome.code === 'JOB_ROUTE_CHANGED' ? 'refused-route-changed' : outcome.code === 'JOB_IN_FLIGHT' ? 'refused-in-flight' : 'refused',
      }
    default: return { ...none, message: 'unknown' }
  }
}

export interface RecoveryEntry {
  readonly job: RecoverableJob
  readonly outcome: RecoveryOutcome
  /** Page-side single flight: a POST or status poll of this job is running. */
  readonly busy: boolean
  /** The result line was inserted into the composer (once per resultId). */
  readonly inserted: boolean
}

export interface RecoverySnapshot {
  readonly loaded: boolean
  readonly entries: readonly RecoveryEntry[]
}

const POLL_MS = 1000
const POLL_LIMIT_MS = 180_000

/** Per-Session recovery state: listing, explicit Recover, status polling, feed events and one insert per result. */
export class OfflineRecoveryController {
  private snapshot: RecoverySnapshot = { loaded: false, entries: [] }
  private readonly listeners = new Set<() => void>()
  private readonly inserted: Set<string>
  private disposed = false

  /**
   * @param sessionId - the Session this card belongs to.
   * @param fetchImpl - page fetch.
   * @param sleep - timer (tests).
   * @param storage - per-viewer memory of inserted results (survives a reload); unavailable storage only keeps it in memory.
   */
  constructor(
    private readonly sessionId: string,
    private readonly fetchImpl: FetchLike,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
  ) {
    this.inserted = new Set(this.readInserted())
  }

  private get storageKey(): string {
    return `dsh-voice-capture:recovered-inserted:${this.sessionId}`
  }

  private readInserted(): string[] {
    try {
      const value = JSON.parse(this.storage?.getItem(this.storageKey) ?? '[]') as unknown
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(-200) : []
    } catch {
      return []
    }
  }

  readonly source = {
    getSnapshot: (): RecoverySnapshot => this.snapshot,
    subscribe: (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
  }

  /**
   * Read the recoverable list (host-local; never starts a recovery).
   * @returns completion; a host without the list leaves the card empty.
   */
  async load(): Promise<void> {
    let activity: unknown
    try {
      activity = await requestJson<unknown>(this.fetchImpl, `${ROUTE_PREFIX}/activity`)
    } catch {
      activity = undefined
    }
    if (this.disposed) return
    const jobs = recoverableJobs(activity, this.sessionId)
    const previous = new Map(this.snapshot.entries.map(e => [recoveryKey(e.job), e]))
    this.set({
      loaded: true,
      entries: jobs.map((job) => {
        const known = previous.get(recoveryKey(job))
        // A page-side running request keeps its own newer view.
        const outcome = known?.busy === true ? known.outcome : job.recovery
        return { job, outcome, busy: known?.busy ?? false, inserted: this.insertedFor(outcome) }
      }),
    })
    // The listing carries no result line: read the stored outcome (host-local status, no worker request) so Insert works.
    for (const entry of this.snapshot.entries) {
      if ((entry.outcome.status === 'recovered' || entry.outcome.status === 'recovered-unverified') && entry.outcome.resultLink === undefined && !entry.busy) void this.refreshStatus(recoveryKey(entry.job))
    }
  }

  /**
   * Explicit user Recover (or Recover again after `retryable` or a transient refusal).
   * @param key - {@link recoveryKey} of a job from the listing.
   * @returns completion when the recovery reached a non-running status or the poll limit.
   */
  async recover(key: string): Promise<void> {
    const entry = this.entry(key)
    if (entry === undefined || entry.busy) return
    const view = recoveryView(entry.outcome)
    if (view.recover === undefined) return
    const { sessionId, provider, model, jobId } = entry.job
    this.patch(key, { busy: true, outcome: { ...entry.outcome, status: 'recovering', idempotent: false } })
    try {
      const response = await this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/offline-job/recover`), {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, sessionId, provider, model }),
      })
      const outcome = readRecovery(await response.json().catch(() => ({})), response.status)
      this.patch(key, { outcome })
      await this.poll(key)
    } catch (error) {
      this.patch(key, { outcome: { ...entry.outcome, status: 'retryable', code: 'NETWORK', message: error instanceof Error ? error.message : String(error), idempotent: false } })
    } finally {
      this.patch(key, { busy: false })
    }
  }

  /**
   * Apply a session feed `offline.job.recovery` event.
   * @param event - feed event.
   */
  handleEvent(event: Readonly<Record<string, unknown>>): void {
    if (event.type !== 'offline.job.recovery' || typeof event.jobId !== 'string' || typeof event.provider !== 'string' || typeof event.model !== 'string') return
    const entry = this.entry(recoveryKey({ provider: event.provider, model: event.model, jobId: event.jobId }))
    if (entry === undefined) return
    const next = readRecovery(event)
    if (next.status === 'unknown') return
    // Keep the richer reply fields (resultLink, integrity) when the event only carries the status.
    this.patch(recoveryKey(entry.job), { outcome: { ...entry.outcome, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)), idempotent: entry.outcome.idempotent } as RecoveryOutcome })
    // A terminal status from the feed fetches the full stored outcome (status only, no new request to the worker).
    if (!RECOVERY_RUNNING.has(next.status as RecoveryStatus)) void this.refreshStatus(recoveryKey(entry.job))
  }

  /**
   * Insert the result line into the composer once per result.
   * @param key - {@link recoveryKey} of the job.
   * @param setDraft - composer writer (appends a line to the current draft).
   * @returns whether a line was inserted.
   */
  insert(key: string, setDraft: (line: string) => void): boolean {
    const entry = this.entry(key)
    if (entry === undefined) return false
    const view = recoveryView(entry.outcome)
    const resultId = entry.outcome.resultId
    if (view.insert === undefined || resultId === undefined || entry.outcome.resultLink === undefined || this.inserted.has(resultId)) return false
    this.inserted.add(resultId)
    try { this.storage?.setItem(this.storageKey, JSON.stringify([...this.inserted].slice(-200))) } catch { /* memory only */ }
    setDraft(entry.outcome.resultLink)
    this.patch(key, { inserted: true })
    return true
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private insertedFor(outcome: RecoveryOutcome): boolean {
    return outcome.resultId !== undefined && this.inserted.has(outcome.resultId)
  }

  private entry(key: string): RecoveryEntry | undefined {
    return this.snapshot.entries.find(e => recoveryKey(e.job) === key)
  }

  private async poll(key: string): Promise<void> {
    const started = Date.now()
    while (!this.disposed) {
      const entry = this.entry(key)
      // `recovered` without integrity facts is the feed's early status: keep reading until the stored outcome arrives.
      const pending = entry !== undefined && (RECOVERY_RUNNING.has(entry.outcome.status as RecoveryStatus) || recoveryView(entry.outcome).message === 'fetching')
      if (!pending) return
      if (Date.now() - started > POLL_LIMIT_MS) return
      await this.sleep(POLL_MS)
      await this.refreshStatus(key)
    }
  }

  /** GET status: never starts anything and sends no worker request. */
  private async refreshStatus(key: string): Promise<void> {
    const entry = this.entry(key)
    if (entry === undefined) return
    const { sessionId, provider, model, jobId } = entry.job
    const query = new URLSearchParams({ jobId, sessionId, provider, model })
    try {
      const response = await this.fetchImpl(routeUrl(`${ROUTE_PREFIX}/offline-job/recover?${query.toString()}`), { credentials: 'include' })
      const outcome = readRecovery(await response.json().catch(() => ({})), response.status)
      // A status refusal (e.g. listing changed) does not overwrite a known outcome.
      if (outcome.status !== 'refused') this.patch(key, { outcome })
    } catch (error) {
      if (!(error instanceof AudioRouteError)) return
    }
  }

  private patch(key: string, patch: Partial<RecoveryEntry>): void {
    if (this.disposed) return
    const entries = this.snapshot.entries.map(e => (recoveryKey(e.job) === key ? { ...e, ...patch, inserted: patch.inserted ?? this.insertedFor(patch.outcome ?? e.outcome) } : e))
    this.set({ ...this.snapshot, entries })
  }

  private set(next: RecoverySnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
