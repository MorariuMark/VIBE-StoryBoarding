import { CANVAS_H, CANVAS_W, type Pt, type Stroke } from './types'

/** 2D affine matrix {a,b,c,d,e,f} as in SVG. */
export interface Mat { a: number; b: number; c: number; d: number; e: number; f: number }
const IDENT_MAT: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function mulMat(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

function parseTransformAttr(attr: string): Mat {
  let m: Mat = { ...IDENT_MAT }
  const re = /(\w+)\s*\(([^)]*)\)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(attr))) {
    const name = mm[1]
    const args = mm[2].trim().split(/[\s,]+/).filter(s => s.length).map(Number).filter(isFinite)
    let t: Mat = { ...IDENT_MAT }
    if (name === 'translate') { t.e = args[0] || 0; t.f = args.length > 1 ? args[1] : 0 }
    else if (name === 'scale') { const sx = args.length ? args[0] : 1; t.a = sx; t.d = args.length > 1 ? args[1] : sx }
    else if (name === 'rotate') {
      const a = ((args[0] || 0) * Math.PI) / 180
      const cx = args.length > 2 ? args[1] : 0, cy = args.length > 2 ? args[2] : 0
      const cos = Math.cos(a), sin = Math.sin(a)
      t = { a: cos, b: sin, c: -sin, d: cos, e: cx - cx * cos + cy * sin, f: cy - cx * sin - cy * cos }
    }
    else if (name === 'skewX') { t.c = Math.tan(((args[0] || 0) * Math.PI) / 180) }
    else if (name === 'skewY') { t.b = Math.tan(((args[0] || 0) * Math.PI) / 180) }
    else if (name === 'matrix' && args.length >= 6) { t = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] } }
    else continue
    m = mulMat(m, t)
  }
  return m
}

/** Compose transform attributes from the element up through ancestor <g>s (outermost first). */
function ancestorsMatrix(el: Element): Mat {
  const chain: Element[] = []
  let cur: Element | null = el
  while (cur) { chain.unshift(cur); cur = cur.parentElement }
  let m: Mat = { ...IDENT_MAT }
  for (const node of chain) {
    const tr = node.getAttribute('transform')
    if (tr) m = mulMat(m, parseTransformAttr(tr))
  }
  return m
}

