/**
 * audio8 — client bridge to a local CUDA GPU server running Audio8-TTS-Preview-0.6B.
 *
 * Why a bridge (read before "just run it in the browser"):
 *  - Audio8 0.6B is a PyTorch + Transformers model with custom remote code
 *    (DualAR slow/fast AR + 44.1kHz neural codec, trust_remote_code=True).
 *  - There is NO transformers.js / ONNX-WebGPU browser build of it. The only
 *    official ONNX release (Audio8-TTS-Preview-0.6B-ONNX-INT4) is CPU-only
 *    (CPUExecutionProvider, weight-only INT4) with a Python runtime harness —
 *    it cannot run on WebGPU and there is no q8 WebGPU artifact to download.
 *  - Browsers can't touch CUDA anyway; "GPU" in-browser means WebGPU, which
 *    this model simply was never exported for.
 *
 * So: Kokoro-82M stays the 100% in-browser engine, and Audio8 runs on your
 * real GPU via `server/python/audio8_server.py` (torch + CUDA, BF16). This
 * module speaks to that server over HTTP and returns plain Float32 audio the
 * rest of the voiceover pipeline (chunking, captions, FX, WAV export) already
 * understands. All Audio8 generation options live in Audio8Options below.
 */

export const AUDIO8_MODEL_ID = 'Audio8/Audio8-TTS-Preview-0.6b';
export const AUDIO8_SAMPLE_RATE = 44100;
export const AUDIO8_DEFAULT_URL = 'http://127.0.0.1:8010';
/** Upstream guidance: keep each request <= ~150 chars for best quality. */
export const AUDIO8_MAX_CHARS = 150;
/** 11 languages the Preview checkpoint officially supports. */
export const AUDIO8_LANGUAGES = [
  'English',
  'Chinese',
  'Cantonese',
  'Dutch',
  'French',
  'German',
  'Italian',
  'Japanese',
  'Korean',
  'Polish',
  'Spanish',
] as const;
export type Audio8Language = (typeof AUDIO8_LANGUAGES)[number];

export interface Audio8Options {
  /** Base URL of the local GPU server, e.g. http://127.0.0.1:8010 */
  serverUrl: string;
  /** Hint prepended to the prompt so the model picks the right language. */
  language: Audio8Language;
  /** Sampling controls (upstream defaults). */
  temperature: number;
  topP: number;
  topK: number;
  maxNewTokens: number;
  /** Zero-shot cloning: reference WAV (as dataURL/blob) + exact transcript. Both or neither. */
  referenceAudioB64?: string | null;
  referenceAudioMime?: string | null;
  referenceText?: string;
  /** ...or a voice saved in models/audio8/voices/ (server resolves audio+transcript). */
  voiceName?: string | null;
  onStatus?: (msg: string, progress: number | null) => void;
}

export const DEFAULT_AUDIO8_OPTIONS: Audio8Options = {
  serverUrl: AUDIO8_DEFAULT_URL,
  language: 'English',
  temperature: 0.8,
  topP: 0.95,
  topK: 50,
  maxNewTokens: 1024,
  referenceAudioB64: null,
  referenceAudioMime: null,
  referenceText: '',
};

export interface Audio8Health {
  ok: boolean;
  device: string;
  cudaAvailable: boolean;
  dtype: string;
  model: string;
  /** On-disk sizes (MB) inside the project folder — null when unknown. */
  modelDirMB: number | null;
  sttDirMB: number | null;
  voicesMB: number | null;
  voicesCount: number | null;
  sttModel: string | null;
  sttReady: boolean;
  error?: string | null;
}

/** Download sizes shown in the app (first-run cost, then cached). */
export const KOKORO_SIZE_FAST = '~100MB';
export const KOKORO_SIZE_QUALITY = '~300MB';
export const AUDIO8_SIZE_TTS = '~2.5GB';
export const AUDIO8_SIZE_STT = '~500MB';

