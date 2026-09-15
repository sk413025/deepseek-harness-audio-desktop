import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../format.ts'
import type { RecoveryCardProps } from '../slots.ts'
import { RecordingPlayer } from './AudioReplies.tsx'
import { recoveryKey, recoveryView } from './offline-recover.ts'
import css from './audio.module.css'

/**
 * Interrupted offline generator jobs of this Session (R-MIC recover contract): explicit Recover, host-stated outcome,
 * the recovered recording in the existing inline player, and Insert into conversation once per result. Recovered
 * audio is never labelled streaming, realtime or Live.
 */
export function RecoveryCard({ t, useRecovery, useInput, inputActions, load, recover, insert }: RecoveryCardProps) {
  const snapshot = useRecovery(s => s)
  const draft = useInput(state => state.draft)
  useEffect(() => { load() }, [load])
  if (snapshot.entries.length === 0) return null
  return (
    <section className={css.bar} aria-label={t('recover.panel')} data-testid="dsh-voice-capture-recovery">
      {snapshot.entries.map(({ job, outcome, busy, inserted }) => {
        const view = recoveryView(outcome)
        const key = recoveryKey(job)
        const detail = [outcome.code, outcome.message].filter(Boolean).join(' · ')
        return (
          <div key={key} className={css.referenceBox} data-testid="dsh-voice-capture-recovery-job" data-job-id={job.jobId} data-provider={job.provider} data-model={job.model} data-status={outcome.status} data-badge={view.badge} data-busy={String(busy)} data-inserted={String(inserted)} data-idempotent={String(outcome.idempotent)}>
            <div className={css.row}>
              <span className={css.title}>{t('recover.title', { model: job.model })}</span>
              <span className={cx(css.caption, (view.message === 'integrity-mismatch' || view.message.startsWith('refused') || view.message === 'failed' || view.badge === 'unverified') && css.warn)} role="status">
                {t(`recover.status.${view.message}` as never, { code: outcome.code ?? '' })}
                {view.badge === 'verified' ? ` · ${t('recover.badge.verified')}` : view.badge === 'unverified' ? ` · ${t('recover.badge.unverified')}` : ''}
                {detail !== '' && view.message !== 'recovered' ? ` · ${detail}` : ''}
              </span>
              <span className={css.spacer} />
              {view.recover !== undefined && (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => { recover(key) }} data-testid="dsh-voice-capture-recovery-recover">
                  {t(view.recover === 'recover' ? 'recover.action.recover' : 'recover.action.again')}
                </Button>
              )}
              {(view.insert !== undefined || inserted) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={inserted || view.insert === undefined}
                  onClick={() => { insert(key, line => { inputActions.setDraft(draft.trim() === '' ? line : `${draft}\n${line}`) }) }}
                  data-testid="dsh-voice-capture-recovery-insert"
                >
                  {inserted ? t('recover.action.inserted') : t(view.insert === 'verified' ? 'recover.action.insert' : 'recover.action.insertUnverified')}
                </Button>
              )}
            </div>
            {view.player && outcome.recordingId !== undefined && (
              <RecordingPlayer
                recordingId={outcome.recordingId}
                path={`/api/dsh-dgx-audio/v1/recording?id=${encodeURIComponent(outcome.recordingId)}`}
                title={t(view.badge === 'verified' ? 'recover.player.verified' : 'recover.player.unverified')}
                caption={outcome.frames === undefined ? '' : t('recover.frames', { frames: outcome.frames })}
                t={t as never}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}
