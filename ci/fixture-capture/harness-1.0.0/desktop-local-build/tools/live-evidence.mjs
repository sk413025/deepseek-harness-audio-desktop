// Live-panel request log and per-connection control evidence for desktop-model-acceptance.mjs runLive().
// Written 2026-09-15 05:19 CST, host 0.4.5 FINAL_FROZEN sources added 05:31 CST (release lane, CPU-only). Design and limits:
// results/harness-macos-portable-audio-20260914/live-controls-design/LIVE_CONTROLS.md.
//
// Sources (read-only; line numbers are of the frozen packages):
//   host dsh-dgx-audio 0.4.5  PRIMARY. results/harness-streaming-transport-20260915/package-0.4.5/dsh-dgx-audio-0.4.5.tgz
//                             (sha256 51278da7…, FINAL_FROZEN 05:16) → package/src/live.js, routes.js; cited as "0.4.5 live.js:<n>".
//                             Control reply { controlId, sent, targetResponseId, outcome } (live.js:332-372), feed
//                             live.control.result (live.js:374-382), live.capability (live.js:240-247), live.playback.ack
//                             (live.js:619-624), live/close observations[] / controls[] / inputIntegrity (live.js:835-838).
//   host dsh-dgx-audio 0.4.2  fallback reference (package-0.4.2, sha256 bccc4afb…); 0.4.4 (package-0.4.4, 79744531…) has the same
//                             live control/ack code; cited as "0.4.2 live.js:<n>".
//   mic  dsh-voice-capture 0.3.0  parallel-work/microphone-ui/dist/dsh-voice-capture-0.3.0.tgz (364f4d73…) → lib/client.js;
//                             0.3.1 (061d8516…) has the same live call sites.
//
// Source preference for per-connection evidence: host outcome/observation records (0.4.5) first; the request-timing window and
// client-side ack posts are FALLBACKS for hosts that report none (< 0.4.5), and every result names the source it used.
//
// Nothing here talks to a model server. installLiveRequestLog runs in the Desktop page (serialized by liveRequestInstrumentation);
// every other export is a pure function over { epoch, e } feed events and the request log, so it is unit-tested offline.

/** Interrupt/cancel control types (host 0.4.2 live.js:332-338 barge-in → `barge_in`, cancel-response → `response.cancel`). */
export const INTERRUPT_CONTROL_TYPES = Object.freeze(['barge-in', 'cancel-response'])
/**
 * A cancelled response counts as caused by an interrupt control when it is observed between 50 ms before and 2000 ms after
 * the control request started (page clock for both: the feed reader and the request log both use Date.now() in the page).
 * The 50 ms lead absorbs event-loop ordering between the feed reader and fetch bookkeeping; it is not a causal claim.
 */
export const ATTRIBUTION_WINDOW_MS = Object.freeze({ beforeMs: 50, afterMs: 2000 })
/** Cancel reasons the host counts as barge-in (host 0.4.2 live.js:18; DGX SERVER_CONTRACT.md: turn_detected = server VAD). */
export const BARGE_IN_REASONS = Object.freeze(['barge_in', 'client_force_barge_in', 'client_overlap_action', 'turn_detected'])
/**
 * mic 0.3.0 turnDetection control: TaskStrip params row `data-testid=dsh-voice-capture-task-params` (client.js:3233-3246),
 * enum ParamControl `<select data-param=<key>>` (client.js:3495-3515). Rendered only for the Session's SELECTED model
 * (deriveFeatures client.js:3617; TaskStrip client.js:3155-3171), i.e. only when that model is the realtime entry itself.
 */
export const VAD_SELECT = '[data-testid=dsh-voice-capture-task-params] select[data-param=turnDetection]'
export const PARAMS_STATE = '[data-testid=dsh-voice-capture-task-params-state]'

// ---------------------------------------------------------------------------------------------------------------------------
// In-page request log

/**
 * Wrap the page's fetch and record live requests in globalThis.__dshLiveRequests. Observe-only: the original request object is
 * passed through untouched, except for the opt-in VAD hook (options.vadHook === 'fetch-rewrite') which adds
 * `turnDetection: 'server_vad'` to a live/open JSON body that has none, and records `vadInjectedByRunner: true` with the sent body.
 * The mic resolves the global fetch at call time (client.js:5986 `const fetchImpl = (input, init) => fetch(input, init)`), so a
 * wrapper installed after page load sees its live requests.
 * Routes (host 0.4.2 routes.js:331-344): live/open|control|close|text and session-params get { t, url, method, body, status,
 * response }; live/append gets { t, url, seq, byteLength, status } only (no PCM).
 * This function is serialized into the page: it must not reference module scope.
 */
