import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptionAnim, EditorClip } from '../engine/editorTypes'
import { renderTextLayer } from '../engine/editorRender'
import { DEFAULT_VOICE_FX, type VoiceFxParams } from '../engine/voiceFx'
import {
  DEFAULT_PREVIEW_TEXT, MAX_BLOCK_CHARS, VOICES, VO_MODEL_SIZE, bankKey, bankStore, buildCaptions,
  cancelPreviewBank, cancelVoiceover, chunkScript, downloadVoiceover, encodeWav,
  ensurePreviewBank, estimateSeconds, generateVoiceover, getBankUrl, peaksOf, previewVoice,
  renderVoiceFx, resetKokoroModel, sanitizeForTTS, setVoiceServerUrl,
  type CaptionCue, type KokoroDevice, type VoiceBlock, type VoiceoverResult,
} from '../engine/voiceover'
import {
  AUDIO8_DEFAULT_URL, AUDIO8_LANGUAGES, AUDIO8_MAX_CHARS, AUDIO8_PRESET_VOICES,
  AUDIO8_SIZE_STT, AUDIO8_SIZE_TTS, KOKORO_SIZE_MODEL,
  audio8DeleteVoice, audio8Health, audio8ListVoices, audio8ReferenceFromFile, audio8SaveVoice,
  audio8SteadyAnchor, audio8Transcribe, audio8VoiceAudioUrl, chunkAudio8Script, formatBytes, formatDiskMB,
  generateAudio8Voiceover,
  type Audio8Health, type Audio8Language, type SavedVoice,
} from '../engine/audio8'

export interface CaptionStyle {
  fontSize: number
  color: string
  bg: string
  fontFamily: string
  posY: number
  anim: CaptionAnim
  hiColor: string
  maxWords: number
}

export interface VoiceoverInsert {
  name: string
  url: string
  naturalDuration: number
  peaks: number[]
  voiceLabel: string
  captions: CaptionCue[]
  captionStyle: CaptionStyle
  /** exact sentence spans — powers image auto-sync (no STT needed for TTS) */
  blocks: VoiceBlock[]
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 52,
  color: '#ffffff',
  bg: 'rgba(0,0,0,0.72)',
  fontFamily: 'Inter, system-ui, sans-serif',
  posY: 0.86,
  anim: 'karaoke',
  hiColor: '#fde047',
  maxWords: 8,
}

const FONTS = [
  'Inter, system-ui, sans-serif',
  'Georgia, serif',
  "'Courier New', monospace",
  'Impact, sans-serif',
  'Verdana, sans-serif',
]

type VoiceFilter = 'all' | 'female' | 'male' | 'American' | 'British'

