import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AudioInputDevice, CaptureBackend, CaptureOpenOptions, CaptureSession } from '../src/client/capture.ts'
import { CaptureError, classifyMediaError } from '../src/client/capture.ts'
import type { SessionPort, UploadPort, VoiceCaptureSpec } from '../src/client/controller.ts'
import { VoiceCaptureController } from '../src/client/controller.ts'
import { readWavHeader } from '../src/client/wav.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId
const SPEC: VoiceCaptureSpec = { maxDurationMs: 2000, minDurationMs: 300, targetSampleRate: 16000, meterIntervalMs: 50 }

interface FakeCapture {
  options: CaptureOpenOptions
  closed: number
  session: CaptureSession
}

class FakeBackend implements CaptureBackend {
  unsupported: ReturnType<CaptureBackend['support']> = undefined
  devices: AudioInputDevice[] = [{ id: '', label: '' }, { id: 'usb', label: 'USB Mic' }]
  opens: FakeCapture[] = []
  failWith: unknown = undefined
  gate: Promise<void> | undefined
  sampleRate = 48000
  support() { return this.unsupported }
  async listDevices() { return this.devices }
  onDeviceChange() { return () => {} }
  async open(options: CaptureOpenOptions): Promise<CaptureSession> {
    if (this.gate !== undefined) await this.gate
    if (this.failWith !== undefined) throw classifyMediaError(this.failWith)
    const capture: FakeCapture = {
      options,
      closed: 0,
      session: {
        sampleRate: this.sampleRate,
        deviceLabel: options.deviceId === 'usb' ? 'USB Mic' : 'Default',
        deviceId: options.deviceId,
        close: async () => { capture.closed++ },
      },
    }
    this.opens.push(capture)
    return capture.session
  }
  feed(seconds: number, frequency = 440): void {
    const capture = this.opens.at(-1)!
    const quantum = 128
    const total = Math.round(this.sampleRate * seconds)
    for (let offset = 0; offset < total; offset += quantum) {
      const chunk = new Float32Array(Math.min(quantum, total - offset))
      for (let i = 0; i < chunk.length; i++) chunk[i] = 0.4 * Math.sin(2 * Math.PI * frequency * (offset + i) / this.sampleRate)
      capture.options.onFrames(chunk)
    }
  }
}

interface Recorded {
  uploads: { sessionId: SessionId; bytes: Uint8Array; name: string; type: string }[]
  submissions: { text: string; attachments: unknown[] }[]
  prompts: { content: unknown[]; mode: string; requestId: unknown }[]
  abandoned: number
}

function ports(options: {
  uploadResult?: 'ok' | 'fail' | 'throw' | 'hang'
  promptResult?: 'ok' | 'fail' | 'throw'
  noBinding?: boolean
} = {}) {
  const recorded: Recorded = { uploads: [], submissions: [], prompts: [], abandoned: 0 }
  const upload: UploadPort = {
    async upload(sessionId, data, name, signal, onProgress) {
      const bytes = new Uint8Array(await data.arrayBuffer())
      recorded.uploads.push({ sessionId, bytes, name, type: data.type })
      onProgress({ loaded: Math.floor(bytes.length / 2), total: bytes.length })
      if (options.uploadResult === 'hang') {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
        })
      }
      if (options.uploadResult === 'throw') throw new Error('network down')
      if (options.uploadResult === 'fail') return { ok: false, error: { code: 'attachment/too-large', message: 'too large' } } as never
      return {
        ok: true,
        value: {
          receiptId: `receipt-${recorded.uploads.length}`,
          file: { attachmentId: `att-${createHash('sha256').update(bytes).digest('hex')}`, name, bytes: bytes.length },
        },
      } as never
    },
  }
  const sessions: SessionPort = {
    binding(id) {
      if (options.noBinding === true || id === undefined) return undefined
      return {
        session: {
          beginSubmission(input) {
            recorded.submissions.push({ text: input.text, attachments: [...input.attachments] })
            return { requestId: `req-${recorded.submissions.length}` as never, abandon: () => { recorded.abandoned++ } }
          },
          async prompt(content, mode, _signal, requestId) {
            recorded.prompts.push({ content: [...content], mode, requestId })
            if (options.promptResult === 'throw') throw new Error('socket closed')
            if (options.promptResult === 'fail') return { ok: false, error: { code: 'session/busy', message: 'busy' } } as never
            return { ok: true, value: { accepted: true } } as never
          },
        },
      }
    },
  }
  return { recorded, upload, sessions }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, map }
}

