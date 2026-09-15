# audio.2-pre23: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio pre23 (Local Build) 0.1.5-rc.1-audio.2-pre23, macOS arm64, ad-hoc signed, not notarized. dmg sha256 `a49130b728290e5c…`.
- **Plugins** (frozen packages, preinstalled and enabled on first launch; also attached individually):
  - dsh-dgx-audio 0.4.12 `dadc204a…`
  - dsh-voice-capture 0.3.8 `683a4cb8…`
  - **dsh-audio-model-library 0.1.6** `90f2a9dc…`: demo focus (two models); Activate switches the model on the DGX Spark
  - **dsh-audio-release-kit 0.2.3** `2d007ea4…`: Audio servers form pre-filled with the DGX Spark address and model; servers provided by Audio models are listed read-only
- **New since audio.2-pre19:**
  - **Distribution defaults (patch 0007):** `distribution-settings.dgx-spark.yaml` is added to `settings.yaml` on first launch, only for sections the user does not have. It covers the Audio models server (DGX Spark, ssh controller), the two demo models, the voice prompt when present locally, and the default model. No typing needed.
  - **Version in the app name and window title** (patch 0006).
- **Test labels:**
  - "fixture" = a fixed speech WAV fed into the app's microphone input at real-time speed; the real app controls are clicked.
  - "real" = the actual DGX model server.
  - Content correctness of model replies is **not judged** (deferred).

| Item | State |
|---|---|
| Bundled plugins + distribution defaults from this dmg (fresh profile, relaunch, upgrade from audio.2-pre19) | **PASS** (local dmg check 17/17: all 4 plugins enabled; defaults added on a fresh profile; relaunch keeps settings byte-identical; upgrade keeps user settings and adds only missing defaults) |
| Audio models → Refresh reaches the DGX controller with the shipped defaults (this build) | **PASS** (read-only controller status; switching allowed for the two demo models) |
| **Switch the DGX model from Harness** (Audio models → Activate; real, audio.2-pre22 with the same plugins) | **PASS**: MiniCPM → MiMo ready 4 min 49 s after the click; MiMo → MiniCPM about 3 min 47 s |
| MiMo-Audio-7B-Instruct mic question on the switched-in model (fixture, real, audio.2-pre22) | **PASS** |
| MiniCPM-o 4.5 Live on the switched-in model, End while a reply is audible (fixture, real, audio.2-pre22) | **PASS**: no sound after the click |
| MiniCPM-o 4.5 Live, **native duplex** mode (fixture, real, audio.2-pre19) | **The model sometimes keeps listening and does not reply to a later clip (FAIL, model behaviour)**; server VAD mode PASS |
| During a switch, a user on the model being stopped sees a clear "switching" message | **NOT IMPLEMENTED**: they currently get no reply (requested from the library and host owners) |
| Fresh profile without clicks | **Not yet:** the core "Add an API key" dialog (Configure later) and one Audio models Refresh are still needed |
| Physical speaker → USB microphone capture check | **NOT RUN** |
| Second physical Mac | **NOT RUN** |

- **audio.2-pre23 vs audio.2-pre22:** only the distribution defaults file changed. The controller command is the library default (`dsh-audio-ctl`, now on the DGX user PATH), and the voice prompt path uses `~/`. Plugins and patches are identical.
- **Switching scope:** the DGX allows Harness to switch only between the two demo models. Choosing a model in the model picker does not switch the DGX.
- **MiMo:** turn-based only; replies limited to `maxTokens: 200`.
