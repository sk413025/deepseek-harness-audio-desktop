# DeepSeek Harness Audio (Local Build)

A **local/custom** macOS desktop build of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with audio plugins for OpenAI-compatible vLLM / vLLM-Omni servers. **Not an official DeepSeek release.**

## Status
- **Current scope:** a focused two-model demo on a DGX Spark server:
  - `openbmb/MiniCPM-o-4_5` (voice chat + Live full duplex);
  - `XiaomiMiMo/MiMo-Audio-7B-Instruct` (turn-based voice chat with streamed spoken reply).
- **Every published build is a prerelease candidate.** Each release's `STATUS.md` states what was verified on the real desktop and what is still pending.
- **Not claimed:** stable, production, notarized, or "microphone/streaming fully verified". A second physical Mac has not been verified.

## Layout
| Path | Content |
|---|---|
| `desktop/UPSTREAM.md` | exact upstream repository, tag and commit the desktop app is built from |
| `desktop/patches/` | the local patch stack applied on top of upstream (0001–0005) |
| `desktop/scripts/` | build and packaging scripts (set `DSH_ROOT` to your checkout; see `desktop/BUILD.md`) |
| `plugins/dsh-dgx-audio/` | host audio adapter (vLLM / vLLM-Omni chat audio, speech, realtime duplex) |
| `plugins/dsh-voice-capture/` | microphone capture, Live panel, progressive reply player |
| `plugins/dsh-audio-model-library/` | audio model library panel and switching (plus optional DGX controller) |
| `plugins/dsh-audio-release-kit/` | "DGX audio (no tools)" preset and the Audio servers settings card |
| `releases/<version>/` | reproducible manifest (exact plugin sha256), quickstart, example settings, status |

Plugin directories hold the **frozen package contents** of the version named in each commit. Git history shows the version-to-version changes.

## Downloads
- Installers (`.dmg`), individual plugin tarballs and `SHA256SUMS` are attached to **GitHub Releases**, one per desktop version.
- Each plugin tarball can be installed separately: Settings → Plugins → Install from File.

## Not in this repository
- Credentials, personal settings, recordings, model weights or caches, lab host addresses.
- Configure your own server address in the app: Settings → Plugins → Audio servers, or `releases/<version>/settings.example.yaml`.

## Licences
- This repository: MIT (`LICENSE`).
- Upstream DeepSeek Harness: MIT, © 2026 DeepSeek (`LICENSE-UPSTREAM-DeepSeek-Harness.txt`).
- Each plugin carries its own `LICENSE` (MIT).
- Server-side models and runtimes (vLLM-Omni, MiniCPM-o, MiMo-Audio) are **not** distributed here; their own licences apply on the server.
