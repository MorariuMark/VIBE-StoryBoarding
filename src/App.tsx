import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CANVAS_H, CANVAS_W, DEFAULT_SETTINGS, type BrushType, type RenderSettings, type RevealSource, type Stroke } from './engine/types'
import { parseSvgToStrokes } from './engine/svgParser'
import { compassLabel, orderStrokesDirectional, orderStrokesNatural, type OrderMode } from './engine/orderStrokes'
import { rasterToEdgeStrokes } from './engine/rasterEdges'
import { buildTimeline, fitCanvasToElement, renderFrame, resolveDurationFor, revealDurationFor } from './engine/renderer'
import { BRUSH_PRESETS, BrushEngine } from './engine/brush'
import { renderPaintedFinish, type PaintDensity, type PaintStyle } from './engine/paint'
import BgEditor from './components/BgEditor'
import { ModeTabs, ScrubBar } from './components/shared'
import ShowcaseMode from './components/ShowcaseMode'
import VideoEditor from './components/VideoEditor'
import type { AppMode } from './components/shared'
import { requestAddSceneToEditor, setWhiteboardSnapshot } from './engine/projectBridge'
import { createDefaultHand, loadImageFromFile, loadImageFromUrl } from './engine/hand'
import { cancelExport, downloadBlob, exportToMp4 } from './engine/exporter'
import { SAMPLES } from './engine/samples'

type Status = { kind: 'idle' | 'working' | 'error'; msg: string }