async function recordClip(controller: VoiceCaptureController, backend: FakeBackend, seconds = 1) {
  await controller.start(A)
  backend.feed(seconds)
  await controller.stop(A)
  return controller.source(A).getSnapshot()
}

test('record → stop produces a 16 kHz mono WAV preview and releases the capture', async () => {
  const backend = new FakeBackend()
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  const source = controller.source(A)
  assert.equal(source, controller.source(A))
  assert.equal(source.getSnapshot().phase, 'idle')
  const phases: string[] = []
  source.subscribe(() => { phases.push(source.getSnapshot().phase) })

  await controller.start(A)
  assert.equal(source.getSnapshot().phase, 'recording')
  assert.equal(controller.capturing, true)
  backend.feed(1.25)
  const stable = source.getSnapshot()
  assert.equal(stable, source.getSnapshot())
  await controller.stop(A)

  const snapshot = source.getSnapshot()
  assert.equal(snapshot.phase, 'preview')
  assert.equal(controller.capturing, false)
  assert.equal(backend.opens[0]!.closed, 1)
  const clip = snapshot.clip!
  assert.match(clip.name, /^recording-\d{8}-\d{6}\.wav$/)
  assert.equal(clip.mimeType, 'audio/wav')
  assert.equal(clip.sampleRate, 16000)
  assert.equal(clip.durationMs, 1250)
  assert.equal(clip.bytes, 44 + 16000 * 1.25 * 2)
  assert.match(clip.sha256 ?? '', /^[0-9a-f]{64}$/)
  assert.equal(clip.limitReached, false)
  assert.ok(clip.url.startsWith('blob:'))
  assert.ok(phases.includes('requesting') && phases.includes('recording') && phases.includes('encoding'))
  assert.ok(!('data' in clip))
})

test('cancel while recording discards frames and stops the tracks', async () => {
  const backend = new FakeBackend()
  const { upload, sessions, recorded } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await controller.start(A)
  backend.feed(0.5)
  await controller.cancel(A)
  assert.equal(controller.source(A).getSnapshot().phase, 'idle')
  assert.equal(controller.source(A).getSnapshot().clip, undefined)
  assert.equal(backend.opens[0]!.closed, 1)
  assert.equal(controller.capturing, false)
  assert.equal(recorded.uploads.length, 0)
})

test('cancel during the permission prompt closes the stream once it is granted', async () => {
  const backend = new FakeBackend()
  let release!: () => void
  backend.gate = new Promise((resolve) => { release = resolve })
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  const starting = controller.start(A)
  assert.equal(controller.source(A).getSnapshot().phase, 'requesting')
  await controller.cancel(A)
  release()
  await starting
  assert.equal(backend.opens[0]!.closed, 1)
  assert.equal(controller.source(A).getSnapshot().phase, 'idle')
  assert.equal(controller.capturing, false)
})

test('stop during the permission prompt finishes as soon as capture opens', async () => {
  const backend = new FakeBackend()
  let release!: () => void
  backend.gate = new Promise((resolve) => { release = resolve })
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  const starting = controller.start(A)
  await controller.stop(A)
  release()
  await starting
  assert.equal(backend.opens[0]!.closed, 1)
  assert.equal(controller.source(A).getSnapshot().error?.code, 'too-short')
})

test('permission, device and platform failures map to recoverable errors', async () => {
  const cases: [unknown, string][] = [
    [Object.assign(new Error('denied'), { name: 'NotAllowedError' }), 'permission-denied'],
    [Object.assign(new Error('none'), { name: 'NotFoundError' }), 'no-device'],
    [Object.assign(new Error('busy'), { name: 'NotReadableError' }), 'device-busy'],
    [Object.assign(new Error('weird'), { name: 'WeirdError' }), 'capture-failed'],
  ]
  for (const [failure, code] of cases) {
    const backend = new FakeBackend()
    backend.failWith = failure
    const { upload, sessions } = ports()
    const storage = memoryStorage()
    storage.setItem('dsh-voice-capture.deviceId', 'usb')
    const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, storage)
    await controller.start(A)
    const snapshot = controller.source(A).getSnapshot()
    assert.equal(snapshot.phase, 'error')
    assert.equal(snapshot.error?.code, code)
    assert.equal(controller.capturing, false)
    if (code === 'no-device') assert.equal(snapshot.selectedDeviceId, '')
    controller.dismissError(A)
    assert.equal(controller.source(A).getSnapshot().phase, 'idle')
  }
  const backend = new FakeBackend()
  backend.unsupported = 'insecure-context'
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  assert.equal(controller.source(A).getSnapshot().supported, false)
  await controller.start(A)
  assert.equal(controller.source(A).getSnapshot().error?.code, 'insecure-context')
  assert.equal(backend.opens.length, 0)
  assert.ok(new CaptureError('no-device', 'x') instanceof Error)
})

