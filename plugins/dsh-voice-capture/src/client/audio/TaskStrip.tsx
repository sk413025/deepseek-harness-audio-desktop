import { useEffect, useRef, useState } from 'react'
import { Button, IconCloseOutline16, IconSendOutline16, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { clockText, cx } from '../format.ts'
import { MicIcon, StopSquareIcon } from '../icons.tsx'
import type { TaskStripProps } from '../slots.ts'
import { missingInputs, offerOf, taskView } from './tasks.ts'
import type { ReferenceSlot, TaskParam, TaskValue, TaskView } from './tasks.ts'
import { rendersControl } from './options.ts'
import type { OfferState, OptionFact } from './options.ts'
import { gateBlocks } from './gate.ts'
import { jobsOf, recoveryActions } from './offline-jobs.ts'
import type { OfflineJobState } from './offline-jobs.ts'
import { chosenTurnMode, hidesTurnParam, turnModesOf } from './turn-mode.ts'
import type { TurnModes } from './turn-mode.ts'
import css from './audio.module.css'

/** Turn modes with localized names (others show the host's mode id). */
const KNOWN_TURN_MODES: ReadonlySet<string> = new Set(['native-duplex', 'server-vad', 'no-turn-detection'])
type KnownTurnMode = 'native-duplex' | 'server-vad' | 'no-turn-detection'

/** Tasks whose request text comes from the composer and is sent by this strip's action. */
const TEXT_REQUEST_TASKS: ReadonlySet<string> = new Set(['tts', 'voice-clone', 'music-generation', 'sound-generation', 'video-generation'])

/** Contract parameter keys with localized labels (TASK_CONTRACT 0.2 host TASK_PARAMS); other keys show as published. */
const PARAM_LABELS: ReadonlySet<string> = new Set([
  'voice', 'instructions', 'language', 'taskType', 'responseFormat', 'maxNewTokens', 'refText', 'audioLength', 'negativePrompt',
  'guidanceScale', 'numInferenceSteps', 'seed', 'prompt', 'timestampGranularities', 'toLanguage', 'overlapPolicy', 'turnDetection',
  'speed', 'sampleRate', 'wordTimestamps', 'xVectorOnlyMode', 'nonStreamingMode', 'initialCodecChunkFrames', 'ambientSound',
  'durationSeconds', 'extraParams',
])

/** Extra attachment slots rendered after the main reference box. */
const EXTRA_SLOTS: readonly Exclude<ReferenceSlot, 'referenceAudio'>[] = ['referenceAudio2', 'emotionAudio', 'imageReference', 'audioReference']

type ServerValues = Readonly<Record<string, readonly string[] | 'failed'>>

/**
 * Load server-reported choices (`valuesFrom`, e.g. GET voices) for the given URLs.
 * @param urls - adapter route URLs.
 * @param loadValues - cached loader.
 * @returns choices per URL (`failed` when the server did not answer with a list).
 */
function useServerValues(urls: readonly string[], loadValues: (url: string) => Promise<readonly string[]>): ServerValues {
  const [values, setValues] = useState<ServerValues>({})
  const key = [...new Set(urls)].sort().join('\n')
  useEffect(() => {
    let alive = true
    for (const url of key === '' ? [] : key.split('\n')) {
      loadValues(url).then(
        (list) => { if (alive) setValues(current => ({ ...current, [url]: list })) },
        () => { if (alive) setValues(current => ({ ...current, [url]: 'failed' })) },
      )
    }
    return () => { alive = false }
  }, [key, loadValues])
  return values
}

function valuesFromOf(param: TaskParam): string | undefined {
  return 'valuesFrom' in param ? param.valuesFrom : undefined
}

/** Parameters the reference box edits itself. */
const REFERENCE_PARAMS: ReadonlySet<string> = new Set(['refText'])

/**
 * Task strip above the composer for the selected adapter model: task and output
 * expectation, activation gate, parameters, reference voice with consent, the
 * input checklist and, for text-input generation tasks, the Generate action.
 * Renders nothing for models the audio adapter does not serve, and for plain
 * chat models without parameters.
 */
export function TaskStrip({
  t, useFeatures, useTaskInputs, useReferenceVoice, useGate, useVideoProgress, useOfflineJobs, useTurnModes, useInput, inputActions,
  setValue, pickReference, clearReference, setConsent, setReferenceText, startReference, stopReference,
  keepReference, discardRecordedReference, generate, cancelGenerate, dismissTaskError, loadValues, openLibrary, setTurnMode,
}: TaskStripProps) {
  const model = useFeatures(features => features.model)
  const selection = useFeatures(features => features.selection)
  const candidates = useFeatures(features => features.liveCandidates)
  const inputs = useTaskInputs(snapshot => snapshot)
  const recorder = useReferenceVoice(snapshot => snapshot)
  const gate = useGate(snapshot => snapshot)
  const draft = useInput(state => state.draft)
  const videoJob = useVideoProgress(snapshot => snapshot)
  const offlineJobState = useOfflineJobs(snapshot => snapshot)
  const turnChoices = useTurnModes(snapshot => snapshot)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  useEffect(() => () => { discardRecordedReference() }, [discardRecordedReference])
  const liveViews = candidates.filter(c => c.available && c.entry.id !== model?.id).map(c => ({ candidate: c, view: taskView(c.entry) }))
  const serverValues = useServerValues(
    [...(model === undefined ? [] : taskView(model).params), ...liveViews.flatMap(l => l.view.params)].map(valuesFromOf).filter((u): u is string => u !== undefined),
    loadValues,
  )
  if (model === undefined) return null
  const view: TaskView = taskView(model)
  const showsReference = view.input.referenceAudio !== 'none'
  const offerOfParam = (v: TaskView, param: TaskParam): OfferState => {
    const url = valuesFromOf(param)
    const choices = url === undefined ? undefined : serverValues[url]
    return offerOf(v, param, choices === 'failed' ? [] : choices)
  }
  const params = view.input.referenceText === 'none' ? view.params : view.params.filter(p => !REFERENCE_PARAMS.has(p.key))
  const shown = params.filter(p => rendersControl(offerOfParam(view, p)) && !hidesTurnParam(model, p.key))
  const notOffered = params.filter(p => offerOfParam(view, p) === 'not-offered')
  const unlistedKeys = params.filter(p => offerOfParam(view, p) === 'unlisted').map(p => p.key)
  const unknownKeys = params.filter(p => offerOfParam(view, p) === 'unknown').map(p => p.key)
  // Omni-duplex models: one turn mode choice (host turnModes) instead of separate turnDetection / overlapPolicy controls.
  const turnCandidates = candidates.filter(c => c.available).map(c => ({ candidate: c, modes: turnModesOf(c.entry) })).filter((c): c is { candidate: typeof c.candidate; modes: TurnModes } => c.modes !== undefined)
  const liveOptions = liveViews
    .map(l => ({ ...l, params: l.view.params.filter(p => rendersControl(offerOfParam(l.view, p)) && !hidesTurnParam(l.candidate.entry, p.key)) }))
    .filter(l => l.params.length > 0)
  const extraSlots = EXTRA_SLOTS.filter(slot => view.input[slot] !== 'none')
  if (view.task === 'chat' && shown.length === 0 && !showsReference && liveOptions.length === 0 && turnCandidates.length === 0) return null

  const blocked = gateBlocks(gate)
  const values = inputs.values[model.id] ?? {}
  const hasValue = (param: TaskParam) => {
    const value = values[param.key] ?? param.default
    return value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
  }
  const requiredOptionsMissing = shown.filter(p => offerOfParam(view, p) === 'required' && !hasValue(p)).map(p => p.key)
  const textRequest = TEXT_REQUEST_TASKS.has(view.task)
  const missing = missingInputs(view, {
    text: textRequest ? draft : 'n/a',
    hasAudio: true,
    hasReference: inputs.reference !== undefined,
    referenceConsent: inputs.referenceConsent,
    referenceText: inputs.referenceText,
    options: values,
    extraReferences: Object.fromEntries(extraSlots.map(slot => [slot, { present: inputs.references[slot] !== undefined, consent: inputs.consents[slot] === true }])),
    requiredOptionsMissing,
  })
  const choicesOf = (param: TaskParam): readonly string[] | undefined => {
    const url = valuesFromOf(param)
    const choices = url === undefined ? undefined : serverValues[url]
    return choices === 'failed' ? undefined : choices
  }
  const onGenerate = async () => {
    const text = latestDraft.current
    const ok = await generate(text)
    if (ok && latestDraft.current === text) inputActions.setDraft('')
  }

  return (
    <section className={css.bar} aria-label={t('task.panel')} data-testid="dsh-voice-capture-task" data-task={view.task} data-task-source={view.source}>
      <div className={css.row}>
        <span className={css.taskChip} data-testid="dsh-voice-capture-task-chip">{t(`task.name.${view.task}`)}</span>
        {view.source === 'inferred' && <span className={css.caption}>{t('task.inferred')}</span>}
        <span className={css.caption} data-testid="dsh-voice-capture-task-output">{outputText(view, t)}</span>
        <span className={css.spacer} />
        {blocked && (
          <span
            className={cx(css.caption, css.warn)}
            role="status"
            title={gate.source === undefined ? undefined : t(gate.source === 'library' ? 'gate.sourceLibrary' : 'gate.sourceAdapter')}
            data-testid="dsh-voice-capture-task-gate"
            data-state={gate.state}
            data-source={gate.source}
          >
            {t(`gate.${gate.state}`)}{'detail' in gate && gate.detail !== undefined ? ` · ${gate.detail}` : ''}{'progress' in gate && gate.progress !== undefined ? ` · ${Math.round(gate.progress * (gate.progress <= 1 ? 100 : 1))}%` : ''}
          </span>
        )}
        {blocked && gate.library === true && (
          <Button size="sm" variant="ghost" onClick={() => { openLibrary() }} data-testid="dsh-voice-capture-task-open-library">{t('gate.openLibrary')}</Button>
        )}
      </div>
      {shown.length > 0 && (
        <div className={css.row} data-testid="dsh-voice-capture-task-params" data-params={inputs.params}>
          {shown.map(param => (
            <ParamControl
              key={param.key}
              param={param}
              offer={offerOfParam(view, param)}
              fact={view.options.byKey[param.key]}
              choices={choicesOf(param)}
              value={values[param.key]}
              onChange={value => { setValue(param.key, value) }}
              t={t}
            />
          ))}
        </div>
      )}
      <OptionStatusNotes view={view} notOffered={notOffered} unlistedKeys={unlistedKeys} unknownKeys={unknownKeys} t={t} />
      {view.task === 'video-generation' && videoJob !== undefined && (videoJob.model === undefined || videoJob.model === model.id) && (
        <div className={css.caption} role="status" data-testid="dsh-voice-capture-video-progress" data-status={videoJob.status}>
          {t('task.videoProgress', { status: videoJob.status, progress: videoJob.progress === undefined ? '' : ` · ${Math.round(videoJob.progress <= 1 ? videoJob.progress * 100 : videoJob.progress)}%` })}
        </div>
      )}
      {view.adapterTask === 'tts.offline-job' && jobsOf(offlineJobState, selection?.provider, model.id).slice(-1).map(job => (
        <OfflineJobLine key={job.jobId} job={job} t={t} />
      ))}
      {turnCandidates.map(({ candidate, modes }) => {
        const selected = chosenTurnMode(modes, turnChoices[candidate.model.model]).mode
        return (
          <div key={`turn-${candidate.model.model}`} className={css.referenceBox} role="radiogroup" aria-label={t('live.turnMode.label', { model: candidate.model.model })}
            data-testid="dsh-voice-capture-turn-mode" data-model={candidate.model.model} data-default={modes.default} data-selected={selected}>
            <div className={css.row}><span className={css.caption}>{t('live.turnMode.label', { model: candidate.model.model })}</span></div>
            {modes.modes.map(option => (
              <label key={option.mode} className={css.turnOption}>
                <input type="radio" name={`dsh-voice-capture-turn-${candidate.model.model}`} value={option.mode} checked={selected === option.mode}
                  onChange={() => { setTurnMode(candidate.model.model, option.mode) }} data-testid="dsh-voice-capture-turn-mode-option" data-mode={option.mode} />
                <span>{KNOWN_TURN_MODES.has(option.mode) ? t(`live.turn.choice.${option.mode as KnownTurnMode}`) : option.mode}{option.meaning === undefined ? '' : ` — ${option.meaning}`}</span>
              </label>
            ))}
          </div>
        )
      })}
      {liveOptions.map(({ candidate, params: liveParams, view: liveView }) => (
        <details key={candidate.model.model} className={css.referenceBox} data-testid="dsh-voice-capture-live-options" data-model={candidate.model.model}>
          <summary className={css.caption}>{t('task.liveOptions', { model: candidate.model.model })}</summary>
          <div className={css.row}>
            {liveParams.map(param => (
              <ParamControl
                key={param.key}
                param={param}
                offer={offerOfParam(liveView, param)}
                fact={liveView.options.byKey[param.key]}
                choices={choicesOf(param)}
                value={inputs.values[candidate.model.model]?.[param.key]}
                onChange={value => { setValue(param.key, value, candidate.model.model) }}
                t={t}
              />
            ))}
          </div>
        </details>
      ))}
      {inputs.params !== 'unset' && (
        <div className={cx(css.caption, (inputs.params === 'failed' || inputs.params === 'unsupported') && css.warn)} role="status" data-testid="dsh-voice-capture-task-params-state" data-state={inputs.params}>
          {inputs.params === 'failed' ? t('params.failed', { detail: inputs.paramsDetail ?? '' }) : t(`params.${inputs.params}`)}
        </div>
      )}
      {showsReference && (
        <div className={css.referenceBox} data-testid="dsh-voice-capture-reference">
          <div className={css.row}>
            <span className={css.title}>{view.input.referenceAudio === 'required' ? t('reference.titleRequired') : t('reference.titleOptional')}</span>
            <span className={css.spacer} />
            {recorder.phase === 'recording'
              ? (
                <>
                  <span className={css.recDot} aria-hidden="true" />
                  <span className={css.timer}>{clockText(recorder.elapsedMs)}</span>
                  <Button size="sm" variant="primary" icon={<StopSquareIcon size={14} />} onClick={stopReference}>{t('action.stop')}</Button>
                </>
              )
              : (
                <>
                  <Button size="sm" variant="outline" icon={<MicIcon size={14} />} onClick={startReference} disabled={recorder.phase === 'requesting' || recorder.phase === 'encoding'} data-testid="dsh-voice-capture-reference-record">
                    {t('reference.record')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { fileInput.current?.click() }} data-testid="dsh-voice-capture-reference-file">{t('reference.chooseFile')}</Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="audio/*"
                    hidden
                    data-testid="dsh-voice-capture-reference-input"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file !== undefined) pickReference(file)
                      event.currentTarget.value = ''
                    }}
                  />
                </>
              )}
          </div>
          {recorder.phase === 'preview' && recorder.clip !== undefined && (
            <div className={css.row}>
              <audio className={css.player} controls preload="metadata" src={recorder.clip.url} aria-label={t('reference.previewRecorded')} />
              <Button size="sm" variant="ghost" onClick={discardRecordedReference}>{t('action.discard')}</Button>
              <Button size="sm" variant="primary" onClick={keepReference} data-testid="dsh-voice-capture-reference-keep">{t('reference.use')}</Button>
            </div>
          )}
          {recorder.error !== undefined && <div className={cx(css.caption, css.warn)} role="alert">{t(`error.${recorder.error.code}`)}</div>}
          {inputs.reference !== undefined && (
            <>
              <div className={css.row}>
                <audio className={css.player} controls preload="metadata" src={inputs.reference.url} aria-label={t('reference.player')} data-testid="dsh-voice-capture-reference-player" />
                <span className={css.caption}>{inputs.reference.name}</span>
                <button type="button" className={css.iconButton} aria-label={t('reference.clear')} onClick={() => { clearReference() }}>
                  <IconCloseOutline16 size={14} />
                </button>
              </div>
              <label className={css.toggle}>
                <input type="checkbox" checked={inputs.referenceConsent} onChange={(event) => { setConsent(event.currentTarget.checked) }} data-testid="dsh-voice-capture-reference-consent" />
                <span>{t('reference.consent')}</span>
              </label>
              {view.input.referenceText !== 'none' && (
                <input
                  className={css.textInput}
                  type="text"
                  value={inputs.referenceText}
                  placeholder={view.input.referenceText === 'required' ? t('reference.textRequired') : t('reference.textOptional')}
                  aria-label={t('reference.textLabel')}
                  onChange={(event) => { setReferenceText(event.currentTarget.value) }}
                  data-testid="dsh-voice-capture-reference-text"
                />
              )}
            </>
          )}
        </div>
      )}
      {extraSlots.map(slot => (
        <ExtraReference
          key={slot}
          slot={slot}
          need={view.input[slot]}
          note={view.options.byKey[slot]?.raw.join('; ') || undefined}
          clip={inputs.references[slot]}
          consent={inputs.consents[slot] === true}
          onPick={(file) => { pickReference(file, slot) }}
          onClear={() => { clearReference(slot) }}
          onConsent={(consent) => { setConsent(consent, slot) }}
          t={t}
        />
      ))}
      {inputs.error !== undefined && (
        <div className={cx(css.row, css.warn)} role="alert" data-testid="dsh-voice-capture-task-error" data-code={inputs.error.code}>
          <IconWarningOutline16 size={14} />
          <span className={css.caption}>{t(`task.error.${inputs.error.code}`)}{inputs.error.detail === '' ? '' : ` · ${inputs.error.detail}`}</span>
          <span className={css.spacer} />
          <button type="button" className={css.iconButton} aria-label={t('action.dismiss')} onClick={dismissTaskError}><IconCloseOutline16 size={14} /></button>
        </div>
      )}
      <div className={css.row}>
        <span className={css.caption} data-testid="dsh-voice-capture-task-needs">
          {missing.length > 0
            ? t('task.needs', { items: missing.map(code => (code === 'requiredOption' ? t('task.missing.requiredOption', { keys: requiredOptionsMissing.join(', ') }) : t(`task.missing.${code}`))).join(' · ') })
            : textRequest ? t('task.readyText') : inputHint(view, t)}
        </span>
        <span className={css.spacer} />
        {textRequest && (inputs.phase === 'sending'
          ? <Button size="sm" variant="ghost" onClick={cancelGenerate}>{t('action.cancelSend')}</Button>
          : (
            <Button
              size="sm"
              variant="primary"
              icon={<IconSendOutline16 size={14} />}
              disabled={blocked || missing.length > 0}
              onClick={() => { void onGenerate() }}
              data-testid="dsh-voice-capture-task-generate"
            >
              {t(`task.action.${view.task === 'video-generation' ? 'generateVideo' : view.task === 'music-generation' || view.task === 'sound-generation' ? 'generateAudio' : 'generateSpeech'}`)}
            </Button>
          ))}
      </div>
    </section>
  )
}

