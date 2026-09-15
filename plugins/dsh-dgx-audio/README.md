# dsh-dgx-audio

A DeepSeek Harness 0.1.5-rc.1 plugin that connects Harness to OpenAI-compatible **vLLM / vLLM-Omni** audio servers:

- **Complete-clip audio questions.** An attached WAV/MP3/… file is sent as `input_audio` (chat) or to `/audio/transcriptions`.
- **Incremental text.** Replies stream over SSE when the server supports it, with automatic fallback for servers that don't.
- **Spoken replies.** Audio is delivered progressively when the server sends it progressively. It is always saved as one coherent WAV, with a portable player link.
- **Host-mediated live / duplex sessions.** For vLLM-Omni `/v1/realtime?duplex=1` models such as MiniCPM-o 4.5.

The shared UI integration contract is `parallel-work/streaming/CONTRACT.md`, in the DSH workspace that produced this package.

The package has no dependencies. It imports no `@deepseek-ai/*` package at runtime, so it installs offline and loads as a Desktop plugin package, a Web profile bundle, or a path row.

## Nothing is preconfigured

A fresh install registers **no provider** and contacts **no server**. There is no default endpoint, IP address, home directory or credential.

Configure servers in either of two places:
- **Harness user settings**, namespace `dsh-dgx-audio`. This is portable, and the settings UI can edit it. It stores only an environment-variable *reference* for API keys (`apiKeyEnv`); keyless servers leave it empty.
- **The row config** of id `dgx-audio` in a profile patch.

Output files go to `$DSH_HOME/dsh-dgx-audio/outputs` (default `~/.dsh/dsh-dgx-audio/outputs`). Paths may contain spaces and non-ASCII characters.

```yaml
# example (settings section `dsh-dgx-audio` or row config) — replace host/port with your server
routes:
  - provider: lab-omni
    displayName: Lab vLLM-Omni
    baseURL: http://SERVER:PORT/v1
    models:
      - id: omni-speech
        upstreamModel: Qwen/Qwen2.5-Omni-7B
        outputAudio: true
        sendModalities: true      # vLLM-Omni requires `modalities` when streaming
      - id: duplex
        upstreamModel: openbmb/MiniCPM-o-4_5
        mode: realtime
        realtime:
          query: { minicpmo45_native_duplex: "1" }
          refAudioFile: /absolute/path/voice-prompt.wav   # MiniCPM-o needs a voice prompt for speech
```

## Per-model fields

