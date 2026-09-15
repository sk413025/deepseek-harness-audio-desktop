#!/bin/zsh
# Reproducible packaged-Desktop fixture-capture demo (AUDIO_TEST_LAYERING_20260915.md): MiniCPM-style full-duplex Live on
# deterministic loopback mocks, capture=fixture (test-only MediaStream at getUserMedia), backend=mock.
# Runs two cases through the actual app and installed plugins, clicking the real Live / Interrupt / End controls:
#   overlap-abc        A, then B once A's reply is sounding (output clock), then C   → C0 C1 O1 S1 P1 E1
#   timeline-interrupt fixed timeline A–B–C with Interrupt during a sounding reply     → C0 C1 O1 S1 P1 I1 E1
#   negative-silent-input silence only: frames flow (C0 PASS) but O1/S1 must FAIL (negative control)
# then compares the host-received live input WAV with the fixture (analyze-capture.py) and writes summary.json.
# Fail-fast: any setup step failing exits non-zero; the app instance and mocks started here are stopped on exit.
#
# Usage: run-fixture-desktop-demo.sh --app <app executable> --voice <dsh-voice-capture.tgz> --host <dsh-dgx-audio.tgz>
#          --library <dsh-audio-model-library.tgz> --out <new empty dir> [--fixtures <fixture set dir>] [--cdp 9420] [--mock-port 18980]
#   --fixtures default: parallel-work/microphone-ui/fixtures/ci-jfk (redistributable); files are chosen by manifest roles.
# The app must be a packaged DeepSeek Harness build whose Desktop profile is profiles/desktop (plugins are sideloaded into
# an isolated home; the user's profile is never touched). Nothing here reaches a DGX.
set -euo pipefail
zmodload zsh/datetime
HERE="${0:A:h}"
R="${HERE:h:h:h}"
APP="" VOICE="" HOST="" LIBRARY="" OUT="" FIXTURES="" CDP=9420 MOCK=18980
while (( $# )); do
  case "$1" in
    --app) APP="$2"; shift 2 ;; --voice) VOICE="$2"; shift 2 ;; --host) HOST="$2"; shift 2 ;; --library) LIBRARY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;; --fixtures) FIXTURES="$2"; shift 2 ;; --cdp) CDP="$2"; shift 2 ;; --mock-port) MOCK="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
