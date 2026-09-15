/**
 * Duplex Live turn mode (streaming contract R-MIC-TURN-MODE, host dsh-dgx-audio ≥ 0.4.12 TASK_CONTRACT §K.18).
 * One mode choice replaces independent `turnDetection` / `overlapPolicy` controls for omni-duplex models:
 * native duplex (the model decides when to speak; nothing sent) or server VAD (`turnDetection: server_vad`; the host pairs
 * `barge_in_on_speech`). The mode that actually ran comes from the host's `turn` summary, never from the choice.
 */
import type { CapabilityModel } from './api.ts'

/** Parameter keys a mode choice owns for omni-duplex models (never offered as separate controls there). */
export const TURN_KEYS: ReadonlySet<string> = new Set(['turnDetection', 'overlapPolicy'])

/** One offered mode. `send` is exactly what the UI posts (sanitized to `turnDetection` only). */
export interface TurnModeOption {
  readonly mode: string
  readonly send: Readonly<Record<string, string>>
  readonly meaning: string | undefined
}

/** Modes a host offers for one omni-duplex model. */
export interface TurnModes {
  readonly default: string
  readonly modes: readonly TurnModeOption[]
  readonly refusalCode: string | undefined
}

/** What the host actually sent for a Live session (`turn` of live/open, `live.state ready`, `live/close`). */
export interface TurnSummary {
  readonly mode: string | undefined
  readonly turnDetection: string | undefined
  readonly turnDetectionSource: string | undefined
  readonly overlapPolicy: string | undefined
  readonly overlapPolicySource: string | undefined
  readonly nativeDuplexRequested: boolean | undefined
  readonly implementationLevel: string | undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * Parse the host's `turnModes` of a capability model.
 * @param entry - capability model.
 * @returns modes, or undefined when the host publishes none (host ≤ 0.4.11, other wires): then no mode choice is offered.
 */
export function turnModesOf(entry: CapabilityModel | undefined): TurnModes | undefined {
  const raw = (entry as { turnModes?: unknown } | undefined)?.turnModes as { default?: unknown; modes?: unknown; refusalCode?: unknown } | undefined
  if (raw === undefined || raw === null || typeof raw !== 'object' || !Array.isArray(raw.modes)) return undefined
  const modes: TurnModeOption[] = []
  for (const m of raw.modes as unknown[]) {
    const item = m as { mode?: unknown; send?: unknown; meaning?: unknown }
    const mode = str(item?.mode)
    if (mode === undefined || modes.some(x => x.mode === mode)) continue
    const send: Record<string, string> = {}
    const rawSend = item.send !== null && typeof item.send === 'object' ? item.send as Record<string, unknown> : {}
    // Only turnDetection is ever posted from this control; overlapPolicy stays host-paired (contract item 2).
    if (typeof rawSend.turnDetection === 'string') send.turnDetection = rawSend.turnDetection
    modes.push({ mode, send, meaning: str(item.meaning) })
  }
  if (modes.length === 0) return undefined
  const def = str(raw.default)
  return { default: def !== undefined && modes.some(m => m.mode === def) ? def : modes[0]!.mode, modes, refusalCode: str(raw.refusalCode) }
}

/**
 * Whether the separate `turnDetection` / `overlapPolicy` controls must be hidden for a model.
 * @param entry - capability model.
 * @returns true for omni-duplex realtime models (wire published, or `turnModes` present).
 */
export function ownsTurnKeys(entry: CapabilityModel | undefined): boolean {
  if (entry === undefined || entry.mode !== 'realtime') return false
  return turnModesOf(entry) !== undefined || (entry as { wire?: unknown }).wire === 'omni-duplex'
}

/**
 * Whether a parameter control is replaced by the turn mode choice (contract item 1).
 * @param entry - capability model.
 * @param key - parameter key.
 * @returns true for `turnDetection` / `overlapPolicy` of omni-duplex realtime models.
 */
export function hidesTurnParam(entry: CapabilityModel | undefined, key: string): boolean {
  return TURN_KEYS.has(key) && ownsTurnKeys(entry)
}

/**
 * The mode to use: the user's explicit choice when it is offered, else the host default.
 * @param modes - offered modes.
 * @param choice - user's choice for this model in this Session.
 * @returns the option.
 */
export function chosenTurnMode(modes: TurnModes, choice: string | undefined): TurnModeOption {
  return modes.modes.find(m => m.mode === choice) ?? modes.modes.find(m => m.mode === modes.default) ?? modes.modes[0]!
}

/**
 * Parse a host `turn` summary.
 * @param value - `turn` field.
 * @returns summary, or undefined when absent.
 */
export function turnSummaryOf(value: unknown): TurnSummary | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const t = value as Record<string, unknown>
  return {
    mode: str(t.mode), turnDetection: str(t.turnDetection), turnDetectionSource: str(t.turnDetectionSource),
    overlapPolicy: str(t.overlapPolicy), overlapPolicySource: str(t.overlapPolicySource),
    nativeDuplexRequested: typeof t.nativeDuplexRequested === 'boolean' ? t.nativeDuplexRequested : undefined,
    implementationLevel: str(t.implementationLevel),
  }
}

/** Label key for the mode that ran. */
export type TurnLabel = 'native-duplex' | 'server-vad' | 'no-turn-detection' | 'other' | 'unreported'

/**
 * Label of the mode that ran, from the host's summary only.
 * @param turn - host summary.
 * @returns label key (`unreported` when the host sent none).
 */
export function turnLabelOf(turn: TurnSummary | undefined): TurnLabel {
  if (turn?.mode === undefined) return 'unreported'
  return turn.mode === 'native-duplex' || turn.mode === 'server-vad' || turn.mode === 'no-turn-detection' ? turn.mode : 'other'
}