/** Format MB/GB for the model-size readouts. */
export function formatDiskMB(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (mb >= 1) return `${Math.round(mb)}MB`;
  return `${Math.max(1, Math.round(mb * 1024))}KB`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** A clone voice saved in models/audio8/voices/ (project-local). */
export interface SavedVoice {
  name: string;
  transcript: string;
  sizeBytes: number;
  created: string;
}

/** Built-in preset voices = shipped reference clips served by the GPU server. */
export interface Audio8PresetVoice {
  id: string;
  label: string;
  gender: 'female' | 'male';
  accent: string;
  description: string;
}

export const AUDIO8_PRESET_VOICES: Audio8PresetVoice[] = [
  { id: 'auto-female', label: 'Aria', gender: 'female', accent: 'American', description: 'Default female voice (no cloning needed)' },
  { id: 'auto-male', label: 'Rowan', gender: 'male', accent: 'American', description: 'Default male voice (no cloning needed)' },
];

function baseUrl(o: Audio8Options): string {
  return (o.serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '');
}

export async function audio8Health(opts: Pick<Audio8Options, 'serverUrl'>): Promise<Audio8Health> {
  const url = `${(opts.serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/health`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`server replied HTTP ${res.status}`);
    const j = (await res.json()) as Partial<Audio8Health>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      ok: j.ok ?? true,
      device: typeof j.device === 'string' ? j.device : 'unknown',
      cudaAvailable: j.cudaAvailable ?? false,
      dtype: typeof j.dtype === 'string' ? j.dtype : 'unknown',
      model: typeof j.model === 'string' ? j.model : AUDIO8_MODEL_ID,
      modelDirMB: num(j.modelDirMB),
      sttDirMB: num(j.sttDirMB),
      voicesMB: num(j.voicesMB),
      voicesCount: typeof j.voicesCount === 'number' ? j.voicesCount : null,
      sttModel: typeof j.sttModel === 'string' ? j.sttModel : null,
      sttReady: j.sttReady ?? false,
      error: typeof j.error === 'string' ? j.error : null,
    };
  } finally {
    clearTimeout(t);
  }
}

async function throwForBad(res: Response, prefix: string): Promise<never> {
  let detail = '';
  try {
    const j = (await res.json()) as { detail?: unknown };
    detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j);
  } catch {
    detail = await res.text().catch(() => '');
  }
  throw new Error(`${prefix}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
}

/** Transcribe a reference clip on the server (faster-whisper, project-local model). */
export async function audio8Transcribe(
  serverUrl: string,
  audioB64: string,
  audioMime?: string | null,
  model?: 'base' | 'small',
): Promise<string> {
  const res = await fetch(`${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_b64: audioB64, audio_mime: audioMime ?? 'audio/wav', model: model ?? 'small' }),
  });
  if (!res.ok) await throwForBad(res, 'Audio8 STT');
  const j = (await res.json()) as { text?: unknown };
  return String(j.text ?? '').trim();
}

/** List clone voices saved in models/audio8/voices/. */
export async function audio8ListVoices(serverUrl: string): Promise<SavedVoice[]> {
  const res = await fetch(`${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/voices`);
  if (!res.ok) await throwForBad(res, 'Audio8 voices');
  const j = (await res.json()) as { voices?: SavedVoice[] };
  return Array.isArray(j.voices) ? j.voices : [];
}

/** Save a clone voice into the project folder (wav + transcript). */
export async function audio8SaveVoice(
  serverUrl: string,
  name: string,
  transcript: string,
  audioB64: string,
  audioMime?: string | null,
): Promise<string> {
  const res = await fetch(`${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/voices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, transcript, audio_b64: audioB64, audio_mime: audioMime ?? 'audio/wav' }),
  });
  if (!res.ok) await throwForBad(res, 'Audio8 save voice');
  const j = (await res.json()) as { name?: unknown };
  return String(j.name ?? name);
}

/** Delete a saved clone voice from the project folder. */
export async function audio8DeleteVoice(serverUrl: string, name: string): Promise<void> {
  const res = await fetch(
    `${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/voices?name=${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) await throwForBad(res, 'Audio8 delete voice');
}

/** Playback URL for a saved voice clip. */
export function audio8VoiceAudioUrl(serverUrl: string, name: string): string {
  return `${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/voices/audio?name=${encodeURIComponent(name)}`;
}

/** Split prose into <= maxChars chunks (Audio8 likes short inputs). */
export function chunkAudio8Script(script: string, maxChars = AUDIO8_MAX_CHARS): string[] {
  const clean = script.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]+["”']?\s*|[^.!?…]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [clean];
  const blocks: string[] = [];
  let cur = '';
  const push = (t: string) => {
    if (t) blocks.push(t);
  };
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) {
        push(cur);
        cur = '';
      }
      const words = s.split(' ').filter(Boolean);
      let acc = '';
      for (const w of words) {
        const next = acc ? `${acc} ${w}` : w;
        if (next.length <= maxChars) acc = next;
        else {
          push(acc);
          acc = w;
        }
      }
      push(acc);
      continue;
    }
    const next = cur ? `${cur} ${s}` : s;
    if (next.length <= maxChars) cur = next;
    else {
      push(cur);
      cur = s;
    }
  }
  push(cur);
  return blocks.filter(b => b.length > 0);
}

