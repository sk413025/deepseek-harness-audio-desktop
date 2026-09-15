/**
 * Browser half of dsh-voice-capture: the shared audio UI for Web and Desktop.
 * - Record-and-send (CONTRACT §1): composer microphone toggle and recording
 *   panel; the WAV clip is uploaded through `ctx.fileUpload` and admitted with
 *   the Session's public prompt verbs.
 * - Reply audio (§3, §4): progressive playback of the audio event feed and
 *   inline players for recording links in completed Turns.
 * - Live mode (§2, §5): offered only for models whose `liveInput` capability
 *   is declared, advertised or verified, labelled with that evidence layer.
 * - Task controls (TASK_CONTRACT 0.2): parameters, reference voice, text-input
 *   generation, and the activation gate shared with the model library.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { browserCaptureBackend } from './capture.ts'
import { DEFAULT_SPEC, VoiceCaptureController } from './controller.ts'
import { NS, en, zh } from './locale.ts'
import { MicButton } from './MicButton.tsx'
import { VoiceDock } from './VoiceDock.tsx'
import type { AudioInjected, GateState, RecoveryInjected, TaskInjected, VideoProgress, VoiceInjected } from './slots.ts'
import { ActivationBoard, gateBlocks, gateKey } from './audio/gate.ts'
import type { AudioModelLibraryFace } from './audio/gate.ts'
import { TaskInputsController } from './audio/task-controller.ts'
import { taskView } from './audio/tasks.ts'
import { TaskStrip } from './audio/TaskStrip.tsx'
import type { FetchLike } from './audio/api.ts'
import { CapabilityDirectory } from './audio/capabilities.ts'
import type { AudioFeatures } from './audio/capabilities.ts'
import { subscribeAudioEvents } from './audio/events.ts'
import { LiveController, liveInputName } from './audio/live.ts'
import { applyOfflineJobEvent, applyOfflineStreamEnd } from './audio/offline-jobs.ts'
import { OfflineRecoveryController } from './audio/offline-recover.ts'
import { RecoveryCard } from './audio/RecoveryCard.tsx'
import type { OfflineJobState } from './audio/offline-jobs.ts'
import type { LogLiveExchange } from './audio/live.ts'
import { ProgressivePlayer, webAudioOutput } from './audio/player.ts'
import type { PlaybackEvent } from './audio/player.ts'
import { selectReplyRecordings, voiceAudioDefinition } from './audio/recordings.ts'
import { ROUTE_PREFIX, requestJson, routeUrl } from './audio/api.ts'
import { resolveOptions, voiceNames } from './audio/tasks.ts'
import { parseResultDocument } from './audio/results.ts'
import type { AudioResult } from './audio/results.ts'
import { AudioReplies } from './audio/AudioReplies.tsx'
import { LiveButton } from './audio/LiveButton.tsx'
import { LiveDock } from './audio/LiveDock.tsx'
import { ReplyBar } from './audio/ReplyBar.tsx'
import { PlaybackTimelineStore, summarizeTimeline } from './audio/playback-timeline.ts'
import { PlaybackReporter } from './audio/playback-report.ts'

/** Services this plugin waits for. */
export const inject = ['slots', 'locale', 'fileUpload', 'sessions', 'uiConversation']

/** Plugin version named in playback reports (keep equal to package.json). */
const PLUGIN_VERSION = '0.3.5'

/** Longest reference voice recording. */
const REFERENCE_MAX_MS = 30_000

/** Interval of playback acknowledgements sent from the real player position during Live mode. */
const PLAYBACK_ACK_MS = 500

