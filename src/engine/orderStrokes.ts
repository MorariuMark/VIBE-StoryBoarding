import type { Stroke } from './types'

export type OrderMode = 'natural' | 'directional'

/** Compass label for a sweep angle (screen coords, y down). */
export function compassLabel(angleDeg: number): string {
  const names: [number, string][] = [
    [0, '→ left-to-right'], [45, '↘ top-left to bottom-right'], [90, '↓ top-to-bottom'],
    [135, '↙ top-right to bottom-left'], [180, '← right-to-left'], [225, '↖ bottom-right to top-left'],
    [270, '↑ bottom-to-top'], [315, '↗ bottom-left to top-right'],
  ]
  const a = ((angleDeg % 360) + 360) % 360
  let best = names[0]
  for (const n of names) {
    const d = Math.abs(a - n[0])
    const bd = Math.abs(a - best[0])
    if (Math.min(d, 360 - d) < Math.min(bd, 360 - bd)) best = n
  }
  return best[1]
}

/**
 * Sequential sweep ordering: strokes sorted along the chosen direction, so the
 * hand progresses systematically across the image (e.g. top-to-bottom like reading).
 * Each stroke is oriented to draw with the sweep, not against it.
 */
export function orderStrokesDirectional(input: Stroke[], angleDeg: number): Stroke[] {
  const rad = (angleDeg * Math.PI) / 180
  const dx = Math.cos(rad), dy = Math.sin(rad)
  // secondary axis follows reading intuition: mostly-horizontal sweeps go top-first,
  // mostly-vertical sweeps go left-first
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const items = input.map(s => {
    const pts = [...s.points]
    let cx = 0, cy = 0
    for (const p of pts) { cx += p.x; cy += p.y }
    cx /= pts.length; cy /= pts.length
    return { s: { ...s, points: pts }, primary: cx * dx + cy * dy, secondary: horizontal ? cy : cx }
  })
  items.sort((a, b) => a.primary - b.primary || a.secondary - b.secondary)
  for (const it of items) {
    const p = it.s.points
    const ox = p[p.length - 1].x - p[0].x, oy = p[p.length - 1].y - p[0].y
    if (ox * dx + oy * dy < 0) p.reverse()
  }
  return items.map((it, i) => ({ ...it.s, id: i }))
}

/**
 * Natural drawing order: greedy nearest-neighbor traversal.
 * - Seed: topmost, then leftmost start zone.
 * - Repeatedly pick the unvisited stroke whose start OR end is closest
 *   to the current pen position; flip it if its end is closer.
 * This minimizes hand travel jumps like a human artist.
 */
export function orderStrokesNatural(input: Stroke[]): Stroke[] {
  if (input.length <= 1) return input.map(s => ({ ...s }))
  const remaining = input.map(s => ({ ...s, points: [...s.points] }))
  // Seed: minimal (y + 0.35x) of start point — top-to-bottom, left-to-right bias
  let seedIdx = 0, seedScore = Infinity
  remaining.forEach((s, i) => {
    const p = s.points[0]
    const score = p.y + p.x * 0.35
    if (score < seedScore) { seedScore = score; seedIdx = i }
  })
  // Also consider flipping seed if its end is more top-left (rare)
  const ordered: Stroke[] = []
  let cur = remaining.splice(seedIdx, 1)[0]
  // orient seed so it starts near top-left
  const sScore = cur.points[0].y + cur.points[0].x * 0.35
  const eScore = cur.points[cur.points.length - 1].y + cur.points[cur.points.length - 1].x * 0.35
  if (eScore < sScore) cur.points.reverse()
  ordered.push(cur)

  let pen = cur.points[cur.points.length - 1]
  while (remaining.length) {
    let best = 0, bestDist = Infinity, flip = false
    remaining.forEach((s, i) => {
      const a = s.points[0], b = s.points[s.points.length - 1]
      const da = Math.hypot(a.x - pen.x, a.y - pen.y)
      const db = Math.hypot(b.x - pen.x, b.y - pen.y)
      // small bias: prefer strokes that continue downward/rightward flow
      if (da < bestDist) { bestDist = da; best = i; flip = false }
      if (db < bestDist) { bestDist = db; best = i; flip = true }
    })
    const nxt = remaining.splice(best, 1)[0]
    if (flip) nxt.points.reverse()
    ordered.push(nxt)
    pen = nxt.points[nxt.points.length - 1]
  }
  // re-id
  ordered.forEach((s, i) => (s.id = i))
  return ordered
}
