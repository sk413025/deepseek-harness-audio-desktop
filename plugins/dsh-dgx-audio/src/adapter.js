// LlmAdapter for OpenAI-compatible vLLM / vLLM-Omni audio endpoints.
//
// Transport is chosen per model and per observed server behavior (capabilities.js):
// `stream: true` SSE yields Harness text deltas as they arrive and forwards audio payloads
// to the rendering-only AudioHub; `stream: false` keeps the verified complete-response path.

import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { LlmAdapterBase, LlmError, attributionHeaders } from './compat.js'
import { attachmentRefFromHandle, loadAttachmentBytes, loadAudioAttachment, mimeOf, parseFileHandle, audioFormatOf } from './audio.js'
import { readSse } from './sse.js'
import { chatStreamEvents } from './openai-stream.js'
import { safeSegment } from './recording.js'
import { AudioHub } from './audio-hub.js'
import { routeApiKey } from './config.js'
import { generateVideoRequest } from './video.js'
import { alignRequest, auxiliaryLocal, generateAudioRequest, isContextNotice, pendingUserMessages, renderAsrBody, speechRequest, validateTaskParams } from './tasks.js'
import { catalogTasksOf, catalogTasksSourceOf, extractOptionsBlock, taskOf, uiTaskOf } from './task-map.js'
import { resultLinkLine } from './results.js'
import { appendInvocationRecord, refusalRecord } from './records.js'

export { taskOf }

/** Marks the adapter's evidence footer so it is stripped from assistant history on later turns. */
export const FOOTER_MARKER = '\n\n---\n**DGX audio adapter**'

export class DgxAudioAdapter extends LlmAdapterBase {
  /**
   * @param {object} deps
   * @param {() => any} deps.config - current resolved plugin config.
   * @param {() => any} deps.attachments - resolves `ctx.attachments`.
   * @param {(message: string) => void} deps.log
   * @param {() => import('./audio-hub.js').AudioHub | undefined} [deps.hub]
   * @param {import('./capabilities.js').CapabilityRegistry} [deps.capabilities]
   * @param {typeof fetch} [deps.fetch]
   * @param {import('./live-turns.js').LiveTurnRegistry} [deps.turns]
   */
  constructor(deps) {
    super()
    this.deps = deps
    this.fetch = deps.fetch ?? globalThis.fetch
    // Recordings are persisted through a hub even when no UI route is mounted.
    if (deps.hub === undefined) {
      const hub = new AudioHub({ outputDir: () => deps.config().outputDir, log: deps.log })
      this.deps = { ...deps, hub: () => hub }
    }
  }

  /** @param {string} provider */
  route(provider) {
    const route = this.deps.config().routes.find(r => r.provider === provider)
    if (route === undefined) throw new LlmError(`dsh-dgx-audio: unknown provider route "${provider}"`, 'NO_ADAPTER')
    return route
  }

  /** @param {string} provider @param {string} model */
  modelConfig(provider, model) {
    const found = this.route(provider).models.find(m => m.id === model)
    if (found === undefined) throw new LlmError(`dsh-dgx-audio: model "${model}" is not configured on "${provider}"`, 'UNKNOWN_MODEL')
    return found
  }

  providerInfo(provider) {
    return { id: provider, name: this.route(provider).displayName }
  }

  async listModels(provider) {
    return this.route(provider).models.filter(m => m.mode !== 'realtime').map(m => ({
      provider,
      id: m.id,
      name: m.name ?? m.id,
      ...(m.description === undefined ? {} : { description: m.description }),
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const m = this.modelConfig(provider, model)
    return {
      provider,
      id: m.id,
      name: m.name ?? m.id,
      inputModalities: ['text'],
      context: { contextWindow: m.contextWindow },
      ...(m.maxTokens === undefined ? {} : { defaultMaxTokens: m.maxTokens }),
    }
  }

  /** @param {any} options - dsh-llm GenerateOptions */
  async * stream(options) {
    const config = this.deps.config()
    const route = this.route(options.provider)
    const model = this.modelConfig(options.provider, options.model)
    const auxiliary = options.purpose !== undefined
    const liveOnly = model.mode === 'realtime' && !auxiliary
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new LlmError(
        `dsh-dgx-audio: ${model.id} does not support tool calling. Start the session with the "DGX audio (no tools)" preset.`,
        'UNSUPPORTED_OPTION',
      )
    }
    if (options.stop !== undefined && options.stop.length > 0 && model.mode !== 'chat' && !auxiliary) {
      throw new LlmError(`dsh-dgx-audio: stop sequences are not supported by ${model.mode} models`, 'UNSUPPORTED_OPTION')
    }
    const activation = this.deps.activation?.(options.provider, model.id)

    const started = Date.now()
    const t0 = performance.now()
    const timeout = AbortSignal.timeout(config.requestTimeoutMs)
    const switchAbort = new AbortController() // model switch / drain({ cancel: true })
    const signal = AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), timeout, switchAbort.signal])
    // Auxiliary calls (session title, compaction) never send audio or request speech.
    const converted = await this.convertMessages(options, model, { includeAudio: !auxiliary, signal })
    const upstreamModel = model.upstreamModel ?? model.id
    const wantAudio = !auxiliary && ((model.mode === 'chat' && model.outputAudio === true) || model.mode === 'speech' || model.mode === 'generate-audio')
    const sessionKey = options.sessionId === undefined ? 'no-session' : String(options.sessionId)
    const inline = auxiliary ? { params: {} } : inlineOptions(options, model)
    // Precedence: logged inline dsh-audio-options block > session-params route > model defaults.
    const taskParams = auxiliary ? {} : { ...(this.deps.sessionParams?.get(sessionKey, options.provider, model.id) ?? {}), ...inline.params }
    const call = new CallState({
      adapter: this, config, route, model, options, upstreamModel, wantAudio, auxiliary, started, t0, taskParams, abortController: switchAbort, attachmentNames: inline.attachments, inlineOptions: inline.params,
      record: {
        time: new Date(started).toISOString(),
        sessionId: options.sessionId === undefined ? null : String(options.sessionId),
        purpose: options.purpose ?? 'conversation',
        provider: options.provider,
        model: model.id,
        upstreamModel,
        mode: auxiliary ? 'chat' : model.mode,
        inputAudio: converted.audio.map(a => ({
          name: a.name, format: a.format, bytes: a.bytes, sha256: a.sha256, verifiedBy: a.verifiedBy,
          durationSeconds: a.wav?.durationSeconds ?? null, sampleRate: a.wav?.sampleRate ?? null, channels: a.wav?.channels ?? null,
        })),
      },
    })