/** One offline generator job: status, progress and measured delivery; never called streaming or Live. */
function OfflineJobLine({ job, t }: { job: OfflineJobState; t: TaskStripProps['t'] }) {
  const actions = recoveryActions(job)
  const status = job.status === 'unknown' ? t('offlineJob.status.unknown', { status: job.rawStatus ?? '' }) : t(`offlineJob.status.${job.status}`, { attempt: job.reconnectAttempt ?? 1 })
  const detail = [
    job.framesGenerated === undefined ? '' : t('offlineJob.frames', { frames: job.framesGenerated }),
    job.delivery === undefined ? '' : t(`offlineJob.delivery.${job.delivery}`),
    job.finishReason === undefined ? '' : t('offlineJob.finish', { reason: job.finishReason }),
  ].filter(Boolean).join(' · ')
  return (
    <div
      className={cx(css.caption, (job.status === 'failed' || job.status === 'interrupted') && css.warn)}
      role="status"
      data-testid="dsh-voice-capture-offline-job"
      data-job-id={job.jobId}
      data-status={job.status}
      data-delivery={job.delivery}
      data-stop={actions.stop.via}
      data-recover={actions.recover.available ? 'available' : actions.recover.reason}
    >
      {t('offlineJob.label')} · {status}{detail === '' ? '' : ` · ${detail}`}
      {actions.stop.available && <> · {t('offlineJob.stopHint')}</>}
      {job.status === 'interrupted' && !actions.recover.available && <> · {t('offlineJob.recoverPending')}</>}
    </div>
  )
}

