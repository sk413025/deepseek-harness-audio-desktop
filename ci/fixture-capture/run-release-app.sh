#!/bin/zsh
# CI runner for the microphone owner's fixture-capture harness 1.0.0 against the PUBLISHED release app.
# Same cases, scenario scripts, capture adapter, mocks, settings text and analysis as the owner's
# parallel-work/microphone-ui/e2e/run-fixture-desktop-demo.sh (vendored byte-identical under harness-1.0.0/). Only the
# steps that assume the local dev build are replaced:
#   - no sideload: the release app seeds its own plugins (profile desktop-audio) on first launch;
#   - settings/presets: the YAML bodies are read out of the owner's setup-040-home.sh / setup-033-ack-home.sh heredocs
#     (NO_TEST_FAULTS=1 filter applied exactly as the owner does) instead of running them (they need the dsh CLI);
#   - the realtime mock voice prompt: a public-domain ci-jfk clip instead of the unverified MiniCPM reference WAV;
#   - Node/Python come from the runner (setup-node / setup-python + pinned numpy/scipy/soundfile).
# Extra case (not in the owner runner): live-late-permission-dismiss via the owner's scenario-live-drain.mjs.
# capture=fixture (test-only MediaStream at getUserMedia), backend=mock. Never reaches a DGX.
# Usage: run-release-app.sh --app <.app bundle> --out <new dir> [--fixtures ci-jfk|tts-espeak]
set -euo pipefail
zmodload zsh/datetime
CI_DIR="${0:A:h}"
R="$CI_DIR/harness-1.0.0"
E2E="$R/parallel-work/microphone-ui/e2e"
APP_BUNDLE="" OUT="" SET=ci-jfk
while (( $# )); do
  case "$1" in
    --app) APP_BUNDLE="$2"; shift 2 ;; --out) OUT="$2"; shift 2 ;; --fixtures) SET="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -d "$APP_BUNDLE" ]] || { echo "missing --app bundle" >&2; exit 2; }
[[ -n "$OUT" && ! -e "$OUT" ]] || { echo "--out must be a new directory" >&2; exit 2; }
APP="$APP_BUNDLE/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$APP_BUNDLE/Contents/Info.plist")"
PYTHON="${PYTHON:-python3}"
"$PYTHON" -c 'import numpy, scipy, soundfile' || { echo "python needs numpy/scipy/soundfile" >&2; exit 2; }
FXD="$R/parallel-work/microphone-ui/fixtures/$SET"
mkdir -p "$OUT"
OUT="${OUT:A}"

# 1. Integrity: the owner hash list (minus the documented exclusion) and the fixture set.
(cd "$R" && grep -v 'minicpmo_system_ref_audio.wav' FIXTURE_CAPTURE_HARNESS_1.0.0.SHA256SUMS | shasum -a 256 -c - > "$OUT/harness-verify.txt") || { echo "harness checksum mismatch" >&2; exit 4; }
[[ "$(shasum -a 256 "$R/FIXTURE_CAPTURE_HARNESS_1.0.0.SHA256SUMS" | cut -d' ' -f1)" = 8a6b428b13a9a1fd401eeb6f8e4f2bbd673fddaa0f3af03105250da60dd03a3e ]] || { echo "owner hash list changed" >&2; exit 4; }
(cd "$FXD" && shasum -a 256 -c SHA256SUMS > "$OUT/fixtures-verify.txt") || { echo "fixture checksum mismatch" >&2; exit 4; }
"$PYTHON" "$R/parallel-work/microphone-ui/fixtures/test-analyze-capture.py" "$FXD" > "$OUT/analyzer-controls.log" 2>&1 || { tail -20 "$OUT/analyzer-controls.log" >&2; echo "analyzer controls failed" >&2; exit 4; }
SILENCE=$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["roles"]["silence"])' "$FXD/manifest.json")
REF="$R/parallel-work/microphone-ui/fixtures/ci-jfk/A.wav"   # public-domain voice prompt for the mock (it only checks a WAV data URL)
freeport() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})' }
CDP=$(freeport); MOCK=$(freeport)

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done }
trap cleanup EXIT

# 2. Mocks (owner commands).
MOCK_RESUME_DELAY_MS=2000 node "$R/parallel-work/streaming/i2/mock-minicpm-realtime.mjs" 0 > "$OUT/rtmock.out" 2>&1 < /dev/null &
PIDS+=($!)
for _ in {1..50}; do grep -q MOCK_LISTENING "$OUT/rtmock.out" 2>/dev/null && break; sleep 0.1; done
RT=$(grep -o 'MOCK_LISTENING http://127.0.0.1:[0-9]*' "$OUT/rtmock.out" | grep -o '[0-9]*$') || { echo "realtime mock did not start" >&2; exit 5; }
node "$E2E/mock-upstream-040.mjs" "$MOCK" "$OUT/upstream.jsonl" > "$OUT/upstream.out" 2>&1 < /dev/null &
PIDS+=($!)

