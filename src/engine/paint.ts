/**
 * Topaz-Impression-style paint finishes, rendered once per image+settings and
 * used as the reveal bitmap (the animation engine stays untouched).
 * - painting: Hertzmann-lite stroke rendering, coarse->fine, strokes follow
 *   image gradients, textured dabs, optional ink outlines from the sketch edges.
 * - pencil: luminance dodge sketch + contrast + paper tooth + dark edges.
 */

export type PaintStyle = 'photo' | 'painting' | 'pencil'
export type PaintDensity = 'low' | 'med' | 'high'

export interface PaintOptions {
  style: PaintStyle
  size: number // brush px at working res (painting)
  density: PaintDensity // stroke coverage (painting)
  pencilStrength: number // 0..1 contrast/darkness (pencil)
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Separable box blur approximating gaussian (2 passes). */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(w * h)
  const res = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -r; x < w + r; x++) {
      const xx = Math.min(w - 1, Math.max(0, x))
      acc += src[y * w + xx]
      const xOut = x - r
      if (xOut >= 0 && xOut < w) {
        tmp[y * w + xOut] = acc / (2 * r + 1)
        const xDrop = x - 2 * r
        if (xDrop >= 0) acc -= src[y * w + Math.min(w - 1, xDrop)]
        else acc -= src[y * w]
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y < h + r; y++) {
      const yy = Math.min(h - 1, Math.max(0, y))
      acc += tmp[yy * w + x]
      const yOut = y - r
      if (yOut >= 0 && yOut < h) {
        res[yOut * w + x] = acc / (2 * r + 1)
        const yDrop = y - 2 * r
        acc -= tmp[Math.min(h - 1, Math.max(0, yDrop)) * w + x]
      }
    }
  }
  return res
}

function drawSourceCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number) {
  ctx.save()
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  ctx.restore()
}

async function renderPainting(
  src: HTMLImageElement, size: number, density: PaintDensity,
): Promise<HTMLCanvasElement> {
  const W = 880
  const scale = W / src.naturalWidth
  const H = Math.max(8, Math.round(src.naturalHeight * scale))
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })!

  // underpainting: heavily blurred photo so every pixel is covered
  const tiny = document.createElement('canvas')
  tiny.width = 32; tiny.height = Math.max(2, Math.round((32 * H) / W))
  tiny.getContext('2d')!.drawImage(src, 0, 0, tiny.width, tiny.height)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(tiny, 0, 0, W, H)

  // working buffers: color + luminance
  const work = document.createElement('canvas')
  work.width = W; work.height = H
  const wctx = work.getContext('2d', { willReadFrequently: true })!
  drawSourceCover(wctx, src, W, H)
  const data = wctx.getImageData(0, 0, W, H).data
  const gray = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  const soft = boxBlur(gray, W, H, 2)
  await tick()

  const rnd = mulberry(1234567)
  const stepMul = density === 'low' ? 1.3 : density === 'high' ? 0.6 : 0.9
  const layers = [
    { sizeMul: 2.3, alpha: 0.9 },
    { sizeMul: 1.0, alpha: 0.9 },
  ]
  for (const L of layers) {
    const step = Math.max(2, size * L.sizeMul * stepMul)
    const len = size * L.sizeMul * 2.2
    const wid = Math.max(1.5, size * L.sizeMul * 0.9)
    for (let gy = step / 2; gy < H; gy += step) {
      for (let gx = step / 2; gx < W; gx += step) {
        const x = Math.min(W - 1, Math.max(0, Math.round(gx + (rnd() - 0.5) * step * 0.9)))
        const y = Math.min(H - 1, Math.max(0, Math.round(gy + (rnd() - 0.5) * step * 0.9)))
        const i = y * W + x
        // orientation along the local edge (perpendicular of the gradient)
        const gxA = soft[i + 1] - soft[i - 1]
        const gyA = soft[i + W] - soft[i - W]
        const ang = Math.abs(gxA) + Math.abs(gyA) < 2 ? rnd() * Math.PI : Math.atan2(gyA, gxA) + Math.PI / 2 + (rnd() - 0.5) * 0.5
        const px = data[i * 4], py = data[i * 4 + 1], pz = data[i * 4 + 2]
        ctx.save()
        ctx.globalAlpha = L.alpha
        ctx.translate(x, y)
        ctx.rotate(ang)
        ctx.fillStyle = `rgb(${px},${py},${pz})`
        ctx.beginPath()
        ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
      if ((gy / step) % 12 === 0) await tick()
    }
  }

  // canvas tooth: fine monochrome grain over everything
  grainOverlay(ctx, W, H, 0.08, 777)
  applySourceAlpha(ctx, src, W, H)
  return c
}

async function renderPencil(
  src: HTMLImageElement, strength: number,
): Promise<HTMLCanvasElement> {
  const W = Math.min(1400, src.naturalWidth)
  const scale = W / src.naturalWidth
  const H = Math.max(8, Math.round(src.naturalHeight * scale))
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  drawSourceCover(ctx, src, W, H)
  const data = ctx.getImageData(0, 0, W, H).data
  const gray = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  await tick()
  // classic luminance dodge: darkens shadows into graphite, keeps paper white
  const blurred = boxBlur(gray.map(v => 255 - v), W, H, Math.max(3, W / 90))
  await tick()
  const contrast = 1 + strength * 1.6
  const out = ctx.createImageData(W, H)
  const od = out.data
  for (let i = 0; i < W * H; i++) {
    const dodge = Math.min(255, (gray[i] * 255) / (255 - blurred[i] + 1))
    let v = (dodge - 128) * contrast + 128
    v = Math.max(0, Math.min(255, v))
    od[i * 4] = v; od[i * 4 + 1] = v; od[i * 4 + 2] = v; od[i * 4 + 3] = 255
  }
  ctx.putImageData(out, 0, 0)

  grainOverlay(ctx, W, H, 0.1 + strength * 0.06, 4242)
  applySourceAlpha(ctx, src, W, H)
  return c
}

/** Constrain the finish to the subject silhouette (lets cutouts stay transparent). */
function applySourceAlpha(ctx: CanvasRenderingContext2D, src: HTMLImageElement, w: number, h: number) {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(src, 0, 0, w, h)
  ctx.restore()
}

/** Fine paper tooth over the finish. */
function grainOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number, seed: number) {
  const rnd = mulberry(seed)
  const tile = 128
  const t = document.createElement('canvas')
  t.width = tile; t.height = tile
  const tctx = t.getContext('2d')!
  const img = tctx.createImageData(tile, tile)
  for (let i = 0; i < tile * tile; i++) {
    const v = rnd() < 0.5 ? 0 : 255
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = Math.round(alpha * 255 * (0.5 + rnd() * 0.5))
  }
  tctx.putImageData(img, 0, 0)
  ctx.save()
  ctx.globalAlpha = 1
  const pat = ctx.createPattern(t, 'repeat')
  if (pat) {
    ctx.fillStyle = pat
    ctx.fillRect(0, 0, w, h)
  }
  ctx.restore()
}

export async function renderPaintedFinish(src: HTMLImageElement, opts: PaintOptions): Promise<HTMLCanvasElement> {
  if (opts.style === 'painting') {
    return renderPainting(src, opts.size, opts.density)
  }
  return renderPencil(src, opts.pencilStrength)
}