function outputText(view: TaskView, t: TaskStripProps['t']): string {
  if (view.output.video) return t('task.output.video')
  if (view.output.embedding) return t('task.output.embedding')
  if (view.output.segments && !view.output.audio) return view.output.speakers ? t('task.output.speakers') : t('task.output.transcript')
  if (view.speaks) return t('task.output.spoken')
  if (view.output.audio) return view.output.audioCount === 'many' ? t('task.output.audioMany') : t('task.output.audio')
  return t('task.output.text')
}

function inputHint(view: TaskView, t: TaskStripProps['t']): string {
  if (view.task === 'alignment') return t('task.hint.alignment')
  if (view.live === 'transcription') return t('task.hint.liveTranscription')
  if (view.live === 'turn') return t('task.hint.liveTurn')
  if (view.live === 'text-input') return t('task.hint.textInput')
  if (view.live !== 'none') return t('task.hint.liveConversation')
  if (view.input.audio === 'required') return t('task.hint.audioRequired')
  if (view.input.audio === 'optional') return t('task.hint.audioOptional')
  return t('task.hint.text')
}

function ExtraReference({ slot, need, note, clip, consent, onPick, onClear, onConsent, t }: {
  slot: Exclude<ReferenceSlot, 'referenceAudio'>
  need: 'optional' | 'required' | 'none'
  note: string | undefined
  clip: { readonly name: string; readonly url: string } | undefined
  consent: boolean
  onPick: (file: File) => void
  onClear: () => void
  onConsent: (consent: boolean) => void
  t: TaskStripProps['t']
}) {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <div className={css.referenceBox} data-testid={`dsh-voice-capture-reference-${slot}`} data-need={need} title={note}>
      <div className={css.row}>
        <span className={css.title}>{t(`reference.slot.${slot}`)}{need === 'required' ? ` · ${t('reference.required')}` : ''}</span>
        <span className={css.spacer} />
        <Button size="sm" variant="ghost" onClick={() => { input.current?.click() }} data-testid={`dsh-voice-capture-reference-${slot}-file`}>{t('reference.chooseFile')}</Button>
        <input
          ref={input}
          type="file"
          accept={slot === 'imageReference' ? 'image/png,image/jpeg,image/webp,image/gif,image/bmp' : 'audio/*'}
          hidden
          data-testid={`dsh-voice-capture-reference-${slot}-input`}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file !== undefined) onPick(file)
            event.currentTarget.value = ''
          }}
        />
      </div>
      {clip !== undefined && (
        <>
          <div className={css.row}>
            {slot === 'imageReference'
              ? <img className={css.thumb} src={clip.url} alt={t(`reference.slot.${slot}`)} data-testid={`dsh-voice-capture-reference-${slot}-preview`} />
              : <audio className={css.player} controls preload="metadata" src={clip.url} aria-label={t(`reference.slot.${slot}`)} data-testid={`dsh-voice-capture-reference-${slot}-preview`} />}
            <span className={css.caption}>{clip.name}</span>
            <button type="button" className={css.iconButton} aria-label={t('reference.clear')} onClick={onClear}>
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <label className={css.toggle}>
            <input type="checkbox" checked={consent} onChange={(event) => { onConsent(event.currentTarget.checked) }} data-testid={`dsh-voice-capture-reference-${slot}-consent`} />
            <span>{t('reference.consent')}</span>
          </label>
        </>
      )}
    </div>
  )
}

