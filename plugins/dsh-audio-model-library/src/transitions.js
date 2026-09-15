// Post-transition server state derived from a terminal controller job (CONTRACT §5.2, plugin 0.1.4).
//
// The controller reaches `ready` only after the target answered `/health` and listed its served models (the job's
// `health`), and it records every recipe it stopped (`history[phase=stopping].detail.recipes`) and restored
// (`restored[]`). Those facts are enough to know which recipe is live the moment the job ends, without waiting
// for another `status` round trip over SSH (seconds on a real server). The library applies this derived state in
// the same step that exposes the terminal job, so "Ready" in the UI, the adapter activation and the binding agree;
// the follow-up `status` only confirms (or corrects) it.

/**
 * @param {{ active?: any[] } | undefined} status last known controller status
 * @param {any} job terminal controller job
 * @param {any[]} recipes normalized recipes of that server
 * @returns {{ active: any[] }} status with `active` updated for this job
 */
export function statusAfterJob(status, job, recipes = []) {
  const base = status ?? { active: [], foreignWorkloads: [], switching: null }
  let active = (base.active ?? []).filter(a => a && typeof a.recipeId === 'string')
  const history = Array.isArray(job?.history) ? job.history : []
  const stopped = new Set(history.filter(h => h?.phase === 'stopping').flatMap(h => (Array.isArray(h.detail?.recipes) ? h.detail.recipes : [])))
  if (job?.kind === 'deactivate' && job.phase === 'stopped') stopped.add(job.recipeId)
  active = active.filter(a => !stopped.has(a.recipeId))
  const verified = (recipeId, detail) => {
    const recipe = recipes.find(r => r.id === recipeId)
    return {
      recipeId,
      port: recipe?.port ?? null,
      healthy: detail?.healthy !== false,
      modelsListed: detail?.modelsListed !== false,
      servedModels: recipe?.servedModels ?? [],
      derivedFromJob: job.jobId,
    }
  }
  if (job?.kind === 'activate') {
    if (job.phase === 'ready') {
      active = [...active.filter(a => a.recipeId !== job.recipeId), verified(job.recipeId, job.health)]
    } else if (history.some(h => h?.phase === 'starting')) {
      // failed or cancelled after starting: the controller stops the target (or could not); never ready from this job
      active = active.filter(a => a.recipeId !== job.recipeId)
    }
    for (const item of Array.isArray(job.restored) ? job.restored : []) {
      active = active.filter(a => a.recipeId !== item?.recipeId)
      if (item?.ok === true) active.push(verified(item.recipeId))
    }
  }
  return { ...base, active }
}
