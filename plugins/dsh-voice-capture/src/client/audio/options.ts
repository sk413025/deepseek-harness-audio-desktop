/**
 * Option controls per task variant (TASK_CONTRACT §K.11, `dsh-audio/option-controls@1`, host ≥ 0.4.6).
 *
 * The host derives, per UI key, an obligation from the catalog variant's `requestOptionsMap` and publishes it as
 * `optionControls` on every capability entry. This module only reads that publication:
 * - a control renders only when `controls[].active` is true; `mandatory` true is required, `"conditional"` shows the
 *   `conditions` text; `offer-unverified` is labelled "not verified for this model"; `offer-restricted` shows the raw
 *   restriction (`requestOptionsMap[entries[].index].raw`);
 * - negatives (`rejected`, `rejected-conditional`, `unsupported`, `not-forwarded`, `ignored`, `conflict`) give no control;
 *   `unknown` is shown as unknown and `unlisted` is hidden — neither is ever called unsupported;
 * - `blockers[]` are required options the adapter cannot send as configured.
 *
 * Nothing is derived from `requestOptions` strings, from legacy `io` tri-states or from the library document. A host
 * without `optionControls` (< 0.4.6) leaves every catalog option unknown; only its deployment-configured values and
 * server-reported voices apply there (the 0.3.1 behaviour).
 */

/** §K.11 obligations. */
export type Obligation =
  | 'required' | 'required-conditional' | 'offer-restricted' | 'offer-unverified'
  | 'rejected-conditional' | 'rejected' | 'unsupported' | 'not-forwarded' | 'ignored' | 'conflict'
  | 'unknown' | 'unlisted'

const OBLIGATIONS: ReadonlySet<string> = new Set<Obligation>([
  'required', 'required-conditional', 'offer-restricted', 'offer-unverified', 'rejected-conditional', 'rejected',
  'unsupported', 'not-forwarded', 'ignored', 'conflict', 'unknown', 'unlisted',
])

/** Obligations that name an explicit negative (no usable control). */
export const NEGATIVE_OBLIGATIONS: ReadonlySet<Obligation> = new Set<Obligation>(['rejected-conditional', 'rejected', 'unsupported', 'not-forwarded', 'ignored', 'conflict'])

export const OPTION_CONTROLS_CONTRACT = 'dsh-audio/option-controls@1'

/** Where a variant's option facts came from. */
export type OptionSource = 'option-controls' | 'none'

/** One UI key of one variant. */
export interface OptionFact {
  readonly key: string
  readonly wire: string | undefined
  readonly kind: 'param' | 'attachment'
  readonly obligation: Obligation
  /** The only field that may turn a control on. */
  readonly active: boolean
  readonly mandatory: boolean | 'conditional'
  readonly reason: string | undefined
  /** Raw text of required-conditional entries and value-conditional rejections. */
  readonly conditions: readonly string[]
  /** Raw texts of the map entries that name this key. */
  readonly raw: readonly string[]
  /** Raw restriction text when the obligation is `offer-restricted`. */
  readonly restriction: string | undefined
  readonly delivery: 'final-header' | 'live.words' | undefined
  readonly note: string | undefined
  readonly deploymentDefault: boolean
}

/** A catalog option outside the controls: blocker, not sendable on this wire, unmapped, or set by the host. */
export interface OptionIssue {
  readonly option: string | undefined
  readonly wireKey: string | undefined
  readonly status: string | undefined
  readonly reason: string | undefined
  readonly raw: string | undefined
}

