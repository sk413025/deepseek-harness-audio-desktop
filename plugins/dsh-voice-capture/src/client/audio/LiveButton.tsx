import { useState } from 'react'
import { Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../format.ts'
import type { LiveButtonProps } from '../slots.ts'
import { gateBlocks } from './gate.ts'
import type { LiveKind } from './live.ts'
import css from './audio.module.css'

const START_LABEL: Record<LiveKind, 'live.start' | 'live.startTranscribe' | 'live.startTurn' | 'live.startSpeak'> = {
  'conversation': 'live.start',
  'transcription': 'live.startTranscribe',
  'turn': 'live.startTurn',
  'text-input': 'live.startSpeak',
}
const START_TITLE: Record<LiveKind, 'live.startTitle' | 'live.startTranscribeTitle' | 'live.startTurnTitle' | 'live.startSpeakTitle'> = {
  'conversation': 'live.startTitle',
  'transcription': 'live.startTranscribeTitle',
  'turn': 'live.startTurnTitle',
  'text-input': 'live.startSpeakTitle',
}

/**
 * Explicit Live-mode entry, shown only when a live session of the selected
 * model's adapter route is declared, advertised or verified; the tooltip
 * carries the evidence layer so an untested mode is never presented as
 * working. With several live models (transcription, duplex, voice turns,
 * streamed speech) the button opens a chooser; cold or loading models are
 * listed but cannot be started.
 */
export function LiveButton({ t, useFeatures, useLive, useSession, useLiveGates, startLive }: LiveButtonProps) {
  const candidates = useFeatures(features => features.liveCandidates)
  const gates = useLiveGates(snapshot => snapshot)
  const phase = useLive(live => live.phase)
  const subagent = useSession(snapshot => snapshot.subagent !== null)
  const running = useSession(snapshot => snapshot.running)
  const [open, setOpen] = useState(false)
  const first = candidates[0]
  if (first === undefined) return null
  const active = phase === 'opening' || phase === 'live' || phase === 'awaiting' || phase === 'closing'
  /** Why a candidate cannot start now; untested, unsupported, cold/busy and a running reply stay distinguishable. */
  const reasonOf = (candidate: typeof first): string | undefined => {
    if (!candidate.available) {
      return candidate.evidence === 'untested'
        ? t('live.unavailable.untested', { model: candidate.model.model })
        : t('live.unavailable.unsupported', { model: candidate.model.model, detail: candidate.detail === undefined ? '' : `: ${candidate.detail}` })
    }
    const gate = gates[candidate.model.model]
    if (gate !== undefined && gateBlocks(gate)) return t('live.gated', { reason: t(`gate.${gate.state}`) })
    if (running) return t('live.replyRunning')
    return undefined
  }
  const choose = candidates.length > 1
  const firstReason = reasonOf(first)
  const evidenceText = (candidate: typeof first) => (candidate.kind === 'text-input' ? t(`evidence.${candidate.evidence}`) : t(`live.input.${candidate.evidence}`))
  const base = choose ? t('live.chooseTitle') : t(START_TITLE[first.kind], { evidence: evidenceText(first) })
  const label = !choose && firstReason !== undefined ? `${base} — ${firstReason}` : base
  const button = (
    <button
      type="button"
      className={cx(css.liveButton, active && css.liveActive, !choose && first.evidence !== 'verified' && css.unverified)}
      aria-label={label}
      aria-pressed={active}
      aria-haspopup={choose ? 'menu' : undefined}
      disabled={active || subagent || (!choose && firstReason !== undefined)}
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={() => { if (choose) setOpen(value => !value); else startLive(first.model.model) }}
      data-testid="dsh-voice-capture-live"
      data-evidence={first.evidence}
      data-kind={choose ? 'choose' : first.kind}
      data-candidates={candidates.length}
      data-reason={choose ? undefined : firstReason === undefined ? undefined : !first.available ? first.evidence : running ? 'reply-running' : 'gate'}
    >
      <span className={css.liveDot} aria-hidden="true" />
      {choose ? t('live.start') : t(START_LABEL[first.kind])}
    </button>
  )
  if (!choose) return <Tooltip label={label} side="top" delayMs={300} maxWidth={320}>{button}</Tooltip>
  return (
    <Menu
      open={open && !active}
      anchor={button}
      side="top"
      portal
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        const picked = candidates.find(c => c.model.model === id)
        if (picked !== undefined && reasonOf(picked) === undefined) startLive(id)
      }}
      items={[
        { type: 'label', id: 'title', text: t('live.chooseTitle') },
        ...candidates.map((candidate) => {
          const reason = reasonOf(candidate)
          return {
            id: candidate.model.model,
            disabled: reason !== undefined,
            label: (
              <span className={css.liveChoice} data-testid="dsh-voice-capture-live-choice" data-model={candidate.model.model} data-kind={candidate.kind} data-evidence={candidate.evidence} data-available={candidate.available} data-blocked={reason === undefined ? undefined : 'true'}>
                <span>{t(`live.kind.${candidate.kind}`)}</span>
                <span className={cx(css.caption, css.truncate)}>
                  {candidate.model.model} · {evidenceText(candidate)}
                </span>
                {reason !== undefined && <span className={cx(css.caption, css.warn)}>{reason}</span>}
              </span>
            ),
          }
        }),
      ]}
    />
  )
}
