#!/usr/bin/env python3
"""Build the redistributable interim CI fixture set ONCE from the public-domain JFK clip (no TTS).

Source: whisper.cpp samples/jfk.wav (sha256 59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e, 16 kHz mono,
11.0 s), identical bytes to parallel-work/streaming/i1/fixtures/jfk-public-domain-16k.wav. Recording: John F. Kennedy's
inaugural address, 20 January 1961, a work of the US federal government (public domain in the US, 17 U.S.C. §105).
Cut points are energy minima between phrases (10 ms RMS, 150 ms smoothing); transcripts per phrase are the known text
split at those pauses. Output: 16 kHz mono PCM16 (the source rate; no resampling).

Usage: make-ci-fixtures-jfk.py <source.wav> <out-dir>   (refuses to overwrite an existing manifest)
"""
import hashlib, json, os, platform, sys
from datetime import datetime, timezone

import numpy as np
import soundfile as sf

SOURCE_SHA = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e"
CUTS = {  # name: (start s, end s, transcript)
    "A": (0.30, 2.20, "And so, my fellow Americans,"),
    "B": (3.30, 7.55, "ask not what your country can do for you,"),
    "C": (8.05, 10.80, "ask what you can do for your country."),
}
TIMELINES = {
    # Full-duplex fixed timeline for the loopback mock: B starts while A's mock reply is sounding; C after it.
    "timeline-abc-mock-timing": [("s", 0.5), ("u", "A"), ("s", 2.5), ("u", "B"), ("s", 5.0), ("u", "C"), ("s", 4.0)],
    # Turn-based record → stop → send question (whole clip).
    "turn-question": [("s", 0.5), ("full", None), ("s", 1.0)],
    "silence-3s": [("s", 3.0)],
}


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def describe(path, rate):
    data, _ = sf.read(path, dtype="int16")
    return {"file": os.path.basename(path), "sha256": sha256(path), "bytes": os.path.getsize(path), "sampleRate": rate, "channels": 1, "sampleFormat": "PCM_S16LE",
            "frames": len(data), "durationSec": round(len(data) / rate, 4), "peak": int(np.abs(data.astype(np.int32)).max()) if len(data) else 0}


def main(source, out):
    if sha256(source) != SOURCE_SHA:
        sys.exit("source sha256 mismatch")
    os.makedirs(out, exist_ok=True)
    manifest_path = os.path.join(out, "manifest.json")
    if os.path.exists(manifest_path):
        sys.exit("refusing to regenerate: manifest exists")
    data, rate = sf.read(source, dtype="int16")
    files = []
    clips = {}
    for name, (a, b, text) in CUTS.items():
        clip = data[int(a * rate): int(b * rate)]
        clips[name] = clip
        path = os.path.join(out, f"{name}.wav")
        sf.write(path, clip, rate, subtype="PCM_16")
        files.append({**describe(path, rate), "kind": "utterance", "transcript": text, "source": {"startSec": a, "endSec": b}})
    for name, parts in TIMELINES.items():
        blocks, segments, cursor = [], [], 0
        for kind, value in parts:
            block = np.zeros(int(round(value * rate)), dtype=np.int16) if kind == "s" else (data if kind == "full" else clips[value])
            seg = {"startSec": round(cursor / rate, 4), "endSec": round((cursor + len(block)) / rate, 4)}
            if kind == "s":
                seg["silenceSec"] = value
            elif kind == "full":
                seg.update({"utterance": "full-clip", "transcript": " ".join(t for _, _, t in CUTS.values())})
            else:
                seg.update({"utterance": value, "transcript": CUTS[value][2]})
            segments.append(seg)
            blocks.append(block)
            cursor += len(block)
        path = os.path.join(out, f"{name}.wav")
        sf.write(path, np.concatenate(blocks), rate, subtype="PCM_16")
        files.append({**describe(path, rate), "kind": "timeline", "segments": segments, "transcript": " ".join(s["transcript"] for s in segments if "transcript" in s)})
    manifest = {
        "schema": "dsh-audio-fixtures@1",
        "set": "ci-jfk (interim redistributable CI fixtures; replaced by a redistributable TTS set later)",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": {"script": "parallel-work/microphone-ui/fixtures/ci-jfk/make-ci-fixtures-jfk.py", "scriptSha256": sha256(__file__), "tts": None,
                      "python": platform.python_version(), "numpy": np.__version__, "soundfile": sf.__version__,
                      "method": "cut at energy minima between phrases; exact zero silences; no resampling"},
        "source": {"file": "jfk-public-domain-16k.wav", "sha256": SOURCE_SHA, "sampleRate": rate, "durationSec": round(len(data) / rate, 3),
                   "upstream": "https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav", "upstreamSha256Verified": "2026-09-15 (identical sha256)",
                   "upstreamRepoLicense": "MIT (whisper.cpp)"},
        "license": {"redistributable": True, "status": "REDISTRIBUTABLE",
                    "basis": "Recording of John F. Kennedy's inaugural address (1961-01-20), a work of the US federal government: public domain in the US (17 U.S.C. §105). The file is distributed in the MIT-licensed whisper.cpp repository.",
                    "note": "Keep this provenance block with the files."},
        "roles": {"A": "A.wav", "B": "B.wav", "C": "C.wav", "timeline": "timeline-abc-mock-timing.wav", "turn": "turn-question.wav", "silence": "silence-3s.wav"},
        "regeneratePolicy": "generated once; CI verifies sha256 and never regenerates",
        "files": files,
    }
    json.dump(manifest, open(manifest_path, "w"), indent=2)
    with open(os.path.join(out, "SHA256SUMS"), "w") as f:
        for e in files:
            f.write(f"{e['sha256']}  {e['file']}\n")
    print(json.dumps([{k: e[k] for k in ("file", "durationSec", "sha256")} for e in files], indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