/**
 * Option summary under the controls (§K.11): source, conditional requirements, unknown keys, blockers, negatives with
 * their reason and raw text, unlisted keys (collapsed, never called unsupported), catalog notes and dropped fields.
 */
function OptionStatusNotes({ view, notOffered, unlistedKeys, unknownKeys, t }: {
  view: TaskView
  notOffered: readonly TaskParam[]
  unlistedKeys: readonly string[]
  unknownKeys: readonly string[]
  t: TaskStripProps['t']
}) {
  const facts = view.options
  const conditional = Object.values(facts.byKey).filter(f => f.active && f.mandatory === 'conditional')
  const notes = facts.unmapped.map(n => n.raw ?? n.option).filter((n): n is string => n !== undefined)
  const notSendable = facts.notSendable.map(n => n.option ?? n.wireKey).filter((n): n is string => n !== undefined)
  const empty = notOffered.length === 0 && unlistedKeys.length === 0 && unknownKeys.length === 0 && conditional.length === 0
    && facts.blockers.length === 0 && notes.length === 0 && notSendable.length === 0 && facts.inputErrors.length === 0
  if (empty) return null
  return (
    <div className={css.hiddenParams} data-testid="dsh-voice-capture-option-status" data-source={facts.source} data-basis={facts.basis} data-unknown={unknownKeys.join(',')}>
      <span>{t(`option.source.${facts.source}`)}</span>
      {facts.basis === 'catalog-map-empty' && <span>{' · '}{t('option.basis.catalog-map-empty')}</span>}
      {facts.scope !== undefined && <span>{' · '}{t('option.scope', { scope: facts.scope })}</span>}
      {facts.blockers.map((blocker, index) => (
        <div key={`blocker-${index}`} className={css.warn} role="status" data-testid="dsh-voice-capture-option-blocker" data-option={blocker.option ?? blocker.wireKey}>
          {t('option.blocker', { option: blocker.raw ?? blocker.option ?? blocker.wireKey ?? '', reason: blocker.reason ?? blocker.status ?? '' })}
        </div>
      ))}
      {conditional.map(fact => (
        <div key={fact.key} className={css.warn} data-testid="dsh-voice-capture-option-conditional" data-key={fact.key}>{fact.key}: {t('option.requiredWhen', { raw: fact.conditions.join('; ') || fact.raw.join('; ') })}</div>
      ))}
      {unknownKeys.length > 0 && (
        <div data-testid="dsh-voice-capture-option-unknown">{t('option.unknown')} — {t('option.unknownKeys', { keys: unknownKeys.join(', ') })}</div>
      )}
      {notOffered.length > 0 && (
        <details data-testid="dsh-voice-capture-option-not-offered" data-keys={notOffered.map(p => p.key).join(',')}>
          <summary>{t('option.notOffered', { count: notOffered.length })}</summary>
          <ul>
            {notOffered.map((param) => {
              const fact = facts.byKey[param.key]
              const obligation = fact?.obligation ?? 'rejected'
              const detail = [...(fact?.conditions ?? []), ...(fact?.raw ?? [])]
              return (
                <li key={param.key} data-key={param.key} data-obligation={obligation}>
                  {param.key}: {t(`option.reason.${obligation as 'rejected' | 'rejected-conditional' | 'unsupported' | 'not-forwarded' | 'ignored' | 'conflict'}`)}
                  {detail.length > 0 ? ` — ${[...new Set(detail)].join('; ')}` : ''}
                </li>
              )
            })}
          </ul>
        </details>
      )}
      {unlistedKeys.length > 0 && (
        <details data-testid="dsh-voice-capture-option-unlisted" data-keys={unlistedKeys.join(',')}>
          <summary>{t('option.unlisted', { count: unlistedKeys.length })}</summary>
          <span>{unlistedKeys.join(', ')}</span>
        </details>
      )}
      {notSendable.length > 0 && <div data-testid="dsh-voice-capture-option-not-sendable">{t('option.notSendable', { options: notSendable.join(', ') })}</div>}
      {notes.length > 0 && <div data-testid="dsh-voice-capture-option-notes">{t('option.notes', { notes: notes.join('; ') })}</div>}
      {facts.inputErrors.length > 0 && (
        <div className={css.warn} data-testid="dsh-voice-capture-option-input-errors">{t('option.inputErrors', { fields: facts.inputErrors.map(e => e.field).join(', ') })}</div>
      )}
    </div>
  )
}

