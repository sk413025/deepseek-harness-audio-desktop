import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReplyBarProps } from '../slots.ts'
import { TimelineCaption } from './TimelineCaption.tsx'
import css from './audio.module.css'

/** Adapter tasks whose audio is generated content, not the other side of a conversation (TASK_CONTRACT 0.2 §A). */
const GENERATED_AUDIO_TASKS: ReadonlySet<string> = new Set(['tts.speech', 'audio.generate', 'tts.stream-input', 'tts.offline-job'])
/** Offline generator jobs: labelled as a job with the measured delivery, never as streaming or Live. */
const OFFLINE_JOB_TASK = 'tts.offline-job'

/** How long a finished reply status stays visible. */
const ENDED_VISIBLE_MS = 6000

/**
 * Progressive reply playback status above the composer (CONTRACT §3). The
 * streaming label appears only when audio was audible on the output clock
 * before the reply ended (not merely scheduled); a host `final-only` delivery
 * is labelled as a complete audio reply. Stop also stops a still-generating turn.
 */
export function ReplyBar({ t, usePlayback, useLive, stopPlayback, setAutoplay, attachFeed }: ReplyBarProps) {
  const playback = usePlayback(snapshot => snapshot)
  const liveKind = useLive(snapshot => snapshot.kind)
  useEffect(() => attachFeed(), [attachFeed])
  const [endedVisible, setEndedVisible] = useState(true)
  useEffect(() => {
    if (playback.phase !== 'ended' && playback.phase !== 'stopped') {
      setEndedVisible(true)
      return
    }
    const timer = setTimeout(() => { setEndedVisible(false) }, ENDED_VISIBLE_MS)
    return () => { clearTimeout(timer) }
  }, [playback.phase, playback.streamId])
  if (playback.phase === 'idle' || ((playback.phase === 'ended' || playback.phase === 'stopped') && !endedVisible)) return null
  // "Streaming" only once audio was actually audible (output clock) before the reply ended, never on scheduling alone.
  const streamingObserved = playback.playedBeforeEnd || (playback.hostDelivery === 'pending' && playback.chunks >= 2 && (playback.timeline?.chunksPlayed ?? 0) > 0)
  // Generated speech or music is never presented as a spoken reply.
  // Live streams carry no task on the feed: a streamed text-to-speech session is generated audio too.
  const generated = (playback.task !== undefined && GENERATED_AUDIO_TASKS.has(playback.task)) || (playback.origin === 'live' && liveKind === 'text-input')
  const offline = playback.task === OFFLINE_JOB_TASK
  // Recovered offline job audio (origin `recover`, R-MIC recover contract): always labelled recovered, even while a
  // reattached job still sends chunks.
  const recovered = playback.origin === 'recover'
  const title = recovered
    ? (playback.phase === 'receiving' ? t('recover.reply.receiving')
      : playback.phase === 'playing' ? t('recover.reply.playing')
        : playback.phase === 'stopped' ? t('reply.stopped') : t('recover.reply.ended'))
    : offline
    ? (playback.phase === 'receiving' ? t('offlineJob.reply.receiving')
      : playback.phase === 'playing' ? t('offlineJob.reply.playing')
        : playback.phase === 'stopped' ? t('reply.stopped') : t('offlineJob.reply.ended'))
    : playback.phase === 'receiving'
    ? t(generated ? 'reply.generated.receiving' : 'reply.receiving')
    : playback.phase === 'playing'
      ? (streamingObserved && playback.hostDelivery !== 'final-only'
          ? t(generated ? 'reply.generated.playingStreaming' : 'reply.speakingStreaming')
          : t(generated ? 'reply.generated.playing' : 'reply.speakingFinal'))
      : playback.phase === 'stopped' ? t('reply.stopped') : t(generated ? 'reply.generated.ended' : 'reply.ended')
  return (
    <section
      className={css.bar}
      aria-label={t(offline ? 'offlineJob.reply.label' : generated ? 'reply.generated.label' : 'reply.label')}
      data-testid="dsh-voice-capture-reply-bar"
      data-kind={generated ? 'generated' : 'spoken'}
      data-task={playback.task}
      data-phase={playback.phase}
      data-delivery={playback.hostDelivery}
      data-played-before-end={String(playback.playedBeforeEnd)}
    >
      <div className={css.row}>
        {playback.phase === 'playing' && <span className={css.speaking} aria-hidden="true" />}
        <span className={css.title} aria-live="polite">{title}</span>
        <span className={css.caption}>
          {offline
            ? (playback.hostDelivery === 'final-only' ? t('offlineJob.delivery.final-only') : playback.hostDelivery === 'progressive' ? t('offlineJob.delivery.progressive') : '')
            : playback.hostDelivery === 'final-only'
            ? t(generated ? 'reply.generated.finalOnly' : 'reply.finalOnly')
            : playback.playedBeforeEnd ? t('reply.progressive', { chunks: playback.chunks }) : ''}
        </span>
        {playback.gaps > 0 && <span className={css.caption}>{t('reply.gaps', { gaps: playback.gaps })}</span>}
        <span className={css.spacer} />
        <label className={css.toggle}>
          <input type="checkbox" checked={playback.autoplay} onChange={(event) => { setAutoplay(event.currentTarget.checked) }} />
          <span>{t(generated ? 'reply.generated.autoplay' : 'reply.autoplay')}</span>
        </label>
        {(playback.phase === 'playing' || playback.phase === 'receiving') && (
          <Button size="sm" variant="outline" onClick={stopPlayback} data-testid="dsh-voice-capture-reply-stop">{t('reply.stop')}</Button>
        )}
      </div>
      <TimelineCaption summary={playback.timeline} t={t} />
    </section>
  )
}
