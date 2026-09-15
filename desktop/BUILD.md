# Building the desktop app

**Requirements:** macOS on Apple Silicon (arm64), Xcode command line tools, Node 24 with pnpm 11 (the scripts put `$DSH_ROOT/.tools/node/bin` first on PATH if present), and `pandoc` for packaging.

## 1. Working checkout layout (`DSH_ROOT`)
```bash
export DSH_ROOT=$HOME/dsh-audio-build
mkdir -p "$DSH_ROOT/vendor" "$DSH_ROOT/desktop-local-build"
git clone https://github.com/deepseek-ai/deepseek-harness.git "$DSH_ROOT/vendor/deepseek-harness-desktop-src"
git -C "$DSH_ROOT/vendor/deepseek-harness-desktop-src" checkout 183f08e9c6dde7e36cd2318eaee70b0da08fb35e   # tag dsh-v0.1.5-rc.1
cp -R desktop/patches "$DSH_ROOT/desktop-local-build/patches"
cp desktop/scripts/*.sh "$DSH_ROOT/desktop-local-build/"
```

## 2. Plugin packages to bundle
- Take the tarballs from a GitHub Release, or pack `plugins/<name>` yourself.
- Put the `.tgz` files in one folder, for example `$DSH_ROOT/bundled`.
- `releases/<version>/MANIFEST.txt` lists the exact sha256 of each plugin in that version. Verify them before building.

## 3. Build (ad-hoc signed, not notarized)
```bash
zsh "$DSH_ROOT/desktop-local-build/build-desktop-release.sh" --out "$DSH_ROOT/out/app" --bundled-dir "$DSH_ROOT/bundled" \
  --product-name "DeepSeek Harness Audio (Local Build)" --app-id local.sbplab.deepseek-harness-audio --profile desktop-audio --log "$DSH_ROOT/out/build.log"
```
The script applies the patch stack to the upstream checkout and bundles the plugin files into the offline seed.

## 4. Package (dmg + plugins + docs)
- Put the app in `<REL>/work/app/` and the bundled plugins in `<REL>/work/bundled-plugins/`.
- Put `releases/<version>/QUICKSTART.zh-TW.md` in `<REL>/work/docs/`.
- Put `releases/<version>/settings.example.yaml` and a public-domain example WAV in `<REL>/work/examples/`.

```bash
bash "$DSH_ROOT/desktop-local-build/package-release.sh" "<REL>" <version>
```
