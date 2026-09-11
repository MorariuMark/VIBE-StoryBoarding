import { CANVAS_H, CANVAS_W, DEFAULT_SETTINGS, type Placement, type Pt, type RenderSettings, type Stroke } from './types'
import { containRect } from './rasterEdges'
import { BrushEngine } from './brush'
import { buildTimeline, handStateAt } from './renderer'
import { createDefaultHand } from './hand'

/**
 * Showcase mode: ordered images take turns full-screen, then travel into a
 * final lineup (dock row, grid, or tilted scatter) with smooth eased motion.
 * All layout is a pure function of (items, options, time).
 */

export interface ShowItem {
  id: number
  img: HTMLImageElement
  name: string
  url: string
}

export type LineupLayout = 'dock' | 'grid' | 'scatter'

export interface LineupOptions {
  layout: LineupLayout
  tileSize: number // reference tile height px (dock) / scale driver (grid, scatter)
  gap: number // spacing px (dock row, grid cells)
  gridCols: number // grid columns
  maxTilt: number // degrees of random tilt (grid slight, scatter full range)
  seed: number // scatter/shuffle randomness
  connect: boolean // draw an order line through the lineup in the background
  connectColor: string // order line color
}

/** Max allowed pairwise overlap (fraction of the smaller tile). */
export const MAX_OVERLAP = 0.3

/** Optional whiteboard sketch intro, drawn per image before it docks. */
export interface SketchIntroOptions {
  enabled: boolean
  /** sketch seconds per image */
  duration: number
  lineWidth: number
  strokeColor: string
  paperColor: string
  showHand: boolean
  handScale: number
  /** edge-detection working size */
  detail: number
  /** canny strong threshold */
  threshold: number
}

export const DEFAULT_SKETCH_INTRO: SketchIntroOptions = {
  enabled: false,
  duration: 3,
  lineWidth: 6,
  strokeColor: '#111827',
  paperColor: '#ffffff',
  showHand: true,
  handScale: 1,
  detail: 640,
  threshold: 110,
}

export interface ShowSlot {
  item: ShowItem
  index: number
  start: number
  /** sketch phase window (equals start when the intro is off) */
  sketchStart: number
  sketchEnd: number
  enterEnd: number
  holdEnd: number
  exitEnd: number
  full: Placement
  finalRect: Placement
  finalRot: number // degrees
}

export interface ShowTimeline {
  slots: ShowSlot[]
  total: number
  hold: number
  trans: number
  sketch: number
}

/** Per-image sketch vectors (remapped into the full-card rect) + brush state. */
export interface SketchEntry {
  strokes: Stroke[]
  engine: BrushEngine
}

export interface SketchRenderState {
  options: SketchIntroOptions
  entries: Map<number, SketchEntry>
  hand: CanvasImageSource | null
}

let defaultSketchHand: HTMLCanvasElement | null = null
/** Shared default hand for sketch intros (no custom upload in this flow). */
export function getSketchHand(): HTMLCanvasElement {
  if (!defaultSketchHand) defaultSketchHand = createDefaultHand(320)
  return defaultSketchHand
}

/**
 * Remap detection-space strokes (contain pad 120) into the showcase full
 * card (contain pad 90). Same image aspect, so one uniform scale applies —
 * arc lengths scale along with the points.
 */
export function remapStrokesToFull(strokes: Stroke[], from: Placement, full: Placement): Stroke[] {
  const k = full.dw / Math.max(1, from.dw)
  return strokes.map(s => ({
    ...s,
    length: s.length * k,
    points: s.points.map(p => ({ x: full.dx + (p.x - from.dx) * k, y: full.dy + (p.y - from.dy) * k })),
  }))
}

/** Tile card styling. */
export interface TileStyle {
  radius: number // corner radius px (canvas scale)
  outlineWidth: number // 0 = off
  outlineColor: string
}

export const DEFAULT_TILE_STYLE: TileStyle = { radius: 22, outlineWidth: 0, outlineColor: '#ffffff' }

