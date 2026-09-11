/**
 * editorRender — frame compositor for the multi-track editor + MP4 export.
 *
 * Every visual clip renders into a 1920x1080 offscreen layer, then gets
 * composited bottom-to-top with transform (scale/offset), opacity and
 * fade in/out. Whiteboard & showcase clips re-use the real studio renderers,
 * so editor clips stay fully editable — not baked video.
 */
import { CANVAS_H, CANVAS_W } from './types'
import { BrushEngine } from './brush'
import { buildTimeline, renderFrame, resolveDurationFor, revealDurationFor } from './renderer'
import { buildShowTimeline, renderShowcaseFrame } from './showcase'
import { createDefaultHand } from './hand'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { findCutBefore } from './editorTypes'
import type { ClipMotion, ClipTransition, EditorClip, EditorProject, TextClipData, TransitionType } from './editorTypes'

export interface MediaCache {
  videos: Map<string, HTMLVideoElement>
  images: Map<string, HTMLImageElement>
  audios: Map<string, HTMLAudioElement>
}

export function createMediaCache(): MediaCache {
  return { videos: new Map(), images: new Map(), audios: new Map() }
}

let defaultHand: HTMLCanvasElement | null = null
function getHand(): HTMLCanvasElement {
  if (!defaultHand) defaultHand = createDefaultHand(320)
  return defaultHand
}

const brushCache = new Map<number, BrushEngine>()
function brushFor(clipId: number): BrushEngine {
  let b = brushCache.get(clipId)
  if (!b) {
    b = new BrushEngine()
    brushCache.set(clipId, b)
  }
  return b
}

const layerCache = new Map<string, HTMLCanvasElement>()
function layerFor(key: string | number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const k = String(key)
  let c = layerCache.get(k)
  if (!c) {
    c = document.createElement('canvas')
    c.width = CANVAS_W
    c.height = CANVAS_H
    layerCache.set(k, c)
  }
  return { canvas: c, ctx: c.getContext('2d')! }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** Fade multiplier 0..1 for a clip at local time `local`. */
export function fadeGain(clip: EditorClip, local: number): number {
  let g = 1
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= clamp01(local / clip.fadeIn)
  const remain = clip.duration - local
  if (clip.fadeOut > 0 && remain < clip.fadeOut) g *= clamp01(remain / clip.fadeOut)
  return g
}

function drawCoverContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  fit: 'contain' | 'cover' | 'stretch',
) {
  if (fit === 'stretch') {
    ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H)
    return
  }
  const k = fit === 'cover' ? Math.max(CANVAS_W / iw, CANVAS_H / ih) : Math.min(CANVAS_W / iw, CANVAS_H / ih)
  const dw = iw * k
  const dh = ih * k
  ctx.drawImage(img, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh)
}

/** Greedy word-wrap shared by the text renderer, the measure helper and the transform box. */
export function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const rawParas = text.split('\n')
  const lines: string[] = []
  for (const para of rawParas) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) { lines.push(''); continue }
    let line = ''
    for (const w of words) {
      const trial = line ? line + ' ' + w : w
      if (ctx.measureText(trial).width > maxW && line) {
        lines.push(line)
        line = w
      } else {
        line = trial
      }
    }
    lines.push(line)
  }
  if (!lines.length) lines.push('')
  return lines
}

export function textFontOf(d: TextClipData): string {
  const weight = d.preset === 'title' ? '800' : d.preset === 'lower' ? '600' : '500'
  return `${weight} ${d.fontSize}px ${d.fontFamily}`
}

const measureCtx: CanvasRenderingContext2D | null =
  typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null

/** Pixel size of the text block (content + padding), mirroring renderTextLayer. */
export function measureTextBlock(d: TextClipData): { w: number; h: number } {
  if (!measureCtx) return { w: 600, h: 200 }
  measureCtx.font = textFontOf(d)
  const lines = wrapTextLines(measureCtx, d.text, CANVAS_W * 0.84)
  const widths = lines.map(l => measureCtx!.measureText(l).width)
  return {
    w: Math.max(...widths, 10) + 72,
    h: lines.length * d.fontSize * 1.25 + 48,
  }
}