function ParamControl({ param, offer, fact, choices, value, onChange, t }: {
  param: TaskParam
  offer: OfferState
  fact: OptionFact | undefined
  choices: readonly string[] | undefined
  value: TaskValue | undefined
  onChange: (value: TaskValue) => void
  t: TaskStripProps['t']
}) {
  const baseLabel = param.label ?? (PARAM_LABELS.has(param.key) ? t(`param.label.${param.key}` as never) : param.key)
  // A restriction is shown on the control itself, not only in the tooltip (§K.11 offer-restricted).
  const label = offer === 'required' ? `${baseLabel} *` : offer === 'offered-restricted' && fact?.restriction !== undefined ? `${baseLabel} (${fact.restriction})` : baseLabel
  // Why the control is offered: required / listed but not verified / configured by the deployment / reported by the server.
  // Why the control is offered; every catalog-derived state is "not verified for this model" (§K.11 `verified: false`).
  const status = offer === 'required' ? `${t('option.required')} · ${t('option.unverified')}`
    : offer === 'required-conditional' ? `${t('option.requiredWhen', { raw: fact?.conditions.join('; ') ?? '' })} · ${t('option.unverified')}`
      : offer === 'offered-restricted' ? t('option.restricted', { raw: fact?.restriction ?? '' })
        : offer === 'offered-unverified' ? t('option.unverified')
          : offer === 'offered-configured' ? t('option.configured') : t('option.server')
  const title = [status, offer === 'offered-restricted' ? undefined : fact?.raw.join('; '), fact?.note].filter(Boolean).join(' · ')
  const support = offer === 'offered-configured' ? 'configured' : offer === 'offered-server' ? 'server' : 'catalog'
  const common = { 'data-param': param.key, 'data-support': support, 'data-offer': offer, 'data-obligation': fact?.obligation, 'data-mandatory': fact === undefined ? undefined : String(fact.mandatory) }
  const listId = `dsh-voice-capture-values-${param.key}`
  switch (param.type) {
    case 'enum': {
      const options = [...new Set([...param.values, ...(choices ?? [])])]
      return (
        <label className={css.param} title={title}>
          <span className={css.caption}>{label}</span>
          <select className={css.select} value={String(value ?? param.default ?? options[0] ?? '')} onChange={(event) => { onChange(event.currentTarget.value) }} {...common}>
            {options.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      )
    }
    case 'number':
    case 'integer': {
      const integral = param.type === 'integer' || (param.step !== undefined && Number.isInteger(param.step))
      const range = param.min !== undefined || param.max !== undefined ? ` (${param.min ?? '…'}–${param.max ?? '…'})` : ''
      return (
        <label className={css.param} title={title}>
          <span className={css.caption}>{label}{range}</span>
          <input
            className={css.numberInput}
            type="number"
            min={param.min}
            max={param.max}
            step={param.step ?? (integral ? 1 : 'any')}
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : String(param.default ?? '')}
            onChange={(event) => { onChange(event.currentTarget.value === '' ? '' : Number(event.currentTarget.value)) }}
            {...common}
          />
        </label>
      )
    }
    case 'boolean':
      return (
        <label className={css.toggle} title={title}>
          <input type="checkbox" checked={Boolean(value ?? param.default ?? false)} onChange={(event) => { onChange(event.currentTarget.checked) }} {...common} />
          <span>{label}</span>
        </label>
      )
    case 'list':
      return (
        <label className={cx(css.param, css.paramWide)} title={title}>
          <span className={css.caption}>{label}</span>
          <input
            className={css.textInput}
            type="text"
            value={Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : (param.default ?? []).join(', ')}
            placeholder={t('param.listHint')}
            onChange={(event) => { onChange(event.currentTarget.value) }}
            {...common}
          />
        </label>
      )
    case 'object':
      return (
        <label className={cx(css.param, css.paramWide)} title={title}>
          <span className={css.caption}>{label}</span>
          <textarea
            className={css.textInput}
            rows={2}
            value={typeof value === 'string' ? value : value !== undefined && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : param.default === undefined ? '' : JSON.stringify(param.default)}
            placeholder={t('param.objectHint')}
            onChange={(event) => { onChange(event.currentTarget.value) }}
            {...common}
          />
        </label>
      )
    case 'string':
    case 'text':
      return (
        <label className={cx(css.param, param.type === 'text' && css.paramWide)} title={title}>
          <span className={css.caption}>{label}</span>
          <input
            className={css.textInput}
            type="text"
            list={choices === undefined ? undefined : listId}
            maxLength={param.maxLength}
            value={typeof value === 'string' ? value : String(param.default ?? '')}
            placeholder={t('task.optional')}
            onChange={(event) => { onChange(event.currentTarget.value) }}
            {...common}
            data-values={choices === undefined ? undefined : 'ready'}
          />
          {choices !== undefined && (
            <datalist id={listId}>
              {choices.map(option => <option key={option} value={option} />)}
            </datalist>
          )}
        </label>
      )
    default:
      return null
  }
}
