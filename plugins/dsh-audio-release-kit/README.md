# dsh-audio-release-kit

Part of the local/custom **DeepSeek Harness Audio (Local Build)** distribution, built from the official DeepSeek Harness 0.1.5-rc.1 source. It is **not** an official DeepSeek release.

- **Preset:** read-only agent preset **DGX audio (no tools)** (`presets/dgx-audio`) for audio models that reject tool calling. Desktop discovers it through `dsh.agentPresets` (local host patch 0004). On Web/CLI, copy `presets/dgx-audio` to `$DSH_HOME/.agent-presets/dgx-audio`.
- **Settings → Plugins → Audio servers:** add or remove OpenAI-compatible vLLM / vLLM-Omni servers into the `dsh-dgx-audio` settings section. **Test connection** runs only when you click it, as a host reachability probe with no inference. Each model's capability state is shown truthfully (verified / not tested / declared / advertised).
- **Composer chip:** when an audio-adapter model is selected in a non-audio preset, a blank conversation switches to the audio preset in place; a started one gets a new audio conversation with the same workspace and model.
- No network access of its own beyond the host's own `/api/dsh-dgx-audio/v1/*` routes. No credentials: only an environment-variable **name** may be stored for API keys.