/** Vertical center of the text block (its scale/rotate pivot). */
export function textPivotY(d: TextClipData): number {
  if (typeof d.posY === 'number') return CANVAS_H * Math.min(0.95, Math.max(0.05, d.posY))
  return d.preset === 'lower' ? CANVAS_H * 0.78 : d.preset === 'caption' ? CANVAS_H * 0.88 : CANVAS_H / 2
}

/**
 * Content pivot: the point scale/rotation anchor to so position never shifts.
 * Fullscreen sources pivot at screen center (unchanged behavior); text pivots
 * at its block center; a presenting avatar pivots at its corner anchor.
 */
export function contentPivot(clip: EditorClip): { x: number; y: number } {
  const p = clip.payload
  if (p.kind === 'text') return { x: CANVAS_W / 2, y: textPivotY(p.data) }
  if (p.kind === 'avatar' && p.data.mode === 'present') {
    const c = p.data.corner === 'random' ? 'BR' : p.data.corner
    const a = AVATAR_CORNERS[c]
    return { x: a.x + (p.data.offX ?? 0), y: a.y + (p.data.offY ?? 0) }
  }
  return { x: CANVAS_W / 2, y: CANVAS_H / 2 }
}

/** Clip position: percent (-100..100) of half-screen, per axis. */
export function positionPx(clip: EditorClip): { x: number; y: number } {
  return { x: (clip.x / 100) * (CANVAS_W / 2), y: (clip.y / 100) * (CANVAS_H / 2) }
}

