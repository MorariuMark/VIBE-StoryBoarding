"""
Audio8 0.6B local GPU server — exposes Audio8/Audio8-TTS-Preview-0.6b to the
HandScribe voiceover panel over HTTP so generation runs on your CUDA GPU.

Everything lives INSIDE the project folder — nothing is installed globally:
  <project>/server/python/.venv/   Python venv (torch CUDA, transformers, …)
  <project>/models/audio8/         Audio8 checkpoint (downloaded once)
  <project>/models/hf-cache/       Hugging Face cache dir (env-redirected,
                                   incl. Kokoro-82M weights + voices)
  <project>/models/stt/            faster-whisper STT model (for auto-transcript)
  <project>/models/audio8/voices/  saved clone voices (wav + transcript json)

Why a server: Audio8 ships as PyTorch + Transformers custom code
(trust_remote_code=True, DualAR + neural codec). There is no browser/WebGPU
build and no q8 WebGPU artifact — the only ONNX release is CPU-only INT4.
This server is the supported GPU path: torch + CUDA (BF16 on Ampere+,
FP16 on older cards like GTX 16xx).

Setup (Windows, one time — everything project-local):
  scripts\\setup-audio8.bat        creates .venv, installs deps, downloads models
  scripts\\start-audio8.bat        starts this server with the local venv

API:
  GET  /health            -> {ok, device, cudaAvailable, dtype, model,
                             modelDirMB, sttDirMB, voicesMB, voicesCount,
                             sttModel, sttReady, error}
  POST /api/tts           -> WAV bytes (audio/wav)
    {text, language, temperature, top_p, top_k, max_new_tokens,
     reference_audio_b64?, reference_audio_mime?, reference_text?,
     voice_name? (saved voice in models/audio8/voices/)}
  POST /api/transcribe    -> {text}  (STT of a reference clip, auto-transcript)
    {audio_b64, audio_mime?, model? ("base"|"small")}
  GET  /api/voices        -> {voices: [{name, transcript, sizeBytes, created}]}
  POST /api/voices        -> {ok}  {name, transcript, audio_b64, audio_mime?}
  DELETE /api/voices?name=.. -> {ok}
  GET  /api/voices/audio?name=.. -> WAV bytes of a saved voice
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import os
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------- project dirs
ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / "models"
TTS_DIR = MODEL_ROOT / "audio8"
HF_CACHE = MODEL_ROOT / "hf-cache"
STT_DIR = MODEL_ROOT / "stt"
VOICES_DIR = TTS_DIR / "voices"

MODEL_ID = "Audio8/Audio8-TTS-Preview-0.6b"
STT_DEFAULT = "small"  # faster-whisper model kept in models/stt/

# Redirect every HF download into the project folder BEFORE any HF import.
os.environ.setdefault("HF_HOME", str(HF_CACHE))
os.environ.setdefault("HF_HUB_CACHE", str(HF_CACHE / "hub"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(HF_CACHE / "hub"))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(HF_CACHE / "hub"))

_state: dict = {
    "model": None,
    "processor": None,
    "device": "cpu",
    "dtype": "float32",
    "model_id": MODEL_ID,
    "model_dir": str(TTS_DIR),
    "error": None,
}
_stt: dict = {"model": None, "name": None, "error": None}
_lock = threading.Lock()
_stt_lock = threading.Lock()


def dir_mb(path: Path) -> float:
    total = 0
    try:
        for p in path.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return round(total / (1024 * 1024), 1)


def _cuda_info() -> tuple[bool, str]:
    """(cuda_available, dtype_name) — BF16 on Ampere+, else FP16."""
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return False, "float32"
        try:
            major, _ = torch.cuda.get_device_capability(0)
            return True, ("bfloat16" if major >= 8 else "float16")
        except Exception:
            return True, "float16"
    except Exception:
        return False, "float32"


def _load(model_id: str) -> None:
    """Import torch/transformers lazily so --help works without deps."""
    try:
        import torch  # type: ignore
        from transformers import AutoModel, AutoProcessor  # type: ignore
    except Exception as e:  # pragma: no cover
        _state["error"] = f"Deps missing in project venv (run scripts\\setup-audio8.bat): {e}"
        return
    try:
        cuda, dtype_name = _cuda_info()
        device = "cuda" if cuda else "cpu"
        dtype = getattr(torch, dtype_name if cuda else "float32")
        local_cfg = TTS_DIR / "config.json"
        src = str(TTS_DIR) if local_cfg.is_file() else model_id
        processor = AutoProcessor.from_pretrained(src, trust_remote_code=True)
        model = AutoModel.from_pretrained(src, trust_remote_code=True, dtype=dtype).eval().to(device)
        _state.update(
            {
                "model": model,
                "processor": processor,
                "device": device,
                "dtype": dtype_name if cuda else "float32",
                "model_id": model_id,
                "error": None,
            }
        )
        print(f"[audio8] ready: {model_id} from {src} on {device} ({_state['dtype']})", flush=True)
    except Exception as e:  # pragma: no cover
        _state["error"] = str(e)
        print(f"[audio8] load failed: {e}", flush=True)


def _safe_voice_name(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", (name or "").strip()).strip("-")[:48]
    if not slug:
        raise ValueError("voice name is empty")
    return slug


def _voice_paths(name: str) -> tuple[Path, Path]:
    slug = _safe_voice_name(name)
    return VOICES_DIR / f"{slug}.wav", VOICES_DIR / f"{slug}.json"


def _list_voices() -> list[dict]:
    out: list[dict] = []
    if not VOICES_DIR.is_dir():
        return out
    for meta in sorted(VOICES_DIR.glob("*.json")):
        wav = meta.with_suffix(".wav")
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            info = {}
        out.append(
            {
                "name": meta.stem,
                "transcript": str(info.get("transcript", "")),
                "sizeBytes": wav.stat().st_size if wav.is_file() else 0,
                "created": str(info.get("created", "")),
            }
        )
    return out


def _resolve_reference(payload: dict) -> tuple[str | None, str]:
    """Return (wav_path, transcript) for cloning — inline upload wins, else saved voice."""
    ref_b64 = payload.get("reference_audio_b64")
    ref_text = str(payload.get("reference_text", "")).strip()
    if ref_b64 and ref_text:
        return None, ""  # handled inline by caller via _inline_wav()
    voice_name = str(payload.get("voice_name", "") or "").strip()
    if voice_name:
        wav, meta = _voice_paths(voice_name)
        if not wav.is_file():
            raise ValueError(f"saved voice '{voice_name}' not found")
        try:
            transcript = str(json.loads(meta.read_text(encoding="utf-8")).get("transcript", "")).strip()
        except Exception:
            transcript = ""
        if not transcript:
            raise ValueError(f"saved voice '{voice_name}' has no transcript")
        return str(wav), transcript
    return None, ""


def _inline_wav(payload: dict) -> tuple[str | None, str]:
    ref_b64 = payload.get("reference_audio_b64")
    ref_text = str(payload.get("reference_text", "")).strip()
    if not (ref_b64 and ref_text):
        return None, ""
    raw = base64.b64decode(str(ref_b64))
    if len(raw) > 12 * 1024 * 1024:
        raise ValueError("reference clip too large (12MB max)")
    suffix = mimetypes.guess_extension(str(payload.get("reference_audio_mime", "audio/wav"))) or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(raw)
    tmp.close()
    return tmp.name, ref_text


def _synthesize(payload: dict) -> tuple[bytes, int]:
    import soundfile as sf  # type: ignore
    import torch  # type: ignore

    with _lock:
        model = _state["model"]
        processor = _state["processor"]
        device = _state["device"]
        if model is None or processor is None:
            raise RuntimeError(_state["error"] or "Model is still loading — retry in a few seconds.")
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ValueError("text is empty")
        language = str(payload.get("language", "English"))
        prompt = f"[{language}] {text}" if language and language != "English" else text
        kwargs: dict = {"text": [prompt], "return_tensors": "pt"}
        tmp_path, ref_text = _inline_wav(payload)
        try:
            if tmp_path:
                kwargs["reference_audio"] = [tmp_path]
                kwargs["reference_text"] = [ref_text]
            else:
                saved_wav, saved_text = _resolve_reference(payload)
                if saved_wav:
                    kwargs["reference_audio"] = [saved_wav]
                    kwargs["reference_text"] = [saved_text]
            inputs = processor(**kwargs)
            inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}
            gen = {
                "max_new_tokens": int(payload.get("max_new_tokens", 1024)),
                "temperature": float(payload.get("temperature", 0.8)),
                "top_p": float(payload.get("top_p", 0.95)),
                "top_k": int(payload.get("top_k", 50)),
                "do_sample": True,
                "return_dict_in_generate": True,
            }
            with torch.inference_mode():
                output = model.generate(**inputs, **gen)
                waveforms, lengths = model.decode_audio(output.codes)
            audio = waveforms[0, : int(lengths[0])].float().cpu().numpy()
            sr = int(getattr(model.config, "codec_sample_rate", 44100))
            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="WAV")
            return buf.getvalue(), sr
        finally:
            if tmp_path:
                try:
                    Path(tmp_path).unlink()
                except OSError:
                    pass


def _transcribe_bytes(raw: bytes, want: str) -> str:
    if want not in ("base", "small"):
        want = STT_DEFAULT
    with _stt_lock:
        if _stt["model"] is None or _stt["name"] != want:
            try:
                from faster_whisper import WhisperModel  # type: ignore
            except Exception as e:
                raise RuntimeError(f"STT deps missing in project venv (run scripts\\setup-audio8.bat): {e}")
            import torch  # type: ignore

            cuda = bool(torch.cuda.is_available())
            try:
                _stt["model"] = WhisperModel(
                    want,
                    device="cuda" if cuda else "cpu",
                    compute_type="float16" if cuda else "int8",
                    download_root=str(STT_DIR),
                )
                _stt["name"] = want
                _stt["error"] = None
            except Exception as e:
                _stt["error"] = str(e)
                raise RuntimeError(f"STT model load failed: {e}")
        model = _stt["model"]
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        try:
            tmp.write(raw)
            tmp.close()
            segments, _info = model.transcribe(tmp.name, beam_size=5)
            return " ".join(s.text.strip() for s in segments if s.text and s.text.strip()).strip()
        finally:
            try:
                Path(tmp.name).unlink()
            except OSError:
                pass


def _transcribe_segments(raw: bytes, want: str) -> list:
    """Transcribe and return per-segment spans for timeline sync.

    Each item: {"text": str, "start": float, "end": float} (seconds,
    audio-relative). Segment granularity suits sentence-level image
    sync — word timestamps cost more and drift harder.
    """
    if want not in ("base", "small"):
        want = STT_DEFAULT
    with _stt_lock:
        if _stt["model"] is None or _stt["name"] != want:
            try:
                from faster_whisper import WhisperModel  # type: ignore
            except Exception as e:
                raise RuntimeError(f"STT deps missing in project venv (run scripts\\setup-audio8.bat): {e}")
            import torch  # type: ignore

            cuda = bool(torch.cuda.is_available())
            try:
                _stt["model"] = WhisperModel(
                    want,
                    device="cuda" if cuda else "cpu",
                    compute_type="float16" if cuda else "int8",
                    download_root=str(STT_DIR),
                )
                _stt["name"] = want
                _stt["error"] = None
            except Exception as e:
                _stt["error"] = str(e)
                raise RuntimeError(f"STT model load failed: {e}")
        model = _stt["model"]
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        try:
            tmp.write(raw)
            tmp.close()
            segments, _info = model.transcribe(tmp.name, beam_size=5)
            out = []
            for s in segments:
                t = (s.text or "").strip()
                if not t:
                    continue
                out.append({"text": t, "start": float(s.start or 0), "end": float(s.end or 0)})
            return out
        finally:
            try:
                Path(tmp.name).unlink()
            except OSError:
                pass


def _transcribe(payload: dict) -> str:
    raw_b64 = str(payload.get("audio_b64", "") or "")
    if not raw_b64:
        raise ValueError("audio_b64 is empty")
    raw = base64.b64decode(raw_b64)
    if len(raw) > 25 * 1024 * 1024:
        raise ValueError("clip too large for transcription (25MB max)")
    want = str(payload.get("model", STT_DEFAULT) or STT_DEFAULT)
    return _transcribe_bytes(raw, want)


def _frame_f0(frame: "np.ndarray", sr: int) -> float | None:
    """Median-voiced F0 of one short frame via autocorrelation (50-500 Hz)."""
    import numpy as np

    if np.abs(frame).max() < 0.02:
        return None
    w = frame * np.hanning(len(frame))
    ac = np.correlate(w, w, mode="full")[len(w) - 1 :]
    if ac[0] <= 1e-9:
        return None
    ac = ac / ac[0]
    lo, hi = int(sr / 500), int(sr / 50)
    if hi >= len(ac):
        return None
    peak = int(np.argmax(ac[lo:hi])) + lo
    if ac[peak] < 0.35:
        return None
    return float(sr / peak)


def _steady_anchor(name: str, window_sec: float = 10.0) -> dict:
    """Carve the prosodically flattest window out of a saved voice and save it
    as `<name>-steady` (audio + fresh STT transcript).

    Why: every narration chunk re-anchors to its reference's OPENING pitch.
    A 40s excited opening (≈117 Hz here) makes each ~10s chunk start high and
    end low — an audible upward jump at every boundary, perceived as pitch
    rising over the narration. A short, flat anchor removes the sawtooth.
    """
    import numpy as np
    import soundfile as sf  # type: ignore

    wav, _meta = _voice_paths(name)
    if not wav.is_file():
        raise ValueError(f"saved voice '{name}' not found")
    window_sec = min(20.0, max(5.0, float(window_sec or 10.0)))
    x, sr = sf.read(str(wav), dtype="float32", always_2d=False)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    dur = len(x) / sr
    if dur < window_sec + 1:
        raise ValueError(f"clip is only {dur:.0f}s — a steady anchor needs >{window_sec + 1:.0f}s")
    step, flen = 0.5, int(sr * 0.5)
    grid: list[float | None] = []
    t = 0.0
    while t + 0.5 <= dur:
        grid.append(_frame_f0(np.asarray(x[int(t * sr) : int(t * sr) + flen]), sr))
        t += step
    voiced_all = [v for v in grid if v is not None]
    if not voiced_all:
        raise ValueError("no voiced speech found — use a cleaner clip")
    clip_median = float(np.median(voiced_all))
    win_frames = int(round(window_sec / step))
    best, best_key = 0.0, None
    for start in range(0, len(grid) - win_frames + 1):
        seg = [v for v in grid[start : start + win_frames] if v is not None]
        if len(seg) < int(win_frames * 0.6):
            continue
        # flat AND near the clip's overall median pitch: a high/excited opening
        # biases every chunk start upward, which is the sawtooth we remove.
        key = (float(np.std(seg)) + 0.5 * abs(float(np.mean(seg)) - clip_median))
        if best_key is None or key < best_key:
            best_key, best = key, start * step
    if best_key is None:
        raise ValueError("no clean voiced passage found — use a cleaner clip")
    cut = x[int(best * sr) : int((best + window_sec) * sr)]
    buf = io.BytesIO()
    sf.write(buf, cut, sr, format="WAV", subtype="PCM_16")
    clip_bytes = buf.getvalue()
    transcript = _transcribe_bytes(clip_bytes, "small")
    if not transcript:
        raise ValueError("STT heard no speech in the flattest passage")
    import datetime as _dt

    slug = _safe_voice_name(f"{_safe_voice_name(name)}-steady")
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    wpath, mpath = VOICES_DIR / f"{slug}.wav", VOICES_DIR / f"{slug}.json"
    wpath.write_bytes(clip_bytes)
    mpath.write_text(
        json.dumps(
            {"transcript": transcript, "created": _dt.datetime.now().isoformat(timespec="seconds"),
             "anchorOf": _safe_voice_name(name), "anchorStartSec": round(best, 1)},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return {"name": slug, "transcript": transcript, "startSec": round(best, 1),
            "sizeBytes": len(clip_bytes)}


# ---------------------------------------------------------------- Kokoro-82M
# Server-side Kokoro (official torch voices + misaki G2P, no espeak binary).
# This replaced the old in-browser kokoro-js path: browser weight caches,
# WebGPU/WASM driver variance and CDN phonemizer data cannot corrupt output
# anymore — files are verified project-local and every render is measurable.

KOKORO_ID = "hexgrad/Kokoro-82M"
KOKORO_SR = 24000
KOKORO_MAX_CHARS = 600

_kokoro: dict = {
    "pipes": {},  # (lang, device) -> KPipeline
    "g2p": {},  # british? -> misaki G2P
    "device": "cpu",
    "error": None,
    "selftest": None,  # {ok, rms, voicedRatio, ms, voice}
}
_kokoro_lock = threading.Lock()


def _kokoro_device() -> str:
    try:
        import torch  # type: ignore

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _kokoro_pipe(lang: str, device: str):
    key = (lang, device)
    if key in _kokoro["pipes"]:
        return _kokoro["pipes"][key]
    from kokoro import KPipeline  # type: ignore
    from misaki import en as misaki_en  # type: ignore

    british = lang == "b"
    if british not in _kokoro["g2p"]:
        _kokoro["g2p"][british] = misaki_en.G2P(trf=False, british=british, fallback=None)
    pipe = KPipeline(lang_code=lang, en_callable=_kokoro["g2p"][british], device=device)
    _kokoro["pipes"][key] = pipe
    return pipe


def _kokoro_ensure(lang: str, device: str):
    """Load (or reuse) the Kokoro pipeline; raises with a readable message."""
    with _kokoro_lock:
        try:
            pipe = _kokoro_pipe(lang, device)
            _kokoro["device"] = device
            _kokoro["error"] = None
            return pipe
        except Exception as e:
            _kokoro["error"] = str(e)
            raise RuntimeError(f"Kokoro load failed: {e}")


def _kokoro_synth(payload: dict) -> bytes:
    import soundfile as sf  # type: ignore
    import torch  # type: ignore

    with _kokoro_lock:
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ValueError("text is empty")
        if len(text) > KOKORO_MAX_CHARS:
            raise ValueError(f"text too long ({len(text)} chars, max {KOKORO_MAX_CHARS})")
        voice = str(payload.get("voice", "af_heart") or "af_heart").strip()
        speed = float(payload.get("speed", 1.0) or 1.0)
        speed = min(2.0, max(0.5, speed))
        want_cpu = str(payload.get("device", "auto") or "auto") == "cpu"
        device = "cpu" if want_cpu else _kokoro_device()
        lang = "b" if voice[:1] == "b" else "a"
        try:
            pipe = _kokoro_pipe(lang, device)
            _kokoro["device"] = device
            _kokoro["error"] = None
        except Exception as e:
            _kokoro["error"] = str(e)
            raise RuntimeError(f"Kokoro load failed: {e}")
        try:
            chunks: list = []
            with torch.inference_mode():
                for _gs, _ps, audio in pipe(text, voice=voice, speed=speed):
                    chunks.append(audio.cpu().numpy())
        except Exception as e:
            raise RuntimeError(f"Kokoro synthesis failed (voice '{voice}'): {e}")
        if not chunks:
            raise RuntimeError("Kokoro returned no audio")
        import numpy as np

        wav = np.concatenate(chunks).astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, wav, KOKORO_SR, format="WAV", subtype="PCM_16")
        return buf.getvalue()


def _kokoro_selftest() -> dict:
    """Startup proof: synthesize a line and verify it is actually speech
    (energy + voiced periodicity), not silence or static. Result is served
    on /health so the UI — and the operator — can trust the engine."""
    import time as _time

    import numpy as np

    t0 = _time.time()
    out: dict = {"ok": False, "rms": 0.0, "voicedRatio": 0.0, "ms": 0, "voice": "af_heart"}
    try:
        wav_bytes = _kokoro_synth(
            {"text": "Hello, this is a voice check.", "voice": "af_heart", "speed": 1.0}
        )
        import soundfile as sf  # type: ignore

        x, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
        x = np.asarray(x, dtype=np.float64)
        rms = float(np.sqrt((x**2).mean())) if len(x) else 0.0
        flen = sr // 10
        voiced = total = 0
        for s in range(0, len(x) - flen, flen):
            total += 1
            fr = x[s : s + flen] * np.hanning(flen)
            if np.abs(fr).max() < 0.02:
                continue
            ac = np.correlate(fr, fr, mode="full")[flen - 1 :]
            if ac[0] <= 1e-9:
                continue
            ac = ac / ac[0]
            lo, hi = int(sr / 500), int(sr / 50)
            if hi >= len(ac):
                continue
            if ac[int(np.argmax(ac[lo:hi])) + lo] >= 0.35:
                voiced += 1
        out.update(
            {
                "ok": bool(rms > 0.01 and (voiced / max(1, total)) > 0.25),
                "rms": round(rms, 4),
                "voicedRatio": round(voiced / max(1, total), 3),
                "ms": int((_time.time() - t0) * 1000),
            }
        )
    except Exception as e:
        out["error"] = str(e)[:200]
    _kokoro["selftest"] = out
    print(f"[kokoro] self-test: {out}", flush=True)
    return out


class _Handler(BaseHTTPRequestHandler):
    server_version = "Audio8GPUServer/2.0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _json(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        try:
            return json.loads(self.rfile.read(max(0, length)).decode("utf-8") or "{}")
        except Exception as e:
            raise ValueError(f"bad JSON: {e}")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path in ("", "/", "/health"):
            try:
                import torch  # type: ignore

                cuda = bool(torch.cuda.is_available())
            except Exception:
                cuda = False
            loaded = _state["model"] is not None
            kokoro_dir = HF_CACHE / "hub" / "models--hexgrad--Kokoro-82M"
            self._json(
                {
                    "ok": loaded,
                    "device": _state["device"] if loaded else ("loading" if not _state["error"] else "error"),
                    "cudaAvailable": cuda and _state["device"] == "cuda",
                    "dtype": _state["dtype"],
                    "model": _state["model_id"],
                    "modelDir": str(TTS_DIR),
                    "modelDirMB": dir_mb(TTS_DIR),
                    "sttDirMB": dir_mb(STT_DIR),
                    "voicesMB": dir_mb(VOICES_DIR),
                    "voicesCount": len(_list_voices()),
                    "sttModel": _stt["name"] or STT_DEFAULT,
                    "sttReady": _stt["model"] is not None,
                    "error": _state["error"],
                    "kokoro": {
                        "ready": _kokoro["selftest"] is not None and bool(_kokoro["selftest"].get("ok")),
                        "loading": _kokoro_started and _kokoro["selftest"] is None and not _kokoro["error"],
                        "device": _kokoro["device"],
                        "dirMB": dir_mb(kokoro_dir),
                        "selftest": _kokoro["selftest"],
                        "error": _kokoro["error"],
                    },
                }
            )
            return
        if path == "/api/voices":
            self._json({"voices": _list_voices()})
            return
        if path == "/api/voices/audio":
            name = parse_qs(parsed.query).get("name", [""])[0]
            try:
                wav, _meta = _voice_paths(name)
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            if not wav.is_file():
                self._json({"detail": "voice not found"}, 404)
                return
            data = wav.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return
        self._json({"detail": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path == "/api/tts":
            try:
                payload = self._body()
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            try:
                wav, _sr = _synthesize(payload)
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            except Exception as e:
                self._json({"detail": str(e)[:500]}, 500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self._cors()
            self.end_headers()
            self.wfile.write(wav)
            return
        if path == "/api/transcribe":
            try:
                payload = self._body()
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            try:
                raw_b64 = str(payload.get("audio_b64", "") or "")
                if not raw_b64:
                    raise ValueError("audio_b64 is empty")
                raw = base64.b64decode(raw_b64)
                if len(raw) > 25 * 1024 * 1024:
                    raise ValueError("clip too large for transcription (25MB max)")
                want = str(payload.get("model", STT_DEFAULT) or STT_DEFAULT)
                if payload.get("timestamps"):
                    # one inference only — text derives from the same segments
                    segments = _transcribe_segments(raw, want)
                    text = " ".join(s["text"] for s in segments).strip()
                    self._json({"text": text, "segments": segments})
                else:
                    self._json({"text": _transcribe(payload)})
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            except Exception as e:
                self._json({"detail": str(e)[:500]}, 500)
                return
            return
        if path == "/api/voices":
            try:
                payload = self._body()
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            try:
                name = _safe_voice_name(str(payload.get("name", "")))
                transcript = str(payload.get("transcript", "")).strip()
                if not transcript:
                    raise ValueError("transcript is empty — transcribe the clip first or type it")
                raw = base64.b64decode(str(payload.get("audio_b64", "") or ""))
                if not raw:
                    raise ValueError("audio_b64 is empty")
                if len(raw) > 12 * 1024 * 1024:
                    raise ValueError("clip too large (12MB max)")
                import datetime as _dt

                VOICES_DIR.mkdir(parents=True, exist_ok=True)
                wav, meta = _voice_paths(name)
                wav.write_bytes(raw)
                meta.write_text(
                    json.dumps(
                        {"transcript": transcript, "created": _dt.datetime.now().isoformat(timespec="seconds")},
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                self._json({"ok": True, "name": name})
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
            except Exception as e:
                self._json({"detail": str(e)[:300]}, 500)
            return
        if path == "/api/voices/anchor":
            try:
                payload = self._body()
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            try:
                out = _steady_anchor(str(payload.get("name", "")),
                                     float(payload.get("window_sec", 10.0) or 10.0))
                self._json({"ok": True, **out})
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
            except Exception as e:
                self._json({"detail": str(e)[:300]}, 500)
            return
        if path == "/api/kokoro/load":
            _kokoro_start()
            self._json({"ok": True, "started": True})
            return
        if path == "/api/kokoro/synth":
            try:
                payload = self._body()
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            try:
                wav = _kokoro_synth(payload)
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            except Exception as e:
                self._json({"detail": str(e)[:500]}, 500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self._cors()
            self.end_headers()
            self.wfile.write(wav)
            return
        self._json({"detail": "not found"}, 404)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if (parsed.path.rstrip("/")) != "/api/voices":
            self._json({"detail": "not found"}, 404)
            return
        name = parse_qs(parsed.query).get("name", [""])[0]
        try:
            wav, meta = _voice_paths(name)
        except ValueError as e:
            self._json({"detail": str(e)}, 400)
            return
        for p in (wav, meta):
            try:
                p.unlink()
            except OSError:
                pass
        self._json({"ok": True})

    def log_message(self, fmt: str, *args: object) -> None:  # quieter logs
        print(f"[audio8] {fmt % args}", flush=True)


_kokoro_started = False


def _kokoro_start() -> None:
    """Begin Kokoro load + self-test in the background (idempotent)."""
    global _kokoro_started
    if _kokoro_started:
        return
    _kokoro_started = True

    def _run() -> None:
        try:
            _kokoro_ensure("a", _kokoro_device())
        except Exception as e:
            print(f"[kokoro] preload failed (will retry on first synthesis): {e}", flush=True)
        _kokoro_selftest()

    threading.Thread(target=_run, daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser(description="HandScribe local voice server: Audio8 0.6B + Kokoro-82M (project-local)")
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--no-kokoro", action="store_true", help="skip the Kokoro engine (Audio8/STT only)")
    args = ap.parse_args()
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    _state["model_id"] = args.model
    threading.Thread(target=_load, args=(args.model,), daemon=True).start()
    if not args.no_kokoro:
        _kokoro_start()
    srv = ThreadingHTTPServer((args.host, args.port), _Handler)
    print(f"[voice] serving on http://{args.host}:{args.port} (model: {args.model})", flush=True)
    print(f"[voice] models dir: {MODEL_ROOT} (project-local, nothing global)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