| Field | Default | Meaning |
|---|---|---|
| `mode` | `chat` | `chat` = `/chat/completions` + `input_audio`. `transcribe` = `/audio/transcriptions`. `realtime` = live WebSocket session; not in the model picker, used via Live mode. |
| `upstreamModel` | `id` | The model name the server expects. |
| `outputAudio`, `sendModalities` | `false` | Request speech / send the vLLM-Omni `modalities` field. |
| `audioFormat` | server default (`wav`) | Chat reply audio format. Only `wav` and `pcm16` can be played progressively. |
| `streaming.text` | `auto` | `auto` uses SSE, retries once without streaming if the server refuses, and remembers the refusal. `sse` always streams. `off` never streams, for non-streaming APIs. |
| `capabilities` | `{}` | **Declared** capabilities, e.g. `{ fullDuplex: true }`. Declarations never count as verified. |
| `extraBody` | – | Extra JSON fields, e.g. `chat_template_kwargs`. |
| `systemPromptWithAudio` | `auto` | Where the system prompt goes when the request carries audio. `system` and `user-prefix` are explicit and always win. `auto` folds into the first user turn when this host already saw the server reject a system message with audio for this deployment, or when the upstream model matches a live-verified rule (currently only `mistralai/Voxtral-Mini-3B-2507`, I3-VOX). Otherwise it sends a system message and retries **once**, folded, if the server answers with the Mistral tokenizer rejection (`… not allowed prior to the tokenizer version 13`); that rejection is remembered. The invocation log records `systemPlacement` and `systemPlacementReason`. |
| `wire` | – | Catalog `adapter_models[].wire`. It must match `mode`, and for `mode: realtime` it selects `realtime.wire`. Wires this build does not implement are refused. |
| `speech.*` per-turn fields | – | Through `session-params` or an inline options block: `voice`, `instructions`, `language`, `taskType`, `responseFormat`, `maxNewTokens`, `refText`, `speed` (0.25–4), `seed`, `sampleRate`, `wordTimestamps` (non-streaming; words from `X-Word-Timestamps`), `xVectorOnlyMode`, `nonStreamingMode`, `initialCodecChunkFrames`, `ambientSound`, `durationSeconds`, `extraParams`. Inline attachment names: `referenceAudio` (a name or a list), `referenceAudio2` (→ `ref_audio_2`), `emotionAudio` (→ `extra_params.emo_audio`). Which model honors which field is catalog `request_options` data. |
| `systemPrompt`, `language`, `contextWindow`, `maxTokens`, `temperature`, `maxAudioPerRequest` | | As in 0.2. |
| `realtime.{path,query,session,inputSampleRate,outputSampleRate,refAudioFile,sessionIdPrefix,connectTimeoutMs}` | `/realtime`, `duplex=1&autostart=0`, pcm16 16 kHz in / 24 kHz out | Realtime session settings. On the duplex wire, `session.extra_body` defaults to `auto_response: true`. With a native flag in `query` (`native_duplex=1` or `minicpmo45_native_duplex=1`), the same key plus `force_listen_count: 0` are added. Keys you set explicitly win. |

Top-level fields:
- `outputLink`: `api` (portable `/api/dsh-dgx-audio/v1/recording?id=` link), `web`, or `path`
- `requestTimeoutMs`, `maxAudioBytes`, `annotate`, `httpRoutes`
- `live.{maxSessions,idleTimeoutMs,maxFrameBytes,maxQueuedBytes,maxSeconds}`
- `sseLimits`, `hubLimits`

## Capability truthfulness

Every model reports `textStreaming`, `audioOutput`, `audioOutputStreaming`, `liveInput`, `fullDuplex`, `bargeIn`, `playbackAck` and `sessionResume`. Each has one of five states:
- `unsupported`
- `untested`
- `declared`: set by config. A `mode: realtime` entry declares `liveInput` (and `fullDuplex` / `audioOutput` where its wire has them) with source `config:mode`.
- `advertised`: announced by a server handshake
- `verified`: this host observed the feature working on the wire

Evidence is stored per `baseURL` + model and reset when either changes. One audio payload arriving at the end of a response is reported as `final-only`, never as streaming speech. This is how Qwen2.5-Omni behaves on vLLM-Omni without `async_chunk`.

## Host routes (when the Connection service exists)

All routes live under `/api/dsh-dgx-audio/v1/`:
- `capabilities` (GET)
- `capabilities/probe` (POST, explicit user action only)
- `events?sessionId=&after=` (GET, NDJSON audio/live event feed; rendering-only)
- `recording?id=` (GET/HEAD, WAV with Range)
- `live/open`, `live/append?liveId=&seq=`, `live/control?liveId=`, `live/close?liveId=` (all POST)

## Behavior kept from 0.2

- Audio attachments are re-read through `ctx.attachments.readFileStream`, which verifies sha256 and length. Forged handles are rejected.
- Only the newest `maxAudioPerRequest` audio items are re-sent.
- ~~The Voxtral system prompt is folded into the user turn.~~ Until 0.4.1 this only happened with an explicit `systemPromptWithAudio: user-prefix`; the claim was wrong (I3-VOX c3). From 0.4.2, see `systemPromptWithAudio: auto`.
- Task requests (transcribe, translate, speech, generate, live replay, inline options) read the **pending user turn**: every user message after the last assistant message, minus Harness context notices. The notices include `[model changed: …]`, which dsh-agent appends after the prompt on the first request after a model switch. Chat requests still forward the notice to the model, as Harness intends.
- Tools are rejected (`UNSUPPORTED_OPTION`).
- Session-title and compaction calls never send audio.
- Every call is appended to the JSONL invocation log. Records include input/output hashes, transport (`sse`/`json`), and a timeline: request sent, response headers, first text, first audio, done, and delta/payload counts.

