/**
 * Reconnecting subscriber for `GET …/events?sessionId=&after=` (CONTRACT §3).
 * The NDJSON body is read incrementally; the last cursor is resent on
 * reconnect so audio already received is not replayed. Unsubscribing aborts
 * the fetch only; it never cancels generation.
 */
import { NdjsonDecoder, ROUTE_PREFIX, isRecord, routeUrl } from './api.ts'
import type { FetchLike } from './api.ts'

/** Feed connection state. */
export type FeedState = 'connecting' | 'open' | 'retrying' | 'absent' | 'closed'

/** Callbacks of one subscription. */
export interface FeedHandlers {
  /** One decoded event object with a string `type`. */
  onEvent(event: Record<string, unknown> & { type: string }): void
  /** Connection state changes. */
  onState(state: FeedState, detail?: string): void
}

/** Retry delays in ms; the last value repeats. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000]

/**
 * Subscribe to one Session's audio event feed until the returned disposer runs.
 * @param fetchImpl - page fetch.
 * @param sessionId - Session identity.
 * @param handlers - event and state callbacks.
 * @param sleep - delay function (injectable for tests).
 * @returns disposer that aborts the feed.
 */
export function subscribeAudioEvents(
  fetchImpl: FetchLike,
  sessionId: string,
  handlers: FeedHandlers,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
): () => void {
  const abort = new AbortController()
  let cursor: string | undefined
  void (async () => {
    let attempt = 0
    while (!abort.signal.aborted) {
      handlers.onState(attempt === 0 ? 'connecting' : 'retrying')
      const query = new URLSearchParams({ sessionId })
      if (cursor !== undefined) query.set('after', cursor)
      try {
        const response = await fetchImpl(routeUrl(`${ROUTE_PREFIX}/events?${query.toString()}`), {
          credentials: 'include',
          signal: abort.signal,
          headers: { accept: 'application/x-ndjson' },
        })
        if (response.status === 404) {
          handlers.onState('absent')
          return
        }
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        handlers.onState('open')
        attempt = 0
        const reader = response.body.getReader()
        const decoder = new NdjsonDecoder()
        for (;;) {
          const { value, done } = await reader.read()
          const batch = done ? decoder.end() : decoder.push(value)
          for (const item of batch.values) {
            if (!isRecord(item) || typeof item.type !== 'string') continue
            if (typeof item.cursor === 'string') cursor = item.cursor
            handlers.onEvent(item as Record<string, unknown> & { type: string })
          }
          if (done) break
        }
      } catch (error) {
        if (abort.signal.aborted) break
        handlers.onState('retrying', error instanceof Error ? error.message : String(error))
      }
      if (abort.signal.aborted) break
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
      attempt++
      try {
        await sleep(delay, abort.signal)
      } catch {
        // Aborted while waiting: the loop condition ends the subscription.
      }
    }
    handlers.onState('closed')
  })()
  return () => { abort.abort() }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}
