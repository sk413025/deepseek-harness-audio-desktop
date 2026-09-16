# audio.2-pre31: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio pre31 (Local Build) 0.1.5-rc.1-audio.2-pre31, macOS arm64, ad-hoc signed, not notarized. dmg sha256 `16acc05384e46d3c…`.
- **Plugins** (frozen packages, preinstalled and enabled on first launch; also attached individually):
  - dsh-dgx-audio 0.4.12 `dadc204a…`
  - dsh-voice-capture 0.3.8 `683a4cb8…`
  - dsh-audio-model-library 0.1.6 `90f2a9dc…`: demo focus (two models); Activate switches the model on the DGX Spark
  - **dsh-audio-release-kit 0.3.6** `0506fb6b…`: replies in Traditional Chinese; the voice call plays the model only after you have spoken
- **New since audio.2-pre30:**
  - **Reply language: Traditional Chinese (Taiwan).** The rule is sent in three places:
    - the voice call's duplex instructions (MiniCPM-o 4.5; the server's default line "Streaming Omni Conversation." stays first);
    - the "DGX audio (no tools)" persona, for new conversations with either model;
    - the MiMo Audio servers preset.
  - **Voice conversation starts by listening.** A full-duplex model can start talking into the silence as soon as the call opens (seen on the DGX: English sentences before the user said anything). Replies the model starts before your first turn has ended are cancelled and not played.
- **Test labels:**
  - "fixture" = a fixed speech WAV fed into the app's microphone input;
  - "speakers" = TTS WAVs played through the Mac speakers into a USB microphone facing them (real microphone and echo cancellation);
  - "real" = the actual DGX model server;
  - "mock" = a local test server.

| Item | State |
|---|---|
| Bundled plugins + distribution defaults from this dmg (fresh profile, relaunch, upgrade from audio.2-pre24) | **PASS** (local dmg check 17/17) |
| No dialog on a fresh install (watched from document start for 40 s; app copied out of this dmg) | **PASS** (a first attempt lost its DevTools session before reporting; the rerun passed) |
| Voice call on the real DGX MiniCPM-o 4.5 (speakers into the real microphone) | • 15 s of silence after the call opened: **PASS**, nothing played (the model started 5 short replies by itself; all cancelled, not played)<br>• Chinese question 「請問，法國的首都是哪裡？」 → 「法國的首都是巴黎。」: **PASS** (Traditional)<br>• Stop reply: **PASS**, silent 10 ms after the click; nothing played in the next 6 s<br>• echo: the model's own voice from the speakers did not interrupt its reply<br>• **English question → English reply ("The capital of France is Paris."): FAIL, model behaviour** (see below)<br>• the same Chinese question after Stop reply was once answered with a question (「你的首都是哪裡呢？」); the same question asked after cancelled model replies was answered correctly in 2 host-API trials |
| Reply-language wording (real, host API, single trials) | English speech got English replies with all three wordings tried. Chinese speech got Traditional Chinese with the shipped wording; a Chinese-only prompt gave Simplified |
| Chat system messages on the wire (mock, packaged app) | **PASS**: the MiMo preset and the MiniCPM persona both carry the Traditional Chinese rule; audio.2-pre30 negative control carries none |
| Voice page regressions (mock, packaged app) | **PASS** (nothing plays before the user speaks; the call asks for Traditional Chinese; Stop after the server finished; late audio; model-started replies after Stop; answer after Stop). audio.2-pre30 negative control reproduces the first two defects |
| Interrupting the model by speaking over it (real) | **NOT RUN** |
| Call saved into the conversation; camera | **NOT IMPLEMENTED** |
| **Switch the DGX model from Harness** (real, audio.2-pre22, same library and host) | **PASS** (unchanged) |
| Second physical Mac | **NOT RUN** |

- **Known limits:**
  - **English speech gets English replies.** MiniCPM-o 4.5 full duplex follows the language of the speech; the system prompt did not override it.
  - **Model-started replies still cost GPU.** They are generated on the DGX and cancelled by the page every few seconds while waiting for the user. The server option `force_listen_count` (host default 0) reduces them. In one trial each, 0 / 2 / 5 gave 3 / 1 / 1 starts in 10 s of silence and 3.7 / 3.5 / 5.8 s to the answer. The host and model-library owners are choosing a value.
  - **Late reply audio:** 2 gaps / 1.4 s in the speakers run; the adaptive playback buffer grew to 0.8 s.
- **audio.2-pre31 vs audio.2-pre30:** only dsh-audio-release-kit changed (0.3.5 → 0.3.6). Patches, distribution defaults and the other three plugins are identical.
- **Switching scope:** the DGX allows Harness to switch only between the two demo models. Choosing a model in the model picker does not switch the DGX.
