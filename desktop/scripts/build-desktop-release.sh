#!/bin/zsh
: "${DSH_ROOT:?set DSH_ROOT to your working checkout (see desktop/BUILD.md)}"; export DSH_ROOT
# Build the local/custom macOS arm64 DeepSeek Harness Desktop from the pinned official source with the
# sbplab local patches, optionally bundling plugin package files into the offline seed.
#
# Usage: desktop-local-build/build-desktop-release.sh --out <dir> [--bundled-dir <dir-with-tgz>]
#          [--product-name <name>] [--app-id <reverse.dns.id>] [--profile <desktop-name>] [--log <file>]
# Ad-hoc signed, not notarized (no Developer ID identity on this machine); auto-update disabled via .invalid origin.
set -euo pipefail
SRC=${DSH_ROOT}/vendor/deepseek-harness-desktop-src
PATCHES=${DSH_ROOT}/desktop-local-build/patches
OUT="" BUNDLED="" PRODUCT="DeepSeek Harness (local dev build)" APP_ID="local.sbplab.deepseek-harness.dev" PROFILE="" LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --bundled-dir) BUNDLED="$2"; shift 2 ;;
    --product-name) PRODUCT="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
mkdir -p "$OUT"
[ -n "$LOG" ] || LOG="$OUT/build.log"
export PATH=${DSH_ROOT}/.tools/node/bin:$PATH
# Hold the vendor-tree lock for the whole build: plugin staging under packages/third-party would
# otherwise enter the vendor pnpm workspace and break the frozen lockfile install.
LOCK=${DSH_ROOT}/desktop-local-build/.vendor-tree.lock
for attempt in {1..1800}; do
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; break; fi
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  [ "$attempt" = 1 ] && echo "build-desktop-release: waiting for vendor-tree lock held by pid ${holder:-?}" >&2
  [ "$attempt" = 1800 ] && { echo "build-desktop-release: vendor-tree lock still held after 30 min" >&2; exit 6; }
  sleep 1
done
trap 'rm -rf "$LOCK"' EXIT
if [ -d "$SRC/packages/third-party" ]; then echo "stale plugin staging in vendor packages/third-party; refusing to build" >&2; exit 4; fi
cd "$SRC"
test "$(git rev-parse HEAD)" = 183f08e9c6dde7e36cd2318eaee70b0da08fb35e
${DSH_ROOT}/desktop-local-build/apply-patch-stack.sh
{
  echo "== $(date '+%F %T') build start: product=$PRODUCT appId=$APP_ID profile=${PROFILE:-desktop} bundled=${BUNDLED:-none}"
  git rev-parse HEAD
  git diff --stat
} >> "$LOG"
pnpm install --frozen-lockfile >> "$LOG" 2>&1
export DSH_DESKTOP_APP_ID="$APP_ID"
export DSH_DESKTOP_LOCAL_UNSIGNED=1
export DSH_DESKTOP_LOCAL_PRODUCT_NAME="$PRODUCT"
if [ -n "$PROFILE" ]; then export DSH_DESKTOP_LOCAL_PROFILE="$PROFILE"; else unset DSH_DESKTOP_LOCAL_PROFILE; fi
export DSH_DESKTOP_AUTO_UPDATE_ENV=test
export DOWNLOAD_TEST_ORIGIN=https://updates.invalid
if [ -n "$BUNDLED" ]; then export DSH_DESKTOP_BUNDLED_PLUGINS_DIR="$(cd "$BUNDLED" && pwd)"; else unset DSH_DESKTOP_BUNDLED_PLUGINS_DIR; fi
START=$(date +%s)
pnpm run package:desktop:mac:arm64:dir >> "$LOG" 2>&1
ARTIFACTS="$SRC/apps/desktop/.desktop-build/targets/mac-arm64/artifacts"
APP="$(find "$ARTIFACTS" -maxdepth 2 -name '*.app' -type d | head -1)"
[ -n "$APP" ] || { echo "no .app produced; see $LOG" >&2; exit 3; }
rm -rf "$OUT/$(basename "$APP")"
ditto "$APP" "$OUT/$(basename "$APP")"
echo "== $(date '+%F %T') build done in $(( $(date +%s) - START ))s: $OUT/$(basename "$APP")" | tee -a "$LOG"