export const SHOW_BGS = ['#0e0e12', '#1e293b', '#e8e6e1'] as const

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function easeOutBack(t: number): number {
  const c = 1.70158
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
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

function fitInto(natW: number, natH: number, boxW: number, boxH: number): { dw: number; dh: number } {
  const k = Math.min(boxW / natW, boxH / natH)
  return { dw: natW * k, dh: natH * k }
}

/** Corners of a rotated rect (center, w, h, degrees). */
export function rotatedCorners(cx: number, cy: number, w: number, h: number, rotDeg: number): Pt[] {
  const rad = (rotDeg * Math.PI) / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  return [
    { x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 },
  ].map(p => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }))
}

function polyArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

/** Intersect convex polygons (Sutherland–Hodgman): clip subject by clipper. */
function polyIntersect(subject: Pt[], clipper: Pt[]): Pt[] {
  let area2 = 0
  for (let i = 0; i < clipper.length; i++) {
    const p = clipper[i], q = clipper[(i + 1) % clipper.length]
    area2 += p.x * q.y - q.x * p.y
  }
  const left = area2 > 0 // interior side of each clip edge (winding-agnostic)
  let out = subject
  for (let e = 0; e < clipper.length; e++) {
    const a = clipper[e], b = clipper[(e + 1) % clipper.length]
    const input = out
    out = []
    if (!input.length) break
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length]
      const crossC = (b.x - a.x) * (cur.y - a.y) - (b.y - a.y) * (cur.x - a.x)
      const crossP = (b.x - a.x) * (prev.y - a.y) - (b.y - a.y) * (prev.x - a.x)
      const insideC = left ? crossC >= -1e-9 : crossC <= 1e-9
      const insideP = left ? crossP >= -1e-9 : crossP <= 1e-9
      if (insideC) {
        if (!insideP) out.push(lineIntersect(prev, cur, a, b))
        out.push(cur)
      } else if (insideP) {
        out.push(lineIntersect(prev, cur, a, b))
      }
    }
  }
  return out
}

function lineIntersect(p1: Pt, p2: Pt, a: Pt, b: Pt): Pt {
  const d = (p2.x - p1.x) * (b.y - a.y) - (p2.y - p1.y) * (b.x - a.x) || 1e-9
  const t = ((a.x - p1.x) * (b.y - a.y) - (a.y - p1.y) * (b.x - a.x)) / d
  return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t }
}

/** Overlap ratio of two rotated tiles = intersection / smaller area (0..1). */
export function overlapRatio(
  a: { cx: number; cy: number; w: number; h: number; rot: number },
  b: { cx: number; cy: number; w: number; h: number; rot: number },
): number {
  const pa = rotatedCorners(a.cx, a.cy, a.w, a.h, a.rot)
  const pb = rotatedCorners(b.cx, b.cy, b.w, b.h, b.rot)
  const inter = polyArea(polyIntersect(pa, pb))
  const minA = Math.min(a.w * a.h, b.w * b.h)
  if (minA <= 0) return 0
  return Math.min(1, inter / minA)
}

