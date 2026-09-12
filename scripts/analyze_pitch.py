"""Measure pitch (F0) drift over time in a generated WAV — numpy only.

Usage:
  .venv python scripts/analyze_pitch.py <wav> [--bin 2]
Prints median F0 per time bin + overall slope. A rising slope = the model
output itself drifts (not a playback artifact).
"""
from __future__ import annotations

import argparse
import struct
import sys
import wave

import numpy as np


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        n, ch, width, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    fmt = {1: "b", 2: "h", 4: "i"}[width]
    a = np.array(struct.unpack(f"<{n * ch}{fmt}", raw), dtype=np.float64)
    a = a.reshape(-1, ch).mean(axis=1)
    a /= max(1e-9, np.abs(a).max())
    return a, sr


def f0_autocorr(x: np.ndarray, sr: int) -> float:
    """Median F0 over 100ms frames via autocorrelation, 50-500 Hz, voiced only."""
    fmin, fmax = 50.0, 500.0
    flen = sr // 10
    vals = []
    for start in range(0, len(x) - flen, flen):
        fr = x[start : start + flen] * np.hanning(flen)
        if np.abs(fr).max() < 0.02:  # silence
            continue
        ac = np.correlate(fr, fr, mode="full")[flen - 1 :]
        ac /= max(1e-9, ac[0])
        lo, hi = int(sr / fmax), int(sr / fmin)
        if hi >= len(ac):
            continue
        seg = ac[lo:hi]
        peak = int(np.argmax(seg)) + lo
        # peak must be prominent (voiced), else skip (unvoiced consonant)
        if ac[peak] < 0.35:
            continue
        vals.append(sr / peak)
    if not vals:
        return float("nan")
    return float(np.median(vals))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--bin", type=float, default=2.0)
    args = ap.parse_args()
    x, sr = read_wav(args.wav)
    dur = len(x) / sr
    print(f"file={args.wav} sr={sr} dur={dur:.1f}s")
    rows = []
    t = 0.0
    while t < dur:
        seg = x[int(t * sr) : int(min(dur, t + args.bin) * sr)]
        f0 = f0_autocorr(seg, sr)
        rows.append((t, f0))
        print(f"  {t:5.1f}s  F0={f0:7.1f} Hz")
        t += args.bin
    vals = np.array([f for _, f in rows if np.isfinite(f)])
    ts = np.array([t for t, f in rows if np.isfinite(f)])
    if len(vals) >= 3:
        slope = float(np.polyfit(ts, vals, 1)[0])
        print(f"trend: {slope:+.2f} Hz/sec  (first={vals[0]:.0f}Hz last={vals[-1]:.0f}Hz)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
