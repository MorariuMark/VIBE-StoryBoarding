import { CANVAS_H, CANVAS_W, type Placement, type Pt, type Stroke } from './types'
import { polyLength } from './svgParser'
import { cannyEdges, gaussianBlur } from './canny'
import { joinFragments, pruneSpurs, smoothPath, traceSkeleton } from './tracing'

export interface RasterEdgeOptions {
  low: number // weak threshold (0..255 gradient magnitude)
  high: number // strong threshold — medium-high keeps only real contours
  maxDimension: number // working resolution for detection (detail vs speed)
  blur: number // gaussian smoothing sigma (kills texture noise before detection)
  pruneLen: number // working-px branch length below which ticks are pruned
  minLen: number // canvas-px stroke length below which fragments are dropped
  joinGap: number // working-px gap across which collinear fragments rejoin
}

/** Aspect-preserving contain-fit of a srcW×srcH image into the 1920×1080 canvas. */
export function containRect(srcW: number, srcH: number, pad = 120): Placement {
  const scale = Math.min((CANVAS_W - pad * 2) / srcW, (CANVAS_H - pad * 2) / srcH)
  const dw = srcW * scale
  const dh = srcH * scale
  return { dx: (CANVAS_W - dw) / 2, dy: (CANVAS_H - dh) / 2, dw, dh }
}

export interface RasterEdgeResult {
  strokes: Stroke[]
  /** where the full-res source sits on canvas — identical transform as the vectors, so reveal aligns exactly */
  rect: Placement
  /** small black-on-white preview of the detected edges, for threshold tuning */
  edgePreview: string
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

/**
 * Photo/clipart -> sketch vectors:
 * downscale (working copy) -> grayscale -> blur -> Canny edges ->
 * prune noise ticks -> trace to ordered polylines -> join fragments ->
 * map to canvas with the SAME contain-fit placement used for the photo reveal.
 */
export async function rasterToEdgeStrokes(img: HTMLImageElement, opts: RasterEdgeOptions): Promise<RasterEdgeResult> {
  const { low, high, maxDimension, blur, pruneLen, minLen, joinGap } = opts
  const srcW = img.naturalWidth, srcH = img.naturalHeight
  if (!srcW || !srcH) throw new Error('Could not read image dimensions.')

  const s0 = Math.min(1, maxDimension / Math.max(srcW, srcH))
  const ww = Math.max(8, Math.round(srcW * s0))
  const wh = Math.max(8, Math.round(srcH * s0))

  const canvas = document.createElement('canvas')
  canvas.width = ww; canvas.height = wh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, ww, wh)
  ctx.drawImage(img, 0, 0, ww, wh)
  const data = ctx.getImageData(0, 0, ww, wh).data

  const gray = new Float32Array(ww * wh)
  for (let i = 0; i < ww * wh; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  await tick() // let the UI breathe between heavy stages
  const edges = cannyEdges(gaussianBlur(gray, ww, wh, blur), ww, wh, low, high)
  await tick()

  pruneSpurs(edges, ww, wh, Math.max(0, pruneLen), 2)
  const joined = joinFragments(traceSkeleton(edges, ww, wh), Math.max(0, joinGap), 0.5)
  await tick()

  // identical placement as the reveal photo: uniform scale, no stretch
  const rect = containRect(srcW, srcH)
  const k = rect.dw / ww
  const yOff = rect.dy + (rect.dh - wh * k) / 2

  const strokes: Stroke[] = []
  joined.forEach((path, id) => {
    if (path.length < 3) return
    const sm = smoothPath(path)
    const pts: Pt[] = sm
      .filter((_, i) => i % 2 === 0 || i === sm.length - 1)
      .map(p => ({ x: rect.dx + p.x * k, y: yOff + p.y * k }))
    if (pts.length < 2) return
    const len = polyLength(pts)
    if (len < Math.max(0, minLen)) return
    strokes.push({ id, points: pts, length: len, closed: false })
  })
  if (!strokes.length) {
    throw new Error('No edges found — lower the edge threshold or raise detail.')
  }
  return { strokes, rect, edgePreview: strokesPreviewUrl(strokes) }
}

/**
 * Render the FINAL stroke set (the exact vectors the hand will draw) to a small
 * preview. Because it is built from the same strokes, the preview can never
 * disagree with the animation — every line shown is drawn, nothing hidden is shown.
 */
function strokesPreviewUrl(strokes: Stroke[]): string {
  const W = 640, H = 360
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#111827'
  ctx.lineWidth = 2.5 // ≈7px canvas-equivalent
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.scale(W / CANVAS_W, H / CANVAS_H)
  for (const s of strokes) {
    const p = s.points
    ctx.beginPath()
    ctx.moveTo(p[0].x, p[0].y)
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y)
    ctx.stroke()
  }
  return c.toDataURL('image/png')
}
