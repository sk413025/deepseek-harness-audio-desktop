/**
 * Microphone capture backend. A capture owns exactly one MediaStream and one
 * AudioContext from `open()` until `stop()` or `abort()`; both paths stop
 * every track and close the context. Frames are mono Float32 at the context
 * rate, tapped through an AudioWorklet or, when a page policy refuses the
 * worklet module, a ScriptProcessorNode.
 */

/** One selectable audio input. */
export interface AudioInputDevice {
  /** Browser device id; `''` addresses the system default input. */
  readonly id: string
  /** Device label, empty until the page holds microphone permission. */
  readonly label: string
}

/** Samples captured by one finished session. */
export interface CapturedAudio {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/** Stable failure categories surfaced to the user interface. */
export type CaptureFailure =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-device'
  | 'device-busy'
  | 'capture-failed'

/** Error carrying a {@link CaptureFailure} category. */
export class CaptureError extends Error {
  /** Failure category. */
  readonly failure: CaptureFailure

  /**
   * @param failure - failure category.
   * @param message - underlying browser message.
   */
  constructor(failure: CaptureFailure, message: string) {
    super(message)
    this.name = 'CaptureError'
    this.failure = failure
  }
}

/** Options for opening one capture. */
export interface CaptureOpenOptions {
  /** Device to open; `''` uses the system default. */
  readonly deviceId: string
  /** Called for each captured mono chunk; the chunk is owned by the callee. */
  readonly onFrames: (chunk: Float32Array) => void
  /** Called once if the device ends the capture (unplugged, revoked). */
  readonly onEnded: () => void
  /** Capture context rate; omitted uses the device/context default (the browser resamples when set). */
  readonly sampleRate?: number
}

/** A running capture. */
export interface CaptureSession {
  /** Context sample rate of delivered frames. */
  readonly sampleRate: number
  /** Label of the opened track (may be empty). */
  readonly deviceLabel: string
  /** Device id reported by the opened track settings, when available. */
  readonly deviceId: string
  /** Release the stream and context. Idempotent. */
  close(): Promise<void>
}

/** Media access used by the controller; the browser implementation is {@link browserCaptureBackend}. */
export interface CaptureBackend {
  /**
   * Classify whether capture can be attempted on this page.
   * @returns undefined when supported, else the blocking failure.
   */
  support(): CaptureFailure | undefined
  /**
   * List audio inputs.
   * @returns inputs in browser order; empty when enumeration is unavailable.
   */
  listDevices(): Promise<readonly AudioInputDevice[]>
  /**
   * Observe input device changes.
   * @param listener - called after a change.
   * @returns unsubscriber.
   */
  onDeviceChange(listener: () => void): () => void
  /**
   * Request the microphone and start tapping frames.
   * @param options - device and frame sinks.
   * @returns the running capture.
   * @throws {CaptureError} on permission, device, or platform failures.
   */
  open(options: CaptureOpenOptions): Promise<CaptureSession>
  /**
   * Ask for microphone access without capturing (the granted tracks stop at once), so a permission prompt is answered
   * before a server session with an idle timeout is opened.
   * @throws {CaptureError} on permission, device, or platform failures.
   */
  prepare?(): Promise<void>
}

const WORKLET_NAME = 'dsh-voice-capture-tap'

/** Worklet source: downmix every render quantum to mono and post it to the page. */
const WORKLET_SOURCE = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0 && input[0].length > 0) {
      const frames = input[0].length
      const mono = new Float32Array(frames)
      for (let c = 0; c < input.length; c++) {
        const channel = input[c]
        for (let i = 0; i < frames; i++) mono[i] += channel[i]
      }
      if (input.length > 1) for (let i = 0; i < frames; i++) mono[i] /= input.length
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, Tap)
`

/**
 * Map a getUserMedia rejection to a failure category.
 * @param error - rejection value.
 * @returns the categorized error.
 */
export function classifyMediaError(error: unknown): CaptureError {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name: unknown }).name)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new CaptureError('permission-denied', message)
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return new CaptureError('no-device', message)
    case 'NotReadableError':
    case 'AbortError':
    case 'TrackStartError':
      return new CaptureError('device-busy', message)
    case 'TypeError':
    case 'NotSupportedError':
      return new CaptureError('unsupported', message)
    default:
      return new CaptureError('capture-failed', message)
  }
}

/**
 * Browser capture backend over `navigator.mediaDevices` and Web Audio.
 * @returns the backend bound to the current page globals.
 */
export function browserCaptureBackend(): CaptureBackend {
  return {
    support() {
      if (typeof window === 'undefined') return 'unsupported'
      if (window.isSecureContext === false) return 'insecure-context'
      if (navigator.mediaDevices?.getUserMedia === undefined) return 'unsupported'
      if (typeof AudioContext !== 'function') return 'unsupported'
      return undefined
    },
    async listDevices() {
      if (navigator.mediaDevices?.enumerateDevices === undefined) return []
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices
        .filter(device => device.kind === 'audioinput')
        .map(device => ({ id: device.deviceId === 'default' ? '' : device.deviceId, label: device.label }))
        .filter((device, index, all) => all.findIndex(other => other.id === device.id) === index)
    },
    onDeviceChange(listener) {
      const media = navigator.mediaDevices
      if (media?.addEventListener === undefined) return () => {}
      media.addEventListener('devicechange', listener)
      return () => { media.removeEventListener('devicechange', listener) }
    },
    async prepare() {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } catch (error) {
        throw classifyMediaError(error)
      }
      for (const track of stream.getTracks()) track.stop()
    },
    async open({ deviceId, onFrames, onEnded, sampleRate }) {
      // Create the context inside the user's click, before the permission prompt can outlast the
      // gesture: engines that gate audio start on user activation then still let it run.
      let context: AudioContext
      try {
        context = sampleRate === undefined ? new AudioContext() : new AudioContext({ sampleRate })
      } catch (error) {
        throw new CaptureError('unsupported', String(error))
      }
      const resumed = context.resume().catch(() => { /* reported below through context.state */ })
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId === '' ? true : { deviceId: { exact: deviceId } },
          video: false,
        })
      } catch (error) {
        await context.close().catch(() => { /* already closed: nothing left to release */ })
        throw classifyMediaError(error)
      }
      const tracks = stream.getAudioTracks()
      try {
        if (tracks.length === 0) throw new CaptureError('no-device', 'the granted stream has no audio track')
        await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, RESUME_TIMEOUT_MS))])
        if (context.state !== 'running') throw new CaptureError('capture-failed', `audio engine did not start (state ${context.state})`)
        return await tapStream(stream, context, tracks[0]!, onFrames, onEnded)
      } catch (error) {
        for (const track of stream.getTracks()) track.stop()
        await context.close().catch(() => { /* already closed: nothing left to release */ })
        throw error instanceof CaptureError ? error : new CaptureError('capture-failed', String(error))
      }
    },
  }
}

/** How long a suspended capture context may take to start before the recording is refused. */
const RESUME_TIMEOUT_MS = 3000

async function tapStream(
  stream: MediaStream,
  context: AudioContext,
  track: MediaStreamTrack,
  onFrames: (chunk: Float32Array) => void,
  onEnded: () => void,
): Promise<CaptureSession> {
  const source = context.createMediaStreamSource(stream)
  const sink = context.createGain()
  sink.gain.value = 0
  sink.connect(context.destination)
  let tap: AudioNode
  let closed = false
  const worklet = await openWorklet(context)
  if (worklet !== undefined) {
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => { if (!closed) onFrames(event.data) }
    tap = worklet
  } else {
    // ScriptProcessorNode is deprecated but remains the only tap when the
    // page's policy refuses a Blob-URL worklet module.
    const processor = context.createScriptProcessor(4096, Math.max(1, Math.min(2, source.channelCount)), 1)
    processor.onaudioprocess = (event) => {
      if (closed) return
      const input = event.inputBuffer
      const mono = new Float32Array(input.length)
      for (let c = 0; c < input.numberOfChannels; c++) {
        const channel = input.getChannelData(c)
        for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]!
      }
      if (input.numberOfChannels > 1) for (let i = 0; i < mono.length; i++) mono[i]! /= input.numberOfChannels
      onFrames(mono)
    }
    tap = processor
  }
  source.connect(tap)
  tap.connect(sink)
  const ended = () => { if (!closed) onEnded() }
  track.addEventListener('ended', ended)
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  return {
    sampleRate: context.sampleRate,
    deviceLabel: track.label,
    deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : '',
    async close() {
      if (closed) return
      closed = true
      track.removeEventListener('ended', ended)
      for (const t of stream.getTracks()) t.stop()
      source.disconnect()
      tap.disconnect()
      sink.disconnect()
      await context.close().catch(() => { /* already closed: nothing left to release */ })
    },
  }
}

async function openWorklet(context: AudioContext): Promise<AudioWorkletNode | undefined> {
  if (context.audioWorklet === undefined || typeof AudioWorkletNode !== 'function') return undefined
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(url)
    return new AudioWorkletNode(context, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
  } catch {
    // A Content-Security-Policy without blob: worker/script sources refuses the module; the caller falls back.
    return undefined
  } finally {
    URL.revokeObjectURL(url)
  }
}
