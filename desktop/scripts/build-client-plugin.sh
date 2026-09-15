#!/usr/bin/env bash
: "${DSH_ROOT:?set DSH_ROOT to your working checkout (see desktop/BUILD.md)}"; export DSH_ROOT
# Build and pack an out-of-tree Harness plugin with the official client-bundle preset.
#
# The official preset (vendor packages/client/tsdown.client.ts) resolves manifests only
# through packages/*/*/package.json inside the vendor repository, so an out-of-tree plugin
# cannot be built where it lives. This script copies the plugin source (read-only use of the
# source tree) into the release-owned staging slot vendor/.../packages/third-party/<name>,
# builds there, packs a tarball into --out, and writes a build record. It never writes into
# the plugin source directory.
#
# Usage: desktop-local-build/build-client-plugin.sh <plugin-source-dir> [--out <dir>]
#        desktop-local-build/build-client-plugin.sh --repack <delivered.tgz> [--out <dir>]
#   --repack: neutralize builder paths inside an already-built tarball (no rebuild) and repack it.
set -euo pipefail

ROOT=${DSH_ROOT}
VENDOR="$ROOT/vendor/deepseek-harness-desktop-src"
NODE_BIN="$ROOT/.tools/node/bin"
OUT="$ROOT/releases/staging/plugins"

SRC=""
REPACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --repack) REPACK="$2"; shift 2 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) SRC="$1"; shift ;;
  esac
done
export PATH="$NODE_BIN:$PATH"

