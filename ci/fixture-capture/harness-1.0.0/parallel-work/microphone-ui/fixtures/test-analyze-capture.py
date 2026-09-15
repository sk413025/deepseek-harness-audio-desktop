#!/usr/bin/env python3
"""Controls for analyze-capture.py (real PCM checks): a clean 16 kHz copy of a fixture must report no dropouts, and the same
copy with a 100 ms digital gap inserted inside speech must report exactly that dropout; a silent capture must not align.
Usage: test-analyze-capture.py <fixture-set-dir>   (uses manifest roles.timeline). Exit 0 = all controls behave.
"""
import json, os, subprocess, sys, tempfile

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))


def analyze(ref, cap):
    out = subprocess.run([sys.executable, os.path.join(HERE, "analyze-capture.py"), ref, cap], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def main(folder):
    manifest = json.load(open(os.path.join(folder, "manifest.json")))
    name = manifest["roles"]["timeline"]
    entry = next(f for f in manifest["files"] if f["file"] == name)
    ref = os.path.join(folder, name)
    x, r = sf.read(ref, dtype="float32")
    y = resample_poly(x, 16000, r) if r != 16000 else x
    speech = next(s for s in entry["segments"] if "utterance" in s)
    mid = (speech["startSec"] + speech["endSec"]) / 2
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        clean = os.path.join(tmp, "clean.wav")
        sf.write(clean, np.concatenate([np.zeros(5600, dtype=np.float32), y]), 16000, subtype="PCM_16")  # 350 ms lead, like the host input
        gap = os.path.join(tmp, "gap.wav")
        z = np.concatenate([np.zeros(5600, dtype=np.float32), y])
        k = 5600 + int(mid * 16000)
        z[k:k + 1600] = 0.0
        sf.write(gap, z, 16000, subtype="PCM_16")
        silent = os.path.join(tmp, "silent.wav")
        sf.write(silent, np.zeros_like(z), 16000, subtype="PCM_16")
        a, b, c = analyze(ref, clean), analyze(ref, gap), analyze(ref, silent)
        results = {
            "clean": {"dropouts": len(a["dropouts"]), "envelopeCorrelation": a["alignment"]["envelopeCorrelation"]},
            "gap100msInsideSpeech": {"dropouts": b["dropouts"], "expectedStartSec": round((k) / 16000, 3)},
            "silent": {"envelopeCorrelation": c["alignment"]["envelopeCorrelation"], "rmsDbfs": c["captured"]["rmsDbfs"]},
        }
    ok = results["clean"]["dropouts"] == 0 and (results["clean"]["envelopeCorrelation"] or 0) >= 0.95 \
        and len(results["gap100msInsideSpeech"]["dropouts"]) == 1 and abs(results["gap100msInsideSpeech"]["dropouts"][0]["startSec"] - results["gap100msInsideSpeech"]["expectedStartSec"]) < 0.02 \
        and results["silent"]["envelopeCorrelation"] is None and results["silent"]["rmsDbfs"] is None
    print(json.dumps({"fixtureSet": folder, "timeline": name, "results": results, "pass": ok}, indent=2))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main(sys.argv[1])
