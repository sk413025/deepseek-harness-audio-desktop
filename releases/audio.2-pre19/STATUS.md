# audio.2-pre19: status (PRERELEASE CANDIDATE, focused two-model demo)

- **Desktop:** DeepSeek Harness Audio (Local Build) 0.1.5-rc.1-audio.2-pre19, macOS arm64, ad-hoc signed, not notarized. dmg sha256 `52effe97154a10b6…`.
- **Plugins** (frozen packages, preinstalled and enabled on first launch; also attached individually):
  - **dsh-dgx-audio 0.4.12** `dadc204a…`
  - **dsh-voice-capture 0.3.8** `683a4cb8…`
  - dsh-audio-model-library 0.1.4 `5cd3a029…`
  - dsh-audio-release-kit 0.2.2 `17fc0ef9…`
- **Test labels:**
  - "fixture" = a fixed speech WAV fed into the app's microphone input at real-time speed; the real app controls are clicked.
  - "real" = the actual DGX model server.
  - Content correctness of model replies is **not judged** (deferred).

| Item | State |
|---|---|
| Bundled plugins on a fresh macOS profile (from this dmg) | **PASS**: all 4 installed and enabled; relaunch keeps user settings; upgrade from audio.2-pre18 updates the plugins and keeps settings |
| MiniCPM-o 4.5 Live, **server VAD** mode chosen in the app (fixture, real) | **PASS**: speaking over a reply interrupts it; a reply after each clip; mode shown in the Live panel |
| MiniCPM-o 4.5 Live, **native duplex** mode (fixture, real) | Input accepted while replies play; **the model sometimes keeps listening and does not reply to a later clip within 30 s (FAIL, model behaviour)** |
| MiniCPM-o 4.5 Interrupt button / End live session while audio plays (fixture, real) | **PASS** / **PASS** (silent within 11 ms) |
| MiMo-Audio-7B-Instruct record → send → streamed spoken reply → Stop while audible (fixture, real, audio.2-pre17; same host chat path) | **PASS**: sent audio matches the fixture; reply plays before generation ends; Stop mid-chunk ends the request |
| Invalid turn settings (interrupt by speaking without server VAD) | Refused with a clear message before contacting the server (mock) |
| Physical speaker → USB microphone capture check | **NOT RUN** |
| Second physical Mac | **NOT RUN** |

- **MiMo:** turn-based only; replies limited to `maxTokens: 200`. The server sends 4.8 s audio chunks about every 6 s, so short pauses between chunks are expected.
- **MiMo system prompt:** a system message is still sent (the kit preset); the server contract asks for none. Open item.
- **Server endpoints:** not included. See QUICKSTART and settings.example.yaml.
