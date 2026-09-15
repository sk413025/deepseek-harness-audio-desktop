// Cordis plugin entry: registers the audio LlmAdapter, the /api/dsh-dgx-audio/v1/* routes consumed by the shared
// audio UI (CONTRACT.md, TASK_CONTRACT.md) and the in-process `dshAudio` service for the model-library plugin.
//
// Dependency-free on purpose (no @deepseek-ai/* imports) so the same files load as a Web profile bundle, a Desktop
// plugin package, or a path row.

import { join } from 'node:path'
import { DgxAudioAdapter } from './adapter.js'
import { taskOf } from './task-map.js'
import { AudioHub } from './audio-hub.js'
import { CapabilityRegistry } from './capabilities.js'
import { resolveConfig } from './config.js'
import { LiveSessionManager } from './live.js'
import { LiveTurnRegistry } from './live-turns.js'
import { createRouteHandlers } from './routes.js'
import { ROUTE_PREFIX } from './constants.js'
import { SETTINGS_NS, definedEntries, loadSchemastery, settingsSchema } from './settings.js'
import { ActivationStore, SERVICE_CONTRACT_VERSION, SessionParamsStore, WorkTracker } from './service.js'
import { ResultStore } from './results.js'

export { resolveConfig, MODEL_DEFAULTS, CONFIG_DEFAULTS, QWEN_OMNI_SYSTEM_PROMPT } from './config.js'

export const name = 'dsh-dgx-audio'
export const inject = ['llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} rawConfig - Loader row config; user settings (when available) layer over it.
 */
export function apply(ctx, rawConfig) {
  const plugin = createAudioPlugin({ rowConfig: rawConfig ?? {}, log: message => ctx.logger.info(message), logError: message => (ctx.logger.error ?? ctx.logger.info)(message), attachments: () => ctx.get('attachments'), fileUploads: () => ctx.get('fileUploads') })

  /** @type {any} */
  let registration
  const syncRegistration = () => {
    const providers = plugin.chatProviders()
    if (registration === undefined) {
      if (providers.length === 0) return
      registration = ctx.llm.registerAdapter(providers, plugin.adapter)
    } else {
      registration.replace(providers)
    }
    ctx.logger.info(`dsh-dgx-audio: serving ${providers.length === 0 ? 'no chat routes' : providers.join(', ')}`)
  }
  plugin.onRoutesChanged = syncRegistration
  ctx.effect(() => {
    syncRegistration()
    if (registration === undefined) ctx.logger.info('dsh-dgx-audio: no chat/transcribe routes configured; adapter not registered')
    return () => { registration?.(); registration = undefined }
  }, 'dsh-dgx-audio: adapter routes')
  ctx.effect(() => () => { plugin.dispose() }, 'dsh-dgx-audio: live sessions and audio feed')
  if (typeof ctx.provide === 'function') {
    ctx.effect(() => ctx.provide('dshAudio', plugin.service), 'dsh-dgx-audio: dshAudio service')
  }

  if (plugin.config().httpRoutes) {
    ctx.inject(['connection'], (routeCtx) => {
      const handlers = plugin.routes()
      for (const route of handlers) {
        routeCtx.effect(() => routeCtx.connection.fetch.register(route), `dsh-dgx-audio: ${route.path}`)
      }
      routeCtx.logger.info(`dsh-dgx-audio: mounted ${handlers.length} routes under ${ROUTE_PREFIX}`)
    })
  }

  ctx.inject(['settings'], async (settingsCtx) => {
    const z = await loadSchemastery()
    if (z === undefined) {
      ctx.logger.info('dsh-dgx-audio: settings schema library not resolvable from this install; using row config only')
      return
    }
    let source = () => ({})
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NS, settingsSchema(z), {}, {
        validate: value => { plugin.validateSettings(definedEntries(value)) },
        setSource: (current) => { source = current },
        onChange: () => {
          try {
            plugin.applySettings(definedEntries(source()))
          } catch (error) {
            ctx.logger.error(`dsh-dgx-audio: keeping previous configuration after a refused settings update: ${error?.message ?? error}`)
          }
        },
      })
    } catch (error) {
      ctx.logger.error(`dsh-dgx-audio: settings section unavailable: ${error?.message ?? error}`)
    }
  })
}

