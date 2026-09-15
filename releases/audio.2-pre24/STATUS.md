# audio.2-pre24: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio pre24 (Local Build) 0.1.5-rc.1-audio.2-pre24, macOS arm64, ad-hoc signed, not notarized. dmg sha256 `5f34cd93288182a9…`.
- **Plugins** (frozen packages, preinstalled and enabled on first launch; also attached individually):
  - dsh-dgx-audio 0.4.12 `dadc204a…`
  - dsh-voice-capture 0.3.8 `683a4cb8…`
  - **dsh-audio-model-library 0.1.6** `90f2a9dc…`: demo focus (two models); Activate switches the model on the DGX Spark
  - **dsh-audio-release-kit 0.2.4** `793b2bbb…`: Audio servers presets now carry each model's request values (MiMo maxTokens 200 + short system prompt; MiniCPM chat_template_kwargs); when Audio models has a server configured, the card points there and the manual form sits behind "Add a server manually"
- **Fixed since audio.2-pre23:** a server added from the kit 0.2.3 presets sent MiMo requests without a token limit (a reply streamed for over a minute) and MiniCPM requests without chat_template_kwargs (replies started with `<think>`). Found in a real user run; kit 0.2.4 sends the values (mock wire test, with audio.2-pre23 as the negative control). Routes added with an older kit keep their old values: remove and re-add them, or use Audio models.
- **New since audio.2-pre19:**
  - **Distribution defaults (patch 0007):** `distribution-settings.dgx-spark.yaml` is added to `settings.yaml` on first launch, only for sections the user does not have. It covers the Audio models server (DGX Spark, ssh controller), the two demo models, the voice prompt when present locally, and the default model. No typing needed.
  - **Version in the app name and window title** (patch 0006).
- **Test labels:**
  - "fixture" = a fixed speech WAV fed into the app's microphone input at real-time speed; the real app controls are clicked.
  - "real" = the actual DGX model server.
  - Content correctness of model replies is **not judged** (deferred).

| Item | State |
|---|---|
| Bundled plugins + distribution defaults from this dmg (fresh profile, relaunch, upgrade from audio.2-pre23) | **PASS** (local dmg check 17/17: all 4 plugins enabled; defaults added on a fresh profile; relaunch keeps settings byte-identical; upgrade from audio.2-pre23 moves the kit to 0.2.4 and keeps user settings) |
| Audio servers presets → request values on the wire (packaged app, mock server) | **PASS**: MiMo max_tokens 200 + short system prompt; MiniCPM chat_template_kwargs. audio.2-pre23 negative control reproduces the defect |
| Audio models → Refresh reaches the DGX controller with the shipped defaults (audio.2-pre23, same defaults and library) | **PASS** (read-only controller status; switching allowed for the two demo models) |
| **Switch the DGX model from Harness** (Audio models → Activate; real, audio.2-pre22 with the same plugins) | **PASS**: MiniCPM → MiMo ready 4 min 49 s after the click; MiMo → MiniCPM about 3 min 47 s |
| MiMo-Audio-7B-Instruct mic question on the switched-in model (fixture, real, audio.2-pre22) | **PASS** |
| MiniCPM-o 4.5 Live on the switched-in model, End while a reply is audible (fixture, real, audio.2-pre22) | **PASS**: no sound after the click |
| MiniCPM-o 4.5 Live, **native duplex** mode (fixture, real, audio.2-pre19) | **The model sometimes keeps listening and does not reply to a later clip (FAIL, model behaviour)**; server VAD mode PASS |
| During a switch, a user on the model being stopped sees a clear "switching" message | **NOT IMPLEMENTED**: they currently get no reply (requested from the library and host owners) |
| Fresh profile without clicks | **Not yet:** the core "Add an API key" dialog (Configure later) and one Audio models Refresh are still needed |
| Physical speaker → USB microphone capture check | **NOT RUN** |
| Second physical Mac | **NOT RUN** |

- **audio.2-pre24 vs audio.2-pre23:** only dsh-audio-release-kit changed (0.2.3 → 0.2.4). Patches and defaults are identical.
- **Kit 0.2.4 on the real DGX:** not run yet (waiting for an idle DGX). A user-level route with the same MiniCPM values sent chat_template_kwargs and replied without `<think>` (18:58, audio.2-pre22 app).
- **Switching scope:** the DGX allows Harness to switch only between the two demo models. Choosing a model in the model picker does not switch the DGX.
- **MiMo:** turn-based only; replies limited to `maxTokens: 200`.
