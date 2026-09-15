# dsh-voice-capture

DeepSeek Harness 0.1.5-rc.1 client plugin that adds microphone input to the conversation composer. One build serves the Web client and Harness Desktop (both load the same `dsh.client` module graph).

## What the user sees

- A microphone button in the composer tool row (`conversation.input.left`). It is shown in an opened Session and disabled, with an explanation, when the page cannot use the microphone or the Session is a subagent.
- Recording starts only when the user clicks the button. A panel above the composer (`conversation.input.dock`) shows a blinking recording dot, the elapsed time against the limit, an input-level meter, the device in use, **Stop** and **Discard**.
- After **Stop** the panel shows a preview player (play/pause/seek), duration, size and format, a microphone selector, **Discard**, **Record again** and **Send recording**.
- **Send recording** uploads the clip with progress (cancellable) and sends it to the Session's selected model. If the message box holds plain text, that text is sent with the recording and cleared; if it holds reference chips, the recording is sent alone and the text stays.
- Errors are shown in the panel and keep the clip when possible: permission denied (with where to allow it), no microphone, microphone busy, insecure page, unsupported browser, too short, another Session already recording, encoding, upload, send, Session unavailable.

## What is sent

The recording is a WAV file (PCM s16le, mono, 16 kHz; band-limited resampling from the capture rate) named `recording-YYYYMMDD-HHMMSS.wav`. It is uploaded with `ctx.fileUpload.upload` and admitted with the Session's public `beginSubmission` + `prompt([{type:'file', receiptId}, {type:'text', text}], 'queue')`. This is the same path a picked audio file takes, so the host attachment store and the configured audio adapter (for example `dsh-dgx-audio`) receive the exact previewed bytes. No speech-to-text or OS dictation is involved. This implements §1 of `parallel-work/streaming/CONTRACT.md` v0.1.

## Lifecycle guarantees

- The MediaStream and AudioContext exist only between a user-initiated start and stop/discard/limit; every path stops all tracks and closes the context.
- Leaving the Session composer (navigation) stops a running recording and keeps the clip; page hide and plugin unload release captures, in-flight uploads and preview URLs.
- The recording stops automatically at the limit (120 s) and keeps the clip. Clips under 300 ms are refused.
- Only one Session can hold the microphone at a time.

## Package

- `lib/index.js`: host half; registers nothing (the Loader row lets the client-module scan serve the browser half).
- `lib/client.js`: closure-factory browser bundle; module-table requests `react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`.
- `cordis.patch.yml`: inserts row `voice-capture`.
- No `dependencies`/`peerDependencies`; no configuration keys; no hostnames, paths or credentials.
- Copy is localized (`voiceCapture` namespace, en and zh).

## Build and test (development)

```bash
node scripts/test.mjs
```

```bash
node scripts/build.mjs
```

Both use the pinned Harness source toolchain at `../../vendor/deepseek-harness-desktop-src` (override with `DSH_HARNESS_SRC`). The release build uses the official client preset through `desktop-local-build/build-client-plugin.sh`.

## Platform notes

- Browsers allow microphone capture only on secure origins (HTTPS or `localhost`/`127.0.0.1`). A Web client opened over plain HTTP from another host shows the "secure connection" error.
- Harness Desktop serves the UI from the secure `dsh-app://` scheme. macOS asks for microphone permission on first use; a signed hardened-runtime build also needs the `com.apple.security.device.audio-input` entitlement (release build concern).
