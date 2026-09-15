// Plugin configuration (settings section `dsh-audio-model-library` layered over row config).
//
// No shipped server, host name, account, key or voice: a fresh install shows an empty library
// and contacts nothing until the user adds a server and presses Refresh.

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
// ssh destination: alias, host or user@host; never starts with '-' (option injection).
const SSH_DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,254}$/
// remote controller command: bare name or absolute path, safe characters only.
const SSH_COMMAND = /^(?:\/[A-Za-z0-9_.-]+)+$|^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]+\]$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/

export const CONFIG_DEFAULTS = Object.freeze({
  servers: Object.freeze([]),
  bindingProvider: 'dgx-library',
  referenceVoiceFile: undefined,
  stateDir: undefined, // default <DSH home>/dsh-audio-model-library
  sshBinary: '/usr/bin/ssh',
  controllerTimeoutMs: 30000,
  pollIntervalMs: 2000,
  adapterModes: undefined, // override when the adapter capability document cannot be read
  httpRoutes: true,
})

export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

function defined(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined && v !== ''))
}

function fail(message) {
  const error = new Error(`dsh-audio-model-library: ${message}`)
  error.code = 'BAD_CONFIG'
  throw error
}

/** @param {any} raw @param {{ env?: Record<string, string | undefined> }} [options] */
export function resolveConfig(raw = {}, options = {}) {
  const input = defined(raw)
  const config = { ...CONFIG_DEFAULTS, ...input }
  if (!PROVIDER.test(String(config.bindingProvider))) fail('bindingProvider must be a lowercase id')
  if (config.referenceVoiceFile !== undefined && !isAbsolute(String(config.referenceVoiceFile))) fail('referenceVoiceFile must be an absolute path')
  config.stateDir = config.stateDir === undefined ? join(dshHome(options.env), 'dsh-audio-model-library') : String(config.stateDir)
  if (!isAbsolute(config.stateDir)) fail('stateDir must be absolute')
  if (!isAbsolute(String(config.sshBinary))) fail('sshBinary must be absolute')
  if (!Array.isArray(config.servers)) fail('servers must be an array')
  const ids = new Set()
  config.servers = config.servers.map((rawServer) => {
    const server = defined(rawServer)
    if (!ID.test(String(server.id ?? ''))) fail('server.id must be a lowercase id (a-z, 0-9, -)')
    if (ids.has(server.id)) fail(`duplicate server id "${server.id}"`)
    ids.add(server.id)
    if (typeof server.displayName !== 'string' || server.displayName.trim() === '') fail(`server ${server.id} needs a displayName`)
    if (server.modelHost !== undefined && !HOST.test(String(server.modelHost))) fail(`server ${server.id} modelHost must be a host name or IP address`)
    const scheme = server.modelScheme ?? 'http'
    if (scheme !== 'http' && scheme !== 'https') fail(`server ${server.id} modelScheme must be http or https`)
    if (server.apiKeyEnv !== undefined && !ENV_NAME.test(String(server.apiKeyEnv))) fail(`server ${server.id} apiKeyEnv must be an environment variable name`)
    const controller = { mode: 'none', sshCommand: 'dsh-audio-ctl', ...defined(server.controller) }
    if (!['none', 'ssh', 'http'].includes(controller.mode)) fail(`server ${server.id} controller.mode must be none, ssh or http`)
    if (controller.mode === 'ssh') {
      if (!SSH_DESTINATION.test(String(controller.sshDestination ?? ''))) fail(`server ${server.id} controller.sshDestination must be an SSH alias or user@host`)
      if (!SSH_COMMAND.test(String(controller.sshCommand))) fail(`server ${server.id} controller.sshCommand must be a command name or absolute path`)
    }
    if (controller.mode === 'http') {
      let url
      try { url = new URL(String(controller.httpURL ?? '')) } catch { fail(`server ${server.id} controller.httpURL is not a URL`) }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`server ${server.id} controller.httpURL must be http(s)`)
      if (url.username || url.password) fail(`server ${server.id} controller.httpURL must not embed credentials`)
      if (!ENV_NAME.test(String(controller.tokenEnv ?? ''))) fail(`server ${server.id} controller.tokenEnv must name the environment variable holding the bearer token`)
    }
    if (server.catalogFile !== undefined && !isAbsolute(String(server.catalogFile))) fail(`server ${server.id} catalogFile must be an absolute path`)
    return { ...server, modelScheme: scheme, controller }
  })
  return config
}

export function settingsSchema(z) {
  const controller = z.object({
    mode: z.union(['none', 'ssh', 'http']).default('none').description('How to activate cold models: none (static endpoints), ssh (existing SSH access), http (private controller endpoint)'),
    sshDestination: z.string().description('SSH alias or user@host you already use for this server'),
    sshCommand: z.string().default('dsh-audio-ctl').description('Controller command on the server'),
    httpURL: z.string().description('Private controller URL, e.g. http://10.0.0.5:18190'),
    tokenEnv: z.string().role('credential-ref').description('Environment variable holding the controller bearer token'),
  })
  const server = z.object({
    id: z.string().required(),
    displayName: z.string().required(),
    modelHost: z.string().description('Host name or IP address clients use to reach model ports'),
    modelScheme: z.union(['http', 'https']).default('http'),
    apiKeyEnv: z.string().role('credential-ref').description('Environment variable holding the model API key; empty for keyless servers'),
    controller,
    catalogFile: z.string().description('Absolute path of an audio catalog JSON file (used when the controller has none)'),
  })
  return z.object({
    servers: z.array(server).default([]),
    bindingProvider: z.string().default('dgx-library').description('Provider id the library manages inside dsh-dgx-audio'),
    referenceVoiceFile: z.string().description('Absolute path of a voice prompt WAV you may use (realtime speech models)'),
  })
}

export async function loadSchemastery(importer = specifier => import(specifier)) {
  try {
    const mod = await importer('@deepseek-ai/schemastery')
    const z = mod?.default ?? mod
    return typeof z?.object === 'function' ? z : undefined
  } catch {
    return undefined
  }
}

export function definedEntries(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined))
}