/** Option facts of one variant. */
export interface OptionFacts {
  readonly source: OptionSource
  readonly basis: 'catalog-map' | 'catalog-map-empty' | 'raw-only' | 'none' | undefined
  readonly family: string | undefined
  /** `requestOptionsScope` as published (e.g. why a list is empty). */
  readonly scope: string | undefined
  readonly byKey: Readonly<Record<string, OptionFact>>
  readonly blockers: readonly OptionIssue[]
  readonly notSendable: readonly OptionIssue[]
  readonly unmapped: readonly OptionIssue[]
  readonly hostOptions: readonly OptionIssue[]
  /** Fields the host dropped whole for violating the bounds. */
  readonly inputErrors: readonly { readonly field: string; readonly message: string }[]
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * Read a capability entry's option controls.
 * @param entry - capability entry facts: `optionControls`, `requestOptionsMap` (for raw texts), `requestOptionsScope`.
 * @returns facts; `source: none` when the host publishes no `optionControls@1`.
 */
export function optionFacts(entry: { readonly optionControls?: unknown; readonly requestOptionsMap?: unknown; readonly requestOptionsScope?: unknown }): OptionFacts {
  const oc = entry.optionControls as Record<string, unknown> | null | undefined
  if (oc?.contract !== OPTION_CONTROLS_CONTRACT || !Array.isArray(oc.controls)) {
    return { source: 'none', basis: undefined, family: undefined, scope: undefined, byKey: {}, blockers: [], notSendable: [], unmapped: [], hostOptions: [], inputErrors: [] }
  }
  const map = Array.isArray(entry.requestOptionsMap) ? entry.requestOptionsMap as unknown[] : []
  const rawAt = (index: unknown): string | undefined => (typeof index === 'number' ? text((map[index] as { raw?: unknown } | undefined)?.raw) : undefined)
  const byKey: Record<string, OptionFact> = {}
  for (const item of oc.controls as unknown[]) {
    const c = item as Record<string, unknown> | null
    if (typeof c?.key !== 'string') continue
    const known = typeof c.obligation === 'string' && OBLIGATIONS.has(c.obligation)
    const obligation: Obligation = known ? c.obligation as Obligation : 'unknown'
    const entries = Array.isArray(c.entries) ? c.entries as { index?: unknown; status?: unknown }[] : []
    const raw = entries.map(e => rawAt(e?.index)).filter((r): r is string => r !== undefined)
    const restricted = entries.filter(e => e?.status === 'listed-restricted').map(e => rawAt(e.index)).filter((r): r is string => r !== undefined)
    byKey[c.key] = {
      key: c.key,
      wire: text(c.wireKey),
      kind: c.kind === 'attachment' ? 'attachment' : 'param',
      obligation,
      // `active` alone turns a control on; an unrecognized, negative, unknown or unlisted obligation never does.
      active: c.active === true && known && !NEGATIVE_OBLIGATIONS.has(obligation) && obligation !== 'unknown' && obligation !== 'unlisted',
      mandatory: c.mandatory === true ? true : c.mandatory === 'conditional' ? 'conditional' : false,
      reason: text(c.reason),
      conditions: Array.isArray(c.conditions) ? c.conditions.filter((s): s is string => typeof s === 'string') : [],
      raw,
      restriction: obligation === 'offer-restricted' ? (restricted.join('; ') || undefined) : undefined,
      delivery: c.delivery === 'final-header' || c.delivery === 'live.words' ? c.delivery : undefined,
      note: text(c.note),
      deploymentDefault: c.deploymentDefault === true,
    }
  }
  const issues = (value: unknown): OptionIssue[] => (Array.isArray(value) ? value : []).map((item) => {
    const i = item as Record<string, unknown> | null
    return { option: text(i?.option), wireKey: text(i?.wireKey), status: text(i?.status), reason: text(i?.reason), raw: rawAt(i?.index) }
  })
  const basis = oc.basis === 'catalog-map' || oc.basis === 'catalog-map-empty' || oc.basis === 'raw-only' || oc.basis === 'none' ? oc.basis : undefined
  return {
    source: 'option-controls',
    basis,
    family: text(oc.family),
    scope: text(entry.requestOptionsScope),
    byKey,
    blockers: issues(oc.blockers),
    notSendable: issues(oc.notSendable),
    unmapped: issues(oc.unmapped),
    hostOptions: issues(oc.hostOptions),
    inputErrors: (Array.isArray(oc.inputErrors) ? oc.inputErrors : [])
      .map(e => e as { field?: unknown; message?: unknown } | null)
      .filter(e => typeof e?.field === 'string')
      .map(e => ({ field: String(e!.field), message: String(e!.message ?? '') })),
  }
}

/** How a control is offered. */
export type OfferState =
  | 'required' | 'required-conditional' | 'offered-restricted' | 'offered-unverified'
  | 'offered-configured' | 'offered-server'
  | 'not-offered' | 'unlisted' | 'unknown'

/**
 * Decide how a UI key is offered.
 * @param facts - option facts of the variant.
 * @param key - UI key.
 * @param configured - the deployment set a value (descriptor `default`); used only without `optionControls`.
 * @param serverChoices - the server reported non-empty choices (voices); used only without `optionControls`.
 * @returns offer state; only the `required*` and `offered-*` states render a control.
 */
export function offerFor(facts: OptionFacts, key: string, configured: boolean, serverChoices: boolean): OfferState {
  if (facts.source === 'option-controls') {
    const fact = facts.byKey[key]
    if (fact === undefined) return 'unknown'
    if (fact.active) {
      if (fact.mandatory === true) return 'required'
      if (fact.mandatory === 'conditional') return 'required-conditional'
      return fact.obligation === 'offer-restricted' ? 'offered-restricted' : 'offered-unverified'
    }
    if (NEGATIVE_OBLIGATIONS.has(fact.obligation)) return 'not-offered'
    return fact.obligation === 'unlisted' ? 'unlisted' : 'unknown'
  }
  // Host < 0.4.6: catalog support is unknown; only what the deployment configured or the server itself reports.
  if (configured) return 'offered-configured'
  if (serverChoices) return 'offered-server'
  return 'unknown'
}

/**
 * Whether an offer state renders a control.
 * @param offer - offer state.
 * @returns true when a control is shown.
 */
export function rendersControl(offer: OfferState): boolean {
  return offer === 'required' || offer === 'required-conditional' || offer === 'offered-restricted' || offer === 'offered-unverified' || offer === 'offered-configured' || offer === 'offered-server'
}

/**
 * Input need of an attachment slot from its control: active → optional (required when mandatory, or when the host's
 * own io already requires it); otherwise none.
 * @param facts - option facts.
 * @param key - attachment key.
 * @param ioNeed - the host's io tri-state for the same slot (it only tightens an active control, never enables one).
 * @returns need.
 */
export function slotNeed(facts: OptionFacts, key: string, ioNeed: 'none' | 'optional' | 'required'): 'none' | 'optional' | 'required' {
  const fact = facts.byKey[key]
  if (fact?.active !== true) return 'none'
  return fact.mandatory === true || ioNeed === 'required' ? 'required' : 'optional'
}
