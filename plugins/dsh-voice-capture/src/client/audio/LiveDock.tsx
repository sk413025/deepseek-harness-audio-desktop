import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { clockText, cx } from '../format.ts'
import type { LiveDockProps } from '../slots.ts'
import type { LiveSnapshot } from './live.ts'
import { turnLabelOf } from './turn-mode.ts'
import type { TurnLabel } from './turn-mode.ts'
import css from './audio.module.css'

type EndedCode = 'IDLE_TIMEOUT' | 'RESYNC_REQUIRED' | 'RESUME_REJECTED' | 'BACKEND_DISCONNECTED'
const ENDED_CODES: ReadonlySet<string> = new Set<EndedCode>(['IDLE_TIMEOUT', 'RESYNC_REQUIRED', 'RESUME_REJECTED', 'BACKEND_DISCONNECTED'])

/** Seconds without any reply after input ended before the panel says so. */
const NO_REPLY_HINT_MS = 15_000

/**
 * Live panel: transmission state, buffering while connecting, server
 * acknowledgements, live text, responses and controls. The panel differs by
 * task: live transcription (text only, no Interrupt), duplex conversation
 * (Interrupt / Cancel reply), voice turns (speech replies, no Interrupt), and
 * streamed text-to-speech (text input instead of the microphone).
 */
