import type { ReplyBarProps } from '../slots.ts'
import type { TimelineSummary } from './playback-timeline.ts'
import css from './audio.module.css'

/**
 * Actual playback facts of one reply stream (output clock), shown in the reply bar and under the reply player.
 * The data attributes carry the same facts for evidence readers.
 */
export function TimelineCaption({ summary, t }: { summary: TimelineSummary | undefined; t: ReplyBarProps['t'] }) {
  if (summary === undefined || summary.chunksReceived === 0) return null
  const parts: string[] = []
  if (summary.verdict === 'pending') parts.push(t('timeline.pending', { played: summary.chunksPlayed, received: summary.chunksReceived }))
  else if (summary.verdict === 'progressive') parts.push(t('timeline.progressive', { lead: ((summary.leadMs ?? 0) / 1000).toFixed(1), played: summary.chunksPlayed, received: summary.chunksReceived }))
  else if (summary.verdict === 'after-generation') parts.push(t('timeline.afterGeneration'))
  else parts.push(t('timeline.noPlayback'))
  if (!summary.inOrder) parts.push(t('timeline.outOfOrder'))
  if (summary.underruns.length > 0) parts.push(t('timeline.underruns', { count: summary.underruns.length, ms: Math.max(...summary.underruns.map(u => u.gapMs)) }))
  if (summary.stopAt !== undefined) {
    if (summary.soundAfterStop === true) parts.push(t('timeline.soundAfterStop'))
    else if (summary.stopKind === 'cancelled') parts.push(t('timeline.cancelClean'))
    else parts.push(t('timeline.stopClean', { ms: Math.max(0, (summary.lastSoundAt ?? summary.stopAt) - summary.stopAt) }))
  }
  return (
    <div
      className={css.caption}
      role="status"
      data-testid="dsh-voice-capture-playback-timeline"
      data-stream-id={summary.streamId}
      data-recording-id={summary.recordingId}
      data-verdict={summary.verdict}
      data-host-delivery={summary.hostDelivery}
      data-first-playback-before-end={summary.firstPlaybackBeforeGenerationEnd === undefined ? 'unknown' : String(summary.firstPlaybackBeforeGenerationEnd)}
      data-lead-ms={summary.leadMs}
      data-chunks-received={summary.chunksReceived}
      data-chunks-played={summary.chunksPlayed}
      data-in-order={String(summary.inOrder)}
      data-underruns={summary.underruns.length}
      data-stop-kind={summary.stopKind}
      data-sound-after-stop={summary.soundAfterStop === undefined ? undefined : String(summary.soundAfterStop)}
      data-clock={summary.clock}
    >
      {parts.join(' · ')}
    </div>
  )
}
