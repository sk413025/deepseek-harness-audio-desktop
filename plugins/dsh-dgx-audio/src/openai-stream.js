// Decode OpenAI-compatible chat/transcription SSE payloads into normalized events.
//
// vLLM-Omni (0.28, serving_chat.py) tags every chunk with a top-level `modality`. Its
// audio chunks carry a base64 audio container in `choices[i].delta.content`, the same
// field text uses, so `modality` must be checked before any content is treated as text.
// OpenAI-style `delta.audio.{data,transcript}` is accepted as well.

import { LlmError } from './compat.js'
import { DONE } from './constants.js'

/**
 * @typedef {(
 *   | { type: 'meta', id?: string, model?: string }
 *   | { type: 'text', choice: number, text: string }
 *   | { type: 'reasoning', choice: number, text: string }
 *   | { type: 'audio', choice: number, base64: string, carrier: 'modality-content' | 'delta-audio', format?: string, sampleRate?: number }
 *   | { type: 'transcript', choice: number, text: string }
 *   | { type: 'finish', choice: number, reason: string }
 *   | { type: 'usage', usage: any }
 *   | { type: 'done' }
 * )} ChatStreamEvent
 */

/**
 * @param {AsyncIterable<{ data: string }>} sse
 * @param {{ audioDefaults?: { format?: string, sampleRate?: number }, onUnknown?: (chunk: any) => void }} [options]
 * @returns {AsyncGenerator<ChatStreamEvent>}
 */
export async function * chatStreamEvents(sse, options = {}) {
  let first = true
  let sawDone = false
  for await (const { data } of sse) {
    if (data === DONE) { sawDone = true; yield { type: 'done' }; break }
    let chunk
    try {
      chunk = JSON.parse(data)
    } catch (error) {
      throw new LlmError(`malformed stream payload (not JSON): ${data.slice(0, 120)}`, 'MALFORMED_STREAM', { cause: error })
    }
    if (chunk === null || typeof chunk !== 'object') {
      throw new LlmError('malformed stream payload (not an object)', 'MALFORMED_STREAM')
    }
    const failure = streamError(chunk)
    if (failure !== undefined) throw failure
    if (first) {
      first = false
      yield { type: 'meta', ...(typeof chunk.id === 'string' ? { id: chunk.id } : {}), ...(typeof chunk.model === 'string' ? { model: chunk.model } : {}) }
    }
    const modality = typeof chunk.modality === 'string' ? chunk.modality : 'text'
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const index = Number.isInteger(choice?.index) ? choice.index : 0
      const delta = choice?.delta ?? {}
      if (modality === 'audio') {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'audio', choice: index, base64: delta.content, carrier: 'modality-content' }
        }
      } else if (modality === 'text') {
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'reasoning', choice: index, text: delta.reasoning_content }
        } else if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          yield { type: 'reasoning', choice: index, text: delta.reasoning }
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) yield { type: 'text', choice: index, text: delta.content }
      } else {
        options.onUnknown?.(chunk)
      }
      const audio = delta.audio
      if (audio !== null && typeof audio === 'object') {
        if (typeof audio.data === 'string' && audio.data.length > 0) {
          yield {
            type: 'audio', choice: index, base64: audio.data, carrier: 'delta-audio',
            format: audio.format ?? options.audioDefaults?.format ?? 'pcm16',
            ...(options.audioDefaults?.sampleRate === undefined ? {} : { sampleRate: options.audioDefaults.sampleRate }),
          }
        }
        if (typeof audio.transcript === 'string' && audio.transcript.length > 0) yield { type: 'transcript', choice: index, text: audio.transcript }
      }
      if (typeof choice?.finish_reason === 'string') yield { type: 'finish', choice: index, reason: choice.finish_reason }
    }
    if (chunk.usage !== null && typeof chunk.usage === 'object' && chunk.usage.prompt_tokens !== undefined) {
      yield { type: 'usage', usage: chunk.usage }
    }
  }
  if (!sawDone) throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}

/** vLLM emits `data: {"error": {...}}` or `{"object":"error", ...}` mid-stream. */
function streamError(chunk) {
  const body = chunk.error !== undefined && chunk.error !== null ? chunk.error : chunk.object === 'error' ? chunk : undefined
  if (body === undefined) return undefined
  const message = typeof body === 'string' ? body : String(body.message ?? JSON.stringify(body)).slice(0, 800)
  const status = Number(body.code ?? body.status)
  const code = status === 429 ? 'RATE_LIMIT' : status >= 400 && status < 500 ? 'INVALID_REQUEST' : 'SERVER'
  return new LlmError(`backend stream error: ${message}`, code, Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {})
}
