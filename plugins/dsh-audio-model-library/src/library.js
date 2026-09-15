// Library state: catalog + controller state per server, activation jobs, binding (CONTRACT §3, §5).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CONTRACT_VERSION, PLUGIN_NAME, PLUGIN_VERSION, TERMINAL_PHASES } from './constants.js'
import { advisoriesFor, normalizeCatalog, normalizeRecipe, recipesForRow, staticRow } from './catalog.js'
import { LibraryError, ServiceBinder, SettingsBinder, buildRoute, providerSlug, taskBindings } from './binding.js'
import { checkProtocol, transportFor } from './controller-client.js'
import { statusAfterJob } from './transitions.js'

const EVENT_BACKLOG = 200

function summarizeBusy(report) {
  return { total: report.total, live: report.items.filter(i => i.kind === 'live').length, requests: report.items.filter(i => i.kind !== 'live').length }
}
const iso = ms => new Date(ms).toISOString()

export class Library {
  /**
   * @param {object} deps
   * @param {() => any} deps.config resolved config
   * @param {() => any} deps.settings host settings service (may be undefined)
   * @param {() => any} [deps.dshAudio] dsh-dgx-audio ≥ 0.4 in-process service (may be undefined)
   * @param {(m: string) => void} [deps.log]
   * @param {(server: any, config: any) => any} [deps.transportFor]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? Date.now
    this.transportFor = deps.transportFor ?? ((server, config) => transportFor(server, config))
    this.readFile = deps.readFile ?? (file => readFile(file, 'utf8'))
    /** binding: last applied target; owned: settings route written by the library; runtimes: provider → runtime fingerprint */
    this.state = { version: 1, binding: null, owned: false, servers: {}, runtimes: {} }
    this.events = []
    this.cursor = 0
    this.listeners = new Set()
    this.polls = new Map()
    /** jobId being finalized per server (not persisted: a restart re-polls and finalizes again). */
    this.finalizing = new Map()
    /** transition finalizations in flight (including their confirming status), for whenIdle() */
    this.inflight = new Set()
    this.saving = Promise.resolve()
    this.disposed = false
    this.settingsBinder = new SettingsBinder({ settings: () => this.deps.settings(), provider: () => this.config.bindingProvider })
    this.serviceBinder = undefined
    this.loaded = this.load()
  }

  get config() { return this.deps.config() }
  get stateFile() { return join(this.config.stateDir, 'state.json') }

  async load() {
    try {
      const json = JSON.parse(await readFile(this.stateFile, 'utf8'))
      if (json?.version === 1) this.state = { version: 1, binding: json.binding ?? null, owned: json.owned === true, servers: json.servers ?? {}, runtimes: json.runtimes ?? {} }
    } catch { /* first run */ }
    this.syncService()
    // Continue tracking a transition the user started before a restart.
    for (const [serverId, entry] of Object.entries(this.state.servers)) {
      if (entry?.job && !TERMINAL_PHASES.includes(entry.job.phase) && this.server(serverId, false)) this.startPolling(serverId)
    }
  }

  persist() {
    const body = JSON.stringify(this.state, null, 2)
    const file = this.stateFile
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, body)
        await rename(tmp, file)
      } catch (error) {
        this.log(`dsh-audio-model-library: cannot save state: ${error?.message ?? error}`)
      }
    })
    return this.saving
  }

  dispose() {
    this.disposed = true
    for (const handle of this.polls.values()) clearTimeout(handle.timer)
    this.polls.clear()
    this.serviceBinder?.dispose()
    for (const listener of this.listeners) listener(null)
    this.listeners.clear()
  }

  // ------------------------------------------------------------------ binders
  binder() {
    const service = this.deps.dshAudio?.()
    if (service && String(service.contractVersion ?? '').startsWith('0.2') && typeof service.registerRouteSource === 'function') {
      if (this.serviceBinder?.service !== service) {
        this.serviceBinder?.dispose()
        this.serviceBinder = new ServiceBinder({ service, owner: PLUGIN_NAME, log: this.log })
      }
      return this.serviceBinder
    }
    if (this.serviceBinder) {
      this.serviceBinder.dispose()
      this.serviceBinder = undefined
    }
    return this.settingsBinder
  }

  providerFor(binder, server, recipe) {
    return binder.kind === 'service' ? `${this.config.bindingProvider}-${providerSlug(server.id)}-${providerSlug(recipe.id)}`.slice(0, 96) : this.config.bindingProvider
  }

  /** Demo focus (0.1.6): rows shown and recipes offered. Inactive when no rows are listed. */
  focus() {
    const focus = this.config.focus ?? { rows: [], recipes: [] }
    return { active: focus.rows.length > 0, rows: new Set(focus.rows), recipes: new Set(focus.recipes) }
  }

  recipeInFocus(recipe, focus = this.focus()) {
    if (!focus.active) return true
    return focus.recipes.size > 0 ? focus.recipes.has(recipe.id) : (recipe.catalogIds ?? []).some(id => focus.rows.has(id))
  }

  /** Service mode: every recipe with a bindable task is registered, with its activation state. */
  syncService() {
    const binder = this.binder()
    if (binder.kind !== 'service') return
    const routes = []
    const states = []
    const rows = this.catalogRows()
    for (const server of this.config.servers) {
      const entry = this.state.servers[server.id]
      if (!entry || !server.modelHost) continue
      const focus = this.focus()
      for (const recipe of entry.recipes ?? []) {
        // Focus: only the demo recipes register models, so the conversation model picker lists only them.
        if (!this.recipeInFocus(recipe, focus)) continue
        const served = [...rows.values()].filter(row => recipesForRow(row, [recipe]).length > 0 && row.role !== 'auxiliary_asset' && (!focus.active || focus.rows.has(row.id)))
        if (served.length === 0) continue
        let built
        try {
          built = buildRoute({ server, recipe, rows: served, features: binder.features, provider: this.providerFor(binder, server, recipe), referenceVoiceFile: this.config.referenceVoiceFile, allowEmpty: true })
        } catch { built = null }
        if (!built) continue
        routes.push(built.route)
        states.push({ provider: built.route.provider, models: built.route.models.map(m => m.id), activation: this.activationFor(server.id, recipe), runtime: recipe.runtime })
      }
    }
    binder.syncAll(routes)
    for (const item of states) {
      const fingerprint = JSON.stringify([item.runtime?.image ?? null, item.runtime?.imageDigest ?? null, item.runtime?.version ?? null, item.runtime?.runtimeCommit ?? null])
      if (this.state.runtimes[item.provider] !== undefined && this.state.runtimes[item.provider] !== fingerprint) binder.resetCapabilities(item.provider)
      this.state.runtimes[item.provider] = fingerprint
      binder.setActivation(item.provider, item.models, item.activation)
    }
  }

  activationFor(serverId, recipe) {
    const entry = this.state.servers[serverId]
    const job = entry?.job
    const active = (entry?.status?.active ?? []).find(a => a.recipeId === recipe.id)
    const runtime = recipe.runtime ?? {}
    if (job && !TERMINAL_PHASES.includes(job.phase)) {
      if (job.recipeId === recipe.id && job.kind === 'activate') {
        return { state: job.phase === 'queued' || job.phase === 'preflight' || job.phase === 'draining' ? 'queued' : 'activating', detail: job.phase, progress: { phase: job.phase, startedAt: job.createdAt, typicalLoadSeconds: job.typicalLoadSeconds ?? null }, runtime }
      }
      if ((job.previous ?? []).includes(recipe.id) || (job.kind === 'deactivate' && job.recipeId === recipe.id)) return { state: 'unloading', detail: job.phase, runtime }
    }
    if (active?.healthy && active?.modelsListed) return { state: 'ready', runtime }
    if (job?.recipeId === recipe.id && (job.phase === 'failed' || job.phase === 'refused')) return { state: 'failed', detail: job.error?.code ?? job.phase, runtime }
    return { state: 'cold', runtime }
  }

  // ------------------------------------------------------------------ events
  publish(event) {
    const entry = { ...event, cursor: ++this.cursor, t: this.now() }
    this.events.push(entry)
    if (this.events.length > EVENT_BACKLOG) this.events.shift()
    for (const listener of this.listeners) listener(entry)
  }

  subscribe({ after, signal } = {}) {
    const queue = this.events.filter(e => after === undefined || e.cursor > after)
    let wake
    const listener = (entry) => { queue.push(entry); wake?.() }
    this.listeners.add(listener)
    const cleanup = () => { this.listeners.delete(listener); wake?.() }
    signal?.addEventListener('abort', cleanup, { once: true })
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'hello', contractVersion: CONTRACT_VERSION, cursor: self.cursor, serverTime: self.now() }
        try {
          while (!signal?.aborted && !self.disposed) {
            if (queue.length === 0) {
              await new Promise((resolve) => {
                wake = resolve
                setTimeout(resolve, 15000).unref?.()
              })
              wake = undefined
              if (queue.length === 0) {
                if (!signal?.aborted && !self.disposed) yield { type: 'ping', t: self.now() }
                continue
              }
            }
            const next = queue.shift()
            if (next === null) return
            yield next
          }
        } finally {
          cleanup()
        }
      },
    }
  }

  // ------------------------------------------------------------------ lookup
  server(serverId, required = true) {
    const server = this.config.servers.find(s => s.id === serverId)
    if (server === undefined && required) throw new LibraryError('UNKNOWN_SERVER', `no configured server "${serverId}"`, 404)
    return server
  }

  entry(serverId) {
    this.state.servers[serverId] ??= { controller: { state: 'unknown', checkedAt: null }, status: null, recipes: [], catalog: null, catalogError: null, job: null, intent: null }
    return this.state.servers[serverId]
  }

  catalogRows() {
    const rows = new Map()
    for (const server of this.config.servers) {
      for (const row of this.state.servers[server.id]?.catalog?.rows ?? []) if (!rows.has(row.id)) rows.set(row.id, row)
    }
    return rows
  }

  // ------------------------------------------------------------------ document
  document() {
    const config = this.config
    const binder = this.binder()
    const rows = this.catalogRows()
    const out = [...rows.values()].map(row => this.rowView(row, binder))
    const known = new Set([...rows.values()].map(r => r.repo).filter(Boolean))
    const libraryProviders = new Set([config.bindingProvider])
    for (const route of this.settingsBinder.userRoutes()) {
      if (libraryProviders.has(route?.provider) && this.state.owned) continue
      for (const model of Array.isArray(route?.models) ? route.models : []) {
        const upstream = model.upstreamModel ?? model.id
        const staticRoute = { provider: route.provider, model: model.id, mode: model.mode ?? 'chat', baseURL: route.baseURL }
        const matching = out.filter(v => v.repo === upstream)
        for (const view of matching) {
          view.staticRoutes.push(staticRoute)
          if (view.residency === 'no-recipe') view.residency = 'static'
        }
        if (matching.length === 0 && !known.has(upstream)) {
          const view = this.rowView(staticRow(route, model), binder)
          view.residency = 'static'
          view.staticRoutes.push(staticRoute)
          out.push(view)
        }
      }
    }
    const focus = this.focus()
    return {
      contractVersion: CONTRACT_VERSION,
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      configured: config.servers.length > 0,
      focus: { active: focus.active, rows: [...focus.rows], recipes: [...focus.recipes], referenceVoiceConfigured: typeof config.referenceVoiceFile === 'string' },
      servers: config.servers.map((server) => {
        const entry = this.state.servers[server.id]
        return {
          id: server.id,
          displayName: server.displayName,
          modelHostConfigured: typeof server.modelHost === 'string' && server.modelHost !== '',
          controller: { mode: server.controller.mode, ...(entry?.controller ?? { state: 'unknown', checkedAt: null }) },
          switching: entry?.status?.switching ?? null,
          active: entry?.status?.active ?? [],
          foreignWorkloads: entry?.status?.foreignWorkloads ?? [],
          job: entry?.job ?? null,
          pending: entry?.intent ? { kind: entry.intent.kind, rowId: entry.intent.rowId ?? null, recipeId: entry.intent.recipeId, tasks: entry.intent.tasks ?? null } : null,
          bindingError: entry?.bindingError ?? null,
          recipeCount: entry?.recipes?.length ?? 0,
        }
      }),
      catalogs: config.servers.map((server) => {
        const entry = this.state.servers[server.id]
        const catalog = entry?.catalog
        return { serverId: server.id, source: catalog?.source ?? null, catalogVersion: catalog?.catalogVersion ?? null, completeness: catalog?.completeness ?? null, generatedAt: catalog?.generatedAt ?? null, rowCount: catalog?.rows.length ?? 0, error: entry?.catalogError ?? null }
      }),
      adapter: { present: binder.present, binding: binder.kind, features: [...binder.features] },
      binding: this.state.binding,
      rows: out,
    }
  }

  rowView(row, binder) {
    const recipes = []
    const matched = []
    for (const server of this.config.servers) {
      const entry = this.state.servers[server.id]
      for (const recipe of recipesForRow(row, entry?.recipes ?? []).filter(r => this.recipeInFocus(r))) {
        matched.push(recipe)
        const active = (entry?.status?.active ?? []).find(a => a.recipeId === recipe.id)
        const healthy = active?.healthy === true && active?.modelsListed === true
        let models = []
        let planError = null
        try {
          const built = buildRoute({ server, recipe, rows: [row], features: binder.features, provider: this.providerFor(binder, server, recipe), referenceVoiceFile: this.config.referenceVoiceFile, allowEmpty: true })
          models = built?.summary.models ?? []
        } catch (error) {
          planError = { code: error.code ?? 'INTERNAL', message: error.message }
        }
        const provider = this.providerFor(binder, server, recipe)
        const hostRefused = binder.refusedReason(provider)
        if (hostRefused !== null) {
          planError = { code: 'HOST_REFUSED', message: hostRefused }
          models = []
        }
        const bound = binder.kind === 'service'
          ? healthy
          : this.state.binding?.serverId === server.id && this.state.binding.recipeId === recipe.id && this.state.binding.state === 'bound'
        recipes.push({
          serverId: server.id,
          recipeId: recipe.id,
          displayName: recipe.displayName,
          runtime: recipe.runtime,
          port: recipe.port,
          typicalLoadSeconds: recipe.typicalLoadSeconds,
          memoryGiB: recipe.memoryGiB,
          active: active !== undefined,
          healthy,
          tasks: taskBindings(row, recipe, binder.features),
          activation: this.activationFor(server.id, recipe),
          provider,
          models,
          usable: bound && models.length > 0,
          notes: recipe.notes ?? null,
          performance: recipe.performance ?? null,
          endpointNotes: Object.fromEntries((recipe.endpoints ?? []).filter(e => typeof e.notes === 'string' && e.notes.trim() !== '').map(e => [e.task, e.notes.trim().slice(0, 2000)])),
          busy: binder.kind === 'service' ? summarizeBusy(binder.busy(provider)) : null,
          planError,
        })
      }
    }
    const preferred = recipes.find(r => r.healthy) ?? recipes[0]
    const residency = recipes.some(r => r.healthy) ? 'active' : recipes.some(r => r.active) ? 'loading' : recipes.length > 0 ? 'cold' : 'no-recipe'
    return {
      ...row,
      selectable: row.role !== 'auxiliary_asset',
      focused: this.focus().active ? this.focus().rows.has(row.id) : null,
      tasks: preferred ? preferred.tasks : taskBindings(row, null, binder.features),
      recipes,
      residency,
      advisories: advisoriesFor(row, matched),
      staticRoutes: [],
    }
  }

  // ------------------------------------------------------------------ refresh
  async refresh(serverId) {
    await this.loaded
    const servers = serverId ? [this.server(serverId)] : this.config.servers
    for (const server of servers) await this.refreshServer(server)
    this.publish({ type: 'library.updated' })
    return this.document()
  }

  async refreshServer(server, { catalog = true } = {}) {
    const entry = this.entry(server.id)
    const transport = this.transportFor(server, this.config)
    entry.controller = { state: transport ? 'checking' : 'none', checkedAt: iso(this.now()) }
    if (transport) {
      const jobBefore = entry.job
      try {
        const status = checkProtocol(await transport.call(['status']))
        const recipes = checkProtocol(await transport.call(['recipes']))
        entry.status = { active: status.active ?? [], foreignWorkloads: status.foreignWorkloads ?? [], switching: status.switching ?? null }
        entry.recipes = (recipes.recipes ?? []).map(normalizeRecipe).filter(Boolean)
        entry.controller = { state: 'reachable', checkedAt: iso(this.now()), version: status.controller?.version ?? null, serverId: status.controller?.serverId ?? null }
        // The status can be seconds old (SSH + health probes). It never replaces a job started or tracked meanwhile:
        // a running tracked job belongs to its poller, and its terminal state is exposed only by onTerminal.
        const tracking = entry.job && !TERMINAL_PHASES.includes(entry.job.phase)
        if (status.job && entry.job === jobBefore && !tracking) this.acceptJob(server.id, status.job)
        if (catalog) {
          const reply = await transport.call(['catalog'])
          if (reply.catalog) this.setCatalog(entry, reply.catalog, 'controller')
        }
      } catch (error) {
        entry.controller = { state: 'unreachable', checkedAt: iso(this.now()), error: { code: error.code ?? 'CONTROLLER_UNREACHABLE', message: error.message, ...(error.extra?.controllerCode ? { controllerCode: error.extra.controllerCode } : {}) } }
      }
    }
    if (catalog && entry.catalog?.source !== 'controller' && server.catalogFile) {
      try {
        this.setCatalog(entry, JSON.parse(await this.readFile(server.catalogFile)), 'file')
      } catch (error) {
        entry.catalogError = { code: 'CATALOG_UNREADABLE', message: String(error.message ?? error) }
      }
    }
    this.reconcileBinding(server.id)
    this.syncService()
    await this.persist()
  }

  setCatalog(entry, doc, source) {
    const result = normalizeCatalog(doc, source)
    if (!result.ok) {
      entry.catalogError = result.error
      return
    }
    entry.catalog = result.catalog
    entry.catalogError = null
  }

  /** A binding whose recipe is no longer active on its server becomes `stale` (route kept for the conversation). */
  reconcileBinding(serverId) {
    const binding = this.state.binding
    if (!binding || binding.serverId !== serverId) return
    const entry = this.state.servers[serverId]
    if (entry?.controller?.state !== 'reachable') return
    const active = (entry.status?.active ?? []).find(a => a.recipeId === binding.recipeId)
    const job = entry.job && !TERMINAL_PHASES.includes(entry.job.phase) ? entry.job : null
    const next = job ? 'switching' : active?.healthy && active?.modelsListed ? 'bound' : 'stale'
    if (binding.state !== next) {
      binding.state = next
      binding.stateChangedAt = iso(this.now())
      this.publish({ type: 'binding.state', binding })
    }
  }

  // ------------------------------------------------------------------ transitions
  resolveTarget(serverId, rowId, recipeId) {
    const server = this.server(serverId)
    const entry = this.entry(serverId)
    const row = this.catalogRows().get(rowId)
    if (row === undefined) throw new LibraryError('UNKNOWN_ROW', `catalog row ${rowId} is not loaded; refresh the library`, 404)
    if (row.role === 'auxiliary_asset') throw new LibraryError('TASK_NOT_BINDABLE', `${rowId} is an auxiliary asset, not a selectable model`, 409)
    const focus = this.focus()
    if (focus.active && !focus.rows.has(rowId)) throw new LibraryError('NOT_IN_FOCUS', `${rowId} is not one of the demo models configured in focus.rows`, 409)
    const candidates = recipesForRow(row, entry.recipes ?? []).filter(r => this.recipeInFocus(r, focus))
    let recipe
    if (recipeId) recipe = candidates.find(r => r.id === recipeId)
    else recipe = candidates.find(r => (entry.status?.active ?? []).some(a => a.recipeId === r.id)) ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (recipe === undefined) {
      if (candidates.length > 1 && !recipeId) throw new LibraryError('AMBIGUOUS_RECIPE', `${rowId} has ${candidates.length} runtimes on ${server.displayName}; choose one`, 409, { recipes: candidates.map(r => r.id) })
      throw new LibraryError('NO_RECIPE', `${server.displayName} has no recipe for ${rowId}`, 409)
    }
    return { server, entry, row, recipe }
  }

  plan(binder, server, recipe, row, tasks) {
    if (!binder.present) throw new LibraryError('ADAPTER_MISSING', 'dsh-dgx-audio is not installed or its settings are unavailable', 409)
    binder.checkOwnership(this.state.owned)
    return buildRoute({ server, recipe, rows: [row], tasks, features: binder.features, provider: this.providerFor(binder, server, recipe), referenceVoiceFile: this.config.referenceVoiceFile })
  }

  /** Work running on this server's library models on this host (service mode only). */
  localBusy(binder, server) {
    if (binder.kind !== 'service') return { supported: false, total: 0, items: [] }
    const entry = this.entry(server.id)
    const report = { supported: true, total: 0, items: [], providers: [] }
    for (const active of entry.status?.active ?? []) {
      const recipe = (entry.recipes ?? []).find(r => r.id === active.recipeId)
      if (!recipe) continue
      const provider = this.providerFor(binder, server, recipe)
      const busy = binder.busy(provider)
      report.total += busy.total
      report.items.push(...busy.items)
      report.providers.push(provider)
    }
    return report
  }

  async activate(body) {
    await this.loaded
    const binder = this.binder()
    const { server, entry, row, recipe } = this.resolveTarget(body.serverId, body.rowId, body.recipeId)
    const tasks = Array.isArray(body.tasks) ? body.tasks.filter(t => typeof t === 'string') : undefined
    this.plan(binder, server, recipe, row, tasks) // refuse before touching the server
    const transport = this.transportFor(server, this.config)
    if (!transport) throw new LibraryError('NOT_CONFIGURED', `${server.displayName} has no controller; its models are managed by the server administrator`, 409)
    if (entry.job && !TERMINAL_PHASES.includes(entry.job.phase) && !(entry.job.kind === 'activate' && entry.job.recipeId === recipe.id)) {
      throw new LibraryError('CONTROLLER_REFUSED', `a transition is already running on ${server.displayName}`, 409, { controllerCode: 'JOB_IN_PROGRESS', job: entry.job })
    }
    const alreadyReady = (entry.status?.active ?? []).some(a => a.recipeId === recipe.id && a.healthy && a.modelsListed)
    if (!alreadyReady) {
      const busy = this.localBusy(binder, server)
      if (busy.total > 0 && body.confirmCancelRunning !== true) {
        throw new LibraryError('LOCAL_BUSY', 'an audio turn or live session is still running on the current model; wait for it or confirm cancelling it', 409, { items: busy.items })
      }
      for (const provider of busy.providers ?? []) await binder.drain(provider, { cancel: body.confirmCancelRunning === true })
    }
    const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(body.requestId) ? body.requestId : `lib-${randomBytes(6).toString('hex')}`
    const reply = await transport.call(['activate', recipe.id, '--request', requestId, '--client', 'harness-model-library'])
    entry.intent = { jobId: reply.job.jobId, kind: 'activate', rowId: row.id, recipeId: recipe.id, tasks, requestId }
    if (TERMINAL_PHASES.includes(reply.job.phase)) {
      await this.onTerminal(server.id, reply.job)
      return { ok: true, job: this.entry(server.id).job, deduplicated: reply.deduplicated === true }
    }
    this.acceptJob(server.id, reply.job)
    if (this.state.binding?.serverId === server.id && this.state.binding.recipeId !== recipe.id) {
      this.state.binding.state = 'switching'
      this.publish({ type: 'binding.state', binding: this.state.binding })
    }
    this.syncService()
    await this.persist()
    this.startPolling(server.id)
    return { ok: true, job: this.entry(server.id).job, deduplicated: reply.deduplicated === true }
  }

  async deactivate(body) {
    await this.loaded
    const binder = this.binder()
    const server = this.server(body.serverId)
    const entry = this.entry(server.id)
    const transport = this.transportFor(server, this.config)
    if (!transport) throw new LibraryError('NOT_CONFIGURED', `${server.displayName} has no controller`, 409)
    const recipe = (entry.recipes ?? []).find(r => r.id === body.recipeId)
    if (!recipe) throw new LibraryError('NO_RECIPE', `${server.displayName} has no recipe ${body.recipeId}`, 404)
    if (binder.kind === 'service') {
      const provider = this.providerFor(binder, server, recipe)
      const busy = binder.busy(provider)
      if (busy.total > 0 && body.confirmCancelRunning !== true) throw new LibraryError('LOCAL_BUSY', 'an audio turn or live session is still running on this model', 409, { items: busy.items })
      await binder.drain(provider, { cancel: body.confirmCancelRunning === true })
    }
    const reply = await transport.call(['deactivate', recipe.id, '--client', 'harness-model-library'])
    entry.intent = { jobId: reply.job.jobId, kind: 'deactivate', recipeId: recipe.id }
    if (TERMINAL_PHASES.includes(reply.job.phase)) {
      await this.onTerminal(server.id, reply.job)
      return { ok: true, job: this.entry(server.id).job }
    }
    this.acceptJob(server.id, reply.job)
    this.syncService()
    await this.persist()
    this.startPolling(server.id)
    return { ok: true, job: this.entry(server.id).job }
  }

  async cancel(body) {
    await this.loaded
    const server = this.server(body.serverId)
    const transport = this.transportFor(server, this.config)
    if (!transport) throw new LibraryError('NOT_CONFIGURED', `${server.displayName} has no controller`, 409)
    const reply = await transport.call(['cancel', String(body.jobId)])
    if (TERMINAL_PHASES.includes(reply.job.phase)) {
      await this.onTerminal(server.id, reply.job)
      return { ok: true, job: this.entry(server.id).job }
    }
    this.acceptJob(server.id, reply.job)
    this.startPolling(server.id)
    return { ok: true, job: this.entry(server.id).job }
  }

  /** Bind an already active recipe without a transition (settings mode), or confirm it is usable (service mode). */
  async bind(body) {
    await this.loaded
    const binder = this.binder()
    const { server, entry, row, recipe } = this.resolveTarget(body.serverId, body.rowId, body.recipeId)
    const active = (entry.status?.active ?? []).find(a => a.recipeId === recipe.id)
    if (!(active?.healthy && active?.modelsListed)) throw new LibraryError('NOT_ACTIVE', `${recipe.displayName} is not active and healthy on ${server.displayName}; activate it first`, 409)
    const tasks = Array.isArray(body.tasks) ? body.tasks.filter(t => typeof t === 'string') : undefined
    return { ok: true, binding: await this.applyBinding(binder, server, recipe, row, tasks) }
  }

  async applyBinding(binder, server, recipe, row, tasks, { publish = true } = {}) {
    const { route, summary } = this.plan(binder, server, recipe, row, tasks)
    if (binder.kind === 'settings') {
      await binder.apply(route, this.state.owned)
      this.state.owned = true
    } else {
      this.syncService()
    }
    this.state.binding = { ...summary, rowId: row.id, tasks: tasks ?? null, binder: binder.kind, state: 'bound', appliedAt: iso(this.now()) }
    await this.persist()
    if (publish) this.publish({ type: 'binding.applied', binding: this.state.binding })
    this.log(`dsh-audio-model-library: ${binder.kind} binding ${recipe.id} → ${summary.provider} (${summary.models.map(m => m.id).join(', ')})`)
    return this.state.binding
  }

  async clearBinding(reason, { publish = true } = {}) {
    if (!this.state.binding) return null
    const binder = this.binder()
    if (binder.kind === 'settings') await binder.clear(this.state.owned)
    const previous = this.state.binding
    this.state.binding = null
    if (binder.kind === 'settings') this.state.owned = false
    await this.persist()
    if (publish) this.publish({ type: 'binding.cleared', reason, previous })
    return previous
  }

  acceptJob(serverId, job) {
    const entry = this.entry(serverId)
    const before = entry.job
    entry.job = job
    if (!before || before.jobId !== job.jobId || before.phase !== job.phase || before.updatedAt !== job.updatedAt || JSON.stringify(before.health) !== JSON.stringify(job.health)) {
      this.publish({ type: 'job.progress', serverId, job })
    }
  }

  startPolling(serverId) {
    if (this.polls.has(serverId) || this.disposed) return
    const handle = { timer: undefined, failures: 0 }
    this.polls.set(serverId, handle)
    const tick = async () => {
      if (this.disposed) return
      const server = this.server(serverId, false)
      const entry = this.state.servers[serverId]
      const transport = server && this.transportFor(server, this.config)
      if (!server || !transport || !entry?.job) { this.polls.delete(serverId); return }
      try {
        const reply = await transport.call(['job', entry.job.jobId])
        handle.failures = 0
        entry.controller = { ...entry.controller, state: 'reachable', checkedAt: iso(this.now()) }
        if (TERMINAL_PHASES.includes(reply.job.phase)) {
          this.polls.delete(serverId)
          // The terminal job is exposed only by onTerminal, together with the activation and binding it implies.
          await this.onTerminal(serverId, reply.job)
          return
        }
        this.acceptJob(serverId, reply.job)
        this.syncService()
      } catch (error) {
        handle.failures += 1
        entry.controller = { ...entry.controller, state: 'unreachable', checkedAt: iso(this.now()), error: { code: error.code ?? 'CONTROLLER_UNREACHABLE', message: error.message } }
        this.publish({ type: 'job.contact-lost', serverId, jobId: entry.job.jobId, failures: handle.failures, error: entry.controller.error })
      }
      await this.persist()
      const delay = Math.min(this.config.pollIntervalMs * 2 ** Math.min(handle.failures, 4), 30000)
      handle.timer = setTimeout(() => { void tick() }, delay)
    }
    handle.timer = setTimeout(() => { void tick() }, this.config.pollIntervalMs)
  }

  /**
   * Finish a transition (0.1.4). The terminal job, the adapter activation and the binding change together:
   *  1. derive the post-job status from the controller-verified job (target ready, stopped recipes gone) — no I/O;
   *  2. apply or clear the binding while the job is still shown in its last running phase (target `activating`,
   *     previous recipes `unloading`), so nothing reads "Ready" yet;
   *  3. in one synchronous step: expose the terminal job, reconcile the binding, push activations to the adapter,
   *     then publish — a prompt sent on the Ready event reaches the new model, and the old route is already cold;
   *  4. persist, then confirm with a live `status` (seconds over SSH); activation follows it if reality changed.
   * 0.1.1–0.1.3 exposed the terminal job first and derived activation from the stale pre-job status until the
   * refresh finished (I5 real R6/R7: MODEL_NOT_READY on the first turn after a switch).
   */
  onTerminal(serverId, job) {
    const work = this.finishTransition(serverId, job)
    this.inflight.add(work)
    return work.finally(() => { this.inflight.delete(work) })
  }

  /** Resolves when no transition is being finalized or confirmed (tests, shutdown, diagnostics). */
  async whenIdle() {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
    await this.saving
  }

  async finishTransition(serverId, job) {
    const entry = this.entry(serverId)
    if (this.finalizing.get(serverId) === job.jobId) return
    if (entry.job?.jobId === job.jobId && TERMINAL_PHASES.includes(entry.job.phase)) return
    this.finalizing.set(serverId, job.jobId)
    try {
      const server = this.server(serverId, false)
      const intent = entry.intent?.jobId === job.jobId ? entry.intent : null
      entry.status = statusAfterJob(entry.status, job, entry.recipes ?? [])
      entry.bindingError = null
      let applied = null
      let cleared = null
      try {
        if (intent?.kind === 'activate' && job.phase === 'ready' && server) {
          const { recipe, row } = this.resolveTarget(serverId, intent.rowId, intent.recipeId)
          applied = await this.applyBinding(this.binder(), server, recipe, row, intent.tasks, { publish: false })
        } else if (intent?.kind === 'deactivate' && job.phase === 'stopped' && this.state.binding?.serverId === serverId && this.state.binding.recipeId === intent.recipeId) {
          cleared = await this.clearBinding('deactivated', { publish: false })
        }
      } catch (error) {
        entry.bindingError = { code: error.code ?? 'BINDING_REJECTED', message: error.message, at: iso(this.now()) }
      }
      // ---- atomic exposure (no await between these lines)
      if (intent) entry.intent = null
      const before = entry.job
      entry.job = job
      this.reconcileBinding(serverId)
      this.syncService()
      if (!before || before.jobId !== job.jobId || before.phase !== job.phase) this.publish({ type: 'job.progress', serverId, job })
      if (applied) this.publish({ type: 'binding.applied', binding: applied })
      if (cleared) this.publish({ type: 'binding.cleared', reason: 'deactivated', previous: cleared })
      if (entry.bindingError) this.publish({ type: 'binding.failed', serverId, jobId: job.jobId, error: entry.bindingError })
      this.publish({ type: 'library.updated' })
      // ----
      await this.persist()
      if (server) {
        try { await this.refreshServer(server, { catalog: false }) } catch { /* reported in controller state */ }
        this.publish({ type: 'library.updated' })
      }
    } finally {
      if (this.finalizing.get(serverId) === job.jobId) this.finalizing.delete(serverId)
    }
  }
}
