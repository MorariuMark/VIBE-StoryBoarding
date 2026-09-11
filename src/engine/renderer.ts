import { CANVAS_H, CANVAS_W, type Placement, type Pt, type RenderSettings, type RevealSource, type Stroke } from './types'
import { pointAtLength } from './svgParser'
import { clipHalfPlane, tracePoly, type BrushEngine } from './brush'

export interface TimelineMap {
  total: number
  perStroke: { stroke: Stroke; start: number; end: number; drawSpan: number }[]
  transit: number // seconds reserved per gap for hand travel
  revealStart: number | null // when the painted finish begins wiping in (null = no reveal)
  revealEnd: number
  resolveStart: number | null // when the dissolve to the real photo begins (null = off)
}

/** Build global playback timeline: edges draw, then the paint wipe, then the photo resolve. */
export function buildTimeline(strokes: Stroke[], duration: number, transitPerGap = 0.12, revealDuration = 0, resolveDuration = 0): TimelineMap {
  // Reserve the tail for the sketch->paint reveal; edges always complete before it.
  const reveal = Math.min(Math.max(0, revealDuration), Math.max(0, duration - 0.5))
  const edgeWindow = duration - reveal
  const resolve = reveal > 0 ? Math.min(Math.max(0, resolveDuration), Math.max(0, reveal - 0.4)) : 0
  const totalLen = strokes.reduce((a, s) => a + s.length, 0) || 1
  const gaps = Math.max(0, strokes.length - 1)
  // Scale transit so the full drawing ALWAYS fits: travel may use at most 30% of the edge window.
  const transit = gaps > 0 ? Math.min(transitPerGap, (edgeWindow * 0.3) / gaps) : 0
  const gapTotal = transit * gaps
  const drawTotal = Math.max(0.3, edgeWindow - gapTotal)
  let t = 0
  const perStroke = strokes.map((stroke) => {
    const span = (stroke.length / totalLen) * drawTotal
    const seg = { stroke, start: t, end: t + span, drawSpan: span }
    t += span + transit
    return seg
  })
  // last stroke shouldn't include trailing transit
  if (perStroke.length) perStroke[perStroke.length - 1].end = Math.min(edgeWindow, perStroke[perStroke.length - 1].end)
  return {
    total: duration, perStroke, transit,
    revealStart: reveal > 0 ? edgeWindow : null, revealEnd: duration,
    resolveStart: resolve > 0 ? duration - resolve : null,
  }
}

/** 0..1 progress of the paint wipe at time t: sketch -> painted finish. */
export function wipeProgress(tl: TimelineMap, time: number): number {
  if (tl.revealStart === null || time <= tl.revealStart) return 0
  const end = tl.resolveStart ?? tl.revealEnd
  const span = Math.max(1e-6, end - tl.revealStart)
  return Math.min(1, (time - tl.revealStart) / span)
}

/** 0..1 progress of the dissolve to the real photo at time t. */
export function resolveProgress(tl: TimelineMap, time: number): number {
  if (tl.resolveStart === null || time <= tl.resolveStart) return 0
  const span = Math.max(1e-6, tl.revealEnd - tl.resolveStart)
  return Math.min(1, (time - tl.resolveStart) / span)
}

/** 0..1 progress of the photo reveal at time t (0 = not started). */
export function revealProgress(tl: TimelineMap, time: number): number {
  if (tl.revealStart === null || time <= tl.revealStart) return 0
  const span = Math.max(1e-6, tl.revealEnd - tl.revealStart)
  return Math.min(1, (time - tl.revealStart) / span)
}

/** Seconds of photo-resolve to reserve, or 0 when off / unavailable. */
export function resolveDurationFor(settings: RenderSettings, reveal: RevealSource | null): number {
  if (!settings.resolvePhoto || !reveal || !reveal.photo || reveal.img === reveal.photo) return 0
  const window = Math.min(Math.max(0, settings.revealDuration), Math.max(0, settings.duration - 0.5))
  if (window <= 0) return 0
  return Math.min(2, Math.max(0.6, window * 0.4))
}

/** Seconds of reveal to reserve, or 0 when the photo finish is off / unavailable. */
export function revealDurationFor(settings: RenderSettings, reveal: RevealSource | null): number {
  return settings.revealPhoto && reveal ? Math.max(0, settings.revealDuration) : 0
}