## Changes

- **0.4.10** (packaged-Desktop MiniCPM Live 11:57 findings; mock-tested against vLLM-Omni 58adeec event shapes): every per-connection `fullDuplex` observation (`live.capability`, `live/close` `observations[]`) carries the server-reported `implementationLevel`, so a later per-response `verified` event no longer reads as "not reported" in a UI that keeps the newest event per key. `playback.acknowledged` is parsed in the realtime-wrapped shape (`{event: {item_id: "item_<response_id>", played_ms, committed_ms, truncate, playback, history_committed}}`) as well as flat: `playback-ack` controls resolve `acknowledged` (were `unconfirmed` after 3 s), and `live.playback.ack` carries responseId/itemId/playedMs/committedMs/playback ledger. `playback-ack` accepts optional `truncate: true` (the server's "what was actually heard" ack after the user stops playback). One `playbackAck` verified observation per connection instead of one per ack. Interrupt semantics unchanged (§K.10). Contract: `parallel-work/streaming/TASK_CONTRACT.md` §K.16.
- **0.4.9** (streamed speech evidence; mock-tested): every chat invocation in `invocations.jsonl` carries `stream`: host epoch-ms `requestSentAt` / `responseHeadersAt` / `terminalAt`; `text.arrivals` and `text.delivery` (`progressive` only for ≥ 2 model deltas ≥ 250 ms apart; one final chunk is `single`, bunched deltas `burst`; the capability `textStreaming` is verified only for `progressive`); `audio.arrivals[]` per decoded WAV/PCM chunk (seq, host arrival time, startSample, samples, rate, peak, clipped, boundaryJump) and `audio.quality`. New evidence-only route `POST /api/dsh-dgx-audio/v1/audio/playback` stores a UI playback report (output-clock `scheduled` / `position` / `stopped` / `ended` events) as `record: "playback"` beside the host facts of that stream; it changes no request or playback. Verdict: `parallel-work/streaming/focused-demo/audio-stream-verdict.mjs`. Contract: `parallel-work/streaming/TASK_CONTRACT.md` §K.15.
- **0.4.8** (focused two-model demo; mock-tested): Harness context notices (`[model changed: …]`, a user-role message dsh-agent appends after the prompt on the first request after a model switch) are no longer sent as a user turn in chat requests. In template-driven audio models (MiMo-Audio spoken dialogue) that turn landed between the recorded audio and the assistant generation prompt. Auxiliary calls (title/compaction) are unchanged. `invocations.jsonl` `request` adds `droppedContextNotices` and `sampling {temperature, max_tokens, sampling_params_list, extraBodyKeys, extraBodySha256}` (the fields actually sent), so a run can be checked against the server recipe. No route, control, setting or live-path change. Contract: `parallel-work/streaming/TASK_CONTRACT.md` §K.14.
- **0.4.7** (verifiable resume + fail-fast records; mock-tested): a test-only `testFaults.transportDrop` (settings.yaml / row config only; absent by default, not in the Settings form, no new route or control; shown in `GET capabilities` when set) closes ONE live session's backend socket without `session.close`, `after-ready` or `after-first-audio`, so the normal resume path runs. `resume: invalid-token` / `delay` exercise rejection and expiry. Feed `live.test.fault`; close `faultInjections[]` and `resumeAttempts[]`. The idle timer pauses during a reconnect. Fail-fast refusals before any upstream request (`MODEL_NOT_READY`, Live-only, `PROVIDER_BUSY`, `BUFFER_FULL`) are written to `invocations.jsonl` as `record: "refusal"` (`invocation: false`, `zeroUpstream: true`, origin, provenance); normal lines carry `record: "invocation"`. Live replay records/results cite the live model's `catalogTasks` / `deploymentId` (`liveOrigin`). Contract: `parallel-work/streaming/TASK_CONTRACT.md` §K.12.
- **0.4.6** (catalog option statuses; config + capability document only, no wire change): model entries accept `requestOptionsMap` / `requestOptionsScope` / `requestOptionsEvidence` verbatim within the bounds of library 0.1.3 (400 entries / 2000-char text / 16 KiB evidence; a malformed field is dropped whole and named in `optionControls.inputErrors`) and `GET capabilities` publishes them with `optionControls` (`dsh-audio/option-controls@1`: per UI key obligation, `active`, `mandatory`, conditions, WS/HTTP differences, `hostOptions`, `notSendable`, `blockers`) and `io.obligations`. A listed string is never support: `io` clip slots and word timestamps now come only from active obligations; `requestOptions` strings alone give `none`. The send path is unchanged. Contract: `parallel-work/streaming/TASK_CONTRACT.md` §K.11 + `OPTION_CONTROLS_CONTRACT.json`.
- **0.4.5** (per-connection live evidence + control ACK; release I4; mock-tested): controls reply `{controlId, sent, targetResponseId, outcome}`. A barge-in with no active response sends nothing (clean no-op, avoiding server `stale_fence` and cleared input). Tail-race outcomes and server-rejected appends are attributed (`live.control.result`, `live.input.rejected`, close `controls[]` / `inputIntegrity`). Plus: capability entries gain `scope` + `observedBy`; `live.capability` / `live.playback.ack` feed events; `live.input.accepted.overlapResponseIds`; `live/close` `observations[]`. The capability document is deployment history, never current-connection proof.
- **0.4.4** (mock-tested): audio+video `generate-video` (vLLM-Omni `/v1/videos`, wire `omni-videos`).
  - Sync (`/v1/videos/sync`) and async jobs (poll, `video.progress`, Stop → `DELETE`).
  - Image/audio references by attachment name; `params_required` enforced.
  - MP4 track facts incl. audio-track sample sha256; `video/mp4` from the recording route.
  - Accepts the catalog `adapter_models` video object (`sync` / `endpoint` paths, `generateSound: "unknown"`).
- **0.4.3** (mock-tested; see TASK_CONTRACT §K):
  - Streamed TTS: the text receipt is staged on close, and replay from it makes no model call (also on the Live-only model).
  - Speech stream-input `session.config` params per session and per utterance, incl. `refText` / `xVectorOnlyMode` (catalog R6); `live.words` word timestamps.
  - Footer result link + durable `GET|HEAD result?id=` (`resultCarrier`, fence fallback).
  - `voices: string[]`; `session-params` `UNKNOWN_PARAM` / `INVALID_PARAM` with `error.key`.
  - `requestOptions` passthrough and clip-slot io facts.
  - `align` mode: Qwen3-ForcedAligner on vLLM `/pooling`, wire `vllm-pooling-forced-align`.
  - Audio+video (`generate-video`, wire `omni-videos`) is **not** in 0.4.3. It continues as the next milestone (branch copy `parallel-work/streaming/branches/av-generate-video-dev/`).
- **0.4.2:** fixes for I3-VOX and the mic lane's model-switch note, plus per-turn fields for endpoints that already exist (mock-tested; 0.4.1 left frozen).
  - `systemPromptWithAudio: auto` (new default): verified model rule, remembered server rejection, and one folded retry on the exact tokenizer error. Explicit settings always win; there is no global change.
  - Pending-turn parsing that ignores `[model changed: …]` notices. In 0.4.1 transcribe/translate failed with `NO_AUDIO_INPUT`, and speech read the notice aloud or lost its options.
  - Catalog `wire` alias with validation.
  - `/v1/audio/speech` per-turn fields (see the table), `ref_audio` lists, `ref_audio_2`, emotion clip, and word timestamps in the result block. Parameter descriptors gain `min`/`max`/`step` and `source: "voices"`.
  - Speech stream-input: per-chunk `sample_rate` wins over the nominal 24 kHz in `audio.start`; binary frames use an explicit `realtime.outputSampleRate`.
- **0.4.1:** fixes for the I2-A real-app defects (release lane `OWNER_HANDOFF_I2A.md` #1–#4; mock-tested, 0.4.0 left frozen).
  - Duplex `session.update.extra_body` now carries the native flag, `auto_response` and `force_listen_count` derived from the query flag. Without them vLLM-Omni runs its generic serving adapter and never answers (I2-A 6-4).
  - `live.warning NATIVE_DUPLEX_NOT_ENABLED` when the server reports another `implementation_level`. The ready event carries `implementationLevel`, `autoResponse` and `warnings`.
  - End input sends `response.create` when the duplex session neither auto-responds nor uses server VAD.
  - The live close result and `live.state closed` carry `receipt {state: staged|skipped|unavailable|failed, reason}` (for example `no-response`) instead of a silent missing receipt.
  - A configured realtime model is `declared` for Live by its mode (never verified without evidence).
  - A Live-only model used as the conversation model gets an error naming the chat models on the same server. Session titles for it stay local.
  - `live/open` returns 409 `PROVIDER_BUSY` (with `details.items`) while this host streams another reply from the same server (override `allowConcurrent: true`). Server `config_timeout` maps to 503 `BACKEND_BUSY`.
  - Test proving Stop closes the upstream request promptly before headers and mid-stream.
- **0.4.0:** all audio task wires of the pinned runtimes (TASK_CONTRACT v0.2, mock-tested; live acceptance per model pending).
  - HTTP modes: `speech` (`/v1/audio/speech`, SSE / raw / complete; reference clip, `ref_text`, voice, instructions, `taskType`), `translate` (`/v1/audio/translations`), and `generate-audio` (`/v1/audio/generate`). Transcription response formats: `verbose_json`, `diarized_json`, `srt`, `vtt`, `text`.
  - Realtime wires: `vllm-asr` (vLLM realtime transcription), `omni-turn` (Qwen3-Omni turn-based realtime), `omni-speech-ws` (streaming text-input TTS), and `omni-duplex` with `pcm_f32le`/`frameMs` profiles.
  - `dshAudio` in-process service: route sources, activation gating, `busy`/`drain`, capability reset, `subscribe`.
  - HTTP routes: `session-params`, `voices`, `live/text`, `activity`.
  - Task mapping fields in the capability document: `uiTask`, `catalogTasks`, `io`, `params[]`, `adapterModes`. Inline `dsh-audio-options` and `dsh-audio-result` blocks.
  - `deploymentId` in the evidence key.
  - Resume URL `resume=1&session_id=<server id>`; `server_vad` defaults to `barge_in_on_speech`.
  - Byte-stream PCM framer (header-only WAV chunks, odd-byte carry).

- **0.3.1:** resume on live sessions after an unexpected socket loss.
  - Resume uses the server-issued id, integer incarnation, bounded retries on `session_resume_conflict`/`runtime_resume_failed`, and a clean close on `session.resync_required`.
  - `live.state reconnecting`.
  - `append`/`control` return a retryable 503 `RECONNECTING` instead of a generic error while re-attaching.
  - Session control events are never de-duplicated.
- **0.3.0:** capability-aware streaming adapter, audio event feed, recording route, realtime duplex, portable config (frozen integration baseline 660be2aa…).

## Test

```bash
npm test
```

The tests are offline and use scripted HTTP/SSE and WebSocket servers. They need `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/schemastery` from `devDependencies` or an enclosing Harness workspace. **Mock success is not evidence of any live server.**
