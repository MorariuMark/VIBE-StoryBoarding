"""Download Audio8 + STT models into <project>/models/ (project-local, nothing global).

Usage (with the project venv):
  server\\python\\.venv\\Scripts\\python server\\python\\download_models.py
  server\\python\\.venv\\Scripts\\python server\\python\\download_models.py --skip-stt
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / "models"
TTS_DIR = MODEL_ROOT / "audio8"
STT_DIR = MODEL_ROOT / "stt"
HF_CACHE = MODEL_ROOT / "hf-cache"

os.environ.setdefault("HF_HOME", str(HF_CACHE))
os.environ.setdefault("HF_HUB_CACHE", str(HF_CACHE / "hub"))

AUDIO8_ID = "Audio8/Audio8-TTS-Preview-0.6b"
STT_ID = "Systran/faster-whisper-small"
KOKORO_ID = "hexgrad/Kokoro-82M"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-stt", action="store_true")
    ap.add_argument("--skip-kokoro", action="store_true")
    args = ap.parse_args()
    from huggingface_hub import snapshot_download

    TTS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[models] Audio8 -> {TTS_DIR}", flush=True)
    snapshot_download(repo_id=AUDIO8_ID, local_dir=str(TTS_DIR))
    print("[models] Audio8 done", flush=True)
    if not args.skip_stt:
        STT_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[models] STT {STT_ID} -> {STT_DIR}", flush=True)
        snapshot_download(repo_id=STT_ID, local_dir=str(STT_DIR / "small"))
        print("[models] STT done", flush=True)
    if not args.skip_kokoro:
        # Kokoro weights + all voice files, pre-warmed into the project HF
        # cache (the server loads them from there — nothing global).
        print(f"[models] Kokoro {KOKORO_ID} -> HF cache", flush=True)
        snapshot_download(repo_id=KOKORO_ID)
        print("[models] Kokoro done", flush=True)
    # sizes
    total = sum(p.stat().st_size for p in MODEL_ROOT.rglob("*") if p.is_file()) / (1024**3)
    print(f"[models] total on disk: {total:.2f} GB under {MODEL_ROOT}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
