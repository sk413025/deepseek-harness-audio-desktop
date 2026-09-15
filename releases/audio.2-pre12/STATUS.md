# audio.2-pre12: status (PRERELEASE CANDIDATE)

- **Desktop:** DeepSeek Harness Audio (Local Build) 0.1.5-rc.1-audio.2-pre12, macOS arm64, ad-hoc signed, not notarized.
- **Plugins** (frozen packages): dsh-dgx-audio 0.4.7 `97ae555a…`, dsh-audio-model-library 0.1.4 `5cd3a029…`, dsh-voice-capture 0.3.3 `38d722c3…`, dsh-audio-release-kit 0.2.2 `17fc0ef9…`.

| Item | State |
|---|---|
| Packaged app launches; left **Audio models** entry, 🎙 mic, **Live**, model dropdown visible | verified on the build Mac (CUA UI check) |
| Real USB microphone record → stop → preview in the packaged app | verified (not sent) |
| Clean-profile first launch (isolated HOME + user data), bundled plugins seeded offline | verified on the build Mac |
| MiniCPM-o 4.5 real DGX round trip, Live full duplex / Interrupt | **pending** |
| MiMo-Audio-7B-Instruct | **not included in this build** (see audio.2-pre13) |
| Finder double-click as a new macOS user, Install from File of individual plugins, Audio servers card on a clean profile | **pending** |
| Second physical Mac | **pending** |