export default function App() {
  const [mode, setMode] = useState<AppMode>('whiteboard')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [fileName, setFileName] = useState('No file loaded — try a sample below')
  const [settings, setSettings] = useState<RenderSettings>(DEFAULT_SETTINGS)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: 'Ready' })
  const [cannyHigh, setCannyHigh] = useState(110)
  const [cannyLow, setCannyLow] = useState(40)
  const [detail, setDetail] = useState(640)
  const [cannyBlur, setCannyBlur] = useState(1)
  const [speckCleanup, setSpeckCleanup] = useState(6)
  const [minLineLen, setMinLineLen] = useState(8)
  const [gapJoin, setGapJoin] = useState(5)
  const [edgePreview, setEdgePreview] = useState<string | null>(null)
  const [handChoice, setHandChoice] = useState<'default' | 'none' | 'custom'>('default')
  const [exportPct, setExportPct] = useState<number | null>(null)
  const [hasReveal, setHasReveal] = useState(false)
  const [orderMode, setOrderMode] = useState<OrderMode>('directional')
  const [drawAngle, setDrawAngle] = useState(90)
  const [paintStyle, setPaintStyle] = useState<PaintStyle>('photo')
  const [paintSize, setPaintSize] = useState(9)
  const [paintDensity, setPaintDensity] = useState<PaintDensity>('med')
  const [pencilStrength, setPencilStrength] = useState(0.65)
  const [paintTick, setPaintTick] = useState(0)
  const [imageId, setImageId] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const modeRef = useRef<AppMode>('whiteboard')
  const handDefaultRef = useRef<HTMLCanvasElement | null>(null)
  const handCustomRef = useRef<HTMLImageElement | null>(null)
  const rafRef = useRef<number>(0)
  const lastTsRef = useRef<number>(0)
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const settingsRef = useRef(settings)
  const strokesRef = useRef<Stroke[]>([])
  const revealRef = useRef<RevealSource | null>(null)
  const loopErrLogged = useRef(false)
  const exportPctRef = useRef<number | null>(null)
  const procToken = useRef(0)
  const lastProcParams = useRef('')
  const rawRef = useRef<Stroke[]>([])
  const orderRef = useRef<{ mode: OrderMode; angle: number }>({ mode: 'directional', angle: 90 })
  const origRef = useRef<HTMLImageElement | null>(null)
  const origFileImgRef = useRef<HTMLImageElement | null>(null)
  const origFileBlobRef = useRef<Blob | null>(null)
  const [bgRemoved, setBgRemoved] = useState(false)
  const [bgWorking, setBgWorking] = useState(false)
  const [bgEditorOpen, setBgEditorOpen] = useState(false)
  const paintToken = useRef(0)
  const brushRef = useRef<BrushEngine | null>(null)
  const getBrush = () => (brushRef.current ??= new BrushEngine())

  timeRef.current = time
  playingRef.current = playing
  settingsRef.current = settings
  strokesRef.current = strokes
  exportPctRef.current = exportPct
  modeRef.current = mode
  orderRef.current = { mode: orderMode, angle: drawAngle }

  const revealSecs = (r: RevealSource | null, s: RenderSettings) => revealDurationFor(s, r)
  const resolveSecs = (r: RevealSource | null, s: RenderSettings) => resolveDurationFor(s, r)
  const timeline = useMemo(
    () => buildTimeline(strokes, settings.duration, 0.12, revealSecs(revealRef.current, settings), resolveSecs(revealRef.current, settings)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strokes, settings.duration, settings.revealPhoto, settings.revealDuration, settings.resolvePhoto, hasReveal, paintTick],
  )

  // init default hand once (+ optional ?sample=Name deep link for testing/sharing)
  useEffect(() => {
    handDefaultRef.current = createDefaultHand(320)
    const c = canvasRef.current
    if (c) fitCanvasToElement(c)
    const q = new URLSearchParams(window.location.search).get('sample')
    if (q) {
      const s = SAMPLES.find(x => x.name.toLowerCase() === q.toLowerCase())
      if (s) void loadSample(s.name, s.svg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // realtime render loop (self-healing: one bad frame must never kill playback)
  useEffect(() => {
    const loop = (ts: number) => {
      try {
        if (modeRef.current !== 'whiteboard') {
          lastTsRef.current = ts
          return
        }
        const dt = Math.min(0.1, lastTsRef.current ? (ts - lastTsRef.current) / 1000 : 0) * settingsRef.current.drawSpeed
        lastTsRef.current = ts
        if (playingRef.current) {
          let t = timeRef.current + dt
          if (t >= settingsRef.current.duration) { t = settingsRef.current.duration; playingRef.current = false; setPlaying(false) }
          timeRef.current = t
          setTime(t)
        }
        const canvas = canvasRef.current
        if (canvas) {
          const ctx = canvas.getContext('2d')!
          const hand: CanvasImageSource | null =
            handChoice === 'none' ? null : handChoice === 'custom' ? (handCustomRef.current as unknown as CanvasImageSource | null) : handDefaultRef.current
          const s = settingsRef.current
          const rvLoop = revealRef.current
          renderFrame(ctx, strokesRef.current, buildTimeline(strokesRef.current, s.duration, 0.12, revealDurationFor(s, rvLoop), resolveDurationFor(s, rvLoop)), timeRef.current, { ...s, showHand: handChoice !== 'none' }, hand, rvLoop, getBrush())
        }
      } catch (err) {
        if (!loopErrLogged.current) {
          loopErrLogged.current = true
          console.error('render loop frame failed (loop continues):', err)
          setStatus({ kind: 'error', msg: 'A frame failed to render — playback continues, check console.' })
        }
      } finally {
        rafRef.current = requestAnimationFrame(loop)
      }
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [handChoice])

  const applyStrokes = useCallback((raw: Stroke[], name: string, reveal: RevealSource | null = null) => {
    rawRef.current = raw
    const o = orderRef.current
    const ordered = o.mode === 'natural' ? orderStrokesNatural(raw) : orderStrokesDirectional(raw, o.angle)
    const label = o.mode === 'natural' ? 'nearest-neighbor order' : `${compassLabel(o.angle)} order`
    revealRef.current = reveal
    setHasReveal(!!reveal)
    setStrokes(ordered)
    setFileName(name)
    setTime(0); timeRef.current = 0
    setPlaying(true); playingRef.current = true
    setStatus({ kind: 'idle', msg: `${ordered.length} strokes · ${label}${reveal ? ' · photo finish armed' : ''}` })
  }, [])

  // Live re-order: mode/angle changes re-sequence the loaded drawing (no re-detection).
  useEffect(() => {
    if (!rawRef.current.length) return
    const ordered = orderMode === 'natural' ? orderStrokesNatural(rawRef.current) : orderStrokesDirectional(rawRef.current, drawAngle)
    setStrokes(ordered)
  }, [orderMode, drawAngle])

  const handleSvgFile = useCallback(async (file: File) => {
    try {
      setEdgePreview(null)
      origRef.current = null
      setStatus({ kind: 'working', msg: `Parsing ${file.name}…` })
      const text = await file.text()
      const raw = await parseSvgToStrokes(text)
      if (!raw.length) throw new Error('No drawable paths found (needs <path>/<line>/<polyline>/<polygon>/<rect>/<circle>).')
      applyStrokes(raw, file.name)
    } catch (e) {
      setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'SVG parse failed' })
    }
  }, [applyStrokes])

  /** Ingest a raster working image: detect edges, arm the reveal, restart playback. */
  const ingestRasterImage = useCallback(async (img: HTMLImageElement, name: string) => {
    const { strokes: raw, rect, edgePreview: preview } = await rasterToEdgeStrokes(img, {
      low: cannyLow, high: cannyHigh, maxDimension: detail,
      blur: cannyBlur, pruneLen: speckCleanup, minLen: minLineLen, joinGap: gapJoin,
    })
    lastProcParams.current = procKey(cannyLow, cannyHigh, detail, cannyBlur, speckCleanup, minLineLen, gapJoin)
    setEdgePreview(preview)
    origRef.current = img
    setImageId(id => id + 1)
    applyStrokes(raw, name, { img, rect, photo: img })
    if (raw.length < 15) {
      setStatus({ kind: 'idle', msg: `Only ${raw.length} edge strokes — sketch will look sparse. Try lowering Edge threshold (strong) or raising detail.` })
    } else if (raw.length > 1200) {
      setStatus({ kind: 'idle', msg: `${raw.length} edge strokes — very dense/noisy. Try raising Edge threshold (strong) or lowering detail.` })
    }
  }, [applyStrokes, cannyLow, cannyHigh, detail, cannyBlur, speckCleanup, minLineLen, gapJoin])

  const handleRasterFile = useCallback(async (file: File) => {
    try {
      setEdgePreview(null)
      setBgRemoved(false)
      setStatus({ kind: 'working', msg: `Detecting edges in ${file.name} (Canny ${cannyLow}/${cannyHigh})…` })
      const img = await loadImageFromFile(file)
      origFileImgRef.current = img
      origFileBlobRef.current = file
      await ingestRasterImage(img, file.name)
    } catch (e) {
      setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Raster processing failed' })
    }
  }, [ingestRasterImage, cannyLow, cannyHigh])

  /** Remove the photo background (ML cutout), then sketch the subject. */
  const onRemoveBg = useCallback(async () => {
    const blob = origFileBlobRef.current
    if (!blob || !origRef.current) {
      setStatus({ kind: 'error', msg: 'Load a photo first.' })
      return
    }
    try {
      setBgWorking(true)
      setStatus({ kind: 'working', msg: 'Loading background-removal model (first run downloads it, then it is cached)…' })
      const { removeBackground } = await import('@imgly/background-removal')
      const outBlob = (await removeBackground(blob, {
        progress: (key: string, current: number, total: number) => {
          setStatus({ kind: 'working', msg: `Removing background… ${key} ${Math.round((current / Math.max(1, total)) * 100)}%` })
        },
      })) as Blob
      const cutout = await loadImageFromUrl(URL.createObjectURL(outBlob))
      await ingestRasterImage(cutout, `${fileName} (cutout)`)
      setBgRemoved(true)
    } catch (e) {
      setStatus({ kind: 'error', msg: `Background removal failed${navigator.onLine === false ? ' (offline — the model downloads on first run)' : ''}: ${e instanceof Error ? e.message : e}` })
    } finally {
      setBgWorking(false)
    }
  }, [ingestRasterImage, fileName])

  /** Restore the original background. */
  const onRestoreBg = useCallback(async () => {
    const orig = origFileImgRef.current
    if (!orig) return
    setBgRemoved(false)
    await ingestRasterImage(orig, fileName.replace(' (cutout)', ''))
  }, [ingestRasterImage, fileName])

  /** Manual cutout from the wand/solid editor. */
  const onManualCutout = useCallback(async (cutout: HTMLImageElement, label: string) => {
    setBgEditorOpen(false)
    await ingestRasterImage(cutout, label)
    setBgRemoved(true)
  }, [ingestRasterImage])

  const onDropFile = useCallback((file: File) => {
    const ext = file.name.toLowerCase()
    if (ext.endsWith('.svg')) void handleSvgFile(file)
    else if (/\.(png|jpe?g|webp|bmp)$/.test(ext)) void handleRasterFile(file)
    else setStatus({ kind: 'error', msg: 'Unsupported file — drop an SVG, PNG or JPG.' })
  }, [handleSvgFile, handleRasterFile])

  const loadSample = useCallback(async (name: string, svg: string) => {
    try {
      setEdgePreview(null)
      origRef.current = null
      const raw = await parseSvgToStrokes(svg)
      applyStrokes(raw, `Sample: ${name}`)
    } catch (e) {
      setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Sample failed' })
    }
  }, [applyStrokes])

  // Paint finish: re-render the reveal bitmap when the photo or paint settings change.
  // The sketch strokes are untouched — only the finish bitmap swaps (no restart).
  useEffect(() => {
    const src = origRef.current
    const prev = revealRef.current
    if (!src || !prev) return
    if (paintStyle === 'photo') {
      if (revealRef.current?.img !== src) {
        revealRef.current = { img: src, rect: prev.rect, photo: src }
        setPaintTick(t => t + 1)
      }
      return
    }
    const id = ++paintToken.current
    const t = setTimeout(async () => {
      if (exportPctRef.current !== null) return
      setStatus({ kind: 'working', msg: `Rendering ${paintStyle === 'painting' ? 'painted' : 'pencil'} finish…` })
      try {
        const bmp = await renderPaintedFinish(src, {
          style: paintStyle,
          size: paintSize,
          density: paintDensity,
          pencilStrength,
        })
        if (paintToken.current !== id) return
        revealRef.current = { img: bmp, rect: prev.rect, photo: src }
        setPaintTick(tk => tk + 1)
        setStatus({ kind: 'idle', msg: `${strokesRef.current.length} strokes · ${paintStyle} finish ready` })
      } catch (e) {
        if (paintToken.current === id) {
          setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Paint render failed' })
        }
      }
    }, 500)
    return () => { paintToken.current++; clearTimeout(t) }
  }, [paintStyle, paintSize, paintDensity, pencilStrength, imageId])

  // Live re-process: Canny slider changes re-detect edges on the loaded photo
  // (debounced, stale runs discarded). Always runs on the ORIGINAL photo,
  // then the paint finish re-renders on top. No re-drop needed.
  useEffect(() => {
    const src = origRef.current
    if (!src) return
    // Fresh uploads already processed these exact params in their load handler.
    const key = procKey(cannyLow, cannyHigh, detail, cannyBlur, speckCleanup, minLineLen, gapJoin)
    if (lastProcParams.current === key) return
    const id = ++procToken.current
    const t = setTimeout(async () => {
      if (exportPctRef.current !== null) return
      try {
        await ingestRasterImage(src, fileName)
        // ingest bumps imageId -> paint finish re-renders over the new sketch
      } catch (e) {
        if (procToken.current === id) {
          setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Reprocessing failed' })
        }
      }
    }, 450)
    return () => { procToken.current++; clearTimeout(t) }
  }, [cannyHigh, cannyLow, detail, cannyBlur, speckCleanup, minLineLen, gapJoin, fileName, ingestRasterImage])

  const onExport = useCallback(async () => {
    if (!strokes.length) { setStatus({ kind: 'error', msg: 'Load an image first.' }); return }
    try {
      setExportPct(0)
      setStatus({ kind: 'working', msg: 'Rendering 1080p60 MP4 frame-by-frame…' })
      const hand: CanvasImageSource | null =
        handChoice === 'none' ? null : handChoice === 'custom' ? (handCustomRef.current as unknown as CanvasImageSource | null) : handDefaultRef.current
      const blob = await exportToMp4(strokes, { ...settings, showHand: handChoice !== 'none' }, hand, 60, (p) => {
        setExportPct(Math.round((p.frame / p.total) * 100))
      }, revealRef.current, new BrushEngine())
      downloadBlob(blob, `handscribe-${Date.now()}.mp4`)
      setStatus({ kind: 'idle', msg: `Exported ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4 · 1920×1080 @60fps` })
    } catch (e) {
      setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Export failed' })
    } finally {
      setExportPct(null)
    }
  }, [strokes, settings, handChoice])

  const set = <K extends keyof RenderSettings>(k: K, v: RenderSettings[K]) => setSettings(s => ({ ...s, [k]: v }))

  const fmt = (t: number) => `${t.toFixed(1)}s`

  /** Play: always replay the loaded image from zero with the current settings. */
  const onPlay = useCallback(() => {
    if (!strokes.length) { setStatus({ kind: 'error', msg: 'Load an image first, then press Play.' }); return }
    timeRef.current = 0
    setTime(0)
    lastTsRef.current = 0
    playingRef.current = true
    setPlaying(true)
    setStatus({ kind: 'idle', msg: `Playing ${fileName} — ${strokes.length} strokes${revealRef.current && settings.revealPhoto ? ' + color finish' : ''}` })
  }, [strokes, fileName, settings.revealPhoto])

  /** Pause / resume toggle (resuming at the end restarts). */
  const onPauseToggle = useCallback(() => {
    if (playingRef.current) {
      playingRef.current = false
      setPlaying(false)
    } else {
      if (!strokes.length) return
      if (timeRef.current >= settingsRef.current.duration - 0.001) {
        timeRef.current = 0
        setTime(0)
      }
      lastTsRef.current = 0
      playingRef.current = true
      setPlaying(true)
    }
  }, [strokes.length])

  /** Render a small before/after thumbnail (no hand). */
  const renderThumb = (atTime: number, withReveal: boolean): string | null => {
    if (!strokes.length) return null
    const s = settingsRef.current
    const rv = withReveal ? revealRef.current : null
    const tl = buildTimeline(strokesRef.current, s.duration, 0.12, revealDurationFor(s, rv), resolveDurationFor(s, rv))
    const engine = new BrushEngine()
    const full = document.createElement('canvas')
    full.width = CANVAS_W; full.height = CANVAS_H
    renderFrame(full.getContext('2d')!, strokesRef.current, tl, atTime, { ...s, showHand: false }, null, rv, engine)
    const th = document.createElement('canvas')
    th.width = 480; th.height = 270
    th.getContext('2d')!.drawImage(full, 0, 0, 480, 270)
    return th.toDataURL('image/jpeg', 0.82)
  }

  const beforePreview = useMemo(() => {
    if (!strokes.length) return null
    // raster: the true original upload; vector: the finished line art (live with pen settings)
    if (origFileImgRef.current) return origFileImgRef.current.src
    if (revealRef.current && typeof (revealRef.current.img as HTMLImageElement).src === 'string') {
      return (revealRef.current.img as HTMLImageElement).src
    }
    return renderThumb(settings.duration, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, hasReveal, settings, imageId])

  const onSeek = useCallback((t: number) => {
    const c = Math.min(settingsRef.current.duration, Math.max(0, t))
    timeRef.current = c
    setTime(c)
  }, [])

  /** Storyboard filmstrip: real rendered frames across the video.
   *  Pen settings apply on a short debounce so slider drags don't jank. */
  const THUMBS = 8
  const filmSettings = useDebouncedValue(settings, 300)
  const filmstrip = useMemo(() => {
    if (!strokes.length) return []
    const full = document.createElement('canvas')
    full.width = CANVAS_W; full.height = CANVAS_H
    const fctx = full.getContext('2d')!
    const rv = revealRef.current
    const tl = buildTimeline(strokes, filmSettings.duration, 0.12, revealDurationFor(filmSettings, rv), resolveDurationFor(filmSettings, rv))
    const engine = new BrushEngine()
    const out: { t: number; url: string; phase: string }[] = []
    for (let k = 0; k < THUMBS; k++) {
      const t = (filmSettings.duration * (k + 0.5)) / THUMBS
      renderFrame(fctx, strokes, tl, t, { ...filmSettings, showHand: false }, null, rv, engine)
      const th = document.createElement('canvas')
      th.width = 240; th.height = 135
      th.getContext('2d')!.drawImage(full, 0, 0, 240, 135)
      out.push({
        t,
        url: th.toDataURL('image/jpeg', 0.7),
        phase: tl.resolveStart !== null && t >= tl.resolveStart ? 'photo' : tl.revealStart !== null && t >= tl.revealStart ? 'color' : 'sketch',
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, filmSettings, hasReveal, paintTick])

  const activeThumb = strokes.length ? Math.min(THUMBS - 1, Math.floor((time / settings.duration) * THUMBS)) : -1
  const phaseLabel = !strokes.length
    ? 'empty'
    : time >= settings.duration - 0.001
      ? '✓ finished'
      : timeline.resolveStart !== null && time >= timeline.resolveStart
        ? '📷 photo'
        : timeline.revealStart !== null && time >= timeline.revealStart
          ? '🎨 coloring'
          : '✏️ sketching'

  // Live link: keep the editor's editable Whiteboard scene in sync with this tab.
  useEffect(() => {
    setWhiteboardSnapshot({ strokes, settings, reveal: revealRef.current, fileName })
  }, [strokes, settings, fileName, hasReveal, paintTick])

  /** Push the current sketch to the Editor as a live, editable scene clip. */
  const sendWhiteboardToEditor = useCallback(() => {
    if (!strokesRef.current.length) {
      setStatus({ kind: 'error', msg: 'Load an image first, then send it to the Editor.' })
      return
    }
    setWhiteboardSnapshot({ strokes: strokesRef.current, settings: settingsRef.current, reveal: revealRef.current, fileName })
    setMode('editor')
    // the editor mounts on the mode switch — deliver the add request just after
    setTimeout(() => requestAddSceneToEditor('whiteboard'), 120)
  }, [fileName])

  return (
    <>
      {/* All tabs stay mounted (hidden via display) so switching never loses progress.
          Hidden tabs idle their render loops and pause playback (see each tab). */}
      <div className="h-full" style={{ display: mode === 'showcase' ? undefined : 'none' }}>
        <ShowcaseMode mode={mode} onMode={setMode} />
      </div>
      <div className="h-full" style={{ display: mode === 'editor' ? undefined : 'none' }}>
        <VideoEditor mode={mode} onMode={setMode} />
      </div>
      <div className="h-full flex flex-col bg-zinc-950 text-zinc-100" style={{ display: mode === 'whiteboard' ? undefined : 'none' }}>
      {/* top bar */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900/70 backdrop-blur">
        <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-xl">✍️</div>
        <div>
          <h1 className="font-bold text-lg leading-none tracking-tight">HandScribe</h1>
          <p className="text-xs text-zinc-400">whiteboard hand-drawing animation studio</p>
        </div>
        <div className="flex-1" />
        <ModeTabs mode={mode} onMode={setMode} />
        <div className="hidden md:flex items-center gap-2 text-xs text-zinc-400">
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">1920×1080</span>
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">60 fps export</span>
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">{strokes.length} strokes</span>
        </div>
        <button
          onClick={sendWhiteboardToEditor}
          disabled={!strokes.length}
          title="Add this sketch to the Editor timeline as a live, editable scene (not a baked video)"
          className="ml-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-emerald-950"
        >
          🎬 Editor＋
        </button>
        <button
          onClick={() => void onExport()}
          disabled={!strokes.length || exportPct !== null}
          className="ml-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-indigo-950"
        >
          {exportPct !== null ? `Rendering ${exportPct}%…` : '⬇ Export MP4'}
        </button>
        {exportPct !== null && (
          <button onClick={() => cancelExport()} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm border border-zinc-700">Cancel</button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        {/* sidebar */}
        <aside className="w-80 shrink-0 border-r border-zinc-800 bg-zinc-900/50 p-4 overflow-y-auto space-y-5">
          {/* source */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">1 · Source image</h2>
            <Dropzone onFile={onDropFile} />
            <p className="text-xs text-zinc-500 mt-2 leading-relaxed">SVG → exact vector paths. PNG/JPG → Canny edge detection → vector sketch → photo reveal.</p>
            <div className="flex gap-2 mt-2 flex-wrap">
              {SAMPLES.map(s => (
                <button key={s.name} onClick={() => void loadSample(s.name, s.svg)} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">
                  {s.name}
                </button>
              ))}
            </div>
            {hasReveal && (
              <div className="flex gap-2 mt-2">
                {!bgRemoved ? (
                  <>
                    <button onClick={() => setBgEditorOpen(true)} className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Click the background (or any element) to remove it — wand or solid color">
                      🪄 Wand / solid
                    </button>
                    <button onClick={() => void onRemoveBg()} disabled={bgWorking} className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50" title="Cut out the subject with an on-device ML model (downloads on first run)">
                      ✂ {bgWorking ? 'Removing…' : 'AI remove'}
                    </button>
                  </>
                ) : (
                  <button onClick={() => void onRestoreBg()} disabled={bgWorking} className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50">
                    ↩ Restore background
                  </button>
                )}
              </div>
            )}
            <div className="mt-3 p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2">
              <div className="flex justify-between text-xs"><span className="text-zinc-300">Edge threshold (strong)</span><span className="text-zinc-400 font-mono">{cannyHigh}</span></div>
              <input type="range" min={40} max={220} value={cannyHigh} onChange={e => setCannyHigh(+e.target.value)} className="w-full" />
              <div className="flex justify-between text-xs"><span className="text-zinc-300">Detail threshold (weak)</span><span className="text-zinc-400 font-mono">{cannyLow}</span></div>
              <input type="range" min={10} max={150} value={cannyLow} onChange={e => setCannyLow(+e.target.value)} className="w-full" />
              <div className="flex justify-between text-xs items-center">
                <span className="text-zinc-300">Detection detail</span>
                <select value={detail} onChange={e => setDetail(+e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-xs">
                  <option value={480}>Standard</option>
                  <option value={640}>High</option>
                  <option value={800}>Ultra</option>
                </select>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Smoothing blur</span><span className="font-mono text-zinc-400">{cannyBlur.toFixed(1)}</span></div>
                <input type="range" min={0} max={2.5} step={0.1} value={cannyBlur} onChange={e => setCannyBlur(+e.target.value)} className="w-full" title="Blurs away paper texture and noise before detection — higher misses fine detail" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Speck cleanup</span><span className="font-mono text-zinc-400">{speckCleanup}px</span></div>
                <input type="range" min={0} max={12} step={1} value={speckCleanup} onChange={e => setSpeckCleanup(+e.target.value)} className="w-full" title="Prunes tiny side-ticks and spurs off the detected edges" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Min line length</span><span className="font-mono text-zinc-400">{minLineLen}px</span></div>
                <input type="range" min={0} max={40} step={1} value={minLineLen} onChange={e => setMinLineLen(+e.target.value)} className="w-full" title="Drops fragments shorter than this — clears dots and noise dashes" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Gap join</span><span className="font-mono text-zinc-400">{gapJoin}px</span></div>
                <input type="range" min={0} max={12} step={1} value={gapJoin} onChange={e => setGapJoin(+e.target.value)} className="w-full" title="Reconnects broken contour pieces across gaps up to this wide" />
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-300 pt-1">
                <input type="checkbox" checked={settings.revealPhoto} onChange={e => set('revealPhoto', e.target.checked)} className="accent-indigo-500" />
                Photo finish — hand paints the real image top-to-bottom
              </label>
              {settings.revealPhoto && (
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Reveal length</span><span className="font-mono text-zinc-400">{settings.revealDuration.toFixed(1)}s</span></div>
                    <input type="range" min={0.5} max={6} step={0.5} value={settings.revealDuration} onChange={e => set('revealDuration', +e.target.value)} className="w-full" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Color direction</span><span className="font-mono text-zinc-400">{settings.colorAngle}°</span></div>
                    <input type="range" min={0} max={359} step={1} value={settings.colorAngle} onChange={e => set('colorAngle', +e.target.value)} className="w-full" />
                    <div className="text-[11px] text-zinc-400">{compassLabel(settings.colorAngle)}</div>
                    <div className="grid grid-cols-8 gap-1 mt-1.5">
                      {[[0, '→'], [45, '↘'], [90, '↓'], [135, '↙'], [180, '←'], [225, '↖'], [270, '↑'], [315, '↗']].map(([deg, arrow]) => (
                        <button key={deg as number} onClick={() => set('colorAngle', deg as number)} className={`py-1 text-sm rounded-lg border ${settings.colorAngle === deg ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title={`${deg}°`}>{arrow as string}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-zinc-500">Sliders re-detect live — watch the sketch below update as you drag.</p>
              {edgePreview && (
                <div>
                  <div className="text-[11px] text-zinc-400 mb-1">Sketch — exactly what the hand will draw:</div>
                  <img src={edgePreview} alt="sketch preview large" className="w-full block rounded-lg border border-indigo-500/50 bg-white" />
                </div>
              )}
            </div>
          </section>

          {/* paint look */}
          <section className={hasReveal ? '' : 'opacity-50 pointer-events-none'}>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">🎨 Paint look</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-3">
              <div className="grid grid-cols-3 gap-1.5">
                {(['photo', 'painting', 'pencil'] as PaintStyle[]).map(v => (
                  <button key={v} onClick={() => setPaintStyle(v)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${paintStyle === v ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title={v === 'photo' ? 'Reveal the untouched photo' : v === 'painting' ? 'Impression-style painted finish' : 'Graphite pencil finish'}>{v}</button>
                ))}
              </div>
              {paintStyle === 'painting' && (
                <div className="space-y-2.5">
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Stroke size</span><span className="font-mono text-zinc-400">{paintSize}px</span></div>
                    <input type="range" min={3} max={20} step={1} value={paintSize} onChange={e => setPaintSize(+e.target.value)} className="w-full" />
                  </div>
                  <div>
                    <div className="text-xs mb-1.5">Strokes</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['low', 'med', 'high'] as PaintDensity[]).map(d => (
                        <button key={d} onClick={() => setPaintDensity(d)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${paintDensity === d ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}>{d}</button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input type="checkbox" checked={settings.resolvePhoto} onChange={e => set('resolvePhoto', e.target.checked)} className="accent-indigo-500" />
                    End on the real photo (paint dissolves to photo)
                  </label>
                </div>
              )}
              {paintStyle === 'pencil' && (
                <div>
                  <div className="flex justify-between text-xs mb-1"><span>Graphite strength</span><span className="font-mono text-zinc-400">{Math.round(pencilStrength * 100)}%</span></div>
                  <input type="range" min={0} max={100} value={Math.round(pencilStrength * 100)} onChange={e => setPencilStrength(+e.target.value / 100)} className="w-full" />
                </div>
              )}
              <p className="text-[11px] text-zinc-500">{hasReveal ? 'Finish renders once per image — Before/After, storyboard and export follow.' : 'Load a photo to enable painted finishes.'}</p>
            </div>
          </section>

          {/* before */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">✦ Preview</h2>
            <div className="rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800 aspect-video flex items-center justify-center">
              {beforePreview ? <img src={beforePreview} alt="before" className="w-full h-full object-cover" /> : <span className="text-[11px] text-zinc-500">before</span>}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1 text-center">Before — original</div>
          </section>

          {/* stroke order */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">◈ Stroke order</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-3">
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => setOrderMode('directional')} className={`px-2 py-1.5 text-xs rounded-lg border ${orderMode === 'directional' ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title="Draw row by row along one direction, like reading">↕ Sequential</button>
                <button onClick={() => setOrderMode('natural')} className={`px-2 py-1.5 text-xs rounded-lg border ${orderMode === 'natural' ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title="Each stroke follows the nearest unvisited one (shortest hand travel)">✦ Nearest</button>
              </div>
              {orderMode === 'directional' && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs"><span className="text-zinc-300">Draw direction</span><span className="font-mono text-zinc-400">{drawAngle}°</span></div>
                  <input type="range" min={0} max={359} step={1} value={drawAngle} onChange={e => setDrawAngle(+e.target.value)} className="w-full" />
                  <div className="text-[11px] text-zinc-400">{compassLabel(drawAngle)}</div>
                  <div className="grid grid-cols-8 gap-1">
                    {[[0, '→'], [45, '↘'], [90, '↓'], [135, '↙'], [180, '←'], [225, '↖'], [270, '↑'], [315, '↗']].map(([deg, arrow]) => (
                      <button key={deg as number} onClick={() => setDrawAngle(deg as number)} className={`py-1 text-sm rounded-lg border ${drawAngle === deg ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title={`${deg}°`}>{arrow as string}</button>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[11px] text-zinc-500">Re-sequences the loaded drawing instantly — no re-detection.</p>
            </div>
          </section>

          {/* pen */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">2 · Pen & paper</h2>
            <div className="space-y-3 p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60">
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Ink color</span><span className="font-mono text-zinc-400">{settings.strokeColor}</span></div>
                <div className="flex gap-2 items-center">
                  <input type="color" value={settings.strokeColor} onChange={e => set('strokeColor', e.target.value)} className="w-10 h-8 rounded cursor-pointer bg-transparent" />
                  <div className="flex gap-1.5">
                    {['#111827', '#1d4ed8', '#dc2626', '#059669', '#7c3aed', '#ea580c'].map(c => (
                      <button key={c} onClick={() => set('strokeColor', c)} className="w-6 h-6 rounded-full border border-white/20" style={{ background: c }} />
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Line thickness</span><span className="font-mono text-zinc-400">{settings.lineWidth}px</span></div>
                <input type="range" min={2} max={22} step={0.5} value={settings.lineWidth} onChange={e => set('lineWidth', +e.target.value)} className="w-full" />
              </div>
              <div>
                <div className="text-xs mb-1.5">Brush — real-media feel</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['marker', 'pencil', 'brush'] as BrushType[]).map(b => (
                    <button key={b} onClick={() => setSettings(s => ({ ...s, brushType: b, ...BRUSH_PRESETS[b] }))} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${settings.brushType === b ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title={b === 'marker' ? 'Crisp flat vector ink' : b === 'pencil' ? 'Hard grainy graphite with pointed tip' : 'Soft feathery bristles with strong taper'}>{b}</button>
                  ))}
                </div>
              </div>
              {settings.brushType !== 'marker' && (
                <div className="space-y-2.5 rounded-lg bg-zinc-900/60 border border-zinc-700/50 p-2.5">
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Softness</span><span className="font-mono text-zinc-400">{Math.round(settings.softness * 100)}%</span></div>
                    <input type="range" min={0} max={100} value={Math.round(settings.softness * 100)} onChange={e => set('softness', +e.target.value / 100)} className="w-full" title="Feathered dab edge, like a soft Photoshop brush" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Texture / grain</span><span className="font-mono text-zinc-400">{Math.round(settings.grain * 100)}%</span></div>
                    <input type="range" min={0} max={100} value={Math.round(settings.grain * 100)} onChange={e => set('grain', +e.target.value / 100)} className="w-full" title="Paper tooth and bristle noise inside each dab" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Pointed tip</span><span className="font-mono text-zinc-400">{Math.round(settings.taper * 100)}%</span></div>
                    <input type="range" min={0} max={100} value={Math.round(settings.taper * 100)} onChange={e => set('taper', +e.target.value / 100)} className="w-full" title="Pressure-style taper pinching both stroke ends" />
                  </div>
                </div>
              )}
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Paper</span></div>
                <div className="flex gap-1.5">
                  {['#ffffff', '#fefce8', '#f1f5f9', '#111827'].map(c => (
                    <button key={c} onClick={() => set('paperColor', c)} className="w-8 h-8 rounded-lg border border-white/20" style={{ background: c }} title={c} />
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs mb-1.5">Fill style</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button onClick={() => set('fillMode', 'outlines')} className={`px-2 py-1.5 text-xs rounded-lg border ${settings.fillMode === 'outlines' ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}>Draw outlines</button>
                  <button onClick={() => set('fillMode', 'scribble')} className={`px-2 py-1.5 text-xs rounded-lg border ${settings.fillMode === 'scribble' ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}>Scribble fill</button>
                </div>
              </div>
            </div>
          </section>

          {/* hand */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">3 · Hand</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-3">
              <div className="grid grid-cols-3 gap-1.5">
                {(['default', 'custom', 'none'] as const).map(v => (
                  <button key={v} onClick={() => setHandChoice(v)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${handChoice === v ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}>{v}</button>
                ))}
              </div>
              {handChoice === 'custom' && (
                <label className="block text-xs px-3 py-2 rounded-lg bg-zinc-800 border border-dashed border-zinc-600 text-center cursor-pointer hover:bg-zinc-700">
                  Upload hand PNG (transparent)
                  <input type="file" accept="image/png,image/webp" className="hidden" onChange={async e => {
                    const f = e.target.files?.[0]; if (!f) return
                    handCustomRef.current = await loadImageFromFile(f)
                    setStatus({ kind: 'idle', msg: `Custom hand loaded: ${f.name}` })
                  }} />
                </label>
              )}
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Hand size</span><span className="font-mono text-zinc-400">{settings.handScale.toFixed(2)}×</span></div>
                <input type="range" min={0.4} max={2} step={0.05} value={settings.handScale} onChange={e => set('handScale', +e.target.value)} className="w-full" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Shake / jitter</span><span className="font-mono text-zinc-400">{settings.jitterAmp.toFixed(1)}px</span></div>
                <input type="range" min={0} max={8} step={0.1} value={settings.jitterAmp} onChange={e => set('jitterAmp', +e.target.value)} className="w-full" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs mb-1 text-zinc-400">Pen-tip anchor X {settings.anchorX.toFixed(2)}</div>
                  <input type="range" min={0} max={1} step={0.01} value={settings.anchorX} onChange={e => set('anchorX', +e.target.value)} className="w-full" />
                </div>
                <div>
                  <div className="text-xs mb-1 text-zinc-400">Anchor Y {settings.anchorY.toFixed(2)}</div>
                  <input type="range" min={0} max={1} step={0.01} value={settings.anchorY} onChange={e => set('anchorY', +e.target.value)} className="w-full" />
                </div>
              </div>
              <p className="text-[11px] text-zinc-500">Anchor = which pixel of the hand image sits exactly on the stroke tip. Default matches the built-in marker tip.</p>
            </div>
          </section>

          {/* timing */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">4 · Timing</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60">
              <div className="flex justify-between text-xs mb-1"><span>Total duration</span><span className="font-mono text-zinc-400">{settings.duration.toFixed(1)}s</span></div>
              <input type="range" min={2} max={30} step={0.5} value={settings.duration} onChange={e => { set('duration', +e.target.value); setTime(t => Math.min(t, +e.target.value)) }} className="w-full" />
            </div>
          </section>
        </aside>

        {/* stage */}
        <main className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <div className={`mx-4 mt-3 px-3 py-2 rounded-lg text-xs border ${status.kind === 'error' ? 'bg-red-950/60 border-red-800 text-red-200' : status.kind === 'working' ? 'bg-amber-950/60 border-amber-800 text-amber-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}>
            <span className="font-mono">{fileName}</span> · <span>{status.msg}</span>
          </div>
          <div className="flex-1 min-h-0 min-w-0 p-4 flex items-center justify-center overflow-hidden">
            <div className="relative h-full aspect-video max-w-full flex items-center justify-center rounded-xl overflow-hidden border border-zinc-800 shadow-2xl bg-white">
              <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="block h-full w-auto max-w-full" />
              {!strokes.length && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 bg-white">
                  <div className="text-5xl mb-3">✋</div>
                  <p className="font-semibold text-zinc-700">Drop an SVG or PNG/JPG anywhere</p>
                  <p className="text-sm">or pick a sample from the sidebar to see the magic</p>
                </div>
              )}
            </div>
          </div>
          {/* timeline */}
          <div className="px-5 pb-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 space-y-3">
              <div className="flex items-center gap-3">
                <button onClick={onPlay} className="h-10 px-5 rounded-full bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center font-semibold text-sm shrink-0 shadow-lg shadow-indigo-950" title="Replay the loaded image from the beginning with current settings">
                  ▶ Play
                </button>
                <button onClick={onPauseToggle} className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 flex items-center justify-center text-lg shrink-0" title="Pause / resume">
                  {playing ? '⏸' : '▶'}
                </button>
                <span className="text-xs font-mono text-zinc-400 w-24 text-center shrink-0">{fmt(time)} / {fmt(settings.duration)}</span>
                <span className="text-xs text-zinc-400 shrink-0 hidden sm:block">{phaseLabel}</span>
                <select value={settings.drawSpeed} onChange={e => set('drawSpeed', +e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs font-mono shrink-0" title="Preview draw speed (export always renders the full duration)">
                  {[0.5, 1, 1.5, 2, 3].map(v => <option key={v} value={v}>{v}× speed</option>)}
                </select>
              </div>
              {/* storyboard filmstrip */}
              {filmstrip.length > 0 && (
                <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${THUMBS}, minmax(0, 1fr))` }}>
                  {filmstrip.map((f, i) => (
                    <button
                      key={i}
                      onClick={() => onSeek((settings.duration * i) / THUMBS)}
                      className={`relative rounded-md overflow-hidden border-2 transition aspect-video bg-zinc-800 ${i === activeThumb ? 'border-indigo-400 shadow-lg shadow-indigo-950' : 'border-zinc-700/60 opacity-70 hover:opacity-100'}`}
                      title={`Jump to ${fmt(f.t)}`}
                    >
                      <img src={f.url} alt={`frame ${i + 1}`} className="w-full h-full object-cover" draggable={false} />
                      {f.phase !== 'sketch' && (
                        <span className={`absolute top-0.5 right-0.5 text-[9px] px-1 rounded font-bold ${f.phase === 'photo' ? 'bg-emerald-400/90 text-black' : 'bg-amber-400/90 text-black'}`}>{f.phase === 'photo' ? 'PHOTO' : 'COLOR'}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {/* scrub bar */}
              <ScrubBar
                value={time}
                max={settings.duration}
                revealStart={timeline.revealStart}
                resolveStart={timeline.resolveStart}
                onSeek={onSeek}
              />
            </div>
          </div>
        </main>
      </div>
      {bgEditorOpen && origFileImgRef.current && (
        <BgEditor
          src={origFileImgRef.current}
          fileName={fileName}
          onApply={(cutout, label) => void onManualCutout(cutout, label)}
          onClose={() => setBgEditorOpen(false)}
        />
      )}
      </div>
    </>
  )
}

function procKey(...v: (number | string)[]): string {
  return v.join('/')
}

function useDebouncedValue<T>(v: T, ms: number): T {  const [snap, setSnap] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setSnap(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return snap
}

function Dropzone({ onFile }: { onFile: (f: File) => void }) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent) }
  }, [])
  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f) }}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${over ? 'border-indigo-400 bg-indigo-950/40' : 'border-zinc-700 bg-zinc-800/40 hover:border-zinc-500'}`}
    >
      <div className="text-2xl mb-1">📥</div>
      <p className="text-sm font-medium">Drop SVG / PNG / JPG</p>
      <p className="text-xs text-zinc-500">or click to browse</p>
      <input ref={inputRef} type="file" accept=".svg,.png,.jpg,.jpeg,.webp,.bmp" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
    </div>
  )
}