export interface HandState { x: number; y: number; lifting: boolean; drawing: boolean }

export function handStateAt(strokes: Stroke[], tl: TimelineMap, time: number, revealRect: Placement | null = null, colorAngleDeg = 90): HandState {
  if (!strokes.length) return { x: CANVAS_W / 2, y: CANVAS_H / 2, lifting: false, drawing: false }
  // coloring phase: hand sweeps serpentine rows along the wipe frontier
  const rp = wipeProgress(tl, time)
  if (revealRect && rp > 0 && rp < 1) {
    const rad = (colorAngleDeg * Math.PI) / 180
    const dx = Math.cos(rad), dy = Math.sin(rad)
    const nx = -dy, ny = dx
    const { dx: rx, dy: ry, dw, dh } = revealRect
    const corners = [
      { x: rx, y: ry }, { x: rx + dw, y: ry },
      { x: rx + dw, y: ry + dh }, { x: rx, y: ry + dh },
    ]
    const ss = corners.map(p => p.x * dx + p.y * dy)
    const qs = corners.map(p => p.x * nx + p.y * ny)
    const sMin = Math.min(...ss), sMax = Math.max(...ss)
    const qMin = Math.min(...qs), qMax = Math.max(...qs)
    const f = sMin + rp * (sMax - sMin)
    const cx = rx + dw / 2, cy = ry + dh / 2
    const sc = cx * dx + cy * dy
    const rows = Math.max(3, Math.min(24, Math.round((qMax - qMin) / 80)))
    const rf = Math.min(rows - 1e-3, rp * rows)
    const row = Math.floor(rf)
    const within = rf - row
    const span = Math.max(1e-9, qMax - qMin)
    const q = row % 2 === 1 ? qMax - within * span : qMin + within * span
    const bx = cx + dx * (f - sc), by = cy + dy * (f - sc)
    const bq = bx * nx + by * ny
    return { x: bx + nx * (q - bq), y: by + ny * (q - bq), lifting: false, drawing: true }
  }
  if (time <= 0) { const p = strokes[0].points[0]; return { x: p.x, y: p.y, lifting: false, drawing: false } }
  for (let i = 0; i < tl.perStroke.length; i++) {
    const seg = tl.perStroke[i]
    if (time >= seg.start && time <= seg.end) {
      const frac = seg.drawSpan <= 0 ? 1 : (time - seg.start) / seg.drawSpan
      const p = pointAtLength(seg.stroke, frac * seg.stroke.length)
      return { x: p.x, y: p.y, lifting: false, drawing: true }
    }
    // transit gap to next
    const next = tl.perStroke[i + 1]
    if (next && time > seg.end && time < next.start) {
      const a = seg.stroke.points[seg.stroke.points.length - 1]
      const b = next.stroke.points[0]
      const f = (time - seg.end) / Math.max(1e-6, next.start - seg.end)
      const e = easeInOut(f)
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e - Math.sin(f * Math.PI) * 46, lifting: true, drawing: false }
    }
  }
  const last = strokes[strokes.length - 1]
  const p = last.points[last.points.length - 1]
  return { x: p.x, y: p.y, lifting: false, drawing: false }
}

function easeInOut(t: number) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 }