export function LiveDock({
  t, useLive, useFeatures, endLiveInput, closeLive, liveControl, dismissLive, sendLiveText,
}: LiveDockProps) {
  const live = useLive(snapshot => snapshot)
  const bargeIn = useFeatures(features => features.bargeInState)
  const [text, setText] = useState('')
  const now = useTicker(live.phase === 'awaiting' || live.phase === 'live')
  if (live.phase === 'idle') return null
  const conversation = live.kind === 'conversation'
  const textInput = live.kind === 'text-input'
  // Audio sessions label the input path only: acknowledged frames prove delivery, not a working conversation.
  // Server acknowledgements on this host prove delivery of the input, nothing more.
  // This connection's own observation (live.capability, §K.9) wins over open-time document facts.
  const inputState = live.accepted > 0 || live.observed.liveInput?.state === 'verified' ? 'verified' : (live.observed.liveInput?.state ?? live.server?.liveInput?.state ?? live.evidence)
  const evidence = textInput ? t(`evidence.${live.evidence}`) : t(`live.input.${inputState}`)
  const duplex = live.observed.fullDuplex ?? live.server?.fullDuplex
  const nativeDuplex = duplex !== undefined && (duplex.state === 'advertised' || duplex.state === 'verified') && duplex.implementationLevel !== undefined
  const fallback = duplex !== undefined && duplex.state === 'unsupported'
  const bargeInState = live.observed.bargeIn?.state ?? live.server?.bargeIn?.state ?? bargeIn
  const openResponse = conversation && live.responses.some(response => response.status === 'created')
  // The turn mode that ran, from the host's summary only (never inferred from the choice or from native duplex facts).
  const turnLabel = turnLabelOf(live.turn)
  const bufferedSeconds = (live.queued * live.frameMs) / 1000
  const maxSeconds = (live.maxQueued * live.frameMs) / 1000
  const waitedMs = live.inputEndedAt === undefined ? 0 : now - live.inputEndedAt
  const noReplyYet = live.phase === 'awaiting' && live.responses.length === 0 && live.turns.length === 0 && waitedMs >= NO_REPLY_HINT_MS
  return (
    <section className={css.bar} aria-label={t(PANEL_LABEL[live.kind])} data-testid="dsh-voice-capture-live-panel" data-phase={live.phase} data-evidence={live.evidence} data-kind={live.kind} data-task={live.task}>
      <div className={cx(css.row, live.phase !== 'error' && css.nowrap)}>
        {live.phase === 'live' && <span className={css.recDot} aria-hidden="true" />}
        <span className={cx(css.title, live.phase === 'error' && css.wrapTitle)} aria-live="polite">
          {live.phase === 'opening' ? t(live.waitingMic ? 'live.waitingMic' : 'live.opening')
            : live.phase === 'live' ? t(LIVE_TITLE[live.kind])
              : live.phase === 'awaiting' ? t('live.awaiting')
                : live.phase === 'closing' ? t('live.closing')
                  : live.phase === 'closed' ? t('live.closed')
                    : t('live.error', { detail: errorText(live, t) })}
        </span>
        {(live.phase === 'live' || live.phase === 'awaiting') && !textInput && <span className={css.timer}>{clockText(live.elapsedMs)}</span>}
        {live.phase === 'live' && !textInput && (
          <span className={css.meter} role="meter" aria-label={t('level.label')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(live.level * 100)}>
            <span className={css.meterFill} style={{ transform: `scaleX(${live.level.toFixed(3)})` }} />
          </span>
        )}
        <span className={cx(css.caption, css.truncate, (textInput ? live.evidence : inputState) !== 'verified' && css.warn)} data-testid="dsh-voice-capture-live-evidence" data-state={textInput ? live.evidence : inputState}>{evidence}</span>
      </div>
      {conversation && live.phase !== 'opening' && live.phase !== 'error' && (
        <div
          className={cx(css.caption, !nativeDuplex && css.warn)}
          role="status"
          data-testid="dsh-voice-capture-live-duplex"
          data-state={duplex?.state ?? 'unreported'}
          data-level={duplex?.implementationLevel}
        >
          {nativeDuplex
            ? t('live.duplex.native', { level: duplex.implementationLevel ?? '' })
            : fallback
              ? t('live.duplex.fallback', { level: duplex.implementationLevel ?? duplex.detail ?? '' })
              : t('live.duplex.unknown')}
        </div>
      )}
      {conversation && live.liveId !== undefined && live.phase !== 'error' && (
        <div
          className={cx(css.caption, turnLabel === 'unreported' && css.warn)}
          role="status"
          data-testid="dsh-voice-capture-live-turn"
          data-mode={turnLabel}
          data-requested={live.requestedTurnMode ?? ''}
          data-turn-detection={live.turn?.turnDetection ?? ''}
          data-overlap-policy={live.turn?.overlapPolicy ?? ''}
        >
          {turnLabel === 'other' ? t('live.turn.label.other', { mode: live.turn?.mode ?? '' }) : t(`live.turn.label.${turnLabel as Exclude<TurnLabel, 'other'>}`)}
        </div>
      )}
      {live.phase === 'live' && !textInput && (
        <div className={cx(css.caption, live.framesAcked === 0 && css.warn)} role="status" data-testid="dsh-voice-capture-live-ready" data-ready={live.framesAcked > 0} data-queued={live.queued}>
          {live.framesAcked === 0
            ? t('live.buffering', { seconds: bufferedSeconds.toFixed(1), max: maxSeconds.toFixed(0) })
            : live.queued > 1
              ? `${t('live.speakNow')} · ${t('live.buffered', { seconds: bufferedSeconds.toFixed(1), max: maxSeconds.toFixed(0) })}`
              : t('live.speakNow')}
        </div>
      )}
      {live.phase !== 'opening' && live.phase !== 'error' && !textInput && (
        <div className={css.row}>
          <span className={css.caption} data-testid="dsh-voice-capture-live-stats" data-rejected={live.inputRejected}>
            {t('live.stats', { sent: live.framesSent, accepted: live.accepted })}
            {live.inputRejected > 0 && ` · ${t('live.rejectedFrames', { count: live.inputRejected })}`}
            {live.acceptedWhileCapturing > 0 && ` · ${t('live.acceptedEarly', { count: live.acceptedWhileCapturing })}`}
          </span>
        </div>
      )}
      {textInput && live.phase !== 'opening' && live.phase !== 'error' && (
        <div className={css.caption} data-testid="dsh-voice-capture-live-text-stats">{t('live.textStats', { count: live.textChunks })}</div>
      )}
      {live.phase === 'awaiting' && live.inputEndedAt !== undefined && (
        <div className={cx(css.caption, noReplyYet && css.warn)} role="status" data-testid="dsh-voice-capture-live-waiting" data-waited-ms={Math.round(waitedMs)}>
          {noReplyYet ? t('live.noReplyYet', { seconds: Math.round(waitedMs / 1000) }) : t('live.waitingFor', { seconds: Math.round(waitedMs / 1000) })}
        </div>
      )}
      {live.control !== undefined && (
        <div
          className={cx(css.caption, (live.control.outcome === 'error' || live.control.outcome === 'unconfirmed' || live.control.outcome === 'stale') && css.warn)}
          role="status"
          data-testid="dsh-voice-capture-live-control"
          data-type={live.control.type}
          data-outcome={live.control.outcome}
          data-confirmed={String(live.control.confirmed)}
          data-target={live.control.targetResponseId}
        >
          {controlText(live, t)}
        </div>
      )}
      {live.integrity !== undefined && (
        <div className={css.caption} data-testid="dsh-voice-capture-live-integrity" data-forwarded={live.integrity.framesForwarded} data-rejected={live.integrity.serverRejectedAppends}>
          {t('live.integrity', { delivered: Math.max(0, live.integrity.framesForwarded - live.integrity.serverRejectedAppends), forwarded: live.integrity.framesForwarded, rejected: live.integrity.serverRejectedAppends })}
        </div>
      )}
      {live.textParams !== undefined && (
        <div className={cx(css.caption, live.textParams.state === 'rejected' && css.warn)} role="status" data-testid="dsh-voice-capture-live-text-params" data-state={live.textParams.state} data-code={live.textParams.code}>
          {live.textParams.state === 'applied'
            ? t('live.textParamsApplied', { keys: Object.keys(live.textParams.params).join(', ') })
            : live.textParams.code === 'UTTERANCE_IN_PROGRESS' ? t('live.textParamsInUtterance') : t('live.textParamsRejected', { detail: `${live.textParams.code ?? ''} ${live.textParams.message ?? ''}`.trim() })}
        </div>
      )}
      {live.words.length > 0 && (
        <div className={css.caption} data-testid="dsh-voice-capture-live-words" data-sentences={live.words.length} data-words={live.words.reduce((n, w) => n + w.words.length, 0)}>
          {live.words.map((sentence, index) => (
            <div key={index} data-state={sentence.state}>
              {sentence.state === 'aligned'
                ? sentence.words.map(w => `${w.word} ${(w.startMs / 1000).toFixed(2)}`).join(' · ')
                : t(`live.words.${sentence.state === 'silence' ? 'silence' : 'failed'}`)}
            </div>
          ))}
        </div>
      )}
      {live.reconnecting && <div className={cx(css.caption, css.warn)} role="status" data-testid="dsh-voice-capture-live-reconnecting">{t('live.reconnecting')}</div>}
      {live.resumes > 0 && !live.reconnecting && <div className={css.caption} data-testid="dsh-voice-capture-live-resumed">{t('live.resumed', { count: live.resumes })}</div>}
      {live.phase === 'closed' && live.error !== undefined && (
        <div className={cx(css.caption, css.warn)} role="status" data-testid="dsh-voice-capture-live-ended" data-code={live.error.code}>
          {ENDED_CODES.has(live.error.code) ? t(`live.ended.${live.error.code as EndedCode}`) : t('live.ended.other', { detail: `${live.error.code} ${live.error.message}`.trim() })}
        </div>
      )}
      {live.phase === 'error' && (live.error?.code === 'BACKEND_REJECTED' || live.error?.code === 'BACKEND_UNREACHABLE') && (
        <div className={cx(css.caption, css.warn)} data-testid="dsh-voice-capture-live-hint">{t('live.openRejected')}</div>
      )}
      {live.notice !== undefined && !live.notice.startsWith('resumed') && <div className={css.caption}>{live.notice}</div>}
      {live.turns.length > 0 && (
        <div className={css.transcript} aria-label={live.kind === 'transcription' ? t('live.transcriptTitle') : t('live.transcript')} data-testid="dsh-voice-capture-live-transcript">
          {live.turns.map(turn => (
            <span key={turn.id} className={cx(!turn.final && live.kind === 'transcription' && css.partial)} data-final={turn.final} data-kind={turn.kind}>
              {turn.text}{' '}
            </span>
          ))}
        </div>
      )}
      {live.phase === 'closed' && live.log !== 'none' && (
        <div className={cx(css.caption, live.log !== 'logged' && live.log !== 'logging' && css.warn)} data-testid="dsh-voice-capture-live-log" data-log={live.log} data-detail={live.logDetail}>
          {live.log === 'logging' ? t('live.logging')
            : live.log === 'logged' ? t('live.logged')
              : live.logDetail === 'no-reply' ? t('live.logUnavailableNoReply')
                : live.logDetail === 'no-input' ? t('live.logUnavailableNoInput')
                  : live.logDetail === 'text-input' ? t('live.notLogged')
                    : t('live.logFailed', { detail: live.logDetail ?? live.log })}
        </div>
      )}
      {textInput && live.phase === 'live' && live.utteranceOpen && (
        <div className={css.row}>
          <span className={css.spacer} />
          <Button size="sm" variant="ghost" onClick={() => { void sendLiveText('', true, false) }} data-testid="dsh-voice-capture-live-end-utterance">{t('live.endUtterance')}</Button>
        </div>
      )}
      {textInput && live.phase === 'live' && (
        <div className={css.row}>
          <textarea
            className={cx(css.textInput, css.paramWide)}
            rows={2}
            value={text}
            placeholder={t('live.textPlaceholder')}
            aria-label={t('live.textPlaceholder')}
            onChange={(event) => { setText(event.currentTarget.value) }}
            data-testid="dsh-voice-capture-live-text"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={text.trim() === ''}
            onClick={() => { void sendLiveText(text, false, false).then((ok) => { if (ok) setText('') }) }}
            data-testid="dsh-voice-capture-live-send-text"
          >
            {t('live.sendText')}
          </Button>
        </div>
      )}
      <div className={css.row}>
        <span className={css.spacer} />
        {live.phase === 'live' && (
          textInput
            ? <Button size="sm" variant="outline" onClick={endLiveInput} data-testid="dsh-voice-capture-live-end-input">{t('live.finishText')}</Button>
            : <Button size="sm" variant="outline" onClick={endLiveInput} data-testid="dsh-voice-capture-live-end-input">{t('live.endInput')}</Button>
        )}
        {(live.phase === 'live' || live.phase === 'awaiting') && openResponse && (
          <Button size="sm" variant="ghost" onClick={() => { liveControl('cancel-response') }}>{t('live.cancelResponse')}</Button>
        )}
        {(live.phase === 'live' || live.phase === 'awaiting') && openResponse && bargeInState !== 'unsupported' && !fallback && (
          <Button size="sm" variant="ghost" onClick={() => { liveControl('barge-in') }} title={t(`evidence.${bargeInState}`)}>{t('live.bargeIn')}</Button>
        )}
        {(live.phase === 'opening' || live.phase === 'live' || live.phase === 'awaiting') && (
          <Button size="sm" variant="primary" onClick={closeLive} data-testid="dsh-voice-capture-live-close">{t('live.close')}</Button>
        )}
        {(live.phase === 'closed' || live.phase === 'error') && live.log !== 'logging' && (
          <Button size="sm" variant="ghost" onClick={dismissLive} data-testid="dsh-voice-capture-live-dismiss">{t('live.dismiss')}</Button>
        )}
      </div>
    </section>
  )
}