/** Final lineup slots: rect + rotation. Deterministic per seed. */
export function layoutSlots(items: ShowItem[], opts: LineupOptions): { rect: Placement; rot: number }[] {
  if (!items.length) return []
  const rnd = mulberry(opts.seed || 1)
  if (opts.layout === 'grid') {
    const cols = Math.max(1, Math.min(opts.gridCols, items.length))
    const rows = Math.ceil(items.length / cols)
    const marginX = 70, top = 150, bottom = 70
    const cw = (CANVAS_W - marginX * 2) / cols
    const ch = (CANVAS_H - top - bottom) / rows
    // tileSize scales cells around the 190px reference, clamped to fit
    const s = Math.min(1.6, Math.max(0.5, opts.tileSize / 190))
    const out: { rect: Placement; rot: number }[] = []
    items.forEach((it, i) => {
      const r = Math.floor(i / cols), c = i % cols
      const inRow = Math.min(cols, items.length - r * cols)
      const rowX = marginX + ((CANVAS_W - marginX * 2 - inRow * cw) / 2)
      const boxW = (cw - opts.gap) * s, boxH = (ch - opts.gap) * s
      const natW = it.img.naturalWidth || 16, natH = it.img.naturalHeight || 9
      const { dw, dh } = fitInto(natW, natH, Math.max(8, boxW), Math.max(8, boxH))
      const dx = rowX + c * cw + (cw - dw) / 2
      const dy = top + r * ch + (ch - dh) / 2
      out.push({ rect: { dx, dy, dw, dh }, rot: (rnd() * 2 - 1) * opts.maxTilt * 0.35 })
    })
    return out
  }
  if (opts.layout === 'scatter') {
    // chained placement: each tile lands near the previous one so order lines
    // stay short, with rejection sampling keeping overlap under MAX_OVERLAP
    const placed: { cx: number; cy: number; w: number; h: number; rot: number }[] = []
    const out: { rect: Placement; rot: number }[] = []
    items.forEach((it, idx) => {
      const natW = it.img.naturalWidth || 16, natH = it.img.naturalHeight || 9
      const box = opts.tileSize * (0.9 + rnd() * 0.35)
      const { dw, dh } = fitInto(natW, natH, box, box * 0.8)
      const diag = Math.hypot(dw, dh)
      let best = { dx: 60, dy: 120, over: Infinity, rot: 0 }
      for (let attempt = 0; attempt < 100; attempt++) {
        const rot = (rnd() * 2 - 1) * opts.maxTilt
        let dx: number, dy: number
        if (idx === 0 || attempt % 4 === 3) {
          // first tile, plus occasional free jumps so the chain can relocate
          dx = 60 + rnd() * Math.max(1, CANVAS_W - 120 - dw)
          dy = 120 + rnd() * Math.max(1, CANVAS_H - 180 - dh)
        } else {
          // chain: near the previous tile's center, random bearing and reach
          const prev = placed[placed.length - 1]
          const ang = rnd() * Math.PI * 2
          const reach = diag * (0.55 + rnd() * 1.5)
          dx = Math.min(Math.max(60, prev.cx + Math.cos(ang) * reach - dw / 2), Math.max(60, CANVAS_W - 60 - dw))
          dy = Math.min(Math.max(120, prev.cy + Math.sin(ang) * reach - dh / 2), Math.max(120, CANVAS_H - 60 - dh))
        }
        const cand = { cx: dx + dw / 2, cy: dy + dh / 2, w: dw, h: dh, rot }
        let over = 0
        for (const p of placed) over = Math.max(over, overlapRatio(cand, p))
        if (over < best.over) best = { dx, dy, over, rot }
        if (over <= MAX_OVERLAP) break
      }
      placed.push({ cx: best.dx + dw / 2, cy: best.dy + dh / 2, w: dw, h: dh, rot: best.rot })
      out.push({ rect: { dx: best.dx, dy: best.dy, dw, dh }, rot: best.rot })
    })
    return out
  }
  // dock: top row lineup, aspect-preserved, shrinks to fit
  const aspects = items.map(i => (i.img.naturalWidth || 16) / (i.img.naturalHeight || 9))
  let dockH = opts.tileSize
  const widths = aspects.map(a => dockH * a)
  const totalW = widths.reduce((a, b) => a + b, 0) + opts.gap * (items.length - 1)
  const avail = CANVAS_W - 140
  if (totalW > avail) dockH *= avail / totalW
  const out: { rect: Placement; rot: number }[] = []
  let x = 70
  const y = 64
  for (let i = 0; i < items.length; i++) {
    const w = dockH * aspects[i]
    out.push({ rect: { dx: x, dy: y, dw: w, dh: dockH }, rot: 0 })
    x += w + opts.gap
  }
  return out
}

