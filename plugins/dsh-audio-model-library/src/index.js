// Cordis host entry for dsh-audio-model-library: catalog/controller state, activation jobs and the
// binding of an active model into dsh-dgx-audio. Dependency-free (Node built-ins only), so the
// same files load as a Web profile bundle row or a Desktop plugin package.

import { Library } from './library.js'
import { createRouteHandlers } from './routes.js'
import { ROUTE_PREFIX, SETTINGS_NS } from './constants.js'
import { definedEntries, loadSchemastery, resolveConfig, settingsSchema } from './config.js'

export { resolveConfig } from './config.js'
export { normalizeCatalog, TASK_GROUPS } from './catalog.js'
export { buildRoute, taskBindings } from './binding.js'

export const name = 'dsh-audio-model-library'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} rawConfig Loader row config; user settings layer over it.
 */
export function apply(ctx, rawConfig) {
  const rowConfig = rawConfig ?? {}
  let config = resolveConfig(rowConfig)
  const library = new Library({
    config: () => config,
    settings: () => ctx.get('settings'),
    dshAudio: () => ctx.get('dshAudio'),
    log: message => ctx.logger.info(message),
  })
  // dsh-dgx-audio ≥ 0.4.0 exposes `dshAudio` (TASK_CONTRACT v0.2 §C): register cold/ready models through it.
  ctx.inject(['dshAudio'], (serviceCtx) => {
    void library.loaded.then(() => library.syncService())
    serviceCtx.logger.info('dsh-audio-model-library: using the dshAudio route source')
  })
  ctx.effect(() => () => { library.dispose() }, 'dsh-audio-model-library: library state')

  if (config.httpRoutes) {
    ctx.inject(['connection'], (routeCtx) => {
      const handlers = createRouteHandlers({ library, log: message => routeCtx.logger.warn?.(message) ?? routeCtx.logger.info(message) })
      for (const route of handlers) routeCtx.effect(() => routeCtx.connection.fetch.register(route), `dsh-audio-model-library: ${route.path}`)
      routeCtx.logger.info(`dsh-audio-model-library: mounted ${handlers.length} routes under ${ROUTE_PREFIX}`)
    })
  }

  ctx.inject(['settings'], async (settingsCtx) => {
    const z = await loadSchemastery()
    if (z === undefined) {
      ctx.logger.info('dsh-audio-model-library: settings schema library not resolvable from this install; using row config only')
      return
    }
    let source = () => ({})
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NS, settingsSchema(z), {}, {
        validate: (value) => { resolveConfig({ ...rowConfig, ...definedEntries(value) }) },
        setSource: (current) => { source = current },
        onChange: () => {
          try {
            config = resolveConfig({ ...rowConfig, ...definedEntries(source()) })
            library.syncService()
            library.publish({ type: 'library.updated', reason: 'settings' })
          } catch (error) {
            ctx.logger.error(`dsh-audio-model-library: keeping previous configuration after a refused settings update: ${error?.message ?? error}`)
          }
        },
      })
    } catch (error) {
      ctx.logger.error(`dsh-audio-model-library: settings section unavailable: ${error?.message ?? error}`)
    }
  })
}
