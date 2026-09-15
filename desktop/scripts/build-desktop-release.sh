#!/bin/zsh
: "${DSH_ROOT:?set DSH_ROOT to your working checkout (see desktop/BUILD.md)}"; export DSH_ROOT
# Build the local/custom macOS arm64 DeepSeek Harness Desktop from the pinned official source with the
# sbplab local patches, optionally bundling plugin package files into the offline seed.
#
# Usage: desktop-local-build/build-desktop-release.sh --out <dir> [--bundled-dir <dir-with-tgz>] [--release-tag <tag>]
#          [--product-name <name>] [--app-id <reverse.dns.id>] [--profile <desktop-name>] [--log <file>]
#          [--distribution-settings <yaml>]   (patch 0007: default settings seeded into settings.yaml on first launch)
# Ad-hoc signed, not notarized (no Developer ID identity on this machine); auto-update disabled via .invalid origin.
set -euo pipefail
SRC=${DSH_ROOT}/vendor/deepseek-harness-desktop-src
PATCHES=${DSH_ROOT}/desktop-local-build/patches
OUT="" BUNDLED="" PRODUCT="DeepSeek Harness (local dev build)" APP_ID="local.sbplab.deepseek-harness.dev" PROFILE="" LOG="" RELEASE_TAG="" DIST_SETTINGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --bundled-dir) BUNDLED="$2"; shift 2 ;;
    --product-name) PRODUCT="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --release-tag) RELEASE_TAG="$2"; shift 2 ;;
    --distribution-settings) DIST_SETTINGS="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
