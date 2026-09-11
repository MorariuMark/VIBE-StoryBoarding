# VIBE-StoryBoarding (HandScribe)

Whiteboard hand-drawing animation studio with a timeline editor and a local AI voiceover studio. Everything runs on your own machine: no cloud accounts, no API keys, no audio or scripts leaving your computer.

## Features

- Timeline-based whiteboard animation editor with MP4 export.
- AI Voiceover Studio:
  - **Kokoro-82M** text-to-speech, 100 percent in-browser (28 voices, WebGPU/CPU, background worker so the page never freezes).
  - **Audio8 0.6B** text-to-speech on your own CUDA GPU via a project-local Python sidecar, with zero-shot voice cloning.
  - Built-in speech-to-text: transcribe a reference clip and its exact words are pasted into the transcript box automatically.
  - Saved voice library: named clone voices stored as wav + transcript in the project folder, reusable without re-uploading.
  - Sentence-accurate auto captions (timed from the real audio), voice FX chain (pitch, tempo, reverb, fades, normalize), WAV export, one-click insert onto the timeline.
- Desktop build (Electron): the app manages the GPU server process for you — no terminal windows to babysit.

## Quick start

Requirements: Node.js 20+ LTS. For the Audio8 GPU backend: Python 3.10+ and a CUDA-capable NVIDIA GPU.

### Web app (browser)

Double-click `start.bat`, or:

```bat
npm install
npm run dev
```

Open `http://localhost:5173`. Kokoro voices work immediately (the model downloads once into the browser cache, then runs offline).

### Desktop app (recommended for Audio8 voices)

Double-click `start-desktop.bat`, or build the installers:

```bat
npm run electron:dist
```

This produces `dist/HandScribe Setup 1.0.0.exe` (installer) and `dist/HandScribe-portable.exe` (no install). The desktop shell starts the GPU sidecar automatically, waits for it to answer, then shows the UI — the "server not reachable" failure mode does not exist there.

## Audio8 GPU backend setup (one time)

Everything is installed **inside the project folder**. Nothing is installed globally and no weights are committed to git.

```bat
scripts\setup-audio8.bat
```

This creates `server/python/.venv`, installs CUDA torch plus the server dependencies, and downloads the models into `models/`. Afterwards:

```bat
scripts\start-audio8.bat
```

Then open the voiceover panel, switch the backend toggle to **Audio8 0.6B GPU**, and press **Test**.

### Project-local layout

| Path | Contents |
|---|---|
| `server/python/.venv/` | Project Python environment (torch CUDA, transformers, faster-whisper) |
| `models/audio8/` | Audio8-TTS-Preview-0.6b checkpoint |
| `models/audio8/voices/` | Saved clone voices (`<name>.wav` + `<name>.json` transcript) |
| `models/stt/` | faster-whisper model used for auto-transcription |
| `models/hf-cache/` | Hugging Face cache (redirected here, never `~/.cache`) |

### Download sizes (first run only, then cached)

| Model | Size | Where |
|---|---|---|
| Kokoro-82M fast (q8) | ~100 MB | Browser cache |
| Kokoro-82M best (fp32) | ~300 MB | Browser cache |
| Audio8-TTS 0.6B | ~2.5 GB | `models/audio8/` |
| faster-whisper small (STT) | ~0.5 GB | `models/stt/` |

The panel shows the selected model size in Settings, and the live on-disk usage (TTS / STT / voices) in the Audio8 section once the server is up.

## Cloning a voice

1. In the Audio8 section, pick a reference clip (5-15 seconds of clean speech).
2. Press **Transcribe** — the local STT model fills in the exact words. Verify they match the clip word for word.
3. Name it and press **Save voice**. It is stored under `models/audio8/voices/`.
4. Click a saved voice to use it for previews and full narration. No re-upload needed.

Notes: cloning quality depends on the transcript matching the clip exactly. Keep each narration chunk under ~150 characters for best quality (the app splits scripts automatically).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (browser) |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run electron:dev` | Desktop shell against the vite dev server (run `npm run dev` in another terminal first) |
| `npm run electron` | Build + run the desktop app from `dist/` |
| `npm run electron:dist` | Build Windows installer + portable exe |
| `scripts/setup-audio8.bat` | One-time project-local GPU backend install |
| `scripts/start-audio8.bat` | Start the Audio8 GPU server on `127.0.0.1:8010` |

## How it works

- `src/engine/voiceover.ts` + `src/engine/voWorker.ts` — Kokoro synthesis in a Web Worker (WebGPU when available, WASM fallback; GPU always uses fp32 because the quantized build corrupts audio there).
- `src/engine/audio8.ts` — HTTP client for the sidecar: chunked GPU synthesis, STT transcription, saved-voice library.
- `server/python/audio8_server.py` — stdlib-only HTTP server (no framework): `/health`, `/api/tts`, `/api/transcribe`, `/api/voices`. Loads Audio8 with torch/CUDA (BF16 on Ampere and newer, FP16 on older cards such as GTX 16xx) and faster-whisper for STT.
- `electron/main.cjs` — desktop shell: spawns and supervises the sidecar, serves `dist/` over loopback HTTP (required for module workers, WASM and WebGPU; `file://` would break them), opens the app window.
- `src/engine/voiceFx.ts` — offline DSP (tempo, pitch, reverb, fades, gain, normalize) applied in the worker; caption timings follow tempo changes.

Why a sidecar instead of in-browser Audio8: Audio8 ships as PyTorch + Transformers custom code. There is no WebGPU/browser build and no quantized WebGPU artifact (the only official ONNX release is CPU-only INT4), and browsers cannot access CUDA. The sidecar is the supported GPU path.

## Configuration

- Sidecar address: `http://127.0.0.1:8010` by default, editable in the voiceover panel.
- `AUDIO8_PORT` env var overrides the sidecar port (desktop shell and server both respect it).
- `HANDSCRIBE_ROOT` env var overrides the project root the desktop shell manages.
- `VITE_DEV_URL` env var overrides the dev-server URL used by `electron:dev`.

## Troubleshooting

- **"Audio8 server not reachable / Failed to fetch"** — the sidecar process is not running. Start `scripts/start-audio8.bat` (browser) or use the desktop app (manages it for you). First start takes ~2 minutes while the 2.4 GB checkpoint loads; the Test button shows `loading` until then.
- **Server reachable but "NOT on GPU"** — torch has no CUDA here. Re-run `scripts/setup-audio8.bat` (installs the CUDA build) and check `nvidia-smi`.
- **CUDA out of memory on 4 GB cards** — the server already prefers FP16 on pre-Ampere GPUs. Close other GPU apps before long renders.
- **Transcribe returns nothing** — the clip has no intelligible speech. Use a cleaner, louder 5-15 second sample.
- **Cloned voice sounds off** — the transcript does not match the clip exactly. Re-transcribe and proofread before saving.

## License

No license file is included yet, so all rights are reserved by default. Third-party model weights downloaded by the setup script follow their own licenses (notably Apache-2.0 for Audio8-TTS).