/** Decode a WAV ArrayBuffer (server returns WAV) into mono Float32 + rate. */
export async function decodeWavBytes(buf: ArrayBuffer): Promise<{ samples: Float32Array; rate: number }> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio');
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const ch0 = audio.getChannelData(0);
    const out = new Float32Array(ch0.length);
    out.set(ch0);
    return { samples: out, rate: audio.sampleRate };
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

function blobToB64(blob: Blob): Promise<{ b64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      const comma = s.indexOf(',');
      resolve({ b64: comma >= 0 ? s.slice(comma + 1) : s, mime: blob.type || 'audio/wav' });
    };
    r.onerror = () => reject(r.error ?? new Error('Could not read reference audio'));
    r.readAsDataURL(blob);
  });
}

/** Convenience: turn a user-picked reference file into the fields Audio8Options needs. */
export async function audio8ReferenceFromFile(file: File): Promise<{ b64: string; mime: string }> {
  if (file.size > 8 * 1024 * 1024) throw new Error('Reference clip must be under 8MB (a clean 5–15s line works best).');
  return blobToB64(file);
}

async function synthOne(text: string, opts: Audio8Options): Promise<{ samples: Float32Array; rate: number }> {
  const hasRef = !!(opts.referenceAudioB64 && (opts.referenceText ?? '').trim());
  const body: Record<string, unknown> = {
    text,
    language: opts.language,
    temperature: opts.temperature,
    top_p: opts.topP,
    top_k: opts.topK,
    max_new_tokens: opts.maxNewTokens,
  };
  if (hasRef) {
    body.reference_audio_b64 = opts.referenceAudioB64;
    body.reference_audio_mime = opts.referenceAudioMime ?? 'audio/wav';
    body.reference_text = (opts.referenceText ?? '').trim();
  } else if (opts.voiceName) {
    body.voice_name = opts.voiceName;
  }
  const res = await fetch(`${baseUrl(opts)}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { detail?: unknown };
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`Audio8 GPU server: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const buf = await res.arrayBuffer();
  return decodeWavBytes(buf);
}

/**
 * Synthesize a full script through the GPU server: short-chunk -> sequential
 * POSTs -> concat with a pause between chunks. Returns per-chunk spans so the
 * existing caption builder stays sentence-accurate.
 */
export async function generateAudio8Voiceover(
  script: string,
  opts: Audio8Options & { pauseSec: number; onBlock?: (done: number, total: number) => void },
): Promise<{ samples: Float32Array; rate: number; chunks: { text: string; start: number; end: number }[] }> {
  const clean = script.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('The script is empty.');
  const blocks = chunkAudio8Script(clean);
  if (!blocks.length) throw new Error('The script is empty.');
  // Prove the GPU server is alive before burning time on chunks.
  const h = await audio8Health(opts);
  if (!h.cudaAvailable) {
    opts.onStatus?.(`Audio8 server is on CPU (${h.device}) — start it with a CUDA GPU for GPU synthesis.`, null);
  }
  const rateGuess = AUDIO8_SAMPLE_RATE;
  const parts: Float32Array[] = [];
  const chunks: { text: string; start: number; end: number }[] = [];
  let rate = rateGuess;
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    opts.onStatus?.(`Audio8 (GPU) synthesizing ${i + 1}/${blocks.length}…`, i / blocks.length);
    const { samples, rate: r } = await synthOne(blocks[i], opts);
    rate = r;
    // First chunk defines the timeline rate; resample strays (shouldn't happen).
    let s = samples;
    if (r !== rateGuess && i > 0) {
      // cheap linear resample to the timeline rate
      const n = Math.max(1, Math.round((samples.length * rateGuess) / r));
      const out = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const pos = (k * samples.length) / n;
        const i0 = Math.floor(pos);
        const f = pos - i0;
        out[k] = samples[i0] + ((samples[Math.min(samples.length - 1, i0 + 1)] - samples[i0]) * f || 0);
      }
      s = out;
    } else {
      rate = r;
    }
    const start = cursor / rate;
    parts.push(s);
    cursor += s.length;
    const end = cursor / rate;
    chunks.push({ text: blocks[i], start, end });
    if (i < blocks.length - 1 && opts.pauseSec > 0) {
      const gap = new Float32Array(Math.round(opts.pauseSec * rate));
      parts.push(gap);
      cursor += gap.length;
    }
    opts.onBlock?.(i + 1, blocks.length);
    opts.onStatus?.(`Audio8 (GPU) synthesizing ${i + 1}/${blocks.length}…`, (i + 1) / blocks.length);
    await new Promise(r2 => setTimeout(r2, 0));
  }
  const total = cursor;
  const samples = new Float32Array(total);
  let w = 0;
  for (const p of parts) {
    samples.set(p, w);
    w += p.length;
  }
  return { samples, rate, chunks };
}
