/**
 * Browser client for the audio adapter's authenticated Fetch routes
 * (`parallel-work/streaming/CONTRACT.md` v0.1 §2–§6). Requests are relative
 * to the page origin, so Web (`http://…/api`) and Desktop
 * (`dsh-app://app/api`) share one code path and cookies/Connection auth ride
 * the same origin. The browser never contacts a model server.
 */

/** Route prefix owned by the audio adapter package. */
export const ROUTE_PREFIX = '/api/dsh-dgx-audio/v1'

/** Contract major/minor this client was written against. */
export const CONTRACT_VERSION = '0.1'

/** Capability evidence layers, weakest to strongest. */
export type CapabilityState = 'unsupported' | 'untested' | 'declared' | 'advertised' | 'verified'

/** One capability entry. */
export interface CapabilityEntry {
  readonly state: CapabilityState
  readonly source?: string
  readonly detail?: string
  readonly checkedAt?: string | null
  readonly evidence?: string
  readonly observedDelivery?: 'none' | 'final-only' | 'progressive' | null
  readonly implementationLevel?: string | null
}

/** Capability names defined by the contract. */
export type CapabilityName =
  | 'textStreaming' | 'audioOutput' | 'audioOutputStreaming' | 'liveInput'
  | 'fullDuplex' | 'bargeIn' | 'playbackAck' | 'sessionResume'

/** One model in the capability document. */
export interface CapabilityModel {
  readonly id: string
  readonly name?: string
  readonly mode: 'chat' | 'transcribe' | 'translate' | 'speech' | 'generate-audio' | 'realtime' | (string & {})
  readonly input?: { readonly formats?: readonly string[] }
  readonly output?: { readonly text?: boolean; readonly audio?: boolean }
  readonly capabilities: Partial<Record<CapabilityName, CapabilityEntry>>
  readonly limits?: { readonly maxAudioBytes?: number; readonly liveMaxSeconds?: number; readonly liveFrameMaxBytes?: number }
}

/** Capability document (`GET …/capabilities`). */
export interface CapabilityDocument {
  readonly contractVersion: string
  readonly configured: boolean
  readonly routes: readonly { readonly provider: string; readonly displayName?: string; readonly models: readonly CapabilityModel[] }[]
}

/** Business failure body shared by every route. */
export class AudioRouteError extends Error {
  /** Contract error code, or `HTTP_<status>` when the body carried none. */
  readonly code: string
  /** HTTP status. */
  readonly status: number

  /**
   * @param status - HTTP status.
   * @param code - contract error code.
   * @param message - human-readable detail.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AudioRouteError'
    this.status = status
    this.code = code
  }
}

/** Fetch implementation (the page `fetch`, replaceable in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Resolve a contract path against the page location.
 * @param path - absolute path beginning with `/api/`.
 * @param base - page URL (defaults to `location.href`).
 * @returns absolute URL string on the page origin.
 */
export function routeUrl(path: string, base: string = globalThis.location?.href ?? 'http://localhost/'): string {
  return new URL(path, base).toString()
}

/**
 * Call a JSON route and unwrap `{ ok:false, error }` bodies.
 * @param fetchImpl - fetch implementation.
 * @param path - route path including query.
 * @param init - request init.
 * @returns the parsed JSON body.
 * @throws {AudioRouteError} for non-2xx or `ok:false` bodies.
 */
export async function requestJson<T>(fetchImpl: FetchLike, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchImpl(routeUrl(path), { credentials: 'include', ...init })
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new AudioRouteError(response.status, `HTTP_${response.status}`, text.slice(0, 200))
  }
  const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined
  if (!response.ok || failure !== undefined) {
    throw new AudioRouteError(
      response.status,
      typeof failure?.code === 'string' ? failure.code : `HTTP_${response.status}`,
      typeof failure?.message === 'string' ? failure.message : response.statusText,
    )
  }
  return body as T
}

/**
 * Incremental NDJSON decoder: accepts arbitrary byte fragments and yields
 * one parsed object per complete `\n`-terminated line. Lines longer than
 * `maxLineBytes` and malformed JSON are reported, not thrown.
 */
export class NdjsonDecoder {
  private readonly decoder = new TextDecoder()
  private pending = ''

  /** @param maxLineBytes - upper bound for one buffered line (audio chunks are base64 PCM). */
  constructor(private readonly maxLineBytes = 8 * 1024 * 1024) {}

  /**
   * Feed bytes.
   * @param bytes - next fragment.
   * @returns decoded objects and parse errors in arrival order.
   */
  push(bytes: Uint8Array): { readonly values: unknown[]; readonly errors: string[] } {
    this.pending += this.decoder.decode(bytes, { stream: true })
    return this.drain(false)
  }

  /**
   * Flush the final unterminated line at end of stream.
   * @returns decoded objects and parse errors.
   */
  end(): { readonly values: unknown[]; readonly errors: string[] } {
    this.pending += this.decoder.decode()
    return this.drain(true)
  }

  private drain(final: boolean): { values: unknown[]; errors: string[] } {
    const values: unknown[] = []
    const errors: string[] = []
    let newline = this.pending.indexOf('\n')
    while (newline >= 0) {
      this.take(this.pending.slice(0, newline), values, errors)
      this.pending = this.pending.slice(newline + 1)
      newline = this.pending.indexOf('\n')
    }
    if (final && this.pending.trim() !== '') {
      this.take(this.pending, values, errors)
      this.pending = ''
    }
    if (this.pending.length > this.maxLineBytes) {
      errors.push(`line exceeds ${this.maxLineBytes} bytes`)
      this.pending = ''
    }
    return { values, errors }
  }

  private take(line: string, values: unknown[], errors: string[]): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    try {
      values.push(JSON.parse(trimmed))
    } catch {
      errors.push(`malformed line: ${trimmed.slice(0, 80)}`)
    }
  }
}

/**
 * Narrow an unknown value to a plain record.
 * @param value - candidate.
 * @returns whether it is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
