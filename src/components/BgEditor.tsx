import { useEffect, useMemo, useRef, useState } from 'react'
import { cutoutWithMask, featherMask, invertMask, solidMask, wandMask, type Seed } from '../engine/segmentation'
import { loadImageFromUrl } from '../engine/hand'

type Tool = 'wand' | 'solid'

const WORK_MAX = 900

/**
 * Click-to-remove background editor: magic wand (contiguous flood fill) and
 * solid color (global match + detail guard), with live mask preview.
 */
export default function BgEditor({
  src, fileName, onApply, onClose,
}: {
  src: HTMLImageElement
  fileName: string
  onApply: (cutout: HTMLImageElement, label: string) => void
  onClose: () => void
}) {
  const [tool, setTool] = useState<Tool>('wand')
  const [tolerance, setTolerance] = useState(25)
  const [detailGuard, setDetailGuard] = useState(12)
  const [seeds, setSeeds] = useState<Seed[]>([])
  const [inverted, setInverted] = useState(false)
  const [applying, setApplying] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // working copy (downscaled) + raw pixels, built once per source
  const work = useMemo(() => {
    const s = Math.min(1, WORK_MAX / Math.max(src.naturalWidth, src.naturalHeight))
    const w = Math.max(8, Math.round(src.naturalWidth * s))
    const h = Math.max(8, Math.round(src.naturalHeight * s))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(src, 0, 0, w, h)
    return { canvas: c, rgb: ctx.getImageData(0, 0, w, h).data, w, h }
  }, [src])

  const tol = tolerance * 1.5
  const minSize = Math.round(((detailGuard / 100) ** 2) * work.w * work.h * 0.05)

  // selection mask (feathered, optionally inverted)
  const mask = useMemo(() => {
    if (!seeds.length) return new Uint8Array(work.w * work.h)
    const sel = tool === 'wand'
      ? wandMask(work.rgb, work.w, work.h, seeds, tol)
      : solidMask(work.rgb, work.w, work.h, seeds, tol, minSize)
    const soft = featherMask(sel, work.w, work.h, 1)
    return inverted ? invertMask(soft) : soft
  }, [work, seeds, tool, tol, minSize, inverted])

  const selectedCount = useMemo(() => {
    let n = 0
    for (let i = 0; i < mask.length; i += 4) if (mask[i] > 127) n++
    return n
  }, [mask])

  // paint source + red mask overlay + seed dots
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = work.w
    canvas.height = work.h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(work.canvas, 0, 0)
    if (seeds.length) {
      const img = ctx.getImageData(0, 0, work.w, work.h)
      const d = img.data
      for (let i = 0; i < mask.length; i++) {
        const a = mask[i] / 255
        if (a <= 0) continue
        d[i * 4] = d[i * 4] * (1 - a * 0.55) + 255 * a * 0.55
        d[i * 4 + 1] = d[i * 4 + 1] * (1 - a * 0.55)
        d[i * 4 + 2] = d[i * 4 + 2] * (1 - a * 0.55)
      }
      ctx.putImageData(img, 0, 0)
      ctx.fillStyle = '#22d3ee'
      ctx.strokeStyle = '#000'
      for (const s of seeds) {
        ctx.beginPath()
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
  }, [work, mask, seeds])

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = canvasRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * work.w
    const y = ((e.clientY - r.top) / r.height) * work.h
    setSeeds(s => [...s, { x, y }])
  }

  const onApplyClick = async () => {
    if (!seeds.length) return
    setApplying(true)
    try {
      await new Promise(r => setTimeout(r, 10))
      const cut = cutoutWithMask(src, mask, work.w, work.h, true)
      const blob = await new Promise<Blob | null>(res => cut.toBlob(res, 'image/png'))
      if (!blob) throw new Error('Could not encode cutout')
      const img = await loadImageFromUrl(URL.createObjectURL(blob))
      onApply(img, `${fileName} (cutout)`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="font-bold">🪄 Remove background — click what goes away</h3>
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">✕</button>
        </div>
        <div className="flex justify-center bg-zinc-950 rounded-xl border border-zinc-800 p-2 mb-3">
          <canvas
            ref={canvasRef}
            onClick={onCanvasClick}
            className="max-w-full cursor-crosshair rounded"
            style={{ maxHeight: '52vh' }}
          />
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-2.5 p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60">
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => setTool('wand')} className={`px-2 py-1.5 text-xs rounded-lg border ${tool === 'wand' ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title="Flood fill from the click — connected area only">🪄 Magic wand</button>
              <button onClick={() => setTool('solid')} className={`px-2 py-1.5 text-xs rounded-lg border ${tool === 'solid' ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`} title="Every patch of that color in the whole image">🎨 Solid color</button>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Tolerance</span><span className="font-mono text-zinc-400">{tolerance}</span></div>
              <input type="range" min={1} max={100} value={tolerance} onChange={e => setTolerance(+e.target.value)} className="w-full" />
            </div>
            {tool === 'solid' && (
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Detail guard (protects small patches)</span><span className="font-mono text-zinc-400">{detailGuard}</span></div>
                <input type="range" min={0} max={100} value={detailGuard} onChange={e => setDetailGuard(+e.target.value)} className="w-full" />
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={inverted} onChange={e => setInverted(e.target.checked)} className="accent-indigo-500" />
              Invert selection
            </label>
          </div>
          <div className="space-y-2.5 p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60">
            <div className="text-xs text-zinc-400">
              {seeds.length === 0
                ? 'Click the background (or any element) in the image to select it. Red = will be removed.'
                : `${seeds.length} seed${seeds.length > 1 ? 's' : ''} · ${Math.round((selectedCount / mask.length) * 100)}% selected`}
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <button onClick={() => setSeeds(s => s.slice(0, -1))} disabled={!seeds.length} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40">↩ Undo click</button>
              <button onClick={() => setSeeds([])} disabled={!seeds.length} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40">Clear</button>
            </div>
            <div className="flex gap-1.5 pt-1">
              <button onClick={onClose} className="flex-1 px-3 py-2 text-sm rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">Cancel</button>
              <button onClick={() => void onApplyClick()} disabled={!seeds.length || applying} className="flex-1 px-3 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 font-semibold disabled:opacity-40">
                {applying ? 'Cutting…' : '✂ Apply cutout'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
