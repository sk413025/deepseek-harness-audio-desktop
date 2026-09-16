#!/usr/bin/env bash
# Isolated Harness Web home for the playback-ACK / slow-resume E2E (dsh-voice-capture 0.3.3 and the 0.3.2 negative control),
# on the FROZEN dsh-dgx-audio 0.4.7 test-only transport drop (TASK_CONTRACT §K.12). Same route shape as release's
# a3-desktop/live-resume-mock resume-ok-slow case: one chat opener and one native-duplex realtime model on the stream
# lane's MiniCPM-o realtime mock (run it with MOCK_RESUME_DELAY_MS=2000), transport drop after the first reply audio.
# The 0.4.0 base routes stay (setup-040-home.sh). Loopback mocks only.
# Usage: setup-033-ack-home.sh <scratch-dir> <voice-capture.tgz> <host.tgz> <library.tgz|-> <e2e-activation.tgz> <mock-040-port> <realtime-mock-port>
set -euo pipefail
SCRATCH="$1"; VOICE_TGZ="$2"; HOST_TGZ="$3"; LIBRARY_TGZ="$4"; ACTIVATION_TGZ="$5"; MOCK_PORT="$6"; RT_PORT="$7"
HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_ROOT="${DSH_ROOT:-$(cd "$HERE/../../.." && pwd)}"
bash "$HERE/setup-040-home.sh" "$SCRATCH" "$VOICE_TGZ" "$HOST_TGZ" "$LIBRARY_TGZ" "$ACTIVATION_TGZ" "$MOCK_PORT" > /dev/null
HOME_DIR="$SCRATCH/web home 錄音測試"
REF="$DSH_ROOT/parallel-work/streaming/i1/fixtures/minicpmo_system_ref_audio.wav"
[ -f "$REF" ] || { echo "missing $REF" >&2; exit 2; }
cat >> "$HOME_DIR/settings.yaml" <<YAML
    - provider: mock-live-resume
      displayName: MOCK realtime (loopback, not DGX)
      baseURL: http://127.0.0.1:${RT_PORT}/v1
      models:
        - id: mock-s2s
          name: MOCK chat (opener only)
          upstreamModel: openbmb/MiniCPM-o-4_5
          mode: chat
        - id: mock-duplex
          name: MOCK Live duplex
          upstreamModel: openbmb/MiniCPM-o-4_5
          mode: realtime
          realtime:
            path: /realtime
            inputEncoding: pcm16
            inputSampleRate: 16000
            frameMs: 200
            outputSampleRate: 24000
            query:
              duplex: "1"
              autostart: "0"
            session:
              extra_body:
                native_duplex: true
                auto_response: true
            refAudioFile: "${REF}"
            sessionIdPrefix: mic-ack-resume-mock-
  testFaults:
    transportDrop:
      model: mock-duplex
      occurrence: 1
      trigger: after-first-audio
      afterMs: 1500
      closeCode: 4003
      resume: normal
YAML
# NO_TEST_FAULTS=1: same routes without the injected transport drop (clean fixture-capture demos).
if [ "${NO_TEST_FAULTS:-0}" = 1 ]; then
  awk '/^  testFaults:$/{skip=1; next} skip && /^      resume: normal$/{skip=0; next} !skip' "$HOME_DIR/settings.yaml" > "$HOME_DIR/settings.yaml.tmp" && mv "$HOME_DIR/settings.yaml.tmp" "$HOME_DIR/settings.yaml"
fi
echo "home: $HOME_DIR"