    // A staged live receipt (audio capture or streamed-TTS text) replays without a model call. This also works when the
    // conversation model is the Live-only model itself, and does not need the model to be activated.
    const liveTurn = auxiliary ? undefined : await this.liveTurnFor(converted, signal)
    if (liveTurn !== undefined) {
      yield * this.replayLiveTurn(call, liveTurn)
      return
    }
    if (liveOnly) {
      // I2-A #2: say what to do instead. Session titles/compaction for such a session stay local (auxiliaryLocal).
      const chatModels = route.models.filter(m => m.mode !== 'realtime').map(m => `"${m.name ?? m.id}" (${m.id})`)
      const pick = chatModels.length > 0 ? `pick ${chatModels.join(' or ')} on the same server as the conversation model` : 'pick a chat, transcription or speech model as the conversation model'
      const refusal = new LlmError(`dsh-dgx-audio: "${model.name ?? model.id}" is a Live-only model and cannot answer typed or file prompts. To talk to it, press Live. For typed or file prompts, ${pick}.`, 'UNSUPPORTED_OPTION')
      await this.writeLog(config, refusalRecord({ origin: 'adapter.stream', code: refusal.code, message: refusal.message, route, model, sessionId: options.sessionId, purpose: options.purpose ?? 'conversation', activation }))
      throw refusal
    }
    if (activation !== undefined && activation.state !== 'ready') {
      // 0.4.7 (§K.12): a fail-fast refusal is logged (zero upstream requests), never as a completed invocation.
      const refusal = new LlmError(`dsh-dgx-audio: ${options.provider}/${model.id} is ${activation.state}${activation.detail ? ` (${activation.detail})` : ''}; activate the model first`, 'MODEL_NOT_READY')
      await this.writeLog(config, refusalRecord({ origin: 'adapter.stream', code: refusal.code, message: refusal.message, route, model, sessionId: options.sessionId, purpose: options.purpose ?? 'conversation', activation }))
      throw refusal
    }

