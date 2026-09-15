# audio.2-pre13: status (PRERELEASE CANDIDATE)

- **Desktop:** DeepSeek Harness Audio (Local Build) 0.1.5-rc.1-audio.2-pre13, macOS arm64, ad-hoc signed, not notarized.
- **Plugins** (frozen packages): **dsh-dgx-audio 0.4.8** `9dff24b6…`, dsh-audio-model-library 0.1.4 `5cd3a029…`, dsh-voice-capture 0.3.3 `38d722c3…`, dsh-audio-release-kit 0.2.2 `17fc0ef9…`.

| Item | State |
|---|---|
| MiMo-Audio-7B-Instruct: packaged Desktop → real DGX, **file input smoke** (public-domain JFK clip) | functional round trip: HTTP 200 SSE, `modalities [text, audio]`, `max_tokens 200` sent, text + 16 s 24 kHz spoken reply delivered in 4 progressive payloads, Desktop player renders it |
| MiMo audio quality | **SUSPECT, not passed**: clipping 7.8–9.9 % and noise-like spectrum in the first 1.5 s, 1 % pause frames. Long replies degrade to noise (known server-side FAIL). Spoken audio may differ from the text. |
| MiMo **progressive playback in the Desktop** (starts before completion, later chunks continue), real microphone record → send, Stop | **pending** (Codex real-mic check in progress) |
| MiniCPM-o 4.5 real DGX round trip, Live full duplex / Interrupt with the real microphone | **pending** |
| Finder double-click as a new macOS user, Install from File of individual plugins, second physical Mac | **pending** |

- **MiMo runtime:** turn-based only in this runtime (no duplex, no barge-in). Keep replies short (`maxTokens: 200`).
- **Server endpoints:** not included. Configure your own (see `settings.example.yaml`).
