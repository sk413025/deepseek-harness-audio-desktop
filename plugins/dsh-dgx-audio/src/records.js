// Invocation log records (`invocations.jsonl`). Every line carries `record`:
// - `invocation`: a request that reached (or tried to reach) the model server, or a live replay;
// - `refusal`: a fail-fast refusal before any upstream request (MODEL_NOT_READY, Live-only, busy). It is never a completed
//   invocation: `invocation: false`, `zeroUpstream: true`, no `ok`/`endpoint`/`transport` (TASK_CONTRACT §K.12).

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { catalogTasksOf, catalogTasksSourceOf, taskOf, uiTaskOf } from './task-map.js'

/** Append one record; logging never breaks a request. */
export async function appendInvocationRecord(config, record, log = () => {}) {
  if (!config?.invocationLog) return
  try {
    await mkdir(dirname(config.invocationLog), { recursive: true })
    await appendFile(config.invocationLog, `${JSON.stringify({ record: 'invocation', ...record })}\n`)
  } catch (error) {
    log(`dsh-dgx-audio: cannot write invocation log: ${error?.message ?? error}`)
  }
}

/** Deployment provenance of one model entry, as the capability document and results name it. */
export function modelProvenance(model) {
  return {
    upstreamModel: model.upstreamModel ?? model.id,
    task: taskOf(model),
    uiTask: uiTaskOf(model),
    catalogTasks: catalogTasksOf(model),
    catalogTasksSource: catalogTasksSourceOf(model),
    deploymentId: model.deploymentId ?? null,
  }
}

/**
 * A fail-fast refusal record.
 * @param {{ origin: 'adapter.stream' | 'live.open', code: string, message: string, httpStatus?: number, route: any, model: any,
 *   sessionId?: string, purpose?: string, activation?: { state: string, detail?: string }, details?: any }} info
 */
export function refusalRecord(info) {
  return {
    record: 'refusal',
    invocation: false,
    time: new Date().toISOString(),
    origin: info.origin,
    status: 'refused',
    code: info.code,
    message: String(info.message),
    ...(info.httpStatus === undefined ? {} : { httpStatus: info.httpStatus }),
    zeroUpstream: true,
    upstreamRequests: 0,
    sessionId: info.sessionId === undefined ? null : String(info.sessionId),
    ...(info.purpose === undefined ? {} : { purpose: info.purpose }),
    provider: info.route.provider,
    model: info.model.id,
    mode: info.model.mode,
    ...modelProvenance(info.model),
    liveId: null,
    activation: info.activation === undefined ? null : { state: info.activation.state, ...(info.activation.detail ? { detail: info.activation.detail } : {}) },
    ...(info.details === undefined ? {} : { details: info.details }),
  }
}
