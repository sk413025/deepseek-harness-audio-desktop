# audio.2-pre16: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio (Local Build) 0.1.5-rc.1-audio.2-pre16, macOS arm64, ad-hoc signed, not notarized.
- **Plugins** (frozen packages): **dsh-dgx-audio 0.4.10** `6e7f4c56…`, dsh-audio-model-library 0.1.4 `5cd3a029…`, **dsh-voice-capture 0.3.5** `79cfe8f2…`, dsh-audio-release-kit 0.2.2 `17fc0ef9…`.
- **Desktop patch 0003:** removing a locally installed plugin now works with `CI=true`.

| Item | State |
|---|---|
| Packaged app launches with host 0.4.10 + mic 0.3.5 (mic/Live controls, two-model dropdown) | verified on the build Mac, **no model request yet** |
| MiniCPM-o 4.5 Live full duplex, real microphone (previous build pre13) | real USB mic input + concurrently streamed output seen; **Interrupt NOT EXECUTED**; the duplex label flip is fixed in host 0.4.10, **not yet re-verified** |
| MiniCPM-o 4.5 Interrupt / stable duplex label / Stop on this build | **pending** (DGX window) |
| MiMo-Audio-7B-Instruct progressive spoken reply, real microphone (previous build pre13) | real mic transport PASS; streaming speech **FAIL** (near-silent input, 0.16 s final-only audio, token budget spent on text) |
| MiMo progressive playback with output-clock playback reports on this build | **pending** (DGX window) |
| Hosted CI (release artifact verification) | workflow under review in PR #1; not yet run on this release |
| Finder double-click as a new macOS user, second physical Mac | **pending** |

- **MiMo:** turn-based only (no duplex or barge-in in the tested runtime). Keep replies short (`maxTokens: 200`); long replies degrade to noise.
- **Server endpoints:** not included.
