#!/usr/bin/env bash
: "${DSH_ROOT:?set DSH_ROOT to your working checkout (see desktop/BUILD.md)}"; export DSH_ROOT
# Regenerate patches/0003 as the diff between (pinned HEAD + 0001 + 0002) and the current vendor working tree
# for the files owned by the bundled/local plugin lifecycle and release-identity changes.
set -euo pipefail
SRC=${DSH_ROOT}/vendor/deepseek-harness-desktop-src
PATCHES=${DSH_ROOT}/desktop-local-build/patches
OUT="$PATCHES/0003-desktop-bundled-and-local-plugin-lifecycle.patch"
FILES=(
  apps/desktop/electron-builder.config.mjs
  apps/desktop/renderer/plugin-manager.css
  apps/desktop/renderer/plugin-manager.html
  apps/desktop/renderer/plugin-manager.js
  apps/desktop/scripts/prepare-seed.ts
  apps/desktop/src/ipc.ts
  apps/desktop/src/locale.ts
  apps/desktop/src/main.ts
  apps/desktop/src/paths.ts
  apps/desktop/src/preload.ts
  apps/desktop/src/project-manager.ts
  apps/desktop/tests/locale.spec.ts
  packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx
  packages/client/ui-primitives/src/markdown/render.tsx
)
NEW_FILES=(apps/desktop/tests/project-manager-local-plugins.spec.ts apps/desktop/src/permissions.ts apps/desktop/tests/permissions.spec.ts)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-patch0003.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$SRC"
for f in "${FILES[@]}"; do mkdir -p "$WORK/$(dirname "$f")"; git show "HEAD:$f" > "$WORK/$f"; done
cd "$WORK"
git init -q . && git add -A && git -c user.email=local@build -c user.name=local commit -qm base
git apply "$PATCHES/0001-local-unsigned-macos-dev-build.patch" "$PATCHES/0002-local-ui-audio-player-for-local-audio-files.patch"
git add -A && git -c user.email=local@build -c user.name=local commit -qm "0001+0002"
for f in "${FILES[@]}" "${NEW_FILES[@]}"; do mkdir -p "$(dirname "$f")"; cp "$SRC/$f" "$f"; done
git add -A
git diff --cached > "$OUT"
git diff --cached --stat | tail -1
# The chain must apply to pristine sources, and 0003 must reverse-apply on the working tree (build-loop idempotency).
git stash -q && git apply --check "$OUT" && git stash pop -q
cd "$SRC" && git apply --check -R "$OUT"
echo "0003 regenerated: $OUT"