export function buildShowTimeline(
  items: ShowItem[], hold: number, trans: number, endHold: number,
  lineup: LineupOptions, sketchDur = 0,
): ShowTimeline {
  const sketch = Math.max(0, sketchDur)
  const finals = layoutSlots(items, lineup)
  const slot = sketch + hold + trans
  const slots: ShowSlot[] = items.map((item, index) => {
    const start = index * slot
    const sketchEnd = start + sketch
    const enterDur = Math.min(0.45, hold * 0.25)
    return {
      item, index, start,
      sketchStart: start,
      sketchEnd,
      enterEnd: sketchEnd + enterDur,
      holdEnd: sketchEnd + hold,
      exitEnd: sketchEnd + hold + trans,
      full: containRect(item.img.naturalWidth || 16, item.img.naturalHeight || 9, 90),
      finalRect: finals[index].rect,
      finalRot: finals[index].rot,
    }
  })
  return { slots, total: items.length ? items.length * slot + endHold : 0, hold, trans, sketch }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpRect(a: Placement, b: Placement, t: number): Placement {
  return { dx: lerp(a.dx, b.dx, t), dy: lerp(a.dy, b.dy, t), dw: lerp(a.dw, b.dw, t), dh: lerp(a.dh, b.dh, t) }
}

function roundRectPath(ctx: CanvasRenderingContext2D, r: Placement, radius: number) {
  const rad = Math.min(radius, r.dw / 2, r.dh / 2)
  ctx.beginPath()
  ctx.moveTo(r.dx + rad, r.dy)
  ctx.arcTo(r.dx + r.dw, r.dy, r.dx + r.dw, r.dy + r.dh, rad)
  ctx.arcTo(r.dx + r.dw, r.dy + r.dh, r.dx, r.dy + r.dh, rad)
  ctx.arcTo(r.dx, r.dy + r.dh, r.dx, r.dy, rad)
  ctx.arcTo(r.dx, r.dy, r.dx + r.dw, r.dy, rad)
  ctx.closePath()
}

function drawPhoto(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: Placement,
  alpha: number, rotDeg: number, style: TileStyle,
) {
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
  const cx = r.dx + r.dw / 2, cy = r.dy + r.dh / 2
  ctx.translate(cx, cy)
  ctx.rotate((rotDeg * Math.PI) / 180)
  ctx.translate(-cx, -cy)
  const rad = Math.min(Math.max(0, style.radius), r.dw / 2, r.dh / 2)
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 36
  ctx.shadowOffsetY = 14
  roundRectPath(ctx, r, rad)
  ctx.fillStyle = '#000'
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  if (style.outlineWidth > 0) {
    roundRectPath(ctx, r, rad)
    ctx.strokeStyle = style.outlineColor
    ctx.lineWidth = style.outlineWidth
    ctx.stroke()
  }
  roundRectPath(ctx, r, rad)
  ctx.clip()
  ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh)
  ctx.restore()
}

function sketchHandAspect(hand: CanvasImageSource): number {
  const o = hand as unknown as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  const w = o.naturalWidth || o.width || 1
  const h = o.naturalHeight || o.height || 1
  return h / Math.max(1, w)
}

/**
 * Whiteboard sketch intro: paper card in the full rect, edge vectors drawn
 * by the brush engine on the show's clock, hand riding the stroke tip.
 */
