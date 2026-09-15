/**
 * Turn-scoped reply-recording Definition. The audio adapter ends a completed
 * assistant message with a portable link line (CONTRACT §4):
 * `[▶ DGX audio reply · 24000 Hz · 10.88 s](/api/dsh-dgx-audio/v1/recording?id=<recordingId>)`.
 * Folding durable `assistant/message` events keeps reopened conversations
 * playable from the Session log alone; no rendering-only data is persisted.
 */
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ROUTE_PREFIX, isRecord } from './api.ts'
import { parseAudioResults } from './results.ts'
import type { AudioResult } from './results.ts'

/** One reply recording referenced by an assistant message. */
export interface ReplyRecording {
  /** Log sequence of the assistant message that carries the link. */
  readonly seq: number
  readonly recordingId: string
  /** Relative route path (resolved against the page origin when played). */
  readonly path: string
  /** Link text written by the adapter (format facts, never a transcript). */
  readonly label: string
}

/** A structured task result stored by the adapter and linked from the assistant message. */
export interface ResultLink {
  readonly seq: number
  readonly resultId: string
  readonly label: string
}

/** Immutable recordings and task results published against one Turn. */
export interface VoiceAudioTurnData {
  readonly recordings: readonly ReplyRecording[]
  readonly results: readonly AudioResult[]
  readonly resultLinks: readonly ResultLink[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Reply recordings linked from this Turn's assistant messages. */
    voiceAudio: VoiceAudioTurnData
  }
}

interface VoiceAudioState extends VoiceAudioTurnData {
  readonly turn: number
}

const RESULT_LINK = new RegExp(`\\[([^\\]\\n]{0,200})\\]\\((?:${ROUTE_PREFIX.replace(/\//g, '\\/')}\\/result\\?id=([A-Za-z0-9._~-]{1,200}))\\)`, 'g')

/**
 * Extract structured-result links (proposal §E) from assistant text.
 * @param text - assistant message text.
 * @param seq - message sequence.
 * @returns links in text order, de-duplicated by result id.
 */
export function resultLinks(text: string, seq: number): ResultLink[] {
  const found = new Map<string, ResultLink>()
  for (const match of text.matchAll(RESULT_LINK)) {
    if (!found.has(match[2]!)) found.set(match[2]!, { seq, resultId: match[2]!, label: match[1]!.trim() })
  }
  return [...found.values()]
}

const LINK = new RegExp(`\\[([^\\]\\n]{0,200})\\]\\((${ROUTE_PREFIX.replace(/\//g, '\\/')}\\/recording\\?id=([A-Za-z0-9._~-]{1,200}))\\)`, 'g')

/**
 * Extract recording links from assistant text.
 * @param text - assistant message text.
 * @param seq - message sequence.
 * @returns links in text order, de-duplicated by recording id.
 */
export function recordingLinks(text: string, seq: number): ReplyRecording[] {
  const found = new Map<string, ReplyRecording>()
  for (const match of text.matchAll(LINK)) {
    const recordingId = match[3]!
    if (!found.has(recordingId)) found.set(recordingId, { seq, recordingId, path: match[2]!, label: match[1]!.trim() })
  }
  return [...found.values()]
}

function messageText(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.message) || !Array.isArray(data.message.content)) return ''
  return data.message.content
    .map(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

/** Turn-local accumulator; it publishes Turn data and no view Node. */
export const voiceAudioDefinition: ConversationNodeDefinition<VoiceAudioState> = {
  // The engine requires the published Location data key to equal the Definition kind.
  kind: 'voiceAudio',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'assistant/message') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('voice-audio start requires turn/start')
    return { turn: match.event.data.turn, recordings: [], results: [], resultLinks: [] }
  },
  update: (context, match) => {
    if (match.event.type !== 'assistant/message') return context.state
    const text = messageText(match.event.data)
    const links = recordingLinks(text, match.event.seq)
    const parsed = parseAudioResults(text, match.event.seq)
    const linked = resultLinks(text, match.event.seq)
    if (links.length === 0 && parsed.length === 0 && linked.length === 0) return context.state
    const known = new Set(context.state.recordings.map(recording => recording.recordingId))
    const added = links.filter(link => !known.has(link.recordingId))
    const knownResults = new Set(context.state.results.map(result => `${result.seq}:${result.index}`))
    const addedResults = parsed.filter(result => !knownResults.has(`${result.seq}:${result.index}`))
    const knownLinks = new Set(context.state.resultLinks.map(link => link.resultId))
    const addedLinks = linked.filter(link => !knownLinks.has(link.resultId))
    if (added.length === 0 && addedResults.length === 0 && addedLinks.length === 0) return context.state
    return {
      ...context.state,
      resultLinks: addedLinks.length === 0 ? context.state.resultLinks : [...context.state.resultLinks, ...addedLinks],
      recordings: added.length === 0 ? context.state.recordings : [...context.state.recordings, ...added],
      results: addedResults.length === 0 ? context.state.results : [...context.state.results, ...addedResults],
    }
  },
  buildLocationData: (context, scope, previous) => {
    const state = context.state
    if (scope !== 'turn' || state === undefined || (state.recordings.length === 0 && state.results.length === 0 && state.resultLinks.length === 0)) return null
    if (previous?.kind === 'turn' && previous.turn === state.turn && previous.key === 'voiceAudio'
      && previous.value.recordings === state.recordings && previous.value.results === state.results && previous.value.resultLinks === state.resultLinks) return previous
    return { kind: 'turn', turn: state.turn, key: 'voiceAudio', value: { recordings: state.recordings, results: state.results, resultLinks: state.resultLinks } }
  },
}

/** Matched tail content: result cards plus recording links not already covered by a result. */
export interface TurnAudioMatch {
  readonly results: readonly AudioResult[]
  readonly resultLinks: readonly ResultLink[]
  readonly recordings: readonly ReplyRecording[]
}

/**
 * Chain selector for the completed-Turn tail: results and recordings at or before the closing message.
 * @param owner - closing Turn and sequence.
 * @returns matched content, or null so other tail entries may render.
 */
export function selectReplyRecordings(owner: TurnTailOwnerProps): TurnAudioMatch | null {
  const data = owner.turn.data.get('voiceAudio')
  const results = data?.results.filter(result => result.seq <= owner.seq) ?? []
  const links = data?.resultLinks.filter(link => link.seq <= owner.seq) ?? []
  const covered = new Set(results.flatMap(result => result.outputs.map(output => output.recordingId)))
  // Messages that link a stored result list their audio outputs inside it; do not repeat those recordings.
  const linkedSeqs = new Set(links.map(link => link.seq))
  const recordings = data?.recordings.filter(recording => recording.seq <= owner.seq && !covered.has(recording.recordingId) && !linkedSeqs.has(recording.seq)) ?? []
  return results.length === 0 && links.length === 0 && recordings.length === 0 ? null : { results, resultLinks: links, recordings }
}
