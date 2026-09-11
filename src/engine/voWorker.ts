/**
 * voWorker — Kokoro-82M synthesis runs here, off the main thread, so long
 * renders can never freeze the page ("page unresponsive").
 *
 * Protocol (main thread drives, one call at a time via its FIFO lane):
 *   {type:'load', device, dtype}            -> {type:'ready'} (+ {type:'load-progress'} updates)
 *   {type:'gen', text, voice, speed}        -> {type:'chunk', samples, rate} (samples transferred)
 *   {type:'fx', samples, rate, fx}          -> {type:'fx-done', samples, timeScale} (transferred)
 *   any failure                             -> {type:'error', message}
 */
import { applyVoiceFx, trimSilence } from './voiceFx'
import type { VoiceFxParams } from './voiceFx'

/** Minimal worker-global shape (TS's DOM lib omits DedicatedWorkerGlobalScope). */
declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent) => void) | null
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

interface WorkerTTS {
  generate: (text: string, opts: { voice: string; speed?: number }) => Promise<{ audio: unknown; sampling_rate?: number }>
  stream: (input: unknown, opts: { voice: string; speed?: number }) => AsyncIterable<unknown>
}

interface SplitterCtor {
  new (): { push: (...texts: string[]) => void; close: () => void }
}

let tts: WorkerTTS | null = null
let loadedKey = ''
let splitterCtor: SplitterCtor | null = null

async function loadTts(dtype: string, device: string, id: number) {
  const key = `${device}/${dtype}`
  if (tts && loadedKey === key) return
  const mod = (await import('kokoro-js')) as unknown as {
    KokoroTTS: {
      from_pretrained: (
        modelId: string,
        opts: Record<string, unknown>,
      ) => Promise<WorkerTTS>
    }
  }
  const maybeSplitter = (mod as unknown as { TextSplitterStream?: SplitterCtor }).TextSplitterStream
  if (typeof maybeSplitter === 'function') splitterCtor = maybeSplitter
  tts = await mod.KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
      self.postMessage({
        type: 'load-progress',
        id,
        progress: typeof p?.progress === 'number' ? p.progress : null,
        status: p?.status ?? null,
        file: p?.file ?? null,
      })
    },
  })
  loadedKey = key
}

/** RawAudio ({audio, sampling_rate}) or a bare array — normalize to {data, rate}. */
function extractAudio(a: unknown): { data: unknown; rate: number } {
  if (a && typeof a === 'object' && 'audio' in (a as Record<string, unknown>)) {
    const r = a as { audio: unknown; sampling_rate?: unknown }
    return {
      data: r.audio,
      rate: typeof r.sampling_rate === 'number' && (r.sampling_rate as number) > 0 ? (r.sampling_rate as number) : 24000,
    }
  }
  return { data: a, rate: 24000 }
}

function toExactFloat32(audio: unknown): Float32Array {
  if (audio instanceof Float32Array) {
    // exact-size copy: the postMessage transfer below moves the whole buffer,
    // so the view must own it with no byteOffset games
    const out = new Float32Array(audio.length)
    out.set(audio)
    return out
  }
  if (Array.isArray(audio)) return Float32Array.from(audio as number[])
  if (audio && typeof audio === 'object' && 'data' in (audio as Record<string, unknown>)) {
    return toExactFloat32((audio as { data: unknown }).data)
  }
  throw new Error('TTS returned audio in an unknown format')
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as Record<string, unknown> & { id: number; type: string }
  void (async () => {
    try {
      if (m.type === 'load') {
        await loadTts(m.dtype as string, m.device as string, m.id)
        self.postMessage({ type: 'ready', id: m.id })
      } else if (m.type === 'gen') {
        if (!tts) throw new Error('Voice model not loaded')
        const out = await tts.generate(m.text as string, {
          voice: m.voice as string,
          speed: m.speed as number,
        })
        const samples = toExactFloat32(out.audio)
        const rate = typeof out.sampling_rate === 'number' && out.sampling_rate > 0 ? out.sampling_rate : 24000
        self.postMessage({ type: 'chunk', id: m.id, rate, samples }, [samples.buffer as ArrayBuffer])
      } else if (m.type === 'genblock') {
        // Sentence-accurate synthesis: stream the block sentence by sentence
        // (with kokoro's own abbreviation/number-aware splitter) and trim edge
        // silence per sentence, so caption spans hug the real speech.
        // NOTE: pass our own splitter + close() — a bare string never flushes
        // its trailing sentence upstream and the stream would hang.
        if (!tts) throw new Error('Voice model not loaded')
        if (!splitterCtor) throw new Error('sentence streaming unsupported by this kokoro-js build')
        const splitter = new splitterCtor()
        splitter.push(m.text as string)
        splitter.close()
        const pieces: { text: string; samples: Float32Array }[] = []
        let rate = 24000
        for await (const seg of tts.stream(splitter, { voice: m.voice as string, speed: m.speed as number })) {
          const s = seg as { text?: unknown; audio?: unknown }
          const { data, rate: r } = extractAudio(s.audio)
          rate = r
          pieces.push({ text: String(s.text ?? '').trim(), samples: trimSilence(toExactFloat32(data), rate) })
        }
        if (!pieces.length) throw new Error('no sentences synthesized')
        const transfers = pieces.map(p => p.samples.buffer as ArrayBuffer)
        self.postMessage({ type: 'blockdone', id: m.id, rate, pieces }, transfers)
      } else if (m.type === 'fx') {
        const input = toExactFloat32(m.samples)
        const { samples, timeScale } = applyVoiceFx(input, m.rate as number, m.fx as VoiceFxParams)
        self.postMessage({ type: 'fx-done', id: m.id, samples, timeScale }, [samples.buffer as ArrayBuffer])
      } else {
        throw new Error(`Unknown voice worker message: ${m.type}`)
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) })
    }
  })()
}
