import { useEffect, useState } from 'react'
import { Button, IconCopyOutline16, IconDownloadOutline16, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { clockText, cx } from '../format.ts'
import type { AudioRepliesProps } from '../slots.ts'
import { ROUTE_PREFIX, routeUrl } from './api.ts'
import { saveBlob, saveRoute } from './download.ts'
import type { ReplyRecording, ResultLink } from './recordings.ts'
import { outputLabel, toPlainText, toSrt, toVtt } from './results.ts'
import type { AudioResult, ResultAudio, WordTimestamps } from './results.ts'
import type { TimelineSummary } from './playback-timeline.ts'
import { TimelineCaption } from './TimelineCaption.tsx'
import css from './audio.module.css'

type T = AudioRepliesProps['t']

/** Completed-Turn audio results: transcripts, generated audio, stems, embeddings and linked recordings (CONTRACT §4, proposal §E). */
export function AudioReplies({ matched, t, loadResult, playbackTimelineFor, usePlaybackTimelines }: AudioRepliesProps) {
  // Re-render when a stream timeline is finalized (the store version changes).
  usePlaybackTimelines(version => version)
  return (
    <div className={css.replies} data-testid="dsh-voice-capture-replies">
      {matched.resultLinks.map(link => <LinkedResult key={link.resultId} link={link} load={loadResult} t={t} timelineFor={playbackTimelineFor} />)}
      {matched.results.map(result => <ResultCard key={`${result.seq}:${result.index}`} result={result} t={t} timelineFor={playbackTimelineFor} />)}
      {matched.recordings.map(recording => (
        <RecordingPlayer
          key={recording.recordingId}
          recordingId={recording.recordingId}
          path={recording.path}
          title={t('reply.audioOutput')}
          caption={recording.label.replace(/^▶\s*/, '')}
          t={t}
          timeline={playbackTimelineFor(recording.recordingId)}
        />
      ))}
    </div>
  )
}

/** Actual playback facts by recording id (this browser). */
type TimelineFor = AudioRepliesProps['playbackTimelineFor']

function LinkedResult({ link, load, t, timelineFor }: { link: ResultLink; load: AudioRepliesProps['loadResult']; t: T; timelineFor: TimelineFor }) {
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ready'; result: AudioResult } | { phase: 'failed' }>({ phase: 'loading' })
  useEffect(() => {
    let current = true
    void load(link.resultId, link.seq).then(
      (result) => { if (current) setState(result === undefined ? { phase: 'failed' } : { phase: 'ready', result }) },
      () => { if (current) setState({ phase: 'failed' }) },
    )
    return () => { current = false }
  }, [link.resultId, link.seq, load])
  if (state.phase === 'ready') return <ResultCard result={state.result} t={t} timelineFor={timelineFor} />
  return (
    <div className={css.reply} data-testid="dsh-voice-capture-result-link" data-phase={state.phase}>
      <div className={css.replyHead}>
        <span className={css.replyTitle}>{link.label === '' ? t('result.audio') : link.label}</span>
        <span className={state.phase === 'failed' ? css.errorText : css.caption}>{state.phase === 'failed' ? t('result.unavailable') : t('result.loading')}</span>
      </div>
    </div>
  )
}

function ResultCard({ result, t, timelineFor }: { result: AudioResult; t: T; timelineFor: TimelineFor }) {
  const hasTranscript = result.segments.length > 0 || (result.text !== undefined && result.text !== '')
  const transcriptTitle = result.task === 'translation' ? t('result.translation') : result.task === 'diarization' ? t('result.speakers') : t('result.transcript')
  return (
    <div className={css.resultGroup} data-testid="dsh-voice-capture-result" data-task={result.task}>
      {hasTranscript && <TranscriptCard result={result} title={transcriptTitle} t={t} />}
      {result.outputs.map((output, index) => (output.kind === 'video'
        ? <VideoPlayer key={output.recordingId} output={output} t={t} />
        : <RecordingPlayer
          key={output.recordingId}
          recordingId={output.recordingId}
          path={`${ROUTE_PREFIX}/recording?id=${encodeURIComponent(output.recordingId)}`}
          title={titleFor(result.task, output, index, t)}
          caption={outputCaption(output, t)}
          t={t}
          timeline={timelineFor(output.recordingId)}
        />
      ))}
      {result.wordTimestamps !== undefined && <WordTimestampsCard words={result.wordTimestamps} base={`words-${result.seq}-${result.index}`} t={t} />}
      {result.embedding !== undefined && (
        <div className={css.reply} data-testid="dsh-voice-capture-embedding">
          <div className={css.replyHead}>
            <span className={css.replyTitle}>{t('result.embedding')}</span>
            <span className={css.caption}>{t('result.dims', { dims: result.embedding.dims })}</span>
            <span className={css.spacer} />
            <DownloadRoute url={routeUrl(`${ROUTE_PREFIX}/result?id=${encodeURIComponent(result.embedding.resultId)}`)} name={`embedding-${result.embedding.resultId.slice(-12)}.json`} label={t('result.downloadJson')} t={t} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Longest word list rendered inline; the JSON download always has every word. */
const MAX_WORDS_SHOWN = 200

function WordTimestampsCard({ words, base, t }: { words: WordTimestamps; base: string; t: T }) {
  const aligned = words.state === 'aligned'
  const seconds = (ms: number) => (ms / 1000).toFixed(2)
  return (
    <div className={css.reply} data-testid="dsh-voice-capture-word-timestamps" data-state={words.state} data-words={words.words.length}>
      <div className={css.replyHead}>
        <span className={css.replyTitle}>{t('result.wordTimestamps')}</span>
        <span className={css.caption}>{aligned ? t('result.wordCount', { count: words.words.length }) : t(`result.words.${words.state as 'omitted' | 'missing' | 'invalid'}`)}</span>
        <span className={css.spacer} />
        {aligned && (
          <Button size="sm" variant="ghost" icon={<IconDownloadOutline16 size={14} />} onClick={() => { saveBlob(new Blob([JSON.stringify(words.words, null, 2)], { type: 'application/json' }), `${base}.json`) }}>JSON</Button>
        )}
      </div>
      {aligned && words.words.length > 0 && (
        <ol className={css.wordList}>
          {words.words.slice(0, MAX_WORDS_SHOWN).map((word, index) => (
            <li key={index} className={css.word} title={`${seconds(word.startMs)}–${seconds(word.endMs)} s`}>
              <span>{word.word}</span>
              <span className={css.caption}>{seconds(word.startMs)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function titleFor(task: string, output: ResultAudio, index: number, t: T): string {
  const kind = outputLabel(task, output.role)
  if (kind === 'stem') return t('result.stem', { name: output.role.slice('stem:'.length) || String(index + 1) })
  return t(`result.${kind}`)
}

function outputCaption(output: ResultAudio, t?: T): string {
  return [
    output.sampleRate === undefined ? '' : `${output.sampleRate} Hz`,
    output.channels === undefined ? '' : `${output.channels} ch`,
    output.durationSeconds === undefined ? '' : clockText(output.durationSeconds * 1000),
    // Delivery as the host observed it; a complete file is never labelled streaming.
    t === undefined || output.delivery === undefined ? '' : output.delivery === 'progressive' ? t('result.deliveryProgressive') : output.delivery === 'final-only' ? t('result.deliveryFinal') : '',
  ].filter(Boolean).join(' · ')
}

function TranscriptCard({ result, title, t }: { result: AudioResult; title: string; t: T }) {
  const [copied, setCopied] = useState(false)
  const plain = result.segments.length > 0 ? toPlainText(result.segments) : (result.text ?? '')
  const base = `transcript-${result.seq}-${result.index}`
  return (
    <div className={css.reply} data-testid="dsh-voice-capture-transcript" data-segments={result.segments.length}>
      <div className={css.replyHead}>
        <span className={css.replyTitle}>{title}</span>
        <span className={css.caption}>
          {[result.language, result.durationSeconds === undefined ? undefined : clockText(result.durationSeconds * 1000), result.model].filter(Boolean).join(' · ')}
        </span>
        <span className={css.spacer} />
        <Button size="sm" variant="ghost" icon={<IconCopyOutline16 size={14} />} onClick={() => { void writeClipboard(plain).then((ok) => { setCopied(ok) }) }}>
          {copied ? t('result.copied') : t('result.copy')}
        </Button>
        <Button size="sm" variant="ghost" icon={<IconDownloadOutline16 size={14} />} onClick={() => { saveBlob(new Blob([plain], { type: 'text/plain' }), `${base}.txt`) }}>TXT</Button>
        {result.segments.length > 0 && (
          <>
            <Button size="sm" variant="ghost" onClick={() => { saveBlob(new Blob([toSrt(result.segments)], { type: 'application/x-subrip' }), `${base}.srt`) }} data-testid="dsh-voice-capture-transcript-srt">SRT</Button>
            <Button size="sm" variant="ghost" onClick={() => { saveBlob(new Blob([toVtt(result.segments)], { type: 'text/vtt' }), `${base}.vtt`) }}>VTT</Button>
            <Button size="sm" variant="ghost" onClick={() => { saveBlob(new Blob([JSON.stringify(result.segments, null, 2)], { type: 'application/json' }), `${base}.json`) }}>JSON</Button>
          </>
        )}
      </div>
      {result.segments.length > 0
        ? (
          <ol className={css.segments}>
            {result.segments.map((segment, index) => (
              <li key={index} className={css.segment}>
                <span className={css.segmentTime}>{segmentTime(segment.start)}–{segmentTime(segment.end)}</span>
                {segment.speaker !== undefined && <span className={css.speaker}>{segment.speaker}</span>}
                <span className={css.segmentText}>{segment.text}</span>
              </li>
            ))}
          </ol>
        )
        : <div className={css.transcriptText}>{plain}</div>}
    </div>
  )
}

/** Transcript timestamp with tenths of a second (`m:ss.s`). */
function segmentTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10))
  const minutes = Math.floor(tenths / 600)
  const rest = (tenths - minutes * 600) / 10
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}

function DownloadRoute({ url, name, label, t }: { url: string; name: string; label?: string; t: T }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconDownloadOutline16 size={14} />}
      disabled={state !== 'idle'}
      onClick={() => {
        setState('busy')
        void saveRoute(url, name).then(ok => { setState(ok ? 'idle' : 'failed') })
      }}
    >
      {state === 'busy' ? t('reply.downloading') : state === 'failed' ? t('reply.unavailableShort') : label ?? t('reply.download')}
    </Button>
  )
}

/** Generated video with the host's sound-track facts; the sound track is inside the MP4 (no separate audio stream). */
function VideoPlayer({ output, t }: { output: ResultAudio; t: T }) {
  const [failed, setFailed] = useState(false)
  const url = routeUrl(`${ROUTE_PREFIX}/recording?id=${encodeURIComponent(output.recordingId)}`)
  const track = output.audioTrack
  const size = output.width !== undefined && output.height !== undefined ? `${output.width}×${output.height}` : ''
  const caption = [size, output.durationSeconds === undefined ? '' : clockText(output.durationSeconds * 1000), output.delivery === 'final-only' ? t('result.deliveryFinal') : ''].filter(Boolean).join(' · ')
  const trackText = track === undefined
    ? t('result.video.trackUnknown')
    : track.present
      ? t('result.video.track', { details: [track.codec, track.sampleRate === undefined ? '' : `${track.sampleRate} Hz`, track.channels === undefined ? '' : `${track.channels} ch`, track.durationSeconds === undefined ? '' : clockText(track.durationSeconds * 1000)].filter(Boolean).join(' · ') })
      : t('result.video.noTrack')
  return (
    <div className={css.reply} data-recording-id={output.recordingId} data-testid="dsh-voice-capture-video" data-audio-track={track === undefined ? 'unknown' : String(track.present)}>
      <div className={css.replyHead}>
        <span className={css.replyTitle}>{t('result.video.title')}</span>
        {caption !== '' && <span className={css.caption}>{caption}</span>}
        <span className={css.spacer} />
        {!failed && <DownloadRoute url={url} name={`video-${output.recordingId.slice(-16)}.mp4`} t={t} />}
      </div>
      <div className={cx(css.caption, track !== undefined && !track.present && css.warn)} data-testid="dsh-voice-capture-video-track">{trackText}</div>
      {failed
        ? <div className={css.errorText} role="status">{t('reply.unavailable')}</div>
        : <video className={css.video} controls preload="metadata" src={url} onError={() => { setFailed(true) }} data-testid="dsh-voice-capture-video-player" />}
    </div>
  )
}

export function RecordingPlayer({ recordingId, path, title, caption, t, timeline }: {
  recordingId: string
  path: string
  title: string
  caption: string
  t: T
  /** Actual playback facts of the stream that produced this recording, when this browser played it. */
  timeline?: TimelineSummary
}) {
  const [failed, setFailed] = useState(false)
  const url = routeUrl(path)
  return (
    <div className={css.reply} data-recording-id={recordingId}>
      <div className={css.replyHead}>
        <span className={css.replyTitle}>{title}</span>
        {caption !== '' && <span className={css.caption}>{caption}</span>}
        <span className={css.spacer} />
        {!failed && <DownloadRoute url={url} name={`audio-${recordingId.slice(-16)}.wav`} t={t} />}
      </div>
      {failed
        ? <div className={css.errorText} role="status">{t('reply.unavailable')}</div>
        : (
          <audio
            className={css.player}
            controls
            preload="metadata"
            src={url}
            aria-label={t('reply.player')}
            onError={() => { setFailed(true) }}
            data-testid="dsh-voice-capture-reply-player"
          />
        )}
      <TimelineCaption summary={timeline} t={t} />
    </div>
  )
}

export type { ReplyRecording }
