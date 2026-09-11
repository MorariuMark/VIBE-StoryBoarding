/**
 * Canny edge detection (grayscale Float32 input):
 * Gaussian blur -> Sobel gradients -> non-maximum suppression ->
 * double threshold + hysteresis. Outputs a 1px binary edge map.
 */

export function gaussianBlur(src: Float32Array, w: number, h: number, sigma = 1): Float32Array {
  if (sigma <= 0) return src
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const k: number[] = []
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k.push(v)
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  // horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -radius; i <= radius; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i))
        s += src[y * w + xx] * k[i + radius]
      }
      tmp[y * w + x] = s
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -radius; i <= radius; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i))
        s += tmp[yy * w + x] * k[i + radius]
      }
      out[y * w + x] = s
    }
  }
  return out
}

export function cannyEdges(blurred: Float32Array, w: number, h: number, low: number, high: number): Uint8Array {
  const mag = new Float32Array(w * h)
  const sector = new Uint8Array(w * h) // 0: E-W, 1: NE-SW, 2: N-S, 3: NW-SE

  // Sobel gradients
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx =
        -blurred[i - w - 1] - 2 * blurred[i - 1] - blurred[i + w - 1] +
        blurred[i - w + 1] + 2 * blurred[i + 1] + blurred[i + w + 1]
      const gy =
        -blurred[i - w - 1] - 2 * blurred[i - w] - blurred[i - w + 1] +
        blurred[i + w - 1] + 2 * blurred[i + w] + blurred[i + w + 1]
      mag[i] = Math.hypot(gx, gy)
      // quantize direction into 4 sectors (0..180 deg)
      let a = (Math.atan2(gy, gx) * 180) / Math.PI
      if (a < 0) a += 180
      sector[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3
    }
  }

  // Non-maximum suppression -> thin edges
  const thin = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]
      if (m < low) continue
      const s = sector[i]
      let n1 = 0, n2 = 0
      if (s === 0) { n1 = mag[i - 1]; n2 = mag[i + 1] }
      else if (s === 2) { n1 = mag[i - w]; n2 = mag[i + w] }
      else if (s === 1) { n1 = mag[i - w + 1]; n2 = mag[i + w - 1] }
      else { n1 = mag[i - w - 1]; n2 = mag[i + w + 1] }
      if (m >= n1 && m >= n2) thin[i] = m
    }
  }

  // Double threshold + hysteresis: strong pixels flood through weak ones
  const STRONG = 2, WEAK = 1
  const tags = new Uint8Array(w * h)
  const stack: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (thin[i] >= high) { tags[i] = STRONG; stack.push(i) }
    else if (thin[i] >= low) tags[i] = WEAK
  }
  const out = new Uint8Array(w * h)
  while (stack.length) {
    const i = stack.pop()!
    if (out[i]) continue
    out[i] = 1
    const x = i % w, y = (i / w) | 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (!out[j] && tags[j] >= WEAK) stack.push(j)
      }
    }
  }
  return out
}