export function renderTextLayer(ctx: CanvasRenderingContext2D, clip: EditorClip, local: number) {
  if (clip.payload.kind !== 'text') return
  const d = clip.payload.data
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  const anim = d.anim ?? 'none'
  const dur = Math.max(0.01, clip.duration)
  const frac = Math.min(1, Math.max(0, local / dur))

  // word-wrap to at most ~84% of screen width (shared with measure/box)
  ctx.font = textFontOf(d)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lines = wrapTextLines(ctx, d.text, CANVAS_W * 0.84)

  const lh = d.fontSize * 1.25
  const totalH = lines.length * lh
  // anchor: posY override wins, else preset default (same as textPivotY)
  const baseY = textPivotY(d)
  const widths = lines.map(l => ctx.measureText(l).width)
  const boxW = Math.max(...widths, 10) + 72
  const boxH = totalH + 48

  // entrance animation
  let alpha = 1
  let scale = 1
  if (anim === 'fade') {
    alpha = Math.min(1, frac / 0.18, (1 - frac) / 0.18 + 0.12)
    alpha = Math.min(1, Math.max(0, alpha))
  } else if (anim === 'pop') {
    const p = Math.min(1, frac / 0.22)
    // overshoot ease-out-back
    const c = 1.9
    const u = p - 1
    scale = 0.7 + 0.3 * (1 + (c + 1) * u * u * u + c * u * u)
  }

  ctx.save()
  if (anim === 'pop') {
    ctx.translate(CANVAS_W / 2, baseY)
    ctx.scale(scale, scale)
    ctx.translate(-CANVAS_W / 2, -baseY)
  }
  ctx.globalAlpha = alpha
  if (d.bg !== 'transparent') {
    ctx.save()
    ctx.globalAlpha = 0.92 * alpha
    ctx.fillStyle = d.bg
    roundRect(ctx, CANVAS_W / 2 - boxW / 2, baseY - boxH / 2, boxW, boxH, 26)
    ctx.fill()
    ctx.restore()
  }
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 18
  if (anim === 'karaoke') {
    // word-by-word highlight, timing weighted by word length
    const words = (d.words && d.words.length ? d.words : d.text.split(/\s+/).filter(Boolean))
    const weights = words.map(w => Math.max(1, w.length))
    const totalW = weights.reduce((a, b) => a + b, 0) || 1
    let spokenChars = frac * totalW
    let wi = 0
    const hi = d.hiColor ?? '#fde047'
    lines.forEach((line, li) => {
      const y = baseY - totalH / 2 + lh * (li + 0.5)
      const lineWords = line.split(/\s+/).filter(Boolean)
      const lineW = ctx.measureText(line).width
      let x = CANVAS_W / 2 - lineW / 2
      const prevAlign = ctx.textAlign
      ctx.textAlign = 'left'
      lineWords.forEach((w, k) => {
        const isSpoken = weights[wi] <= spokenChars
        spokenChars -= weights[wi]
        wi++
        ctx.fillStyle = isSpoken ? hi : d.color
        ctx.fillText(w, x, y)
        x += ctx.measureText(w + ' ').width
        void k
      })
      ctx.textAlign = prevAlign
    })
  } else {
    ctx.fillStyle = d.color
    lines.forEach((l, i) => {
      ctx.fillText(l, CANVAS_W / 2, baseY - totalH / 2 + lh * (i + 0.5))
    })
  }
  ctx.restore()
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

function renderWhiteboardLayer(ctx: CanvasRenderingContext2D, clip: EditorClip) {
  if (clip.payload.kind !== 'whiteboard') return
  const d = clip.payload.data
  const s = d.settings
  const reveal = d.revealImg ? { img: d.revealImg, rect: d.revealRect ?? { dx: 0, dy: 0, dw: CANVAS_W, dh: CANVAS_H }, photo: d.photoImg } : null
  const tl = buildTimeline(d.strokes, s.duration, 0.12, revealDurationFor(s, reveal), resolveDurationFor(s, reveal))
  renderFrame(ctx, d.strokes, tl, Math.min(Math.max(0, currentLocal), s.duration), { ...s }, s.showHand ? getHand() : null, reveal, brushFor(clip.id))
}

let currentLocal = 0

function renderShowcaseLayer(ctx: CanvasRenderingContext2D, clip: EditorClip, local: number) {
  if (clip.payload.kind !== 'showcase') return
  const d = clip.payload.data
  const sketchDur = d.sketchOptions.enabled ? d.sketchOptions.duration : 0
  const tl = buildShowTimeline(d.items, d.hold, d.trans, 1.2, d.lineup, sketchDur)
  renderShowcaseFrame(
    ctx, d.items, tl, Math.min(Math.max(0, local), tl.total),
    d.bg, d.lineup.connect ? d.lineup.connectColor : null, d.tileStyle,
    d.sketchOptions.enabled
      ? { options: d.sketchOptions, entries: d.sketchEntries, hand: getHand() }
      : null,
  )
}

// ---------------------------------------------------------------------------
// Host avatar: presenter or random pop-ups, fully deterministic per clip id
// (seeded RNG) so preview and export render identically.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AVATAR_CORNERS = {
  BL: { x: 300, y: 830 },
  BR: { x: 1620, y: 830 },
  TL: { x: 300, y: 250 },
  TR: { x: 1620, y: 250 },
} as const

function drawAvatarPose(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  h: number,
  alpha: number,
  rot = 0,
  flip = false,
  shadow = true,
) {
  if (alpha <= 0.001 || h <= 1) return
  const w = h * (img.naturalWidth / Math.max(1, img.naturalHeight))
  ctx.save()
  ctx.globalAlpha = Math.min(1, alpha)
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = 28
  }
  ctx.translate(cx, cy)
  if (rot) ctx.rotate((rot * Math.PI) / 180)
  if (flip) ctx.scale(-1, 1)
  ctx.drawImage(img, -w / 2, -h / 2, w, h)
  ctx.restore()
}

