#!/usr/bin/env bash
# Check that desktop/patches/*.patch (tag tree) apply, in order, to the pinned official upstream commit named in
# desktop/UPSTREAM.md. Fetches only that commit (depth 1, sparse: just the files the stack touches).
# This proves the published patch stack is coherent with its upstream; it does NOT rebuild the app.
# Usage: verify-patch-stack.sh <tag-src> <out.json>
set -euo pipefail
SRC="$(cd "$1" && pwd)"; mkdir -p "$(dirname "$2")"; OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
COMMIT="$(sed -nE 's/.*\*\*Commit:\*\*[[:space:]]*`([0-9a-f]{40})`.*/\1/p' "$SRC/desktop/UPSTREAM.md")"
REPO="$(sed -nE 's/.*\*\*Repository:\*\*[[:space:]]*(https:\/\/github\.com\/[^ )]+).*/\1/p' "$SRC/desktop/UPSTREAM.md")"
[ -n "$COMMIT" ] && [ -n "$REPO" ] || { echo "UPSTREAM.md has no repository/commit" >&2; exit 2; }
PATCHES=()
while IFS= read -r p; do PATCHES+=("$p"); done < <(find "$SRC/desktop/patches" -name '*.patch' | LC_ALL=C sort)
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(for p in "${PATCHES[@]}"; do git apply --numstat "$p" | cut -f3; done | LC_ALL=C sort -u)
cd "$WORK"
git init -q upstream && cd upstream
git remote add origin "$REPO.git"
git -c protocol.version=2 fetch -q --depth 1 --filter=blob:none origin "$COMMIT"
git sparse-checkout init --no-cone
printf '%s\n' "${FILES[@]}" | git sparse-checkout set --no-cone --stdin
git -c advice.detachedHead=false checkout -q FETCH_HEAD
test "$(git rev-parse HEAD)" = "$COMMIT"
RESULTS=()
status=pass
for p in "${PATCHES[@]}"; do
  name="$(basename "$p")"
  if err="$(git apply --whitespace=nowarn "$p" 2>&1)"; then
    RESULTS+=("{\"id\":\"apply.$name\",\"status\":\"pass\",\"evidence\":\"source-tree\",\"summary\":\"applies to upstream $COMMIT\",\"patch\":\"$name\",\"applied\":true,\"sha256\":\"$(shasum -a 256 "$p" | cut -d' ' -f1)\"}")
  else
    status=fail
    RESULTS+=("{\"id\":\"apply.$name\",\"status\":\"fail\",\"evidence\":\"source-tree\",\"summary\":\"does not apply to upstream $COMMIT\",\"patch\":\"$name\",\"applied\":false,\"error\":$(printf '%s' "$err" | head -c 2000 | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')}")
    break
  fi
done
CHANGED="$(git status --porcelain | wc -l | tr -d ' ')"
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<JSON
{"schemaVersion":1,"report":"verify-patch-stack","verdict":"$status","counts":{"$status":${#RESULTS[@]}},"meta":{"upstream":"$REPO","commit":"$COMMIT","files":${#FILES[@]},"changedPaths":$CHANGED},"checks":[$(IFS=,; echo "${RESULTS[*]}")]}
JSON
cat "$OUT"
[ "$status" = pass ]
