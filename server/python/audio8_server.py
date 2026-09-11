"""
Audio8 0.6B local GPU server — exposes Audio8/Audio8-TTS-Preview-0.6b to the
HandScribe voiceover panel over HTTP so generation runs on your CUDA GPU.

Everything lives INSIDE the project folder — nothing is installed globally:
  <project>/server/python/.venv/   Python venv (torch CUDA, transformers, …)
  <project>/models/audio8/         Audio8 checkpoint (downloaded once)
  <project>/models/hf-cache/       Hugging Face cache dir (env-redirected)
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


def _transcribe(payload: dict) -> str:
    raw_b64 = str(payload.get("audio_b64", "") or "")
    if not raw_b64:
        raise ValueError("audio_b64 is empty")
    raw = base64.b64decode(raw_b64)
    if len(raw) > 25 * 1024 * 1024:
        raise ValueError("clip too large for transcription (25MB max)")
    want = str(payload.get("model", STT_DEFAULT) or STT_DEFAULT)
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
        suffix = mimetypes.guess_extension(str(payload.get("audio_mime", "audio/wav"))) or ".wav"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
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


class _Handler(BaseHTTPRequestHandler):
    server_version = "Audio8GPUServer/1.1"

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
                text = _transcribe(payload)
            except ValueError as e:
                self._json({"detail": str(e)}, 400)
                return
            except Exception as e:
                self._json({"detail": str(e)[:500]}, 500)
                return
            self._json({"text": text})
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


def main() -> None:
    ap = argparse.ArgumentParser(description="Audio8 0.6B local CUDA GPU server for HandScribe (project-local)")
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8010)
    args = ap.parse_args()
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    _state["model_id"] = args.model
    threading.Thread(target=_load, args=(args.model,), daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), _Handler)
    print(f"[audio8] serving on http://{args.host}:{args.port} (model: {args.model})", flush=True)
    print(f"[audio8] models dir: {MODEL_ROOT} (project-local, nothing global)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