    let settled = false
    const work = this.deps.work?.begin({ kind: auxiliary ? 'auxiliary' : model.mode, provider: options.provider, model: model.id, sessionId: sessionKey, cancel: () => call.abortController?.abort() })
    try {
      let upstream
      if (auxiliary && model.mode !== 'chat') upstream = auxiliaryLocal(call, options)
      else if (auxiliary || model.mode === 'chat') upstream = this.chat(call, converted, signal)
      else if (model.mode === 'transcribe' || model.mode === 'translate') upstream = this.transcribe(call, converted, signal)
      else if (model.mode === 'speech') upstream = speechRequest(call, converted, signal)
      else if (model.mode === 'generate-audio') upstream = generateAudioRequest(call, converted, signal)
      else if (model.mode === 'align') upstream = alignRequest(call, converted, signal)
      else if (model.mode === 'generate-video') upstream = generateVideoRequest(call, converted, signal)
      else throw new LlmError(`dsh-dgx-audio: unsupported mode ${model.mode}`, 'UNSUPPORTED_OPTION')
      for await (const chunk of upstream) yield chunk
      yield * call.finish()
      settled = true
    } catch (error) {
      settled = true
      const failure = switchAbort.signal.aborted && !options.signal?.aborted
        ? new LlmError(`dsh-dgx-audio: request cancelled because ${options.provider}/${model.id} is being switched or unloaded`, 'ABORTED', { cause: error })
        : normalizeError(error, { options, timeout, route, config })
      await call.fail(failure)
      throw failure
    } finally {
      // The consumer stopped iterating early: the upstream reader is already cancelled.
      if (!settled) await call.fail(new LlmError('dsh-dgx-audio: consumer stopped reading the stream', 'ABORTED'))
      work?.end()
    }
  }

  /** An unbound live turn whose captured input is the newest audio of the last user message. */
  async liveTurnFor(converted, signal) {
    const turns = this.deps.turns
    if (turns === undefined) return undefined
    const last = converted.pendingAudio.at(-1)
    if (last !== undefined) return turns.find(last.sha256)
    // Streamed text-to-speech receipt: the newest pending text file whose content-addressed id names an unbound turn,
    // re-read through the attachment store (sha256 + length verified) before it is trusted.
    for (const { handle, ref } of [...(converted.pendingTextFiles ?? [])].reverse()) {
      const sha = String(ref.attachmentId).slice('sha256:'.length)
      const turn = turns.find(sha)
      if (turn === undefined || turn.input?.kind !== 'text') continue
      try {
        const loaded = await loadAttachmentBytes(handle, this.deps.attachments(), signal)
        // Hash the bytes actually read: the turn is keyed by what the live session recorded, not by the handle's name.
        if (createHash('sha256').update(loaded.data).digest('hex') === sha && loaded.bytes === turn.input.bytes) return turn
        this.deps.log(`dsh-dgx-audio: live text receipt ${handle.name} does not match the recorded input; not replayed`)
      } catch (error) {
        this.deps.log(`dsh-dgx-audio: live text receipt ${handle.name} not replayed: ${error?.message ?? error}`)
      }
    }
    return undefined
  }

  /**
   * Put an already-answered live exchange into the conversation without a second model call.
   * @param {CallState} call
   */
  async * replayLiveTurn(call, turn) {
    const lines = []
    for (const response of turn.responses) {
      if (response.transcript) lines.push(response.transcript.trim())
    }
    const text = lines.join('\n\n') || '[live response without transcript]'
    yield * call.delta('text', text)
    // 0.4.7: the live model that actually produced the exchange (captured at close), not the conversation model.
    const liveOrigin = turn.origin === undefined ? undefined : { provider: turn.provider, model: turn.model, ...turn.origin }
    const record = {
      ...call.record, transport: 'live-replay', ok: true, latencySeconds: 0, liveId: turn.liveId, liveModel: `${turn.provider}/${turn.model}`, ...(liveOrigin ? { liveOrigin } : {}),
      outputText: text, liveResponses: turn.responses.map(r => ({ responseId: r.responseId, status: r.status, reason: r.reason ?? null, recording: r.recording?.recordingId ?? null })),
    }
    this.deps.turns.markBound(turn.inputSha256, { boundSessionId: call.record.sessionId })
    await this.writeLog(call.config, record)
    const textTurn = turn.input?.kind === 'text'
    const outputs = turn.responses.filter(r => r.recording).map(r => ({ kind: 'audio', role: 'speech', recordingId: r.recording.recordingId, sampleRate: r.recording.sampleRate, channels: r.recording.channels, durationSeconds: r.recording.durationSeconds, sha256: r.recording.sha256, delivery: r.delivery ?? null }))
    const words = turn.responses.flatMap(r => r.wordTimestamps ?? [])
    const result = {
      v: 1, task: turn.uiTask ?? (textTurn ? 'tts-stream' : 'duplex'), adapterTask: turn.task ?? (textTurn ? 'tts.stream-input' : 'duplex'), origin: 'live-replay',
      provider: turn.provider, model: turn.model, liveId: turn.liveId,
      ...(turn.origin ? { upstreamModel: turn.origin.upstreamModel, catalogTasks: turn.origin.catalogTasks, catalogTasksSource: turn.origin.catalogTasksSource, ...(turn.origin.deploymentId ? { deploymentId: turn.origin.deploymentId } : {}) } : {}),
      input: { kind: turn.input?.kind ?? 'audio', sha256: turn.input?.sha256 ?? null, bytes: turn.input?.bytes ?? null },
      outputs, ...(words.length > 0 ? { wordTimestamps: { state: 'aligned', sentences: words } } : {}), ...(turn.params ? { params: turn.params } : {}),
    }
    const carrier = outputs.length > 0 || words.length > 0 ? await this.resultCarrier(call.config, result) : ''
    if (call.config.annotate) {
      const kind = textTurn ? 'streamed text-to-speech exchange' : 'live duplex exchange'
      const out = [`${FOOTER_MARKER} — ${kind} \`${turn.provider}/${turn.model}\` (${turn.liveId}); replayed from the live session, no second model call`]
      if (textTurn) out.push(`- text in (streamed): ${turn.input.chars} characters · ${turn.input.bytes} bytes · sha256 \`${turn.input.sha256.slice(0, 16)}…\``)
      else out.push(`- audio in (live capture): ${turn.input.durationSeconds} s · ${turn.input.bytes} bytes · sha256 \`${turn.input.sha256.slice(0, 16)}…\``)
      for (const r of turn.responses) {
        if (r.recording) out.push(`- [▶ live reply ${r.status}${r.reason ? ` (${r.reason})` : ''} · ${r.recording.sampleRate} Hz · ${r.recording.durationSeconds} s](${r.recording.url})`)
        else out.push(`- live reply ${r.status}${r.reason ? ` (${r.reason})` : ''}: no audio recorded`)
      }
      yield * call.delta('text', `${out.join('\n')}\n${carrier}`)
    } else if (carrier) {
      yield * call.delta('text', `${FOOTER_MARKER}\n${carrier}`)
    }
    for (const [kind, block] of [...call.blocks.entries()].sort((a, b) => a[1].index - b[1].index)) {
      yield { type: 'block-end', index: block.index, block: { type: kind, text: block.text } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * Convert Harness messages to OpenAI chat messages, turning audio file handles into input_audio parts.
   * @param {any} options - dsh-llm GenerateOptions
   * @param {any} model
   * @param {{ includeAudio: boolean, signal: AbortSignal }} opts
   */
  async convertMessages(options, model, { includeAudio, signal }) {
    const config = this.deps.config()
    const systemTexts = []
    const messages = []
    const audio = []
    let totalAudioBytes = 0
    // vLLM caps audio items per prompt (limit_mm_per_prompt): re-send only the newest ones.
    const totalAudioHandles = options.messages
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter(b => b.type === 'text' && audioFormatOf(parseFileHandle(b.text)?.name ?? '') !== undefined).length
    let audioOrdinal = 0
    if (options.system) systemTexts.push(options.system)
    const pendingIndexes = new Set(pendingUserMessages(options.messages).map(([i]) => i))
    const pendingTextFiles = []
    const pendingFiles = []
    let droppedContextNotices = 0
    for (const [messageIndex, message] of options.messages.entries()) {
      // 0.4.8 (§K.14): a Harness context notice ("[model changed: …]") is not the user's turn. Sent as a user message it
      // becomes an extra text turn after the audio in template-driven audio models (MiMo-Audio spoken dialogue).
      if (includeAudio && isContextNotice(message)) {
        droppedContextNotices += 1
        continue
      }
      if (message.role === 'system') {
        systemTexts.push(textOf(message.content))
        continue
      }
      if (message.role === 'assistant') {
        const text = textOf(message.content).split(FOOTER_MARKER)[0]
        if (text.length > 0) messages.push({ role: 'assistant', content: text })
        continue
      }
      const parts = []
      for (const block of message.content) {
        if (block.type !== 'text') {
          parts.push({ type: 'text', text: blockPlaceholder(block) })
          continue
        }
        const handle = parseFileHandle(block.text)
        if (handle !== undefined && audioFormatOf(handle.name) === undefined && pendingIndexes.has(messageIndex) && handle.path !== undefined) {
          const ref = attachmentRefFromHandle(handle)
          if (ref !== undefined) {
            pendingFiles.push({ handle, ref })
            if (/\.txt$/i.test(handle.name) && handle.bytes <= 1_048_576) pendingTextFiles.push({ handle, ref })
          }
        }
        if (handle === undefined || audioFormatOf(handle.name) === undefined) {
          // The logged dsh-audio-options block configures the task; it is not model input.
          parts.push({ type: 'text', text: block.text.includes('```dsh-audio-options') ? extractOptionsBlock(block.text).text : block.text })
          continue
        }
        audioOrdinal += 1
        if (!includeAudio) {
          parts.push({ type: 'text', text: `[audio attachment "${handle.name}"]` })
          continue
        }
        if (totalAudioHandles - audioOrdinal >= model.maxAudioPerRequest) {
          parts.push({ type: 'text', text: `[earlier audio attachment "${handle.name}" not re-sent: at most ${model.maxAudioPerRequest} audio items per request]` })
          continue
        }
        let loaded
        try {
          loaded = await loadAudioAttachment(handle, this.deps.attachments(), signal)
        } catch (error) {
          throw new LlmError(`dsh-dgx-audio: ${error?.message ?? error}`, 'ATTACHMENT_UNREADABLE', { cause: error })
        }
        totalAudioBytes += loaded.bytes
        if (totalAudioBytes > config.maxAudioBytes) {
          throw new LlmError(`dsh-dgx-audio: audio in this conversation exceeds maxAudioBytes (${config.maxAudioBytes})`, 'INVALID_REQUEST')
        }
        audio.push({ ...loaded, pending: pendingIndexes.has(messageIndex) })
        parts.push({ type: 'input_audio', input_audio: { data: loaded.data.toString('base64'), format: loaded.format } })
      }
      const merged = mergeTextParts(parts)
      if (merged.length > 0) messages.push({ role: 'user', content: merged })
    }
    let system = systemTexts.filter(Boolean).join('\n\n')
    // Auxiliary calls (session title, compaction) keep their own instructions.
    if (includeAudio && model.systemPrompt !== undefined && model.systemPrompt.length > 0) system = model.systemPrompt
    const plan = system && audio.length > 0 ? systemPlacementPlan(model, this.deps.capabilities?.evidenceFor(this.route(options.provider), model, 'systemWithAudio')) : { placement: 'system', reason: 'no-system-or-audio' }
    const converted = { system, systemPlacement: 'system', systemPlacementReason: plan.reason, messages, audio, pendingAudio: audio.filter(a => a.pending), pendingTextFiles, pendingFiles, droppedContextNotices }
    return plan.placement === 'user-prefix' ? foldSystemIntoUser(converted, plan.reason) : converted
  }

  /** @param {CallState} call */
  async * transcribe(call, converted, signal) {
    const { route, model, upstreamModel } = call
    // The pending user turn (every user message after the last assistant, minus Harness notices such as
    // "[model changed: …]", which is appended after the prompt on the first request after a model switch).
    const last = converted.pendingAudio.at(-1)
    if (last === undefined) {
      throw new LlmError(`dsh-dgx-audio: ${model.id} ${model.mode === 'translate' ? 'translates' : 'transcribes'} an audio attachment — attach a WAV/MP3 file to your message`, 'NO_AUDIO_INPUT')
    }
    // Only the newest attachment is transcribed; earlier ones are not re-sent.
    call.record.inputAudio = call.record.inputAudio.filter(a => a.sha256 === last.sha256).slice(-1)
    const asr = { ...model.asr, ...(model.language ? { language: model.language } : {}), ...call.taskParams }
    const responseFormat = asr.responseFormat ?? 'json'
    call.asrResponseFormat = responseFormat
    const endpoint = `${route.baseURL.replace(/\/+$/, '')}/audio/${model.mode === 'translate' ? 'translations' : 'transcriptions'}`
    // Only the json format has an incremental text representation.
    let sse = responseFormat === 'json' && (this.deps.capabilities?.wantsTextStream(route, model) ?? model.streaming?.text !== 'off')
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new FormData()
      form.set('model', upstreamModel)
      form.set('response_format', responseFormat)
      form.set('temperature', String(model.temperature ?? 0))
      if (asr.language) form.set('language', asr.language)
      if (asr.prompt) form.set('prompt', asr.prompt)
      if (asr.toLanguage) form.set('to_language', asr.toLanguage)
      if (responseFormat === 'verbose_json') for (const g of asr.timestampGranularities ?? []) form.append('timestamp_granularities[]', g)
      if (sse) form.set('stream', 'true')
      form.set('file', new Blob([last.data], { type: mimeOf(last.format) }), last.name)
      call.taskParamsUsed = { language: asr.language ?? null, prompt: asr.prompt ?? null, toLanguage: asr.toLanguage ?? null, responseFormat }
      call.record.request = { endpoint, stream: sse, multipart: { model: upstreamModel, language: asr.language ?? null, response_format: responseFormat, file: last.name } }
      call.mark('requestSent')
      const response = await this.fetch(endpoint, { method: 'POST', body: form, headers: headers(route), signal })
      call.mark('responseHeaders')
      const outcome = await call.acceptResponse(response, endpoint, sse)
      if (outcome === 'retry-without-stream') { sse = false; continue }
      yield * call.consume(response, outcome, signal)
      return
    }
  }

  /** @param {CallState} call */
  async * chat(call, converted, signal) {
    const { route, model, upstreamModel, options, wantAudio } = call
    const endpoint = `${route.baseURL.replace(/\/+$/, '')}/chat/completions`
    let sse = this.deps.capabilities?.wantsTextStream(route, model) ?? model.streaming?.text !== 'off'
    // One retry with the system prompt folded into the user turn when the server rejects system + audio and the model
    // entry left the choice to the adapter (systemPromptWithAudio: auto).
    call.systemFallbackAllowed = (model.systemPromptWithAudio ?? 'auto') === 'auto' && converted.system !== '' && converted.audio.length > 0
    for (let attempt = 0; attempt < 3; attempt++) {
      const messages = []
      if (converted.system) messages.push({ role: 'system', content: [{ type: 'text', text: converted.system }] })
      messages.push(...converted.messages)
      const body = {
        model: upstreamModel,
        messages,
        stream: sse,
        ...(sse ? { stream_options: { include_usage: true } } : {}),
        ...(options.temperature ?? model.temperature) === undefined ? {} : { temperature: options.temperature ?? model.temperature },
        ...(options.maxTokens ?? model.maxTokens) === undefined ? {} : { max_tokens: options.maxTokens ?? model.maxTokens },
        ...(options.stop?.length ? { stop: options.stop } : {}),
        ...(model.extraBody ?? {}),
      }
      // Only vLLM-Omni understands `modalities` (and requires it when streaming); ask for speech only when this call wants it.
      if (model.sendModalities) body.modalities = wantAudio ? ['text', 'audio'] : ['text']
      if (wantAudio && model.audioFormat !== undefined) body.audio = { format: model.audioFormat }
      call.record.request = {
        endpoint,
        stream: sse,
        modalities: body.modalities ?? null,
        systemPlacement: converted.systemPlacement,
        systemPlacementReason: converted.systemPlacementReason,
        systemPrompt: converted.system ? `${converted.system.slice(0, 160)}${converted.system.length > 160 ? '…' : ''}` : null,
        droppedContextNotices: converted.droppedContextNotices ?? 0,
        // 0.4.8 (§K.14): the sampling fields actually sent, so a run can be checked against the server recipe.
        sampling: samplingRecord(body, model.extraBody),
        messages: messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content
            : m.content.map(p => p.type === 'input_audio'
              ? { type: 'input_audio', format: p.input_audio.format, base64Chars: p.input_audio.data.length }
              : p),
        })),
      }
      if (wantAudio) call.openAudioStream()
      call.mark('requestSent')
      const response = await this.fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { ...headers(route), 'content-type': 'application/json', ...(sse ? { accept: 'text/event-stream' } : {}) },
        signal,
      })
      call.mark('responseHeaders')
      const outcome = await call.acceptResponse(response, endpoint, sse)
      if (outcome === 'retry-without-stream') { sse = false; continue }
      if (outcome === 'retry-user-prefix') {
        call.systemFallbackAllowed = false
        call.retriedWithUserPrefix = true
        converted = foldSystemIntoUser(converted, 'server-rejected-system-with-audio')
        continue
      }
      yield * call.consume(response, outcome, signal)
      return
    }
  }

  /**
   * Result carrier text for the footer: a link line to the durable result (default), or the legacy fence.
   * @returns {Promise<string>}
   */
  async resultCarrier(config, result) {
    if (config.resultCarrier !== 'fence' && this.deps.results !== undefined) {
      const id = await this.deps.results.save(result)
      if (id !== undefined) return `\n${resultLinkLine(result.task, id)}\n`
    }
    return resultFence(result)
  }

  async writeLog(config, record) {
    await appendInvocationRecord(config, record, this.deps.log)
  }
}

