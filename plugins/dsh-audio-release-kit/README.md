# dsh-audio-release-kit

Part of the local/custom **DeepSeek Harness Audio (Local Build)** distribution, built from the official DeepSeek Harness 0.1.5-rc.1 source. It is **not** an official DeepSeek release.

- **Preset:** read-only agent preset **DGX audio (no tools)** (`presets/dgx-audio`) for audio models that reject tool calling. Desktop discovers it through `dsh.agentPresets` (local host patch 0004). On Web/CLI, copy `presets/dgx-audio` to `$DSH_HOME/.agent-presets/dgx-audio`.
- **Settings → Plugins → Audio servers:** add or remove OpenAI-compatible vLLM / vLLM-Omni servers into the `dsh-dgx-audio` settings section.
  - **Presets:** the form offers the SBPLab DGX Spark models (MiniCPM-o 4.5 on port 18124, MiMo-Audio-7B-Instruct on port 18212). A preset model also gets its recipe request values: MiniCPM `chat_template_kwargs`; MiMo `maxTokens: 200` and a short system prompt. Tests: `test/presets.test.ts`.
  - **Audio models configured:** when a server is configured in Audio models (dsh-audio-model-library), the card tells you to use Audio models → Refresh. The manual form sits behind "Add a server manually". Servers that Audio models already serves are listed read-only. **Test connection** runs only when you click it, as a host reachability probe with no inference. Each model's capability state is shown truthfully (verified / not tested / declared / advertised).
- **Composer chip:** when an audio-adapter model is selected in a non-audio preset, a blank conversation switches to the audio preset in place; a started one gets a new audio conversation with the same workspace and model.
- No network access of its own beyond the host's own routes: `/api/dsh-dgx-audio/v1/*`, plus a read of `GET /api/dsh-audio-model-library/v1/library` when the Audio servers card is opened (it contacts no model server). No credentials: only an environment-variable **name** may be stored for API keys.