function renderAvatarLayer(
  ctx: CanvasRenderingContext2D,
  clip: EditorClip,
  local: number,
  cache: MediaCache,
) {
  if (clip.payload.kind !== 'avatar') return
  const d = clip.payload.data
  const imgs = d.poseUrls
    .map(u => cache.images.get(u))
    .filter((im): im is HTMLImageElement => !!im && im.complete && im.naturalWidth > 0)
  if (!imgs.length) return
  const H = 340 * Math.max(0.2, d.avatarScale || 1)
  const wander = Math.min(1, Math.max(0, d.wander ?? 0.6))
  const sp = Math.min(3, Math.max(0.1, d.animSpeed ?? 1)) // global motion speed
  const rot = d.rot ?? 0
  const flip = d.flip ?? false
  const shadow = d.shadow ?? true
  const ox = d.offX ?? 0
  const oy = d.offY ?? 0
  const t = Math.max(0, local)

  if (d.mode === 'present') {
    // on screen the whole clip: cycle poses, bob and drift gently.
    // Wander 0% or speed 0 freezes the avatar completely — no motion at all.
    const frozen = sp < 0.01 || wander <= 0
    const idx = d.poseInterval > 0 ? Math.floor(t / d.poseInterval) % imgs.length : 0
    const anchor = AVATAR_CORNERS[d.corner === 'random' ? 'BR' : d.corner]
    const dx = ox + (frozen ? 0 : Math.sin(t * 0.7 * sp) * 60 * wander)
    const dy = oy + (frozen ? 0 : (Math.cos(t * 0.9 * sp) * 30 + Math.sin(t * Math.PI * sp) * 10) * wander)
    drawAvatarPose(ctx, imgs[idx % imgs.length], anchor.x + dx, anchor.y + dy, H, 1, rot, flip, shadow)
    return
  }

  // popup mode: N deterministic appearances — pose, corner, timing and
  // in/out style all derive from a seeded RNG, so every render agrees.
  // The RNG sequence per slot is fixed (style is always consumed), so
  // changing the style/corner never reshuffles timing or poses.
  const rng = mulberry32((Math.imul(clip.id, 2654435761)) >>> 0)
  const n = Math.max(1, Math.min(12, Math.round(d.popCount || 4)))
  const D = Math.max(0.5, clip.duration)
  const f = Math.min(1, Math.max(0.05, d.fadeDur))
  const holdMul = Math.min(2, Math.max(0.5, d.holdMul ?? 1))
  const fixedStyle = d.popStyle && d.popStyle !== 'mixed' ? d.popStyle : null
  const corners = ['BL', 'BR', 'TL', 'TR'] as const
  const styles = ['pop', 'fade', 'slide'] as const
  for (let k = 0; k < n; k++) {
    const slot = D / n
    const t0 = (k + 0.12 + 0.68 * rng()) * slot
    const hold = Math.min((1.1 + rng() * 2.2) * holdMul, Math.max(0.4, D - t0 - 0.25))
    const poseIdx = Math.floor(rng() * imgs.length) % imgs.length
    const corner = d.corner === 'random' ? corners[Math.floor(rng() * corners.length)] : d.corner
    const style = fixedStyle ?? styles[Math.floor(rng() * styles.length)]
    if (t < t0 || t > t0 + hold) continue
    const lt = t - t0
    const rt = t0 + hold - t
    const aIn = clamp01(lt / f)
    const aOut = clamp01(rt / f)
    const anchor = AVATAR_CORNERS[corner]
    let alpha = Math.min(aIn, aOut)
    let scale = 1
    let dy = oy + Math.sin((t - t0) * 3 * sp) * 12 * wander
    if (style === 'pop') {
      const p = easeOutBack(clamp01(lt / Math.max(0.05, f * 1.5)))
      scale = 0.3 + 0.7 * Math.max(0.01, p)
      alpha = Math.min(1, aIn * 2) * aOut
    } else if (style === 'slide') {
      dy += (1 - easeOutCubic(aIn)) * 130 + (1 - aOut) * 60
      alpha = Math.min(1, aIn * 1.5) * aOut
    }
    drawAvatarPose(ctx, imgs[poseIdx], anchor.x + ox, anchor.y + dy, H * scale, alpha, rot, flip, shadow)
  }
}

/**
 * Paint one visual clip's source frame into a 1920×1080 layer (no transform).
 * Video elements are owned per clip (`v<id>`); the preview/export loops keep
 * them seeked — this just draws the current frame.
 */
