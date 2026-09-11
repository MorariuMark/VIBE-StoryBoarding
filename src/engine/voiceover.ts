/**
 * voiceover — local AI narration with Kokoro-82M (kokoro-js, 100% in-browser).
 *
 * All heavy work (model inference + FX) runs in a dedicated Web Worker
 * (voWorker.ts), so long renders never block the page. Auto mode prefers
 * WebGPU when the browser offers it, otherwise CPU/WASM.
 *
 * Long scripts are split into sentence-safe blocks (<= MAX_BLOCK_CHARS),
 * synthesized sequentially, then concatenated with a natural pause between
 * blocks. Caption cues are derived from the true per-block audio durations,
 * so captions stay in sync with the voiceover on the timeline.
 */
import type { VoiceFxParams, FxResult } from './voiceFx'

export const VO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const VO_SAMPLE_RATE = 24000
/**
 * Max characters sent to the model in a single generate() call.
 * kokoro-js tokenizes phonemes with truncation at ~510 tokens, and phoneme
 * strings run ~2x the character count — so 300 chars keeps every block
 * safely under the limit instead of being silently cut off mid-sentence.
 */
export const MAX_BLOCK_CHARS = 300
/** Silence inserted between blocks (seconds) — the "natural pause". */
export const DEFAULT_PAUSE_SEC = 0.45
/** Editable default line used for voice previews. */
export const DEFAULT_PREVIEW_TEXT = "Hello! I'm ready to narrate your video. This is how my voice sounds."

export type VoGender = 'female' | 'male'
export type VoAccent = 'American' | 'British'

export interface VoiceMeta {
  id: string
  label: string
  gender: VoGender
  accent: VoAccent
  grade: string
  top?: boolean
}

