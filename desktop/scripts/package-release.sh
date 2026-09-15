#!/usr/bin/env bash
: "${DSH_ROOT:?set DSH_ROOT to your working checkout (see desktop/BUILD.md)}"; export DSH_ROOT
# Assemble a versioned local/custom release folder from a built app + bundled plugin tarballs + docs:
#   <REL>/DeepSeek-Harness-Audio-Local-<version>-arm64.dmg      (app, Applications link, docs, examples)
#   <REL>/plugins/*.tgz (+ build records)                          (individually installable plugins)
#   <REL>/source/patches/*.patch, source/release-kit-src.tgz       (reproducible host hooks + release-kit source)
#   <REL>/docs/, RELEASE_MANIFEST.json, SHA256SUMS
# Usage: desktop-local-build/package-release.sh <REL> <version>
set -euo pipefail
REL="$1"; VERSION="$2"
ROOT=${DSH_ROOT}
# The product name may carry the release (e.g. "DeepSeek Harness Audio pre20"): take the one app the build produced.
APP="$(find "$REL/work/app" -maxdepth 1 -name '*.app' -type d | head -1)"
[ -n "$APP" ] && [ "$(find "$REL/work/app" -maxdepth 1 -name '*.app' -type d | wc -l | tr -d ' ')" = 1 ] || { echo "work/app must hold exactly one .app" >&2; exit 2; }
APP_NAME="$(basename "$APP" .app)"
[ -d "$APP" ] || { echo "missing $APP" >&2; exit 2; }
DMG_NAME="DeepSeek-Harness-Audio-Local-$VERSION-arm64.dmg"