/**
 * Per-call state: Harness block bookkeeping, audio stream, timeline evidence and log record.
 */
class CallState {
  constructor(init) {
    Object.assign(this, init)
    this.blocks = new Map() // kind → { index, text }
    this.nextIndex = 0
    this.text = ''
    this.usage = undefined
    this.finishReason = undefined
    this.requestId = undefined
    this.audioStream = undefined
    this.audioSummary = undefined
    this.status = undefined
    this.endpoint = undefined
    this.transport = undefined
    this.timeline = { textDeltas: 0, reasoningDeltas: 0, audioPayloads: 0, sseEvents: 0, bytesIn: 0 }
  }

  mark(name) {
    if (this.timeline[`${name}Ms`] === undefined) this.timeline[`${name}Ms`] = round(performance.now() - this.t0)
  }

  get hub() { return this.adapter.deps.hub?.() }
  get capabilities() { return this.adapter.deps.capabilities }

  openAudioStream() {
    if (this.audioStream !== undefined || this.hub === undefined) return
    const sessionId = this.options.sessionId === undefined ? 'no-session' : String(this.options.sessionId)
    this.audioStream = this.hub.openStream({
      sessionId, provider: this.options.provider, model: this.model.id, origin: 'chat', task: taskOf(this.model),
      fileStem: `${new Date(this.started).toISOString().replace(/[:.]/g, '-')}-${safeSegment(this.model.id)}`,
    })
  }