for v in APP VOICE HOST LIBRARY OUT; do [[ -n "${(P)v}" ]] || { echo "missing --${(L)v}" >&2; exit 2; }; done
[[ -x "$APP" ]] || { echo "app executable not found: $APP" >&2; exit 2; }
for f in "$VOICE" "$HOST" "$LIBRARY"; do [[ -f "$f" ]] || { echo "missing package $f" >&2; exit 2; }; done
[[ ! -e "$OUT" ]] || { echo "refusing to reuse existing output dir $OUT" >&2; exit 2; }
lsof -nP -iTCP:"$CDP" -sTCP:LISTEN >/dev/null 2>&1 && { echo "CDP port $CDP busy" >&2; exit 3; }
lsof -nP -iTCP:"$MOCK" -sTCP:LISTEN >/dev/null 2>&1 && { echo "mock port $MOCK busy" >&2; exit 3; }
export PATH="$R/.tools/node/bin:$PATH"
# Analysis needs Python 3 with numpy, scipy and soundfile (set PYTHON to choose the interpreter).
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then for c in python3 /opt/anaconda3/bin/python3 /opt/homebrew/bin/python3; do command -v "$c" >/dev/null 2>&1 && "$c" -c 'import numpy, scipy, soundfile' 2>/dev/null && { PYTHON="$c"; break; }; done; fi
[[ -n "$PYTHON" ]] || { echo "no python3 with numpy/scipy/soundfile (set PYTHON)" >&2; exit 2; }
FXD="${FIXTURES:-$R/parallel-work/microphone-ui/fixtures/ci-jfk}"
[[ -f "$FXD/manifest.json" ]] || { echo "fixture set without manifest.json: $FXD" >&2; exit 2; }
SILENCE=$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["roles"]["silence"])' "$FXD/manifest.json")
ACT="$HERE/pkgs/dsh-e2e-activation-0.0.1.tgz"
RTMOCK="$R/parallel-work/streaming/i2/mock-minicpm-realtime.mjs"
(cd "$FXD" && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "fixture checksum mismatch" >&2; exit 4; }
(cd "$HERE/pkgs" && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "activation package checksum mismatch" >&2; exit 4; }
mkdir -p "$OUT/template" && cp "$VOICE" "$HOST" "$LIBRARY" "$ACT" "$OUT/"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done }
trap cleanup EXIT
MOCK_RESUME_DELAY_MS=2000 node "$RTMOCK" 0 > "$OUT/rtmock.out" 2>&1 < /dev/null &
PIDS+=($!)
for _ in {1..50}; do grep -q MOCK_LISTENING "$OUT/rtmock.out" 2>/dev/null && break; sleep 0.1; done
RT=$(grep -o 'MOCK_LISTENING http://127.0.0.1:[0-9]*' "$OUT/rtmock.out" | grep -o '[0-9]*$') || { echo "realtime mock did not start" >&2; exit 5; }
NO_TEST_FAULTS=1 bash "$HERE/setup-033-ack-home.sh" "$OUT/template" "$OUT/${VOICE:t}" "$OUT/${HOST:t}" "$OUT/${LIBRARY:t}" "$OUT/${ACT:t}" "$MOCK" "$RT" > "$OUT/template.log" 2>&1 || { tail -5 "$OUT/template.log" >&2; exit 5; }
DSH_DESKTOP_APP="$APP" bash "$HERE/setup-desktop-home.sh" "$OUT" "$CDP" "$OUT/template/web home 錄音測試" - "$OUT/${VOICE:t}" "$OUT/${HOST:t}" "$OUT/${LIBRARY:t}" "$OUT/${ACT:t}" > "$OUT/setup.log" 2>&1 || { tail -5 "$OUT/setup.log" >&2; exit 5; }
(cd "$OUT" && shasum -a 256 *.tgz > installed-sha256.txt && shasum -a 256 "$APP" "$RTMOCK" | sed "s#$R/##" >> installed-sha256.txt)
node "$HERE/mock-upstream-040.mjs" "$MOCK" "$OUT/upstream.jsonl" > "$OUT/upstream.out" 2>&1 < /dev/null &
PIDS+=($!)
DSH_HOME="$OUT/home 家" "$APP" --user-data-dir="$OUT/userdata 使用者" --remote-debugging-port="$CDP" > "$OUT/app-stdout.log" 2>&1 < /dev/null &
APP_PID=$!
PIDS+=($APP_PID)
for _ in {1..60}; do curl -s "http://127.0.0.1:$CDP/json" 2>/dev/null | grep -q "dsh-app://" && break; sleep 1; done
for _ in {1..30}; do n=$(node "$HERE/probe.mjs" "$CDP" "(window.__DSH_BOOT__?.entries ?? []).length" 2>/dev/null || echo 0); [[ "${n:-0}" -gt 0 ]] 2>/dev/null && break; sleep 2; done
SEED=$(cd "$HERE" && SEED_PROVIDER=dgx-e2e SEED_MODEL=omni-speech node seed-session.mjs "$CDP" dsh-app://app/index.html - "$OUT/workspace 工作區" 2>&1 | tail -1)
echo "$SEED" | grep -q sessionId || { echo "session seed failed: $SEED" >&2; exit 6; }
sleep 3
COMMON='"selectProvider":"mock-live-resume","selectModel":"mock-s2s","backend":"mock","restart":true'
STATUS=0
(cd "$HERE" && node scenario-fixture-duplex.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/overlap-abc" mock-duplex "$FXD" "{\"mode\":\"overlap\",\"interrupt\":false,$COMMON}") | tee "$OUT/overlap-abc.log" || STATUS=1
(cd "$HERE" && node scenario-fixture-duplex.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/timeline-interrupt" mock-duplex "$FXD" "{\"mode\":\"timeline\",\"interrupt\":true,$COMMON}") | tee "$OUT/timeline-interrupt.log" || STATUS=1
# Turn-based spoken chat (MiMo-style): record → stop → send, progressive reply output, Stop inside a sounding buffer.
(cd "$HERE" && node scenario-fixture-mimo.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/turn-record-send" "$FXD" "$OUT/home 家/dsh-dgx-audio/outputs/invocations.jsonl" "$R/parallel-work/streaming/focused-demo/audio-stream-verdict.mjs" '{"selectProvider":"dgx-e2e","selectModel":"omni-speech","backend":"mock"}') | tee "$OUT/turn-record-send.log" || STATUS=1
# Negative control (capture blocked/silent): frames still flow, but no reply may be claimed as output or overlap.
(cd "$HERE" && node scenario-fixture-duplex.mjs "$CDP" dsh-app://app/index.html "Mock reply" "$OUT/negative-silent-input" mock-duplex "$FXD" "{\"mode\":\"timeline\",\"timeline\":\"$SILENCE\",\"interrupt\":false,\"restart\":false,\"tailMs\":6000,\"selectProvider\":\"mock-live-resume\",\"selectModel\":\"mock-s2s\",\"backend\":\"mock\"}") | tee "$OUT/negative-silent-input.log" || STATUS=1
# Host-received live input vs fixture (the recording id of session 1 of each case names the WAV).
"$PYTHON" - "$OUT" "$FXD" "$R/parallel-work/microphone-ui/fixtures/analyze-capture.py" <<'PY' || STATUS=1
import base64, glob, json, os, subprocess, sys
import numpy as np, soundfile as sf
out, fxd, analyzer = sys.argv[1:]
summary = {"schema": "dsh-fixture-desktop-demo@1", "labels": {"capture": "fixture (test-only MediaStream injection at getUserMedia)", "backend": "mock"}, "cases": {}}
for case in ["overlap-abc", "timeline-interrupt"]:
    ev = json.load(open(os.path.join(out, case, "evidence.json")))
    rows = {r["id"]: r["result"] for r in ev["rows"]}
    L1 = next(r for r in ev["raw"]["requests"] if r["route"] == "live/open")["reply"]["liveId"]
    close = next(r for r in ev["raw"]["requests"] if r["route"] == "live/close" and r["liveId"] == L1)
    rid = close["reply"]["input"]["recordingId"]
    rel = base64.urlsafe_b64decode(rid.split(".", 1)[1] + "==").decode()
    wav = glob.glob(os.path.join(out, "home 家", "dsh-dgx-audio", "outputs", rel))[0]
    if case == "timeline-interrupt":
        ref = os.path.join(fxd, ev["fixture"]["files"]["T"]["file"])
    else:
        stream = [s for s in ev["raw"]["capture"]["streams"] if not s.get("warmup") and s["clips"]][0]
        t0 = stream["clips"][0]["scheduledStartEpoch"]
        loaded = [(sf.read(os.path.join(fxd, ev["fixture"]["files"][c["name"]]["file"]), dtype="int16"), (c["scheduledStartEpoch"] - t0) / 1000) for c in stream["clips"]]
        rate = loaded[0][0][1]
        total = int((max(o + len(d) / rate for (d, _), o in loaded) + 1) * rate)
        buf = np.zeros(total, dtype=np.int32)
        for (d, _), o in loaded:
            s = int(o * rate); buf[s:s + len(d)] += d
        ref = os.path.join(out, case, "reference-abc.wav")
        sf.write(ref, np.clip(buf, -32768, 32767).astype(np.int16), rate, subtype="PCM_16")
    res = json.loads(subprocess.run([sys.executable, analyzer, ref, wav, "--manifest", os.path.join(fxd, "manifest.json"), "--out", os.path.join(out, case, "capture-analysis.json"), "--label", f"{case}: host-received live input vs fixture"], capture_output=True, text=True, check=True).stdout)
    content = res["alignment"]["envelopeCorrelation"] is not None and res["alignment"]["envelopeCorrelation"] >= 0.9 and not res["dropouts"] and res["captured"]["clippedRatio"] == 0
    rows["C2"] = "PASS" if content else "FAIL"
    summary["cases"][case] = {"rows": rows, "hostInput": {"sha256": res["captured"]["sha256"], "envelopeCorrelation": res["alignment"]["envelopeCorrelation"], "dropouts": len(res["dropouts"]), "rmsDbfs": res["captured"]["rmsDbfs"]}}
turn = json.load(open(os.path.join(out, "turn-record-send", "evidence.json")))
turn_rows = {r["id"]: r["result"] for r in turn["rows"]}
req = [a for a in turn["m1"]["inputAudio"] if a["name"].startswith("recording-")][-1]
req_file = glob.glob(os.path.join(out, "home 家", "attachments", "v1", "file-objects", req["sha256"][:2], req["sha256"]))[0]
res = json.loads(subprocess.run([sys.executable, analyzer, os.path.join(fxd, turn["fixture"]["file"]), req_file, "--manifest", os.path.join(fxd, "manifest.json"), "--out", os.path.join(out, "turn-record-send", "capture-analysis-M1.json"), "--label", "turn: request audio recorded via Mic vs fixture"], capture_output=True, text=True, check=True).stdout)
turn_rows["C2"] = "PASS" if (res["alignment"]["envelopeCorrelation"] or 0) >= 0.9 and not res["dropouts"] and res["captured"]["clippedRatio"] == 0 else "FAIL"
summary["cases"]["turn-record-send"] = {"rows": turn_rows, "requestAudio": {"sha256": req["sha256"], "envelopeCorrelation": res["alignment"]["envelopeCorrelation"], "dropouts": len(res["dropouts"])}}
neg = json.load(open(os.path.join(out, "negative-silent-input", "evidence.json")))
neg_rows = {r["id"]: r["result"] for r in neg["rows"]}
summary["fixtureSet"] = {"dir": fxd, "manifestSha256": __import__("hashlib").sha256(open(os.path.join(fxd, "manifest.json"), "rb").read()).hexdigest(), "license": json.load(open(os.path.join(fxd, "manifest.json")))["license"]["status"]}
summary["negativeControl"] = {"case": "negative-silent-input (roles.silence)", "rows": neg_rows, "expected": {"C0": "PASS", "O1": "FAIL", "S1": "FAIL"},
                              "correct": neg_rows.get("C0") == "PASS" and neg_rows.get("O1") == "FAIL" and neg_rows.get("S1") == "FAIL"}
summary["pass"] = all(v in ("PASS", "NOT RUN") for c in summary["cases"].values() for v in c["rows"].values()) and summary["negativeControl"]["correct"]
json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=2)
print(json.dumps(summary, indent=2))
sys.exit(0 if summary["pass"] else 1)
PY
kill "$APP_PID" 2>/dev/null || true
for _ in {1..30}; do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
exit $STATUS
