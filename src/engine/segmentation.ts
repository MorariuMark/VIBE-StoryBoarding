/**
 * Click-to-remove segmentation (magic wand + solid color).
 * Works on a downscaled copy for instant live preview; the final cutout is
 * applied at full resolution by upscaling the feathered mask.
 */

export interface Seed { x: number; y: number }

function colorDist(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2
  // weighted euclidean: green carries luminance, matches perception better
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3
}

/**
 * Magic wand: union of contiguous flood fills from each seed.
 * Returns 1 = selected (to remove).
 */
export function wandMask(
  rgb: Uint8ClampedArray, w: number, h: number, seeds: Seed[], tol: number,
): Uint8Array {
  const sel = new Uint8Array(w * h)
  const stack: number[] = []
  for (const s of seeds) {
    const sx = Math.min(w - 1, Math.max(0, Math.round(s.x)))
    const sy = Math.min(h - 1, Math.max(0, Math.round(s.y)))
    const si = sy * w + sx
    if (sel[si]) continue
    const sr = rgb[si * 4], sg = rgb[si * 4 + 1], sb = rgb[si * 4 + 2]
    stack.push(si)
    sel[si] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w, y = (i / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (sel[j]) continue
          if (colorDist(sr, sg, sb, rgb[j * 4], rgb[j * 4 + 1], rgb[j * 4 + 2]) <= tol) {
            sel[j] = 1
            stack.push(j)
          }
        }
      }
    }
  }
  return sel
}

/**
 * Solid color remover: every pixel similar to any seed, anywhere in the image.
 * Connected components smaller than minSize px are protected (keeps small
 * details/highlights that happen to share the color).
 */
export function solidMask(
  rgb: Uint8ClampedArray, w: number, h: number, seeds: Seed[], tol: number, minSize: number,
): Uint8Array {
  const match = new Uint8Array(w * h)
  const cols = seeds.map(s => {
    const x = Math.min(w - 1, Math.max(0, Math.round(s.x)))
    const y = Math.min(h - 1, Math.max(0, Math.round(s.y)))
    const i = y * w + x
    return [rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2]]
  })
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 4], g = rgb[i * 4 + 1], b = rgb[i * 4 + 2]
    for (const c of cols) {
      if (colorDist(c[0], c[1], c[2], r, g, b) <= tol) { match[i] = 1; break }
    }
  }
  if (minSize <= 0) return match
  // drop small components (detail guard)
  const labels = new Int32Array(w * h).fill(-1)
  const sel = new Uint8Array(w * h)
  const queue: number[] = []
  let comp = 0
  for (let i = 0; i < w * h; i++) {
    if (!match[i] || labels[i] !== -1) continue
    queue.length = 0
    queue.push(i)
    labels[i] = comp
    const cells: number[] = [i]
    while (queue.length) {
      const c = queue.pop()!
      const x = c % w, y = (c / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (!match[j] || labels[j] !== -1) continue
          labels[j] = comp
          cells.push(j)
          queue.push(j)
        }
      }
    }
    if (cells.length >= minSize) {
      for (const c of cells) sel[c] = 1
    }
    comp++
  }
  return sel
}

/** Soften a binary mask (feathered cutout edges). */
export function featherMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask
  const src = Float32Array.from(mask, v => v * 255)
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -r; x < w + r; x++) {
      acc += src[y * w + Math.min(w - 1, Math.max(0, x))]
      const xo = x - r
      if (xo >= 0 && xo < w) {
        tmp[y * w + xo] = acc / (2 * r + 1)
        acc -= src[y * w + Math.min(w - 1, Math.max(0, x - 2 * r))]
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) acc += tmp[yy * w + x]
      const n = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1
      out[y * w + x] = Math.round(acc / n)
    }
  }
  return out
}

export function invertMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i]
  return out
}

/**
 * Apply a working-res selection mask to the full-res source → cutout canvas.
 * The mask is upscaled smoothly, so edges stay soft at full resolution.
 * `remove=true`: masked area becomes transparent; false keeps only the mask.
 */
export function cutoutWithMask(
  src: HTMLImageElement, mask: Uint8Array, mw: number, mh: number, remove = true,
): HTMLCanvasElement {
  const W = src.naturalWidth, H = src.naturalHeight
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.drawImage(src, 0, 0, W, H)
  const mc = document.createElement('canvas')
  mc.width = mw; mc.height = mh
  const mctx = mc.getContext('2d')!
  const img = mctx.createImageData(mw, mh)
  for (let i = 0; i < mw * mh; i++) {
    const a = remove ? 255 - mask[i] : mask[i]
    img.data[i * 4 + 3] = Math.max(0, Math.min(255, a))
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255
  }
  mctx.putImageData(img, 0, 0)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(mc, 0, 0, W, H)
  ctx.restore()
  return c
}
