#!/usr/bin/env python3
"""Compare a captured recording with its fixture WAV (fixture-capture proof or speaker→microphone loopback).

Reports: lag (cross-correlation of 16 kHz mono signals and of their 20 ms RMS envelopes), normalized correlation peak,
durations, level (RMS/peak, dBFS), clipping ratio, dropouts (runs of digital silence inside the expected speech span),
per-segment speech energy, and frame RMS statistics. Acoustic recordings are not expected to be byte-identical.

Usage: analyze-capture.py <fixture.wav> <captured.wav> [--manifest manifest.json] [--out result.json] [--label text]
"""
import argparse, hashlib, json, os

import numpy as np
import soundfile as sf
from scipy.signal import correlate, resample_poly

RATE = 16000


def load(path):
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    g = np.gcd(rate, RATE)
    return (resample_poly(mono, RATE // g, rate // g).astype(np.float32) if rate != RATE else mono), rate, data.shape[1], data.shape[0]


def envelope(x, hop=320):
    n = len(x) // hop
    return np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1)) if n else np.zeros(0)


def best_lag(ref, sig):
    corr = correlate(sig - sig.mean(), ref - ref.mean(), mode="full", method="fft")
    lag = int(np.argmax(corr)) - (len(ref) - 1)
    return lag, corr


def dbfs(v):
    return None if v <= 0 else round(20 * np.log10(v), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fixture")
    ap.add_argument("captured")
    ap.add_argument("--manifest")
    ap.add_argument("--out")
    ap.add_argument("--label", default="")
    args = ap.parse_args()
    ref, ref_rate, ref_ch, ref_frames = load(args.fixture)
    sig, sig_rate, sig_ch, sig_frames = load(args.captured)
    # Envelope alignment first (robust to acoustic filtering), then sample lag refined around it.
    er, es = envelope(ref), envelope(sig)
    elag, ecorr = best_lag(er, es) if len(er) and len(es) else (0, np.zeros(1))
    lag, corr = best_lag(ref, sig)
    denom = np.linalg.norm(ref - ref.mean()) * np.linalg.norm(sig - sig.mean())
    peak_norm = float(np.max(corr) / denom) if denom > 0 else 0.0
    # Envelope correlation at the envelope lag.
    def aligned(a, b, k):
        if k >= 0:
            b = b[k:]
        else:
            a = a[-k:]
        n = min(len(a), len(b))
        return a[:n], b[:n]
    ea, eb = aligned(er, es, elag)
    env_corr = float(np.corrcoef(ea, eb)[0, 1]) if len(ea) > 10 and ea.std() > 0 and eb.std() > 0 else None
    sa, sb = aligned(ref, sig, elag * 320)
    sample_corr_at_env_lag = float(np.corrcoef(sa, sb)[0, 1]) if len(sa) > 100 and sa.std() > 0 and sb.std() > 0 else None
    raw, _ = sf.read(args.captured, dtype="int16", always_2d=True)
    clipped = float(np.mean(np.abs(raw.astype(np.int32)) >= 32767)) if raw.size else 0.0
    # Dropouts: runs of exact zeros ≥ 50 ms inside the span where the (aligned) fixture has speech.
    zero = (np.abs(sig) < 1e-6).astype(np.int8)
    runs, start = [], None
    for i, z in enumerate(zero):
        if z and start is None:
            start = i
        elif not z and start is not None:
            if i - start >= int(0.05 * RATE):
                runs.append((start, i))
            start = None
    # Only where the aligned fixture itself is not silent in that exact window (fixture silences and inter-word gaps are
    # digital zeros and are reproduced as zeros; they are not dropouts). Sample-level alignment at the envelope lag.
    # Precise sample lag when the waveform cross-correlation is strong, else the 20 ms envelope lag; only the central part
    # of each zero run is judged (15 ms guard per edge) so gap edges shifted by alignment/filtering are not counted.
    shift = lag if peak_norm >= 0.9 else elag * 320
    guard = int(0.015 * RATE)
    def fixture_speech(a, b):
        a, b = a + guard, b - guard
        if b <= a:
            return False
        seg = ref[max(0, a - shift): max(0, b - shift)]
        return seg.size > 0 and float(np.sqrt(np.mean(seg ** 2))) > 10 ** (-45 / 20)
    dropouts = [{"startSec": round(a / RATE, 3), "durSec": round((b - a) / RATE, 3)} for a, b in runs if fixture_speech(a, b)]
    segments = []
    if args.manifest:
        entry = next((e for e in json.load(open(args.manifest))["files"] if e["file"] == os.path.basename(args.fixture)), None)
        for seg in (entry or {}).get("segments", []):
            a, b = int(seg["startSec"] * RATE) + elag * 320, int(seg["endSec"] * RATE) + elag * 320
            part = sig[max(0, a): max(0, b)]
            segments.append({**({"utterance": seg["utterance"]} if "utterance" in seg else {"silenceSec": seg["silenceSec"]}),
                             "capturedRmsDbfs": dbfs(float(np.sqrt(np.mean(part ** 2)))) if part.size else None, "capturedSec": round(part.size / RATE, 3)})
    frame = 3200
    frames = [float(np.sqrt(np.mean(sig[i:i + frame] ** 2))) for i in range(0, len(sig) - frame + 1, frame)]
    result = {
        "label": args.label,
        "fixture": {"file": os.path.basename(args.fixture), "sha256": hashlib.sha256(open(args.fixture, "rb").read()).hexdigest(), "sampleRate": ref_rate, "channels": ref_ch, "durationSec": round(ref_frames / ref_rate, 3)},
        "captured": {"file": os.path.basename(args.captured), "sha256": hashlib.sha256(open(args.captured, "rb").read()).hexdigest(), "sampleRate": sig_rate, "channels": sig_ch, "durationSec": round(sig_frames / sig_rate, 3),
                     "rmsDbfs": dbfs(float(np.sqrt(np.mean(sig ** 2)))), "peakDbfs": dbfs(float(np.max(np.abs(sig)))) , "clippedRatio": round(clipped, 6)},
        "alignment": {"envelopeLagSec": round(elag * 320 / RATE, 3), "sampleLagSec": round(lag / RATE, 4), "envelopeCorrelation": None if env_corr is None else round(env_corr, 4),
                      "sampleCorrelationAtEnvelopeLag": None if sample_corr_at_env_lag is None else round(sample_corr_at_env_lag, 4), "normalizedXcorrPeak": round(peak_norm, 4)},
        "dropouts": dropouts,
        "dropoutRule": "zero run >= 50 ms in the capture whose aligned fixture window (15 ms guard per edge) is above -45 dBFS",
        "segments": segments,
        "frameRms200ms": {"count": len(frames), "over500int16": int(sum(1 for f in frames if f * 32768 > 500)), "maxInt16": int(max(frames) * 32768) if frames else 0},
    }
    text = json.dumps(result, indent=2)
    if args.out:
        open(args.out, "w").write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
