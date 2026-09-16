# audio.2-pre32: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio pre32 (Local Build) 0.1.5-rc.1-audio.2-pre32, macOS arm64, ad-hoc signed, not notarized. dmg sha256 `b24f0216df0678d2…`.
- **Plugins** (frozen packages, preinstalled and enabled on first launch; also attached individually):
  - dsh-dgx-audio 0.4.12 `dadc204a…`
  - dsh-voice-capture 0.3.8 `683a4cb8…`
  - dsh-audio-model-library 0.1.6 `90f2a9dc…`: demo focus (two models); Activate switches the model on the DGX Spark
  - **dsh-audio-release-kit 0.3.7** `dac76e65…`: a Chinese language hint instead of a reply-language rule; the voice call plays the model only after you have spoken
- **Changed since audio.2-pre31:**
  - **No reply language is imposed.** audio.2-pre31's "always answer in Traditional Chinese" rule made the replies sound unnatural. The system prompts now only say 「預期使用者會使用中文交談。」 (the user is expected to speak Chinese), in the voice call's duplex instructions (after MiniCPM-o's default line "Streaming Omni Conversation."), the "DGX audio (no tools)" persona and the MiMo Audio servers preset.
  - **Kept from audio.2-pre31:** the voice call starts by listening. Replies the model starts before your first turn has ended are cancelled and not played.
- **Test labels:**
  - "injected" = the TTS clips fed into the app's microphone input (not a microphone);
  - "speakers" = TTS played through the Mac speakers into a USB microphone facing them (real microphone and echo cancellation);
  - "real" = the actual DGX model server;
  - "mock" = a local test server.

| Item | State |
|---|---|
| Bundled plugins + distribution defaults from this dmg (fresh profile, relaunch, upgrade from audio.2-pre24) | **PASS** (local dmg check 17/17) |
| No dialog on a fresh install (watched from document start for 40 s) | **PASS** (packaged app and the app copied out of this dmg) |
| Voice call on the real DGX MiniCPM-o 4.5: silence at the start (15 s) | **PASS** in 4 runs (2 speakers, 2 injected): nothing played while the model started 3–5 short replies by itself (cancelled, not played) |
| Chinese capital question → Chinese answer naming 巴黎 | **PASS** in 4 of 4 runs (replies use **Simplified** characters, e.g. 「法国的首都是巴黎。」) |
| Stop reply while audible → silent; nothing plays in the next 6 s | **PASS** in 4 of 4 runs (14–24 ms) |
| Capital question again after Stop reply | answered in 3 of 4 runs. The not-an-answer (「你的首都是哪里呀？」) happened once, through the speakers. With the same page Stop handling it did not happen in 2 injected runs or 2 host-API trials, so it is not caused by the Stop handling; intermittent, not isolated |
| English question | answered in English (expected: no reply language is imposed) |
| Chinese question right after an English turn | answered in English in 2 of 4 runs (the model keeps the previous turn's language) |
| Chat system messages on the wire (mock, packaged app) | **PASS**: the MiMo preset and the MiniCPM persona carry the Chinese hint and no strict rule; audio.2-pre31 negative control carries the strict rule |
| Voice page regressions (mock, packaged app) | **PASS** (nothing plays before the user speaks; hint-only instructions; Stop after the server finished; late audio; model-started replies after Stop; answer after Stop). audio.2-pre31 control carries the strict rule |
| Interrupting the model by speaking over it (real) | **NOT RUN** |
| Call saved into the conversation; camera | **NOT IMPLEMENTED** |
| **Switch the DGX model from Harness** (real, audio.2-pre22, same library and host) | **PASS** (unchanged) |
| Second physical Mac | **NOT RUN** |

- **Known limits:**
  - **The reply language follows the speech**, with Simplified characters and carry-over from the previous turn.
  - **Model-started replies still cost GPU** while the call waits for the user. The server option `force_listen_count` (host default 0) reduces them: in one trial each, 0 / 2 / 5 gave 3 / 1 / 1 starts in 10 s of silence and 3.7 / 3.5 / 5.8 s to the answer. The host and model-library owners are choosing a value.
  - **Late reply audio:** about 2 gaps / 1.5 s per call; the adaptive playback buffer grows to 0.8 s.
- **audio.2-pre32 vs audio.2-pre31:** only dsh-audio-release-kit changed (0.3.6 → 0.3.7). Patches, distribution defaults and the other three plugins are identical.
- **Switching scope:** the DGX allows Harness to switch only between the two demo models. Choosing a model in the model picker does not switch the DGX.
