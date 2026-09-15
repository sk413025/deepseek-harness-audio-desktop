# Release artifact CI

`.github/workflows/release-artifact-verify.yml` checks a **published** GitHub Release of DeepSeek Harness Audio (Local Build).

- **Runners:** GitHub-hosted only — `ubuntu-24.04` plus `macos-26`, which is Apple silicon arm64.
- **Token:** the read-only `GITHUB_TOKEN`. No secrets, no self-hosted runner.

## Triggers
| Event | Target |
|---|---|
| `release: published` (includes prereleases) | that tag. The workflow file must exist in the tagged commit. |
| `workflow_dispatch` (input `tag`, `lifecycle`) | the given tag, or the newest published release |
| `pull_request` / `push` to `main` touching `ci/**` or the workflow | the newest published release (self-test of the CI) |

## What is verified, and against what
| Report | Runner | Evidence class | Checks |
|---|---|---|---|
| `verify-release-sources` | ubuntu | `release-artifact`, `source-tree` | See [Source checks](#source-checks). |
| `verify-patch-stack` | ubuntu | `source-tree` | `desktop/patches/*.patch` apply in order to the upstream commit in `desktop/UPSTREAM.md` (sparse depth-1 fetch). This does **not** rebuild the app. |
| `negative-controls-sources` | ubuntu | `negative-control` | Broken inputs must be rejected: flipped tarball byte, wrong PLUGINS.json version, extra tree file, leaked home path/IP, changed patch. |
| `verify-desktop-artifact` | macos-26 | `release-artifact`, `packaged-app-static` | See [App checks](#app-checks). |
| `negative-controls-artifact` | macos-26 | `negative-control` | The dmg seed checked against a PLUGINS.json with a wrong hash must fail. |
| `desktop-smoke-launch` | macos-26 | `packaged-app-hosted-launch` | See [Launch smoke](#launch-smoke). |
| `desktop-smoke-lifecycle` | macos-26 | `packaged-app-hosted-ui` | See [Plugins window lifecycle](#plugins-window-lifecycle). |

### Source checks
- Every downloaded asset matches its GitHub API `digest` and its `SHA256SUMS` line.
- Plugin tarballs match `releases/<tag>/MANIFEST.txt` and `PLUGINS.json`.
- The tarball `package/` equals `plugins/<name>/` byte for byte. The only allowed extra is `src/`, which must equal the shipped source map `sourcesContent`.
- `npm pack` of the tree reproduces the tarball payload (the uncompressed tar).
- The patch hashes match MANIFEST.txt.
- A privacy scan finds no builder home path, private IP (documented placeholders are allow-listed) or token.
- The unpublished owner test suites are reported as warnings.

### App checks
- The dmg is bound to the published bytes: GitHub digest, SHA256SUMS, `hdiutil verify`, read-only mount and layout.
- Info.plist identity matches the dmg name version.
- All `seed/integrity.json` files are intact.
- The bundled plugins exactly match PLUGINS.json and the release tarballs.
- `app.asar` and the seed hashes match MANIFEST.txt.
- Every Mach-O file contains arm64 (optional prebuilds are allow-listed).
- The ad-hoc signature is valid.
- Gatekeeper and notarization state agree with the release's "not notarized" claim. They are **not** accepted as verified.
- The Electron fuses are recorded.

### Launch smoke
- The app copied from the dmg starts with an isolated `DSH_HOME` and `--user-data-dir`. The offline seed install completes.
- `window.__DSH_BOOT__` loads every bundled client plugin. The served `client.js` bytes equal the released `lib/client.js`.
- The host routes of `dsh-dgx-audio` and `dsh-audio-model-library` answer with the released version and product defaults (no server configured, no `testFaults`).
- The installed package files on disk equal the release tarballs.
- The app quits cleanly and relaunches with the same profile.

### Plugins window lifecycle
Playwright (experimental Electron support) opens the real Plugins window through the application menu and checks:
- The window lists the bundled plugins.
- **Install from File** installs a probe package. Only the native open panel is stubbed in the main process; the button, IPC, project manager, pnpm and host restart are real.
- A non-plugin package and a corrupt `.tgz` are rejected.
- The installed probe can be removed.
- A bundled plugin can be disabled and re-enabled, and the main window boot graph follows each change.

`summarize` binds everything into `evidence.json`:
- run URL, CI commit, tag and tag commit, release id;
- dmg sha and GitHub digest, app identity, plugin versions and hashes, runner image.

A required report that is missing or failed fails the run.

## Not covered by GitHub-hosted runners (never inferred from a green run)
- Real DGX / vLLM-Omni servers:
  - MiniCPM-o-4_5 full duplex and Interrupt;
  - MiMo-Audio-7B-Instruct replies;
  - MiMo progressive playback starting before the stream completes.
- A physical USB microphone and the macOS microphone permission prompt. The app is not covered by the runner image's microphone grants, and the image has no reliable audio devices.
- Speaker playback and audio quality.
- A Finder double-click of a quarantined download (Gatekeeper first open), notarization, a second physical Mac.

These need controlled external runs whose evidence is attached separately (see the research notes in the release coordination folder). A mock or injected audio stream is never reported as microphone evidence.

## Local use
The scripts need Node ≥ 22. `verify-desktop-artifact` and `desktop-smoke` also need macOS and `npm ci --prefix ci`.
- `desktop-smoke` launches a GUI app. Run it only on a machine where a second app window is acceptable.

```bash
node ci/scripts/verify-release-sources.mjs --tag <tag> --tag-src <checkout-of-tag> --assets <dir> --release-json <dir>/release.json --out out/sources.json
```
