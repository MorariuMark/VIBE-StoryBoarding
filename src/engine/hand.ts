/**
 * Procedural default hand graphic: cartoon hand holding a marker,
 * drawn onto an offscreen canvas. Pen tip at bottom-center (~0.5, 0.92).
 * Returns an HTMLCanvasElement usable as drawImage source.
 */
export function createDefaultHand(size = 320): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const S = size / 320
  ctx.scale(S, S)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const skin = '#f2c9a0'
  const skinShade = '#d9a06f'
  const sleeve = '#4f46e5'
  const sleeveDark = '#3730a3'

  // sleeve (top-right cuff)
  ctx.save()
  ctx.translate(205, 40)
  ctx.rotate(0.5)
  ctx.fillStyle = sleeve
  roundRect(ctx, -40, -70, 130, 110, 18)
  ctx.fill()
  ctx.fillStyle = sleeveDark
  roundRect(ctx, -40, 8, 130, 32, 12)
  ctx.fill()
  ctx.restore()

  // marker pen (diagonal, tip at ~ (160, 294))
  ctx.save()
  ctx.translate(160, 200)
  ctx.rotate(-0.62)
  // body
  ctx.fillStyle = '#1f2937'
  roundRect(ctx, -16, -120, 32, 150, 10)
  ctx.fill()
  ctx.fillStyle = '#6366f1'
  roundRect(ctx, -16, -120, 32, 52, 10)
  ctx.fill()
  ctx.fillStyle = '#e5e7eb'
  ctx.fillRect(-16, -72, 32, 8)
  // tip cone
  ctx.fillStyle = '#9ca3af'
  ctx.beginPath()
  ctx.moveTo(-16, 30); ctx.lineTo(16, 30); ctx.lineTo(0, 62); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#111827'
  ctx.beginPath()
  ctx.moveTo(-5, 48); ctx.lineTo(5, 48); ctx.lineTo(0, 62); ctx.closePath(); ctx.fill()
  ctx.restore()

  // hand: fist gripping pen
  ctx.fillStyle = skin
  ctx.strokeStyle = skinShade
  ctx.lineWidth = 4
  // palm/back
  ctx.beginPath()
  ctx.moveTo(96, 120)
  ctx.bezierCurveTo(90, 80, 130, 55, 175, 60)
  ctx.bezierCurveTo(225, 66, 250, 100, 246, 150)
  ctx.bezierCurveTo(243, 190, 220, 205, 190, 208)
  ctx.bezierCurveTo(150, 212, 100, 180, 96, 120)
  ctx.closePath()
  ctx.fill(); ctx.stroke()
  // knuckle ridges (4 fingers wrapping)
  for (let i = 0; i < 4; i++) {
    const y = 108 + i * 26
    ctx.beginPath()
    ctx.moveTo(118, y)
    ctx.bezierCurveTo(160, y - 8, 205, y - 4, 228, y + 10)
    ctx.stroke()
  }
  // thumb over
  ctx.beginPath()
  ctx.moveTo(120, 190)
  ctx.bezierCurveTo(140, 215, 175, 225, 205, 215)
  ctx.bezierCurveTo(215, 205, 210, 190, 195, 188)
  ctx.bezierCurveTo(165, 184, 135, 180, 120, 190)
  ctx.closePath()
  ctx.fill(); ctx.stroke()
  // thumb nail
  ctx.fillStyle = '#fbe3c8'
  ctx.beginPath()
  ctx.ellipse(196, 201, 12, 8, 0.3, 0, Math.PI * 2)
  ctx.fill()

  return c
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = rej
    img.src = url
  })
}

export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = rej
    img.src = url
  })
}
