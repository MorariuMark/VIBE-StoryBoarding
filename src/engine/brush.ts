import { CANVAS_H, CANVAS_W, type BrushType, type Pt, type RenderSettings, type Stroke } from './types'
import { pointAtLength } from './svgParser'
import type { TimelineMap } from './renderer'

export const BRUSH_PRESETS: Record<BrushType, { softness: number; grain: number; taper: number }> = {
  marker: { softness: 0.05, grain: 0, taper: 0 },
  pencil: { softness: 0.35, grain: 0.65, taper: 0.5 },
  brush: { softness: 0.8, grain: 0.3, taper: 0.85 },
}

/** Intersect a convex polygon with a half-plane proj<=f (keepLe) or proj>=f. */
export function clipHalfPlane(corners: Pt[], proj: number[], f: number, keepLe: boolean): Pt[] {
  const inside = (v: number) => (keepLe ? v <= f + 1e-9 : v >= f - 1e-9)
  const out: Pt[] = []
  for (let i = 0; i < corners.length; i++) {
    const j = (i + 1) % corners.length
    const cur = corners[i], nxt = corners[j]
    const cin = inside(proj[i]), nin = inside(proj[j])
    if (cin) out.push(cur)
    if (cin !== nin) {
      const denom = proj[j] - proj[i] || 1e-9
      const t = (f - proj[i]) / denom
      out.push({ x: cur.x + (nxt.x - cur.x) * t, y: cur.y + (nxt.y - cur.y) * t })
    }
  }
  return out
}

export function tracePoly(ctx: CanvasRenderingContext2D, poly: Pt[]) {
  ctx.beginPath()
  if (!poly.length) return
  ctx.moveTo(poly[0].x, poly[0].y)
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
  ctx.closePath()
}

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function parseHexColor(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  if (!isFinite(n)) return [17, 24, 39]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/**
 * Procedural Photoshop-style dab tip: solid core -> soft falloff (softness),
 * multiplied by per-pixel grain noise (texture). Baked in the ink color.
 */
function makeTip(color: string, softness: number, grain: number): HTMLCanvasElement {
  const S = 64
  const c = document.createElement('canvas')
  c.width = S; c.height = S
  const ctx = c.getContext('2d')!
  const [r, g, b] = parseHexColor(color)
  const img = ctx.createImageData(S, S)
  const d = img.data
  const inner = 0.75 - softness * 0.65 // hard pencil: solid to 75%, soft brush: feathered from 10%
  const rnd = mulberry(hashStr(`${color}|${softness.toFixed(3)}|${grain.toFixed(3)}`))
  // low-frequency blotches + per-pixel tooth
  const blotches: number[] = []
  for (let i = 0; i < 24; i++) blotches.push(rnd() * S, rnd() * S, 4 + rnd() * 14, 0.4 + rnd() * 0.6)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dist = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5) / (S / 2)
      let a = 1 - sstep(inner, 1, dist)
      if (a > 0 && grain > 0) {
        let blotch = 0
        for (let k = 0; k < blotches.length; k += 4) {
          const dd = Math.hypot(x - blotches[k], y - blotches[k + 1]) / blotches[k + 2]
          if (dd < 1) blotch += (1 - dd) * blotches[k + 3]
        }
        const tooth = rnd()
        a *= 1 - grain * Math.min(1, blotch * 0.5 + tooth * 0.75) * 0.9
      }
      const i = (y * S + x) * 4
      d[i] = r; d[i + 1] = g; d[i + 2] = b
      d[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)))
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** Brush width envelope: pointed-tip taper pinches both ends (like pressure). */
function widthAt(t: number, base: number, taper: number): number {
  if (taper <= 0) return base
  const pinch = Math.max(1 - sstep(0, 0.12, t), sstep(0.88, 1, t))
  return Math.max(0.5, base * (1 - taper * 0.88 * pinch))
}

function drawPartialStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, targetLen: number) {
  const pts = stroke.points
  if (pts.length < 2 || targetLen <= 0) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (acc + seg >= targetLen) {
      const t = seg === 0 ? 0 : (targetLen - acc) / seg
      ctx.lineTo(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t)
      break
    }
    ctx.lineTo(pts[i].x, pts[i].y)
    acc += seg
  }
  ctx.stroke()
}

/** Diagonal hatching clipped inside the closed stroke's bbox path. */
function drawScribbleFill(ctx: CanvasRenderingContext2D, stroke: Stroke, settings: RenderSettings, progress: number) {
  if (progress <= 0) return
  const pts = stroke.points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.clip()
  ctx.strokeStyle = settings.strokeColor
  ctx.globalAlpha = 0.55
  ctx.lineWidth = Math.max(2, settings.lineWidth * 0.45)
  const gap = Math.max(10, settings.lineWidth * 2.4)
  const diag = (maxX - minX) + (maxY - minY)
  const lines = Math.ceil(diag / gap)
  const upto = Math.floor(lines * progress)
  ctx.beginPath()
  for (let i = 0; i < upto; i++) {
    const off = minX - (maxY - minY) + i * gap
    // 45° hatch with slight wobble for hand feel
    const x0 = off, y0 = maxY + 10
    const x1 = off + (maxY - minY) + 20, y1 = minY - 10
    ctx.moveTo(x0 + Math.sin(i * 3.3) * 3, y0)
    ctx.lineTo(x1 + Math.cos(i * 2.1) * 3, y1)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * Incremental sketch layer: completed strokes are baked once onto a persistent
 * canvas; only the active partial stroke is re-drawn per frame. Scrubbing back
 * or changing strokes/settings resets and replays. Preview, export and
 * thumbnails share this path, so output is identical everywhere.
 */
export class BrushEngine {
  private layer: HTMLCanvasElement | null = null
  private layerCtx: CanvasRenderingContext2D | null = null
  private baked: boolean[] = []
  private lastTime = -1
  private key = ''
  private arr: Stroke[] | null = null
  private tips = new Map<string, HTMLCanvasElement>()

  private tipFor(settings: RenderSettings): HTMLCanvasElement {
    const k = `${settings.strokeColor}|${settings.softness.toFixed(3)}|${settings.grain.toFixed(3)}`
    let tip = this.tips.get(k)
    if (!tip) {
      tip = makeTip(settings.strokeColor, settings.softness, settings.grain)
      if (this.tips.size > 8) this.tips.clear()
      this.tips.set(k, tip)
    }
    return tip
  }

  private sketchKey(strokes: Stroke[], total: number, s: RenderSettings): string {
    return [
      strokes.length, total.toFixed(1), s.brushType, s.strokeColor, s.lineWidth,
      s.softness.toFixed(3), s.grain.toFixed(3), s.taper.toFixed(3), s.fillMode,
    ].join('|')
  }

  private reset(fullKey: string) {
    if (!this.layer) {
      this.layer = document.createElement('canvas')
      this.layer.width = CANVAS_W
      this.layer.height = CANVAS_H
      this.layerCtx = this.layer.getContext('2d')!
    } else {
      this.layerCtx!.save()
      this.layerCtx!.setTransform(1, 0, 0, 1, 0, 0)
      this.layerCtx!.globalCompositeOperation = 'copy'
      this.layerCtx!.clearRect(0, 0, CANVAS_W, CANVAS_H)
      this.layerCtx!.restore()
    }
    this.baked = []
    this.lastTime = -1
    this.key = fullKey
  }

  private hatchNeeded(s: RenderSettings, stroke: Stroke): boolean {
    return s.fillMode === 'scribble' && stroke.closed
  }

  private segDone(tl: TimelineMap, s: RenderSettings, i: number, time: number): boolean {
    const seg = tl.perStroke[i]
    if (time < seg.end) return false
    if (this.hatchNeeded(s, seg.stroke) && time < seg.end + 0.6) return false
    return true
  }

  private bakeSeg(stroke: Stroke, s: RenderSettings) {
    const ctx = this.layerCtx!
    if (s.brushType === 'marker') {
      ctx.save()
      ctx.strokeStyle = s.strokeColor
      ctx.lineWidth = s.lineWidth
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      drawPartialStroke(ctx, stroke, stroke.length)
      ctx.restore()
    } else {
      this.stampRun(ctx, this.tipFor(s), stroke, s, stroke.length)
    }
    if (this.hatchNeeded(s, stroke)) drawScribbleFill(ctx, stroke, s, 1)
  }

  /** Stamp dab tips along the first `toLen` px of a stroke. */
  private stampRun(ctx: CanvasRenderingContext2D, tip: HTMLCanvasElement, stroke: Stroke, s: RenderSettings, toLen: number) {
    if (toLen <= 0 || stroke.length <= 0) return
    const total = stroke.length
    const stepBase = Math.min(5, Math.max(1, s.lineWidth * 0.35))
    const sizeMul = 1.3 + s.softness * 1.2
    ctx.save()
    ctx.globalAlpha = s.brushType === 'pencil' ? 0.85 : 0.9
    let d = 0
    // initial dab anchors the stroke start (pointed tip still dots the paper)
    while (d <= toLen) {
      const t = Math.min(1, d / total)
      const w = widthAt(t, s.lineWidth, s.taper)
      const size = Math.max(1.5, w * sizeMul)
      const p = pointAtLength(stroke, Math.min(d, total))
      ctx.drawImage(tip, p.x - size / 2, p.y - size / 2, size, size)
      if (d >= toLen) break
      d += Math.max(0.75, Math.min(stepBase, (w * 0.4) || 1))
      if (d > toLen) d = toLen // ensure a dab lands exactly at the leading edge
    }
    ctx.restore()
  }

  /**
   * Draw the sketch state at `time` onto ctx (paper must already be painted),
   * optionally clipped to a polygon (color-wipe erasing).
   */
  drawSketch(
    ctx: CanvasRenderingContext2D,
    strokes: Stroke[],
    tl: TimelineMap,
    time: number,
    s: RenderSettings,
    clip: Pt[] | null,
  ) {
    // identity part of the key: array ref changes on reload/reorder
    const idKey = this.arr === strokes
      ? this.key.split('|')[0]
      : `n${strokes.length}-${strokes[0]?.id ?? 0}-${strokes[strokes.length - 1]?.id ?? 0}`
    this.arr = strokes
    const key = `${idKey}|${this.sketchKey(strokes, tl.total, s)}`
    if (key !== this.key || time < this.lastTime - 1e-6) this.reset(key)

    for (let i = 0; i < tl.perStroke.length; i++) {
      if (!this.baked[i] && this.segDone(tl, s, i, time)) {
        this.bakeSeg(tl.perStroke[i].stroke, s)
        this.baked[i] = true
      }
    }

    ctx.save()
    if (clip) { tracePoly(ctx, clip); ctx.clip() }
    ctx.drawImage(this.layer!, 0, 0)
    // live: the in-progress stroke(s) redrawn each frame on top
    if (s.brushType === 'marker') {
      ctx.strokeStyle = s.strokeColor
      ctx.lineWidth = s.lineWidth
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
    }
    const tip = s.brushType === 'marker' ? null : this.tipFor(s)
    for (let i = 0; i < tl.perStroke.length; i++) {
      if (this.baked[i]) continue
      const seg = tl.perStroke[i]
      if (time < seg.start) continue
      const frac = time >= seg.end ? 1 : seg.drawSpan <= 0 ? 1 : (time - seg.start) / seg.drawSpan
      if (tip) this.stampRun(ctx, tip, seg.stroke, s, frac * seg.stroke.length)
      else {
        drawPartialStroke(ctx, seg.stroke, frac * seg.stroke.length)
        if (this.hatchNeeded(s, seg.stroke) && frac >= 1) {
          drawScribbleFill(ctx, seg.stroke, s, Math.min(1, (time - seg.end + 0.6) / 0.6))
        }
      }
    }
    ctx.restore()
    this.lastTime = time
  }
}