# 3. Isolated home of the RELEASE app: first launch seeds profiles/desktop-audio from the app's own seed, then quit.
H="$OUT/home 家"; U="$OUT/userdata 使用者"; W="$OUT/workspace 工作區"
mkdir -p "$H" "$U" "$W"
DSH_HOME="$H" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$APP" --user-data-dir="$U" --remote-debugging-port="$CDP" > "$OUT/app-first-launch.log" 2>&1 < /dev/null &
FIRST=$!
for _ in {1..300}; do [[ -f "$H/profiles/desktop-audio/package.json" ]] && curl -s "http://127.0.0.1:$CDP/json" 2>/dev/null | grep -q "dsh-app://" && break; sleep 1; done
[[ -f "$H/profiles/desktop-audio/package.json" ]] || { echo "release app did not seed profiles/desktop-audio" >&2; exit 5; }
kill "$FIRST" 2>/dev/null || true
for _ in {1..30}; do kill -0 "$FIRST" 2>/dev/null || break; sleep 1; done
kill -9 "$FIRST" 2>/dev/null || true

# 4. Settings and preset: the owner's YAML heredoc bodies, variables substituted, NO_TEST_FAULTS filter as the owner applies it.
heredoc() { awk -v start="$2" 'index($0, start) { f = 1; next } f && /^YAML$/ { exit } f' "$1" }
export MOCK_PORT="$MOCK" RT_PORT="$RT" REF
subst() { perl -pe 's/\$\{MOCK_PORT\}/$ENV{MOCK_PORT}/g; s/\$\{RT_PORT\}/$ENV{RT_PORT}/g; s/\$\{REF\}/$ENV{REF}/g' }
{ heredoc "$E2E/setup-040-home.sh" 'cat > "$HOME_DIR/settings.yaml" <<YAML'; heredoc "$E2E/setup-033-ack-home.sh" 'cat >> "$HOME_DIR/settings.yaml" <<YAML'; } | subst > "$OUT/settings.raw.yaml"
awk '/^  testFaults:$/{skip=1; next} skip && /^      resume: normal$/{skip=0; next} !skip' "$OUT/settings.raw.yaml" > "$H/settings.yaml"
grep -q 'provider: mock-live-resume' "$H/settings.yaml" && grep -q 'provider: dgx-e2e' "$H/settings.yaml" && ! grep -q testFaults "$H/settings.yaml" || { echo "settings extraction failed" >&2; exit 5; }
mkdir -p "$H/.agent-presets/audio-no-tools"
heredoc "$E2E/setup-040-home.sh" 'cat > "$HOME_DIR/.agent-presets/audio-no-tools/preset.yml" <<'"'"'YAML'"'"'' > "$H/.agent-presets/audio-no-tools/preset.yml"
heredoc "$E2E/setup-040-home.sh" 'cat > "$HOME_DIR/.agent-presets/audio-no-tools/agent.cordis.yml" <<'"'"'YAML'"'"'' > "$H/.agent-presets/audio-no-tools/agent.cordis.yml"
[[ -s "$H/.agent-presets/audio-no-tools/preset.yml" && -s "$H/.agent-presets/audio-no-tools/agent.cordis.yml" ]] || { echo "preset extraction failed" >&2; exit 5; }

# 5. Bindings: app, installed plugins (from the release seed, as installed), mocks, fixtures, harness.
{
  echo "# app"; shasum -a 256 "$APP" "$APP_BUNDLE/Contents/Resources/app.asar" | sed "s#$APP_BUNDLE/##"
  echo "# installed plugins (release seed files)"; (cd "$APP_BUNDLE/Contents/Resources/seed/desktop-local-packages" && shasum -a 256 *.tgz)
  echo "# installed package.json versions"; for d in "$H/profiles/desktop-audio/node_modules/dsh-"*; do node -p "const p=require(process.argv[1]); p.name+'@'+p.version" "$d/package.json"; done
  echo "# mocks"; (cd "$R" && shasum -a 256 parallel-work/streaming/i2/mock-minicpm-realtime.mjs parallel-work/microphone-ui/e2e/mock-upstream-040.mjs)
  echo "# fixtures ($SET)"; shasum -a 256 "$FXD/manifest.json" | sed "s#$R/##"
  echo "# harness hash list"; shasum -a 256 "$R/FIXTURE_CAPTURE_HARNESS_1.0.0.SHA256SUMS" | sed "s#$R/##"
} > "$OUT/installed-sha256.txt"

