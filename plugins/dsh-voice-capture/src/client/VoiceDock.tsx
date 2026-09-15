import { useEffect, useRef, useState } from 'react'
import { Button, IconCloseOutline16, IconSendOutline16, IconWarningOutline16, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { clockText, cx, deviceText } from './format.ts'
import { MicIcon, StopSquareIcon } from './icons.tsx'
import type { VoiceDockProps } from './slots.ts'
import type { VoiceSnapshot } from './controller.ts'
import css from './VoiceDock.module.css'

/** How long the post-send confirmation line stays visible. */
const SENT_NOTICE_MS = 6000

/**
 * Full-width recording panel above the composer: live status and timer,
 * level meter, device choice, preview player, discard / re-record / send,
 * upload progress and recoverable errors. Renders nothing while idle.
 */
export function VoiceDock({
  t, useVoice, useGate, useInput, inputActions, start, stop, cancel, send, selectDevice, dismissError,
}: VoiceDockProps) {
  const voice = useVoice(snapshot => snapshot)
  const gate = useGate(snapshot => snapshot.state)
  const gated = gate !== 'ready' && gate !== 'static' && gate !== 'unknown'
  const draft = useInput(state => state.draft)
  const references = useInput(state => state.occurrences.length)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const player = useRef<HTMLAudioElement | null>(null)
  const [sentVisible, setSentVisible] = useState(false)
  const lastSentAt = voice.lastSent?.at

  useEffect(() => {
    if (lastSentAt === undefined) return
    setSentVisible(true)
    const timer = setTimeout(() => { setSentVisible(false) }, SENT_NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [lastSentAt])

  useEffect(() => {
    if (voice.phase !== 'preview') player.current?.pause()
  }, [voice.phase])

  const phase = voice.phase
  if (phase === 'idle' && !(sentVisible && voice.lastSent !== undefined)) return null

  const includeDraft = references === 0 && draft.trim() !== ''
  const onSend = async () => {
    player.current?.pause()
    const text = includeDraft ? draft : ''
    const outcome = await send(text)
    if (outcome === 'sent' && text !== '' && latestDraft.current === text) inputActions.setDraft('')
  }

  return (
    <section
      className={css.root}
      aria-label={t('panel.label')}
      data-testid="dsh-voice-capture-panel"
      data-phase={phase}
    >
      <div className={css.body}>
        <p className={css.srOnly} aria-live="polite">{liveMessage(t, voice)}</p>
        {phase === 'requesting' && (
          <div className={css.row}>
            <span className={css.lead}><MicIcon size={16} /></span>
            <span className={css.title}>{t('status.requesting')}</span>
            <span className={css.spacer} />
            <Button size="sm" variant="ghost" onClick={cancel}>{t('action.cancel')}</Button>
          </div>
        )}
        {phase === 'recording' && (
          <div className={cx(css.row, css.nowrap)}>
            <span className={css.recDot} aria-hidden="true" />
            <span className={css.title}>{t('status.recording')}</span>
            <span
              className={css.timer}
              data-testid="dsh-voice-capture-timer"
              aria-label={t('timer.label', { elapsed: clockText(voice.elapsedMs), limit: clockText(voice.limitMs) })}
            >
              {clockText(voice.elapsedMs)}
              <span className={css.limit}> / {clockText(voice.limitMs)}</span>
            </span>
            <span
              className={css.meter}
              role="meter"
              aria-label={t('level.label')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(voice.level * 100)}
            >
              <span className={css.meterFill} style={{ transform: `scaleX(${voice.level.toFixed(3)})` }} />
            </span>
            <span className={cx(css.caption, css.truncate)} title={voice.activeDeviceLabel}>
              {voice.activeDeviceLabel === '' ? '' : t('device.recordingWith', { name: voice.activeDeviceLabel })}
            </span>
            <Button size="sm" variant="ghost" onClick={cancel}>{t('action.discard')}</Button>
            <Button size="sm" variant="primary" icon={<StopSquareIcon size={14} />} onClick={stop} data-testid="dsh-voice-capture-stop">
              {t('action.stop')}
            </Button>
          </div>
        )}
        {phase === 'encoding' && (
          <div className={css.row}>
            <span className={css.spinner} aria-hidden="true" />
            <span className={css.title}>{t('status.encoding')}</span>
          </div>
        )}
        {(phase === 'preview' || phase === 'sending') && voice.clip !== undefined && (
          <>
            <div className={css.row}>
              <span className={css.title}>{t('status.preview')}</span>
              <span className={css.caption} data-testid="dsh-voice-capture-details">
                {t('clip.details', {
                  duration: clockText(voice.clip.durationMs),
                  size: fileSizeText(voice.clip.bytes),
                  rate: voice.clip.sampleRate / 1000,
                })}
              </span>
              <span className={css.spacer} />
              {phase === 'preview' && <DeviceSelect voice={voice} t={t} onSelect={selectDevice} />}
            </div>
            {voice.clip.limitReached && (
              <div className={css.notice}>{t('status.limitReached', { limit: clockText(voice.limitMs) })}</div>
            )}
            <audio
              ref={player}
              className={css.player}
              controls
              preload="metadata"
              src={voice.clip.url}
              aria-label={t('clip.player')}
              data-testid="dsh-voice-capture-preview"
            />
            {voice.error !== undefined && <ErrorLine voice={voice} t={t} onDismiss={dismissError} />}
            {phase === 'sending' && voice.progress !== undefined
              ? (
                <div className={css.row}>
                  <span className={css.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(voice)}>
                    <span className={css.progressFill} style={{ transform: `scaleX(${(percent(voice) / 100).toFixed(3)})` }} />
                  </span>
                  <span className={css.caption}>
                    {voice.progress.stage === 'uploading' ? t('status.uploading', { percent: percent(voice) }) : t('status.submitting')}
                  </span>
                  <span className={css.spacer} />
                  <Button size="sm" variant="ghost" onClick={cancel}>{t('action.cancelSend')}</Button>
                </div>
              )
              : (
                <div className={css.row}>
                  <span className={css.caption}>
                    {gate === 'live-only' ? t('gate.live-only') : gated ? t('live.gated', { reason: t(`gate.${gate}`) }) : includeDraft ? t('clip.withDraft') : references > 0 && draft.trim() !== '' ? t('clip.withReferences') : t('clip.audioOnly')}
                  </span>
                  <span className={css.spacer} />
                  <Button size="sm" variant="ghost" onClick={cancel} data-testid="dsh-voice-capture-discard">{t('action.discard')}</Button>
                  <Button size="sm" variant="outline" icon={<MicIcon size={14} />} onClick={start}>{t('action.rerecord')}</Button>
                  <Button
                    id="dsh-voice-capture-send"
                    size="sm"
                    variant="primary"
                    icon={<IconSendOutline16 size={14} />}
                    onClick={() => { void onSend() }}
                    disabled={gated}
                    data-gate={gate}
                    data-testid="dsh-voice-capture-send"
                  >
                    {t('action.send')}
                  </Button>
                </div>
              )}
          </>
        )}
        {phase === 'error' && voice.error !== undefined && (
          <>
            <ErrorLine voice={voice} t={t} onDismiss={dismissError} />
            <div className={css.row}>
              <span className={css.spacer} />
              <DeviceSelect voice={voice} t={t} onSelect={selectDevice} />
              <Button size="sm" variant="outline" icon={<MicIcon size={14} />} onClick={start} data-testid="dsh-voice-capture-retry">
                {t('action.retry')}
              </Button>
            </div>
          </>
        )}
        {phase === 'idle' && voice.lastSent !== undefined && (
          <div className={css.row} data-testid="dsh-voice-capture-sent">
            <span className={css.caption}>{t('status.sent', { name: voice.lastSent.name })}</span>
          </div>
        )}
      </div>
    </section>
  )
}

function percent(voice: VoiceSnapshot): number {
  const progress = voice.progress
  if (progress === undefined) return 0
  if (progress.stage === 'submitting') return 100
  const total = progress.total ?? voice.clip?.bytes ?? 0
  return total > 0 ? Math.min(100, Math.round(progress.loaded * 100 / total)) : 0
}

function liveMessage(t: VoiceDockProps['t'], voice: VoiceSnapshot): string {
  switch (voice.phase) {
    case 'requesting': return t('status.requesting')
    case 'recording': return t('status.recording')
    case 'encoding': return t('status.encoding')
    case 'preview': return voice.error === undefined ? t('status.preview') : t(`error.${voice.error.code}`)
    case 'sending': return voice.progress?.stage === 'submitting' ? t('status.submitting') : ''
    case 'error': return voice.error === undefined ? '' : t(`error.${voice.error.code}`)
    case 'idle': return voice.lastSent === undefined ? '' : t('status.sent', { name: voice.lastSent.name })
    default: return ''
  }
}

function ErrorLine({ voice, t, onDismiss }: {
  voice: VoiceSnapshot
  t: VoiceDockProps['t']
  onDismiss: () => void
}) {
  const error = voice.error
  if (error === undefined) return null
  return (
    <div className={cx(css.row, css.error)} role="alert" data-testid="dsh-voice-capture-error" data-code={error.code}>
      <span className={css.lead}><IconWarningOutline16 size={16} /></span>
      <span className={css.errorText}>
        {t(`error.${error.code}`)}
        {error.detail !== '' && <span className={css.caption}> {t('error.detail', { detail: error.detail })}</span>}
      </span>
      <span className={css.spacer} />
      <button type="button" className={css.iconButton} aria-label={t('action.dismiss')} onClick={onDismiss}>
        <IconCloseOutline16 size={14} />
      </button>
    </div>
  )
}

function DeviceSelect({ voice, t, onSelect }: {
  voice: VoiceSnapshot
  t: VoiceDockProps['t']
  onSelect: (deviceId: string) => void
}) {
  const devices = voice.devices.some(device => device.id === '')
    ? voice.devices
    : [{ id: '', label: '' }, ...voice.devices]
  const selectedKnown = devices.some(device => device.id === voice.selectedDeviceId)
  return (
    <label className={css.device}>
      <span className={css.srOnly}>{t('device.label')}</span>
      <select
        className={css.select}
        value={selectedKnown ? voice.selectedDeviceId : ''}
        onChange={(event) => { onSelect(event.currentTarget.value) }}
        data-testid="dsh-voice-capture-device"
      >
        {devices.map((device, index) => (
          <option key={device.id === '' ? 'default' : device.id} value={device.id}>{deviceText(t, device, index)}</option>
        ))}
      </select>
    </label>
  )
}
