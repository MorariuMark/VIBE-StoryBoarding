"""Chained prosody test: chunk N uses chunk N-1's OUTPUT as its reference.

Compares boundary pitch jumps vs independent synthesis (the app's current way).
Usage: .venv python scripts/test_chaining.py
"""
from __future__ import annotations

import base64
import io
import json
import urllib.request
import wave

import numpy as np

URL = "http://127.0.0.1:8010/api/tts"
TEXTS = [
    "Welcome back to the channel. Today we are testing a brand new artificial intelligence model, and the results are genuinely surprising.",
    "The model handles coding tasks remarkably well. It writes clean functions, catches edge cases, and explains every step along the way.",
    "In our benchmarks it scored near the top of the intelligence index, beating several much larger and more expensive models.",
]


def post(payload: dict) -> tuple[np.ndarray, int]:
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        data = r.read()
    with wave.open(io.BytesIO(data), "rb") as w:
        n, ch, width, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float64).reshape(-1, ch).mean(axis=1)
    return a / max(1e-9, np.abs(a).max()), sr


def to_wav_b64(x: np.ndarray, sr: int) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return base64.b64encode(buf.getvalue()).decode()


def edge_f0(x: np.ndarray, sr: int, edge: str, secs: float = 1.5) -> float:
    seg = x[: int(secs * sr)] if edge == "start" else x[-int(secs * sr):]
    flen = sr // 10
    vals = []
    for s in range(0, len(seg) - flen, flen):
        fr = seg[s : s + flen] * np.hanning(flen)
        if np.abs(fr).max() < 0.02:
            continue
        ac = np.correlate(fr, fr, mode="full")[flen - 1 :]
        ac /= max(1e-9, ac[0])
        lo, hi = int(sr / 500), int(sr / 50)
        peak = int(np.argmax(ac[lo:hi])) + lo
        if ac[peak] < 0.35:
            continue
        vals.append(sr / peak)
    return float(np.median(vals)) if vals else float("nan")


prev_audio_b64, prev_text, prev_sr = None, None, 44100
for i, text in enumerate(TEXTS):
    payload = {"text": text, "language": "English", "temperature": 0.8,
               "top_p": 0.95, "top_k": 50, "max_new_tokens": 512}
    if prev_audio_b64 is None:
        payload["voice_name"] = "Mark"
        ref = "Mark"
    else:
        payload["reference_audio_b64"] = prev_audio_b64
        payload["reference_audio_mime"] = "audio/wav"
        payload["reference_text"] = prev_text
        ref = "prev-chunk"
    x, sr = post(payload)
    f_start, f_end = edge_f0(x, sr, "start"), edge_f0(x, sr, "end")
    print(f"chunk{i+1} ref={ref} dur={len(x)/sr:.1f}s start={f_start:.0f}Hz end={f_end:.0f}Hz", flush=True)
    prev_audio_b64, prev_text, prev_sr = to_wav_b64(x, sr), text, sr
print("DONE")
