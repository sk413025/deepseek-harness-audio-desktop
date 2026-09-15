# dsh-audio-controller — deployment guide (server owner only)

`dsh_audio_controller.py` is an optional, narrow service switch for one GPU server. Harness clients never run it themselves; the server owner installs it, writes the allowlisted recipes and decides who may call it. Python 3.10+ standard library; Docker Compose v2 and `ss` on the server.

What it can do: `status`, `recipes`, `catalog`, `activate <recipeId>`, `deactivate <recipeId>`, `job <jobId>`, `cancel <jobId>`, `health <recipeId>`. Nothing else: no shell, no arbitrary compose files, no image pulls unless the recipe says `"pull": "missing"`.

## 1. Install

```bash
install -d -m 0700 ~/dsh-audio-controller/{bin,etc,state}
install -m 0755 dsh_audio_controller.py ~/dsh-audio-controller/bin/dsh-audio-ctl
cp examples/controller.example.json ~/dsh-audio-controller/etc/controller.json
cp examples/recipes.example.json ~/dsh-audio-controller/etc/recipes.json
```

Edit `etc/controller.json` (paths, lock/reservation files, container prefixes of workloads that must never be preempted) and `etc/recipes.json` (one entry per tested Docker service). Set `"noDeps": true` when the compose service has `depends_on` another GPU model (otherwise `compose up` starts both), and `"pull": "missing"` only for images pinned by digest that may be pulled; the default `never` refuses to fetch anything. List only GPU-using containers in `foreignContainerPrefixes` (download or tooling containers must not block activation). Recipe fields in `compose` and `container` are private; `endpoints`, `servedModels`, `port`, `runtime` are shown to clients and drive the Harness binding (sample rates are never guessed: a realtime endpoint without both rates is not offered). Optionally copy the audio catalog JSON next to it as `catalogFile`.

Check it locally before exposing it:

```bash
~/dsh-audio-controller/bin/dsh-audio-ctl --config ~/dsh-audio-controller/etc/controller.json status
```

## 2. Choose how clients reach it

### a) SSH forced command (recommended; reuses existing authenticated SSH)

Add a dedicated key line for each client in `~/.ssh/authorized_keys` of the account that owns Docker access:

```
command="/home/<user>/dsh-audio-controller/bin/dsh-audio-ctl --config /home/<user>/dsh-audio-controller/etc/controller.json --ssh",restrict ssh-ed25519 AAAA… harness-model-library
```

`restrict` disables PTY, port/agent/X11 forwarding. The controller reads `SSH_ORIGINAL_COMMAND` and accepts only `[A-Za-z0-9._:@-]` tokens. In Harness: Settings → Plugins → Audio model library → Activation **SSH**, host/alias as the user types after `ssh`, command `dsh-audio-ctl`.

Without a forced command the client's tokens run through the login shell of that account (they contain no metacharacters, but every other command that account could run is also reachable) — only acceptable for the server owner's own account.

### b) Private HTTP endpoint

```bash
umask 077; openssl rand -hex 32 > ~/dsh-audio-controller/etc/controller.token
~/dsh-audio-controller/bin/dsh-audio-ctl --config ~/dsh-audio-controller/etc/controller.json serve
```

`http.bind` must be loopback, RFC 1918 or a 100.64.0.0/10 (Tailscale) address; 0.0.0.0/:: and public addresses are refused. Clients send `Authorization: Bearer <token>`; the Harness host reads it from the environment variable named in settings (only the name is stored). Run it under your service manager with `Restart=on-failure`; it holds no GPU memory itself.

## 3. GPU ownership, reservations and busy models

