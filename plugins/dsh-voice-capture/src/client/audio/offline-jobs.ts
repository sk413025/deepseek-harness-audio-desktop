/**
 * Offline generator jobs (host mode `offline-job`, adapter task `tts.offline-job`; stream design
 * `parallel-work/streaming/offline-job/OFFLINE_JOB_ADAPTER_DESIGN.md`, host branch 0.5.0-dev, NOT frozen).
 *
 * The audio itself plays through the shared player (`audio.start` origin `turn`); this module only keeps each job's
 * state from the `offline.job` feed events so the task strip can show it. An offline job is never presented as
 * streaming, realtime or Live.
 *
 * Idempotent by construction: events are keyed by provider + model + `jobId` (a worker numbers its own jobs, so the same
 * id can exist on two routes), a terminal status is final (a replayed `running` after a reconnect never reopens a
 * completed job), and progress never goes back.
 *
 * Recovery after a host restart (release G7b) needs a host contract that does not exist yet (explicit Recover/Fetch
 * result with job/session/provider identity, running reattach, content PCM check, expired error). Until a capability
 * document publishes it, {@link recoveryActions} offers nothing and says why.
 */

export type OfflineJobStatus =
  | 'created' | 'running' | 'reconnecting' | 'test-stream-drop'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'

const KNOWN: ReadonlySet<string> = new Set<OfflineJobStatus>(['created', 'running', 'reconnecting', 'test-stream-drop', 'completed', 'failed', 'cancelled', 'interrupted'])

/** Statuses after which no event changes the job. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<OfflineJobStatus> = new Set<OfflineJobStatus>(['completed', 'failed', 'cancelled', 'interrupted'])

export interface OfflineJobState {
  readonly jobId: string
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly status: OfflineJobStatus
  /** Raw status text when it is not in the known list. */
  readonly rawStatus: string | undefined
  readonly framesGenerated: number | undefined
  readonly maxTokens: number | undefined
  /** Host-measured delivery on completion (`progressive` | `final-only`). */
  readonly delivery: 'progressive' | 'final-only' | undefined
  readonly finishReason: string | undefined
  readonly reconnectAttempt: number | undefined
  readonly code: string | undefined
  /** Order of first appearance in this Session (display order). */
  readonly order: number
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * Key of one job: provider, model and the worker's job id.
 * @param provider - route provider.
 * @param model - model id.
 * @param jobId - worker job id.
 * @returns key.
 */
export function offlineJobKey(provider: string | undefined, model: string | undefined, jobId: string): string {
  return `${provider ?? ''}\u0000${model ?? ''}\u0000${jobId}`
}

/**
 * Apply one `offline.job` feed event.
 * @param jobs - current jobs by key ({@link offlineJobKey}).
 * @param event - feed event (`type` already checked by the caller or ignored here).
 * @returns the same object when nothing changed, else a new map.
 */
export function applyOfflineJobEvent(jobs: Readonly<Record<string, OfflineJobState>>, event: Readonly<Record<string, unknown>>): Readonly<Record<string, OfflineJobState>> {
  if (event.type !== 'offline.job') return jobs
  const jobId = str(event.jobId)
  if (jobId === undefined) return jobs
  const key = offlineJobKey(str(event.provider), str(event.model), jobId)
  const previous = jobs[key]
  const rawStatus = str(event.status)
  const status: OfflineJobStatus = rawStatus !== undefined && KNOWN.has(rawStatus) ? rawStatus as OfflineJobStatus : 'unknown'
  if (previous !== undefined && TERMINAL_JOB_STATUSES.has(previous.status)) return jobs
  const frames = num(event.framesGenerated)
  const delivery = event.delivery === 'progressive' || event.delivery === 'final-only' ? event.delivery : undefined
  const next: OfflineJobState = {
    jobId,
    provider: str(event.provider) ?? previous?.provider,
    model: str(event.model) ?? previous?.model,
    // An unknown status never replaces a known one of the same job.
    status: status === 'unknown' && previous !== undefined ? previous.status : status,
    rawStatus: status === 'unknown' ? rawStatus : undefined,
    framesGenerated: frames === undefined ? previous?.framesGenerated : Math.max(frames, previous?.framesGenerated ?? 0),
    maxTokens: num(event.maxTokens) ?? previous?.maxTokens,
    delivery: delivery ?? previous?.delivery,
    finishReason: str(event.finishReason) ?? previous?.finishReason,
    reconnectAttempt: status === 'reconnecting' ? num(event.attempt) ?? previous?.reconnectAttempt : previous?.reconnectAttempt,
    code: str(event.code) ?? previous?.code,
    order: previous?.order ?? Object.keys(jobs).length,
  }
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return jobs
  return { ...jobs, [key]: next }
}

/**
 * Close the running job of a route model when the shared audio stream of an offline job ends without a completed job
 * event. Host 0.5.0-rc.1 publishes `offline.job` only up to `completed`: a turn Stop (DELETE sent), a worker failure or a
 * deadline ends the job's audio stream as `cancelled` / `error` but sends no terminal job status.
 * @param jobs - jobs by key.
 * @param provider - provider of the ended stream (`audio.start`).
 * @param model - model of the ended stream.
 * @param status - `audio.end` status.
 * @returns the same object when nothing changed.
 */
export function applyOfflineStreamEnd(jobs: Readonly<Record<string, OfflineJobState>>, provider: string | undefined, model: string | undefined, status: unknown): Readonly<Record<string, OfflineJobState>> {
  if (status !== 'cancelled' && status !== 'error') return jobs
  const open = jobsOf(jobs, provider, model).filter(j => !TERMINAL_JOB_STATUSES.has(j.status)).at(-1)
  if (open === undefined) return jobs
  return { ...jobs, [offlineJobKey(open.provider, open.model, open.jobId)]: { ...open, status: status === 'cancelled' ? 'cancelled' : 'failed', code: open.code ?? (status === 'cancelled' ? 'STREAM_CANCELLED' : 'STREAM_ERROR') } }
}

/** What the user can do about a job, and why an action is not offered. */
export interface OfflineJobActions {
  /** Stop a running job: the existing turn Stop (the host cancels the worker job); no second control. */
  readonly stop: { readonly available: boolean; readonly via: 'turn-stop' | undefined }
  /** Retrieve a finished result after a host restart. */
  readonly recover: { readonly available: boolean; readonly reason: 'contract-pending' | 'not-interrupted' | undefined }
}

/**
 * Actions for one job.
 * @param job - job state.
 * @param recoveryContract - the host's published recovery facility; none exists yet, so callers pass undefined.
 * @returns actions with reasons.
 */
export function recoveryActions(job: OfflineJobState, recoveryContract?: undefined): OfflineJobActions {
  const running = !TERMINAL_JOB_STATUSES.has(job.status)
  return {
    stop: { available: running, via: running ? 'turn-stop' : undefined },
    recover: job.status === 'interrupted'
      ? { available: recoveryContract !== undefined, reason: recoveryContract === undefined ? 'contract-pending' : undefined }
      : { available: false, reason: 'not-interrupted' },
  }
}

/**
 * Jobs of one route model, oldest first.
 * @param jobs - jobs by key.
 * @param provider - route provider (all when undefined).
 * @param model - model id (all when undefined).
 * @returns list.
 */
export function jobsOf(jobs: Readonly<Record<string, OfflineJobState>>, provider?: string, model?: string): readonly OfflineJobState[] {
  return Object.values(jobs)
    .filter(j => (provider === undefined || j.provider === provider) && (model === undefined || j.model === model))
    .sort((a, b) => a.order - b.order)
}