export function paintVisualClipLayer(
  lctx: CanvasRenderingContext2D,
  clip: EditorClip,
  local: number,
  cache: MediaCache,
) {
  lctx.save()
  lctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  try {
    const p = clip.payload
    if (p.kind === 'whiteboard') {
      currentLocal = local
      renderWhiteboardLayer(lctx, clip)
    } else if (p.kind === 'showcase') {
      renderShowcaseLayer(lctx, clip, local)
    } else if (p.kind === 'image') {
      const img = cache.images.get(p.data.url)
      lctx.fillStyle = '#000'
      lctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      if (img && img.complete && img.naturalWidth > 0) {
        let zoom = 1
        if (p.data.kenBurns && clip.duration > 0) zoom = 1 + 0.12 * clamp01(local / clip.duration)
        lctx.save()
        lctx.translate(CANVAS_W / 2, CANVAS_H / 2)
        lctx.scale(zoom, zoom)
        lctx.translate(-CANVAS_W / 2, -CANVAS_H / 2)
        drawCoverContain(lctx, img, img.naturalWidth, img.naturalHeight, p.data.fit)
        lctx.restore()
      }
    } else if (p.kind === 'video') {
      const v = cache.videos.get(`v${clip.id}`)
      lctx.fillStyle = '#000'
      lctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        drawCoverContain(lctx, v, v.videoWidth, v.videoHeight, p.data.fit)
      }
    } else if (p.kind === 'text') {
      renderTextLayer(lctx, clip, local)
    } else if (p.kind === 'avatar') {
      renderAvatarLayer(lctx, clip, local, cache)
    }
  } catch (err) {
    console.warn('editor clip render failed', clip.name, err)
  }
  lctx.restore()
}

// ---------------------------------------------------------------------------
// Entrance / exit motion
// ---------------------------------------------------------------------------

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3)
}

