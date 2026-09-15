// Audio+video generation over vLLM-Omni /v1/videos (wire `omni-videos`, mode `generate-video`; ADAPTER_GAPS §1).
// Form fields per vLLM-Omni `_parse_video_form` (eb11446b api_server.py; aff7d649; 5f25d986 video/generation/helpers.py):
// multipart `prompt`, `seconds`, `size`, `width`, `height`, `num_frames`, `fps`, `negative_prompt`, `num_inference_steps`,
// `guidance_scale`, `guidance_scale_2`, `flow_shift`, `true_cfg_scale`, `seed`, `generate_sound`, `sound_duration`,
// `aspect_ratio`, `quality`, `extra_params` (JSON), and JSON-string references `image_reference={"image_url":…}`,
// `audio_reference={"audio_url":…}`. `/v1/videos/sync` blocks and returns `video/mp4`; `/v1/videos` returns a job
// ({id,status,progress}) polled at `GET /v1/videos/{id}`, content at `/content`, cancelled by `DELETE`.
// No audio+video model streams progressively: delivery is always final-only.

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from './compat.js'
import { loadAttachmentBytes, mimeOf } from './audio.js'
import { inspectMp4 } from './mp4.js'
import { encodeRecordingId, safeSegment } from './recording.js'
import { pendingUserAudio, pendingUserText } from './tasks.js'

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }

/** UI param key → form field (numbers/booleans become strings; objects become JSON). */
export const VIDEO_FORM_FIELDS = Object.freeze({
  seconds: 'seconds', size: 'size', width: 'width', height: 'height', numFrames: 'num_frames', fps: 'fps', aspectRatio: 'aspect_ratio',
  quality: 'quality', negativePrompt: 'negative_prompt', numInferenceSteps: 'num_inference_steps', guidanceScale: 'guidance_scale',
  guidanceScale2: 'guidance_scale_2', flowShift: 'flow_shift', trueCfgScale: 'true_cfg_scale', seed: 'seed', generateSound: 'generate_sound',
  soundDuration: 'sound_duration', extraParams: 'extra_params',
})

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

