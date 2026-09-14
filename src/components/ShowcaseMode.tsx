import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CANVAS_H, CANVAS_W } from '../engine/types'
import {
  DEFAULT_SKETCH_INTRO, SHOW_BGS, buildShowTimeline, getSketchHand, remapStrokesToFull, renderShowcaseFrame,
  type LineupLayout, type LineupOptions, type ShowItem, type SketchEntry, type SketchIntroOptions, type TileStyle,
} from '../engine/showcase'
import { BrushEngine } from '../engine/brush'
import { containRect, rasterToEdgeStrokes } from '../engine/rasterEdges'
import { cancelExport, downloadBlob, exportFrames, pickVideoSaveFile } from '../engine/exporter'
import { loadImageFromUrl } from '../engine/hand'
import { ModeTabs, ScrubBar, type AppMode } from './shared'
import { requestAddSceneToEditor, setShowcaseSnapshot } from '../engine/projectBridge'
import { sortByName } from '../engine/imageSync'

type Status = { kind: 'idle' | 'working' | 'error'; msg: string }

const THUMBS = 8
let nextId = 1

export default function ShowcaseMode({ mode, onMode }: { mode: AppMode; onMode: (m: AppMode) => void }) {
  const [items, setItems] = useState<ShowItem[]>([])
  const [hold, setHold] = useState(3)
  const [trans, setTrans] = useState(0.9)
  const [speed, setSpeed] = useState(1)
  const [layout, setLayout] = useState<LineupLayout>('scatter')
  const [tileSize, setTileSize] = useState(190)
  const [gap, setGap] = useState(26)
  const [gridCols, setGridCols] = useState(3)
  const [maxTilt, setMaxTilt] = useState(45)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))
  const [bg, setBg] = useState<string>(SHOW_BGS[0])
  const [bgImage, setBgImage] = useState<{ img: HTMLImageElement; url: string } | null>(null)
  const [radius, setRadius] = useState(22)
  const [outlineOn, setOutlineOn] = useState(false)
  const [outlineWidth, setOutlineWidth] = useState(6)
  const [outlineColor, setOutlineColor] = useState('#ffffff')
  const [connect, setConnect] = useState(true)
  const [connectColor, setConnectColor] = useState('#ef2b2b')
  // optional whiteboard sketch intro, drawn per image before it docks
  const [skOn, setSkOn] = useState(DEFAULT_SKETCH_INTRO.enabled)
  const [skDur, setSkDur] = useState(DEFAULT_SKETCH_INTRO.duration)
  const [skInk, setSkInk] = useState(DEFAULT_SKETCH_INTRO.strokeColor)
  const [skWidth, setSkWidth] = useState(DEFAULT_SKETCH_INTRO.lineWidth)
  const [skPaper, setSkPaper] = useState(DEFAULT_SKETCH_INTRO.paperColor)
  const [skHand, setSkHand] = useState(DEFAULT_SKETCH_INTRO.showHand)
  const [skHandScale, setSkHandScale] = useState(DEFAULT_SKETCH_INTRO.handScale)
  const [skDetail, setSkDetail] = useState(DEFAULT_SKETCH_INTRO.detail)
  const [skThresh, setSkThresh] = useState(DEFAULT_SKETCH_INTRO.threshold)
  const [sketchTick, setSketchTick] = useState(0)
  const [sketchProg, setSketchProg] = useState<{ done: number; total: number } | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [expFps, setExpFps] = useState(30)
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: 'Add images to build the lineup' })
  const [exportPct, setExportPct] = useState<number | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const rafRef = useRef<number>(0)
  const lastTsRef = useRef<number>(0)
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(speed)
  const itemsRef = useRef<ShowItem[]>([])
  const bgRef = useRef(bg)
  const lineupRef = useRef<LineupOptions | null>(null)
  const styleRef = useRef<TileStyle>({ radius: 22, outlineWidth: 0, outlineColor: '#ffffff' })
  const backdropRef = useRef<string | CanvasImageSource>(bg)
  speedRef.current = speed
  bgRef.current = bg
  itemsRef.current = items

  const lineup: LineupOptions = useMemo(
    () => ({ layout, tileSize, gap, gridCols, maxTilt, seed, connect, connectColor }),
    [layout, tileSize, gap, gridCols, maxTilt, seed, connect, connectColor],
  )
  lineupRef.current = lineup
  const tileStyle: TileStyle = useMemo(
    () => ({ radius, outlineWidth: outlineOn ? outlineWidth : 0, outlineColor }),
    [radius, outlineOn, outlineWidth, outlineColor],
  )
  const backdrop: string | CanvasImageSource = bgImage ? bgImage.img : bg
  styleRef.current = tileStyle
  backdropRef.current = backdrop

  const sketchOptions: SketchIntroOptions = useMemo(
    () => ({
      enabled: skOn, duration: skDur, lineWidth: skWidth, strokeColor: skInk,
      paperColor: skPaper, showHand: skHand, handScale: skHandScale,
      detail: skDetail, threshold: skThresh,
    }),
    [skOn, skDur, skWidth, skInk, skPaper, skHand, skHandScale, skDetail, skThresh],
  )
  const sketchHandRef = useRef<HTMLCanvasElement | null>(null)
  const sketchOptionsRef = useRef(sketchOptions)
  sketchOptionsRef.current = sketchOptions
  const sketchEntriesRef = useRef<Map<number, SketchEntry>>(new Map())
  const sketchKeyRef = useRef('')
  const sketchToken = useRef(0)
  const getSketchHandLazy = () => (sketchHandRef.current ??= getSketchHand())

  const tl = useMemo(
    () => buildShowTimeline(items, hold, trans, 1.2, lineup, skOn ? skDur : 0),
    [items, hold, trans, lineup, skOn, skDur],
  )
  const tlRef = useRef(tl)
  tlRef.current = tl

  const sketchState = useMemo(
    () => (skOn
      ? { options: sketchOptions, entries: sketchEntriesRef.current, hand: getSketchHandLazy() }
      : null),
    // entries mutate in place; sketchTick publishes each landing
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sketchOptions, sketchTick],
  )
  const sketchStateRef = useRef(sketchState)
  sketchStateRef.current = sketchState

  // sketch vectors for the intro: edge-detect each image once (debounced by
  // detection params), remapped into the full-card rect. Paint-only tweaks
  // (ink, paper, hand) reuse the cache — no re-detection. Stale runs die.
  useEffect(() => {
    if (!skOn || !items.length) {
      if (!skOn) {
        sketchToken.current++
        sketchEntriesRef.current = new Map()
        sketchKeyRef.current = ''
        setSketchProg(null)
      }
      return
    }
    const key = `${skDetail}/${skThresh}`
    const ids = items.map(i => i.id)
    const cached = sketchKeyRef.current === key ? sketchEntriesRef.current : new Map<number, SketchEntry>()
    // drop removed images, keep the rest
    for (const id of [...cached.keys()]) {
      if (!ids.includes(id)) cached.delete(id)
    }
    const missing = items.filter(it => !cached.has(it.id))
    if (!missing.length) {
      sketchEntriesRef.current = cached
      return
    }
    const id = ++sketchToken.current
    sketchKeyRef.current = key
    let cancelled = false
    let doneCount = items.length - missing.length
    const run = async () => {
      setSketchProg({ done: doneCount, total: items.length })
      for (const it of missing) {
        if (cancelled || sketchToken.current !== id) return
        try {
          const det = await rasterToEdgeStrokes(it.img, {
            low: Math.round(skThresh * 0.36), high: skThresh, maxDimension: skDetail,
            blur: 1, pruneLen: 6, minLen: 8, joinGap: 5,
          })
          if (cancelled || sketchToken.current !== id) return
          const full = containRect(it.img.naturalWidth || 16, it.img.naturalHeight || 9, 90)
          cached.set(it.id, { strokes: remapStrokesToFull(det.strokes, det.rect, full), engine: new BrushEngine() })
        } catch {
          // sparse/empty edges: that image simply pops in as usual
        }
        if (cancelled || sketchToken.current !== id) return
        doneCount++
        setSketchProg({ done: doneCount, total: items.length })
        setSketchTick(t => t + 1) // reveal each sketch as it lands
      }
      if (cancelled || sketchToken.current !== id) return
      sketchEntriesRef.current = cached
      setSketchTick(t => t + 1)
      setSketchProg(null)
      setStatus({ kind: 'idle', msg: `Sketch intro ready for ${cached.size}/${items.length} image${items.length === 1 ? '' : 's'} — each draws first, then docks` })
    }
    void run()
    return () => { cancelled = true }
  }, [items, skOn, skDetail, skThresh])

  // pause when the tab is hidden (tabs stay mounted to keep progress)
  useEffect(() => {
    if (mode !== 'showcase' && playingRef.current) {
      playingRef.current = false
      setPlaying(false)
    }
  }, [mode])

  // realtime loop (idles while the tab is hidden)
  useEffect(() => {
    const loop = (ts: number) => {
      try {
        if (modeRef.current !== 'showcase') {
          lastTsRef.current = ts
          return
        }
        const dt = Math.min(0.1, lastTsRef.current ? (ts - lastTsRef.current) / 1000 : 0) * speedRef.current
        lastTsRef.current = ts
        if (playingRef.current) {
          let t = timeRef.current + dt
          if (t >= tlRef.current.total) {
            t = tlRef.current.total
            playingRef.current = false
            setPlaying(false)
          }
          timeRef.current = t
          setTime(t)
        }
        const canvas = canvasRef.current
        if (canvas) {
          const lp = lineupRef.current
          renderShowcaseFrame(canvas.getContext('2d')!, itemsRef.current, tlRef.current, timeRef.current, backdropRef.current, lp && lp.connect ? lp.connectColor : null, styleRef.current, sketchStateRef.current)
        }
      } finally {
        rafRef.current = requestAnimationFrame(loop)
      }
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const onSeek = useCallback((t: number) => {
    const c = Math.min(tlRef.current.total, Math.max(0, t))
    timeRef.current = c
    setTime(c)
  }, [])

  const onPlay = useCallback(() => {
    if (!itemsRef.current.length) {
      setStatus({ kind: 'error', msg: 'Add at least one image first.' })
      return
    }
    // every run gets a fresh scatter — no two playthroughs look alike
    setSeed(Math.floor(Math.random() * 1e9))
    timeRef.current = 0
    setTime(0)
    lastTsRef.current = 0
    playingRef.current = true
    setPlaying(true)
    setStatus({ kind: 'idle', msg: `Playing ${itemsRef.current.length} images` })
  }, [])

  const onPauseToggle = useCallback(() => {
    if (playingRef.current) {
      playingRef.current = false
      setPlaying(false)
    } else {
      if (!itemsRef.current.length) return
      if (timeRef.current >= tlRef.current.total - 0.001) {
        // restarting after the end = a new run = a fresh scatter
        setSeed(Math.floor(Math.random() * 1e9))
        timeRef.current = 0
        setTime(0)
      }
      lastTsRef.current = 0
      playingRef.current = true
      setPlaying(true)
    }
  }, [])

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return
    setStatus({ kind: 'working', msg: `Loading ${files.length} image(s)…` })
    const fresh: ShowItem[] = []
    for (const f of Array.from(files)) {
      if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)) continue
      try {
        const url = URL.createObjectURL(f)
        const img = await loadImageFromUrl(url)
        fresh.push({ id: nextId++, img, name: f.name, url })
      } catch {
        /* skip unreadable files */
      }
    }
    if (fresh.length) {
      const ordered = sortByName(fresh, f => f.name)
      setItems(prev => [...prev, ...ordered])
      setStatus({ kind: 'idle', msg: `${ordered.length} image(s) added in file order — reorder freely, then press Play` })
    } else {
      setStatus({ kind: 'error', msg: 'No readable images in that drop.' })
    }
  }, [])

  const sortAZ = useCallback(() => {
    setItems(prev => sortByName(prev, it => it.name))
  }, [])

  const move = useCallback((id: number, dir: -1 | 1) => {
    setItems(prev => {
      const i = prev.findIndex(x => x.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }, [])

  const remove = useCallback((id: number) => {
    setItems(prev => prev.filter(x => x.id !== id))
    onSeek(0)
  }, [onSeek])

  const onExport = useCallback(async () => {
    if (!itemsRef.current.length) {
      setStatus({ kind: 'error', msg: 'Add at least one image first.' })
      return
    }
    try {
      setExportPct(0)
      setStatus({ kind: 'working', msg: 'Rendering 1080p60 MP4 frame-by-frame…' })
      const snapshot = [...itemsRef.current]
      const sk = sketchStateRef.current
      const sketchDur = sk ? sk.options.duration : 0
      const t = buildShowTimeline(snapshot, hold, trans, 1.2, lineup, sketchDur)
      const b = backdrop
      const cc = lineup.connect ? lineup.connectColor : null
      const st = tileStyle
      const fps = expFps
      const fileName = `showcase-${Date.now()}.mp4`
      const dest = await pickVideoSaveFile(fileName)
      const blob = await exportFrames(t.total, fps, (ctx, tt) => {
        renderShowcaseFrame(ctx, snapshot, t, tt, b, cc, st, sk)
      }, p => setExportPct(Math.round((p.frame / p.total) * 100)), dest)
      if (blob) {
        downloadBlob(blob, fileName)
        setStatus({ kind: 'idle', msg: `Exported ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4 · 1920×1080 @${fps}fps` })
      } else {
        setStatus({ kind: 'idle', msg: `Saved ${dest?.fileName ?? fileName} · 1920×1080 @${fps}fps (streamed to disk)` })
      }
    } catch (e) {
      setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Export failed' })
    } finally {
      setExportPct(null)
    }
  }, [hold, trans, lineup, backdrop, tileStyle, expFps])

  // Live link: keep the editor's editable Showcase scene in sync with this tab.
  useEffect(() => {
    setShowcaseSnapshot({
      items, hold, trans, lineup, tileStyle, bg: backdrop,
      sketchOptions, sketchEntries: sketchEntriesRef.current,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hold, trans, lineup, tileStyle, backdrop, sketchOptions, sketchTick])

  const sendToEditor = useCallback(() => {
    if (!itemsRef.current.length) {
      setStatus({ kind: 'error', msg: 'Add at least one image first.' })
      return
    }
    setShowcaseSnapshot({
      items: [...itemsRef.current],
      hold, trans,
      lineup: { ...lineupRef.current! },
      tileStyle: { ...styleRef.current },
      bg: backdropRef.current,
      sketchOptions: { ...sketchOptionsRef.current },
      sketchEntries: sketchEntriesRef.current,
    })
    onMode('editor')
    // the editor mounts on the mode switch — deliver the add request just after
    setTimeout(() => requestAddSceneToEditor('showcase'), 120)
  }, [hold, trans])

  const filmstrip = useMemo(() => {
    if (!items.length || !tl.total) return []
    const full = document.createElement('canvas')
    full.width = CANVAS_W; full.height = CANVAS_H
    const fctx = full.getContext('2d')!
    const out: { t: number; url: string }[] = []
    for (let k = 0; k < THUMBS; k++) {
      const t = (tl.total * (k + 0.5)) / THUMBS
      renderShowcaseFrame(fctx, items, tl, t, backdrop, lineup.connect ? lineup.connectColor : null, tileStyle, sketchState)
      const th = document.createElement('canvas')
      th.width = 240; th.height = 135
      th.getContext('2d')!.drawImage(full, 0, 0, 240, 135)
      out.push({ t, url: th.toDataURL('image/jpeg', 0.7) })
    }
    return out
  }, [items, tl, backdrop, lineup, tileStyle, sketchState])

  const activeThumb = tl.total ? Math.min(THUMBS - 1, Math.floor((time / tl.total) * THUMBS)) : -1
  const fmt = (t: number) => `${t.toFixed(1)}s`

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900/70 backdrop-blur">
        <div className="w-9 h-9 rounded-xl bg-fuchsia-600 flex items-center justify-center text-xl">🖼️</div>
        <div>
          <h1 className="font-bold text-lg leading-none tracking-tight">Showcase</h1>
          <p className="text-xs text-zinc-400">full-size features that dock into a lineup</p>
        </div>
        <div className="flex-1" />
        <ModeTabs mode={mode} onMode={onMode} />
        <div className="hidden md:flex items-center gap-2 text-xs text-zinc-400">
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">1920×1080</span>
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">{items.length} images</span>
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">{fmt(tl.total)} total</span>
        </div>
        <button
          onClick={sendToEditor}
          disabled={!items.length}
          title="Add this slideshow to the Editor timeline as a live, editable scene (not a baked video)"
          className="ml-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-emerald-950"
        >
          🎬 Editor＋
        </button>
        <button
          onClick={() => void onExport()}
          disabled={!items.length || exportPct !== null}
          className="ml-2 px-4 py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-fuchsia-950"
        >
          {exportPct !== null ? `Rendering ${exportPct}%…` : '⬇ Export MP4'}
        </button>
        {exportPct !== null && (
          <button onClick={() => cancelExport()} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm border border-zinc-700">Cancel</button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-80 shrink-0 border-r border-zinc-800 bg-zinc-900/50 p-4 overflow-y-auto space-y-5">
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">1 · Images in order</h2>
            <div className="flex gap-1.5 mb-2">
              <button onClick={sortAZ} disabled={!items.length} title="Sort playlist A–Z by filename (natural number order)" className="px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40">⇅ A–Z</button>
            </div>
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); void addFiles(e.dataTransfer.files) }}
              onClick={() => fileRef.current?.click()}
              className="cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition border-zinc-700 bg-zinc-800/40 hover:border-zinc-500"
            >
              <div className="text-2xl mb-1">🖼️</div>
              <p className="text-sm font-medium">Drop images here</p>
              <p className="text-xs text-zinc-500">or click to browse (multi-select)</p>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
            </div>
            <div className="mt-2 space-y-1.5">
              {items.map((it, i) => (
                <div key={it.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/60">
                  <span className="text-xs font-mono text-zinc-500 w-5 text-center">{i + 1}</span>
                  <img src={it.url} alt={it.name} className="w-14 h-10 object-cover rounded border border-zinc-700" />
                  <span className="flex-1 text-xs truncate text-zinc-300" title={it.name}>{it.name}</span>
                  <button onClick={() => move(it.id, -1)} disabled={i === 0} className="px-1.5 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-30">▲</button>
                  <button onClick={() => move(it.id, 1)} disabled={i === items.length - 1} className="px-1.5 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-30">▼</button>
                  <button onClick={() => remove(it.id)} className="px-1.5 py-1 text-xs rounded bg-zinc-800 hover:bg-red-900 border border-zinc-700">✕</button>
                </div>
              ))}
              {!items.length && <p className="text-xs text-zinc-500">Playlist is empty.</p>}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">2 · Motion</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Full-size hold</span><span className="font-mono text-zinc-400">{hold.toFixed(1)}s</span></div>
                <input type="range" min={1} max={8} step={0.5} value={hold} onChange={e => setHold(+e.target.value)} className="w-full" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Dock move</span><span className="font-mono text-zinc-400">{trans.toFixed(1)}s</span></div>
                <input type="range" min={0.4} max={2} step={0.1} value={trans} onChange={e => setTrans(+e.target.value)} className="w-full" />
              </div>
              <p className="text-[11px] text-zinc-500">Each image pops full-screen, holds, then glides into the top lineup slot.</p>
            </div>
          </section>
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">✏️ Sketch intro <span className="normal-case font-normal">(optional)</span></h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-3">
              <label className="flex items-center gap-2 text-xs text-zinc-200">
                <input type="checkbox" checked={skOn} onChange={e => setSkOn(e.target.checked)} className="accent-fuchsia-500" />
                Hand-draw each image first, then dock it
              </label>
              {skOn && (
                <>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Sketch time per image</span><span className="font-mono text-zinc-400">{skDur.toFixed(1)}s</span></div>
                    <input type="range" min={1.5} max={6} step={0.5} value={skDur} onChange={e => setSkDur(+e.target.value)} className="w-full" />
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span>Ink</span>
                    <input type="color" value={skInk} onChange={e => setSkInk(e.target.value)} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
                    <span className="ml-1">Paper</span>
                    <input type="color" value={skPaper} onChange={e => setSkPaper(e.target.value)} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Line width</span><span className="font-mono text-zinc-400">{skWidth.toFixed(1)}px</span></div>
                    <input type="range" min={2} max={16} step={0.5} value={skWidth} onChange={e => setSkWidth(+e.target.value)} className="w-full" />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-zinc-200">
                    <input type="checkbox" checked={skHand} onChange={e => setSkHand(e.target.checked)} className="accent-fuchsia-500" />
                    Drawing hand
                  </label>
                  {skHand && (
                    <div>
                      <div className="flex justify-between text-xs mb-1"><span>Hand size</span><span className="font-mono text-zinc-400">{skHandScale.toFixed(2)}×</span></div>
                      <input type="range" min={0.4} max={2} step={0.05} value={skHandScale} onChange={e => setSkHandScale(+e.target.value)} className="w-full" />
                    </div>
                  )}
                  <div className="flex justify-between text-xs items-center">
                    <span className="text-zinc-300">Edge detail</span>
                    <select value={skDetail} onChange={e => setSkDetail(+e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-xs">
                      <option value={480}>Standard</option>
                      <option value={640}>High</option>
                      <option value={800}>Ultra</option>
                    </select>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Edge threshold</span><span className="font-mono text-zinc-400">{skThresh}</span></div>
                    <input type="range" min={40} max={220} value={skThresh} onChange={e => setSkThresh(+e.target.value)} className="w-full" />
                  </div>
                  {sketchProg && (
                    <p className="text-[11px] text-amber-200">✏️ Detecting edges {sketchProg.done}/{sketchProg.total}…</p>
                  )}
                </>
              )}
              <p className="text-[11px] text-zinc-500">Optional: every image is sketched live on a paper card, then pops full-size and docks into the lineup.</p>
            </div>
          </section>
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">3 · Lineup</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-3">
              <div>
                <div className="text-xs mb-1.5">Final arrangement</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['dock', 'grid', 'scatter'] as LineupLayout[]).map(l => (
                    <button key={l} onClick={() => setLayout(l)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${layout === l ? 'bg-fuchsia-600 border-fuchsia-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title={l === 'dock' ? 'Top row lineup' : l === 'grid' ? 'Card grid' : 'Random scattered pile'}>{l}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Tile size</span><span className="font-mono text-zinc-400">{tileSize}px</span></div>
                <input type="range" min={80} max={320} step={5} value={tileSize} onChange={e => setTileSize(+e.target.value)} className="w-full" />
              </div>
              {layout !== 'scatter' && (
                <div>
                  <div className="flex justify-between text-xs mb-1"><span>Gap</span><span className="font-mono text-zinc-400">{gap}px</span></div>
                  <input type="range" min={0} max={60} step={2} value={gap} onChange={e => setGap(+e.target.value)} className="w-full" />
                </div>
              )}
              {layout === 'grid' && (
                <div>
                  <div className="flex justify-between text-xs mb-1"><span>Columns</span><span className="font-mono text-zinc-400">{gridCols}</span></div>
                  <input type="range" min={1} max={6} step={1} value={gridCols} onChange={e => setGridCols(+e.target.value)} className="w-full" />
                </div>
              )}
              {layout !== 'dock' && (
                <div>
                  <div className="flex justify-between text-xs mb-1"><span>Max tilt</span><span className="font-mono text-zinc-400">±{maxTilt}°</span></div>
                  <input type="range" min={0} max={60} step={1} value={maxTilt} onChange={e => setMaxTilt(+e.target.value)} className="w-full" />
                </div>
              )}
              {layout === 'scatter' && (
                <button onClick={() => setSeed(Math.floor(Math.random() * 1e9))} className="w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">
                  🎲 Shuffle positions
                </button>
              )}
              <div>
                <div className="text-xs mb-1.5">Backdrop</div>
                <div className="flex gap-1.5 items-center flex-wrap">
                  {SHOW_BGS.map(c => (
                    <button key={c} onClick={() => { setBg(c); setBgImage(null) }} className={`w-8 h-8 rounded-lg border ${!bgImage && bg === c ? 'border-fuchsia-400 ring-2 ring-fuchsia-400/40' : 'border-white/20'}`} style={{ background: c }} title={c} />
                  ))}
                  <label className="px-2 h-8 rounded-lg border border-dashed border-zinc-600 text-xs flex items-center cursor-pointer hover:bg-zinc-700" title="Upload a custom background image">
                    🖼 Custom
                    <input type="file" accept="image/*" className="hidden" onChange={async e => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (!f) return
                      try {
                        const url = URL.createObjectURL(f)
                        const img = await loadImageFromUrl(url)
                        setBgImage({ img, url })
                      } catch { /* ignore unreadable */ }
                    }} />
                  </label>
                  {bgImage && (
                    <span className="flex items-center gap-1">
                      <img src={bgImage.url} alt="backdrop" className={`h-8 rounded-lg border ${bgImage ? 'border-fuchsia-400 ring-2 ring-fuchsia-400/40' : 'border-white/20'}`} />
                      <button onClick={() => setBgImage(null)} className="px-1.5 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Back to solid color">✕</button>
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Corner radius</span><span className="font-mono text-zinc-400">{radius}px</span></div>
                <input type="range" min={0} max={200} step={1} value={radius} onChange={e => setRadius(+e.target.value)} className="w-full" />
              </div>
              <div>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={outlineOn} onChange={e => setOutlineOn(e.target.checked)} className="accent-fuchsia-500" />
                  Photo outline
                </label>
                {outlineOn && (
                  <div className="mt-2 space-y-2">
                    <div className="flex justify-between text-xs mb-1"><span>Outline width</span><span className="font-mono text-zinc-400">{outlineWidth}px</span></div>
                    <input type="range" min={2} max={60} step={1} value={outlineWidth} onChange={e => setOutlineWidth(+e.target.value)} className="w-full" />
                    <div className="flex gap-1.5">
                      {['#ffffff', '#111111', '#ef2b2b', '#fbbf24'].map(c => (
                        <button key={c} onClick={() => setOutlineColor(c)} className={`w-8 h-8 rounded-lg border ${outlineColor === c ? 'border-fuchsia-400 ring-2 ring-fuchsia-400/40' : 'border-white/20'}`} style={{ background: c }} title={c} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={connect} onChange={e => setConnect(e.target.checked)} className="accent-fuchsia-500" />
                  Connect images in order
                </label>
                {connect && (
                  <div className="flex gap-1.5 mt-1.5">
                    {['#ef2b2b', '#ffffff', '#fbbf24', '#22d3ee'].map(c => (
                      <button key={c} onClick={() => setConnectColor(c)} className={`w-8 h-8 rounded-lg border ${connectColor === c ? 'border-fuchsia-400 ring-2 ring-fuchsia-400/40' : 'border-white/20'}`} style={{ background: c }} title={c} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </aside>

        <main className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <div className={`mx-4 mt-3 px-3 py-2 rounded-lg text-xs border ${status.kind === 'error' ? 'bg-red-950/60 border-red-800 text-red-200' : status.kind === 'working' ? 'bg-amber-950/60 border-amber-800 text-amber-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}>
            <span>{status.msg}</span>
          </div>
          <div className="flex-1 min-h-0 min-w-0 p-4 flex items-center justify-center overflow-hidden">
            <div className="relative h-full aspect-video max-w-full flex items-center justify-center rounded-xl overflow-hidden border border-zinc-800 shadow-2xl bg-[#0e0e12]">
              <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="block h-full w-auto max-w-full" />
              {!items.length && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
                  <div className="text-5xl mb-3">🖼️</div>
                  <p className="font-semibold text-zinc-300">Drop images in the sidebar</p>
                  <p className="text-sm">order them, then press Play</p>
                </div>
              )}
            </div>
          </div>
          <div className="px-5 pb-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 space-y-3">
              <div className="flex items-center gap-3">
                <button onClick={onPlay} className="h-10 px-5 rounded-full bg-fuchsia-600 hover:bg-fuchsia-500 flex items-center justify-center font-semibold text-sm shrink-0 shadow-lg shadow-fuchsia-950" title="Replay the lineup from the beginning">
                  ▶ Play
                </button>
                <button onClick={onPauseToggle} className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 flex items-center justify-center text-lg shrink-0" title="Pause / resume">
                  {playing ? '⏸' : '▶'}
                </button>
                <span className="text-xs font-mono text-zinc-400 w-24 text-center shrink-0">{fmt(time)} / {fmt(tl.total)}</span>
                <select value={speed} onChange={e => setSpeed(+e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs font-mono shrink-0" title="Preview speed (export always renders full duration)">
                  {[0.5, 1, 1.5, 2, 3].map(v => <option key={v} value={v}>{v}× speed</option>)}
                </select>
                <select value={expFps} onChange={e => setExpFps(+e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs font-mono shrink-0" title="Export frame rate — 30 fps renders twice as fast and looks identical for slideshows">
                  {[30, 60].map(v => <option key={v} value={v}>{v} fps export</option>)}
                </select>
              </div>
              {filmstrip.length > 0 && (
                <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${THUMBS}, minmax(0, 1fr))` }}>
                  {filmstrip.map((f, i) => {
                    const active = tl.total ? Math.min(THUMBS - 1, Math.floor((time / tl.total) * THUMBS)) === i : false
                    return (
                      <button
                        key={i}
                        onClick={() => onSeek((tl.total * i) / THUMBS)}
                        className={`relative rounded-md overflow-hidden border-2 transition aspect-video bg-zinc-800 ${active ? 'border-fuchsia-400 shadow-lg shadow-fuchsia-950' : 'border-zinc-700/60 opacity-70 hover:opacity-100'}`}
                        title={`Jump to ${fmt(f.t)}`}
                      >
                        <img src={f.url} alt={`frame ${i + 1}`} className="w-full h-full object-cover" draggable={false} />
                      </button>
                    )
                  })}
                </div>
              )}
              <ScrubBar value={time} max={tl.total} revealStart={null} onSeek={onSeek} />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
