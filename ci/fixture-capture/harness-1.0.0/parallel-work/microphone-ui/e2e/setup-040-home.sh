#!/usr/bin/env bash
# Isolated Harness Web home for task-UI interop with the FROZEN dsh-dgx-audio 0.4.0 package:
# dsh-voice-capture + dsh-dgx-audio 0.4.0 + dsh-audio-model-library (client service) + the TEST-ONLY
# e2e activation plugin, with every route pointed at the loopback mock-upstream-040.mjs.
# Usage: setup-040-home.sh <scratch-dir> <voice-capture.tgz> <host-0.4.0.tgz> <library.tgz|-> <e2e-activation.tgz> <mock-port>
set -euo pipefail
SCRATCH="$1"; VOICE_TGZ="$2"; HOST_TGZ="$3"; LIBRARY_TGZ="$4"; ACTIVATION_TGZ="$5"; MOCK_PORT="$6"
DSH_ROOT="${DSH_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
export PATH="$DSH_ROOT/.tools/node/bin:$PATH"
HOME_DIR="$SCRATCH/web home 錄音測試"
WORKSPACE="$SCRATCH/workspace 工作區"
OUTPUTS="$SCRATCH/adapter outputs 輸出"
mkdir -p "$HOME_DIR/.agent-presets/audio-no-tools" "$WORKSPACE" "$OUTPUTS"
export DSH_HOME="$HOME_DIR"
DSH=("node" "$DSH_ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js")
"${DSH[@]}" plugin --profile web add "$VOICE_TGZ"
"${DSH[@]}" plugin --profile web add "$HOST_TGZ"
[ "$LIBRARY_TGZ" = "-" ] || "${DSH[@]}" plugin --profile web add "$LIBRARY_TGZ"
"${DSH[@]}" plugin --profile web add "$ACTIVATION_TGZ"
cat > "$HOME_DIR/profiles/web/cordis.patch.yml" <<YAML
- id: dgx-audio
  config:
    outputDir: "${OUTPUTS}"
YAML
cat > "$HOME_DIR/.agent-presets/audio-no-tools/preset.yml" <<'YAML'
name: Audio (no tools)
description: E2E preset without tool plugins for audio adapter models.
YAML
cat > "$HOME_DIR/.agent-presets/audio-no-tools/agent.cordis.yml" <<'YAML'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful assistant.
    complete: true
    includeRuntimeContext: false
YAML
cat > "$HOME_DIR/settings.yaml" <<YAML
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: dgx-e2e
  model: omni-speech
dsh-dgx-audio:
  outputLink: api
  routes:
    - provider: dgx-e2e
      displayName: E2E loopback (mock)
      baseURL: http://127.0.0.1:${MOCK_PORT}/v1
      models:
        - id: omni-speech
          name: Mock spoken chat
          upstreamModel: mock-omni
          mode: chat
          outputAudio: true
          sendModalities: true
        - id: asr-verbose
          name: Mock ASR with timestamps
          upstreamModel: mock-asr
          mode: transcribe
          asr:
            responseFormat: verbose_json
        - id: tts-clone
          name: Mock voice clone
          upstreamModel: mock-tts-base
          mode: speech
          speech:
            taskType: Base
            refAudio: attachment
            refText: prompt-prefix
        - id: tts-custom
          name: Mock preset voice TTS
          upstreamModel: mock-tts-custom
          mode: speech
          streaming:
            audio: "off"
          speech:
            taskType: CustomVoice
            voice: vivian
        - id: rt-asr
          name: Mock realtime ASR
          upstreamModel: mock-rt-asr
          mode: realtime
          realtime:
            wire: vllm-asr
            query: {}
          capabilities:
            liveInput: true
        - id: rt-duplex-untested
          name: Mock duplex (not declared)
          upstreamModel: mock-duplex
          mode: realtime
        - id: tts-stream
          name: Mock streaming TTS input
          upstreamModel: mock-tts-stream
          mode: realtime
          realtime:
            wire: omni-speech-ws
            path: /audio/speech/stream
          capabilities:
            audioOutputStreaming: true
YAML
echo "home: $HOME_DIR"