function drawSketchCard(
  ctx: CanvasRenderingContext2D,
  s: ShowSlot,
  entry: SketchEntry,
  sk: SketchRenderState,
  t: number,
) {
  const o = sk.options
  const dur = Math.max(0.5, o.duration)
  const lt = Math.min(Math.max(0, t), dur)
  const r = s.full
  // paper card
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 36
  ctx.shadowOffsetY = 14
  ctx.fillStyle = o.paperColor
  ctx.fillRect(r.dx, r.dy, r.dw, r.dh)
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = 'rgba(0,0,0,0.15)'
  ctx.lineWidth = 2
  ctx.strokeRect(r.dx, r.dy, r.dw, r.dh)
  ctx.restore()
  // sketch strokes, clipped to the card
  const tl = buildTimeline(entry.strokes, dur, 0.05, 0, 0)
  const st: RenderSettings = {
    ...DEFAULT_SETTINGS,
    strokeColor: o.strokeColor,
    lineWidth: o.lineWidth,
    brushType: 'marker',
    fillMode: 'outlines',
    paperColor: o.paperColor,
    duration: dur,
    showHand: false,
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(r.dx, r.dy, r.dw, r.dh)
  ctx.clip()
  entry.engine.drawSketch(ctx, entry.strokes, tl, lt, st, null)
  ctx.restore()
  // hand on the live stroke tip
  if (o.showHand && sk.hand && entry.strokes.length) {
    const hs = handStateAt(entry.strokes, tl, lt)
    const handPx = 300 * Math.max(0.4, o.handScale)
    const hw = handPx
    const hh = handPx * sketchHandAspect(sk.hand)
    ctx.save()
    ctx.translate(hs.x, hs.y)
    ctx.rotate(Math.sin(lt * 3.1) * 0.03)
    ctx.globalAlpha = 0.98
    ctx.drawImage(sk.hand, -hw * DEFAULT_SETTINGS.anchorX, -hh * DEFAULT_SETTINGS.anchorY, hw, hh)
    ctx.restore()
  }
}

function backdropSize(bg: CanvasImageSource): [number, number] {
  const o = bg as unknown as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  if (o.naturalWidth && o.naturalHeight) return [o.naturalWidth, o.naturalHeight]
  return [o.width || 16, o.height || 9]
}

function paintBackdrop(ctx: CanvasRenderingContext2D, bg: string | CanvasImageSource) {
  if (typeof bg === 'string') {
    ctx.save()
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.restore()
    return
  }
  // cover-fit (crop, never stretch)
  const [iw, ih] = backdropSize(bg)
  const k = Math.max(CANVAS_W / iw, CANVAS_H / ih)
  const dw = iw * k, dh = ih * k
  ctx.save()
  ctx.drawImage(bg, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh)
  ctx.restore()
}

/** Pushpin anchor: top-center of a tile, just inside the upper edge. */
export const PIN_INSET = 16

/** Top-center pin point of a (possibly rotated) tile. */
export function pinPoint(
  t: { cx: number; cy: number; w: number; h: number; rot: number },
  inset = PIN_INSET,
): Pt {
  const rad = (t.rot * Math.PI) / 180
  const lx = 0
  const ly = -t.h / 2 + Math.min(inset, t.h / 2)
  return {
    x: t.cx + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: t.cy + lx * Math.sin(rad) + ly * Math.cos(rad),
  }
}

/** Glossy pushpin head with a soft contact shadow. */
export function drawPin(ctx: CanvasRenderingContext2D, p: Pt) {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.ellipse(p.x + 3, p.y + 6, 12, 6, 0, 0, Math.PI * 2)
  ctx.fill()
  const g = ctx.createRadialGradient(p.x - 3, p.y - 4, 1, p.x, p.y, 12)
  g.addColorStop(0, '#ff7b7b')
  g.addColorStop(0.55, '#d61f1f')
  g.addColorStop(1, '#8f1010')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(p.x, p.y, 11, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.beginPath()
  ctx.arc(p.x - 3.5, p.y - 4, 2.6, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * One detective-board yarn string: a smooth gravity-sagged quadratic curve
 * from pin A to pin B with a faint deterministic sideways wobble (stable per
 * link index, so it never swims between frames). Drawn partial by arc length
 * for the landing grow animation — dense sampling keeps it corner-free.
 */
export function drawYarn(
  ctx: CanvasRenderingContext2D,
  A: Pt,
  B: Pt,
  frac: number,
  linkIndex: number,
  color: string,
) {
  const dx = B.x - A.x
  const dy = B.y - A.y
  const dist = Math.hypot(dx, dy)
  if (dist < 4 || frac <= 0) return
  const sag = Math.min(90, Math.max(18, dist * 0.055))
  const wob = (((linkIndex * 37) % 11) / 10 - 0.5) * dist * 0.05
  const nx = -dy / dist
  const ny = dx / dist
  const C = { x: (A.x + B.x) / 2 + nx * wob, y: (A.y + B.y) / 2 + ny * wob + sag }
  // dense bezier samples → smooth partial polyline, no corners ever
  const N = 48
  const pts: Pt[] = []
  for (let k = 0; k <= N; k++) {
    const u = k / N
    const iu = 1 - u
    pts.push({
      x: iu * iu * A.x + 2 * iu * u * C.x + u * u * B.x,
      y: iu * iu * A.y + 2 * iu * u * C.y + u * u * B.y,
    })
  }
  let total = 0
  const cum = [0]
  for (let k = 1; k < pts.length; k++) {
    total += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
    cum.push(total)
  }
  const want = total * Math.min(1, Math.max(0, frac))
  const part: Pt[] = [pts[0]]
  for (let k = 1; k < pts.length; k++) {
    if (want <= cum[k - 1]) break
    const segLen = Math.max(1e-9, cum[k] - cum[k - 1])
    const q = Math.min(1, (want - cum[k - 1]) / segLen)
    part.push({
      x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * q,
      y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * q,
    })
    if (q < 1) break
  }
  if (part.length < 2) return
  const passes: [string, number, number][] = [
    ['rgba(0,0,0,0.65)', 15, 1],
    [color, 8, 0.95],
  ]
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [style, width, alpha] of passes) {
    ctx.strokeStyle = style
    ctx.lineWidth = width
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(part[0].x, part[0].y)
    for (let k = 1; k < part.length; k++) ctx.lineTo(part[k].x, part[k].y)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * A slot's rect + rotation at time `t`, mirroring the draw phases below, so
 * order lines attach to flying photos — not to where they will land.
 */
function slotPose(s: ShowSlot, time: number): { rect: Placement; rot: number } {
  if (time < s.holdEnd) return { rect: s.full, rot: 0 }
  if (time < s.exitEnd) {
    const p = easeInOutCubic((time - s.holdEnd) / Math.max(1e-6, s.exitEnd - s.holdEnd))
    return { rect: lerpRect(s.full, s.finalRect, p), rot: s.finalRot * p }
  }
  return { rect: s.finalRect, rot: s.finalRot }
}

export function renderShowcaseFrame(
  ctx: CanvasRenderingContext2D,
  items: ShowItem[],
  tl: ShowTimeline,
  time: number,
  bg: string | CanvasImageSource = '#0e0e12',
  connectColor: string | null = null,
  style: TileStyle = DEFAULT_TILE_STYLE,
  sketch: SketchRenderState | null = null,
) {
  ctx.save()
  paintBackdrop(ctx, bg)
  for (const s of tl.slots) {
    if (time < s.start) continue
    // optional sketch intro: hand-draw the image on a paper card first,
    // then it pops full-size and docks like usual
    const skEntry = sketch && sketch.options.enabled && tl.sketch > 0 && time < s.sketchEnd
      ? sketch.entries.get(s.item.id)
      : undefined
    if (skEntry && skEntry.strokes.length) {
      drawSketchCard(ctx, s, skEntry, sketch!, time - s.start)
    } else if (time < s.enterEnd) {
      // pop in: scale + fade
      const p = Math.min(1, (time - s.start) / Math.max(1e-6, s.enterEnd - s.start))
      const sc = 0.72 + 0.28 * easeOutBack(p)
      const cx = s.full.dx + s.full.dw / 2, cy = s.full.dy + s.full.dh / 2
      const r: Placement = {
        dw: s.full.dw * sc, dh: s.full.dh * sc,
        dx: cx - (s.full.dw * sc) / 2, dy: cy - (s.full.dh * sc) / 2,
      }
      drawPhoto(ctx, s.item.img, r, p, 0, style)
    } else if (time < s.holdEnd) {
      drawPhoto(ctx, s.item.img, s.full, 1, 0, style)
    } else if (time < s.exitEnd) {
      // glide into the final lineup slot (position, size and tilt)
      const p = easeInOutCubic((time - s.holdEnd) / Math.max(1e-6, s.exitEnd - s.holdEnd))
      drawPhoto(ctx, s.item.img, lerpRect(s.full, s.finalRect, p), 1, s.finalRot * p, style)
    } else {
      drawPhoto(ctx, s.item.img, s.finalRect, 1, s.finalRot, style)
    }
  }
  // detective board: pushpins + sagging yarn over the docked lineup —
  // but NEVER over the presented image: the current slot owns the top layer
  // from the moment it starts until it finishes docking, so its exact
  // silhouette (rotated while flying) is cut out of the yarn layer and
  // strings visibly dive behind the feature. Its own pin still draws on top.
  if (connectColor) {
    const featured = tl.slots.find(s => time >= s.start && time < s.exitEnd) ?? null
    const holePose = featured ? slotPose(featured, time) : null
    const holePoly: Pt[] | null = holePose
      ? rotatedCorners(
        holePose.rect.dx + holePose.rect.dw / 2,
        holePose.rect.dy + holePose.rect.dh / 2,
        holePose.rect.dw,
        holePose.rect.dh,
        holePose.rot,
      )
      : null
    // generous bounds for the pin-burial test (pin radius + soft edge)
    const holeBox = holePoly
      ? {
        x0: Math.min(...holePoly.map(p => p.x)) - 14,
        y0: Math.min(...holePoly.map(p => p.y)) - 14,
        x1: Math.max(...holePoly.map(p => p.x)) + 14,
        y1: Math.max(...holePoly.map(p => p.y)) + 14,
      }
      : null
    const pins: (Pt | null)[] = tl.slots.map(s => {
      if (time < s.enterEnd) return null
      const pose = slotPose(s, time)
      return pinPoint(
        {
          cx: pose.rect.dx + pose.rect.dw / 2,
          cy: pose.rect.dy + pose.rect.dh / 2,
          w: pose.rect.dw,
          h: pose.rect.dh,
          rot: pose.rot,
        },
        PIN_INSET,
      )
    })
    // yarn first (pins cap the ends), clipped around the feature
    ctx.save()
    if (holePoly && holePoly.length > 2) {
      ctx.beginPath()
      ctx.rect(0, 0, CANVAS_W, CANVAS_H)
      // reversed winding → hole under the even-odd rule
      ctx.moveTo(holePoly[0].x, holePoly[0].y)
      for (let k = holePoly.length - 1; k >= 0; k--) {
        ctx.lineTo(holePoly[k].x, holePoly[k].y)
      }
      ctx.closePath()
      ctx.clip('evenodd')
    }
    for (let i = 0; i + 1 < pins.length; i++) {
      const A = pins[i]
      const B = pins[i + 1]
      if (!A || !B) continue
      // string i appears with image i+1: grows while it travels, complete on dock
      const b = tl.slots[i + 1]
      if (time < b.holdEnd) continue
      const p = Math.min(1, (time - b.holdEnd) / Math.max(1e-6, b.exitEnd - b.holdEnd))
      const pe = 1 - Math.pow(1 - p, 3) // easeOutCubic draw-on
      if (pe <= 0.01) continue
      drawYarn(ctx, A, B, pe, i, connectColor)
    }
    ctx.restore()
    for (let k = 0; k < pins.length; k++) {
      const pin = pins[k]
      if (!pin) continue
      const isFeatured = featured !== null && tl.slots[k] === featured
      // pins buried under the feature stay hidden with their photo —
      // except the feature's own pin, which sits proudly on top
      if (!isFeatured && holeBox && pin.x > holeBox.x0 && pin.x < holeBox.x1 && pin.y > holeBox.y0 && pin.y < holeBox.y1) {
        continue
      }
      drawPin(ctx, pin)
    }
  }
  ctx.restore()
}