  /**
   * Validate the HTTP response and pick how to read it.
   * @returns {Promise<'sse' | 'json' | 'retry-without-stream'>}
   */
  async acceptResponse(response, endpoint, requestedSse) {
    this.endpoint = endpoint
    this.status = response.status
    const type = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const streamRefused = requestedSse && (response.status === 400 || response.status === 422) && /stream/i.test(raw)
      if (streamRefused && (this.model.streaming?.text ?? 'auto') === 'auto') {
        this.capabilities?.observe(this.route, this.model, 'textStreaming', { state: 'unsupported', source: 'request', detail: `HTTP ${response.status}: ${raw.slice(0, 160)}` })
        this.adapter.deps.log(`dgx-audio: ${this.model.id} refused stream:true (HTTP ${response.status}); retrying once without streaming`)
        this.retriedWithoutStream = true
        return 'retry-without-stream'
      }
      if (response.status === 400 && SYSTEM_WITH_AUDIO_REJECTED.test(raw)) {
        this.capabilities?.note(this.route, this.model, 'systemWithAudio', { rejected: true, source: 'request', detail: `HTTP 400: ${raw.slice(0, 200)}` })
        if (this.systemFallbackAllowed) {
          this.adapter.deps.log(`dgx-audio: ${this.model.id} rejected a system message with audio (HTTP 400); retrying once with the system prompt folded into the user turn`)
          return 'retry-user-prefix'
        }
        throw new LlmError(`dsh-dgx-audio: ${endpoint} returned HTTP 400: ${raw.slice(0, 600)} — this model does not accept a system message together with audio; set systemPromptWithAudio: "user-prefix" (or "auto") for ${this.model.id}`, 'INVALID_REQUEST', { status: 400 })
      }
      const code = response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
      throw new LlmError(`dsh-dgx-audio: ${endpoint} returned HTTP ${response.status}: ${raw.slice(0, 800)}`, code, { status: response.status })
    }
    if (requestedSse && type.includes('text/event-stream')) return 'sse'
    if (requestedSse) {
      // The server ignored stream:true and answered with one body.
      this.capabilities?.observe(this.route, this.model, 'textStreaming', { state: 'unsupported', source: 'request', detail: `stream:true answered with ${type || 'no content-type'}` })
    }
    return 'json'
  }

  async * consume(response, how, signal) {
    this.transport = how
    if (how === 'json') {
      yield * this.consumeJson(response)
      return
    }
    const limits = this.config.sseLimits
    const sse = readSse(response.body, { signal, limits, onBytes: (n) => { this.timeline.bytesIn += n } })
    const counted = (async function * (self) {
      for await (const event of sse) { self.timeline.sseEvents += 1; yield event }
    })(this)
    let textBeforeDone = 0
    for await (const event of chatStreamEvents(counted)) {
      switch (event.type) {
        case 'meta':
          this.requestId ??= event.id
          break
        case 'text':
        case 'transcript':
          // OpenAI-style `delta.audio.transcript` is the spoken text; use it only when no content text exists.
          if (event.type === 'text') this.sawContentText = true
          else if (this.sawContentText) break
          this.mark('firstText')
          this.timeline.textDeltas += 1
          textBeforeDone += 1
          yield * this.delta('text', event.text)
          break
        case 'reasoning':
          this.timeline.reasoningDeltas += 1
          yield * this.delta('reasoning', event.text)
          break
        case 'audio':
          await this.acceptAudio(Buffer.from(event.base64, 'base64'), { format: event.format ?? this.model.audioFormat, sampleRate: event.sampleRate })
          break
        case 'finish':
          this.finishReason ??= event.reason
          break
        case 'usage':
          this.usage = event.usage
          break
        case 'done':
          this.mark('done')
          break
        default:
          break
      }
    }
    if (textBeforeDone >= 2) {
      this.capabilities?.observe(this.route, this.model, 'textStreaming', { state: 'verified', source: 'request', detail: `${textBeforeDone} SSE text deltas` })
    }
  }

  async * consumeJson(response) {
    const raw = await response.text()
    this.mark('done')
    if ((this.model.mode === 'transcribe' || this.model.mode === 'translate') && this.purposeIsConversation()) {
      const rendered = renderAsrBody(this.asrResponseFormat ?? 'json', raw)
      this.usage = rendered.usage
      this.asrResult = rendered
      if (rendered.text.length > 0) { this.mark('firstText'); yield * this.delta('text', rendered.text) }
      this.finishReason = 'stop'
      return
    }
    let json
    try {
      json = JSON.parse(raw)
    } catch (error) {
      throw new LlmError(`dsh-dgx-audio: ${this.endpoint} returned non-JSON: ${raw.slice(0, 200)}`, 'SERVER', { cause: error })
    }
    this.requestId = json.id
    this.usage = json.usage
    if (this.model.mode === 'transcribe' && this.purposeIsConversation()) {
      const text = String(json.text ?? '')
      if (text.length > 0) yield * this.delta('text', text)
      this.finishReason = 'stop'
      return
    }
    const texts = []
    for (const choice of json.choices ?? []) {
      const msg = choice.message ?? {}
      if (typeof msg.content === 'string' && msg.content.length > 0) texts.push(msg.content)
      if (msg.audio?.data) await this.acceptAudio(Buffer.from(msg.audio.data, 'base64'), { format: msg.audio.format ?? this.model.audioFormat })
      this.finishReason ??= choice.finish_reason
    }
    const text = texts.join('\n')
    if (text.length > 0) {
      this.mark('firstText')
      yield * this.delta('text', text)
    }
  }

  purposeIsConversation() { return !this.auxiliary }

  headers() { return headers(this.route) }

  /** Progressive PCM from a byte-stream task wire (speech / audio generate). */
  async acceptPcm(pcm, format) {
    this.timeline.audioPayloads += 1
    this.mark('firstAudio')
    this.timeline.lastAudioMs = round(performance.now() - this.t0)
    this.openAudioStream()
    await this.audioStream.pushPcm(pcm, format)
  }

  pendingDurationSeconds() {
    const s = this.audioStream
    if (s?.format === undefined) return null
    return Math.round((s.totalSamples / s.format.sampleRate) * 100) / 100
  }

  async acceptAudio(bytes, hint) {
    this.timeline.audioPayloads += 1
    this.mark('firstAudio')
    this.timeline.lastAudioMs = round(performance.now() - this.t0)
    if (!this.wantAudio) {
      this.adapter.deps.log(`dgx-audio: ${this.model.id} sent audio although speech was not requested; ignored`)
      return
    }
    this.openAudioStream()
    try {
      await this.audioStream.pushPayload(bytes, hint)
    } catch (error) {
      if (error?.code === 'UNSUPPORTED_AUDIO' || error?.code === 'MALFORMED_AUDIO') {
        this.audioErrors ??= []
        this.audioErrors.push(String(error.message))
        this.adapter.deps.log(`dgx-audio: ${this.model.id} audio payload not playable: ${error.message}`)
        return
      }
      throw error
    }
  }

  * delta(kind, text) {
    let block = this.blocks.get(kind)
    if (block === undefined) {
      block = { index: this.nextIndex++, text: '' }
      this.blocks.set(kind, block)
      yield { type: 'block-start', index: block.index, blockType: kind }
    }
    block.text += text
    yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: block.index, text }
  }

  async * finish() {
    const config = this.config
    const latencySeconds = (Date.now() - this.started) / 1000
    if (this.wantAudio && this.timeline.audioPayloads === 0) {
      this.adapter.deps.log(`dgx-audio: ${this.model.id} returned no audio although modalities included audio`)
    }
    if (this.audioStream !== undefined) {
      this.audioSummary = await this.audioStream.end('completed')
    }
    const summary = this.audioSummary
    if (summary !== undefined && summary.chunks > 0) {
      this.capabilities?.observe(this.route, this.model, 'audioOutput', { state: 'verified', source: 'request', detail: `${summary.chunks} audio payload(s)` })
      if (summary.delivery === 'progressive') {
        this.capabilities?.observe(this.route, this.model, 'audioOutputStreaming', { state: 'verified', source: 'request', observedDelivery: 'progressive', detail: `${summary.chunks} payloads before completion` })
      } else {
        this.capabilities?.note(this.route, this.model, 'audioOutputStreaming', { observedDelivery: summary.delivery })
      }
    }
    const outputAudio = summary?.recording === null || summary === undefined
      ? null
      : { ...summary.recording, path: summary.recordingPath, delivery: summary.delivery, chunks: summary.chunks }
    const logRecord = {
      ...this.record,
      endpoint: this.endpoint,
      transport: this.transport,
      retriedWithoutStream: this.retriedWithoutStream === true,
      retriedWithUserPrefix: this.retriedWithUserPrefix === true,
      latencySeconds,
      timeline: this.timeline,
      ok: true,
      httpStatus: this.status,
      requestId: this.requestId ?? null,
      usage: this.usage ?? null,
      outputText: this.blocks.get('text')?.text ?? '',
      outputAudio,
      audioErrors: this.audioErrors ?? null,
      taskParams: this.taskParamsUsed ?? null,
      ...(this.videoOutput ? { outputVideo: this.videoOutput } : {}),
    }
    await this.adapter.writeLog(config, logRecord)
    this.adapter.deps.log(`dgx-audio ${this.record.provider}/${this.record.model} ${this.endpoint} ${this.transport} session=${this.record.sessionId} audio_in=${this.record.inputAudio.map(a => `${a.name}:${a.sha256.slice(0, 12)}`).join(',') || 'none'} audio_out=${outputAudio === null ? 'none' : `${outputAudio.delivery}:${outputAudio.chunks}`} ${latencySeconds.toFixed(2)}s`)

    const resultObject = this.auxiliary ? undefined : resultOf(this, logRecord)
    const worthCarrying = resultObject !== undefined && (config.annotate || logRecord.outputAudio !== null || this.asrResult?.segments !== undefined || this.wordTimestamps !== undefined || this.videoOutput !== undefined)
    const result = worthCarrying ? await this.adapter.resultCarrier(config, resultObject) : undefined
    if (!this.auxiliary && config.annotate) yield * this.delta('text', `${footer(config, logRecord)}${result ?? ''}`)
    // Without the evidence footer, emit the result carrier only when it carries something the text does not.
    else if (result !== undefined) yield * this.delta('text', `${FOOTER_MARKER}\n${result}`)
    for (const [kind, block] of [...this.blocks.entries()].sort((a, b) => a[1].index - b[1].index)) {
      yield { type: 'block-end', index: block.index, block: { type: kind, text: block.text } }
    }
    if (this.usage?.prompt_tokens !== undefined) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: this.usage.prompt_tokens,
          outputTokens: this.usage.completion_tokens ?? 0,
          ...(this.usage.total_tokens === undefined ? {} : { totalTokens: this.usage.total_tokens }),
        },
      }
    }
    yield { type: 'finish', reason: this.finishReason === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' } }
  }

  async fail(failure) {
    if (this.failed) return
    this.failed = true
    const aborted = failure.code === 'ABORTED'
    let audio = null
    if (this.audioStream !== undefined) {
      const summary = await this.audioStream.end(aborted ? 'cancelled' : 'error', { error: { code: failure.code, message: failure.message } })
      audio = { chunks: summary.chunks, delivery: summary.delivery, partialRecording: summary.recording?.recordingId ?? null }
    }
    await this.adapter.writeLog(this.config, {
      ...this.record,
      endpoint: this.endpoint ?? null,
      transport: this.transport ?? null,
      latencySeconds: (Date.now() - this.started) / 1000,
      timeline: this.timeline,
      ok: false,
      code: failure.code,
      error: String(failure.message),
      partialText: this.blocks.get('text')?.text.length ?? 0,
      audio,
    })
  }
}

