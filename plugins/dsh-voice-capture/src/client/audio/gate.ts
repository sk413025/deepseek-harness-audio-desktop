/**
 * Activation gate for the selected model. Two publishers can know the state:
 * the model-library client service `audioModelLibrary.status(provider, model)`
 * (library CONTRACT §6.1) and the adapter itself (capability `activation`,
 * refreshed by `model.state` feed events; TASK_CONTRACT 0.2 §C/§G). A request
 * is only offered when neither reports the model as unusable, so a cold,
 * loading, busy or switching model never receives audio meant for another one.
 */

/** Combined activation state shown by every send/live/generate control. */
export type GateState = (
  | { readonly state: 'unknown' | 'static' }
  | { readonly state: 'cold' | 'queued' | 'stopping' | 'loading' | 'activating' | 'unloading'; readonly progress?: number; readonly detail?: string }
  | { readonly state: 'ready'; readonly since?: string }
  | { readonly state: 'busy'; readonly reason?: string; readonly detail?: string }
  | { readonly state: 'error' | 'failed'; readonly code?: string; readonly message?: string; readonly detail?: string }
  /** The selected model only accepts Live sessions; chat requests to it fail. */
  | { readonly state: 'live-only' }
) & {
  /** Publisher that decided the state. */
  readonly source?: GateSource
  /** The model library can be opened to change it. */
  readonly library?: boolean
}

/** Which publisher decided the state. */
export type GateSource = 'library' | 'adapter'

/** Every state name a control may display. */
export const GATE_STATES = ['unknown', 'static', 'cold', 'queued', 'stopping', 'loading', 'activating', 'unloading', 'ready', 'busy', 'error', 'failed', 'live-only'] as const

const OPEN: ReadonlySet<string> = new Set(['ready', 'static', 'unknown'])

/**
 * Whether the state forbids sending to the model.
 * @param gate - combined state.
 * @returns true while the model is not usable.
 */
export function gateBlocks(gate: GateState): boolean {
  return !OPEN.has(gate.state)
}

/**
 * Parse an activation value from a capability entry (`activation` / `availability`) or a `model.state` event.
 * @param value - raw value.
 * @param source - publisher.
 * @returns the state, or undefined when the value carries none.
 */
export function parseGate(value: unknown, source: GateSource): GateState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const state = raw.state
  if (typeof state !== 'string' || !(GATE_STATES as readonly string[]).includes(state)) return undefined
  const text = (key: string) => (typeof raw[key] === 'string' && raw[key] !== '' ? { [key]: raw[key] as string } : {})
  const progress = typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? { progress: raw.progress } : {}
  return { state, source, ...text('detail'), ...text('reason'), ...text('code'), ...text('message'), ...text('since'), ...progress } as GateState
}

/**
 * Combine the library and adapter views: any blocking report wins (library first, it names the job);
 * otherwise a positive library report, then the adapter's.
 * @param library - library service state (undefined when the service is absent).
 * @param adapter - adapter activation state (undefined for hosts before 0.4.0).
 * @returns combined state.
 */
export function combineGate(library: GateState | undefined, adapter: GateState | undefined): GateState {
  const lib = library === undefined ? undefined : { ...library, source: 'library' as const }
  const host = adapter === undefined ? undefined : { ...adapter, source: 'adapter' as const }
  if (lib !== undefined && gateBlocks(lib)) return lib
  if (host !== undefined && gateBlocks(host)) return host
  if (lib !== undefined && lib.state !== 'unknown') return lib
  if (host !== undefined) return host
  return lib ?? { state: 'unknown' }
}

/**
 * Stable key for snapshot memoization.
 * @param gate - state.
 * @returns string key.
 */
export function gateKey(gate: GateState): string {
  return JSON.stringify(gate)
}

/** Observable value. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Subset of the model-library client service used here (library CONTRACT §6.1). */
export interface AudioModelLibraryFace {
  status(provider: string, model: string): Observable<unknown>
  document?(): Observable<unknown>
  open?(options?: { sessionId?: string; rowId?: string }): void
}

const modelKey = (provider: string, model: string): string => JSON.stringify([provider, model])

/**
 * Page-wide activation facts: the library service (looked up on every read, it may load after this
 * plugin) and adapter `model.state` events that arrived after the last capability document.
 */
export class ActivationBoard {
  private readonly events = new Map<string, { gate: GateState; at: number }>()
  private readonly listeners = new Set<() => void>()
  private librarySubscription: { face: AudioModelLibraryFace; stop: () => void } | undefined

  /**
   * @param library - current library service, if provided.
   * @param now - clock (ms).
   */
  constructor(private readonly library: () => AudioModelLibraryFace | undefined, private readonly now: () => number = () => Date.now()) {}

  /**
   * Apply a `model.state` feed event.
   * @param event - feed event.
   * @returns whether it named a model.
   */
  handleModelState(event: Record<string, unknown>): boolean {
    const provider = event.provider
    const model = event.model ?? event.modelId
    const gate = parseGate(event, 'adapter')
    if (typeof provider !== 'string' || typeof model !== 'string' || gate === undefined) return false
    this.events.set(modelKey(provider, model), { gate, at: this.now() })
    this.notify()
    return true
  }

  /**
   * Forget events that a capability document fetched after them already reflects.
   * @param since - fetch start time (ms).
   */
  documentLoaded(since: number): void {
    let changed = false
    for (const [key, entry] of this.events) {
      if (entry.at > since) continue
      this.events.delete(key)
      changed = true
    }
    if (changed) this.notify()
  }

  /** Re-read the library service (it was provided or removed). */
  libraryChanged(): void {
    this.syncLibrary()
    this.notify()
  }

  /**
   * Combined gate of one model.
   * @param provider - provider id.
   * @param model - model id.
   * @param entry - capability entry, when the adapter serves the model.
   * @returns state.
   */
  gate(provider: string, model: string, entry: object | undefined): GateState {
    let library: GateState | undefined
    try {
      library = parseGate(this.library()?.status(provider, model).getSnapshot(), 'library')
    } catch {
      library = undefined
    }
    const facts = entry as { readonly activation?: unknown; readonly availability?: unknown } | undefined
    const adapter = this.events.get(modelKey(provider, model))?.gate ?? parseGate(facts?.activation, 'adapter') ?? parseGate(facts?.availability, 'adapter')
    const combined = combineGate(library, adapter)
    return this.canOpenLibrary ? { ...combined, library: true } : combined
  }

  /**
   * Open the library view when the service is present.
   * @param sessionId - conversation to target.
   * @returns whether the library was opened.
   */
  openLibrary(sessionId: string): boolean {
    const face = this.library()
    if (face?.open === undefined) return false
    face.open({ sessionId })
    return true
  }

  /** Whether the library service can be opened. */
  get canOpenLibrary(): boolean {
    return this.library()?.open !== undefined
  }

  /**
   * @param listener - called on any activation change.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.syncLibrary()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.syncLibrary()
    }
  }

  private syncLibrary(): void {
    const face = this.listeners.size === 0 ? undefined : this.library()
    if (this.librarySubscription?.face === face) return
    this.librarySubscription?.stop()
    this.librarySubscription = undefined
    if (face === undefined) return
    try {
      const source = face.document?.() ?? face.status('', '')
      this.librarySubscription = { face, stop: source.subscribe(() => { this.notify() }) }
    } catch {
      // A failing library face leaves the adapter state in charge.
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