rm -rf "$REL/plugins" "$REL/source" "$REL/docs" "$REL/work/dmg-root"
mkdir -p "$REL/plugins" "$REL/source/patches" "$REL/docs" "$REL/work/dmg-root"
cp "$REL"/work/bundled-plugins/*.tgz "$REL/plugins/"
# Mandatory bundled plugins (FOCUSED_AUDIO_DEMO_PLAN): the app seed and the standalone plugins/ must each hold exactly the four
# required plugins, byte-identical (sha256). Anything missing, extra or different fails the release before the dmg is built.
REQUIRED_PLUGINS=(dsh-dgx-audio dsh-voice-capture dsh-audio-model-library dsh-audio-release-kit)
SEED_DIR="$APP/Contents/Resources/seed/desktop-local-packages"
[ "$(find "$SEED_DIR" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')" = "${#REQUIRED_PLUGINS[@]}" ] || { echo "release gate: app seed does not hold exactly ${#REQUIRED_PLUGINS[@]} plugins" >&2; exit 8; }
[ "$(find "$REL/plugins" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')" = "${#REQUIRED_PLUGINS[@]}" ] || { echo "release gate: plugins/ does not hold exactly ${#REQUIRED_PLUGINS[@]} tarballs" >&2; exit 8; }
for name in "${REQUIRED_PLUGINS[@]}"; do
  standalone="$(find "$REL/plugins" -maxdepth 1 -name "$name-[0-9]*.tgz" | head -1)"
  [ -n "$standalone" ] || { echo "release gate: required plugin $name missing from plugins/" >&2; exit 8; }
  sha="$(shasum -a 256 "$standalone" | cut -d' ' -f1)"
  embedded="$SEED_DIR/$(basename "$standalone" .tgz)-${sha:0:12}.tgz"
  [ -f "$embedded" ] || { echo "release gate: $name $(basename "$standalone") not embedded as $(basename "$embedded")" >&2; exit 8; }
  [ "$(shasum -a 256 "$embedded" | cut -d' ' -f1)" = "$sha" ] || { echo "release gate: embedded $name differs from standalone" >&2; exit 8; }
done
echo "release gate: 4 required plugins embedded == standalone by sha256"
# Owner build records name the builder checkout: they are not shipped and never rewritten (frozen owner artefacts).
cp "$ROOT"/desktop-local-build/patches/*.patch "$REL/source/patches/"
tar -czf "$REL/source/dsh-audio-release-kit-src.tgz" -C "$ROOT/release-kit" --exclude node_modules --exclude lib dsh-audio-release-kit
tar -czf "$REL/source/desktop-local-build-scripts.tgz" -C "$ROOT" desktop-local-build/build-client-plugin.sh desktop-local-build/build-desktop-release.sh desktop-local-build/apply-patch-stack.sh desktop-local-build/regenerate-patch-0003.sh desktop-local-build/package-release.sh desktop-local-build/tools
cp -R "$REL/work/docs/." "$REL/docs/"

# Guide as HTML (opens by double-click) next to the Markdown source.
for md in "$REL"/docs/*.md; do
  pandoc --standalone --metadata title="$(head -1 "$md" | sed 's/^# //')" -f gfm -t html5 "$md" -o "${md%.md}.html"
done

# DMG content: app, Applications link, guide, examples.
ditto "$APP" "$REL/work/dmg-root/$APP_NAME.app"
ln -s /Applications "$REL/work/dmg-root/Applications"
mkdir -p "$REL/work/dmg-root/使用說明 Guide" "$REL/work/dmg-root/examples"
cp -R "$REL/docs/." "$REL/work/dmg-root/使用說明 Guide/"
cp "$REL"/work/examples/* "$REL/work/dmg-root/examples/"
rm -f "$REL/$DMG_NAME"
hdiutil create -volname "DeepSeek Harness Audio audio.${VERSION##*-audio.}" -srcfolder "$REL/work/dmg-root" -fs HFS+ -format UDZO -ov "$REL/$DMG_NAME" >/dev/null
hdiutil verify "$REL/$DMG_NAME" >/dev/null

node - "$REL" "$VERSION" "$APP" "$DMG_NAME" <<'NODE'
const [rel, version, app, dmgName] = process.argv.slice(2)
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const plist = key => cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const seed = path.join(app, 'Contents/Resources/seed')
const bundled = JSON.parse(fs.readFileSync(path.join(seed, 'desktop-bundled-plugins.json'), 'utf8')).plugins
const releaseJson = JSON.parse(fs.readFileSync(path.join(seed, 'desktop-release.json'), 'utf8'))
const vendor = '${DSH_ROOT}/vendor/deepseek-harness-desktop-src'
const codesign = cp.spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr
const manifest = {
  schemaVersion: 1,
  distribution: 'DeepSeek Harness Audio (Local Build)',
  distributionVersion: version,
  officialProduct: false,
  basedOn: { product: 'DeepSeek Harness Desktop', tag: 'dsh-v0.1.5-rc.1', commit: cp.execFileSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repository: 'deepseek-ai/deepseek-harness (official source, local clone)' },
  app: {
    bundleName: plist('CFBundleName'), bundleIdentifier: plist('CFBundleIdentifier'), shortVersion: plist('CFBundleShortVersionString'),
    minimumSystemVersion: plist('LSMinimumSystemVersion'), architecture: 'arm64',
    desktopProfile: 'desktop-audio', userData: '~/Library/Application Support/DeepSeek Harness Audio (Local Build)',
    runtime: { node: releaseJson.nodeVersion, pnpm: releaseJson.pnpmVersion, hostProtocolVersion: releaseJson.hostProtocolVersion },
    signing: /Signature=adhoc/.test(codesign) ? 'ad-hoc (no Developer ID)' : codesign.split('\n').find(l => l.startsWith('Authority=')) ?? 'unknown',
    notarized: false, autoUpdate: 'disabled (local build)',
  },
  dmg: { file: dmgName, bytes: fs.statSync(path.join(rel, dmgName)).size, sha256: sha(path.join(rel, dmgName)) },
  bundledPlugins: bundled.map(p => ({ name: p.name, version: p.version, sha256: p.sha256, individuallyInstallable: `plugins/${fs.readdirSync(path.join(rel, 'plugins')).find(f => f.startsWith(`${p.name}-${p.version}`) && f.endsWith('.tgz'))}` })),
  hostPatches: fs.readdirSync(path.join(rel, 'source/patches')).sort().map(f => ({ file: `source/patches/${f}`, sha256: sha(path.join(rel, 'source/patches', f)) })),
  genericHostHooks: [
    '0001 local unsigned macOS build (no Developer ID); auto-update disabled',
    '0002 Markdown audio player for same-origin local audio paths',
    '0003 bundled plugins in the seed lockfile, local package files (Install from File), update restore, bundled disable/enable, Remove fix, cordis.patch.yml carry, zh-TW shell copy, microphone usage text, distribution identity/profile',
    '0004 dsh.agentPresets: read-only presets from installed profile packages',
    '0005 client preset: repository-relative CSS virtual module ids (no builder paths in bundles)',
  ],
  exampleAudio: [{ file: 'examples/jfk-inaugural-1961-public-domain-16k.wav', license: 'public domain (US government work, 1961 inaugural address)' }],
  privacyScan: 'no builder home path, user email, lab IP/host, tokens or recordings found in app bundle, seed archives or package tarballs (see RELEASE_READINESS.json)',
  builtAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(rel, 'RELEASE_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
NODE

(cd "$REL" && { shasum -a 256 "$DMG_NAME"; find plugins source docs -type f | LC_ALL=C sort | xargs shasum -a 256; shasum -a 256 RELEASE_MANIFEST.json; } > SHA256SUMS)
echo "packaged $REL/$DMG_NAME"
wc -l "$REL/SHA256SUMS"