function normalizeError(error, { options, timeout, route, config }) {
  if (options.signal?.aborted) {
    return error?.code === 'ABORTED' ? error : new LlmError('dsh-dgx-audio: request aborted', 'ABORTED', { cause: error })
  }
  if (timeout.aborted) {
    return new LlmError(`dsh-dgx-audio: ${route.baseURL} did not answer within ${config.requestTimeoutMs} ms`, 'DGX_TIMEOUT', { cause: error })
  }
  if (error instanceof LlmError || (typeof error?.code === 'string' && error?.failure !== undefined)) return error
  return new LlmError(`dsh-dgx-audio: cannot reach ${route.baseURL}: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
}

function headers(route) {
  const key = routeApiKey(route)
  return { ...attributionHeaders(), ...(key ? { authorization: `Bearer ${key}` } : {}) }
}

function textOf(content) {
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}

function blockPlaceholder(block) {
  if (block.type === 'tool-result') return `[tool result] ${textOf(block.content)}`
  if (block.type === 'image') return '[image omitted: DGX audio routes accept text and audio only]'
  return `[${block.type} block omitted]`
}

function mergeTextParts(parts) {
  const out = []
  for (const part of parts) {
    const prev = out.at(-1)
    if (part.type === 'text' && prev?.type === 'text') prev.text += `\n${part.text}`
    else out.push({ ...part })
  }
  return out.filter(p => p.type !== 'text' || p.text.length > 0)
}

function round(ms) { return Math.round(ms * 10) / 10 }

const TRANSPORT_LABEL = { sse: 'streamed', json: 'complete response', 'raw-audio': 'streamed audio bytes', binary: 'complete response', job: 'async job (polled)', local: 'local (no server call)' }

function footer(config, record) {
  const lines = [`${FOOTER_MARKER} — \`${record.upstreamModel}\` via \`${record.endpoint}\` · ${TRANSPORT_LABEL[record.transport] ?? record.transport} · ${record.latencySeconds.toFixed(2)} s`]
  if (record.taskParams) {
    const used = Object.entries(record.taskParams).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    if (used.length > 0) lines.push(`- task parameters: ${used.join(' · ')}`)
  }
  for (const a of record.inputAudio) {
    lines.push(`- audio in: \`${a.name}\` ${a.durationSeconds === null ? '' : `${a.durationSeconds} s · `}${a.bytes} bytes · sha256 \`${a.sha256.slice(0, 16)}…\``)
  }
  if (record.inputAudio.length === 0) lines.push('- audio in: none (text only)')
  const video = record.outputVideo
  if (video) {
    const a = video.audioTrack
    lines.push(`- video out (final-only): ${video.width ?? '?'}×${video.height ?? '?'} · ${video.durationSeconds ?? '?'} s · ${video.bytes} bytes · sha256 \`${video.sha256.slice(0, 16)}…\` · ${a.present ? `sound track ${a.codec ?? '?'} ${a.sampleRate ?? '?'} Hz ${a.channels ?? '?'} ch` : 'no sound track'}`)
    lines.push(`- [▶ DGX video${a.present ? ' with sound' : ''} · ${video.durationSeconds ?? '?'} s](${video.url})`)
  }
  const out = record.outputAudio
  if (out) {
    const label = out.delivery === 'progressive' ? 'streamed audio reply' : 'audio reply'
    lines.push(`- audio out (${out.delivery}, ${out.chunks} payload${out.chunks === 1 ? '' : 's'}): ${out.sampleRate} Hz · ${out.durationSeconds} s · ${out.bytes} bytes · sha256 \`${out.sha256.slice(0, 16)}…\``)
    if (config.outputLink === 'api') {
      lines.push(`- [▶ DGX ${label} · ${out.sampleRate} Hz · ${out.durationSeconds} s](${out.url})`)
    } else if (config.outputLink === 'web') {
      lines.push(`- [▶ Play / download generated WAV](${config.webBaseUrl.replace(/\/+$/, '')}/api/file?path=${encodeURIComponent(out.path)})`)
      lines.push(`- saved: \`${out.path}\``)
    } else {
      lines.push(`- saved: \`${out.path}\``)
      // Image syntax over the absolute local path: the Harness Desktop local build (UI patch 0002) renders it as an
      // <audio controls> player on its same-origin dsh-app:// file API; the unpatched Web UI shows the alt text.
      lines.push('', `![DGX generated speech · ${out.sampleRate} Hz · ${out.durationSeconds} s](<${out.path}>)`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Parse the logged inline options block of the newest user message (TASK_CONTRACT §F carrier).
 * @returns {{ params: Record<string, unknown>, referenceAudio?: string }}
 */
function inlineOptions(options, model) {
  // Every user message of the pending turn (a "[model changed: …]" notice may follow the prompt).
  let found
  for (const [, message] of pendingUserMessages(options.messages)) {
    for (const block of message.content ?? []) {
      if (block.type !== 'text' || !block.text.includes('```dsh-audio-options')) continue
      const extracted = extractOptionsBlock(block.text)
      if (extracted.error) throw new LlmError(`dsh-dgx-audio: ${extracted.error}`, 'INVALID_REQUEST')
      found = { ...found, ...extracted.options }
    }
  }
  if (found === undefined) return { params: {}, attachments: {} }
  const { v, model: target, referenceAudio, referenceAudio2, emotionAudio, imageReference, audioReference, referenceText, ...rest } = found
  if (v !== undefined && v !== 1) throw new LlmError(`dsh-dgx-audio: dsh-audio-options v${v} is not supported`, 'INVALID_REQUEST')
  if (target !== undefined && target !== model.id) throw new LlmError(`dsh-dgx-audio: dsh-audio-options names model ${target} but the request uses ${model.id}`, 'INVALID_REQUEST')
  let params
  try {
    params = validateTaskParams(model, rest)
  } catch (error) {
    throw new LlmError(`dsh-dgx-audio: ${error.message}`, 'INVALID_REQUEST')
  }
  if (typeof referenceText === 'string') params.refText = referenceText
  const attachments = {}
  const nameOk = n => typeof n === 'string' && n.length > 0 && n.length <= 255
  if (referenceAudio !== undefined) {
    // A list selects several clips (Ming-omni-tts podcast mode takes ref_audio as a list).
    if (!(nameOk(referenceAudio) || (Array.isArray(referenceAudio) && referenceAudio.length > 0 && referenceAudio.length <= 8 && referenceAudio.every(nameOk)))) {
      throw new LlmError('dsh-dgx-audio: dsh-audio-options referenceAudio must be an attachment name or a list of names', 'INVALID_REQUEST')
    }
    attachments.referenceAudio = referenceAudio
  }
  for (const [key, value, mode] of [['referenceAudio2', referenceAudio2, 'speech'], ['emotionAudio', emotionAudio, 'speech'], ['imageReference', imageReference, 'generate-video'], ['audioReference', audioReference, 'generate-video']]) {
    if (value === undefined) continue
    if (model.mode !== mode) throw new LlmError(`dsh-dgx-audio: dsh-audio-options ${key} is only for ${mode} models`, 'INVALID_REQUEST')
    if (!nameOk(value)) throw new LlmError(`dsh-dgx-audio: dsh-audio-options ${key} must be an attachment name`, 'INVALID_REQUEST')
    attachments[key] = value
  }
  return { params, attachments }
}

/** vLLM mistral tokenizer mode (< v13): "Found system messages at indexes [0] and audio chunks … prior to the tokenizer version 13". */
const SYSTEM_WITH_AUDIO_REJECTED = /system messages?[\s\S]{0,120}audio[\s\S]{0,160}tokenizer version/i

/**
 * Checkpoints verified to reject a system message together with audio. Only live-verified entries belong here;
 * other models are covered by the one-shot retry on the server's own error, whose outcome is remembered per deployment.
 */
const SYSTEM_WITH_AUDIO_RULES = Object.freeze([
  { id: 'voxtral-mini-3b-2507', test: /(^|\/)Voxtral-Mini-3B-2507$/i, evidence: 'I3-VOX 2026-09-15 c3: HTTP 400 on vLLM 0.29.0 (Mistral tokenizer < v13)' },
])

/**
 * Where the system prompt goes when a request carries audio.
 * Explicit `system` / `user-prefix` always wins; `auto` (default) uses remembered server rejection, then the verified rules.
 * @returns {{ placement: 'system' | 'user-prefix', reason: string }}
 */
export function systemPlacementPlan(model, evidence) {
  const setting = model.systemPromptWithAudio ?? 'auto'
  if (setting === 'system' || setting === 'user-prefix') return { placement: setting, reason: 'config' }
  if (evidence?.rejected === true) return { placement: 'user-prefix', reason: 'observed:server-rejected-system-with-audio' }
  const rule = SYSTEM_WITH_AUDIO_RULES.find(r => r.test.test(model.upstreamModel ?? model.id))
  if (rule !== undefined) return { placement: 'user-prefix', reason: `model-rule:${rule.id}` }
  return { placement: 'system', reason: 'auto:default' }
}

/** Fold the system prompt into the first user message (returns a new converted object; audio parts untouched). */
/** Sampling-related fields of one chat request body, verbatim (§K.14). Other extraBody values are named and hashed only. */
function samplingRecord(body, extraBody) {
  const keys = Object.keys(extraBody ?? {}).sort()
  return {
    temperature: body.temperature ?? null,
    max_tokens: body.max_tokens ?? null,
    sampling_params_list: body.sampling_params_list ?? null,
    extraBodyKeys: keys,
    extraBodySha256: keys.length === 0 ? null : createHash('sha256').update(canonicalJson(extraBody)).digest('hex'),
  }
}

/** JSON with object keys sorted at every level (stable hash input). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function foldSystemIntoUser(converted, reason) {
  if (!converted.system) return converted
  let folded = false
  const messages = converted.messages.map((m) => {
    if (folded || m.role !== 'user' || !Array.isArray(m.content)) return m
    folded = true
    const content = m.content.map(p => ({ ...p }))
    const textPart = content.find(p => p.type === 'text')
    if (textPart !== undefined) textPart.text = `${converted.system}\n\n${textPart.text}`
    else content.push({ type: 'text', text: converted.system })
    return { ...m, content }
  })
  return { ...converted, system: '', systemPlacement: 'user-prefix', systemPlacementReason: reason, messages }
}

/** Machine-readable result for the shared UI (TASK_UI_CONTRACT_PROPOSAL §E), carried in the stripped footer region. */
function resultOf(call, record) {
  const model = call.model
  const out = record.outputAudio
  const asr = call.asrResult
  if (model.mode === 'chat' && out === null && asr === undefined) return undefined
  if (call.videoOutput !== undefined) {
    const { url: _url, ...video } = call.videoOutput
    return {
      v: 1, task: uiTaskOf(model), adapterTask: taskOf(model), catalogTasks: catalogTasksOf(model), catalogTasksSource: catalogTasksSourceOf(model),
      provider: record.provider, model: model.id, upstreamModel: record.upstreamModel, ...(model.deploymentId ? { deploymentId: model.deploymentId } : {}),
      outputs: [video], ...(call.videoServer ? { server: call.videoServer } : {}),
      ...(record.taskParams ? { params: Object.fromEntries(Object.entries(record.taskParams).filter(([, v]) => v !== null && v !== undefined)) } : {}),
    }
  }
  const result = {
    v: 1,
    task: uiTaskOf(model),
    adapterTask: taskOf(model),
    catalogTasks: catalogTasksOf(model),
    catalogTasksSource: catalogTasksSourceOf(model),
    provider: record.provider,
    model: model.id,
    upstreamModel: record.upstreamModel,
    ...(model.deploymentId ? { deploymentId: model.deploymentId } : {}),
    ...(asr?.language ? { language: asr.language } : {}),
    ...(asr?.segments ? { segments: asr.segments } : {}),
    ...(call.wordTimestamps !== undefined ? { wordTimestamps: call.wordTimestamps } : {}),
    outputs: out === null ? [] : [{
      kind: 'audio',
      role: model.mode === 'generate-audio' ? (model.generate?.kind === 'sound' ? 'sound' : 'music') : 'speech',
      recordingId: out.recordingId, sampleRate: out.sampleRate, channels: out.channels, durationSeconds: out.durationSeconds, sha256: out.sha256, delivery: out.delivery,
    }],
    ...(record.taskParams ? { params: Object.fromEntries(Object.entries(record.taskParams).filter(([, v]) => v !== null && v !== undefined)) } : {}),
  }
  return result
}

/** Legacy fenced carrier (config resultCarrier: "fence", or when the result store cannot write). */
function resultFence(result) {
  return `\n\`\`\`dsh-audio-result\n${JSON.stringify(result)}\n\`\`\`\n`
}