/** @param {import('./adapter.js').CallStateLike} call */
export async function * generateVideoRequest(call, converted, signal) {
  const { route, model, upstreamModel, options } = call
  const params = { ...model.video, ...call.taskParams }
  const prompt = pendingUserText(options)
  if (prompt.length === 0) throw new LlmError(`dsh-dgx-audio: ${model.id} needs a text prompt`, 'INVALID_REQUEST')
  const names = call.attachmentNames ?? {}
  for (const key of model.paramsRequired ?? []) {
    if ((key === 'audioReference' || key === 'imageReference') && names[key] === undefined) throw new LlmError(`dsh-dgx-audio: ${model.id} needs ${key === 'audioReference' ? 'an audio' : 'an image'} reference: attach it and name it in dsh-audio-options "${key}"`, 'INVALID_REQUEST')
  }
  const audioRef = names.audioReference !== undefined ? pendingUserAudio(converted, names.audioReference) : undefined
  let imageRef
  if (names.imageReference !== undefined) {
    const file = (converted.pendingFiles ?? []).find(f => f.handle.name === names.imageReference)
    if (file === undefined) throw new LlmError(`dsh-dgx-audio: attachment "${names.imageReference}" is not part of this message`, 'INVALID_REQUEST')
    const ext = String(file.handle.name.split('.').at(-1)).toLowerCase()
    if (IMAGE_MIME[ext] === undefined) throw new LlmError(`dsh-dgx-audio: imageReference "${file.handle.name}" is not a png/jpg/webp/gif/bmp image`, 'INVALID_REQUEST')
    imageRef = { ...(await loadAttachmentBytes(file.handle, call.adapter.deps.attachments(), signal)), mime: IMAGE_MIME[ext] }
  }
  call.record.inputAudio = call.record.inputAudio.filter(a => a.sha256 === audioRef?.sha256)

  const form = new FormData()
  form.set('prompt', prompt)
  form.set('model', upstreamModel)
  const sent = {}
  for (const [key, field] of Object.entries(VIDEO_FORM_FIELDS)) {
    const value = params[key]
    if (value === undefined || value === null || value === 'unknown') continue
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    form.set(field, text)
    sent[field] = typeof value === 'object' ? value : value
  }
  if (imageRef !== undefined) form.set('image_reference', JSON.stringify({ image_url: `data:${imageRef.mime};base64,${imageRef.data.toString('base64')}` }))
  if (audioRef !== undefined) form.set('audio_reference', JSON.stringify({ audio_url: `data:${mimeOf(audioRef.format)};base64,${audioRef.data.toString('base64')}` }))
  const base = route.baseURL.replace(/\/+$/, '')
  const root = base.replace(/\/v1$/, '')
  // Catalog objects name paths from the server root (`/v1/videos`, `/v1/videos/sync`); booleans keep the defaults.
  const sync = model.video?.async === true ? false : params.sync !== false
  const syncUrl = typeof model.video?.sync === 'string' ? `${root}${model.video.sync}` : `${base}/videos/sync`
  const jobsUrl = typeof model.video?.endpoint === 'string' ? `${root}${model.video.endpoint}` : `${base}/videos`
  call.record.request = {
    endpoint: sync ? syncUrl : jobsUrl,
    multipart: { prompt: `${prompt.slice(0, 160)}${prompt.length > 160 ? '…' : ''}`, model: upstreamModel, ...sent, ...(imageRef ? { image_reference: { sha256: imageRef.sha256, bytes: imageRef.bytes, name: imageRef.name } } : {}), ...(audioRef ? { audio_reference: { sha256: audioRef.sha256, bytes: audioRef.bytes, name: audioRef.name } } : {}) },
  }
  call.taskParamsUsed = { ...Object.fromEntries(Object.entries(params).filter(([k, v]) => k in VIDEO_FORM_FIELDS && v !== undefined && v !== 'unknown')), sync, ...(imageRef ? { imageReference: imageRef.sha256 } : {}), ...(audioRef ? { audioReference: audioRef.sha256 } : {}) }
  const headers = call.headers()

  let bytes
  if (sync) {
    call.endpoint = syncUrl
    call.mark('requestSent')
    const response = await call.adapter.fetch(call.endpoint, { method: 'POST', body: form, headers, signal })
    call.mark('responseHeaders')
    call.status = response.status
    if (!response.ok) throw httpError(call.endpoint, response.status, await response.text().catch(() => ''))
    bytes = Buffer.from(await response.arrayBuffer())
    call.videoServer = { requestId: response.headers.get('x-request-id'), inferenceTimeS: Number(response.headers.get('x-inference-time-s')) || null }
  } else {
    call.endpoint = jobsUrl
    call.mark('requestSent')
    const created = await call.adapter.fetch(call.endpoint, { method: 'POST', body: form, headers, signal })
    call.mark('responseHeaders')
    call.status = created.status
    const job = await readJson(created, call.endpoint)
    if (typeof job.id !== 'string' || job.id === '') throw new LlmError(`dsh-dgx-audio: ${call.endpoint} returned no job id`, 'SERVER')
    const jobUrl = `${jobsUrl}/${encodeURIComponent(job.id)}`
    call.videoServer = { jobId: job.id }
    const cancel = () => { void call.adapter.fetch(jobUrl, { method: 'DELETE', headers }).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const deadline = Date.now() + (params.maxSeconds ?? 1800) * 1000
      let status = job.status
      let lastProgress = -1
      while (status !== 'completed') {
        if (status === 'failed') throw new LlmError(`dsh-dgx-audio: video job ${job.id} failed: ${JSON.stringify(job.error ?? null).slice(0, 300)}`, 'SERVER')
        if (Date.now() > deadline) { cancel(); throw new LlmError(`dsh-dgx-audio: video job ${job.id} did not finish within ${params.maxSeconds ?? 1800} s (cancelled)`, 'TIMEOUT') }
        await sleep(params.pollMs ?? 2000, signal)
        const polled = await call.adapter.fetch(jobUrl, { headers, signal })
        const state = polled.ok ? await polled.json() : await readJson(polled, jobUrl)
        status = state.status
        Object.assign(job, state)
        if (typeof state.progress === 'number' && state.progress !== lastProgress) {
          lastProgress = state.progress
          call.adapter.deps.hub?.()?.feed(call.record.sessionId ?? 'no-session').publish({ type: 'video.progress', provider: route.provider, model: model.id, jobId: job.id, status, progress: state.progress })
        }
      }
      const content = await call.adapter.fetch(`${jobUrl}/content`, { headers, signal })
      if (!content.ok) throw httpError(`${jobUrl}/content`, content.status, await content.text().catch(() => ''))
      bytes = Buffer.from(await content.arrayBuffer())
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  call.mark('firstAudio')
  call.transport = sync ? 'binary' : 'job'

  const facts = inspectMp4(bytes)
  if (!facts.ok) throw new LlmError(`dsh-dgx-audio: ${call.endpoint} did not return an MP4 (${bytes.byteLength} bytes)`, 'SERVER')
  const config = call.config
  const rel = `${safeSegment(call.record.sessionId, 'no-session')}/${new Date().toISOString().replace(/[:.]/g, '-')}-${safeSegment(model.id)}-video.mp4`
  await mkdir(join(config.outputDir, rel, '..'), { recursive: true })
  await writeFile(join(config.outputDir, rel), bytes)
  const recordingId = encodeRecordingId(rel)
  call.videoOutput = {
    kind: 'video', role: 'video', recordingId, url: `/api/dsh-dgx-audio/v1/recording?id=${recordingId}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength,
    width: facts.video?.width ?? null, height: facts.video?.height ?? null, durationSeconds: facts.video?.durationSeconds ?? null, delivery: 'final-only',
    audioTrack: facts.audioTrack,
  }
  // A sound track in the container is functional evidence of audio output for this deployment; its absence when sound
  // was requested is recorded too. Nothing here is a streaming claim.
  if (facts.audioTrack.present) call.capabilities?.observe(route, model, 'audioOutput', { state: 'verified', source: 'request', detail: `MP4 audio track ${facts.audioTrack.codec ?? '?'} ${facts.audioTrack.sampleRate ?? '?'} Hz` })
  else if (params.generateSound === true || audioRef !== undefined) call.capabilities?.note(route, model, 'audioOutput', { lastRequestWithoutAudioTrack: true })
  const a = facts.audioTrack
  const sound = a.present ? `sound track ${a.codec ?? ''} ${a.sampleRate ?? '?'} Hz · ${a.channels ?? '?'} ch` : 'no sound track'
  yield * call.delta('text', `Video generated${facts.video?.width ? ` · ${facts.video.width}×${facts.video.height}` : ''}${facts.video?.durationSeconds ? ` · ${facts.video.durationSeconds} s` : ''} · ${sound}.`)
}

async function readJson(response, url) {
  const text = await response.text().catch(() => '')
  if (!response.ok) throw httpError(url, response.status, text)
  try { return JSON.parse(text) } catch { throw new LlmError(`dsh-dgx-audio: ${url} returned non-JSON: ${text.slice(0, 200)}`, 'SERVER') }
}

function httpError(url, status, body) {
  const code = status === 429 ? 'RATE_LIMIT' : status === 504 ? 'TIMEOUT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
  return new LlmError(`dsh-dgx-audio: ${url} returned HTTP ${status}: ${String(body).slice(0, 600)}`, code, { status })
}