function applyMat(m: Mat, p: Pt): Pt {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

/** Parse an SVG file string into ordered point-array strokes, normalized to 1920x1080 space. */
export async function parseSvgToStrokes(svgText: string): Promise<Stroke[]> {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg) throw new Error('No <svg> root found.')

  // Determine source viewBox
  let vbW = 1000, vbH = 1000, vbX = 0, vbY = 0
  const vb = svg.getAttribute('viewBox')
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(isFinite)) { vbX = parts[0]; vbY = parts[1]; vbW = parts[2]; vbH = parts[3] }
  } else {
    const w = parseFloat(svg.getAttribute('width') || '1000')
    const h = parseFloat(svg.getAttribute('height') || '1000')
    if (isFinite(w) && isFinite(h)) { vbW = w; vbH = h }
  }

  // Hidden svg in DOM so getTotalLength works
  const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  holder.setAttribute('width', '0')
  holder.setAttribute('height', '0')
  holder.style.position = 'absolute'
  document.body.appendChild(holder)

  const toCanvas = (x: number, y: number): Pt => {
    // contain-fit into 1920x1080 with padding
    const pad = 120
    const scale = Math.min((CANVAS_W - pad * 2) / vbW, (CANVAS_H - pad * 2) / vbH)
    const ox = (CANVAS_W - vbW * scale) / 2
    const oy = (CANVAS_H - vbH * scale) / 2
    return { x: ox + (x - vbX) * scale, y: oy + (y - vbY) * scale }
  }

  const strokes: Stroke[] = []
  let id = 0
  const push = (points: Pt[], closed = false, mat: Mat = IDENT_MAT) => {
    if (points.length < 2) return
    // transform (element + ancestor groups) -> canvas space -> simplify there,
    // so tolerance stays in screen px regardless of viewBox scale
    const mapped = points.map(p => toCanvasPt(applyMat(mat, p)))
    const cleaned = simplifyDouglas(mapped, 1.6, 2.5)
    if (cleaned.length < 2) return
    strokes.push({ id: id++, points: cleaned, length: 0, closed })
  }
  const toCanvasPt = (p: Pt): Pt => toCanvas(p.x, p.y)

  const samplePath = (d: string): { pts: Pt[]; closed: boolean } => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    el.setAttribute('d', d)
    holder.appendChild(el)
    try {
      const total = (el as SVGPathElement).getTotalLength()
      if (!isFinite(total) || total <= 0) return { pts: [], closed: false }
      // dense sampling: simplify (in canvas space) decides what to keep later
      const n = Math.max(16, Math.min(2400, Math.floor(total / 1.5)))
      const pts: Pt[] = []
      for (let i = 0; i <= n; i++) {
        const p = (el as SVGPathElement).getPointAtLength((total * i) / n)
        pts.push({ x: p.x, y: p.y })
      }
      const closed = /z\s*$/i.test(d.trim())
      return { pts, closed }
    } finally {
      el.remove()
    }
  }

  const num = (el: Element, name: string, fb = 0) => {
    const v = parseFloat(el.getAttribute(name) || '')
    return isFinite(v) ? v : fb
  }
  const ptsFromAttr = (el: Element): Pt[] => {
    const raw = el.getAttribute('points') || ''
    return raw.trim().split(/[\s,]+/).map(Number).reduce<Pt[]>((acc, v, i, arr) => {
      if (i % 2 === 1) acc.push({ x: arr[i - 1], y: v })
      return acc
    }, []).filter(p => isFinite(p.x) && isFinite(p.y))
  }

  // <path>
  doc.querySelectorAll('path').forEach(p => {
    const d = p.getAttribute('d')
    if (!d) return
    const { pts, closed } = samplePath(d)
    if (pts.length) push(pts, closed, ancestorsMatrix(p))
  })
  // <polyline> <polygon>
  doc.querySelectorAll('polyline, polygon').forEach(el => {
    const pts = ptsFromAttr(el)
    if (pts.length >= 2) push(pts, el.tagName.toLowerCase() === 'polygon', ancestorsMatrix(el))
  })
  // <line>
  doc.querySelectorAll('line').forEach(el => {
    push([{ x: num(el, 'x1'), y: num(el, 'y1') }, { x: num(el, 'x2'), y: num(el, 'y2') }], false, ancestorsMatrix(el))
  })
  // <rect> -> outline
  doc.querySelectorAll('rect').forEach(el => {
    const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height')
    if (w > 0 && h > 0) push([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }], true, ancestorsMatrix(el))
  })
  // <circle> <ellipse> -> sampled (sample-then-transform handles rotation/non-uniform scale)
  doc.querySelectorAll('circle').forEach(el => {
    const cx = num(el, 'cx'), cy = num(el, 'cy'), r = num(el, 'r')
    if (r > 0) {
      const pts: Pt[] = []
      for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
      push(pts, true, ancestorsMatrix(el))
    }
  })
  doc.querySelectorAll('ellipse').forEach(el => {
    const cx = num(el, 'cx'), cy = num(el, 'cy'), rx = num(el, 'rx'), ry = num(el, 'ry')
    if (rx > 0 && ry > 0) {
      const pts: Pt[] = []
      for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }) }
      push(pts, true, ancestorsMatrix(el))
    }
  })

  holder.remove()

  // compute lengths (canvas space)
  for (const s of strokes) s.length = polyLength(s.points)

  // drop degenerate
  return strokes.filter(s => s.length > 4)
}

export function polyLength(pts: Pt[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

/** Lightweight Douglas-Peucker to cut point count while preserving shape. */
function simplifyDouglas(pts: Pt[], eps = 0.9, radial = 1.2): Pt[] {
  if (pts.length <= 8) return pts
  // radial pre-filter
  const pre: Pt[] = [pts[0]]
  for (const p of pts) {
    const l = pre[pre.length - 1]
    if (Math.hypot(p.x - l.x, p.y - l.y) > radial) pre.push(p)
  }
  if (pre.length <= 8) return pre
  const keep = new Array(pre.length).fill(false)
  keep[0] = keep[pre.length - 1] = true
  const stack: [number, number][] = [[0, pre.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let maxD = 0, idx = -1
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pre[i], pre[a], pre[b])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]) }
  }
  return pre.filter((_, i) => keep[i])
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  const cx = a.x + t * dx, cy = a.y + t * dy
  return Math.hypot(p.x - cx, p.y - cy)
}

/** Interpolate a point at arc-length distance d along a stroke. */
export function pointAtLength(stroke: Stroke, d: number): Pt {
  const pts = stroke.points
  if (d <= 0) return pts[0]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (acc + seg >= d) {
      const t = seg === 0 ? 0 : (d - acc) / seg
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
    }
    acc += seg
  }
  return pts[pts.length - 1]
}