const PANEL_LABEL = {
  'conversation': 'live.panel',
  'transcription': 'live.panelTranscription',
  'turn': 'live.panelTurn',
  'text-input': 'live.panelTextInput',
} as const

const LIVE_TITLE = {
  'conversation': 'live.sending',
  'transcription': 'live.transcribing',
  'turn': 'live.sending',
  'text-input': 'live.textLive',
} as const

/** Interrupt / Cancel reply outcome: "interrupted" only when the host confirmed the cancelled response (§K.10). */
function controlText(live: LiveSnapshot, t: LiveDockProps['t']): string {
  const control = live.control!
  const action = t(control.type === 'barge-in' ? 'live.bargeIn' : 'live.cancelResponse')
  switch (control.outcome) {
    case 'pending': return t('live.control.pending', { action })
    case 'no-active-response': return t('live.control.nothing', { action })
    case 'response-not-active': return t('live.control.notActive', { action })
    case 'response-already-completed': return t('live.control.alreadyFinished', { action })
    case 'stale':
    case 'unconfirmed': return t('live.control.unconfirmed', { action })
    case 'cancelled': return control.confirmed ? t('live.control.done', { action }) : t('live.control.cancelledPending', { action })
    case 'no-outcome': return t('live.control.noOutcome', { action })
    default: return t('live.control.failed', { action, detail: control.reason ?? '' })
  }
}

function errorText(live: LiveSnapshot, t: LiveDockProps['t']): string {
  const code = live.error?.code
  if (code === 'MIC_BUSY') return t('live.micBusy')
  if (code === 'SERVER_BUSY') return t('live.serverBusy', { detail: live.error?.message ?? '' })
  if (code === 'MODEL_NOT_READY') return t('live.notReady')
  return `${code ?? ''} ${live.error?.message ?? ''}`.trim()
}

/** Wall-clock milliseconds on the `performance.now()` axis, refreshed every second while `active`. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    setNow(performance.now())
    const timer = setInterval(() => { setNow(performance.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [active])
  return now
}
