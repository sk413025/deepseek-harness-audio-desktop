# audio.2-pre30: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio pre30 (Local Build) 0.1.5-rc.1-audio.2-pre30, macOS arm64, ad-hoc signed, not notarized. dmg sha256 `46f368870bf94a0d…`.
- **Plugins** (frozen packages, preinstalled and enabled on first launch; also attached individually):
  - dsh-dgx-audio 0.4.12 `dadc204a…`
  - dsh-voice-capture 0.3.8 `683a4cb8…`
  - dsh-audio-model-library 0.1.6 `90f2a9dc…`: demo focus (two models); Activate switches the model on the DGX Spark
  - **dsh-audio-release-kit 0.3.5** `8ec65b71…`: new **Voice conversation** page; no first-run dialogs; Audio servers presets as in 0.2.4
- **New since audio.2-pre24** (audio.2-pre25 to pre29 were internal candidates, not published):
  - **Voice conversation** (left sidebar): a hands-free live call with MiniCPM-o 4.5 (full duplex, through the dsh-dgx-audio live routes).
    - Start, then just talk: no record / stop / send. The microphone opens only after **Start conversation**, with echo cancellation, noise suppression and gain control on.
    - Controls: Mute, **Stop reply**, End. Two-lane timeline (you / model, 1-second cells) and live captions.
    - **Details:** end of speech → first reply audio, the server's cancellation time, playback gaps and buffer, replies held after Stop.
    - "Interrupt by speaking" (server VAD) is the default; native duplex can be selected before Start.
  - **Stop reply:**
    - playback stops at once, including audio still queued after the server has finished generating;
    - a reply still open is cancelled (`cancel-response`), and a truncating playback ack tells the model what was heard;
    - until the user's next turn has ended, replies the model starts by itself are cancelled and not played ("Waiting for you").
  - **Playback buffer:** reply audio starts 0.3 s ahead and buffers up to 1 s more after gaps.
  - **No first-run dialogs:** the "Internal Testing Notice" and the "Add an API key" step are skipped. The DeepSeek API key stays available in Settings → Models.
- **Test labels:**
  - "fixture" = a fixed speech WAV fed into the app's microphone input; the real app controls are clicked.
  - "real" = the actual DGX model server.
  - "mock" = a local test server.

| Item | State |
|---|---|
| Bundled plugins + distribution defaults from this dmg (fresh profile, relaunch, upgrade from audio.2-pre24) | **PASS** (local dmg check 17/17: all 4 plugins enabled; defaults added on a fresh profile; relaunch keeps settings byte-identical; upgrade from audio.2-pre24 moves the kit to 0.3.5 and keeps user settings) |
| No dialog on a fresh install (watched from document start for 40 s; app copied out of this dmg) | **PASS**: no dialog. Negative control audio.2-pre25 (kit 0.3.0): "Internal Testing Notice" at 0.4 s, then "Add an API key" |
| **Voice conversation on the real DGX MiniCPM-o 4.5** (fixture, app copied out of this dmg) | **PASS**, checked against the host's response record:<br>• live 1.5 s; English question answered ("…Paris…"); zh-TW question answered<br>• Stop reply silent 16 ms (server cancellation 0.02 s)<br>• 3 replies the model started by itself after the stop were cancelled and not played<br>• the next question's answer played first |
| Voice page regressions (mock, packaged app) | **PASS**, each with the previous build as negative control:<br>• Stop after the server finished generating<br>• late audio chunks (no state flicker, gaps counted)<br>• model-started replies after Stop<br>• answer after Stop |
| Interrupting the model by speaking over it, on the voice page (real) | **NOT RUN** (Stop was the button) |
| Real microphone and speaker echo cancellation on the voice page | **NOT RUN** |
| Call saved into the conversation; camera | **NOT IMPLEMENTED** (next iterations) |
| MiniCPM-o 4.5 after a cancelled reply (real) | **Known model/server behaviour:** it starts short replies by itself ("So we…") every few seconds. The voice page cancels them and does not play them. Reported to the streaming owners. |
| Reply audio arriving late (real) | 2 gaps / 1.5 s seen in a 14 s reply (audio.2-pre27, before the buffer). The adaptive buffer's real effect is not measured yet. |
| **Switch the DGX model from Harness** (Audio models → Activate; real, audio.2-pre22, same library and host) | **PASS**: MiniCPM → MiMo ready 4 min 49 s after the click; MiMo → MiniCPM about 3 min 47 s |
| MiMo-Audio-7B-Instruct mic question; MiniCPM-o 4.5 Live via the mic plugin (fixture, real, audio.2-pre22) | **PASS** (unchanged plugins) |
| Fresh profile without clicks | **Improved:** no dialogs. One Audio models → Refresh is still needed before the default model and the voice page list the DGX models |
| Physical speaker → USB microphone capture check; second physical Mac | **NOT RUN** |

- **audio.2-pre30 vs audio.2-pre24:** only dsh-audio-release-kit changed (0.2.4 → 0.3.5). Patches, distribution defaults and the other three plugins are identical.
- **Voice page scope:** audio only, MiniCPM-o 4.5 (the model needs to be active on the DGX; use Audio models). MiMo stays turn-based (mic plugin).
- **Switching scope:** the DGX allows Harness to switch only between the two demo models. Choosing a model in the model picker does not switch the DGX.