/**
 * Host-independent core (also used by tests): config layering, adapter, live sessions, routes and the dshAudio service.
 * @param {{ rowConfig: any, log: (m: string) => void, logError?: (m: string) => void, attachments?: () => any, fileUploads?: () => any, fetch?: typeof fetch, WebSocket?: typeof WebSocket }} options
 */
export function createAudioPlugin(options) {
  const rowConfig = options.rowConfig ?? {}
  const log = options.log
  let settingsValue = {}
  /** @type {Map<string, any[]>} ownerId → raw routes */
  const sources = new Map()
  const build = (settings = settingsValue, src = sources) => {
    const base = { ...rowConfig, ...settings }
    const sourceRoutes = [...src.values()].flat()
    return resolveConfig({ ...base, routes: [...(base.routes ?? []), ...sourceRoutes] })
  }
  let config = build()
  const originOf = (provider) => ([...sources.values()].some(routes => routes.some(r => r.provider === provider)) ? 'source' : 'static')

  const hub = new AudioHub({ outputDir: () => config.outputDir, log, limits: config.hubLimits })
  const listeners = new Set()
  const notify = (event) => { for (const l of listeners) { try { l(event) } catch (error) { log(`dsh-dgx-audio: dshAudio listener failed: ${error?.message ?? error}`) } } }
  const capabilities = new CapabilityRegistry({ file: () => config.capabilityFile || undefined, log })
  const observe = capabilities.observe.bind(capabilities)
  capabilities.observe = (route, model, key, observation) => { observe(route, model, key, observation); notify({ type: 'capabilities', provider: route.provider, modelId: model.id, key }) }
  const turns = new LiveTurnRegistry({ file: () => (config.capabilityFile ? join(config.outputDir, 'live-turns.json') : undefined), log })
  const ready = Promise.all([capabilities.load(), turns.load()])
  const work = new WorkTracker()
  const sessionParams = new SessionParamsStore()
  const activations = new ActivationStore()
  const activationOf = (provider, modelId) => activations.get(provider, modelId, originOf(provider))
  const results = new ResultStore({ outputDir: () => config.outputDir, log })
  const adapter = new DgxAudioAdapter({
    config: () => config,
    results,
    attachments: options.attachments ?? (() => undefined),
    log,
    hub: () => hub,
    capabilities,
    turns,
    fetch: options.fetch,
    activation: activationOf,
    sessionParams,
    work,
  })
  const live = new LiveSessionManager({ config: () => config, hub, capabilities, log, turns, fileUploads: options.fileUploads, WebSocket: options.WebSocket, activation: activationOf, sessionParams, work, recordRefusal: record => adapter.writeLog(config, record) })

  const modelKey = (route, model) => `${route.provider}/${model.id}|${route.baseURL}|${model.upstreamModel ?? model.id}|${model.mode}|${model.deploymentId ?? ''}|${JSON.stringify(model.realtime ?? null)}`
  const swap = async (next, reason) => {
    const before = new Map(config.routes.flatMap(route => route.models.map(model => [`${route.provider}\u0000${model.id}`, modelKey(route, model)])))
    const after = new Map(next.routes.flatMap(route => route.models.map(model => [`${route.provider}\u0000${model.id}`, modelKey(route, model)])))
    const changed = [...before.entries()].filter(([id, key]) => after.get(id) !== key).map(([id]) => id)
    const previous = config
    config = next // routes and Harness registration switch synchronously; session cleanup follows
    const providers = new Set(next.routes.map(r => r.provider))
    for (const route of previous.routes) if (!providers.has(route.provider)) activations.dropProvider(route.provider)
    for (const id of changed) {
      const [provider, modelId] = id.split('\u0000')
      work.cancel(item => item.provider === provider && item.model === modelId)
      sessionParams.dropModel(provider, modelId)
    }
    plugin.onRoutesChanged?.()
    notify({ type: 'routes-changed', changed: changed.map(id => id.replace('\u0000', '/')) })
    await Promise.all(changed.map((id) => {
      const [provider, modelId] = id.split('\u0000')
      return live.closeWhere(s => s.route.provider === provider && s.model.id === modelId, reason)
    }))
  }

  const service = {
    contractVersion: SERVICE_CONTRACT_VERSION,
    registerRouteSource(ownerId, routes) {
      if (typeof ownerId !== 'string' || ownerId === '') throw new Error('dshAudio.registerRouteSource: ownerId is required')
      if (sources.has(ownerId)) throw new Error(`dshAudio.registerRouteSource: owner ${ownerId} already registered; use replace()`)
      const apply = (list) => {
        const nextSources = new Map(sources)
        nextSources.set(ownerId, Array.isArray(list) ? list : [])
        const next = build(settingsValue, nextSources) // validates (duplicate providers throw) before any mutation
        sources.clear()
        for (const [k, v] of nextSources) sources.set(k, v)
        return swap(next, 'model-switched')
      }
      const initial = apply(routes)
      let disposed = false
      return {
        ready: initial,
        replace: (list) => { if (disposed) throw new Error('route source disposed'); return apply(list) },
        dispose: () => {
          if (disposed) return Promise.resolve()
          disposed = true
          const nextSources = new Map(sources)
          nextSources.delete(ownerId)
          const next = build(settingsValue, nextSources)
          sources.delete(ownerId)
          return swap(next, 'model-source-removed')
        },
      }
    },
    setActivation(provider, modelId, value) {
      const route = config.routes.find(r => r.provider === provider)
      if (route?.models.some(m => m.id === modelId) !== true) throw new Error(`dshAudio.setActivation: unknown model ${provider}/${modelId}`)
      const next = activations.set(provider, modelId, value)
      if (next.state !== 'ready') void live.closeWhere(s => s.route.provider === provider && s.model.id === modelId && next.state === 'unloading', 'model-switched')
      hub.broadcast({ type: 'model.state', provider, model: modelId, ...next })
      notify({ type: 'activation', provider, modelId, state: next.state })
      return next
    },
    resetCapabilities(provider, modelId) {
      const pairs = config.routes.filter(r => r.provider === provider).flatMap(route => route.models.filter(m => modelId === undefined || m.id === modelId).map(model => ({ route, model })))
      const removed = capabilities.reset(pairs)
      notify({ type: 'capabilities', provider, modelId: modelId ?? null, reset: removed })
      return { removed }
    },
    busy(provider) {
      const items = [
        ...work.list(provider).filter(i => i.kind !== 'auxiliary').map(({ cancel: _c, ...i }) => i),
        ...[...live.sessions.values()].filter(s => s.state !== 'closed' && (provider === undefined || s.route.provider === provider)).map(s => ({ kind: 'live', provider: s.route.provider, model: s.model.id, sessionId: s.sessionId, liveId: s.liveId })),
      ]
      return {
        chatRequests: items.filter(i => i.kind === 'chat' || i.kind === 'transcribe' || i.kind === 'translate').length,
        speechJobs: items.filter(i => i.kind === 'speech' || i.kind === 'generate-audio' || i.kind === 'generate-video' || i.kind === 'align').length,
        liveSessions: items.filter(i => i.kind === 'live').length,
        items,
      }
    },
    async drain(provider, { cancel = false, signal } = {}) {
      const route = config.routes.find(r => r.provider === provider)
      if (route === undefined) throw new Error(`dshAudio.drain: unknown provider ${provider}`)
      for (const model of route.models) service.setActivation(provider, model.id, { state: 'unloading', detail: 'draining' })
      if (cancel) {
        work.cancel(item => item.provider === provider)
        await live.closeWhere(s => s.route.provider === provider, 'model-switched')
      }
      await work.whenIdle(item => item.provider === provider && item.kind !== 'auxiliary', signal)
      while ([...live.sessions.values()].some(s => s.state !== 'closed' && s.route.provider === provider)) {
        signal?.throwIfAborted()
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return { drained: true }
    },
    describe: () => routeHandlers().describe(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }

  let handlersCache
  const routeHandlers = () => (handlersCache ??= createRouteHandlers({ config: () => config, hub, capabilities, live, adapter, results, log, activation: activationOf, sessionParams, work, fetch: options.fetch, WebSocket: options.WebSocket }))

  const plugin = {
    config: () => config,
    ready,
    adapter, hub, capabilities, live, work, sessionParams, service,
    onRoutesChanged: undefined,
    chatProviders: () => config.routes.filter(route => route.models.some(m => m.mode !== 'realtime')).map(route => route.provider),
    routes: () => routeHandlers(),
    validateSettings: (value) => { build(value, sources) },
    applySettings: (value) => { const next = build(value, sources); settingsValue = value; return swap(next, 'settings-changed') },
    dispose: () => { void live.closeAll('plugin-unload'); hub.dispose(); listeners.clear() },
    taskOf,
  }
  return plugin
}