test('duration limit stops capture automatically and keeps the clip', async () => {
  const backend = new FakeBackend()
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await controller.start(A)
  backend.feed(3)
  await new Promise(resolve => setTimeout(resolve, 20))
  const snapshot = controller.source(A).getSnapshot()
  assert.equal(snapshot.phase, 'preview')
  assert.equal(snapshot.clip?.limitReached, true)
  assert.equal(snapshot.clip?.durationMs, SPEC.maxDurationMs)
  assert.equal(backend.opens[0]!.closed, 1)
})

test('too-short clips are refused and a second session cannot take the microphone', async () => {
  const backend = new FakeBackend()
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await controller.start(A)
  await controller.start(B)
  assert.equal(controller.source(B).getSnapshot().error?.code, 'busy-elsewhere')
  backend.feed(0.1)
  await controller.stop(A)
  assert.equal(controller.source(A).getSnapshot().error?.code, 'too-short')
  assert.equal(controller.source(A).getSnapshot().phase, 'error')
})

test('send uploads the exact preview bytes, then prompts with the file receipt and draft text', async () => {
  const backend = new FakeBackend()
  const { upload, sessions, recorded } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  const preview = await recordClip(controller, backend, 1)
  const clip = preview.clip!
  const outcome = await controller.send(A, 'What is said here?')
  assert.equal(outcome, 'sent')
  assert.equal(recorded.uploads.length, 1)
  const uploaded = recorded.uploads[0]!
  assert.equal(uploaded.sessionId, A)
  assert.equal(uploaded.name, clip.name)
  assert.equal(uploaded.type, 'audio/wav')
  assert.equal(createHash('sha256').update(uploaded.bytes).digest('hex'), clip.sha256)
  assert.deepEqual(readWavHeader(uploaded.bytes), { channels: 1, sampleRate: 16000, bitsPerSample: 16, dataBytes: 32000 })
  assert.deepEqual(recorded.submissions, [{
    text: 'What is said here?',
    attachments: [{ type: 'file', value: { attachmentId: `att-${clip.sha256}`, name: clip.name, bytes: clip.bytes } }],
  }])
  assert.deepEqual(recorded.prompts, [{
    content: [{ type: 'file', receiptId: 'receipt-1' }, { type: 'text', text: 'What is said here?' }],
    mode: 'queue',
    requestId: 'req-1',
  }])
  const after = controller.source(A).getSnapshot()
  assert.equal(after.phase, 'idle')
  assert.equal(after.clip, undefined)
  assert.equal(after.lastSent?.attachmentBytes, clip.bytes)
  assert.equal(await controller.send(A, ''), 'ignored')
})

test('audio-only send omits the text part', async () => {
  const backend = new FakeBackend()
  const { upload, sessions, recorded } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await recordClip(controller, backend, 0.5)
  assert.equal(await controller.send(A, ''), 'sent')
  assert.deepEqual(recorded.prompts[0]!.content, [{ type: 'file', receiptId: 'receipt-1' }])
})

test('upload and prompt failures keep the clip for retry', async () => {
  for (const [option, code] of [
    [{ uploadResult: 'fail' }, 'upload-failed'],
    [{ uploadResult: 'throw' }, 'upload-failed'],
    [{ promptResult: 'fail' }, 'prompt-failed'],
    [{ promptResult: 'throw' }, 'prompt-failed'],
    [{ noBinding: true }, 'session-unavailable'],
  ] as const) {
    const backend = new FakeBackend()
    const { upload, sessions, recorded } = ports(option)
    const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
    await recordClip(controller, backend, 0.5)
    assert.equal(await controller.send(A, 'x'), 'failed')
    const snapshot = controller.source(A).getSnapshot()
    assert.equal(snapshot.phase, 'preview', JSON.stringify(option))
    assert.equal(snapshot.error?.code, code)
    assert.ok(snapshot.clip !== undefined)
    if ('promptResult' in option && option.promptResult === 'throw') assert.equal(recorded.abandoned, 1)
  }
})

test('cancelling an in-flight upload returns to the preview without prompting', async () => {
  const backend = new FakeBackend()
  const { upload, sessions, recorded } = ports({ uploadResult: 'hang' })
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await recordClip(controller, backend, 0.5)
  const sending = controller.send(A, '')
  await new Promise(resolve => setTimeout(resolve, 10))
  const progress = controller.source(A).getSnapshot()
  assert.equal(progress.phase, 'sending')
  assert.equal(progress.progress?.stage, 'uploading')
  assert.ok((progress.progress?.loaded ?? 0) > 0)
  await controller.cancel(A)
  assert.equal(await sending, 'cancelled')
  const snapshot = controller.source(A).getSnapshot()
  assert.equal(snapshot.phase, 'preview')
  assert.equal(snapshot.error, undefined)
  assert.equal(recorded.prompts.length, 0)
})