export function installLiveRequestLog(options) {
  const g = globalThis
  if (Array.isArray(g.__dshLiveRequests) && g.__dshLiveRequestsInfo) return Object.assign({ installed: false, reason: 'already-installed' }, g.__dshLiveRequestsInfo)
  const log = []
  const info = { installedAt: Date.now(), vadHook: options && options.vadHook === 'fetch-rewrite' ? 'fetch-rewrite' : null, max: 6000, dropped: 0 }
  const original = g.fetch
  const ROUTE = /\/api\/dsh-dgx-audio\/v1\/(live\/(?:open|append|control|close|text)|session-params)(?:[?#]|$)/
  g.fetch = function dshLiveRequestLog(input, init) {
    let url = null
    try { url = typeof input === 'string' ? input : (input && typeof input.href === 'string') ? input.href : (input && typeof input.url === 'string') ? input.url : null } catch (e) { url = null }
    const match = url === null ? null : ROUTE.exec(url)
    if (match === null) return original.apply(g, arguments)
    const route = match[1]
    const entry = { t: Date.now(), route, url: url.slice(0, 400), method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(), liveId: null }
    let query = null
    try { query = new URL(url, g.location && g.location.href ? g.location.href : 'http://localhost/').searchParams } catch (e) { query = null }
    if (query !== null) entry.liveId = query.get('liveId')
    let args = arguments
    const body = init ? init.body : undefined
    if (route === 'live/append') {
      entry.seq = query !== null && query.get('seq') !== null ? Number(query.get('seq')) : null
      entry.byteLength = body == null ? null : typeof body.byteLength === 'number' ? body.byteLength : typeof body.size === 'number' ? body.size : null
    } else {
      if (typeof body === 'string') { try { entry.body = JSON.parse(body) } catch (e) { entry.bodyText = body.slice(0, 400) } } else if (body != null) entry.bodyUnread = true
      if (route === 'live/open' && info.vadHook === 'fetch-rewrite' && entry.body !== null && typeof entry.body === 'object' && entry.body.turnDetection === undefined) {
        const sent = Object.assign({}, entry.body, { turnDetection: 'server_vad' })
        entry.bodySent = sent
        entry.vadInjectedByRunner = true
        args = [input, Object.assign({}, init, { body: JSON.stringify(sent) })]
      }
    }
    if (log.length < info.max) log.push(entry); else info.dropped += 1
    const pending = original.apply(g, args)
    // Registered before the caller's await: the clone tees the body before the mic reads it.
    pending.then((res) => {
      entry.status = res.status
      entry.respondedAt = Date.now()
      if (route === 'live/append') return
      let copy
      try { copy = res.clone() } catch (e) { entry.responseError = 'clone: ' + e; return }
      copy.text().then((text) => {
        entry.responseReadAt = Date.now()
        try { entry.response = JSON.parse(text) } catch (e) { entry.responseText = String(text).slice(0, 400) }
      }, (e) => { entry.responseError = String(e) })
    }, (error) => { entry.error = String(error); entry.respondedAt = Date.now() })
    return pending
  }
  g.__dshLiveRequests = log
  g.__dshLiveRequestsInfo = info
  return Object.assign({ installed: true }, info)
}

/** Renderer expression for Runtime.evaluate. */
export function liveRequestInstrumentation(options = {}) {
  return `(${installLiveRequestLog.toString()})(${JSON.stringify({ vadHook: options.vadHook ?? null })})`
}

/** Renderer expression: the mic's turnDetection select, or null when the page shows none. */
export function probeVadControl() {
  return `(() => { const el = document.querySelector(${JSON.stringify(VAD_SELECT)}); if (!el) return null;
    return { value: el.value, options: [...el.options].map(o => o.value), disabled: el.disabled, paramsState: document.querySelector(${JSON.stringify(PARAMS_STATE)})?.getAttribute('data-state') ?? null } })()`
}

/**
 * Set the mic's turnDetection select to server_vad with trusted input: focus the control, then one CDP key press ("s", type-ahead).
 * A mouse press on a <select> in the packaged macOS app opens a native popup menu outside the page that CDP mouse events cannot
 * drive, so the option is chosen from the keyboard. The mic's onChange (client.js:3505-3507) stores the value and POSTs
 * session-params after 400 ms (setValue client.js:2786-2797, PARAMS_DEBOUNCE_MS client.js:2727); startLive posts it again
 * before live/open (client.js:6275-6280). Returns what was observed; never sets .value from script.
 * @param {{ evaluate: (expr: string) => Promise<any>, send: (method: string, params?: object) => Promise<any> }} p
 */
export async function selectServerVadViaUi(p, { timeoutMs = 5000 } = {}) {
  const sel = JSON.stringify(VAD_SELECT)
  const before = await p.evaluate(`(() => { const el = document.querySelector(${sel}); if (!el) return null; el.scrollIntoView({ block: 'center' }); el.focus();
    return { value: el.value, focused: document.activeElement === el, options: [...el.options].map(o => o.value), disabled: el.disabled } })()`)
  if (before === null) return { ok: false, reason: 'control-absent', selector: VAD_SELECT }
  const drive = { selector: VAD_SELECT, method: 'element focus + CDP Input.dispatchKeyEvent "s" (type-ahead on the focused <select>)', before, keyPresses: 0 }
  if (!before.options.includes('server_vad')) return { ...drive, ok: false, reason: 'server_vad not among the options' }
  if (before.value !== 'server_vad') {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', text: 's', unmodifiedText: 's', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 })
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 })
    drive.keyPresses = 1
  }
  const started = Date.now()
  let after = null
  while (Date.now() - started < timeoutMs) {
    after = await p.evaluate(`(() => { const el = document.querySelector(${sel}); return { value: el?.value ?? null, paramsState: document.querySelector(${JSON.stringify(PARAMS_STATE)})?.getAttribute('data-state') ?? null,
      sessionParamsPosts: (globalThis.__dshLiveRequests ?? []).filter(r => r.route === 'session-params' && r.body?.params?.turnDetection === 'server_vad').map(r => ({ t: r.t, status: r.status ?? null })) } })()`)
    if (after.value === 'server_vad' && (after.paramsState === 'applied' || after.paramsState === 'failed' || after.paramsState === 'unsupported')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return { ...drive, after, ok: after?.value === 'server_vad' && after?.paramsState === 'applied' && (after?.sessionParamsPosts ?? []).some(r => r.status === 200) }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Feed helpers

const iso = epoch => (Number.isFinite(epoch) ? new Date(epoch).toISOString() : null)
const isOk = entry => typeof entry?.status === 'number' && entry.status >= 200 && entry.status < 300 && entry.response?.ok !== false

/** Feed lines as written by the runner ({ atMs, line }) → { epoch, atMs, e }; lines cut at 600 chars do not parse and are counted. */
export function feedEvents(lines, t0) {
  const events = []
  let unparsed = 0
  for (const l of lines ?? []) {
    try { events.push({ epoch: t0 + l.atMs, atMs: l.atMs, e: JSON.parse(l.line) }) } catch { unparsed += 1 }
  }
  return { events, unparsed }
}

/**
 * Recorded feed.ndjson files do not store the reader's t0. The host `hello` event carries serverTime (same machine as the page),
 * so t0 ≈ serverTime − atMs of that line. Used only for offline replay; the runner itself has the exact t0.
 */
export function estimateFeedT0(lines) {
  for (const l of lines ?? []) {
    try {
      const e = JSON.parse(l.line)
      if (e.type === 'hello' && Number.isFinite(e.serverTime)) return { t0: e.serverTime - l.atMs, source: 'hello.serverTime - atMs (estimated)' }
    } catch {}
  }
  return { t0: 0, source: 'none (relative atMs only)' }
}

const liveEvents = (events, liveId) => (liveId ? (events ?? []).filter(x => x?.e?.liveId === liveId) : [])

/** liveId returned by the last successful live/open in the request log (host 0.4.2 routes.js:256-265). */
export function liveIdFromRequests(requests) {
  if (!Array.isArray(requests)) return null
  return requests.filter(r => r.route === 'live/open' && typeof r.response?.liveId === 'string').at(-1)?.response.liveId ?? null
}

const liveRequests = (requests, liveId, route) => (Array.isArray(requests) ? requests.filter(r => r.route === route && (route === 'live/open' ? r.response?.liveId === liveId : r.liveId === liveId)).sort((a, b) => a.t - b.t) : [])

/** Per-route request counts of one liveId (append: count, non-2xx, bytes; control: by type). */
export function requestCounts(requests, liveId) {
  if (!Array.isArray(requests)) return null
  const appends = liveRequests(requests, liveId, 'live/append')
  const controls = liveRequests(requests, liveId, 'live/control')
  const byType = {}
  for (const c of controls) { const k = String(c.body?.type ?? '?'); byType[k] = (byType[k] ?? 0) + 1 }
  return {
    open: liveRequests(requests, liveId, 'live/open').length,
    append: { count: appends.length, non2xx: appends.filter(a => !(a.status >= 200 && a.status < 300)).length, bytes: appends.reduce((s, a) => s + (a.byteLength ?? 0), 0), firstSeq: appends[0]?.seq ?? null, lastSeq: appends.at(-1)?.seq ?? null },
    control: byType,
    close: liveRequests(requests, liveId, 'live/close').length,
    sessionParams: requests.filter(r => r.route === 'session-params').length,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Host per-connection records (0.4.5): live/close reply, control outcomes, observations

/**
 * The live/close reply of one liveId from the request log: routes.js liveClose → session.close('client-close') → result
 * (0.4.5 live.js:827-846; 0.4.2 live.js:667-682). Error replies (LIVE_CLOSED, LIVE_NOT_FOUND) carry no liveId and are skipped.
 */
export function closeReply(requests, liveId) {
  return liveRequests(requests, liveId, 'live/close').filter(r => r.response !== null && typeof r.response === 'object' && r.response.liveId === liveId).at(-1)?.response ?? null
}

const defined = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))

/**
 * Host control records of one liveId merged by controlId (host ≥ 0.4.5). Precedence (later wins): control reply (outcome is
 * usually "pending": the mic does not send wait:true, client.js:4218-4224) < feed live.control.result (live.js:374-382) <
 * live/close controls[] (live.js:837). `reportsOutcomes` is false on 0.4.2/0.4.4, whose control reply is `{ ok: true }`.
 */
export function hostControlRecords({ events, requests, liveId }) {
  const byId = new Map()
  const put = (rec, source) => { const prev = byId.get(rec.controlId) ?? { sources: [] }; byId.set(rec.controlId, { ...prev, ...defined(rec), sources: [...prev.sources, source] }) }
  const replies = liveRequests(requests, liveId, 'live/control').filter(r => typeof r.response?.controlId === 'string')
  for (const r of replies) put({ controlId: r.response.controlId, type: r.body?.type ?? r.response.type, sent: r.response.sent, targetResponseId: r.response.targetResponseId ?? null, outcome: r.response.outcome, reason: r.response.reason, requestEpoch: r.t, requestAt: iso(r.t), status: r.status }, 'control reply')
  const results = liveEvents(events, liveId).filter(x => x.e.type === 'live.control.result' && typeof x.e.controlId === 'string')
  for (const x of results) put({ controlId: x.e.controlId, type: x.e.control, sent: x.e.sent, targetResponseId: x.e.targetResponseId ?? null, outcome: x.e.outcome, reason: x.e.reason, detail: x.e.detail, resultAt: iso(x.epoch) }, 'feed live.control.result')
  const close = closeReply(requests, liveId)
  const closeControls = Array.isArray(close?.controls) ? close.controls.filter(c => typeof c?.controlId === 'string') : []
  for (const c of closeControls) put({ controlId: c.controlId, type: c.type, sent: c.sent, targetResponseId: c.targetResponseId ?? null, outcome: c.outcome, reason: c.reason, detail: c.detail, staleError: c.staleError, resolvedAt: c.resolvedAt, at: c.at }, 'live/close controls[]')
  return { reportsOutcomes: replies.length > 0 || results.length > 0 || Array.isArray(close?.controls), records: [...byId.values()] }
}

/**
 * This connection's capability observations (host ≥ 0.4.5): live/close observations[] (live.js:836), else the feed
 * live.capability events (live.js:240-247). Entries: { key, state, source, detail, at, responseId?, implementationLevel? }.
 * Hosts < 0.4.5 have neither (source null); their capability document is deployment history (TASK_CONTRACT §K.9).
 */
export function connectionObservations({ events, requests, liveId }) {
  const close = closeReply(requests, liveId)
  if (Array.isArray(close?.observations)) return { source: 'live/close observations[]', entries: close.observations }
  const feed = liveEvents(events, liveId).filter(x => x.e.type === 'live.capability')
  if (feed.length > 0) return { source: 'feed live.capability', entries: feed.map(x => x.e) }
  return { source: null, entries: [] }
}

/** Per-connection capability verdicts from observations; `source: null` means the host reported none (use the legacy path). */
export function perConnectionCapabilities({ events, requests, liveId }) {
  const obs = connectionObservations({ events, requests, liveId })
  if (obs.source === null) return { source: null }
  const verifiedLive = key => obs.entries.filter(o => o.key === key && o.state === 'verified' && o.source === 'live')
  const close = closeReply(requests, liveId)
  const nativeLevel = obs.entries.some(o => o.key === 'fullDuplex' && o.implementationLevel === 'model_native_duplex') || close?.implementationLevel === 'model_native_duplex'
  const states = {}
  for (const o of obs.entries) (states[o.key] ??= []).push(`${o.state}/${o.source}`)
  return {
    source: obs.source,
    playbackAckVerified: verifiedLive('playbackAck').length > 0,
    fullDuplexVerified: verifiedLive('fullDuplex').length > 0,
    nativeDuplexVerified: verifiedLive('fullDuplex').length > 0 && nativeLevel,
    bargeInVerifiedResponseIds: verifiedLive('bargeIn').map(o => o.responseId ?? null),
    sessionResumeVerified: verifiedLive('sessionResume').length > 0,
    states,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// (a) Interrupt attribution

/**
 * Interrupt/cancel control posts of one liveId. mic 0.3.0 posts `{ type: "barge-in" }` from Interrupt (client.js:5823-5831) and
 * `{ type: "cancel-response" }` from Cancel reply (client.js:5815-5822), both via control() → post("control")
 * (client.js:4218-4224, 4554-4564), with no responseId. Host 0.4.2 replies `{ ok: true }` (0.4.2 live.js:303-313); host 0.4.5
 * replies { ok, controlId, type, sent, targetResponseId, outcome, reason? } (0.4.5 live.js:371).
 */
export function interruptControls(requests, liveId) {
  if (!Array.isArray(requests)) return null
  return liveRequests(requests, liveId, 'live/control').filter(r => INTERRUPT_CONTROL_TYPES.includes(r.body?.type)).map(r => ({
    type: r.body.type, at: iso(r.t), epoch: r.t, respondedAt: iso(r.respondedAt), status: r.status ?? null, ok: isOk(r),
    responseId: r.body.responseId ?? null, sent: typeof r.response?.sent === 'boolean' ? r.response.sent : null,
    controlId: r.response?.controlId ?? null, targetResponseId: r.response?.targetResponseId ?? null, outcome: r.response?.outcome ?? null,
  }))
}

const reasonClass = reason => (reason === 'turn_detected' ? 'server-vad' : reason === 'client_force_barge_in' || reason === 'client_overlap_action' ? 'client' : reason === 'barge_in' ? 'ambiguous (client or model overlap)' : reason === null || reason === undefined ? 'none' : 'other')

export const ATTRIBUTION_METHODS = Object.freeze({
  host: 'host control outcome (host >= 0.4.5, TASK_CONTRACT §K.10)',
  timing: 'request-timing window (FALLBACK: host reported no control outcomes, host < 0.4.5)',
  none: 'not attributable: no request log and no host control outcomes',
})

/**
 * Cancelled responses of this liveId (feed `live.response status=cancelled`, 0.4.5 live.js:597-617 / 0.4.2 live.js:488-500;
 * plus live/close responses[] with status cancelled, which has no timestamp) and what caused them.
 *
 * mode "host" (host ≥ 0.4.5 reports control outcomes — preferred):
 *   attributedToInterrupt = an interrupt control whose final outcome is "cancelled" and targetResponseId = that response, and,
 *   when this connection's observations are available, a verified bargeIn observation with that responseId (the §K.10 PASS rule).
 *   No timing window is used.
 * mode "timing" (request log present, host reports no outcomes — 0.4.2/0.4.4 FALLBACK):
 *   an accepted interrupt control (2xx, ok not false) started within [−50 ms, +2000 ms] of the cancel. Necessary, not sufficient.
 * mode "none": 'unknown'.
 */
export function attributeInterrupts({ events, requests, liveId, window = ATTRIBUTION_WINDOW_MS }) {
  const instrumented = Array.isArray(requests)
  const mine = liveEvents(events, liveId)
  const host = hostControlRecords({ events, requests, liveId })
  const obs = connectionObservations({ events, requests, liveId })
  const close = closeReply(requests, liveId)
  const mode = host.reportsOutcomes ? 'host' : instrumented ? 'timing' : 'none'
  const cancels = new Map()
  for (const c of mine.filter(x => x.e.type === 'live.response' && x.e.status === 'cancelled')) {
    cancels.set(c.e.responseId ?? null, { responseId: c.e.responseId ?? null, epoch: c.epoch, reason: c.e.reason ?? null, sources: ['feed live.response'] })
  }
  for (const r of Array.isArray(close?.responses) ? close.responses.filter(r => r?.status === 'cancelled') : []) {
    const prev = cancels.get(r.responseId)
    if (prev) prev.sources.push('live/close responses[]')
    // A response still open at close is marked cancelled with reason null (0.4.5 live.js:761-765): a close, not an interrupt.
    else if (r.reason !== null && r.reason !== undefined) cancels.set(r.responseId, { responseId: r.responseId, epoch: null, reason: r.reason, sources: ['live/close responses[]'] })
  }
  const controls = interruptControls(requests, liveId)
  const hostInterrupts = host.records.filter(r => INTERRUPT_CONTROL_TYPES.includes(r.type))
  const speechStarts = mine.filter(x => x.e.type === 'live.speech' && x.e.event === 'started')
  const pickHost = r => ({ controlId: r.controlId, type: r.type, sent: r.sent ?? null, targetResponseId: r.targetResponseId, outcome: r.outcome ?? null, reason: r.reason ?? null, requestAt: r.requestAt ?? null, sources: r.sources })
  const perCancel = [...cancels.values()].map((c) => {
    const base = { responseId: c.responseId, at: iso(c.epoch), epoch: c.epoch, reason: c.reason, reasonClass: reasonClass(c.reason), cancelSources: c.sources }
    if (mode === 'host') {
      const cancelledBy = hostInterrupts.filter(r => r.outcome === 'cancelled' && r.targetResponseId === c.responseId)
      const observation = obs.source === null ? null : obs.entries.some(o => o.key === 'bargeIn' && o.state === 'verified' && o.responseId === c.responseId)
      return { ...base, attributedToInterrupt: cancelledBy.length > 0 && observation !== false, method: ATTRIBUTION_METHODS.host, controls: cancelledBy.map(pickHost), bargeInObservation: observation, observationSource: obs.source }
    }
    if (mode === 'none') return { ...base, attributedToInterrupt: 'unknown', method: ATTRIBUTION_METHODS.none, control: null }
    if (c.epoch === null) return { ...base, attributedToInterrupt: false, method: ATTRIBUTION_METHODS.timing, control: null, note: 'cancel only in live/close responses[] (no time): not attributable by timing' }
    const candidates = controls
      .filter(k => k.ok && k.sent !== false)
      .map(k => ({ ...k, deltaMs: c.epoch - k.epoch }))
      .filter(k => k.deltaMs >= -window.beforeMs && k.deltaMs <= window.afterMs)
      .sort((a, b) => (a.deltaMs < 0) - (b.deltaMs < 0) || a.deltaMs - b.deltaMs)
    const control = candidates[0] ?? null
    const from = (control?.epoch ?? c.epoch) - window.afterMs
    return {
      ...base, attributedToInterrupt: control !== null, method: ATTRIBUTION_METHODS.timing, window,
      control: control === null ? null : { type: control.type, at: control.at, deltaMs: control.deltaMs, status: control.status },
      speechStartsInWindow: speechStarts.filter(s => s.epoch >= from && s.epoch <= c.epoch).length,
    }
  })
  const errorsFor = (controlId, epoch) => mine.filter(x => x.e.type === 'live.error' && ((controlId && x.e.controlId === controlId) || (Number.isFinite(epoch) && x.epoch >= epoch - window.beforeMs && x.epoch <= epoch + window.afterMs)))
    .map(x => ({ code: x.e.code ?? null, at: iso(x.epoch), controlId: x.e.controlId ?? null }))
  // Interrupts that cancelled nothing (e.g. the I4 catalog tail race: response completed, then stale_fence).
  const interruptsWithoutCancel = mode === 'host'
    ? hostInterrupts.filter(r => !(r.outcome === 'cancelled' && cancels.has(r.targetResponseId))).map(r => ({ ...pickHost(r), staleError: r.staleError ?? null, errorsWithin: errorsFor(r.controlId, r.requestEpoch) }))
    : (controls ?? []).filter(k => !perCancel.some(p => p.control?.at === k.at && p.control?.type === k.type)).map(k => ({ type: k.type, at: k.at, status: k.status, errorsWithin: errorsFor(null, k.epoch) }))
  return {
    mode, method: ATTRIBUTION_METHODS[mode], instrumented, window: mode === 'timing' ? window : null, interruptControls: controls, hostControls: hostInterrupts.map(pickHost),
    observationSource: obs.source, cancels: perCancel.length, attributedCancels: perCancel.filter(p => p.attributedToInterrupt === true).length, perCancel, interruptsWithoutCancel,
    interruptAttribution: perCancel.some(p => p.attributedToInterrupt === true) ? true : mode === 'none' ? 'unknown' : false,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// (b) Playback ack

/**
 * Playback acks of one liveId.
 * Client side (all hosts): mic 0.3.0 posts `{ type: "playback-ack", responseId, playedMs }` (client.js:4230-4238) every 500 ms
 * while the position changes (PLAYBACK_ACK_MS client.js:5975; timer client.js:6200-6207). playedMs is the output AudioContext
 * clock of the current stream (playedPosition client.js:4740-4751); streamId = responseId (audio-hub.js:237), so the clock
 * restarts for every response → monotonicity is checked per responseId.
 * Server side, preferred when present (host ≥ 0.4.5): feed live.playback.ack echo (0.4.5 live.js:621), verified playbackAck
 * observations (live.js:623 → close observations[]), control outcomes "acknowledged" (live.js:622). Host 0.4.2/0.4.4 forward the
 * ack (0.4.2 live.js:339-343) but publish no per-connection echo (0.4.2 live.js:506-509: shared capability store only).
 */
export function playbackAckEvidence({ events, requests, liveId }) {
  const mine = liveEvents(events, liveId)
  const feedResponses = new Set(mine.filter(x => x.e.type === 'live.response').map(x => x.e.responseId))
  const close = closeReply(requests, liveId)
  for (const r of Array.isArray(close?.responses) ? close.responses : []) feedResponses.add(r.responseId)
  const echoes = mine.filter(x => x.e.type === 'live.playback.ack')
  const obs = connectionObservations({ events, requests, liveId })
  const ackObservations = obs.entries.filter(o => o.key === 'playbackAck' && o.state === 'verified' && o.source === 'live')
  const host = hostControlRecords({ events, requests, liveId })
  const ackControls = host.records.filter(r => r.type === 'playback-ack')
  const serverAckIds = new Set([...echoes.map(x => x.e.responseId), ...ackObservations.map(o => o.responseId), ...ackControls.filter(r => r.outcome === 'acknowledged').map(r => r.targetResponseId)].filter(id => typeof id === 'string'))
  const perConnectionEvidence = echoes.length > 0 || obs.source !== null || host.reportsOutcomes
  const server = {
    available: perConnectionEvidence,
    sources: [...(echoes.length ? ['feed live.playback.ack'] : []), ...(ackObservations.length ? [obs.source] : []), ...(ackControls.some(r => r.outcome === 'acknowledged') ? ['control outcome acknowledged'] : [])],
    echoCount: echoes.length, lastEcho: echoes.length ? { responseId: echoes.at(-1).e.responseId ?? null, playedMs: echoes.at(-1).e.playedMs ?? null, committedMs: echoes.at(-1).e.committedMs ?? null, at: iso(echoes.at(-1).epoch) } : null,
    observations: ackObservations.length, acknowledgedControls: ackControls.filter(r => r.outcome === 'acknowledged').length, unconfirmedControls: ackControls.filter(r => r.outcome === 'unconfirmed').length,
    responseIds: [...serverAckIds],
  }
  if (!Array.isArray(requests)) {
    return { instrumented: false, basis: 'unknown: no request log for this run', count: null, server, verdict: perConnectionEvidence && serverAckIds.size > 0 ? 'server acked (client clock values not recorded)' : 'unknown' }
  }
  const posts = liveRequests(requests, liveId, 'live/control').filter(r => r.body?.type === 'playback-ack').map(r => ({
    at: iso(r.t), epoch: r.t, responseId: typeof r.body.responseId === 'string' ? r.body.responseId : null, playedMs: r.body.playedMs,
    numericClock: typeof r.body.playedMs === 'number' && Number.isFinite(r.body.playedMs) && r.body.playedMs >= 0, ok: isOk(r), status: r.status ?? null,
  }))
  const valid = posts.filter(a => a.ok && a.numericClock && a.responseId !== null)
  const groups = new Map()
  for (const a of valid) { if (!groups.has(a.responseId)) groups.set(a.responseId, []); groups.get(a.responseId).push(a) }
  const nonDecreasing = list => list.every((a, i) => i === 0 || a.playedMs >= list[i - 1].playedMs)
  const perResponse = [...groups.entries()].map(([responseId, list]) => ({ responseId, count: list.length, firstPlayedMs: list[0].playedMs, lastPlayedMs: list.at(-1).playedMs, nonDecreasing: nonDecreasing(list), inThisConnection: feedResponses.has(responseId), serverAcked: perConnectionEvidence ? serverAckIds.has(responseId) : null }))
  return {
    instrumented: true,
    basis: perConnectionEvidence ? 'client ack posts + server ack of the same responseId on this connection (host >= 0.4.5)' : 'client ack posts only (FALLBACK: host < 0.4.5 publishes no per-connection ack)',
    count: posts.length, okNumericCount: valid.length, rejected: posts.filter(a => !a.ok).map(a => ({ at: a.at, status: a.status })),
    first: valid[0] ? { responseId: valid[0].responseId, playedMs: valid[0].playedMs, at: valid[0].at } : null,
    last: valid.at(-1) ? { responseId: valid.at(-1).responseId, playedMs: valid.at(-1).playedMs, at: valid.at(-1).at } : null,
    nonDecreasingPerResponse: perResponse.every(r => r.nonDecreasing), nonDecreasingAcrossResponses: nonDecreasing(valid),
    acksForThisLiveResponses: valid.filter(a => feedResponses.has(a.responseId)).length,
    serverAckedClientResponses: perConnectionEvidence ? perResponse.filter(r => r.serverAcked).length : null,
    perResponse, server,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// (c) Server VAD and resume

/**
 * Server VAD for one liveId. Request side: host takes turnDetection from the live/open body, else from session-params, and
 * defaults overlap_policy to barge_in_on_speech on omni-duplex when none is given (0.4.2 live.js:142-149; 0.4.4 live.js:145-151; 0.4.5
 * live.js:147-153; realtime params tasks.js 0.4.2:33 / 0.4.4:41), so the runner never adds overlapPolicy. Feed side:
 * `live.speech { event: started|stopped|committed }` from input_audio_buffer.* (0.4.5 live.js:479-485; 0.4.2 live.js:386-391),
 * `live.response created`, cancel reason `turn_detected`. A native-duplex session without VAD also emits live.speech and answers
 * before End input, so the checks require a server turn end (live.speech stopped or committed) before End input, followed by a
 * response created before End input. Host 0.4.5 against the streaming lane's scripted VAD backend emits speech stopped without
 * committed (v045-evidence/mock-host-defaults-0.4.5/feed.jsonl), so both count; the I4 native run had neither before End input.
 * No host version echoes the effective turn_detection (live/open reply routes.js liveOpen; live.state ready 0.4.5 live.js:228).
 */
export function serverVadEvidence({ events, requests, liveId, endInputEpoch = null }) {
  const instrumented = Array.isArray(requests)
  const mine = liveEvents(events, liveId)
  const speech = mine.filter(x => x.e.type === 'live.speech')
  const count = name => speech.filter(x => x.e.event === name).length
  const open = instrumented ? liveRequests(requests, liveId, 'live/open').at(-1) : undefined
  const openSent = open?.bodySent ?? open?.body
  const sessionParams = instrumented ? requests.filter(r => r.route === 'session-params' && r.body?.params?.turnDetection === 'server_vad' && (open === undefined || r.t <= open.t)).map(r => ({ at: iso(r.t), status: r.status ?? null, ok: isOk(r), model: r.body?.model ?? null })) : []
  // End input = the mic's commit control (client.js:4210); fall back to the runner's click time.
  const commit = instrumented ? liveRequests(requests, liveId, 'live/control').find(r => r.body?.type === 'commit') : undefined
  const endInput = commit?.t ?? endInputEpoch ?? null
  const beforeEnd = x => endInput === null || x.epoch < endInput
  const turnEnds = speech.filter(x => (x.e.event === 'stopped' || x.e.event === 'committed') && beforeEnd(x))
  const firstTurnEnd = turnEnds[0]?.epoch ?? null
  const created = mine.filter(x => x.e.type === 'live.response' && x.e.status === 'created')
  const answered = created.filter(r => firstTurnEnd !== null && r.epoch >= firstTurnEnd && beforeEnd(r))
  return {
    instrumented,
    requestedIn: openSent?.turnDetection === 'server_vad' ? (open?.vadInjectedByRunner === true ? 'live/open body, added by the runner hook' : 'live/open body') : sessionParams.some(s => s.ok) ? 'session-params' : null,
    vadInjectedByRunner: open?.vadInjectedByRunner === true, openAccepted: open === undefined ? null : isOk(open), openBodySent: openSent ?? null, sessionParams,
    speech: { started: count('started'), stopped: count('stopped'), committed: count('committed') },
    endInputAt: iso(endInput), endInputSource: commit ? 'commit control request' : endInputEpoch !== null ? 'runner click time' : null,
    serverTurnEndsBeforeEndInput: turnEnds.length, firstServerTurnEndAt: iso(firstTurnEnd),
    responsesAfterServerTurnEndBeforeEndInput: answered.map(r => ({ responseId: r.e.responseId, at: iso(r.epoch) })),
    turnDetectedCancels: mine.filter(x => x.e.type === 'live.response' && x.e.status === 'cancelled' && x.e.reason === 'turn_detected').length,
  }
}

/**
 * Resume is passive only. Hosts 0.4.2–0.4.5 resume after the backend socket closes unexpectedly (realtime.js:178-183 →
 * 0.4.5 live.js:215, 712-746 / 0.4.2 live.js:207, 574-602); no route or control can close it (0.4.5 routes.js:371-384 handler
 * list; control types commit|barge-in|cancel-response|playback-ack, 0.4.5 live.js:400-427). 0.4.5 adds a sessionResume
 * observation (live.js:726).
 */
export function resumeEvidence({ events, requests, liveId }) {
  const mine = liveEvents(events, liveId)
  const close = closeReply(requests, liveId)
  const obs = connectionObservations({ events, requests, liveId })
  return {
    reconnecting: mine.filter(x => x.e.type === 'live.state' && x.e.state === 'reconnecting').length,
    resumed: mine.filter(x => x.e.type === 'live.state' && x.e.state === 'ready' && x.e.resumed === true).length,
    closeResume: close?.resume ?? null, closeSocketLosses: close?.socketLosses ?? null,
    sessionResumeObservations: obs.source === null ? null : obs.entries.filter(o => o.key === 'sessionResume').map(o => ({ state: o.state, source: o.source, at: o.at ?? null })),
    exercised: false, transportDropHook: 'none in host 0.4.2/0.4.4/0.4.5 (LIVE_CONTROLS.md §Resume)',
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Aggregate used by runLive

/**
 * @param {object} a
 * @param {{ epoch: number, e: any }[]} a.events  this case's feed events (page clock)
 * @param {any[] | null} a.requests               globalThis.__dshLiveRequests, or null when not instrumented
 * @param {string | null} a.liveId
 * @param {object} a.expect                       case expect (playbackAck, interrupt)
 * @param {object | null} a.vad                   runner VAD record { requested, via: 'ui'|'runner-hook'|'unavailable', uiDrive? }
 * @param {number | null} a.endInputEpoch
 * @returns {{ summary: object, checks: Record<string, boolean> }}
 */
export function liveControlEvidence({ events, requests, liveId, expect = {}, vad = null, endInputEpoch = null }) {
  const interrupt = attributeInterrupts({ events, requests, liveId })
  const playbackAck = playbackAckEvidence({ events, requests, liveId })
  const close = closeReply(requests, liveId)
  const host = hostControlRecords({ events, requests, liveId })
  const obs = connectionObservations({ events, requests, liveId })
  const summary = {
    liveId, instrumented: Array.isArray(requests),
    hostEvidence: { controlOutcomes: host.reportsOutcomes, observationsSource: obs.source, closeReply: close !== null, hostVersionHint: host.reportsOutcomes || obs.source !== null ? '>= 0.4.5' : close !== null ? '< 0.4.5 (close reply without controls[]/observations[])' : 'unknown' },
    requestCounts: requestCounts(requests, liveId), inputIntegrity: close?.inputIntegrity ?? null,
    errorsAttributedToControls: liveEvents(events, liveId).filter(x => x.e.type === 'live.error' && typeof x.e.controlId === 'string').map(x => ({ code: x.e.code ?? null, controlId: x.e.controlId, at: iso(x.epoch) })),
    interrupt, playbackAck, resume: resumeEvidence({ events, requests, liveId }), perConnectionCapabilities: perConnectionCapabilities({ events, requests, liveId }),
  }
  const checks = {}
  if (expect.playbackAck !== false) {
    const client = playbackAck.instrumented === true && playbackAck.okNumericCount >= 1 && playbackAck.nonDecreasingPerResponse && playbackAck.acksForThisLiveResponses >= 1
    checks.playbackAcksThisSession = client && (playbackAck.server.available ? playbackAck.serverAckedClientResponses >= 1 : true)
  }
  if (expect.interrupt) checks.interruptAttributed = interrupt.interruptAttribution === true
  if (vad?.requested === 'server_vad') {
    const v = serverVadEvidence({ events, requests, liveId, endInputEpoch })
    summary.serverVad = { via: vad.via, ...v }
    const suffix = vad.via === 'runner-hook' ? 'ViaRunnerHook' : ''
    if (vad.via === 'runner-hook') checks.serverVadViaRunnerHook = v.vadInjectedByRunner && v.openAccepted === true
    else checks.serverVadViaUi = vad.via === 'ui' && vad.uiDrive?.ok === true && v.sessionParams.some(s => s.ok) && v.openAccepted === true
    // Not requested at all (no UI control, no opt-in): feed-side VAD checks would describe a session without server VAD.
    if (vad.via !== 'ui' && vad.via !== 'runner-hook') return { summary, checks }
    checks[`serverVadTurnEndBeforeEndInput${suffix}`] = v.serverTurnEndsBeforeEndInput >= 1
    checks[`serverVadResponseAfterTurnEnd${suffix}`] = v.responsesAfterServerTurnEndBeforeEndInput.length >= 1
  }
  return { summary, checks }
}