# Fail fast before the lock (audio.2-pre17 13:22: a relative --bundled-dir failed inside `export X="$(cd …)"`, which
# set -e does not catch, and the build silently continued without bundled plugins into the same --out).
BUNDLED_TGZ=()
if [ -n "$BUNDLED" ]; then
  [ -d "$BUNDLED" ] || { echo "--bundled-dir $BUNDLED is not a directory (cwd $PWD)" >&2; exit 2; }
  BUNDLED_ABS="$(cd "$BUNDLED" && pwd)" || { echo "--bundled-dir $BUNDLED cannot be resolved" >&2; exit 2; }
  BUNDLED="$BUNDLED_ABS"
  BUNDLED_TGZ=("$BUNDLED"/*.tgz(N))
  [ ${#BUNDLED_TGZ[@]} -gt 0 ] || { echo "--bundled-dir $BUNDLED contains no .tgz" >&2; exit 2; }
  # codesign --force writes into every seed file; a read-only tarball (audio.2-pre19 16:19, mic 0.3.8 dist is 0444) fails signing late.
  for t in "${BUNDLED_TGZ[@]}"; do [ -w "$t" ] || { echo "--bundled-dir: $t is not writable (codesign would fail); chmod u+w the staged copy" >&2; exit 2; }; done
fi
if [ -n "$DIST_SETTINGS" ]; then
  [ -f "$DIST_SETTINGS" ] || { echo "--distribution-settings $DIST_SETTINGS is not a file (cwd $PWD)" >&2; exit 2; }
  DIST_SETTINGS="$(cd "$(dirname "$DIST_SETTINGS")" && pwd)/$(basename "$DIST_SETTINGS")"
  head -c 1 "$DIST_SETTINGS" | grep -q '[{[]' && { echo "--distribution-settings must be block-style YAML" >&2; exit 2; }
fi
# One writer per output: refuse an --out that already holds an app (use a fresh directory per build).
if [ -d "$OUT" ] && [ -n "$(find "$OUT" -maxdepth 1 -name '*.app' -print -quit)" ]; then echo "--out $OUT already contains an .app; refusing to overwrite (use a fresh --out)" >&2; exit 2; fi
mkdir -p "$OUT"
# The build cd's into the vendor tree: a relative --out/--log would break there (audio.2-pre22 17:46).
OUT="$(cd "$OUT" && pwd)"
[ -n "$LOG" ] || LOG="$OUT/build.log"
case "$LOG" in /*) ;; *) LOG="$PWD/$LOG" ;; esac
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
  echo "== $(date '+%F %T') build start: product=$PRODUCT appId=$APP_ID profile=${PROFILE:-desktop} releaseTag=${RELEASE_TAG:-none} bundled=${BUNDLED:-none} distributionSettings=${DIST_SETTINGS:-none}"
  git rev-parse HEAD
  git diff --stat
} >> "$LOG"
pnpm install --frozen-lockfile >> "$LOG" 2>&1
export DSH_DESKTOP_APP_ID="$APP_ID"
export DSH_DESKTOP_LOCAL_UNSIGNED=1
export DSH_DESKTOP_LOCAL_PRODUCT_NAME="$PRODUCT"
if [ -n "$PROFILE" ]; then export DSH_DESKTOP_LOCAL_PROFILE="$PROFILE"; else unset DSH_DESKTOP_LOCAL_PROFILE; fi
# Release tag (patch 0006): window title suffix + CFBundleVersion, e.g. audio.2-pre20.
if [ -n "$RELEASE_TAG" ]; then export DSH_DESKTOP_LOCAL_RELEASE_TAG="$RELEASE_TAG"; else unset DSH_DESKTOP_LOCAL_RELEASE_TAG; fi
export DSH_DESKTOP_AUTO_UPDATE_ENV=test
export DOWNLOAD_TEST_ORIGIN=https://updates.invalid
if [ -n "$BUNDLED" ]; then export DSH_DESKTOP_BUNDLED_PLUGINS_DIR="$BUNDLED"; else unset DSH_DESKTOP_BUNDLED_PLUGINS_DIR; fi
if [ -n "$DIST_SETTINGS" ]; then export DSH_DESKTOP_LOCAL_DISTRIBUTION_SETTINGS="$DIST_SETTINGS"; else unset DSH_DESKTOP_LOCAL_DISTRIBUTION_SETTINGS; fi
START=$(date +%s)
pnpm run package:desktop:mac:arm64:dir >> "$LOG" 2>&1
ARTIFACTS="$SRC/apps/desktop/.desktop-build/targets/mac-arm64/artifacts"
APP="$(find "$ARTIFACTS" -maxdepth 2 -name '*.app' -type d | head -1)"
[ -n "$APP" ] || { echo "no .app produced; see $LOG" >&2; exit 3; }
ditto "$APP" "$OUT/$(basename "$APP")"
# The offline seed must hold exactly the bundled tarballs (name-sha12.tgz), no more and no fewer.
if [ ${#BUNDLED_TGZ[@]} -gt 0 ]; then
  SEED="$OUT/$(basename "$APP")/Contents/Resources/seed/desktop-local-packages"
  for t in "${BUNDLED_TGZ[@]}"; do
    base="$(basename "$t" .tgz)"; sha="$(shasum -a 256 "$t" | cut -c1-12)"
    [ -f "$SEED/$base-$sha.tgz" ] || { echo "bundled $base ($sha) missing from $SEED" | tee -a "$LOG" >&2; exit 7; }
  done
  count="$(find "$SEED" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')"
  [ "$count" = "${#BUNDLED_TGZ[@]}" ] || { echo "seed holds $count packages, expected ${#BUNDLED_TGZ[@]}" | tee -a "$LOG" >&2; exit 7; }
  echo "seed check: ${#BUNDLED_TGZ[@]} bundled tarballs present by sha" | tee -a "$LOG"
fi
if [ -n "$DIST_SETTINGS" ]; then
  cmp -s "$DIST_SETTINGS" "$OUT/$(basename "$APP")/Contents/Resources/distribution-settings.yaml" \
    || { echo "distribution settings missing or different in Resources" | tee -a "$LOG" >&2; exit 7; }
  echo "distribution settings check: Resources/distribution-settings.yaml = $(shasum -a 256 "$DIST_SETTINGS" | cut -c1-12)" | tee -a "$LOG"
fi
echo "== $(date '+%F %T') build done in $(( $(date +%s) - START ))s: $OUT/$(basename "$APP")" | tee -a "$LOG"
