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
export const KOKORO_SIZE_MODEL = '~330MB';
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

/** One STT segment span (seconds, audio-relative) — for timeline sync. */
export interface SttSegment {
  text: string
  start: number
  end: number
}

/** Transcribe a reference clip on the server (faster-whisper, project-local model). */
export async function audio8Transcribe(
  serverUrl: string,
  audioB64: string,
  audioMime?: string | null,
  model?: 'base' | 'small',
): Promise<string> {
  const r = await audio8TranscribeSegments(serverUrl, audioB64, audioMime, model, false)
  return r.text
}

/** Transcribe with optional per-segment timestamps (recorded-voiceover sync). */
export async function audio8TranscribeSegments(
  serverUrl: string,
  audioB64: string,
  audioMime?: string | null,
  model?: 'base' | 'small',
  timestamps?: boolean,
): Promise<{ text: string; segments: SttSegment[] }> {
  const res = await fetch(`${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_b64: audioB64, audio_mime: audioMime ?? 'audio/wav', model: model ?? 'small', timestamps: timestamps ?? false }),
  });
  if (!res.ok) await throwForBad(res, 'Audio8 STT');
  const j = (await res.json()) as { text?: unknown; segments?: unknown };
  const segs = Array.isArray(j.segments) ? (j.segments as SttSegment[]).filter(
    s => s && typeof s.text === 'string' && typeof s.start === 'number' && typeof s.end === 'number',
  ) : []
  return { text: String(j.text ?? '').trim(), segments: segs }
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

/**
 * Build a "steady anchor" from a saved voice: the server carves out the
 * prosodically flattest ~10s passage and saves it as `<name>-steady` with a
 * fresh transcript. Narrating from the steady anchor instead of a long,
 * expressive reference removes the per-chunk pitch resets that sound like
 * the voice rising over time.
 */
export async function audio8SteadyAnchor(
  serverUrl: string,
  name: string,
): Promise<{ name: string; transcript: string; startSec: number; sizeBytes: number }> {
  const res = await fetch(`${(serverUrl || AUDIO8_DEFAULT_URL).replace(/\/+$/, '')}/api/voices/anchor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, window_sec: 10 }),
  });
  if (!res.ok) await throwForBad(res, 'Audio8 steady anchor');
  const j = (await res.json()) as {
    name?: unknown; transcript?: unknown; startSec?: unknown; sizeBytes?: unknown;
  };
  return {
    name: String(j.name ?? `${name}-steady`),
    transcript: String(j.transcript ?? ''),
    startSec: typeof j.startSec === 'number' ? j.startSec : 0,
    sizeBytes: typeof j.sizeBytes === 'number' ? j.sizeBytes : 0,
  };
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
 * Join chunk samples with an equal-power crossfade at every boundary.
 *
 * Why this exists (measured, not guessed): each narration chunk is an
 * independent model call, so every chunk re-anchors to its reference's
 * opening pitch (~110-130 Hz here) while chunk tails scatter anywhere from
 * ~55 Hz groans to end-of-utterance squeaks. Concatenating those raw edges
 * produces a sharp upward step every ~10s — heard as "pitch keeps rising".
 * The crossfade turns each step into a short glide and buries the unreliable
 * tail/head edges. Chunk time-spans are recomputed from the real layout, so
 * captions stay sample-accurate.
 */
export function crossfadeJoin(
  chunks: Float32Array[],
  rate: number,
  pauseSec: number,
  overlapSec = 0.25,
): { samples: Float32Array; spans: { start: number; end: number }[] } {
  const spans: { start: number; end: number }[] = [];
  if (!chunks.length) return { samples: new Float32Array(0), spans };
  const gapBase = Math.max(0, Math.round(pauseSec * rate));
  // total length pass (overlaps shrink it, gaps grow it)
  let total = chunks[0].length;
  const overlaps: number[] = [0];
  for (let i = 1; i < chunks.length; i++) {
    const o = Math.min(
      Math.round(overlapSec * rate),
      Math.floor(chunks[i - 1].length / 4),
      Math.floor(chunks[i].length / 4),
    );
    overlaps.push(Math.max(0, o));
    total += Math.max(0, gapBase - o) + chunks[i].length - o;
  }
  const out = new Float32Array(total);
  out.set(chunks[0], 0);
  spans.push({ start: 0, end: chunks[0].length / rate });
  let cursor = chunks[0].length;
  for (let i = 1; i < chunks.length; i++) {
    const o = overlaps[i];
    const gap = Math.max(0, gapBase - o);
    const at = cursor + gap - o; // where chunks[i][0] lands
    for (let k = 0; k < o; k++) {
      const t = o <= 1 ? 1 : k / (o - 1);
      out[at + k] = out[at + k] * Math.cos((t * Math.PI) / 2) + chunks[i][k] * Math.sin((t * Math.PI) / 2);
    }
    out.set(chunks[i].subarray(o), at + o);
    cursor = at + chunks[i].length;
    spans.push({ start: at / rate, end: cursor / rate });
  }
  return { samples: out, spans };
}

/**
 * Synthesize a full script through the GPU server: short-chunk -> sequential
 * POSTs -> crossfade-join with the pause between chunks. Returns per-chunk
 * spans so the existing caption builder stays sentence-accurate.
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
  const synthList: Float32Array[] = [];
  let rate = rateGuess;
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
    synthList.push(s);
    opts.onBlock?.(i + 1, blocks.length);
    opts.onStatus?.(`Audio8 (GPU) synthesizing ${i + 1}/${blocks.length}…`, (i + 1) / blocks.length);
    await new Promise(r2 => setTimeout(r2, 0));
  }
  // Crossfade-join: turns every chunk-boundary pitch step into a short glide
  // (see crossfadeJoin). Spans come from the real overlapped layout.
  const { samples, spans } = crossfadeJoin(synthList, rate, opts.pauseSec);
  const chunks = blocks.map((text, i) => ({ text, start: spans[i].start, end: spans[i].end }));
  return { samples, rate, chunks };
}