test('discarding a preview releases it; detach and dispose stop live capture', async () => {
  const backend = new FakeBackend()
  const { upload, sessions } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await recordClip(controller, backend, 0.5)
  await controller.cancel(A)
  assert.equal(controller.source(A).getSnapshot().clip, undefined)
  assert.equal(controller.source(A).getSnapshot().phase, 'idle')

  await controller.start(A)
  backend.feed(0.6)
  await controller.detach(B)
  assert.equal(controller.capturing, true)
  await controller.detach(A)
  assert.equal(controller.capturing, false)
  assert.equal(backend.opens[1]!.closed, 1)
  assert.equal(controller.source(A).getSnapshot().phase, 'preview')

  await controller.start(B)
  backend.feed(0.2)
  await controller.dispose()
  assert.equal(backend.opens[2]!.closed, 1)
  assert.equal(controller.capturing, false)
  assert.equal(controller.source(A).getSnapshot().clip, undefined)
  await controller.start(A)
  assert.equal(backend.opens.length, 3)
})

test('device selection is remembered and listed', async () => {
  const backend = new FakeBackend()
  const { upload, sessions } = ports()
  const storage = memoryStorage()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, storage)
  await controller.refreshDevices()
  assert.deepEqual(controller.source(A).getSnapshot().devices.map(d => d.id), ['', 'usb'])
  controller.selectDevice('usb')
  assert.equal(storage.map.get('dsh-voice-capture.deviceId'), 'usb')
  await controller.start(A)
  assert.equal(backend.opens[0]!.options.deviceId, 'usb')
  assert.equal(controller.source(A).getSnapshot().activeDeviceLabel, 'USB Mic')
  const restored = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, storage)
  assert.equal(restored.source(A).getSnapshot().selectedDeviceId, 'usb')
  await controller.dispose()
  await restored.dispose()
})

test('recording send can carry a reference clip and an options block ahead of the text', async () => {
  const backend = new FakeBackend()
  const { upload, sessions, recorded } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await recordClip(controller, backend, 0.5)
  const reference = new File([new Uint8Array(64)], 'reference-voice-20260915-023000.wav', { type: 'audio/wav' })
  const outcome = await controller.send(A, 'Repeat in my voice', { block: '```dsh-audio-options\n{"v":1}\n```', reference: { file: reference, name: reference.name } })
  assert.equal(outcome, 'sent')
  assert.deepEqual(recorded.uploads.map(u => u.name.startsWith('reference-voice') ? 'reference' : 'clip'), ['clip', 'reference'])
  const content = recorded.prompts[0]!.content as { type: string; receiptId?: string; text?: string }[]
  assert.deepEqual(content.map(part => part.type), ['file', 'file', 'text'])
  assert.equal(content[0]!.receiptId, 'receipt-2')
  assert.equal(content[1]!.receiptId, 'receipt-1')
  assert.equal(content[2]!.text!, '```dsh-audio-options\n{"v":1}\n```\n\nRepeat in my voice')
  assert.equal((recorded.submissions[0]!.attachments as unknown[]).length, 2)
  assert.ok(controller.takeClip(A) === undefined)
})

test('send is refused while the selected model is not ready, before upload and again before admission (clip kept)', async () => {
  const backend = new FakeBackend()
  const { upload, sessions, recorded } = ports()
  const controller = new VoiceCaptureController(backend, upload, sessions, SPEC, undefined, memoryStorage())
  await recordClip(controller, backend, 0.5)
  assert.equal(await controller.send(A, 'hi', { blocked: () => 'cold' }), 'failed')
  assert.equal(recorded.uploads.length, 0)
  assert.deepEqual(controller.source(A).getSnapshot().error, { code: 'model-not-ready', detail: 'cold' })
  let checks = 0
  assert.equal(await controller.send(A, 'hi', { blocked: () => (++checks === 1 ? undefined : 'loading') }), 'failed')
  assert.equal(recorded.uploads.length, 1, 'the model started switching during upload')
  assert.equal(recorded.prompts.length, 0)
  assert.equal(controller.source(A).getSnapshot().phase, 'preview')
  assert.equal(controller.source(A).getSnapshot().error?.code, 'model-not-ready')
  assert.equal(await controller.send(A, 'hi', { blocked: () => undefined }), 'sent')
})
