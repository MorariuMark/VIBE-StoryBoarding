/**
 * voiceover — local AI narration with Kokoro-82M, served by the
 * project-local voice server (server/python/audio8_server.py).
 *
 * This is a from-scratch remake of the old in-browser kokoro-js path. The
 * browser stack proved unfixable in the field: cached weights and voice
 * vectors could silently corrupt (flaky downloads with no checksum), and
 * every voice would come out as static/buzz with no error. The server runs
 * the official torch voices with verified project-local files, self-tests
 * every startup (see /health -> kokoro.selftest), and every render here is
 * measurable — garbage output cannot hide anymore.
 *
 * Flow: script -> sentence-safe blocks (<= MAX_BLOCK_CHARS) -> one server
 * synth per SENTENCE (exact per-sentence audio -> captions stay glued to the
 * true speech) -> crossfade-joined with the pause between blocks.
 */
import type { VoiceFxParams, FxResult } from './voiceFx.ts'
import { applyVoiceFx } from './voiceFx.ts'
import { trimSilence } from './voiceFx.ts'

export const VO_MODEL_ID = 'hexgrad/Kokoro-82M'
export const VO_SAMPLE_RATE = 24000
export const VO_MODEL_SIZE = '~330MB'
/**
 * Max characters sent to the model in a single synth call. Kokoro handles
 * long inputs, but short sentence calls give exact per-sentence timings for
 * captions — blocks stay <= this size, sentences inside them go whole.
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

/** Where Kokoro renders: the project-local voice server (auto = CUDA if present). */
export type KokoroDevice = 'auto' | 'cuda' | 'cpu'

export interface VoQuality {
  device: KokoroDevice
}

export interface EngineInfo {
  device: string
  dtype: string
}

/**
 * Scrub raw text into smooth TTS input:
 *  1. currency symbols jump behind the number ("$10" -> "10$"), which reads
 *     far more naturally than a leading symbol;
 *  2. markdown / code-ish symbols are removed or spaced out, "#" before a
 *     digit becomes "number" ("issue #5" -> "issue number 5");
 *  3. emoji and exotic symbols are stripped (they become garbage phonemes);
 *  4. anything else outside the speakable set is dropped as a safety net.
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

// ---------------------------------------------------------------------------
// Voice server client (Kokoro renders here — no in-browser inference left)
// ---------------------------------------------------------------------------

/** Base URL of the project-local voice server (same process serves Audio8). */
let voiceServerUrl = 'http://127.0.0.1:8010'

export function setVoiceServerUrl(url: string) {
  if (url) voiceServerUrl = url.replace(/\/+$/, '')
}

function serverBase(): string {
  return voiceServerUrl || 'http://127.0.0.1:8010'
}

/** In-flight request controller, so Cancel actually cancels. */
let activeCtrl: AbortController | null = null

async function kokoroPost(path: string, body: Record<string, unknown>): Promise<Response> {
  const ctrl = new AbortController()
  activeCtrl = ctrl
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    return res
  } finally {
    if (activeCtrl === ctrl) activeCtrl = null
  }
}

