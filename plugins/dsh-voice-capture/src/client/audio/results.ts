/**
 * Machine-readable task results in assistant messages (TASK_UI_CONTRACT_PROPOSAL.md §E):
 * one fenced `dsh-audio-result` JSON block per result. Parsed from the durable
 * message text, so results survive reload and do not depend on Markdown rendering.
 */
import { isRecord } from './api.ts'

/** One transcript segment. */
export interface TranscriptSegment {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
}

/** Sound track facts of a video output, read by the host from the MP4 container (no decode; TASK_CONTRACT §K.7). */
export interface VideoAudioTrack {
  readonly present: boolean
  readonly codec?: string
  readonly sampleRate?: number
  readonly channels?: number
  readonly durationSeconds?: number
  readonly sha256?: string
}

/** One generated or processed audio (or video) output. */
export interface ResultAudio {
  /** `audio` (default) or `video` (MP4 served by the recording route). */
  readonly kind: 'audio' | 'video'
  readonly role: string
  readonly recordingId: string
  readonly sampleRate?: number
  readonly channels?: number
  readonly durationSeconds?: number
  /** Host-observed delivery (`progressive` only when chunks arrived before the end). */
  readonly delivery?: 'progressive' | 'final-only' | 'none'
  readonly sha256?: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly audioTrack?: VideoAudioTrack
}

/** One aligned word of generated speech (host 0.4.2 `wordTimestamps`, from the server's `X-Word-Timestamps`). */
export interface WordTimestamp {
  readonly word: string
  readonly startMs: number
  readonly endMs: number
}

/** Word alignment of a speech result: `aligned` with words, or why there are none. */
export interface WordTimestamps {
  readonly state: 'aligned' | 'omitted' | 'missing' | 'invalid'
  readonly words: readonly WordTimestamp[]
}

/** Task parameters the host reports as used for the result (`params`). */
export type ResultParams = Readonly<Record<string, unknown>>

/** One parsed task result. */
export interface AudioResult {
  readonly seq: number
  readonly index: number
  readonly task: string
  readonly model?: string
  readonly language?: string
  readonly durationSeconds?: number
  readonly text?: string
  readonly segments: readonly TranscriptSegment[]
  readonly outputs: readonly ResultAudio[]
  readonly embedding?: { readonly dims: number; readonly resultId: string }
  readonly resultId?: string
  readonly wordTimestamps?: WordTimestamps
  readonly params?: ResultParams
}

const WORD_STATES: ReadonlySet<string> = new Set(['aligned', 'omitted', 'missing', 'invalid'])

function wordTimestampsOf(value: unknown): WordTimestamps | undefined {
  if (!isRecord(value) || typeof value.state !== 'string' || !WORD_STATES.has(value.state)) return undefined
  const words = Array.isArray(value.words)
    ? value.words.flatMap((w): WordTimestamp[] => {
        if (!isRecord(w) || typeof w.word !== 'string') return []
        const startMs = Number(w.startMs)
        const endMs = Number(w.endMs)
        return Number.isFinite(startMs) && Number.isFinite(endMs) ? [{ word: w.word, startMs, endMs }] : []
      })
    : []
  return { state: value.state as WordTimestamps['state'], words }
}

/** Fenced form (visible as a code block) and HTML-comment form (hidden by the Markdown renderer). */
const BLOCK = /```dsh-audio-result[ \t]*\r?\n([\s\S]*?)\r?\n```|<!--\s*dsh-audio-result\s+([\s\S]*?)\s*-->/g
const ID = /^[A-Za-z0-9._~-]{1,200}$/

/**
 * Extract result blocks from assistant text; malformed blocks are skipped.
 * @param text - assistant message text.
 * @param seq - message sequence.
 * @returns parsed results in text order.
 */