# Rolldown region comments for the preset's CSS virtual modules carry the absolute staging path
# (e.g. "//#region \0dsh-css:/Users/.../packages/third-party/<name>/src/x.module.css.mjs"). Rewrite
# them package-relative, then refuse to ship any remaining absolute home/tmp path.
sanitize_package_dir() {
  node -e '
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[1];
const changed = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|cjs|map|css)$/.test(e.name)) {
  const before = fs.readFileSync(p, "utf8");
  const after = before.replace(/(?<![.\w-])(?:[A-Za-z]:)?\/(?:[^\s"'"'"'`()\/]+\/)*?packages\/third-party\/[^\/\s"'"'"'`]+\//g, "");
  if (after !== before) { fs.writeFileSync(p, after); changed.push(path.relative(root, p)); }
  const leak = after.match(/\/(?:Users|home|private\/tmp|private\/var|var\/folders)\/[^\s"'"'"'`]{0,60}/);
  if (leak) { console.error("build-client-plugin: absolute path remains in " + path.relative(root, p) + ": " + leak[0]); process.exit(8); }
} } };
walk(root);
process.stdout.write(JSON.stringify(changed));
' "$1"
}

if [ -n "$REPACK" ]; then
  [ -f "$REPACK" ] || { echo "build-client-plugin: --repack needs a tarball" >&2; exit 2; }
  REPACK="$(cd "$(dirname "$REPACK")" && pwd)/$(basename "$REPACK")"
  mkdir -p "$OUT"
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-repack.XXXXXX")"
  trap 'rm -rf "$WORKDIR"' EXIT
  tar -xzf "$REPACK" -C "$WORKDIR"
  [ -f "$WORKDIR/package/package.json" ] || { echo "build-client-plugin: not an npm package tarball" >&2; exit 2; }
  CHANGED="$(sanitize_package_dir "$WORKDIR/package")"
  TGZ_NAME="$(cd "$WORKDIR/package" && npm pack --pack-destination "$OUT" --silent --ignore-scripts | tail -1)"
  TGZ="$OUT/$TGZ_NAME"
  node -e '
const [tgz, from, changed] = process.argv.slice(1);
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const record = { schemaVersion: 1, builtAt: new Date().toISOString(), mode: "repack-sanitized", tarball: path.basename(tgz), sha256: sha(tgz),
  repackedFrom: { file: from, sha256: sha(from) }, sanitizedFiles: JSON.parse(changed), note: "code unchanged; builder staging paths removed from bundle comments" };
fs.writeFileSync(tgz.replace(/\.tgz$/, ".build.json"), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
' "$TGZ" "$REPACK" "$CHANGED"
  exit 0
fi

[ -n "$SRC" ] && [ -f "$SRC/package.json" ] || { echo "build-client-plugin: need a plugin directory with package.json" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"

# Validate the manifest before touching the staging slot.
NAME="$(node -e '
const m = require(process.argv[1]);
const fail = (msg) => { console.error("build-client-plugin: " + msg); process.exit(3) };
if (typeof m.name !== "string" || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(m.name)) fail("invalid package name");
if (typeof m.version !== "string") fail("missing version");
if (!m.dsh || !m.dsh.bundle || typeof m.dsh.bundle.patch !== "string") fail("dsh.bundle.patch is required (Desktop inspectPlugin rejects packages without it)");
for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  for (const [dep, spec] of Object.entries(m[section] || {})) {
    if (/^(workspace|link|file):/.test(String(spec))) fail(section + "." + dep + " uses a non-registry protocol (" + spec + "); packed tarballs must be installable elsewhere");
  }
}
process.stdout.write(m.name);
' "$SRC/package.json")"
VERSION="$(node -p 'require(process.argv[1]).version' "$SRC/package.json")"
SLUG="${NAME//@/}"; SLUG="${SLUG//\//__}"
STAGE="$VENDOR/packages/third-party/$SLUG"
mkdir -p "$OUT"

# One writer at a time in the vendor staging area (release lane owns it; other lanes may call this script).
LOCK="$ROOT/desktop-local-build/.vendor-tree.lock"   # shared with build-desktop-release.sh
for attempt in $(seq 1 600); do
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; break; fi
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  [ "$attempt" = 1 ] && echo "build-client-plugin: waiting for staging lock held by pid ${holder:-?}" >&2
  [ "$attempt" = 600 ] && { echo "build-client-plugin: staging lock still held after 10 min by pid ${holder:-?}" >&2; exit 6; }
  sleep 1
done
PACKDIR=""
# The staging slot is a vendor workspace path (packages/*/*); remove it on exit so the vendor pnpm
# workspace and its frozen lockfile never see a third-party package between builds.
trap 'rm -rf "$STAGE"; rmdir "$VENDOR/packages/third-party" 2>/dev/null || true; [ -n "$PACKDIR" ] && rm -rf "$PACKDIR"; rm -rf "$LOCK"' EXIT
mkdir -p "$STAGE"

# --checksum: same-size files written within the same second must still be copied (seen with version bumps).
rsync -a --delete --checksum --exclude node_modules --exclude lib --exclude .git --exclude '*.tgz' "$SRC/" "$STAGE/"
rm -rf "$STAGE/lib"

BUILT_CLIENT=false
if [ -f "$STAGE/src/client/index.ts" ] || [ -f "$STAGE/tsdown.config.ts" ]; then
  if [ ! -f "$STAGE/tsdown.config.ts" ]; then
    HOST_ENTRY=""
    for candidate in src/index.ts src/index.js; do [ -f "$STAGE/$candidate" ] && { HOST_ENTRY="$candidate"; break; }; done
    [ -n "$HOST_ENTRY" ] || { echo "build-client-plugin: no tsdown.config.ts and no src/index.ts|js host entry" >&2; exit 4; }
    printf "import { clientBundle } from '../../client/tsdown.client.ts'\n\nexport default clientBundle(%s, [%s])\n" \
      "$(node -p 'JSON.stringify(process.argv[1])' "$NAME")" "$(node -p 'JSON.stringify(process.argv[1])' "$HOST_ENTRY")" > "$STAGE/tsdown.config.ts"
  fi
  (cd "$STAGE" && "$VENDOR/node_modules/.bin/tsdown" --config tsdown.config.ts)
  head -c 40 "$STAGE/lib/client.js" | grep -q 'window.__ModuleLoader__.load' \
    || { echo "build-client-plugin: lib/client.js is not a closure-factory bundle" >&2; exit 5; }
  BUILT_CLIENT=true
fi
sanitize_package_dir "$STAGE" > /dev/null

# Pack from a copy outside the vendor workspace so npm does not resolve the repository root.
PACKDIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-pack.XXXXXX")"
# The package's own "files" list decides what ships (JS-host plugins may ship src/).
rsync -a --exclude node_modules "$STAGE/" "$PACKDIR/pkg/"
TGZ_NAME="$(cd "$PACKDIR/pkg" && npm pack --pack-destination "$OUT" --silent | tail -1)"
TGZ="$OUT/$TGZ_NAME"
PACKED_VERSION="$(tar -xzOf "$TGZ" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
[ "$PACKED_VERSION" = "$VERSION" ] || { echo "build-client-plugin: packed version $PACKED_VERSION != source version $VERSION" >&2; rm -f "$TGZ"; exit 7; }
SHA="$(shasum -a 256 "$TGZ" | cut -d' ' -f1)"
SOURCE_TREE_SHA="$(cd "$SRC" && find . -type f -not -path './node_modules/*' -not -path './lib/*' -not -path './.git/*' -not -name '*.tgz' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
node -e '
const [out, name, version, src, tgz, sha, treeSha, builtClient, vendorRev] = process.argv.slice(1);
const record = { schemaVersion: 1, builtAt: new Date().toISOString(), name, version, source: src, sourceTreeSha256: treeSha,
  vendorRevision: vendorRev, preset: "packages/client/tsdown.client.ts", builtClientBundle: builtClient === "true",
  tarball: require("node:path").basename(tgz), sha256: sha };
require("node:fs").writeFileSync(tgz.replace(/\.tgz$/, ".build.json"), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
' "$OUT" "$NAME" "$VERSION" "$SRC" "$TGZ" "$SHA" "$SOURCE_TREE_SHA" "$BUILT_CLIENT" "$(git -C "$VENDOR" rev-parse HEAD)"
tar -tzf "$TGZ" | sed 's/^/  /'