async function throwForBad(res: Response, prefix: string): Promise<never> {
  let detail = ''
  try {
    const j = (await res.json()) as { detail?: unknown }
    detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j)
  } catch {
    detail = await res.text().catch(() => '')
  }
  throw new Error(`${prefix}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}

export interface KokoroServerState {
  ready: boolean
  loading: boolean
  device: string
  dirMB: number | null
  selftest: { ok: boolean; rms: number; voicedRatio: number; ms: number } | null
  error: string | null
}

export async function kokoroServerState(): Promise<KokoroServerState> {
  const res = await fetch(`${serverBase()}/health`)
  if (!res.ok) throw new Error(`Voice server replied HTTP ${res.status} — start it with scripts\\start-audio8.bat`)
  const j = (await res.json()) as { kokoro?: Partial<KokoroServerState> }
  const k = j.kokoro ?? {}
  return {
    ready: k.ready ?? false,
    loading: k.loading ?? false,
    device: typeof k.device === 'string' ? k.device : 'unknown',
    dirMB: typeof k.dirMB === 'number' ? k.dirMB : null,
    selftest: k.selftest ?? null,
    error: typeof k.error === 'string' ? k.error : null,
  }
}

let engineInfo: EngineInfo | null = null
let loadedKey = ''

/** Hard-stop: abort the in-flight request and forget the engine state. */
export function terminateVoiceEngine() {
  try {
    activeCtrl?.abort()
  } catch { /* noop */ }
  activeCtrl = null
  engineInfo = null
  loadedKey = ''
}

export function getEngineInfo(): EngineInfo | null {
  return engineInfo
}

/**
 * Clear the Kokoro preview bank (in-memory + IndexedDB) and engine state.
 * There are no browser weights to nuke anymore — the server owns verified
 * files. Next use re-renders previews from the server.
 */
export async function resetKokoroModel(): Promise<void> {
  cancelPreviewBank()
  terminateVoiceEngine()
  for (const url of bankUrls.values()) {
    try {
      URL.revokeObjectURL(url)
    } catch { /* noop */ }
  }
  bankUrls.clear()
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('handscribe-vo')
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    })
  } catch { /* IndexedDB unavailable */ }
}

/** Serialize all server calls through one FIFO lane (no concurrent inference). */
let ttsLane: Promise<unknown> = Promise.resolve()
function lane<T>(fn: () => Promise<T>): Promise<T> {
  const run = ttsLane.then(fn, fn)
  ttsLane = run.catch(() => undefined)
  return run as Promise<T>
}

/**
 * Make sure the server-side Kokoro engine is ready. Triggers the load, then
 * polls /health until the startup self-test passes — so by the time this
 * resolves, the engine has PROVEN it renders speech, not static.
 */
export function ensureVoiceModel(
  quality: VoQuality,
  onStatus?: (msg: string, progress: number | null) => void,
): Promise<EngineInfo> {
  const key = `kokoro/${quality.device}`
  if (engineInfo && loadedKey === key) {
    return Promise.resolve(engineInfo)
  }
  return lane(async () => {
    if (engineInfo && loadedKey === key) return engineInfo
    onStatus?.('Starting Kokoro-82M on the voice server…', null)
    try {
      await kokoroPost('/api/kokoro/load', {})
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('Voiceover cancelled')
      throw new Error(`Voice server not reachable at ${serverBase()} — start it with scripts\\start-audio8.bat`)
    }
    const deadline = Date.now() + 5 * 60 * 1000
    for (;;) {
      let st: KokoroServerState
      try {
        st = await kokoroServerState()
      } catch {
        throw new Error(`Voice server not reachable at ${serverBase()} — start it with scripts\\start-audio8.bat`)
      }
      if (st.error) throw new Error(`Kokoro failed on the server: ${st.error}`)
      if (st.ready && st.selftest?.ok) {
        engineInfo = { device: st.device, dtype: 'fp32' }
        loadedKey = key
        onStatus?.(
          `Kokoro-82M ready (${st.device}/fp32, verified speech in ${st.selftest.ms}ms)`,
          1,
        )
        return engineInfo
      }
      if (Date.now() > deadline) throw new Error('Kokoro took too long to start (5 min) — see server logs')
      onStatus?.(
        st.selftest && !st.selftest.ok
          ? 'Kokoro self-test FAILED on the server — refusing to render (see server logs)'
          : 'Loading Kokoro-82M voice model on the server (first run downloads weights)…',
        null,
      )
      if (st.selftest && !st.selftest.ok) {
        throw new Error('Kokoro self-test failed: the server renders silence/static. See server logs.')
      }
      await new Promise(r => setTimeout(r, 2000))
    }
  })
}

/** One server synth call -> mono Float32 + rate. */
async function kokoroSynth(
  text: string,
  voice: string,
  speed: number,
  device: KokoroDevice,
): Promise<{ samples: Float32Array; rate: number }> {
  let res: Response
  try {
    res = await lane(() => kokoroPost('/api/kokoro/synth', { text, voice, speed, device }))
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('Voiceover cancelled')
    throw e
  }
  if (!res.ok) await throwForBad(res, 'Kokoro synthesis')
  const buf = await res.arrayBuffer()
  return parseWavPcm16(buf)
}

/**
 * Minimal WAV decoder for the server's PCM16 output. Deliberately NOT using
 * AudioContext: decoding must work everywhere (including contexts without an
 * audio device) and stay bit-exact for caption timing.
 */
export function parseWavPcm16(buf: ArrayBuffer): { samples: Float32Array; rate: number } {
  const v = new DataView(buf)
  const str = (off: number, len: number) => {
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i))
    return s
  }
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Kokoro server returned non-WAV audio')
  let pos = 12
  let fmt: { channels: number; rate: number; bits: number } | null = null
  let dataOff = -1
  let dataLen = 0
  while (pos + 8 <= v.byteLength) {
    const id = str(pos, 4)
    const len = v.getUint32(pos + 4, true)
    if (id === 'fmt ') {
      const audioFmt = v.getUint16(pos + 8, true)
      if (audioFmt !== 1) throw new Error(`Unsupported Kokoro WAV format (${audioFmt})`)
      fmt = { channels: v.getUint16(pos + 10, true), rate: v.getUint32(pos + 12, true), bits: v.getUint16(pos + 22, true) }
    } else if (id === 'data') {
      dataOff = pos + 8
      dataLen = len
    }
    pos += 8 + len + (len % 2)
  }
  if (!fmt || dataOff < 0) throw new Error('Malformed Kokoro WAV (no fmt/data)')
  if (fmt.bits !== 16) throw new Error(`Unsupported Kokoro WAV depth (${fmt.bits}-bit)`)
  const n = Math.floor(dataLen / 2 / fmt.channels)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let c = 0; c < fmt.channels; c++) {
      acc += v.getInt16(dataOff + (i * fmt.channels + c) * 2, true) / 32768
    }
    out[i] = acc / fmt.channels
  }
  return { samples: out, rate: fmt.rate }
}

/** Split text into sentences (Intl.Segmenter with a regex fallback). */
export function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  try {
    const Seg = (Intl as unknown as {
      Segmenter?: new (
        locale: string,
        opts: { granularity: string },
      ) => { segment(s: string): Iterable<{ segment: string }> }
    }).Segmenter
    if (typeof Seg === 'function') {
      const out: string[] = []
      const it = new Seg('en', { granularity: 'sentence' }).segment(text) as Iterable<{ segment: string }>
      for (const s of it) {
        const t = s.segment.trim()
        if (t) out.push(t)
      }
      if (out.length) return out
    }
  } catch { /* fallback below */ }
  return clean.match(/[^.!?…]+[.!?…]+["”']?\s*|[^.!?…]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [clean]
}

/** Sentence-accurate block render: exact audio + text per sentence. */
async function synthBlock(
  text: string,
  voice: string,
  speed: number,
  device: KokoroDevice,
): Promise<{ pieces: { text: string; samples: Float32Array }[]; rate: number }> {
  const pieces: { text: string; samples: Float32Array }[] = []
  let rate = VO_SAMPLE_RATE
  for (const sentence of splitSentences(text)) {
    if (voiceoverAbort.aborted) throw new Error('Voiceover cancelled')
    const { samples, rate: r } = await kokoroSynth(sentence, voice, speed, device)
    rate = r
    const trimmed = trimSilence(samples, r)
    if (trimmed.length > 0) pieces.push({ text: sentence, samples: trimmed })
  }
  if (!pieces.length) throw new Error('Kokoro returned no audio')
  return { pieces, rate }
}

/** Run the FX chain right here (pure DSP, fast enough for voiceover lengths). */
export async function renderVoiceFx(
  samples: Float32Array,
  rate: number,
  fx: VoiceFxParams,
): Promise<FxResult> {
  return applyVoiceFx(samples, rate, fx)
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
 * Synthesize the FULL script: chunk -> per-sentence server synth ->
 * crossfade-joined with a natural pause between blocks. Works for scripts of
 * any length; the page stays responsive because the heavy work is server-side
 * and the main thread only awaits fetches.
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
  const device = opts.quality.device

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
        const r = await synthBlock(blocks[i], opts.voice, opts.speed, device)
        rate = r.rate
        pieces = r.pieces
      } catch (e) {
        if (voiceoverAbort.aborted) throw new Error('Voiceover cancelled')
        // fallback: whole block as one span (previous behavior)
        const single = await kokoroSynth(blocks[i], opts.voice, opts.speed, device)
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
    const { samples, rate } = await kokoroSynth(line, voice, speed, quality.device)
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
  return [voice, speed.toFixed(2), hashStr(previewText), 'srv', quality.device].join('|')
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
 * synthesized sequentially on the voice server. Safe to call repeatedly.
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
  const paramsKey = [speed.toFixed(2), hashStr(clean), quality.device].join('|')
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
            const { samples, rate } = await kokoroSynth(line, v.id, speed, quality.device)
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
