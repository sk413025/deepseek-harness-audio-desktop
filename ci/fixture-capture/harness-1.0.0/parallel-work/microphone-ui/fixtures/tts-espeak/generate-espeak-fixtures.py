#!/usr/bin/env python3
"""Generate the redistributable TTS fixture set ONCE with eSpeak NG (same utterances/timelines/roles as fixtures/tts).

Synthesizer: eSpeak NG 1.52.0 built from the official source tarball
https://github.com/espeak-ng/espeak-ng/archive/refs/tags/1.52.0.tar.gz (sha256 bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23),
voice en-us (built-in formant data), rate 150 wpm. Output resampled 22 050 → 48 000 Hz mono PCM16, trimmed, composed with exact
zero silences. Usage: generate-espeak-fixtures.py <espeak-ng binary> <espeak-ng-data dir> <out-dir>
"""
import hashlib, json, os, platform, subprocess, sys, tempfile
from datetime import datetime, timezone

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

RATE = 48000
VOICE, SPEED = "en-us", 150
TARBALL_SHA = "bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23"
UTTERANCES = {
    "utt-question": "What is the capital of France? Please answer in one short sentence.",
    "utt-followup": "And what is the capital of Japan?",
    "utt-long-request": "Please tell me a detailed story about a lighthouse keeper. Make it at least one minute long.",
    "utt-interrupt": "Stop. Please tell me one short fact about the ocean instead.",
}
COMPOSITES = {
    "silence-3s": [("silence", 3.0)],
    "turn-question": [("silence", 0.5), ("utt", "utt-question"), ("silence", 1.0)],
    "speech-pause-speech": [("silence", 0.5), ("utt", "utt-question"), ("silence", 2.0), ("utt", "utt-followup"), ("silence", 1.0)],
    "timeline-abc-mock-timing": [("silence", 0.5), ("utt", "utt-long-request"), ("silence", 2.5), ("utt", "utt-interrupt"), ("silence", 5.0), ("utt", "utt-question"), ("silence", 4.0)],
    "timeline-abc-real": [("silence", 0.5), ("utt", "utt-long-request"), ("silence", 7.0), ("utt", "utt-interrupt"), ("silence", 6.0)],
}


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def synth(binary, data_dir, text):
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "u.wav")
        subprocess.run([binary, "-v", VOICE, "-s", str(SPEED), "-w", wav, text], check=True, env={**os.environ, "ESPEAK_DATA_PATH": data_dir})
        x, r = sf.read(wav, dtype="float32")
    g = np.gcd(r, RATE)
    y = resample_poly(x, RATE // g, r // g)
    y = np.clip(np.round(y * 32767), -32768, 32767).astype(np.int16)
    idx = np.flatnonzero(np.abs(y.astype(np.int32)) > 64)
    return y if idx.size == 0 else y[max(0, idx[0] - int(0.02 * RATE)): idx[-1] + int(0.05 * RATE)]


def describe(path):
    d, r = sf.read(path, dtype="int16")
    return {"file": os.path.basename(path), "sha256": sha256(path), "bytes": os.path.getsize(path), "sampleRate": r, "channels": 1, "sampleFormat": "PCM_S16LE",
            "frames": len(d), "durationSec": round(len(d) / r, 4), "peak": int(np.abs(d.astype(np.int32)).max()) if len(d) else 0}


def main(binary, data_dir, out):
    os.makedirs(out, exist_ok=True)
    mpath = os.path.join(out, "manifest.json")
    if os.path.exists(mpath):
        sys.exit("refusing to regenerate: manifest exists")
    version = subprocess.run([binary, "--version"], capture_output=True, text=True, env={**os.environ, "ESPEAK_DATA_PATH": data_dir}).stdout.split("Data at")[0].strip()
    utt, files = {}, []
    for uid, text in UTTERANCES.items():
        utt[uid] = synth(binary, data_dir, text)
        p = os.path.join(out, f"{uid}.wav")
        sf.write(p, utt[uid], RATE, subtype="PCM_16")
        files.append({**describe(p), "kind": "utterance", "transcript": text})
    for cid, parts in COMPOSITES.items():
        blocks, segs, cur = [], [], 0
        for kind, value in parts:
            b = np.zeros(int(round(value * RATE)), dtype=np.int16) if kind == "silence" else utt[value]
            seg = {"startSec": round(cur / RATE, 4), "endSec": round((cur + len(b)) / RATE, 4)}
            seg.update({"silenceSec": value} if kind == "silence" else {"utterance": value, "transcript": UTTERANCES[value]})
            segs.append(seg); blocks.append(b); cur += len(b)
        p = os.path.join(out, f"{cid}.wav")
        sf.write(p, np.concatenate(blocks), RATE, subtype="PCM_16")
        files.append({**describe(p), "kind": "timeline", "segments": segs, "transcript": " ".join(s["transcript"] for s in segs if "transcript" in s)})
    manifest = {
        "schema": "dsh-audio-fixtures@1", "set": "tts-espeak (redistributable TTS fixtures)", "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": {"script": "parallel-work/microphone-ui/fixtures/tts-espeak/generate-espeak-fixtures.py", "scriptSha256": sha256(__file__), "tts": version, "voice": VOICE, "speedWpm": SPEED,
                      "source": {"tarball": "https://github.com/espeak-ng/espeak-ng/archive/refs/tags/1.52.0.tar.gz", "sha256": TARBALL_SHA, "build": "cmake, -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF -DUSE_ASYNC=OFF"},
                      "python": platform.python_version(), "numpy": np.__version__, "soundfile": sf.__version__, "resample": "scipy.signal.resample_poly 22050→48000"},
        "license": {"redistributable": True, "status": "REDISTRIBUTABLE (assessment)",
                    "basis": "Generated by eSpeak NG (GPL-3.0-or-later) with its built-in en-us formant voice; no MBROLA voices. Synthesized speech is program output, not a copy of the program; the GPL does not cover such output (GNU GPL FAQ). Provenance kept here; not legal advice.",
                    "program": "eSpeak NG 1.52.0, GPL-3.0-or-later"},
        "roles": {"A": "utt-long-request.wav", "B": "utt-interrupt.wav", "C": "utt-question.wav", "timeline": "timeline-abc-mock-timing.wav", "timelineReal": "timeline-abc-real.wav", "turn": "turn-question.wav", "silence": "silence-3s.wav"},
        "regeneratePolicy": "generated once; CI verifies sha256 and never regenerates",
        "files": files,
    }
    json.dump(manifest, open(mpath, "w"), indent=2)
    with open(os.path.join(out, "SHA256SUMS"), "w") as f:
        for e in files:
            f.write(f"{e['sha256']}  {e['file']}\n")
    print(json.dumps([{k: e[k] for k in ("file", "durationSec", "sha256")} for e in files], indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:4])
