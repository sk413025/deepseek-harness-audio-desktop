# dsh-audio-model-library

DeepSeek Harness plugin (Web and Desktop): browse **every** audio model in the audio catalog — including models that are not loaded — pick a task, activate the model on your GPU server through a narrow controller, and use it in a conversation through `dsh-dgx-audio`.

- **Library view** (sidebar → *Audio models*): search; filters for task, catalog status, download state, on-server state, runtime, streaming mode and evidence; per-model identity, download, backend/Desktop evidence (as published by the owners — unverified stays unverified), streaming modes, dependencies and sources; runtimes available on your server with the tasks each can serve (and why a task cannot be used yet).
- **Controlled activation**: *Activate* asks the server controller to stop the idle current model, start this one and check health/model list. Progress shows each phase with elapsed time; *Cancel* stops the load and restores the previous model. Refusals are explained (measurement reservation, owner lock, another GPU workload, a turn still running).
- **Use in this conversation**: selects the Harness model id for one task variant with the standard model selection. Recording, playback, Live and task inputs are in `dsh-voice-capture`.
- **Composer chip**: shows whether the conversation's library model is ready, loading, not loaded or failed.
- **Settings → Plugins → Audio model library**: servers (model host, activation over SSH or a private controller endpoint, or none for administrator-managed endpoints). Only host names, SSH aliases and environment-variable *names* are stored.
- **Client service `audioModelLibrary`** for other plugins: `status(provider, model)` observable, `document()`, `open({ sessionId, rowId })`.

Nothing contacts a server on load. *Refresh*, *Activate*, *Cancel*, *Unload* are explicit actions.

## Binding

- `dsh-dgx-audio` ≥ 0.4.0 with the `dshAudio` service (TASK_CONTRACT v0.2): every recipe's models are registered (cold ones fail fast until ready), activation states are published, running turns block switching unless the user confirms, and capability evidence is reset after a runtime swap.
- `dsh-dgx-audio` 0.3.x: the active recipe is written as one library-owned route (`dgx-library`) in the `dsh-dgx-audio` settings section; other routes are left untouched. Speech synthesis, translation, generation and non-duplex live modes are shown but not usable with 0.3.x.

## Server controller (optional)

`controller/dsh_audio_controller.py` + `controller/DEPLOY.md` + `controller/examples/`. The server owner deploys it; fixed recipe ids only, SSH forced command or private bearer endpoint, owner lock/reservation/busy guards, restore on failure.

## Development

```bash
node --test --test-timeout=120000 test/*.test.js
python3 -m unittest discover -s controller/tests
desktop-local-build/build-client-plugin.sh plugins/dsh-audio-model-library --out parallel-work/model-library/dist
```

No `dependencies`/`peerDependencies`: React, Cordis and schemastery come from the Harness host at runtime.
