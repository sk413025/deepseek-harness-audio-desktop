/**
 * Capability view of the Session's selected model (CONTRACT §2). The document
 * is read from the audio adapter's route; a missing route (404) means no
 * audio adapter is installed and every audio control stays hidden. States are
 * shown as reported — `declared`/`advertised` are never presented as tested.
 */
import { AudioRouteError, ROUTE_PREFIX, requestJson } from './api.ts'
import type { CapabilityDocument, CapabilityModel, CapabilityState, FetchLike } from './api.ts'
import type { LiveKind } from './live.ts'
import { taskView } from './tasks.ts'

/** Selected model identity from the `modelSelection` projection. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
}

/** One live session the user may open from the selected model's adapter route. */
export interface LiveCandidate {
  readonly model: ModelChoice
  readonly entry: CapabilityModel
  readonly kind: LiveKind
  /** Evidence of the input path: `liveInput` for audio, `audioOutputStreaming` for streamed text-to-speech. */
  readonly evidence: CapabilityState
  /** Whether the evidence allows offering it; `untested`/`unsupported` models are listed with the reason instead of hidden. */
  readonly available: boolean
  /** Adapter detail of that evidence (e.g. why it is unsupported). */
  readonly detail: string | undefined
}

/** Audio features available for one Session's next request. */
export interface AudioFeatures {
  readonly routes: 'unknown' | 'loading' | 'absent' | 'error' | 'ready'
  readonly configured: boolean
  readonly selection: ModelChoice | undefined
  /** Capability entry of the selected model; undefined when the adapter does not serve it. */
  readonly model: CapabilityModel | undefined
  /** Live input offered (declared, advertised or verified) for an explicit user choice. */
  readonly liveOffered: boolean
  /**
   * Model the live session opens: the selected model when it offers live input, otherwise a
   * realtime model of the same adapter route, so the closed exchange can be logged through the
   * selected chat model of that adapter.
   */
  readonly liveModel: ModelChoice | undefined
  /** Capability entry of {@link liveModel}. */
  readonly liveEntry: CapabilityModel | undefined
  /** Every live model of the route: offerable ones first (default = first), then untested/unsupported ones with their reason. */
  readonly liveCandidates: readonly LiveCandidate[]
  /** The selected model is live-only (`mode: realtime`): typed or recorded messages to it fail. */
  readonly liveOnly: boolean
  readonly liveState: CapabilityState
  readonly bargeInState: CapabilityState
  readonly fullDuplexState: CapabilityState
  readonly audioOutputStreamingState: CapabilityState
  readonly observedDelivery: 'none' | 'final-only' | 'progressive' | null
  readonly error: string | undefined
}

/** States that may be offered to the user (with their evidence label). */
const OFFERABLE: readonly CapabilityState[] = ['declared', 'advertised', 'verified']

/**
 * Derive the per-Session feature view.
 * @param doc - capability document, when loaded.
 * @param routes - route load state.
 * @param selection - selected model.
 * @param error - last load error text.
 * @returns immutable features.
 */
export function deriveFeatures(
  doc: CapabilityDocument | undefined,
  routes: AudioFeatures['routes'],
  selection: ModelChoice | undefined,
  error: string | undefined,
): AudioFeatures {
  const route = doc?.routes.find(entry => entry.provider === selection?.provider)
  const model = route?.models.find(entry => entry.id === selection?.model)
  const state = (name: keyof CapabilityModel['capabilities']): CapabilityState => model?.capabilities[name]?.state ?? 'unsupported'
  const candidate = (entry: CapabilityModel): LiveCandidate | undefined => {
    if (route === undefined) return undefined
    const view = taskView(entry)
    const textInput = view.live === 'text-input'
    if (entry.mode !== 'realtime' && view.live === 'none' && entry !== model) return undefined
    const facts = textInput ? entry.capabilities.audioOutputStreaming : entry.capabilities.liveInput
    const evidence = facts?.state ?? 'unsupported'
    const available = OFFERABLE.includes(evidence)
    // Non-realtime entries (the selected chat model) are only listed when they offer live input.
    if (!available && entry.mode !== 'realtime') return undefined
    const kind: LiveKind = view.live === 'none' ? (view.speaks ? 'conversation' : 'transcription') : view.live
    return { model: { provider: route.provider, model: entry.id }, entry, kind, evidence, available, detail: facts?.detail }
  }
  const listed = model === undefined || route === undefined
    ? []
    : [model, ...route.models.filter(entry => entry !== model && entry.mode === 'realtime')]
        .map(candidate)
        .filter((c): c is LiveCandidate => c !== undefined)
  const liveCandidates = [...listed.filter(c => c.available), ...listed.filter(c => !c.available)]
  const live = liveCandidates.find(c => c.available)?.entry
  const liveCapability = (name: keyof CapabilityModel['capabilities']): CapabilityState => live?.capabilities[name]?.state ?? 'unsupported'
  const liveState = liveCandidates.find(c => c.available)?.evidence ?? 'unsupported'
  return {
    routes,
    configured: doc?.configured ?? false,
    selection,
    model,
    liveOffered: live !== undefined,
    liveModel: live === undefined || route === undefined ? undefined : { provider: route.provider, model: live.id },
    liveEntry: live,
    liveCandidates,
    liveOnly: model?.mode === 'realtime',
    liveState,
    bargeInState: liveCapability('bargeIn'),
    fullDuplexState: liveCapability('fullDuplex'),
    audioOutputStreamingState: state('audioOutputStreaming'),
    observedDelivery: model?.capabilities.audioOutputStreaming?.observedDelivery ?? null,
    error,
  }
}

