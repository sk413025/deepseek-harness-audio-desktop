import { useEffect } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './format.ts'
import { MicIcon, StopSquareIcon } from './icons.tsx'
import type { MicButtonProps } from './slots.ts'
import css from './MicButton.module.css'

/** Composer tool-row microphone toggle: idle → record, recording → stop. */
export function MicButton({ t, useVoice, useSession, start, stop, detach, refreshDevices }: MicButtonProps) {
  const phase = useVoice(snapshot => snapshot.phase)
  const supported = useVoice(snapshot => snapshot.supported)
  const subagent = useSession(snapshot => snapshot.subagent !== null)

  useEffect(() => {
    refreshDevices()
    return () => { detach() }
  }, [detach, refreshDevices])

  const live = phase === 'requesting' || phase === 'recording'
  const working = phase === 'encoding' || phase === 'sending'
  const disabled = !supported || subagent || working
  const label = !supported
    ? t('mic.unsupported')
    : subagent
      ? t('mic.subagent')
      : live
        ? t('mic.stop')
        : working
          ? t('mic.busy')
          : phase === 'preview'
            ? t('mic.pending')
            : t('mic.start')

  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <button
        type="button"
        className={cx(css.button, live && css.live, phase === 'preview' && css.pending)}
        aria-label={label}
        aria-pressed={live}
        data-testid="dsh-voice-capture-mic"
        data-phase={phase}
        disabled={disabled}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => {
          if (live) stop()
          else if (phase === 'preview') document.getElementById('dsh-voice-capture-send')?.focus()
          else start()
        }}
      >
        {live ? <StopSquareIcon size={14} /> : <MicIcon size={14} />}
      </button>
    </Tooltip>
  )
}