function easeOutBack(p: number): number {
  const c = 1.70158
  const u = p - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

export interface MotionState { dx: number; dy: number; scale: number; alpha: number }
const NO_MOTION: MotionState = { dx: 0, dy: 0, scale: 1, alpha: 1 }

/** Entrance/exit transform for a clip at timeline-local time `localT`. */
export function motionAt(clip: EditorClip, localT: number): MotionState {
  if (clip.kind === 'audio') return NO_MOTION
  const D = Math.max(0.01, clip.duration)
  let dx = 0
  let dy = 0
  let scale = 1
  let alpha = 1
  // entrance
  const inD = Math.max(0, clip.animInDur)
  if (clip.animIn !== 'none' && inD > 0 && localT < inD) {
    const p = easeOutCubic(clamp01(localT / inD))
    const k = 1 - p
    switch (clip.animIn as ClipMotion) {
      case 'fromL': dx = -CANVAS_W * k; break
      case 'fromR': dx = CANVAS_W * k; break
      case 'fromT': dy = -CANVAS_H * k; break
      case 'fromB': dy = CANVAS_H * k; break
      case 'zoomIn': scale = 0.6 + 0.4 * p; alpha = Math.min(1, p * 1.6); break
      case 'zoomOut': scale = 1.3 - 0.3 * p; alpha = Math.min(1, p * 1.6); break
      case 'pop': {
        const b = easeOutBack(clamp01(localT / inD))
        scale = 0.5 + 0.5 * Math.max(0, b)
        alpha = Math.min(1, (localT / inD) * 2.2)
        break
      }
      default: break
    }
  }
  // exit
  const outD = Math.max(0, clip.animOutDur)
  if (clip.animOut !== 'none' && outD > 0 && D - localT < outD) {
    const q = easeOutCubic(clamp01((D - localT) / outD)) // 1 -> 0 as the clip ends
    const k = 1 - q
    switch (clip.animOut as ClipMotion) {
      case 'fromL': dx = -CANVAS_W * k; break
      case 'fromR': dx = CANVAS_W * k; break
      case 'fromT': dy = -CANVAS_H * k; break
      case 'fromB': dy = CANVAS_H * k; break
      case 'zoomIn': scale = 1 + 0.35 * k; alpha = Math.min(alpha, q); break
      case 'zoomOut': scale = 0.65 + 0.35 * q; alpha = Math.min(alpha, q); break
      case 'pop': scale = 0.5 + 0.5 * q; alpha = Math.min(alpha, q * q); break
      default: break
    }
  }
  return { dx, dy, scale, alpha }
}

/** Blit a painted layer with the clip's static transform (no fades/motion). */
function blitLayer(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  clip: EditorClip,
  alphaMul = 1,
  extraDx = 0,
  extraDy = 0,
  extraScale = 1,
) {
  const alpha = clamp01(clip.opacity) * alphaMul
  if (alpha <= 0.001) return
  const P = contentPivot(clip)
  const pos = positionPx(clip)
  const rot = ((clip.rotation ?? 0) * Math.PI) / 180
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(P.x + pos.x + extraDx, P.y + pos.y + extraDy)
  if (rot) ctx.rotate(rot)
  ctx.scale(clip.scale * extraScale, clip.scale * extraScale)
  ctx.translate(-P.x, -P.y)
  ctx.drawImage(canvas, 0, 0)
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface ActiveTransition { tr: ClipTransition; a: EditorClip; b: EditorClip }

/** Transitions live at time `t`, with A/B clips resolved. */
export function activeTransitionsAt(project: EditorProject, time: number): ActiveTransition[] {
  const out: ActiveTransition[] = []
  for (const tr of project.transitions) {
    const b = project.clips.find(c => c.id === tr.clipId)
    if (!b || b.kind === 'audio') continue
    const track = project.tracks.find(t => t.id === tr.trackId)
    if (!track || track.kind !== 'video' || track.hidden) continue
    const d = Math.min(Math.max(0.1, tr.duration), Math.max(0.1, b.duration))
    if (time < b.start || time >= b.start + d) continue
    const a = findCutBefore(project, b)
    if (!a) continue
    out.push({ tr: { ...tr, duration: d }, a, b })
  }
  return out
}

/** Frozen source time for the outgoing (A) side of a transition. */
export function frozenLocal(a: EditorClip): number {
  return a.offset + a.duration
}

function drawTransition(
  ctx: CanvasRenderingContext2D,
  at: ActiveTransition,
  time: number,
  cache: MediaCache,
) {
  const { a, b, tr } = at
  const d = tr.duration
  const p = clamp01((time - b.start) / d)
  const { ctx: actx } = layerFor(`tra${tr.id}`)
  const { ctx: bctx } = layerFor(`trb${tr.id}`)
  paintVisualClipLayer(actx, a, frozenLocal(a), cache)
  paintVisualClipLayer(bctx, b, (time - b.start) + b.offset, cache)
  const layerA = layerFor(`tra${tr.id}`).canvas
  const layerB = layerFor(`trb${tr.id}`).canvas
  const type = tr.type as TransitionType
  switch (type) {
    case 'dissolve':
      blitLayer(ctx, layerA, a)
      blitLayer(ctx, layerB, b, p)
      break
    case 'fade-black':
    case 'dip-white': {
      const col = type === 'fade-black' ? '#000000' : '#ffffff'
      if (p < 0.5) {
        blitLayer(ctx, layerA, a, 1 - p * 2)
        ctx.save()
        ctx.globalAlpha = p * 2
        ctx.fillStyle = col
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
        ctx.restore()
      } else {
        ctx.save()
        ctx.globalAlpha = (1 - p) * 2
        ctx.fillStyle = col
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
        ctx.restore()
        blitLayer(ctx, layerB, b, (p - 0.5) * 2)
      }
      break
    }
    case 'wipeL':
    case 'wipeR':
    case 'wipeU':
    case 'wipeD': {
      blitLayer(ctx, layerA, a)
      ctx.save()
      ctx.beginPath()
      if (type === 'wipeL') ctx.rect(0, 0, CANVAS_W * p, CANVAS_H)
      else if (type === 'wipeR') ctx.rect(CANVAS_W * (1 - p), 0, CANVAS_W * p, CANVAS_H)
      else if (type === 'wipeU') ctx.rect(0, 0, CANVAS_W, CANVAS_H * p)
      else ctx.rect(0, CANVAS_H * (1 - p), CANVAS_W, CANVAS_H * p)
      ctx.clip()
      blitLayer(ctx, layerB, b)
      ctx.restore()
      break
    }
    case 'pushL':
      blitLayer(ctx, layerA, a, 1, -CANVAS_W * p, 0)
      blitLayer(ctx, layerB, b, 1, CANVAS_W * (1 - p), 0)
      break
    case 'pushR':
      blitLayer(ctx, layerA, a, 1, CANVAS_W * p, 0)
      blitLayer(ctx, layerB, b, 1, -CANVAS_W * (1 - p), 0)
      break
    case 'zoom':
      blitLayer(ctx, layerA, a, 1 - p)
      blitLayer(ctx, layerB, b, Math.min(1, p * 1.6), 0, 0, 1.25 - 0.25 * p)
      break
    default:
      blitLayer(ctx, layerA, a)
      blitLayer(ctx, layerB, b, p)
      break
  }
}

/**
 * Synchronous composite — used for realtime preview. Video clips draw the
 * video element's current frame (the preview loop keeps it in sync).
 */
export function renderEditorFrame(
  ctx: CanvasRenderingContext2D,
  project: EditorProject,
  time: number,
  cache: MediaCache,
) {
  ctx.save()
  ctx.fillStyle = project.bg || '#000000'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  const active = activeTransitionsAt(project, time)
  const hiddenIds = new Set<number>()
  for (const at of active) {
    hiddenIds.add(at.a.id)
    hiddenIds.add(at.b.id)
  }

  const tracks = project.tracks.filter(t => t.kind === 'video' && !t.hidden)
  // bottom track first: V1 is last in a Premiere-style list, so sort by index
  const ordered = [...tracks].sort((a, b) => {
    const ia = project.tracks.indexOf(a)
    const ib = project.tracks.indexOf(b)
    return ib - ia
  })

  for (const track of ordered) {
    const clips = project.clips
      .filter(c => c.trackId === track.id && c.kind !== 'audio')
      .sort((a, b) => a.start - b.start)
    for (const clip of clips) {
      if (hiddenIds.has(clip.id)) continue // drawn by its transition instead
      const localT = time - clip.start
      const local = localT + clip.offset
      if (time < clip.start || time >= clip.start + clip.duration) continue
      const { ctx: lctx } = layerFor(clip.id)
      paintVisualClipLayer(lctx, clip, local, cache)

      // composite with transform + opacity + fades + entrance/exit motion.
      // Scale/rotation pivot at the content center, so sizing never shifts position.
      const m = motionAt(clip, localT)
      const gain = fadeGain(clip, localT) * clamp01(clip.opacity) * m.alpha
      if (gain <= 0.001) continue
      const P = contentPivot(clip)
      const pos = positionPx(clip)
      const rot = ((clip.rotation ?? 0) * Math.PI) / 180
      ctx.save()
      ctx.globalAlpha = gain
      ctx.translate(P.x + pos.x + m.dx, P.y + pos.y + m.dy)
      if (rot) ctx.rotate(rot)
      ctx.scale(clip.scale * m.scale, clip.scale * m.scale)
      ctx.translate(-P.x, -P.y)
      ctx.drawImage(layerFor(clip.id).canvas, 0, 0)
      ctx.restore()
    }
    // transitions live in their incoming clip's track slot
    for (const at of active) {
      if (at.b.trackId === track.id) drawTransition(ctx, at, time, cache)
    }
  }
  ctx.restore()
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    const target = Math.min(Math.max(0, t), (v.duration || t) - 0.05)
    if (!isFinite(target) || Math.abs(v.currentTime - target) < 0.04) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      v.removeEventListener('seeked', finish)
      resolve()
    }
    v.addEventListener('seeked', finish)
    try {
      v.currentTime = Math.max(0, target)
    } catch {
      finish()
    }
    setTimeout(finish, 1500)
  })
}