/** All 28 Kokoro-82M v1.0 voices with quality grades from the model card. */
export const VOICES: VoiceMeta[] = [
  { id: 'af_heart', label: 'Heart', gender: 'female', accent: 'American', grade: 'A', top: true },
  { id: 'af_bella', label: 'Bella', gender: 'female', accent: 'American', grade: 'A-', top: true },
  { id: 'af_nicole', label: 'Nicole', gender: 'female', accent: 'American', grade: 'B-' },
  { id: 'af_aoede', label: 'Aoede', gender: 'female', accent: 'American', grade: 'C+' },
  { id: 'af_kore', label: 'Kore', gender: 'female', accent: 'American', grade: 'C+' },
  { id: 'af_sarah', label: 'Sarah', gender: 'female', accent: 'American', grade: 'C+' },
  { id: 'af_alloy', label: 'Alloy', gender: 'female', accent: 'American', grade: 'C' },
  { id: 'af_nova', label: 'Nova', gender: 'female', accent: 'American', grade: 'C' },
  { id: 'af_sky', label: 'Sky', gender: 'female', accent: 'American', grade: 'C-' },
  { id: 'af_jessica', label: 'Jessica', gender: 'female', accent: 'American', grade: 'D' },
  { id: 'af_river', label: 'River', gender: 'female', accent: 'American', grade: 'D' },
  { id: 'am_fenrir', label: 'Fenrir', gender: 'male', accent: 'American', grade: 'C+', top: true },
  { id: 'am_michael', label: 'Michael', gender: 'male', accent: 'American', grade: 'C+', top: true },
  { id: 'am_puck', label: 'Puck', gender: 'male', accent: 'American', grade: 'C+' },
  { id: 'am_echo', label: 'Echo', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_eric', label: 'Eric', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_liam', label: 'Liam', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_onyx', label: 'Onyx', gender: 'male', accent: 'American', grade: 'D' },
  { id: 'am_santa', label: 'Santa', gender: 'male', accent: 'American', grade: 'D-' },
  { id: 'am_adam', label: 'Adam', gender: 'male', accent: 'American', grade: 'F+' },
  { id: 'bf_emma', label: 'Emma', gender: 'female', accent: 'British', grade: 'B-', top: true },
  { id: 'bf_isabella', label: 'Isabella', gender: 'female', accent: 'British', grade: 'C' },
  { id: 'bf_alice', label: 'Alice', gender: 'female', accent: 'British', grade: 'D' },
  { id: 'bf_lily', label: 'Lily', gender: 'female', accent: 'British', grade: 'D' },
  { id: 'bm_george', label: 'George', gender: 'male', accent: 'British', grade: 'C', top: true },
  { id: 'bm_fable', label: 'Fable', gender: 'male', accent: 'British', grade: 'C' },
  { id: 'bm_lewis', label: 'Lewis', gender: 'male', accent: 'British', grade: 'D+' },
  { id: 'bm_daniel', label: 'Daniel', gender: 'male', accent: 'British', grade: 'D' },
]

export type VoEngine = 'auto' | 'wasm' | 'webgpu'

export interface VoQuality {
  engine: VoEngine
  /** dtype preset: 'fast' = q8, 'quality' = fp32 */
  quality: 'fast' | 'quality'
}

export interface EngineInfo {
  device: string
  dtype: string
}

/**
 * Scrub raw text into smooth TTS input:
 *  1. currency symbols jump behind the number ("$10" -> "10$"), which the
 *     phonemizer reads far more naturally than a leading symbol;
 *  2. markdown / code-ish symbols espeak would read aloud ("star", "slash",
 *     "tilde", …) are removed or spaced out, "#" before a digit becomes
 *     "number" ("issue #5" -> "issue number 5");
 *  3. emoji and exotic symbols are stripped (they become garbage phonemes);
 *  4. anything else outside the speakable set is dropped as a safety net.
 * kokoro-js normalizes the rest itself (decimals, abbreviations, quotes).
 */
export function sanitizeForTTS(text: string): string {
  return text
    // 1. "$10" / "€50.25" / "£1,000" -> "10$" / "50.25€" / "1,000£"
    .replace(/([$€£¥₹₩₽₴¢])\s*(\d(?:[\d,]*\d)?(?:\.\d+)?)/g, '$2$1')
    // 2. symbols the TTS would read aloud weirdly — drop or space out
    .replace(/[*<>~`\\^|]/g, '')
    .replace(/[/_=]/g, ' ')
    .replace(/(^|\s)#(?=\d)/g, '$1number ')
    .replace(/#/g, ' ')
    // 3. strip emoji / pictographs / symbols outside the speakable set
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '')
    // 4. keep letters (incl. accented), numbers, whitespace and speakable punctuation
    .replace(/[^\p{L}\p{N}\s.,!?;:'"“”‘’()\[\]—–\-…$£€¥₹₩₽₴¢%&@#*+/=]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

interface DeviceAttempt { device: 'webgpu' | 'wasm'; dtype: string }

function gpuAvailable(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu
  } catch {
    return false
  }
}

/**
 * Correct device/dtype matrix. Per the kokoro-js README, WebGPU requires
 * fp32 — running the q8 quantized model on WebGPU yields corrupt audio.
 * Auto prefers the GPU when the browser offers one.
 */
function attemptsFor(q: VoQuality): DeviceAttempt[] {
  if (q.engine === 'wasm') return [{ device: 'wasm', dtype: q.quality === 'quality' ? 'fp32' : 'q8' }]
  if (q.engine === 'webgpu') return [{ device: 'webgpu', dtype: 'fp32' }]
  const cpuDtype = q.quality === 'quality' ? 'fp32' : 'q8'
  if (gpuAvailable()) return [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: cpuDtype }]
  return [{ device: 'wasm', dtype: cpuDtype }]
}

// ---------------------------------------------------------------------------
// Background worker manager
// ---------------------------------------------------------------------------

interface PendingCall {
  res: (v: never) => void
  rej: (e: unknown) => void
  onStatus?: (msg: string, progress: number | null) => void
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, PendingCall>()
let engineInfo: EngineInfo | null = null
let loadedKey = ''

function getWorker(): Worker {
  if (!worker) {
    let w: Worker
    try {
      w = new Worker(new URL('./voWorker.ts', import.meta.url), { type: 'module' })
    } catch (e) {
      throw new Error(`This browser blocked the voice background worker: ${e instanceof Error ? e.message : e}`)
    }
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; type: string; progress?: number | null; status?: string | null; message?: string }
      const p = pending.get(m.id)
      if (!p) return
      if (m.type === 'load-progress') {
        const label = m.status ?? 'Downloading voice model…'
        if (typeof m.progress === 'number') {
          p.onStatus?.(`${label} ${Math.round(m.progress)}%`, m.progress / 100)
        } else {
          p.onStatus?.(label, null)
        }
        return
      }
      pending.delete(m.id)
      if (m.type === 'error') p.rej(new Error(m.message || 'Voice engine error'))
      else p.res(m as never)
    }
    w.onerror = (e: ErrorEvent) => {
      const err = new Error(`Voice worker crashed: ${e.message || 'unknown error'}`)
      pending.forEach(({ rej }) => rej(err))
      pending.clear()
      try {
        w.terminate()
      } catch { /* noop */ }
      if (worker === w) {
        worker = null
        engineInfo = null
        loadedKey = ''
      }
    }
    worker = w
  }
  return worker
}

function callWorker<T>(msg: Record<string, unknown>, onStatus?: (msg: string, progress: number | null) => void): Promise<T> {
  const w = getWorker()
  const id = ++seq
  return new Promise<T>((res, rej) => {
    pending.set(id, { res: res as (v: never) => void, rej, onStatus })
    w.postMessage({ ...msg, id })
  })
}

/** Hard-stop the engine immediately (unblocks a frozen-feeling cancel). */
export function terminateVoiceEngine() {
  pending.forEach(({ rej }) => rej(new Error('Voice engine stopped')))
  pending.clear()
  try {
    worker?.terminate()
  } catch { /* noop */ }
  worker = null
  engineInfo = null
  loadedKey = ''
}

export function getEngineInfo(): EngineInfo | null {
  return engineInfo
}

/** Serialize all worker calls through one FIFO lane (no concurrent inference). */
let ttsLane: Promise<unknown> = Promise.resolve()
function lane<T>(fn: () => Promise<T>): Promise<T> {
  const run = ttsLane.then(fn, fn)
  ttsLane = run.catch(() => undefined)
  return run as Promise<T>
}

/**
 * Load (or reuse) the Kokoro model inside the worker. Resolves with the
 * device/dtype actually used, so the UI can show where it is running.
 */
export function ensureVoiceModel(
  quality: VoQuality,
  onStatus?: (msg: string, progress: number | null) => void,
): Promise<EngineInfo> {
  const attempts = attemptsFor(quality)
  const key = attempts.map(a => `${a.device}/${a.dtype}`).join('+')
  if (engineInfo && loadedKey === key) {
    return Promise.resolve(engineInfo)
  }
  return lane(async () => {
    // re-check inside the lane (a concurrent caller may have loaded meanwhile)
    if (engineInfo && loadedKey === key) return engineInfo
    let lastErr: unknown = null
    for (const { device, dtype } of attempts) {
      try {
        const sizeHint = dtype === 'fp32' ? '~300MB' : '~100MB'
        onStatus?.(`Loading Kokoro-82M voice model (${device}/${dtype}, first run downloads ${sizeHint})…`, null)
        await callWorker<{ type: string }>(
          { type: 'load', device, dtype },
          (msg, p) => {
            if (p === null) onStatus?.(msg, null)
            else onStatus?.(`Downloading voice model… ${Math.round(p * 100)}%`, p)
          },
        )
        engineInfo = { device, dtype }
        loadedKey = key
        onStatus?.(`Voice model ready (${device}/${dtype})`, 1)
        return engineInfo
      } catch (e) {
        lastErr = e
        if (e instanceof Error && /stopped|cancelled/i.test(e.message)) throw e
      }
    }
    throw new Error(`Could not load the Kokoro voice model in this browser: ${lastErr instanceof Error ? lastErr.message : lastErr}`)
  })
}

async function workerGen(
  text: string,
  voice: string,
  speed: number,
): Promise<{ samples: Float32Array; rate: number }> {
  const m = await lane(() => callWorker<{ type: string; samples: unknown; rate: unknown }>({
    type: 'gen', text, voice, speed,
  }))
  const s = m.samples instanceof Float32Array ? m.samples : Float32Array.from(m.samples as ArrayLike<number>)
  const rate = typeof m.rate === 'number' && Number.isFinite(m.rate) && m.rate > 0 ? m.rate : VO_SAMPLE_RATE
  return { samples: s, rate }
}

/** Sentence-accurate block render: exact audio + text per sentence. */
async function workerGenBlock(
  text: string,
  voice: string,
  speed: number,
): Promise<{ pieces: { text: string; samples: Float32Array }[]; rate: number }> {
  const m = await lane(() => callWorker<{
    type: string
    pieces: { text: unknown; samples: unknown }[]
    rate: unknown
  }>({
    type: 'genblock', text, voice, speed,
  }))
  if (!Array.isArray(m.pieces) || !m.pieces.length) throw new Error('empty sentence stream')
  const rate = typeof m.rate === 'number' && Number.isFinite(m.rate) && m.rate > 0 ? m.rate : VO_SAMPLE_RATE
  return {
    rate,
    pieces: m.pieces
      .map(p => ({
        text: String(p.text ?? ''),
        samples: p.samples instanceof Float32Array ? p.samples : Float32Array.from(p.samples as ArrayLike<number>),
      }))
      .filter(p => p.samples.length > 0),
  }
}

/** Run the FX chain in the worker (keeps long-audio processing off the UI thread). */
export async function renderVoiceFx(
  samples: Float32Array,
  rate: number,
  fx: VoiceFxParams,
): Promise<FxResult> {
  const m = await lane(() => callWorker<{ type: string; samples: unknown; timeScale: unknown }>({
    type: 'fx', samples, rate, fx,
  }))
  const s = m.samples instanceof Float32Array ? m.samples : Float32Array.from(m.samples as ArrayLike<number>)
  const timeScale = typeof m.timeScale === 'number' && Number.isFinite(m.timeScale) && m.timeScale > 0 ? m.timeScale : 1
  return { samples: s, timeScale }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export function cancelVoiceover() {
  voiceoverAbort.aborted = true
  terminateVoiceEngine()
}

const voiceoverAbort = { aborted: false }

// ---------------------------------------------------------------------------
// Script chunking + full synthesis
// ---------------------------------------------------------------------------

/** Split prose into sentence-safe blocks, each <= maxChars. */
export function chunkScript(script: string, maxChars = MAX_BLOCK_CHARS): string[] {
  const clean = script.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  // split on sentence boundaries, keeping the punctuation
  const sentences = clean.match(/[^.!?…]+[.!?…]+["”']?\s*|[^.!?…]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [clean]
  const blocks: string[] = []
  let cur = ''
  const push = (text: string) => {
    if (text) blocks.push(text)
  }
  for (const s of sentences) {
    if (s.length > maxChars) {
      // one huge sentence: hard-split on commas/clauses, then words
      if (cur) { push(cur); cur = '' }
      const parts = s.match(/[^,;:]+[,;:]?\s*|[^,;:]+$/g)?.map(x => x.trim()).filter(Boolean) ?? [s]
      let acc = ''
      for (const part of parts) {
        if ((acc + ' ' + part).trim().length <= maxChars) {
          acc = (acc + ' ' + part).trim()
        } else {
          push(acc)
          acc = part
          // still too long (no punctuation at all): chop by words
          while (acc.length > maxChars) {
            const words = acc.split(' ')
            let cut = ''
            while (words.length && (cut + ' ' + words[0]).trim().length <= maxChars) cut = (cut + ' ' + words.shift()).trim()
            if (!cut) cut = words.shift() ?? ''
            push(cut)
            acc = words.join(' ')
          }
        }
      }
      if (acc) push(acc)
      continue
    }
    if ((cur + ' ' + s).trim().length <= maxChars) {
      cur = (cur + ' ' + s).trim()
    } else {
      push(cur)
      cur = s
    }
  }
  push(cur)
  return blocks.filter(b => b.length > 0)
}

/** One synthesized sentence with its exact placed span (seconds, VO-relative). */
export interface VoiceSentence {
  text: string
  start: number
  end: number
}

export interface VoiceBlock {
  text: string
  start: number
  end: number
  duration: number
  /** exact per-sentence spans — captions subdivide these, never the whole block */
  sentences: VoiceSentence[]
}

/** Small glue pause between sentences inside a block (block gaps use pauseSec). */
export const SENTENCE_GAP_SEC = 0.08

export interface VoiceoverResult {
  samples: Float32Array
  sampleRate: number
  duration: number
  blocks: VoiceBlock[]
  blob: Blob
  url: string
  peaks: number[]
  voice: string
  speed: number
  script: string
  engine: EngineInfo
}

export interface VoiceoverOptions {
  voice: string
  speed: number
  pauseSec: number
  quality: VoQuality
  onStatus?: (msg: string, progress: number | null) => void
  onBlock?: (done: number, total: number) => void
}

/** Rough narration rate for time estimates (chars/sec at 1.0x). */
export function estimateSeconds(script: string, speed: number): number {
  const chars = script.trim().length
  if (!chars) return 0
  return chars / 14.5 / Math.max(0.25, speed)
}

/**
 * Synthesize the FULL script: chunk -> sequential worker-side generate ->
 * concat with a natural pause between blocks. Works for scripts of any
 * length; the main thread only awaits messages, so the page stays alive.
 */
export async function generateVoiceover(script: string, opts: VoiceoverOptions): Promise<VoiceoverResult> {
  const clean = sanitizeForTTS(script)
  if (!clean) throw new Error('The script is empty.')
  const blocks = chunkScript(clean)
  if (!blocks.length) throw new Error('The script is empty.')
  voiceoverAbort.aborted = false
  let engine: EngineInfo
  try {
    engine = await ensureVoiceModel(opts.quality, opts.onStatus)
  } catch (e) {
    if (voiceoverAbort.aborted) {
      voiceoverAbort.aborted = false
      throw new Error('Voiceover cancelled')
    }
    throw e
  }

  // segments in final order: audio pieces + silence gaps (zeros when rendered)
  type Seg = { kind: 'a'; s: Float32Array } | { kind: 's'; n: number }
  const segs: Seg[] = []
  const infos: VoiceBlock[] = []
  let rate = VO_SAMPLE_RATE
  let o = 0
  const pauseOf = () => Math.round(Math.max(0, opts.pauseSec) * rate)
  const gapOf = () => Math.round(SENTENCE_GAP_SEC * rate)
  opts.onStatus?.(`Synthesizing 0/${blocks.length} blocks…`, 0)
  try {
    for (let i = 0; i < blocks.length; i++) {
      if (voiceoverAbort.aborted) throw new Error('Voiceover cancelled')
      let pieces: { text: string; samples: Float32Array }[]
      try {
        const r = await workerGenBlock(blocks[i], opts.voice, opts.speed)
        rate = r.rate
        pieces = r.pieces
      } catch (e) {
        if (voiceoverAbort.aborted) throw new Error('Voiceover cancelled')
        // fallback: whole block as one span (previous behavior)
        const single = await workerGen(blocks[i], opts.voice, opts.speed)
        rate = single.rate
        pieces = [{ text: blocks[i], samples: single.samples }]
      }
      const blockStart = o / rate
      const sentences: VoiceSentence[] = []
      pieces.forEach((p, j) => {
        const start = o / rate
        segs.push({ kind: 'a', s: p.samples })
        o += p.samples.length
        const end = o / rate
        sentences.push({ text: p.text, start, end })
        if (j < pieces.length - 1) {
          const n = gapOf()
          segs.push({ kind: 's', n })
          o += n
        }
      })
      const blockEnd = o / rate
      infos.push({ text: blocks[i], start: blockStart, end: blockEnd, duration: blockEnd - blockStart, sentences })
      if (i < blocks.length - 1) {
        const n = pauseOf()
        segs.push({ kind: 's', n })
        o += n
      }
      opts.onBlock?.(i + 1, blocks.length)
      opts.onStatus?.(`Synthesizing ${i + 1}/${blocks.length} blocks…`, (i + 1) / blocks.length)
      // let the UI paint between blocks (main thread is free anyway; cheap safety)
      await new Promise(r2 => setTimeout(r2, 0))
    }
  } catch (e) {
    if (voiceoverAbort.aborted) {
      voiceoverAbort.aborted = false
      throw new Error('Voiceover cancelled')
    }
    throw e
  }

  const total = o
  const samples = new Float32Array(total)
  let w = 0
  for (const sg of segs) {
    if (sg.kind === 'a') {
      samples.set(sg.s, w)
      w += sg.s.length
    } else {
      w += sg.n // silence = zeros, already in place
    }
  }

  const blob = encodeWav(samples, rate)
  const url = URL.createObjectURL(blob)
  return {
    samples, sampleRate: rate, duration: total / rate,
    blocks: infos, blob, url, peaks: peaksOf(samples, 220),
    voice: opts.voice, speed: opts.speed, script: clean, engine,
  }
}

/** Short preview render for voice shopping (single sanitized block). */
export async function previewVoice(voice: string, speed: number, quality: VoQuality, text?: string): Promise<{ url: string; blob: Blob; duration: number }> {
  await ensureVoiceModel(quality)
  if (voiceoverAbort.aborted) {
    voiceoverAbort.aborted = false
    throw new Error('Voiceover cancelled')
  }
  const clean = sanitizeForTTS(text ?? DEFAULT_PREVIEW_TEXT) || DEFAULT_PREVIEW_TEXT
  const line = chunkScript(clean)[0] ?? clean
  try {
    const { samples, rate } = await workerGen(line, voice, speed)
    const blob = encodeWav(samples, rate)
    return { url: URL.createObjectURL(blob), blob, duration: samples.length / rate }
  } catch (e) {
    if (voiceoverAbort.aborted) {
      voiceoverAbort.aborted = false
      throw new Error('Voiceover cancelled')
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

export interface CaptionCue {
  text: string
  words: string[]
  start: number
  end: number
}

/**
 * Build caption cues from exact sentence spans. Character-weighting is only
 * ever applied WITHIN a single sentence (a second or two), so rate drift
 * can't accumulate — cues hug the real speech, and inter-sentence pauses
 * naturally fall between cues instead of inside them.
 */
export function buildCaptions(blocks: VoiceBlock[], maxWords = 8): CaptionCue[] {
  const cues: CaptionCue[] = []
  const pushUnit = (text: string, start: number, end: number) => {
    const words = text.split(/\s+/).filter(Boolean)
    const dur = end - start
    if (!words.length || dur <= 0.05) return
    const totalChars = text.length || 1
    let acc = 0
    for (let i = 0; i < words.length; i += maxWords) {
      const slice = words.slice(i, i + maxWords)
      const sliceLen = slice.join(' ').length
      const cs = start + (acc / totalChars) * dur
      acc += sliceLen + 1
      const ce = start + (Math.min(totalChars, acc - 1) / totalChars) * dur
      cues.push({
        text: slice.join(' '),
        words: slice,
        start: cs,
        end: Math.max(cs + 0.3, ce),
      })
    }
  }
  for (const b of blocks) {
    if (b.sentences && b.sentences.length) {
      for (const s of b.sentences) pushUnit(s.text, s.start, s.end)
    } else {
      pushUnit(b.text, b.start, b.end)
    }
  }
  // fix rounding overlaps
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i].start = cues[i - 1].end
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3
  }
  return cues
}

// ---------------------------------------------------------------------------
// Preview bank (all voices pre-generated, persisted to IndexedDB)
// ---------------------------------------------------------------------------

const bankUrls = new Map<string, string>()

interface BankRun {
  paramsKey: string
  aborted: boolean
  progress: BankProgress
  listeners: Set<(p: BankProgress) => void>
  done: Promise<void>
}
let currentRun: BankRun | null = null

export function cancelPreviewBank() {
  if (currentRun) currentRun.aborted = true
}

function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function bankKey(voice: string, speed: number, previewText: string, quality: VoQuality): string {
  return [voice, speed.toFixed(2), hashStr(previewText), quality.engine, quality.quality].join('|')
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open('handscribe-vo', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('previews')) req.result.createObjectStore('previews')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    } catch (e) {
      reject(e)
    }
  })
}

async function idbGet(key: string): Promise<Blob | undefined> {
  try {
    const db = await idbOpen()
    return await new Promise((resolve) => {
      const tx = db.transaction('previews', 'readonly')
      const rq = tx.objectStore('previews').get(key)
      rq.onsuccess = () => resolve((rq.result as Blob | undefined) ?? undefined)
      rq.onerror = () => resolve(undefined)
      tx.oncomplete = () => db.close()
    })
  } catch {
    return undefined
  }
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  try {
    const db = await idbOpen()
    await new Promise<void>((resolve) => {
      const tx = db.transaction('previews', 'readwrite')
      tx.objectStore('previews').put(blob, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    db.close()
  } catch { /* memory-only fallback */ }
}

/** Instant (synchronous) lookup — returns the blob URL if already banked. */
export function getBankUrl(key: string): string | null {
  return bankUrls.get(key) ?? null
}

/** Cache an on-demand result into the bank (dedupe by key). */
export function bankStore(key: string, blob: Blob): string {
  const existing = bankUrls.get(key)
  if (existing) return existing
  const url = URL.createObjectURL(blob)
  bankUrls.set(key, url)
  void idbPut(key, blob)
  return url
}

export interface BankProgress { done: number; total: number; cached: number }

function broadcast(run: BankRun) {
  run.listeners.forEach(cb => {
    try {
      cb({ ...run.progress })
    } catch { /* listener errors must not kill the bank */ }
  })
}

/**
 * Build the full preview bank: IndexedDB hits are instant, missing voices are
 * synthesized sequentially in the background worker. Safe to call repeatedly.
 */
export function ensurePreviewBank(
  quality: VoQuality,
  previewText: string,
  speed: number,
  onProgress?: (p: BankProgress) => void,
  onStatus?: (msg: string, progress: number | null) => void,
): Promise<void> {
  const clean = sanitizeForTTS(previewText) || DEFAULT_PREVIEW_TEXT
  // NOTE: keys always use the sanitized text — callers must do the same via
  // bankKey(id, speed, sanitizedText, quality), or lookups will always miss.
  const paramsKey = [speed.toFixed(2), hashStr(clean), quality.engine, quality.quality].join('|')
  if (currentRun && currentRun.paramsKey === paramsKey && !currentRun.aborted) {
    // re-entrant (StrictMode remounts, repeated clicks): attach, don't restart
    if (onProgress) {
      currentRun.listeners.add(onProgress)
      try {
        onProgress({ ...currentRun.progress })
      } catch { /* noop */ }
    }
    return currentRun.done
  }
  if (currentRun) currentRun.aborted = true
  const run: BankRun = {
    paramsKey,
    aborted: false,
    progress: { done: 0, total: VOICES.length, cached: 0 },
    listeners: new Set(),
    done: Promise.resolve(),
  }
  if (onProgress) run.listeners.add(onProgress)
  const line = chunkScript(clean)[0] ?? clean
  run.done = (async () => {
    await ensureVoiceModel(quality, onStatus)
    let firstError: unknown = null
    for (const v of VOICES) {
      if (run.aborted) break
      const key = bankKey(v.id, speed, clean, quality)
      try {
        if (bankUrls.has(key)) {
          run.progress.cached++
        } else {
          const stored = await idbGet(key)
          if (run.aborted) break
          if (stored) {
            bankUrls.set(key, URL.createObjectURL(stored))
            run.progress.cached++
          } else {
            const { samples, rate } = await workerGen(line, v.id, speed)
            if (run.aborted) break
            const blob = encodeWav(samples, rate)
            bankUrls.set(key, URL.createObjectURL(blob))
            void idbPut(key, blob)
          }
        }
      } catch (e) {
        // background pass: record and stop instead of crashing the UI.
        // A terminated engine (user cancelled a full render) stops quietly.
        if (run.aborted) break
        if (e instanceof Error && /stopped|cancelled/i.test(e.message)) break
        if (!firstError) firstError = e
        break
      }
      run.progress.done++
      broadcast(run)
    }
    if (firstError && !run.aborted && run.progress.done < run.progress.total) {
      throw firstError
    }
  })().finally(() => {
    if (currentRun === run) currentRun = null
  })
  currentRun = run
  return run.done
}

// ---------------------------------------------------------------------------
// Audio utils
// ---------------------------------------------------------------------------

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const n = samples.length
  const buffer = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  writeStr(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export function peaksOf(samples: Float32Array, buckets = 220): number[] {
  const out: number[] = []
  const per = Math.max(1, Math.floor(samples.length / buckets))
  for (let i = 0; i < buckets; i++) {
    let peak = 0
    const start = i * per
    for (let j = start; j < Math.min(samples.length, start + per); j += 13) {
      const v = Math.abs(samples[j])
      if (v > peak) peak = v
    }
    out.push(Math.min(1, peak * 1.25))
  }
  return out.length ? out : [0.2]
}

export function downloadVoiceover(result: VoiceoverResult, filename?: string) {
  const a = document.createElement('a')
  a.href = result.url
  a.download = filename ?? `voiceover-${result.voice}-${Date.now()}.wav`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 2000)
}