export function parseAudioResults(text: string, seq: number): AudioResult[] {
  const results: AudioResult[] = []
  let index = 0
  for (const match of text.matchAll(BLOCK)) {
    let value: unknown
    try {
      value = JSON.parse(match[1] ?? match[2]!)
    } catch {
      continue
    }
    if (!isRecord(value) || typeof value.task !== 'string') continue
    const segments = Array.isArray(value.segments) ? value.segments.flatMap(segment => {
      if (!isRecord(segment) || typeof segment.text !== 'string') return []
      const start = Number(segment.start)
      const end = Number(segment.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return []
      return [{ start, end, text: segment.text, ...(typeof segment.speaker === 'string' ? { speaker: segment.speaker } : {}) }]
    }) : []
    const outputs = Array.isArray(value.outputs) ? value.outputs.flatMap((output): ResultAudio[] => {
      if (!isRecord(output) || typeof output.recordingId !== 'string' || !ID.test(output.recordingId)) return []
      const track = isRecord(output.audioTrack) && typeof output.audioTrack.present === 'boolean' ? output.audioTrack : undefined
      const num = (value: unknown, key: string) => (typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {})
      return [{
        kind: output.kind === 'video' ? 'video' : 'audio',
        role: typeof output.role === 'string' ? output.role : 'audio',
        ...num(output.bytes, 'bytes'),
        ...num(output.width, 'width'),
        ...num(output.height, 'height'),
        ...(track === undefined ? {} : {
          audioTrack: {
            present: track.present as boolean,
            ...(typeof track.codec === 'string' ? { codec: track.codec } : {}),
            ...num(track.sampleRate, 'sampleRate'),
            ...num(track.channels, 'channels'),
            ...num(track.durationSeconds, 'durationSeconds'),
            ...(typeof track.sha256 === 'string' ? { sha256: track.sha256 } : {}),
          },
        }),
        recordingId: output.recordingId,
        ...(typeof output.sampleRate === 'number' ? { sampleRate: output.sampleRate } : {}),
        ...(typeof output.channels === 'number' ? { channels: output.channels } : {}),
        ...(typeof output.durationSeconds === 'number' ? { durationSeconds: output.durationSeconds } : {}),
        ...(output.delivery === 'progressive' || output.delivery === 'final-only' || output.delivery === 'none' ? { delivery: output.delivery } : {}),
        ...(typeof output.sha256 === 'string' && /^[0-9a-f]{64}$/.test(output.sha256) ? { sha256: output.sha256 } : {}),
      }]
    }) : []
    const embedding = isRecord(value.embedding) && typeof value.embedding.resultId === 'string' && ID.test(value.embedding.resultId)
      ? { dims: Number(value.embedding.dims) || 0, resultId: value.embedding.resultId }
      : undefined
    results.push({
      seq,
      index: index++,
      task: value.task,
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.language === 'string' ? { language: value.language } : {}),
      ...(typeof value.durationSeconds === 'number' ? { durationSeconds: value.durationSeconds } : {}),
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      segments,
      outputs,
      ...(embedding === undefined ? {} : { embedding }),
      ...(typeof value.resultId === 'string' && ID.test(value.resultId) ? { resultId: value.resultId } : {}),
      ...(wordTimestampsOf(value.wordTimestamps) === undefined ? {} : { wordTimestamps: wordTimestampsOf(value.wordTimestamps)! }),
      ...(isRecord(value.params) ? { params: value.params } : {}),
    })
  }
  return results
}

/**
 * Parse one stored result document (the JSON object of a result block).
 * @param value - decoded JSON.
 * @param seq - linking message sequence.
 * @returns the result, or undefined when malformed.
 */
export function parseResultDocument(value: unknown, seq: number): AudioResult | undefined {
  return parseAudioResults('```dsh-audio-result\n' + JSON.stringify(value) + '\n```', seq)[0]
}

/**
 * Assistant text with result and options blocks removed (plain transcript / answer).
 * @param text - assistant message text.
 * @returns text without machine blocks.
 */
export function withoutMachineBlocks(text: string): string {
  return text.replace(/```dsh-audio-(?:result|options)[ \t]*\r?\n[\s\S]*?\r?\n```|<!--\s*dsh-audio-(?:result|options)\s+[\s\S]*?-->/g, '').trim()
}

function clock(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(rest, 3)}`
}

/**
 * SubRip subtitles.
 * @param segments - transcript segments.
 * @returns SRT text.
 */
export function toSrt(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment, i) => `${i + 1}\n${clock(segment.start, ',')} --> ${clock(segment.end, ',')}\n${segment.speaker === undefined ? '' : `[${segment.speaker}] `}${segment.text}\n`).join('\n')
}

/**
 * WebVTT subtitles.
 * @param segments - transcript segments.
 * @returns VTT text.
 */
export function toVtt(segments: readonly TranscriptSegment[]): string {
  return `WEBVTT\n\n${segments.map(segment => `${clock(segment.start, '.')} --> ${clock(segment.end, '.')}\n${segment.speaker === undefined ? '' : `<v ${segment.speaker}>`}${segment.text}\n`).join('\n')}`
}

/**
 * Plain transcript with optional speaker labels.
 * @param segments - transcript segments.
 * @returns text lines.
 */
export function toPlainText(segments: readonly TranscriptSegment[]): string {
  return segments.map(segment => `${segment.speaker === undefined ? '' : `${segment.speaker}: `}${segment.text}`).join('\n')
}

/**
 * Label key for a generated output role and task.
 * @param task - result task.
 * @param role - output role.
 * @returns locale key suffix.
 */
export function outputLabel(task: string, role: string): 'speechReply' | 'generatedSpeech' | 'generatedMusic' | 'generatedSound' | 'enhancedAudio' | 'editedAudio' | 'stem' | 'audio' {
  if (role.startsWith('stem:')) return 'stem'
  if (task === 'omni-chat' || task === 's2s' || task === 'duplex') return 'speechReply'
  if (task === 'tts' || task === 'voice-clone' || role === 'speech') return 'generatedSpeech'
  if (task === 'music-generation' || role === 'music') return 'generatedMusic'
  if (task === 'sound-generation' || role === 'sound') return 'generatedSound'
  if (task === 'enhancement' || role === 'enhanced') return 'enhancedAudio'
  if (task === 'audio-edit') return 'editedAudio'
  return 'audio'
}