/**
 * Frame-accurate MP4 export. Video-clip sources are awaited-seeked per frame
 * so the output matches the timeline even when the preview was approximate.
 * NOTE: audio is preview-only — the MP4 carries the video mix.
 */
export async function exportEditorProjectFrames(
  project: EditorProject,
  cache: MediaCache,
  fps: number,
  onProgress?: (frame: number, total: number) => void,
): Promise<Blob> {
  const off = document.createElement('canvas')
  off.width = CANVAS_W
  off.height = CANVAS_H
  const octx = off.getContext('2d')!

  // pre-seek all timeline videos to 0 and wait for readiness
  const vids = [...cache.videos.values()]
  for (const v of vids) {
    try { v.pause(); v.muted = true } catch { /* noop */ }
  }

  const total = Math.max(0.5, project.duration)
  const totalFrames = Math.max(1, Math.round(total * fps))
  const draw = async (t: number) => {
    // seek each active timeline video to its local time
    const jobs: Promise<void>[] = []
    for (const clip of project.clips) {
      if (clip.payload.kind !== 'video') continue
      if (t < clip.start || t >= clip.start + clip.duration) continue
      const v = cache.videos.get(`v${clip.id}`)
      if (v) jobs.push(seekVideo(v, t - clip.start + clip.offset))
    }
    // transition A-sides render frozen at their end frame — seek those too
    for (const at of activeTransitionsAt(project, t)) {
      if (at.a.payload.kind !== 'video') continue
      const v = cache.videos.get(`v${at.a.id}`)
      if (v) jobs.push(seekVideo(v, frozenLocal(at.a)))
    }
    if (jobs.length) await Promise.all(jobs)
    renderEditorFrame(octx, project, t, cache)
  }

  // Progressive encode pump (mirrors exportFrames) with an async draw step so
  // timeline video sources can be awaited-seeked to the exact frame time.
  if (!('VideoEncoder' in window)) {
    throw new Error('WebCodecs VideoEncoder not available. Use Chrome or Edge 94+.')
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: CANVAS_W, height: CANVAS_H },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('editor encoder error', e),
  })
  encoder.configure({ codec: 'avc1.640034', width: CANVAS_W, height: CANVAS_H, bitrate: 14_000_000, framerate: fps })
  const abortFlag = exportEditorProjectFrames as unknown as { __abort?: boolean }
  try {
    for (let f = 0; f < totalFrames; f++) {
      if (abortFlag.__abort) {
        abortFlag.__abort = false
        try { await encoder.flush(); muxer.finalize() } catch { /* noop */ }
        throw new Error('Export cancelled')
      }
      const t = Math.min(total, f / fps)
      await draw(t)
      const frame = new VideoFrame(off, { timestamp: Math.round((f / fps) * 1e6), duration: Math.round(1e6 / fps) })
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 })
      frame.close()
      if (f % 10 === 0) {
        onProgress?.(f, totalFrames)
        await new Promise(r => setTimeout(r, 0))
      }
      if (f % 20 === 19) {
        while (encoder.encodeQueueSize > 0) await new Promise(r => setTimeout(r, 0))
        await encoder.flush()
      }
    }
    onProgress?.(totalFrames, totalFrames)
    while (encoder.encodeQueueSize > 0) await new Promise(r => setTimeout(r, 0))
    await encoder.flush()
    encoder.close()
    muxer.finalize()
    return new Blob([muxer.target.buffer], { type: 'video/mp4' })
  } finally {
    try { encoder.close() } catch { /* noop */ }
  }
}

export function cancelEditorExport() {
  (exportEditorProjectFrames as unknown as { __abort?: boolean }).__abort = true
}

/** Decode audio peaks for waveform display (mono, ~200 buckets). */
export async function computePeaks(url: string, buckets = 220): Promise<number[]> {
  try {
    const res = await fetch(url)
    const buf = await res.arrayBuffer()
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ac = new AC()
    const audio = await ac.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const out: number[] = []
    const per = Math.max(1, Math.floor(ch.length / buckets))
    for (let i = 0; i < buckets; i++) {
      let peak = 0
      const start = i * per
      for (let j = start; j < Math.min(ch.length, start + per); j += 7) {
        const v = Math.abs(ch[j])
        if (v > peak) peak = v
      }
      out.push(Math.min(1, peak * 1.4))
    }
    void ac.close()
    return out
  } catch {
    // synthetic fallback so the UI still shows something
    return Array.from({ length: buckets }, (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 0.35)))
  }
}