# 6. Launch the release app on the prepared home and seed one session (owner command).
DSH_HOME="$H" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$APP" --user-data-dir="$U" --remote-debugging-port="$CDP" > "$OUT/app-stdout.log" 2>&1 < /dev/null &
APP_PID=$!
PIDS+=($APP_PID)
for _ in {1..120}; do curl -s "http://127.0.0.1:$CDP/json" 2>/dev/null | grep -q "dsh-app://" && break; sleep 1; done
for _ in {1..60}; do n=$(node "$E2E/probe.mjs" "$CDP" "(window.__DSH_BOOT__?.entries ?? []).length" 2>/dev/null || echo 0); [[ "${n:-0}" -gt 0 ]] 2>/dev/null && break; sleep 2; done
SEED=$(cd "$E2E" && SEED_PROVIDER=dgx-e2e SEED_MODEL=omni-speech node seed-session.mjs "$CDP" dsh-app://app/index.html - "$W" 2>&1 | tail -1)
echo "$SEED" > "$OUT/seed.json"
echo "$SEED" | grep -q sessionId || { echo "session seed failed: $SEED" >&2; exit 6; }
sleep 3

# 7. The owner's four cases, same arguments as run-fixture-desktop-demo.sh.
COMMON='"selectProvider":"mock-live-resume","selectModel":"mock-s2s","backend":"mock","restart":true'
STATUS=0
(cd "$E2E" && node scenario-fixture-duplex.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/overlap-abc" mock-duplex "$FXD" "{\"mode\":\"overlap\",\"interrupt\":false,$COMMON}") | tee "$OUT/overlap-abc.log" || STATUS=1
(cd "$E2E" && node scenario-fixture-duplex.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/timeline-interrupt" mock-duplex "$FXD" "{\"mode\":\"timeline\",\"interrupt\":true,$COMMON}") | tee "$OUT/timeline-interrupt.log" || STATUS=1
(cd "$E2E" && node scenario-fixture-mimo.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/turn-record-send" "$FXD" "$H/dsh-dgx-audio/outputs/invocations.jsonl" "$R/parallel-work/streaming/focused-demo/audio-stream-verdict.mjs" '{"selectProvider":"dgx-e2e","selectModel":"omni-speech","backend":"mock"}') | tee "$OUT/turn-record-send.log" || STATUS=1
(cd "$E2E" && node scenario-fixture-duplex.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/negative-silent-input" mock-duplex "$FXD" "{\"mode\":\"timeline\",\"timeline\":\"$SILENCE\",\"interrupt\":false,\"restart\":false,\"tailMs\":6000,\"selectProvider\":\"mock-live-resume\",\"selectModel\":\"mock-s2s\",\"backend\":\"mock\"}") | tee "$OUT/negative-silent-input.log" || STATUS=1

# 8. The owner's analysis/summary (the PY heredoc of run-fixture-desktop-demo.sh, extracted verbatim).
awk "/<<'PY' \\|\\| STATUS=1\$/ { f = 1; next } f && /^PY\$/ { exit } f" "$E2E/run-fixture-desktop-demo.sh" > "$OUT/owner-summary.py"
[[ -s "$OUT/owner-summary.py" ]] || { echo "summary extraction failed" >&2; exit 7; }
shasum -a 256 "$OUT/owner-summary.py" >> "$OUT/installed-sha256.txt"
"$PYTHON" "$OUT/owner-summary.py" "$OUT" "$FXD" "$R/parallel-work/microphone-ui/fixtures/analyze-capture.py" > "$OUT/summary.stdout" 2>&1 || STATUS=1

# 9. A6 in the packaged app: first getUserMedia answered 17 s after the Live click (simulated permission wait at the
# getUserMedia boundary — not the macOS TCC prompt), Live panel Dismiss attempted at 16 s (owner's DEMO3 sequence).
(cd "$E2E" && node scenario-live-drain.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/live-late-permission-dismiss" "$R/parallel-work/microphone-ui/fixtures/$SET/$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["roles"]["A"])' "$FXD/manifest.json")" mock-duplex '{"gumDelayMs":17000,"dismissAtMs":16000,"sampleMs":36000,"stopOnEnd":false,"selectProvider":"mock-live-resume","selectModel":"mock-s2s"}') > "$OUT/live-late-permission-dismiss.log" 2>&1 || true

kill "$APP_PID" 2>/dev/null || true
for _ in {1..30}; do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
exit $STATUS
