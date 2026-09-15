// Host-side clients for the narrow server controller (CONTRACT §2).
//
// ssh: spawns the user's own ssh with an argv (no local shell); only validated tokens travel, so
//      the remote login shell (when no forced command is installed) sees no metacharacters.
// http: private endpoint with a bearer token read from an environment variable on this host.
// The renderer never sees credentials, hosts' shells or docker.

import { spawn } from 'node:child_process'
import { CONTROLLER_PROTOCOL } from './constants.js'
import { LibraryError } from './binding.js'

const TOKEN = /^[A-Za-z0-9._:@-]{1,64}$/
const MAX_OUTPUT = 4 * 1024 * 1024

function scrub(text) {
  return String(text ?? '').replace(/(hf_[A-Za-z0-9]{8,}|Bearer\s+\S+)/g, '[redacted]').slice(-600)
}

function checkArgs(args) {
  for (const arg of args) {
    if (!(TOKEN.test(arg) || arg === '--request' || arg === '--client')) throw new LibraryError('BAD_REQUEST', 'controller argument contains unsupported characters', 400)
  }
}

function parseReply(text, transport) {
  let body
  try {
    body = JSON.parse(String(text).trim().split('\n').at(-1) ?? '')
  } catch {
    throw new LibraryError('CONTROLLER_UNREACHABLE', `${transport} controller returned no JSON: ${scrub(text)}`, 502)
  }
  if (body?.ok === false) {
    const code = String(body.error?.code ?? 'CONTROLLER_ERROR')
    throw new LibraryError('CONTROLLER_REFUSED', body.error?.message ?? code, 409, { controllerCode: code, controllerError: body.error })
  }
  return body
}

/**
 * @param {{ sshBinary: string, destination: string, command: string, timeoutMs: number, spawnImpl?: typeof spawn }} options
 */
export function sshTransport(options) {
  const spawnImpl = options.spawnImpl ?? spawn
  return {
    kind: 'ssh',
    async call(args, signal) {
      checkArgs(args)
      const argv = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(3, Math.round(options.timeoutMs / 3000))}`, '-o', 'ServerAliveInterval=5', '-T', '--', options.destination, options.command, ...args]
      return new Promise((resolve, reject) => {
        const child = spawnImpl(options.sshBinary, argv, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value) } }
        const timer = setTimeout(() => { child.kill('SIGTERM'); finish(reject, new LibraryError('CONTROLLER_UNREACHABLE', `ssh ${options.destination} timed out after ${options.timeoutMs} ms`, 504)) }, options.timeoutMs)
        const onAbort = () => { child.kill('SIGTERM'); finish(reject, new LibraryError('ABORTED', 'controller call aborted', 499)) }
        signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > MAX_OUTPUT) child.kill('SIGTERM') })
        child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 64000) stderr = stderr.slice(-64000) })
        child.on('error', error => finish(reject, new LibraryError('CONTROLLER_UNREACHABLE', `cannot run ssh: ${error.message}`, 502)))
        child.on('close', (code) => {
          if (code === 255 && stdout.trim() === '') return finish(reject, new LibraryError('CONTROLLER_UNREACHABLE', `ssh ${options.destination} failed: ${scrub(stderr) || 'connection error'}`, 502))
          try {
            finish(resolve, parseReply(stdout, 'ssh'))
          } catch (error) {
            if (error.code === 'CONTROLLER_UNREACHABLE' && stderr) error.message += ` (${scrub(stderr)})`
            finish(reject, error)
          }
        })
      })
    },
  }
}

/**
 * @param {{ url: string, tokenEnv: string, timeoutMs: number, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} options
 */
export function httpTransport(options) {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const env = options.env ?? process.env
  const base = options.url.replace(/\/+$/, '')
  const request = async (method, path, body, signal) => {
    const token = env[options.tokenEnv]
    if (typeof token !== 'string' || token.trim() === '') throw new LibraryError('NOT_CONFIGURED', `controller token variable ${options.tokenEnv} is not set on this computer`, 409)
    let response
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token.trim()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs),
        redirect: 'error',
      })
    } catch (error) {
      throw new LibraryError('CONTROLLER_UNREACHABLE', `controller ${new URL(base).host} unreachable: ${error?.message ?? error}`, 502)
    }
    const text = await response.text()
    if (response.status === 401) throw new LibraryError('CONTROLLER_REFUSED', 'controller rejected the token', 409, { controllerCode: 'UNAUTHORIZED' })
    return parseReply(text, 'http')
  }
  return {
    kind: 'http',
    async call(args, signal) {
      checkArgs(args)
      const [command, target, ...rest] = args
      const options = {}
      for (let i = 0; i < rest.length; i += 2) options[rest[i]] = rest[i + 1]
      const ids = { ...(options['--request'] ? { requestId: options['--request'] } : {}), ...(options['--client'] ? { clientId: options['--client'] } : {}) }
      switch (command) {
        case 'status': return request('GET', '/v1/status', undefined, signal)
        case 'recipes': return request('GET', '/v1/recipes', undefined, signal)
        case 'catalog': return request('GET', '/v1/catalog', undefined, signal)
        case 'version': return request('GET', '/v1/version', undefined, signal)
        case 'job': return request('GET', `/v1/job?id=${encodeURIComponent(target)}`, undefined, signal)
        case 'health': return request('GET', `/v1/health?recipe=${encodeURIComponent(target)}`, undefined, signal)
        case 'activate':
        case 'deactivate': return request('POST', `/v1/${command}`, { recipeId: target, ...ids }, signal)
        case 'cancel': return request('POST', '/v1/cancel', { jobId: target }, signal)
        default: throw new LibraryError('BAD_REQUEST', `unsupported controller command ${command}`, 400)
      }
    },
  }
}

/** Build the transport for one server, or undefined in static mode. */
export function transportFor(server, config, deps = {}) {
  const controller = server.controller ?? { mode: 'none' }
  if (controller.mode === 'ssh') return sshTransport({ sshBinary: config.sshBinary, destination: controller.sshDestination, command: controller.sshCommand, timeoutMs: config.controllerTimeoutMs, spawnImpl: deps.spawn })
  if (controller.mode === 'http') return httpTransport({ url: controller.httpURL, tokenEnv: controller.tokenEnv, timeoutMs: config.controllerTimeoutMs, env: deps.env, fetchImpl: deps.fetch })
  return undefined
}

export function checkProtocol(body) {
  if (body?.protocol !== undefined && body.protocol !== CONTROLLER_PROTOCOL) {
    throw new LibraryError('CONTROLLER_REFUSED', `controller speaks ${body.protocol}, expected ${CONTROLLER_PROTOCOL}`, 409, { controllerCode: 'PROTOCOL_MISMATCH' })
  }
  return body
}
