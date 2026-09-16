#!/usr/bin/env bash
# Isolated packaged-Desktop home for dsh-voice-capture E2E (second instance of the installed local dev build; never the
# user's profile). First launch creates profiles/desktop, then the app is quit; the given tarballs are sideloaded with the
# Desktop pnpm store (the dsh CLI refuses the Electron-managed profile), added to dsh.profile.bundles, and settings.yaml
# is copied from a prepared Web home (ports rewritten). pnpm may print Done without exiting: the install is checked on
# disk and only that stale pnpm is stopped. Bounded waits everywhere.
# Usage: setup-desktop-home.sh <desktop-dir> <cdp-port> <web-home-with-settings> <port-rewrite "a:b,c:d"|-> <tgz>...
set -euo pipefail
D="$1"; CDP="$2"; WEBHOME="$3"; REWRITE="$4"; shift 4
H="$D/home 家"
APP="${DSH_DESKTOP_APP:-$HOME/Applications/DeepSeek Harness (local dev build).app/Contents/MacOS/DeepSeek Harness}"
DSH_ROOT="${DSH_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
export PATH="$DSH_ROOT/.tools/node/bin:$PATH"
mkdir -p "$H" "$D/userdata 使用者" "$D/workspace 工作區"
lsof -nP -iTCP:"$CDP" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $CDP busy" >&2; exit 3; }
DSH_HOME="$H" nohup "$APP" --user-data-dir="$D/userdata 使用者" --remote-debugging-port="$CDP" > "$D/desktop-stdout-1.log" 2>&1 &
PID=$!
for _ in $(seq 1 90); do [ -f "$H/profiles/desktop/package.json" ] && curl -s "http://127.0.0.1:$CDP/json" 2>/dev/null | grep -q "dsh-app://" && break; sleep 1; done
kill "$PID" 2>/dev/null || true
for attempt in 1 2 3; do
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -0 "$PID" 2>/dev/null || break
  kill "$PID" 2>/dev/null || true
done
kill -0 "$PID" 2>/dev/null && { echo "first-launch app did not exit" >&2; exit 4; }
( cd "$H/profiles/desktop" && exec pnpm add "$@" --save-exact --store-dir "$H/desktop/pnpm/store" ) > "$D/sideload-pnpm.log" 2>&1 < /dev/null &
PNPM=$!
for _ in $(seq 1 150); do grep -q "Done in" "$D/sideload-pnpm.log" 2>/dev/null && break; kill -0 "$PNPM" 2>/dev/null || break; sleep 1; done
sleep 5
# Stop only the pnpm this script started if it printed Done but did not exit.
kill -0 "$PNPM" 2>/dev/null && kill "$PNPM" 2>/dev/null || true
NAMES=()
for tgz in "$@"; do NAMES+=("$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')"); done
for name in "${NAMES[@]}"; do [ -d "$H/profiles/desktop/node_modules/$name" ] || { echo "sideload missing $name" >&2; tail -5 "$D/sideload-pnpm.log" >&2; exit 5; }; done
node -e '
const fs = require("fs"); const [file, ...names] = process.argv.slice(1)
const m = JSON.parse(fs.readFileSync(file, "utf8")); const b = m.dsh.profile.bundles
for (const n of names) if (!b.includes(n)) b.push(n)
fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n")
' "$H/profiles/desktop/package.json" "${NAMES[@]}"
for tgz in "$@"; do
  name="$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')"
  cmp -s <(tar -xzOf "$tgz" package/package.json) "$H/profiles/desktop/node_modules/$name/package.json" || { echo "installed $name differs from $tgz" >&2; exit 6; }
done
mkdir -p "$H/.agent-presets" && cp -R "$WEBHOME/.agent-presets/audio-no-tools" "$H/.agent-presets/"
cp "$WEBHOME/settings.yaml" "$H/settings.yaml"
if [ "$REWRITE" != "-" ]; then
  IFS=',' read -ra PAIRS <<< "$REWRITE"
  for pair in "${PAIRS[@]}"; do sed -i '' "s/127.0.0.1:${pair%%:*}/127.0.0.1:${pair##*:}/g" "$H/settings.yaml"; done
fi
(cd "$D" && shasum -a 256 "$@" > installed-sha256.txt)
echo "desktop home ready: $H (${NAMES[*]})"
