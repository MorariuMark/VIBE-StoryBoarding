import type { Pt } from './types'

/** Shared binary-skeleton/edge tracing utilities: spur pruning, graph walks, fragment joining. */

export function smoothPath(p: Pt[]): Pt[] {
  if (p.length < 5) return p
  const out: Pt[] = [p[0]]
  for (let i = 1; i < p.length - 1; i++) {
    out.push({ x: (p[i - 1].x + p[i].x * 2 + p[i + 1].x) / 4, y: (p[i - 1].y + p[i].y * 2 + p[i + 1].y) / 4 })
  }
  out.push(p[p.length - 1])
  return out
}

/** Delete short branches that end at a junction (thinning/noise artifacts). Keeps isolated dots. */
export function pruneSpurs(bin: Uint8Array, w: number, h: number, minLen: number, passes: number) {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x])
  const deg = (x: number, y: number) => {
    let n = 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        if (at(x + dx, y + dy)) n++
      }
    return n
  }
  for (let pass = 0; pass < passes; pass++) {
    const kill: number[] = []
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!bin[y * w + x] || deg(x, y) !== 1) continue
        // walk the branch from this endpoint
        const cells: number[] = [y * w + x]
        let cx = x, cy = y, px = -1, py = -1
        let hitsJunction = false
        for (let s = 0; s < minLen + 2; s++) {
          let moved = false
          for (let dy = -1; dy <= 1 && !moved; dy++) {
            for (let dx = -1; dx <= 1 && !moved; dx++) {
              if (!dx && !dy) continue
              const nx = cx + dx, ny = cy + dy
              if ((nx === px && ny === py) || !at(nx, ny)) continue
              if (cells.includes(ny * w + nx)) continue
              cells.push(ny * w + nx)
              px = cx; py = cy; cx = nx; cy = ny
              moved = true
            }
          }
          if (!moved) break
          if (deg(cx, cy) > 2) { hitsJunction = true; break }
          if (deg(cx, cy) === 1 && cells.length > 1) break // reached far endpoint
        }
        // Only prune true spurs: short branch anchored at a junction.
        // Isolated short components (dots, dashes) are kept.
        if (hitsJunction && cells.length - 1 < minLen) {
          for (let i = 0; i < cells.length - 1; i++) kill.push(cells[i])
        }
      }
    }
    if (!kill.length) break
    for (const i of kill) bin[i] = 0
  }
}

/** Walk a 1px binary graph into ordered polylines (junction pass-through, loops supported). */
export function traceSkeleton(bin: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x])
  const neighbors = (x: number, y: number): [number, number][] => {
    const out: [number, number][] = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        if (at(x + dx, y + dy)) out.push([x + dx, y + dy])
      }
    return out
  }
  const degree = (x: number, y: number) => neighbors(x, y).length
  const visited = new Uint8Array(w * h)
  const paths: Pt[][] = []

  const walk = (sx: number, sy: number): Pt[] => {
    const path: Pt[] = [{ x: sx, y: sy }]
    visited[sy * w + sx] = 1
    let cx = sx, cy = sy, px = -1, py = -1
    let idx = 0, idy = 0, hasIn = false
    for (let guard = 0; guard < w * h; guard++) {
      const nbs = neighbors(cx, cy).filter(([nx, ny]) => !(nx === px && ny === py) && !visited[ny * w + nx])
      if (!nbs.length) break // dead end
      // rank by collinearity with incoming direction (junction pass-through)
      let best = nbs[0], bestAlign = -Infinity
      for (const [nx, ny] of nbs) {
        const dx = nx - cx, dy = ny - cy
        const len = Math.hypot(dx, dy) || 1
        const align = !hasIn ? 1 : (dx / len) * idx + (dy / len) * idy
        // tie-break: prefer pixels that are not forks, deterministically
        const score = align * 10 - (degree(nx, ny) > 2 ? 0.5 : 0) - ((nx * 7 + ny * 13) % 5) * 0.001
        if (score > bestAlign) { bestAlign = score; best = [nx, ny] }
      }
      const bdx = best[0] - cx, bdy = best[1] - cy
      const blen = Math.hypot(bdx, bdy) || 1
      const contAlign = !hasIn ? 1 : (bdx / blen) * idx + (bdy / blen) * idy
      // At a true fork/corner (no straight continuation), stop here so each
      // branch becomes its own stroke; otherwise walk straight through.
      if (hasIn && degree(cx, cy) > 2 && nbs.length > 1 && contAlign < 0.5) break
      px = cx; py = cy; cx = best[0]; cy = best[1]
      idx = (cx - px) / (Math.hypot(cx - px, cy - py) || 1)
      idy = (cy - py) / (Math.hypot(cx - px, cy - py) || 1)
      hasIn = true
      visited[cy * w + cx] = 1
      path.push({ x: cx, y: cy })
    }
    return path
  }

  // pass 1: start from endpoints (degree==1)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!at(x, y) || visited[y * w + x]) continue
      if (degree(x, y) === 1) {
        const p = walk(x, y)
        if (p.length >= 3) paths.push(p)
      }
    }
  // pass 2: remaining (loops / junction leftovers)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!at(x, y) || visited[y * w + x]) continue
      const p = walk(x, y)
      if (p.length >= 3) paths.push(p)
    }
  return paths
}