/**
 * Register dictionaries, controllers and every slot entry.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'voice-capture: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(voiceAudioDefinition), 'voice-capture: reply recordings definition')

  const fetchImpl: FetchLike = (input, init) => fetch(input, init)
  const backend = browserCaptureBackend()
  const uploadPort = { upload: (sessionId: SessionId, data: Blob, name: string, signal: AbortSignal, onProgress: (p: { loaded: number; total?: number }) => void) => ctx.fileUpload.upload(sessionId, data, name, signal, onProgress) }
  const sessionPort = { binding: (id: SessionId) => ctx.sessions.binding(id) }
  let live: LiveController | undefined
  let referenceRecorder: VoiceCaptureController | undefined
  const controller = new VoiceCaptureController(
    backend, uploadPort, sessionPort, DEFAULT_SPEC, undefined, undefined,
    () => live?.active === true || referenceRecorder?.capturing === true,
  )
  referenceRecorder = new VoiceCaptureController(
    backend, uploadPort, sessionPort, { ...DEFAULT_SPEC, maxDurationMs: REFERENCE_MAX_MS }, undefined, undefined,
    () => live?.active === true || controller.capturing,
  )
  const taskInputs = new TaskInputsController(uploadPort, sessionPort, (input, init) => fetch(input, init))
  const logExchange: LogLiveExchange = async (sessionId, input) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined || typeof input.receiptId !== 'string') return { ok: false, detail: 'session-unavailable' }
    const attachments = typeof input.attachmentId === 'string'
      ? [{ type: 'file' as const, value: { attachmentId: input.attachmentId, name: liveInputName(input), bytes: input.bytes } as unknown as FileAttachmentRef }]
      : []
    const submission = binding.session.beginSubmission({ mode: 'queue', text: '', attachments })
    const result = await binding.session.prompt([{ type: 'file', receiptId: input.receiptId as never }], 'queue', undefined, submission.requestId)
    return result.ok ? { ok: true } : { ok: false, detail: `${result.error.code}: ${result.error.message}` }
  }
  live = new LiveController(backend, fetchImpl, () => controller.capturing || referenceRecorder?.capturing === true, logExchange)
  const capabilities = new CapabilityDirectory(fetchImpl)
  const board = new ActivationBoard(() => (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get('audioModelLibrary') as AudioModelLibraryFace | undefined)
  ctx.effect(() => ctx.on('internal/service', (name: string) => { if (name === 'audioModelLibrary') board.libraryChanged() }), 'voice-capture: follow the model library service')
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  /** Refresh capabilities after an activation change; events older than the new document are dropped. */
  const reloadAfterModelState = (): void => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      const since = Date.now()
      void capabilities.load(true).then(() => { board.documentLoaded(since) })
    }, 500)
  }

  const players = new Map<SessionId, ProgressivePlayer>()
  const videoJobs = new Map<SessionId, { value: VideoProgress | undefined; listeners: Set<() => void> }>()
  const videoProgressFor = (sessionId: SessionId) => {
    let entry = videoJobs.get(sessionId)
    if (entry === undefined) {
      entry = { value: undefined, listeners: new Set() }
      videoJobs.set(sessionId, entry)
    }
    const current = entry
    return {
      getSnapshot: () => current.value,
      subscribe: (listener: () => void) => { current.listeners.add(listener); return () => { current.listeners.delete(listener) } },
      set: (value: VideoProgress) => { current.value = value; for (const listener of [...current.listeners]) listener() },
    }
  }
  const offlineJobs = new Map<SessionId, { value: Readonly<Record<string, OfflineJobState>>; listeners: Set<() => void> }>()
  const offlineStreams = new Map<string, { provider: string | undefined; model: string | undefined }>()
  const offlineJobsFor = (sessionId: SessionId) => {
    let entry = offlineJobs.get(sessionId)
    if (entry === undefined) {
      entry = { value: {}, listeners: new Set() }
      offlineJobs.set(sessionId, entry)
    }
    const current = entry
    return {
      getSnapshot: () => current.value,
      subscribe: (listener: () => void) => { current.listeners.add(listener); return () => { current.listeners.delete(listener) } },
      apply: (event: Readonly<Record<string, unknown>>) => {
        const next = applyOfflineJobEvent(current.value, event)
        if (next === current.value) return
        current.value = next
        for (const listener of [...current.listeners]) listener()
      },
      endStream: (provider: string | undefined, model: string | undefined, status: unknown) => {
        const next = applyOfflineStreamEnd(current.value, provider, model, status)
        if (next === current.value) return
        current.value = next
        for (const listener of [...current.listeners]) listener()
      },
    }
  }
  const recoveries = new Map<SessionId, OfflineRecoveryController>()
  /** Offline job recovery per Session: listing on demand, explicit Recover only (R-MIC recover contract). */
  const recoveryFor = (sessionId: SessionId): OfflineRecoveryController => {
    let controller = recoveries.get(sessionId)
    if (controller === undefined) {
      controller = new OfflineRecoveryController(sessionId, fetchImpl)
      recoveries.set(sessionId, controller)
    }
    return controller
  }
  const features = new Map<SessionId, { getSnapshot(): AudioFeatures; subscribe(listener: () => void): () => void }>()
  const feeds = new Map<SessionId, { refs: number; dispose: () => void }>()
  /** Finished actual-playback timelines (this browser), for reply cards and evidence readers. */
  const playbackTimelines = new PlaybackTimelineStore()
  const reporters = new Map<SessionId, PlaybackReporter>()
  // Read-only evidence surface for acceptance tooling (CDP): finished timelines plus the streams in progress.
  ;(globalThis as { __dshVoiceCapture?: unknown }).__dshVoiceCapture = {
    version: 'dsh-voice-capture-playback@1',
    playbackTimelines: (sessionId?: string) => ({
      finished: playbackTimelines.list(sessionId).map(entry => ({ sessionId: entry.sessionId, summary: summarizeTimeline(entry.timeline), timeline: entry.timeline })),
      inProgress: [...players.entries()]
        .filter(([id]) => sessionId === undefined || id === sessionId)
        .map(([id, player]) => ({ sessionId: id, timeline: player.currentTimeline() }))
        .filter(entry => entry.timeline !== undefined && entry.timeline.finalizedAt === undefined)
        .map(entry => ({ ...entry, summary: summarizeTimeline(entry.timeline!) })),
      reports: [...reporters.entries()].filter(([id]) => sessionId === undefined || id === sessionId).map(([id, reporter]) => ({ sessionId: id, streams: reporter.state() })),
    }),
  }
  const playerFor = (sessionId: SessionId): ProgressivePlayer => {
    let player = players.get(sessionId)
    if (player === undefined) {
      const reporter = new PlaybackReporter(fetchImpl, sessionId, () => ({ plugin: `dsh-voice-capture@${PLUGIN_VERSION}`, ...players.get(sessionId)!.outputFacts() }))
      reporters.set(sessionId, reporter)
      player = new ProgressivePlayer(webAudioOutput, undefined, {
        onTimeline: timeline => { playbackTimelines.add(sessionId, timeline) },
        // §K.15 playback reports (host ≥ 0.4.9); older hosts answer 404 once per stream and nothing is retried.
        onReport: (streamId, event) => { reporter.event(streamId, event) },
        onReportEnd: (streamId) => { void reporter.close(streamId) },
        // Turn replies only (R-MIC-PLAYBACK: live optional); the Live duplex path stays as in 0.3.4.
        reportOrigins: new Set(['chat']),
      })
      players.set(sessionId, player)
    }
    return player
  }
  const featuresFor = (sessionId: SessionId) => {
    let source = features.get(sessionId)
    if (source === undefined) {
      const selection = ctx.sessions.binding(sessionId)?.session.projections.faceOf('modelSelection')
        ?? { getSnapshot: () => undefined, subscribe: () => () => {} }
      source = capabilities.featuresFor(selection)
      features.set(sessionId, source)
    }
    return source
  }
  const gates = new Map<SessionId, { getSnapshot(): GateState; subscribe(listener: () => void): () => void }>()
  /** Activation gate of the selected model: library service and adapter activation combined. */
  const gateFor = (sessionId: SessionId) => {
    let source = gates.get(sessionId)
    if (source !== undefined) return source
    const features = featuresFor(sessionId)
    let cached: { key: string; value: GateState } | undefined
    source = {
      getSnapshot: () => {
        const current = features.getSnapshot()
        const next: GateState = current.selection === undefined
          ? { state: 'unknown' }
          : current.liveOnly
            ? { state: 'live-only', source: 'adapter' }
            : board.gate(current.selection.provider, current.selection.model, current.model)
        const key = gateKey(next)
        if (cached?.key !== key) cached = { key, value: next }
        return cached.value
      },
      subscribe: (listener) => {
        const stopFeatures = features.subscribe(listener)
        const stopBoard = board.subscribe(listener)
        return () => {
          stopFeatures()
          stopBoard()
        }
      },
    }
    gates.set(sessionId, source)
    return source
  }
  const liveGates = new Map<SessionId, { getSnapshot(): Readonly<Record<string, GateState>>; subscribe(listener: () => void): () => void }>()
  /** Activation gates of every live candidate, keyed by model id. */
  const liveGatesFor = (sessionId: SessionId) => {
    let source = liveGates.get(sessionId)
    if (source !== undefined) return source
    const features = featuresFor(sessionId)
    let cached: { key: string; value: Readonly<Record<string, GateState>> } | undefined
    source = {
      getSnapshot: () => {
        const next = Object.fromEntries(features.getSnapshot().liveCandidates.map(c => [c.model.model, board.gate(c.model.provider, c.model.model, c.entry)]))
        const key = JSON.stringify(next)
        if (cached?.key !== key) cached = { key, value: next }
        return cached.value
      },
      subscribe: (listener) => {
        const stopFeatures = features.subscribe(listener)
        const stopBoard = board.subscribe(listener)
        return () => {
          stopFeatures()
          stopBoard()
        }
      },
    }
    liveGates.set(sessionId, source)
    return source
  }
  /**
   * Work on the same adapter provider that would make a live open time out (I2-A case 6-3): an unfinished
   * reply or another live session. Hosts without `GET activity` (before 0.4.0) report nothing.
   */
  const serverBusy = async (provider: string, sessionId: SessionId): Promise<string | undefined> => {
    try {
      const activity = await requestJson<{ live?: { sessionId?: string; model?: string; state?: string }[]; inflight?: { sessionId?: string; model?: string; kind?: string }[] }>(
        fetchImpl, `${ROUTE_PREFIX}/activity?provider=${encodeURIComponent(provider)}`,
      )
      const work = activity.inflight?.find(item => item.kind !== 'auxiliary')
      if (work !== undefined) return `${work.kind ?? 'request'} · ${work.model ?? ''}${work.sessionId === sessionId ? '' : ' (another conversation)'}`.trim()
      const other = activity.live?.find(item => item.state !== 'closed')
      if (other !== undefined) return `live · ${other.model ?? ''}${other.sessionId === sessionId ? '' : ' (another conversation)'}`.trim()
      return undefined
    } catch {
      return undefined
    }
  }
  /** Reason a request to the selected model must not be sent now (checked again right before admission). */
  const blockedReason = (sessionId: SessionId): string | undefined => {
    const gate = gateFor(sessionId).getSnapshot()
    return gateBlocks(gate) ? gate.state : undefined
  }
  const extrasFor = (sessionId: SessionId) => {
    const blocked = () => blockedReason(sessionId)
    const model = featuresFor(sessionId).getSnapshot().model
    return model === undefined ? { blocked } : { ...taskInputs.extras(sessionId, model.id, taskView(model)), blocked }
  }
  /** Session-params target: the selected model, or a live candidate of its route. */
  const paramsTarget = (sessionId: SessionId, modelId?: string) => {
    const current = featuresFor(sessionId).getSnapshot()
    if (current.model === undefined || current.selection === undefined) return undefined
    if (modelId === undefined || modelId === current.model.id) return { provider: current.selection.provider, model: current.model.id, view: taskView(current.model) }
    const candidate = current.liveCandidates.find(c => c.model.model === modelId)
    return candidate === undefined ? undefined : { provider: candidate.model.provider, model: candidate.model.model, view: taskView(candidate.entry) }
  }
  const releaseFeed = (sessionId: SessionId): void => {
    const feed = feeds.get(sessionId)
    if (feed === undefined) return
    feed.refs--
    if (feed.refs > 0 || live?.owner === sessionId) return
    feed.dispose()
    feeds.delete(sessionId)
  }
  const attachFeed = (sessionId: SessionId): (() => void) => {
    const existing = feeds.get(sessionId)
    if (existing !== undefined) {
      existing.refs++
    } else {
      const player = playerFor(sessionId)
      const dispose = subscribeAudioEvents(fetchImpl, sessionId, {
        onEvent: (event) => {
          if (event.type.startsWith('audio.')) player.handle(event as unknown as PlaybackEvent)
          if (event.type.startsWith('live.') || event.type === 'text.delta') live?.handleEvent(event)
          if (event.type === 'model.state' && board.handleModelState(event)) reloadAfterModelState()
          if (event.type === 'offline.job') offlineJobsFor(sessionId).apply(event)
          // The audio stream of an offline job tells when a Stop, failure or deadline ended it (no job event for that).
          if (event.type === 'audio.start' && event.task === 'tts.offline-job' && event.origin !== 'recover' && typeof event.streamId === 'string') {
            offlineStreams.set(event.streamId, { provider: typeof event.provider === 'string' ? event.provider : undefined, model: typeof event.model === 'string' ? event.model : undefined })
          }
          if (event.type === 'audio.end' && typeof event.streamId === 'string' && offlineStreams.has(event.streamId)) {
            const stream = offlineStreams.get(event.streamId)!
            offlineStreams.delete(event.streamId)
            offlineJobsFor(sessionId).endStream(stream.provider, stream.model, event.status)
          }
          if (event.type === 'offline.job.recovery') recoveryFor(sessionId).handleEvent(event)
          if (event.type === 'video.progress' && typeof event.jobId === 'string') {
            videoProgressFor(sessionId).set({
              model: typeof event.model === 'string' ? event.model : undefined,
              jobId: event.jobId,
              status: String(event.status ?? ''),
              progress: typeof event.progress === 'number' ? event.progress : undefined,
            })
          }
        },
        onState: () => {},
      })
      feeds.set(sessionId, { refs: 1, dispose })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      releaseFeed(sessionId)
    }
  }

  ctx.effect(() => {
    let lastAck = -1
    const timer = setInterval(() => {
      const owner = live?.owner
      if (owner === undefined) return
      const position = players.get(owner)?.playedPosition()
      if (position === undefined || position.origin !== 'live' || position.playedMs === lastAck) return
      lastAck = position.playedMs
      void live?.playbackAck(position.streamId, position.playedMs)
    }, PLAYBACK_ACK_MS)
    const onPageHide = () => {
      void referenceRecorder?.dispose()
      taskInputs.dispose()
      void controller.dispose()
      void live?.dispose()
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      clearInterval(timer)
      clearTimeout(reloadTimer)
      window.removeEventListener('pagehide', onPageHide)
      void referenceRecorder?.dispose()
      taskInputs.dispose()
      void controller.dispose()
      void live?.dispose()
      for (const feed of feeds.values()) feed.dispose()
      feeds.clear()
      for (const player of players.values()) void player.dispose()
      players.clear()
    }
  }, 'voice-capture: release microphone, live session, feeds and playback on unload')

  const voiceFace = (sessionId: SessionId): VoiceInjected => ({
    start: () => { void controller.start(sessionId) },
    stop: () => { void controller.stop(sessionId) },
    cancel: () => { void controller.cancel(sessionId) },
    send: text => controller.send(sessionId, text, extrasFor(sessionId)),
    selectDevice: (deviceId) => { controller.selectDevice(deviceId) },
    dismissError: () => { controller.dismissError(sessionId) },
    detach: () => { void controller.detach(sessionId) },
    refreshDevices: () => { void controller.refreshDevices() },
    openLibrary: () => board.openLibrary(sessionId),
    hooks: { voice: controller.source(sessionId), gate: gateFor(sessionId) },
  })
  const recoveryFace = (sessionId: SessionId): RecoveryInjected => ({
    load: () => { void recoveryFor(sessionId).load() },
    recover: (key) => { void recoveryFor(sessionId).recover(key) },
    insert: (key, setDraft) => recoveryFor(sessionId).insert(key, setDraft),
    hooks: { recovery: recoveryFor(sessionId).source },
  })
  const audioFace = (sessionId: SessionId): AudioInjected => ({
    attachFeed: () => attachFeed(sessionId),
    stopPlayback: () => {
      const player = playerFor(sessionId)
      const before = player.source.getSnapshot()
      player.stop()
      // A turn reply still generating (no audio.end yet) is also stopped like the conversation Stop, so the host aborts the
      // upstream request (R-MIC-PLAYBACK stop semantics). Live replies keep their own controls.
      if (before.origin === 'chat' && before.status === undefined && (before.phase === 'receiving' || before.phase === 'playing')) {
        void ctx.sessions.binding(sessionId)?.session.cancel().catch(() => {
          // A refused cancel is shown by the conversation (promptError); local playback is already silent.
        })
      }
    },
    setAutoplay: (enabled) => { playerFor(sessionId).setAutoplay(enabled) },
    startLive: (modelId) => {
      const current = featuresFor(sessionId).getSnapshot()
      const candidate = modelId === undefined ? current.liveCandidates.find(c => c.available) : current.liveCandidates.find(c => c.model.model === modelId)
      if (candidate === undefined || !candidate.available) return
      if (ctx.sessions.binding(sessionId)?.session.getSnapshot().running === true) return
      // Never open a live session on a model that is cold, loading, switching or busy.
      if (gateBlocks(board.gate(candidate.model.provider, candidate.model.model, candidate.entry))) return
      const release = attachFeed(sessionId)
      void (async () => {
        // Parameters set for this live model travel as session params (the live wire has no prompt to carry a block).
        const view = taskView(candidate.entry)
        if (!(await taskInputs.applyParams(sessionId, { provider: candidate.model.provider, model: candidate.model.model, view }))) return
        await live?.start(sessionId, candidate.model, candidate.evidence, false, candidate.kind, () => serverBusy(candidate.model.provider, sessionId))
      })().finally(release)
    },
    endLiveInput: () => { void live?.endInput() },
    sendLiveText: (text, done, endSession) => {
      // Live options set for the open streamed-TTS model travel as per-utterance params (§K.2).
      const liveModel = live?.source.getSnapshot().model
      const candidate = liveModel === undefined ? undefined : featuresFor(sessionId).getSnapshot().liveCandidates.find(c => c.model.model === liveModel.model)
      const params = candidate === undefined ? undefined : resolveOptions(taskView(candidate.entry).params, taskInputs.source(sessionId).getSnapshot().values[candidate.model.model] ?? {}, false)
      return live?.sendText(text, done, params, endSession ?? done) ?? Promise.resolve(false)
    },
    closeLive: () => { void live?.close().finally(() => { void capabilities.load(true) }) },
    liveControl: (type) => { void live?.control(type) },
    dismissLive: () => { live?.dismiss() },
    openLibrary: () => board.openLibrary(sessionId),
    hooks: { playback: playerFor(sessionId).source, features: featuresFor(sessionId), live: live!.source, gate: gateFor(sessionId), liveGates: liveGatesFor(sessionId) },
  })
  const taskFace = (sessionId: SessionId): TaskInjected => ({
    setValue: (key, value, model) => {
      const target = paramsTarget(sessionId, model)
      if (target !== undefined) taskInputs.setValue(sessionId, target.model, key, value, target)
    },
    pickReference: (file, slot) => { taskInputs.setReference(sessionId, file, 'file', file.name, slot) },
    clearReference: (slot) => { taskInputs.clearReference(sessionId, slot) },
    setConsent: (consent, slot) => { taskInputs.setConsent(sessionId, consent, slot) },
    setReferenceText: (text) => { taskInputs.setReferenceText(sessionId, text) },
    startReference: () => { void referenceRecorder!.start(sessionId) },
    stopReference: () => { void referenceRecorder!.stop(sessionId) },
    keepReference: () => {
      const clip = referenceRecorder!.takeClip(sessionId)
      if (clip !== undefined) taskInputs.setReference(sessionId, new Blob([clip.data as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'recorded', clip.name)
    },
    discardRecordedReference: () => { void referenceRecorder!.cancel(sessionId) },
    generate: (text) => {
      const model = featuresFor(sessionId).getSnapshot().model
      return model === undefined ? Promise.resolve(false) : taskInputs.generate(sessionId, model.id, taskView(model), text, () => blockedReason(sessionId))
    },
    loadValues: (url) => loadValues(url),
    openLibrary: () => board.openLibrary(sessionId),
    cancelGenerate: () => { taskInputs.cancel(sessionId) },
    dismissTaskError: () => { taskInputs.dismissError(sessionId) },
    hooks: { features: featuresFor(sessionId), taskInputs: taskInputs.source(sessionId), referenceVoice: referenceRecorder!.source(sessionId), gate: gateFor(sessionId), videoProgress: videoProgressFor(sessionId), offlineJobs: offlineJobsFor(sessionId) },
  })

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'dsh-voice-capture-mic', order: 10, locale: NS, inject: voiceFace,
  }, MicButton))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'dsh-voice-capture-live', order: 11, locale: NS, inject: audioFace,
  }, LiveButton))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-voice-capture-task', order: 84, locale: NS, inject: taskFace,
  }, TaskStrip))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-voice-capture-live-panel', order: 86, locale: NS, inject: audioFace,
  }, LiveDock))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-voice-capture-recovery', order: 87, locale: NS, inject: recoveryFace,
  }, RecoveryCard))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-voice-capture-reply-bar', order: 88, locale: NS, inject: audioFace,
  }, ReplyBar))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-voice-capture-panel', order: 90, locale: NS, inject: voiceFace,
  }, VoiceDock))
  const valuesCache = new Map<string, Promise<readonly string[]>>()
  /** Server value list for a `valuesFrom` parameter (voices); failures are not cached. */
  const loadValues = (url: string): Promise<readonly string[]> => {
    let pending = valuesCache.get(url)
    if (pending === undefined) {
      pending = requestJson<unknown>(fetchImpl, url).then(voiceNames)
      pending.catch(() => { valuesCache.delete(url) })
      valuesCache.set(url, pending)
    }
    return pending
  }
  const resultCache = new Map<string, Promise<AudioResult | undefined>>()
  const loadResult = (resultId: string, seq: number): Promise<AudioResult | undefined> => {
    const key = `${seq}:${resultId}`
    let pending = resultCache.get(key)
    if (pending === undefined) {
      pending = fetchImpl(routeUrl(`${ROUTE_PREFIX}/result?id=${encodeURIComponent(resultId)}`), { credentials: 'include' })
        .then(async response => (response.ok ? parseResultDocument(await response.json(), seq) : undefined))
        .catch(() => undefined)
      pending.then((value) => { if (value === undefined) resultCache.delete(key) }, () => { resultCache.delete(key) })
      resultCache.set(key, pending)
    }
    return pending
  }
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', select: selectReplyRecordings, priority: 1, locale: NS,
    inject: () => ({
      loadResult,
      playbackTimelineFor: (recordingId: string) => playbackTimelines.byRecording(recordingId)?.summary,
      hooks: { playbackTimelines: playbackTimelines.source },
    }),
  }, AudioReplies))
}