/** Shared capability document cache with per-Session feature sources. */
export class CapabilityDirectory {
  private doc: CapabilityDocument | undefined
  private routes: AudioFeatures['routes'] = 'unknown'
  private error: string | undefined
  private loading: Promise<void> | undefined
  private loadedAt = 0
  private readonly listeners = new Set<() => void>()

  /**
   * @param fetchImpl - page fetch.
   * @param now - wall clock in ms.
   * @param minRefreshMs - minimum spacing of automatic reloads.
   */
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = () => Date.now(),
    private readonly minRefreshMs = 10_000,
  ) {}

  /**
   * Load or reload the document (reads only; never triggers a server probe).
   * @param force - bypass the refresh spacing.
   * @returns completion.
   */
  load(force = false): Promise<void> {
    if (this.loading !== undefined) return this.loading
    if (!force && this.routes !== 'unknown' && this.now() - this.loadedAt < this.minRefreshMs) return Promise.resolve()
    if (this.routes === 'unknown') this.routes = 'loading'
    this.notify()
    this.loading = requestJson<CapabilityDocument>(this.fetchImpl, `${ROUTE_PREFIX}/capabilities`)
      .then((doc) => {
        this.doc = doc
        this.routes = 'ready'
        this.error = undefined
      }, (error: unknown) => {
        if (error instanceof AudioRouteError && error.status === 404) {
          this.routes = 'absent'
          this.doc = undefined
        } else {
          this.routes = this.doc === undefined ? 'error' : 'ready'
          this.error = error instanceof Error ? error.message : String(error)
        }
      })
      .finally(() => {
        this.loadedAt = this.now()
        this.loading = undefined
        this.notify()
      })
    return this.loading
  }

  /**
   * Feature source for one Session.
   * @param selection - observable model selection (`lastUsed`/`next`).
   * @returns identity-stable observable of {@link AudioFeatures}.
   */
  featuresFor(selection: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }): {
    getSnapshot(): AudioFeatures
    subscribe(listener: () => void): () => void
  } {
    let cached: { key: string; value: AudioFeatures } | undefined
    let lastChoiceKey: string | undefined
    const choice = (): ModelChoice | undefined => {
      const value = selection.getSnapshot() as { next?: ModelChoice | null; lastUsed?: ModelChoice | null } | undefined
      const picked = value?.next ?? value?.lastUsed ?? undefined
      return picked === undefined || picked === null ? undefined : { provider: picked.provider, model: picked.model }
    }
    return {
      getSnapshot: () => {
        const current = choice()
        const key = `${this.routes}|${this.loadedAt}|${this.error ?? ''}|${current?.provider ?? ''}/${current?.model ?? ''}`
        if (cached?.key !== key) cached = { key, value: deriveFeatures(this.doc, this.routes, current, this.error) }
        return cached.value
      },
      subscribe: (listener) => {
        this.listeners.add(listener)
        const stopSelection = selection.subscribe(() => {
          const current = choice()
          const choiceKey = `${current?.provider ?? ''}/${current?.model ?? ''}`
          if (choiceKey !== lastChoiceKey) {
            lastChoiceKey = choiceKey
            void this.load()
          }
          listener()
        })
        void this.load()
        return () => {
          this.listeners.delete(listener)
          stopSelection()
        }
      },
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