export default function VoiceoverWindow({ onClose, onInsert }: {
  onClose: () => void
  onInsert: (ins: VoiceoverInsert) => void
}) {
  const [script, setScript] = useState('')
  const [voice, setVoice] = useState('af_heart')
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT)
  const [filter, setFilter] = useState<VoiceFilter>('all')
  const [speed, setSpeed] = useState(1)
  const [pause, setPause] = useState(0.45)
  const [kDevice, setKDevice] = useState<KokoroDevice>('auto')
  /** TTS backend: Kokoro runs 100% in-browser; Audio8 runs on a local CUDA GPU server. */
  const [backend, setBackend] = useState<'kokoro' | 'audio8'>('kokoro')
  const [a8Url, setA8Url] = useState(AUDIO8_DEFAULT_URL)
  const [a8Lang, setA8Lang] = useState<Audio8Language>('English')
  const [a8Temp, setA8Temp] = useState(0.8)
  const [a8TopP, setA8TopP] = useState(0.95)
  const [a8TopK, setA8TopK] = useState(50)
  const [a8MaxTok, setA8MaxTok] = useState(1024)
  const [a8Preset, setA8Preset] = useState('auto-female')
  const [a8RefText, setA8RefText] = useState('')
  const [a8RefB64, setA8RefB64] = useState<string | null>(null)
  const [a8RefMime, setA8RefMime] = useState<string | null>(null)
  const [a8RefName, setA8RefName] = useState<string | null>(null)
  const [a8RefBytes, setA8RefBytes] = useState<number | null>(null)
  const [a8Health, setA8Health] = useState<Audio8Health | null>(null)
  const [a8Checking, setA8Checking] = useState(false)
  /** Saved clone-voice library (project folder: models/audio8/voices/). */
  const [a8Voices, setA8Voices] = useState<SavedVoice[]>([])
  const [a8VoiceName, setA8VoiceName] = useState<string | null>(null)
  const [a8SaveName, setA8SaveName] = useState('')
  const [a8Transcribing, setA8Transcribing] = useState(false)
  const [a8Anchoring, setA8Anchoring] = useState<string | null>(null)
  const [modelMsg, setModelMsg] = useState('Preparing the voice bank — previews render on the local server…')
  const [modelPct, setModelPct] = useState<number | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genDone, setGenDone] = useState(0)
  const [genTotal, setGenTotal] = useState(0)
  const [result, setResult] = useState<VoiceoverResult | null>(null)
  const [bank, setBank] = useState({ done: 0, total: VOICES.length, cached: 0, active: false })
  const [, setBankTick] = useState(0)
  const [fx, setFx] = useState<VoiceFxParams>(DEFAULT_VOICE_FX)
  const [fxResult, setFxResult] = useState<VoiceoverResult | null>(null)
  const [fxWorking, setFxWorking] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [captionOn, setCaptionOn] = useState(true)
  const [capStyle, setCapStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE)
  const audioRef = useRef<HTMLAudioElement>(null)

  const blocks = useMemo(() => chunkScript(script), [script])
  const words = useMemo(() => script.trim().split(/\s+/).filter(Boolean).length, [script])
  const est = useMemo(() => estimateSeconds(script, speed), [script, speed])
  const voices = useMemo(() => VOICES.filter(v => {
    if (filter === 'all') return true
    if (filter === 'female' || filter === 'male') return v.gender === filter
    return v.accent === filter
  }), [filter])

  useEffect(() => {
    const prevent = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', prevent)
    return () => window.removeEventListener('keydown', prevent)
  }, [onClose])

  // revoke preview object URLs
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const quality = useMemo(() => ({ device: kDevice }), [kDevice])
  /** Sanitized preview line — bank keys MUST use this (raw text would never hit). */
  const cleanPreview = useMemo(() => sanitizeForTTS(previewText) || DEFAULT_PREVIEW_TEXT, [previewText])

  /** Build the full 28-voice preview bank in the background (IndexedDB-cached). */
  const kickBank = useCallback(() => {
    setBank(b => (b.active ? b : { ...b, active: true }))
    void ensurePreviewBank(
      quality,
      cleanPreview,
      speed,
      p => {
        setBank({ done: p.done, total: p.total, cached: p.cached, active: p.done < p.total })
      },
      (msg, p) => {
        // model download progress while the bank spins up
        setModelMsg(msg)
        setModelPct(prev => (p === null ? prev : p))
      },
    ).catch(e => {
      setModelMsg(e instanceof Error ? e.message : 'Preview bank failed')
    }).finally(() => {
      setBank(b => ({ ...b, active: false }))
      setBankTick(t => t + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality, cleanPreview, speed])

  // start the bank as soon as the studio opens; it keeps building in the
  // background (module-level) even if the window closes, so reopen is instant
  useEffect(() => {
    kickBank()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const playUrl = (url: string) => {
    const a = audioRef.current
    if (a) { a.src = url; void a.play().catch(() => undefined) }
  }

  const refreshA8Voices = useCallback(async () => {
    try {
      const list = await audio8ListVoices(a8Url)
      setA8Voices(list)
    } catch {
      setA8Voices([])
    }
  }, [a8Url])

  const checkA8 = useCallback(async () => {
    setA8Checking(true)
    try {
      const h = await audio8Health({ serverUrl: a8Url })
      setA8Health(h)
      setModelMsg(h.cudaAvailable
        ? `Audio8 GPU ready — ${h.device}/${h.dtype} · TTS ${formatDiskMB(h.modelDirMB)} on disk`
        : `Audio8 server reachable but NOT on GPU (${h.device}/${h.dtype}) — restart it with CUDA torch for GPU synthesis.`)
      setModelPct(h.cudaAvailable ? 1 : null)
      void refreshA8Voices()
    } catch (e) {
      setA8Health(null)
      setModelMsg(e instanceof Error
        ? `Audio8 server not reachable at ${a8Url}: ${e.message} — start it with scripts\\start-audio8.bat`
        : 'Audio8 server not reachable')
    } finally {
      setA8Checking(false)
    }
  }, [a8Url, refreshA8Voices])

  // Kokoro renders on the same project-local server as Audio8.
  useEffect(() => {
    setVoiceServerUrl(a8Url)
  }, [a8Url])

  // auto-probe the GPU server whenever the Audio8 backend is picked
  useEffect(() => {
    if (backend === 'audio8') void checkA8()
  }, [backend, checkA8])

  const onPreviewVoice = async (id: string) => {
    if (previewId) return
    if (backend === 'audio8') {
      // Audio8 has no 28-voice bank: synthesize the preview line on the GPU server.
      setPreviewId(id)
      setModelMsg(`Audio8 (GPU) rendering preview…`)
      setModelPct(null)
      try {
        const r = await generateAudio8Voiceover(cleanPreview, {
          serverUrl: a8Url, language: a8Lang, temperature: a8Temp, topP: a8TopP, topK: a8TopK,
          maxNewTokens: a8MaxTok, referenceAudioB64: a8RefB64, referenceAudioMime: a8RefMime,
          referenceText: a8RefText, voiceName: a8RefB64 ? null : a8VoiceName, pauseSec: 0,
          onStatus: (msg, p) => { setModelMsg(msg); setModelPct(p) },
        })
        const blob = encodeWav(r.samples, r.rate)
        const url = URL.createObjectURL(blob)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(url)
        setModelMsg(`Audio8 preview ready — ${r.rate / 1000}kHz GPU render`)
        setModelPct(1)
        setTimeout(() => playUrl(url), 30)
      } catch (e) {
        setModelMsg(e instanceof Error ? e.message : 'Audio8 preview failed')
      } finally {
        setPreviewId(null)
      }
      return
    }
    // instant path: pre-generated bank preview
    const hit = getBankUrl(bankKey(id, speed, cleanPreview, quality))
    if (hit) {
      setModelMsg(`Playing ${id} — preloaded preview`)
      playUrl(hit)
      return
    }
    // fallback: render on the spot (model already warm), then bank it
    setPreviewId(id)
    setModelMsg(`Rendering ${id} preview…`)
    setModelPct(null)
    try {
      const r = await previewVoice(id, speed, quality, cleanPreview)
      bankStore(bankKey(id, speed, cleanPreview, quality), r.blob)
      setBankTick(t => t + 1)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(r.url)
      setModelMsg('Voice model ready — preview playing')
      setModelPct(1)
      setTimeout(() => playUrl(r.url), 30)
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setPreviewId(null)
    }
  }

  /** STT: transcribe the reference clip and paste the words into the transcript box. */
  const onTranscribeRef = async () => {
    if (!a8RefB64 || a8Transcribing) return
    setA8Transcribing(true)
    setModelMsg('Transcribing reference clip (local faster-whisper STT)…')
    try {
      const text = await audio8Transcribe(a8Url, a8RefB64, a8RefMime, 'small')
      if (!text) {
        setModelMsg('STT heard no speech — try a cleaner clip.')
      } else {
        setA8RefText(text)
        setModelMsg(`Transcript filled by STT (${text.length} chars) — verify it matches the clip exactly, then Save voice.`)
      }
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : 'Transcription failed')
    } finally {
      setA8Transcribing(false)
    }
  }

  /** Save the current clip + transcript as a named voice in models/audio8/voices/. */
  const onSaveA8Voice = async () => {
    if (!a8RefB64 || !a8SaveName.trim() || !a8RefText.trim()) {
      setModelMsg('To save a voice: pick a clip, transcribe (or type) its exact words, name it, then Save.')
      return
    }
    try {
      const saved = await audio8SaveVoice(a8Url, a8SaveName.trim(), a8RefText.trim(), a8RefB64, a8RefMime)
      setA8SaveName('')
      setA8VoiceName(saved)
      await refreshA8Voices()
      const h = await audio8Health({ serverUrl: a8Url }).catch(() => null)
      if (h) setA8Health(h)
      setModelMsg(`Voice “${saved}” saved to models/audio8/voices/ — select it any time, no re-upload needed.`)
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : 'Save voice failed')
    }
  }

  const onDeleteA8Voice = async (name: string) => {
    try {
      await audio8DeleteVoice(a8Url, name)
      if (a8VoiceName === name) setA8VoiceName(null)
      await refreshA8Voices()
      setModelMsg(`Voice “${name}” deleted from the project folder.`)
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : 'Delete voice failed')
    }
  }

  /** Build a steady anchor from a saved voice (fixes rising-pitch narration). */
  const onSteadyA8Voice = async (name: string) => {
    if (a8Anchoring) return
    setA8Anchoring(name)
    setModelMsg(`Finding the flattest 10s passage in “${name}”…`)
    try {
      const out = await audio8SteadyAnchor(a8Url, name)
      setA8VoiceName(out.name)
      setA8RefB64(null); setA8RefMime(null); setA8RefName(null); setA8RefBytes(null)
      setA8RefText(out.transcript)
      await refreshA8Voices()
      setModelMsg(`“${out.name}” ready (from ${out.startSec}s in “${name}”) — narrate from this one: chunks join without the pitch resets.`)
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : 'Steady anchor failed')
    } finally {
      setA8Anchoring(null)
    }
  }

  const onGenerate = async () => {
    if (!script.trim() || generating) return
    if (backend === 'audio8') {
      // --- Audio8 0.6B path: local CUDA GPU server, 44.1kHz, all options ---
      if (a8RefB64 && !a8RefText.trim()) {
        setModelMsg('Audio8 voice cloning needs the exact reference transcript — press Transcribe or type it.')
        return
      }
      // A fresh upload overrides the library selection; the server resolves the rest.
      const useVoiceName = a8RefB64 ? null : a8VoiceName
      setGenerating(true)
      setResult(null)
      setFxResult(null)
      setGenDone(0)
      const bl = chunkAudio8Script(script)
      setGenTotal(bl.length)
      try {
        const h = await audio8Health({ serverUrl: a8Url }).catch(() => null)
        if (h) setA8Health(h)
        const r = await generateAudio8Voiceover(script, {
          serverUrl: a8Url, language: a8Lang, temperature: a8Temp, topP: a8TopP, topK: a8TopK,
          maxNewTokens: a8MaxTok, referenceAudioB64: a8RefB64, referenceAudioMime: a8RefMime,
          referenceText: a8RefText, voiceName: useVoiceName, pauseSec: pause,
          onStatus: (msg, p) => { setModelMsg(msg); setModelPct(p) },
          onBlock: (done) => setGenDone(done),
        })
        const blob = encodeWav(r.samples, r.rate)
        const url = URL.createObjectURL(blob)
        const preset = AUDIO8_PRESET_VOICES.find(v => v.id === a8Preset)
        const cloneLabel = a8RefB64 ? 'custom clip' : useVoiceName ? `“${useVoiceName}”` : null
        const result: VoiceoverResult = {
          samples: r.samples, sampleRate: r.rate, duration: r.samples.length / r.rate,
          blocks: r.chunks.map(c => ({
            text: c.text, start: c.start, end: c.end, duration: c.end - c.start,
            sentences: [{ text: c.text, start: c.start, end: c.end }],
          })),
          blob, url, peaks: peaksOf(r.samples, 220),
          voice: cloneLabel ? `audio8-clone` : `audio8-${a8Preset}`,
          speed, script: script.replace(/\s+/g, ' ').trim(),
          engine: { device: h?.device === 'cuda' ? 'webgpu' : (h?.device ?? 'gpu'), dtype: h?.dtype ?? 'bf16' },
        }
        setResult(result)
        setModelMsg(`Done — Audio8 GPU · ${bl.length} chunk${bl.length > 1 ? 's' : ''} · ${result.duration.toFixed(1)}s · ${a8Lang}${preset && !cloneLabel ? ` · ${preset.label}` : ''}${cloneLabel ? ` · cloned voice ${cloneLabel}` : ''}`)
      } catch (e) {
        setModelMsg(e instanceof Error ? e.message : 'Audio8 generation failed')
      } finally {
        setGenerating(false)
      }
      return
    }
    // pause the background bank so the full render gets the inference lane
    cancelPreviewBank()
    setBank(b => ({ ...b, active: false }))
    setGenerating(true)
    setResult(null)
    setFxResult(null)
    setGenDone(0)
    const bl = chunkScript(script)
    setGenTotal(bl.length)
    try {
      const r = await generateVoiceover(script, {
        voice, speed, pauseSec: pause, quality,
        onStatus: (msg, p) => { setModelMsg(msg); setModelPct(p) },
        onBlock: (done) => setGenDone(done),
      })
      setResult(r)
      setModelMsg(`Done — ${bl.length} block${bl.length > 1 ? 's' : ''} · ${r.duration.toFixed(1)}s of narration`)
    } catch (e) {
      setModelMsg(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
      // resume the background bank (skips everything already cached)
      kickBank()
    }
  }

  /** Render the FX chain on the main thread (pure DSP, tempo rescales timings). */
  const onApplyFx = () => {
    if (!result || fxWorking) return
    setFxWorking(true)
    void (async () => {
      try {
        const { samples, timeScale } = await renderVoiceFx(result.samples, result.sampleRate, fx)
        const blob = encodeWav(samples, result.sampleRate)
        const blocks = result.blocks.map(b => ({
          ...b,
          start: b.start * timeScale,
          end: b.end * timeScale,
          duration: b.duration * timeScale,
          sentences: b.sentences.map(s => ({ ...s, start: s.start * timeScale, end: s.end * timeScale })),
        }))
        setFxResult({
          ...result,
          samples,
          duration: result.duration * timeScale,
          blocks, blob,
          url: URL.createObjectURL(blob),
          peaks: peaksOf(samples, 220),
        })
        setModelMsg(`FX applied — pitch ${fx.pitch > 0 ? '+' : ''}${fx.pitch} st · tempo ${fx.tempo.toFixed(2)}× · reverb ${Math.round(fx.reverb * 100)}%`)
      } catch (e) {
        setModelMsg(e instanceof Error ? e.message : 'FX failed')
      } finally {
        setFxWorking(false)
      }
    })()
  }

  const shown = fxResult ?? result
  const captionCount = shown ? buildCaptions(shown.blocks, capStyle.maxWords).length : 0
  const voiceMeta = VOICES.find(v => v.id === voice)

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-2xl bg-zinc-950 border border-zinc-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/95 backdrop-blur rounded-t-2xl">
          <div className="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center text-xl">🎙️</div>
          <div>
            <h2 className="font-bold text-lg leading-none">AI Voiceover Studio</h2>
            <p className="text-xs text-zinc-400 mt-1">{backend === 'audio8' ? 'Audio8-TTS 0.6B · local CUDA GPU · zero-shot cloning' : 'Kokoro-82M · local voice server · speech-verified'}</p>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-800 border border-zinc-700" title="TTS backend">
            <button
              onClick={() => setBackend('kokoro')}
              className={`px-2.5 py-1.5 text-xs rounded-lg font-semibold ${backend === 'kokoro' ? 'bg-violet-600' : 'hover:bg-zinc-700 text-zinc-300'}`}
            >
              Kokoro
            </button>
            <button
              onClick={() => setBackend('audio8')}
              className={`px-2.5 py-1.5 text-xs rounded-lg font-semibold ${backend === 'audio8' ? 'bg-violet-600' : 'hover:bg-zinc-700 text-zinc-300'}`}
              title="Audio8 0.6B via local CUDA GPU server"
            >
              Audio8 0.6B ⚡GPU
            </button>
          </div>
          <div className="flex-1" />
          <span className="hidden md:block text-[11px] font-mono text-zinc-500 max-w-md truncate">{modelMsg}</span>
          <button onClick={onClose} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm" title="Close (Esc)">✕</button>
        </div>

        <div className="grid md:grid-cols-2 gap-4 p-5">
          {/* left: script + voices */}
          <div className="space-y-4">
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">1 · Script</h3>
                <span className="text-[11px] font-mono text-zinc-500">
                  {words} words · {script.trim().length} chars · ~{est.toFixed(0)}s · {blocks.length} block{blocks.length === 1 ? '' : 's'}
                </span>
              </div>
              <textarea
                value={script}
                onChange={e => setScript(e.target.value)}
                rows={9}
                placeholder={`Paste your narration script here — any length. Long scripts are split into sentence-safe blocks (≤ ${MAX_BLOCK_CHARS} chars) and stitched with a natural pause.`}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm leading-relaxed focus:outline-none focus:border-violet-500"
              />
              {blocks.length > 1 && (
                <p className="text-[11px] text-zinc-500 mt-1.5">
                  Split into {blocks.length} blocks: {blocks.map((b, i) => `Ⓑ${i + 1} ${b.length}ch`).join(' · ').slice(0, 160)}{blocks.length > 4 ? '…' : ''}
                </p>
              )}
              <p className="text-[11px] text-zinc-600 mt-1.5">
                ✨ Auto-cleaned for speech: * / &lt; &gt; ~ ` # and friends are scrubbed, prices like $10 read as “10$”.
              </p>
            </section>

            {backend === 'audio8' ? (
            <section className="p-3.5 rounded-xl bg-zinc-900/60 border border-violet-800/50 space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">2 · Audio8 voice + GPU server</h3>
              <div className="flex items-center gap-2 text-[11px] px-2.5 py-1.5 rounded-lg bg-zinc-800/70 border border-zinc-700">
                <span className={`w-2 h-2 rounded-full ${a8Health?.cudaAvailable ? 'bg-emerald-400' : a8Health ? 'bg-amber-400' : 'bg-zinc-600'}`} />
                <span className="text-zinc-300">
                  {a8Checking ? 'Probing GPU server…' : a8Health
                    ? (a8Health.cudaAvailable ? `⚡ GPU ${a8Health.device}/${a8Health.dtype}` : `CPU fallback ${a8Health.device}/${a8Health.dtype}`)
                    : 'Server not connected'}
                </span>
                <div className="flex-1" />
                <button onClick={() => void checkA8()} disabled={a8Checking} className="px-2 py-1 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-40 font-semibold">
                  {a8Checking ? '…' : 'Test'}
                </button>
              </div>
              <label className="block text-xs">
                <span className="text-zinc-400">GPU server URL</span>
                <input value={a8Url} onChange={e => setA8Url(e.target.value)} placeholder={AUDIO8_DEFAULT_URL}
                  className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-violet-500" />
              </label>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Start it once:                 <span className="font-mono text-zinc-300">scripts\setup-audio8.bat</span> once (venv + {AUDIO8_SIZE_TTS} TTS + {AUDIO8_SIZE_STT} STT, all into <span className="font-mono text-zinc-300">models\</span>), then{' '}
                <span className="font-mono text-zinc-300">scripts\start-audio8.bat</span>.
                No q8 WebGPU browser build of Audio8 exists — GPU here means CUDA on that server.
              </p>
              <p className="text-[11px] font-mono text-zinc-500">
                💾 On disk: TTS {formatDiskMB(a8Health?.modelDirMB)} (models\audio8) · STT {formatDiskMB(a8Health?.sttDirMB)} (models\stt) · voices {formatDiskMB(a8Health?.voicesMB)} ({a8Health?.voicesCount ?? 0})
              </p>
              <div className="space-y-1">
                {AUDIO8_PRESET_VOICES.map(v => (
                  <div key={v.id} onClick={() => setA8Preset(v.id)}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border cursor-pointer ${a8Preset === v.id && !a8RefB64 ? 'bg-violet-950/60 border-violet-500' : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-600'}`}>
                    <span className="text-sm">{v.gender === 'female' ? '🚺' : '🚹'}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{v.label}</span>
                      <span className="text-[11px] text-zinc-500 ml-2">{v.description}</span>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); void onPreviewVoice(v.id) }}
                      disabled={previewId !== null}
                      className="px-2 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-violet-700 border border-zinc-700 disabled:opacity-40"
                      title={`Preview ${v.label} on GPU`}
                    >
                      {previewId === v.id ? '⏳' : '🔊'}
                    </button>
                  </div>
                ))}
              </div>
              <div className="p-2.5 rounded-lg bg-zinc-800/60 border border-zinc-700 space-y-2">
                <div className="text-xs font-semibold text-zinc-200">🎭 Clone a voice — add, transcribe, save</div>
                <label className="block text-xs">
                  <span className="text-zinc-400">1 · Reference clip (5–15s clean speech{a8RefBytes ? <span className="font-mono text-zinc-500"> · {formatBytes(a8RefBytes)}</span> : ' · ≤8MB'})</span>
                  <input type="file" accept="audio/*" className="mt-1 w-full text-[11px] text-zinc-300"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      void audio8ReferenceFromFile(f).then(({ b64, mime }) => {
                        setA8RefB64(b64); setA8RefMime(mime); setA8RefName(f.name); setA8RefBytes(f.size)
                        setA8VoiceName(null)
                        setModelMsg(`Cloning voice from ${f.name} — press Transcribe to fill the exact words automatically.`)
                      }).catch(err => setModelMsg(err instanceof Error ? err.message : 'Reference read failed'))
                    }} />
                </label>
                {a8RefName && (
                  <div className="flex items-center gap-2 text-[11px] text-emerald-300">
                    <span>✓ {a8RefName} loaded — clones on generate</span>
                    <button onClick={() => { setA8RefB64(null); setA8RefMime(null); setA8RefName(null); setA8RefBytes(null) }} className="px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-200">clear</button>
                  </div>
                )}
                <label className="block text-xs">
                  <span className="text-zinc-400">2 · Exact transcript (what the clip says, word for word)</span>
                  <div className="mt-1 flex gap-1.5">
                    <input value={a8RefText} onChange={e => setA8RefText(e.target.value)} placeholder="Press Transcribe, or type the exact words…"
                      className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-violet-500" />
                    <button onClick={() => void onTranscribeRef()} disabled={!a8RefB64 || a8Transcribing}
                      className="shrink-0 px-2.5 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-xs font-semibold"
                      title="Speech-to-text the reference clip (local STT model) and paste the words here">
                      {a8Transcribing ? '⏳…' : '🎙 Transcribe'}
                    </button>
                  </div>
                </label>
                <div className="flex gap-1.5">
                  <input value={a8SaveName} onChange={e => setA8SaveName(e.target.value)} placeholder="3 · Name it, e.g. Morgan-narration"
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-violet-500" />
                  <button onClick={() => void onSaveA8Voice()} disabled={!a8RefB64 || !a8RefText.trim() || !a8SaveName.trim()}
                    className="shrink-0 px-2.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-xs font-semibold"
                    title="Save clip + transcript into models/audio8/voices/">
                    ＋ Save voice
                  </button>
                </div>
                {a8Voices.length > 0 && (
                  <div className="space-y-1 pt-1">
                    <div className="text-[11px] text-zinc-400 font-semibold">Saved voices ({a8Voices.length} · project folder)</div>
                    {a8Voices.map(v => {
                      const active = !a8RefB64 && a8VoiceName === v.name
                      return (
                        <div key={v.name} onClick={() => { setA8VoiceName(v.name); setA8RefB64(null); setA8RefMime(null); setA8RefName(null); setA8RefBytes(null); setA8RefText(v.transcript) }}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer ${active ? 'bg-violet-950/60 border-violet-500' : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-600'}`}>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-violet-400' : 'bg-zinc-700'}`} />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium">{v.name}</span>
                            <span className="text-[10px] text-zinc-500 font-mono ml-2">{formatBytes(v.sizeBytes)}</span>
                            <div className="text-[10px] text-zinc-500 truncate" title={v.transcript}>“{v.transcript.slice(0, 80)}{v.transcript.length > 80 ? '…' : ''}”</div>
                          </div>
                          <button onClick={e => { e.stopPropagation(); playUrl(audio8VoiceAudioUrl(a8Url, v.name)) }}
                            className="px-1.5 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-violet-700 border border-zinc-700" title="Play saved clip">🔊</button>
                          {!v.name.endsWith('-steady') && (
                            <button onClick={e => { e.stopPropagation(); void onSteadyA8Voice(v.name) }}
                              disabled={a8Anchoring !== null}
                              className="px-1.5 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-sky-700 border border-zinc-700 disabled:opacity-40"
                              title="Build a steady anchor from this voice: carves the flattest 10s passage so long narrations stop rising in pitch. Narrate from the -steady copy.">
                              {a8Anchoring === v.name ? '⏳' : ' steady'}
                            </button>
                          )}
                          <button onClick={e => { e.stopPropagation(); void onDeleteA8Voice(v.name) }}
                            className="px-1.5 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-red-700 border border-zinc-700" title="Delete from project folder">🗑</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <label className="block text-xs">
                <span className="text-zinc-400">Language <span className="font-mono text-zinc-500">(Preview supports 11)</span></span>
                <select value={a8Lang} onChange={e => setA8Lang(e.target.value as Audio8Language)} className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs">
                  {AUDIO8_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label className="block text-xs">
                <span className="text-zinc-400">Preview line <span className="font-mono text-zinc-500">({previewText.trim().length} chars, ≤{AUDIO8_MAX_CHARS} best)</span></span>
                <input value={previewText} onChange={e => setPreviewText(e.target.value)} maxLength={AUDIO8_MAX_CHARS}
                  placeholder={DEFAULT_PREVIEW_TEXT}
                  className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-violet-500" />
              </label>
              <audio ref={audioRef} className="hidden" />
            </section>
            ) : (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">2 · Voice ({VOICES.length})</h3>
                <div className="flex gap-1">
                  {(['all', 'female', 'male', 'American', 'British'] as VoiceFilter[]).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`px-2 py-1 text-[11px] rounded-lg border capitalize ${filter === f ? 'bg-violet-600 border-violet-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 mb-2 px-2.5 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800 text-[11px]">
                <span className="text-zinc-300 font-medium">
                  ⚡ Previews {bank.done}/{bank.total} ready · saved in app{bank.cached > 0 && bank.done < bank.total ? ` · ${bank.cached} instant` : ''}
                </span>
                <div className="flex-1" />
                {bank.active ? (
                  <button onClick={() => cancelPreviewBank()} className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">Cancel</button>
                ) : bank.done < bank.total ? (
                  <button onClick={kickBank} className="px-2 py-1 rounded-lg bg-violet-700 hover:bg-violet-600 border border-violet-600">↻ Render all now</button>
                ) : (
                  <span className="text-emerald-300 font-medium">✓ all instant</span>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                {voices.map(v => (
                  <div
                    key={v.id}
                    onClick={() => setVoice(v.id)}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border cursor-pointer transition ${voice === v.id ? 'bg-violet-950/60 border-violet-500' : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-600'}`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${voice === v.id ? 'bg-violet-400' : 'bg-zinc-700'}`} />
                    <span className="text-sm">{v.gender === 'female' ? '🚺' : '🚹'}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{v.label}</span>
                      <span className="text-[11px] text-zinc-500 font-mono ml-2">{v.id}</span>
                      {v.top && <span className="text-[10px] ml-1.5 px-1 rounded bg-amber-400/20 text-amber-300 font-bold">★ TOP</span>}
                      {getBankUrl(bankKey(v.id, speed, cleanPreview, quality)) && (
                        <span className="text-[10px] ml-1.5 text-emerald-300 font-bold" title="Preloaded — plays instantly">⚡</span>
                      )}
                    </div>
                    <GradeBadge grade={v.grade} />
                    <button
                      onClick={e => { e.stopPropagation(); void onPreviewVoice(v.id) }}
                      disabled={previewId !== null}
                      className="px-2 py-1 text-xs rounded-lg bg-zinc-800 hover:bg-violet-700 border border-zinc-700 disabled:opacity-40"
                      title={`Preview ${v.label}`}
                    >
                      {previewId === v.id ? '⏳' : '🔊'}
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-zinc-500 mt-1.5">Selected: <span className="text-zinc-200 font-mono">{voice}</span> ({voiceMeta?.accent} {voiceMeta?.gender}) · 🔊 previews with current speed</p>
              <label className="block mt-2 text-xs">
                <span className="text-zinc-400">Preview line <span className="font-mono text-zinc-500">({previewText.trim().length} chars)</span></span>
                <input
                  value={previewText}
                  onChange={e => setPreviewText(e.target.value)}
                  maxLength={MAX_BLOCK_CHARS}
                  placeholder={DEFAULT_PREVIEW_TEXT}
                  className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-violet-500"
                />
              </label>
              {/* hidden preview player */}
              <audio ref={audioRef} className="hidden" />
            </section>
            )}
          </div>

          {/* right: settings + generate + result + captions */}
          <div className="space-y-4">
            <section className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">3 · Settings</h3>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Speaking speed</span><span className="font-mono text-zinc-400">{speed.toFixed(2)}×</span></div>
                <input type="range" min={0.5} max={2} step={0.05} value={speed} onChange={e => setSpeed(+e.target.value)} className="w-full" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Pause between blocks</span><span className="font-mono text-zinc-400">{pause.toFixed(2)}s</span></div>
                <input type="range" min={0} max={1.5} step={0.05} value={pause} onChange={e => setPause(+e.target.value)} className="w-full" />
              </div>
              {backend === 'audio8' ? (
              <div className="space-y-2.5">
                <div className="text-[11px] text-zinc-400 font-semibold">Audio8 sampling — all upstream options</div>
                <div>
                  <div className="flex justify-between text-xs mb-1"><span>Temperature</span><span className="font-mono text-zinc-400">{a8Temp.toFixed(2)}</span></div>
                  <input type="range" min={0} max={1.5} step={0.05} value={a8Temp} onChange={e => setA8Temp(+e.target.value)} className="w-full" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Top-p</span><span className="font-mono text-zinc-400">{a8TopP.toFixed(2)}</span></div>
                    <input type="range" min={0.1} max={1} step={0.01} value={a8TopP} onChange={e => setA8TopP(+e.target.value)} className="w-full" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Top-k</span><span className="font-mono text-zinc-400">{a8TopK}</span></div>
                    <input type="range" min={1} max={200} step={1} value={a8TopK} onChange={e => setA8TopK(+e.target.value)} className="w-full" />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1"><span>Max new tokens</span><span className="font-mono text-zinc-400">{a8MaxTok}</span></div>
                  <input type="range" min={128} max={2048} step={32} value={a8MaxTok} onChange={e => setA8MaxTok(+e.target.value)} className="w-full" />
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  GPU synthesis via your local server (CUDA, 44.1kHz). Speed is fixed by the model — use Voice FX tempo after generation. Keep chunks ≤{AUDIO8_MAX_CHARS} chars (auto-split).
                </p>
                <p className="text-[11px] font-mono text-zinc-500">
                  💾 Selected: Audio8 0.6B TTS {AUDIO8_SIZE_TTS}{a8Health?.modelDirMB ? ` · on disk ${formatDiskMB(a8Health.modelDirMB)}` : ' · not downloaded yet'} + STT {AUDIO8_SIZE_STT}{a8Health?.sttDirMB ? ` · on disk ${formatDiskMB(a8Health.sttDirMB)}` : ''} (models\)
                </p>
              </div>
              ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs">
                  <span className="text-zinc-400">Render device</span>
                  <select value={kDevice} onChange={e => setKDevice(e.target.value as KokoroDevice)} className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs">
                    <option value="auto">Auto (CUDA if available)</option>
                    <option value="cuda">CUDA GPU</option>
                    <option value="cpu">CPU</option>
                  </select>
                </label>
                <div className="text-[11px] text-zinc-500 leading-relaxed self-end pb-1">
                  Full fp32 voices ({KOKORO_SIZE_MODEL}) — verified speech-tested on server start.
                </div>
              </div>
              )}
              <p className="text-[11px] font-mono text-zinc-500">
                {backend === 'audio8'
                  ? `💾 Selected: Audio8 0.6B ${AUDIO8_SIZE_TTS} + STT ${AUDIO8_SIZE_STT} (project folder models\\)`
                  : `💾 Selected: Kokoro-82M ${VO_MODEL_SIZE} full fp32 (project folder models\\hf-cache)`}
              </p>
              {backend === 'kokoro' && (
                <button
                  onClick={() => {
                    if (generating || previewId) return
                    setModelMsg('Clearing preview bank — re-rendering previews from the server…')
                    setModelPct(null)
                    void resetKokoroModel().then(() => {
                      setBank({ done: 0, total: VOICES.length, cached: 0, active: false })
                      setModelMsg('Bank cleared — rebuilding previews…')
                      kickBank()
                    }).catch(e => setModelMsg(e instanceof Error ? e.message : 'Reset failed'))
                  }}
                  disabled={generating || previewId !== null}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-800 border border-zinc-700 text-[11px] disabled:opacity-40"
                  title="Clears the preview bank (in-memory + IndexedDB) and re-renders all previews from the server."
                >
                  ↻ Rebuild previews
                </button>
              )}
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                {backend === 'audio8'
                  ? 'Audio8 runs on your CUDA GPU outside the browser — the page stays responsive while the server renders.'
                  : 'Kokoro renders on your local voice server (CUDA fp32 when available) — the page stays responsive while it renders.'}
              </p>
              {(modelPct !== null || generating) && (
                <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-violet-500 transition-all"
                    style={{ width: `${Math.round(((generating ? genDone / Math.max(1, genTotal) : (modelPct ?? 0)) * 100))}%` }}
                  />
                </div>
              )}
            </section>

            <section className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">4 · Generate</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => void onGenerate()}
                  disabled={!script.trim() || generating}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-violet-950"
                >
                  {generating ? `Synthesizing ${backend === 'audio8' ? 'chunk' : 'block'} ${genDone}/${genTotal}…` : backend === 'audio8' ? `⚡ Generate with Audio8 GPU${chunkAudio8Script(script).length > 1 ? ` (${chunkAudio8Script(script).length} chunks)` : ''}` : `🎙 Generate full voiceover${blocks.length > 1 ? ` (${blocks.length} blocks)` : ''}`}
                </button>
                {generating && (
                  <button onClick={() => cancelVoiceover()} className="px-3 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm">Cancel</button>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 leading-relaxed">{modelMsg}</p>
              {shown && (
                <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-emerald-200">
                      ✓ {shown.duration.toFixed(1)}s narration · {shown.blocks.length} blocks
                      <span className="ml-1.5 px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-200 font-bold font-mono" title="Device the voice was rendered on">
                        {shown.engine.device === 'cuda' || shown.engine.device === 'webgpu' ? '⚡ GPU' : 'CPU'} · {shown.engine.dtype}
                      </span>
                      {fxResult && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-violet-500/30 text-violet-200 font-bold">FX</span>}
                    </span>
                    <button onClick={() => downloadVoiceover(shown)} className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs">⬇ Export WAV</button>
                  </div>
                  <audio src={shown.url} controls className="w-full h-9" />
                </div>
              )}
            </section>

            <section className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">5 · Voice FX — pitch · tempo · reverb</h3>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <FxSlider label="Pitch" value={fx.pitch} min={-6} max={6} step={0.5} fmt={v => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`} onChange={v => setFx(s => ({ ...s, pitch: v }))} />
                <FxSlider label="Tempo" value={fx.tempo} min={0.5} max={2} step={0.05} fmt={v => `${v.toFixed(2)}×`} onChange={v => setFx(s => ({ ...s, tempo: v }))} />
                <FxSlider label="Reverb" value={fx.reverb} min={0} max={0.6} step={0.02} fmt={v => `${Math.round((v / 0.6) * 100)}%`} onChange={v => setFx(s => ({ ...s, reverb: v }))} />
                <FxSlider label="Room size" value={fx.room} min={0} max={1} step={0.05} fmt={v => `${Math.round(v * 100)}%`} onChange={v => setFx(s => ({ ...s, room: v }))} />
                <FxSlider label="Gain" value={fx.gain} min={0} max={2} step={0.05} fmt={v => `${Math.round(v * 100)}%`} onChange={v => setFx(s => ({ ...s, gain: v }))} />
                <div className="grid grid-cols-2 gap-2">
                  <FxSlider label="Fade in" value={fx.fadeIn} min={0} max={1.5} step={0.05} fmt={v => `${v.toFixed(2)}s`} onChange={v => setFx(s => ({ ...s, fadeIn: v }))} />
                  <FxSlider label="Fade out" value={fx.fadeOut} min={0} max={1.5} step={0.05} fmt={v => `${v.toFixed(2)}s`} onChange={v => setFx(s => ({ ...s, fadeOut: v }))} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-200">
                <input type="checkbox" checked={fx.normalize} onChange={e => setFx(s => ({ ...s, normalize: e.target.checked }))} className="accent-violet-500" />
                Normalize loudness
              </label>
              <div className="flex gap-2">
                <button
                  onClick={onApplyFx}
                  disabled={!result || fxWorking}
                  className="flex-1 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 font-semibold text-xs"
                >
                  {fxWorking ? 'Applying…' : fxResult ? '↻ Re-apply FX' : '✨ Apply FX'}
                </button>
                <button
                  onClick={() => { setFxResult(null); setFx(DEFAULT_VOICE_FX); }}
                  disabled={!fxResult && JSON.stringify(fx) === JSON.stringify(DEFAULT_VOICE_FX)}
                  className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs disabled:opacity-40"
                >
                  Reset
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">Tempo stretches the audio — caption timings follow automatically.</p>
            </section>

            <section className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={captionOn} onChange={e => setCaptionOn(e.target.checked)} className="accent-violet-500 w-4 h-4" />
                💬 Auto captions {shown ? <span className="text-xs text-zinc-400 font-normal">({captionCount} cues, sentence-accurate)</span> : <span className="text-xs text-zinc-500 font-normal">(timed from the true audio)</span>}
              </label>
              {captionOn && (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs">
                      <span className="text-zinc-400">Font</span>
                      <select value={capStyle.fontFamily} onChange={e => setCapStyle(s => ({ ...s, fontFamily: e.target.value }))} className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs">
                        {FONTS.map(f => <option key={f} value={f}>{f.split(',')[0]}</option>)}
                      </select>
                    </label>
                    <div>
                      <div className="flex justify-between text-xs mb-1"><span className="text-zinc-400">Size</span><span className="font-mono text-zinc-400">{capStyle.fontSize}px</span></div>
                      <input type="range" min={24} max={120} step={2} value={capStyle.fontSize} onChange={e => setCapStyle(s => ({ ...s, fontSize: +e.target.value }))} className="w-full" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-zinc-400">Text</span>
                    <input type="color" value={capStyle.color} onChange={e => setCapStyle(s => ({ ...s, color: e.target.value }))} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
                    <span className="text-zinc-400">Highlight</span>
                    <input type="color" value={capStyle.hiColor} onChange={e => setCapStyle(s => ({ ...s, hiColor: e.target.value }))} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
                    <label className="flex items-center gap-1.5 text-zinc-400">
                      <input type="checkbox" checked={capStyle.bg !== 'transparent'} onChange={e => setCapStyle(s => ({ ...s, bg: e.target.checked ? 'rgba(0,0,0,0.72)' : 'transparent' }))} className="accent-violet-500" /> Box
                    </label>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span className="text-zinc-400">Screen position</span><span className="font-mono text-zinc-400">{capStyle.posY < 0.3 ? 'top' : capStyle.posY > 0.7 ? 'bottom' : 'center'}</span></div>
                    <input type="range" min={0.1} max={0.92} step={0.01} value={capStyle.posY} onChange={e => setCapStyle(s => ({ ...s, posY: +e.target.value }))} className="w-full" />
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400 mb-1.5">Animation</div>
                    <div className="grid grid-cols-4 gap-1">
                      {(['none', 'fade', 'pop', 'karaoke'] as CaptionAnim[]).map(a => (
                        <button
                          key={a}
                          onClick={() => setCapStyle(s => ({ ...s, anim: a }))}
                          className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${capStyle.anim === a ? 'bg-violet-600 border-violet-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                          title={a === 'karaoke' ? 'Word-by-word highlight in sync with speech' : a}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span className="text-zinc-400">Words per caption</span><span className="font-mono text-zinc-400">{capStyle.maxWords}</span></div>
                    <input type="range" min={3} max={16} step={1} value={capStyle.maxWords} onChange={e => setCapStyle(s => ({ ...s, maxWords: +e.target.value }))} className="w-full" />
                  </div>
                  {/* live WYSIWYG preview — same renderer as the timeline, loops sample cues */}
                  <CaptionPreview style={capStyle} />
                </div>
              )}
            </section>

            <button
              onClick={() => {
                if (!shown) return
                const meta = VOICES.find(v => v.id === shown.voice)
                onInsert({
                  name: `🎙 VO ${meta?.label ?? shown.voice} — ${shown.script.slice(0, 32)}${shown.script.length > 32 ? '…' : ''}`,
                  url: shown.url,
                  naturalDuration: shown.duration,
                  peaks: shown.peaks,
                  voiceLabel: meta ? `${meta.label} (${shown.voice})` : shown.voice,
                  captions: captionOn ? buildCaptions(shown.blocks, capStyle.maxWords) : [],
                  captionStyle: capStyle,
                  blocks: shown.blocks,
                })
              }}
              disabled={!shown}
              className="w-full px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-emerald-950"
            >
              {shown ? `＋ Add to timeline (${shown.duration.toFixed(1)}s VO${captionOn ? ` + ${captionCount} captions` : ''})` : 'Generate a voiceover first'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Live WYSIWYG caption preview. Uses the exact timeline text renderer on an
 * offscreen 1920×1080 canvas (scaled down), looping through sample cues so
 * every style/animation change shows up instantly — including karaoke.
 */
function CaptionPreview({ style }: { style: CaptionStyle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const styleRef = useRef(style)
  styleRef.current = style
  const offRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const sample = 'This is how your captions will look and move on screen'
    const loop = (now: number) => {
      try {
        // idle while hidden (offsetParent is null under display:none)
        const cv0 = canvasRef.current
        if (!cv0 || cv0.offsetParent === null) return
        const st = styleRef.current
        const words = sample.split(' ')
        const cues: string[][] = []
        for (let i = 0; i < words.length; i += Math.max(1, st.maxWords)) cues.push(words.slice(i, i + Math.max(1, st.maxWords)))
        const CUE = 1.8
        const t = ((now - t0) / 1000) % (CUE * cues.length)
        const idx = Math.min(cues.length - 1, Math.floor(t / CUE))
        const local = t - idx * CUE
        const cue = cues[idx]
        if (!offRef.current) {
          offRef.current = document.createElement('canvas')
          offRef.current.width = 1920
          offRef.current.height = 1080
        }
        const clip: EditorClip = {
          id: -999, trackId: -1, kind: 'text', name: 'caption preview',
          start: 0, duration: CUE, offset: 0,
          volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0, muted: false,
          animIn: 'none', animInDur: 0.6, animOut: 'none', animOutDur: 0.6,
          payload: {
            kind: 'text',
            data: {
              text: cue.join(' '), preset: 'caption', fontSize: st.fontSize,
              color: st.color, bg: st.bg, fontFamily: st.fontFamily,
              anim: st.anim, posY: st.posY, words: cue, hiColor: st.hiColor,
            },
          },
        }
        const octx = offRef.current.getContext('2d')!
        renderTextLayer(octx, clip, local)
        const cv = canvasRef.current
        if (cv) {
          const ctx = cv.getContext('2d')!
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, cv.width, cv.height)
          ctx.drawImage(offRef.current, 0, 0, cv.width, cv.height)
        }
      } finally {
        raf = requestAnimationFrame(loop)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="rounded-lg overflow-hidden border border-zinc-700 bg-black aspect-video relative">
      <span className="absolute top-2 left-2 text-[10px] font-mono text-zinc-500 z-10">live caption preview</span>
      <canvas ref={canvasRef} width={480} height={270} className="w-full h-full block" />
    </div>
  )
}

function FxSlider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1"><span className="text-zinc-300">{label}</span><span className="font-mono text-zinc-400">{fmt(value)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} className="w-full" />
    </div>
  )
}

function GradeBadge({ grade }: { grade: string }) {
  const color = grade.startsWith('A') ? 'bg-emerald-400/20 text-emerald-300'
    : grade.startsWith('B') ? 'bg-sky-400/20 text-sky-300'
    : grade.startsWith('C') ? 'bg-amber-400/20 text-amber-300'
    : 'bg-zinc-700/60 text-zinc-400'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold font-mono ${color}`}>{grade}</span>
}