/**
 * Greedily concatenate fragments whose endpoints nearly meet with aligned tangents.
 * Single-pass Kruskal-style match over static endpoint pairs (merging never moves
 * free endpoints, so no iteration is needed) with a spatial hash — O(E·k) instead
 * of the old O(P²)-per-iteration scan that froze the tab on detailed images.
 */
export function joinFragments(paths: Pt[][], maxGap: number, minAlign: number): Pt[][] {
  const P: Pt[][] = paths.map(p => [...p]).filter(p => p.length >= 2)
  const n = P.length
  if (n < 2) return P

  const tangentOf = (p: Pt[], atEnd: boolean): Pt => {
    const m = p.length
    const a = atEnd ? p[m - 1] : p[0]
    // step back up to ~6px for a stable direction
    let k = atEnd ? m - 2 : 1
    while (k >= 0 && k < m && Math.hypot(p[k].x - a.x, p[k].y - a.y) < 6) k += atEnd ? -1 : 1
    k = Math.max(0, Math.min(m - 1, k))
    const dx = atEnd ? a.x - p[k].x : p[k].x - a.x
    const dy = atEnd ? a.y - p[k].y : p[k].y - a.y
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
  }

  interface End { path: number; end: 0 | 1; x: number; y: number; tx: number; ty: number }
  const ends: End[] = []
  P.forEach((p, i) => {
    const ts = tangentOf(p, false), te = tangentOf(p, true)
    ends.push({ path: i, end: 0, x: p[0].x, y: p[0].y, tx: ts.x, ty: ts.y })
    ends.push({ path: i, end: 1, x: p[p.length - 1].x, y: p[p.length - 1].y, tx: te.x, ty: te.y })
  })

  // spatial hash so only nearby endpoints are ever compared
  const cell = Math.max(1, maxGap)
  const grid = new Map<string, number[]>()
  ends.forEach((e, idx) => {
    const key = Math.floor(e.x / cell) + ',' + Math.floor(e.y / cell)
    let arr = grid.get(key)
    if (!arr) { arr = []; grid.set(key, arr) }
    arr.push(idx)
  })

  interface Pair { a: number; b: number; score: number }
  const pairs: Pair[] = []
  ends.forEach((e, ai) => {
    const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell)
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = grid.get(gx + ',' + gy)
        if (!arr) continue
        for (const bi of arr) {
          if (bi <= ai) continue
          const f = ends[bi]
          const dist = Math.hypot(e.x - f.x, e.y - f.y)
          if (dist > maxGap) continue
          // Traversal enters/exits through the linked ends: same-side pairs
          // (end-end, start-start) traverse one path backward, so their
          // tangents must oppose; mixed pairs must agree.
          const sameSide = e.end === f.end
          const align = (sameSide ? -1 : 1) * (e.tx * f.tx + e.ty * f.ty)
          if (align < minAlign) continue
          pairs.push({ a: ai, b: bi, score: dist - align * maxGap * 0.5 })
        }
      }
    }
  })
  pairs.sort((u, v) => u.score - v.score)

  // greedy accept: each endpoint joins at most once
  const link = new Map<number, number>()
  const used = new Set<number>()
  for (const pr of pairs) {
    if (used.has(pr.a) || used.has(pr.b)) continue
    used.add(pr.a); used.add(pr.b)
    link.set(pr.a, pr.b); link.set(pr.b, pr.a)
  }

  // stitch chains (components have max degree 2 by construction)
  const visited = new Array<boolean>(n).fill(false)
  const out: Pt[][] = []
  const endIdx = (path: number, end: 0 | 1) => path * 2 + end
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue
    visited[i] = true
    const chain: { path: number; rev: boolean }[] = [{ path: i, rev: false }]
    // extend forward from chain-last's free end (orient newcomer linked-end-first)
    for (;;) {
      const last = chain[chain.length - 1]
      const freeEnd: 0 | 1 = last.rev ? 0 : 1
      const li = link.get(endIdx(last.path, freeEnd))
      if (li === undefined) break
      const j = ends[li].path
      if (visited[j]) break
      chain.push({ path: j, rev: ends[li].end === 1 })
      visited[j] = true
    }
    // extend backward (orient newcomer linked-end-last)
    for (;;) {
      const first = chain[0]
      const freeEnd: 0 | 1 = first.rev ? 1 : 0
      const li = link.get(endIdx(first.path, freeEnd))
      if (li === undefined) break
      const j = ends[li].path
      if (visited[j]) break
      chain.unshift({ path: j, rev: ends[li].end === 0 })
      visited[j] = true
    }
    // concat, dropping the shared joint pixel
    let merged: Pt[] = []
    chain.forEach((s, k) => {
      const seg = s.rev ? [...P[s.path]].reverse() : P[s.path]
      merged = k === 0 ? [...seg] : [...merged, ...seg.slice(1)]
    })
    out.push(merged)
  }
  return out
}