- **Owner lock** (`policy.gpuOwnerLock.path`): if the file exists, switching is refused (`GPU_OWNER_LOCKED`) unless it contains the exact line `controller=allow`. Add that line only for periods when Harness users may switch models.
- **Reservation** (`policy.reservationFile`): `{"state":"measurement","until":"2026-09-15T04:00:00+08:00","owner":"…"}` refuses every switch until `until` (`RESERVED_MEASUREMENT`); `"integration"` with `"allowRecipes":[…]` allows only those recipes; an unreadable file refuses everything. Expired reservations are ignored.
- **Foreign workloads**: a running container whose name starts with a `foreignContainerPrefixes` entry and is not a recipe blocks activation (`FOREIGN_GPU_WORKLOAD`).
- **In-progress turns**: before stopping a model, established TCP connections to its port are drained for `drainSeconds`; still busy → `MODEL_BUSY`, nothing is stopped. (Harness hosts with dsh-dgx-audio ≥ 0.4 also refuse locally while their own turns run.)
- **Offline generator job workers** (controller ≥ 0.1.1; `dsh.offline-job/0.1`)
  - **Why sockets are not enough:** a resident job worker keeps running a job after its stream client disconnects, so established sockets alone cannot guard it. Give the recipe a **private** `offlineJob` object:
    ```json
    "offlineJob": { "activeJobsPath": "/v1/offline-jobs?state=active", "drainPath": "/v1/offline-jobs/drain", "tokenFile": "/abs/path/worker.token" }
    ```
    - `tokenFile` is optional and must be mode 0600. **The owner creates it in place on the server** (for example `install -m 600 /dev/stdin /home/<user>/dsh-audio-controller/etc/gepard-jobworker.token` with the worker's drain bearer). The secret never leaves the server; neither the Harness plugins nor any published recipe carries it.
    - These keys are never returned by `recipes`. They may also sit inside the `adapterMode: "offline-job"` endpoint's `offlineJob`; they are stripped there too.
    - **gepard-1.0 jobworker (DGX v3 contract `JOBWORKER_CONTRACT_gepard-1.0.md`, public recipe `8bd7d4a6…`):** add the published recipe object unchanged to `recipes.json` and append the private block above (paths `/v1/offline-jobs?state=active`, `/v1/offline-jobs/drain`). The worker lists only non-terminal jobs; a reply that lists jobs while `active` is 0 is treated as unreadable (fail closed).
  - **Before stopping that recipe**, the controller:
    1. sets the worker draining;
    2. waits up to `drainSeconds` for `active == 0`;
    3. still active → re-opens the worker and refuses `MODEL_BUSY` with `activeJobs`;
    4. unreadable state (non-200, bad JSON, timeout after `workerTimeoutSeconds`, missing paths or token) → re-opens it and refuses `ACTIVE_JOBS_UNREADABLE`.
  - **Always re-opened:** a cancelled or refused switch never leaves the worker draining.
  - **Status:** `status.active[].activeJobs` shows the count, or `null` when unreadable.
  - **On controller 0.1.0:** do not register a resident job worker as a switchable recipe.
- **Failure recovery**: a failed or cancelled load stops the target and restarts the previously active recipe (`restorePreviousOnFailure`), then reports `restored`.
- Audit trail: `state/audit.jsonl`; jobs: `state/jobs/<jobId>.json`.

## 4. Verify after deployment (server owner, inside an owner-approved window)

1. `status` shows the running recipe with `healthy: true, modelsListed: true` and `switching.allowed` as intended.
2. From a client over the chosen transport: `status` → `activate <cold recipe>` → poll `job` through `stopping/starting/loading/verifying/ready`.
3. With a client connection open to the active model port, `activate` of another recipe returns `refused / MODEL_BUSY`.
4. With a measurement reservation, `activate` returns `RESERVED_MEASUREMENT`.
5. A→B→A switch between two different protocol families, then a real Harness turn on each (see the library HANDOFF acceptance list).
6. Offline job worker recipe (if configured):
   - with a job running and its client disconnected (`?state=active` shows `streamClients: 0`), `activate` of another recipe returns `refused / MODEL_BUSY` listing the job; the worker keeps running and is not left draining;
   - with no active job, the switch proceeds.

## 5. Tests shipped with the source

`python3 -m unittest discover -s controller/tests` (source repository only) drives the controller against fake `docker`/`ss` binaries and loopback stand-in model servers. They are mock evidence, not a DGX result.