/**
 * Draw a single frame at `time` seconds.
 * Pure function of (ctx, strokes, timeline, settings, handImage, reveal) — used by
 * both realtime preview and offline export so output is identical.
 * The reveal photo (if any) uses the same contain-fit placement as the vectors,
 * so the sketch aligns exactly with the finished image. No stretching, ever.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  tl: TimelineMap,
  time: number,
  settings: RenderSettings,
  handImg: CanvasImageSource | null,
  reveal: RevealSource | null,
  engine: BrushEngine,
) {
  ctx.save()
  ctx.fillStyle = settings.paperColor
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // --- sketch strokes via the brush engine (incremental layer + live tip),
  // erased where the color wipe has passed ---
  const wp = wipeProgress(tl, time)
  const wiping = reveal && wp > 0 && wp < 1
  const colorRad = ((settings.colorAngle ?? 90) * Math.PI) / 180
  const colorDir = { x: Math.cos(colorRad), y: Math.sin(colorRad) }
  const rectCorners = reveal
    ? [
        { x: reveal.rect.dx, y: reveal.rect.dy },
        { x: reveal.rect.dx + reveal.rect.dw, y: reveal.rect.dy },
        { x: reveal.rect.dx + reveal.rect.dw, y: reveal.rect.dy + reveal.rect.dh },
        { x: reveal.rect.dx, y: reveal.rect.dy + reveal.rect.dh },
      ]
    : []
  const cornerS = rectCorners.map(p => p.x * colorDir.x + p.y * colorDir.y)
  const wipeF = cornerS.length
    ? Math.min(...cornerS) + wp * (Math.max(...cornerS) - Math.min(...cornerS))
    : 0
  const unrevealed = wiping ? clipHalfPlane(rectCorners, cornerS, wipeF, false) : null
  if (wp < 1) engine.drawSketch(ctx, strokes, tl, time, settings, unrevealed)

  // --- painted finish wipes in along the color direction, in place ---
  if (reveal && wp > 0) {
    ctx.save()
    if (wp < 1) {
      tracePoly(ctx, clipHalfPlane(rectCorners, cornerS, wipeF, true))
      ctx.clip()
    }
    ctx.drawImage(reveal.img, reveal.rect.dx, reveal.rect.dy, reveal.rect.dw, reveal.rect.dh)
    ctx.restore()
  }

  // --- resolve: painted finish dissolves into the real photo ---
  const resolving = reveal && reveal.photo && reveal.img !== reveal.photo && tl.resolveStart !== null
  const xp = resolving ? resolveProgress(tl, time) : 0
  if (resolving && xp > 0 && reveal.photo) {
    ctx.save()
    ctx.globalAlpha = easeInOut(xp)
    ctx.drawImage(reveal.photo, reveal.rect.dx, reveal.rect.dy, reveal.rect.dw, reveal.rect.dh)
    ctx.restore()
  }

  // --- hand ---
  if (settings.showHand && handImg && strokes.length) {
    const hs = handStateAt(strokes, tl, time, reveal ? reveal.rect : null, settings.colorAngle ?? 90)
    // procedural micro-jitter while drawing (sketching and coloring alike)
    let jx = 0, jy = 0
    if (hs.drawing) {
      const a = settings.jitterAmp
      jx = Math.sin(time * 37.0) * a + Math.sin(time * 23.7) * a * 0.6
      jy = Math.cos(time * 41.0) * a + Math.sin(time * 29.3) * a * 0.6
    }
    // wipe done: the hand is gone, only the finish remains
    if (wp >= 1) {
      ctx.restore()
      return
    }
    // ease lift scale visually: hand slightly smaller + shadow when travelling
    const handPx = 300 * settings.handScale * (hs.lifting ? 0.94 : 1)
    const hx = hs.x + jx
    const hy = hs.y + jy - (hs.lifting ? 14 : 0)

    if (hs.lifting) {
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = '#000'
      ctx.beginPath()
      ctx.ellipse(hs.x, hs.y + 26, 60, 14, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    const ax = settings.anchorX, ay = settings.anchorY
    const imgW = handPx
    // assume roughly square hand asset; preserve aspect via fixed ratio box
    const aspect = handAspect(handImg)
    const imgH = imgW * aspect
    ctx.save()
    // slight tilt: drawing vs transit
    const tilt = hs.drawing ? Math.sin(time * 3.1) * 0.03 : -0.12
    ctx.translate(hx, hy)
    ctx.rotate(tilt)
    ctx.globalAlpha = 0.98
    ctx.drawImage(handImg, -imgW * ax, -imgH * ay, imgW, imgH)
    ctx.restore()
  }
  ctx.restore()
}

const aspectCache = new WeakMap<object, number>()
function handAspect(img: CanvasImageSource): number {
  const o = img as unknown as { width?: number; height?: number; videoWidth?: number }
  if (typeof o.width === 'number' && typeof o.height === 'number' && o.width > 0) return o.height / o.width
  const c = aspectCache.get(img as object)
  if (c) return c
  return 1
}

export function fitCanvasToElement(canvas: HTMLCanvasElement) {
  // canvas backing store is always 1920x1080; CSS scales it
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
}

export type { Pt }
