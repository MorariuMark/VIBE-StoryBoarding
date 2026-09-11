import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { CANVAS_H, CANVAS_W, type RenderSettings, type RevealSource, type Stroke } from './types'
import { buildTimeline, renderFrame, resolveDurationFor, revealDurationFor } from './renderer'
import { BrushEngine } from './brush'

export interface ExportProgress { frame: number; total: number; phase: 'encoding' | 'muxing' | 'done' }

function yieldToUI() {
  return new Promise<void>((r) => setTimeout(r, 0))
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(msg)), ms)
  })
  return Promise.race([
    p.finally(() => { if (timer !== undefined) clearTimeout(timer) }),
    timeout,
  ]) as Promise<T>
}

/**
 * Wait until the encoder has digested its queue (backpressure). Without this,
 * thousands of encode() calls pile up unbounded and the tab runs out of
 * memory and dies — typically right at the end of a long export.
 */
async function drainEncoder(encoder: VideoEncoder, deadlineMs: number, what: string) {
  const start = Date.now()
  while (encoder.encodeQueueSize > 0) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(
        `Video encoder stalled during ${what} (queue stuck at ${encoder.encodeQueueSize}). ` +
        `Your machine may be out of memory — try a shorter video or 30 fps export.`,
      )
    }
    await yieldToUI()
  }
  await withTimeout(
    encoder.flush(),
    60000,
    `Video encoder stalled during ${what} final flush. Try a shorter video or 30 fps export.`,
  )
}

/**
 * Generic frame-accurate offline renderer: draws every frame deterministically
 * at 1920x1080 60fps via WebCodecs VideoEncoder + mp4-muxer. No realtime capture.
 */
export async function exportFrames(
  duration: number,
  fps: number,
  draw: (ctx: CanvasRenderingContext2D, t: number) => void,
  onProgress?: (p: ExportProgress) => void,
): Promise<Blob> {
  if (!('VideoEncoder' in window)) {
    throw new Error('WebCodecs VideoEncoder not available in this browser. Use Chrome or Edge 94+.')
  }
  const totalFrames = Math.max(1, Math.round(duration * fps))

  const off = document.createElement('canvas')
  off.width = CANVAS_W
  off.height = CANVAS_H
  const ctx = off.getContext('2d')!

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: CANVAS_W, height: CANVAS_H },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('encoder error', e),
  })
  encoder.configure({
    codec: 'avc1.640034',
    width: CANVAS_W,
    height: CANVAS_H,
    bitrate: 14_000_000,
    framerate: fps,
  })

  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps
    draw(ctx, Math.min(t, duration))
    const frame = new VideoFrame(off, { timestamp: Math.round((f / fps) * 1e6), duration: Math.round(1e6 / fps) })
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 })
    frame.close()
    if (f % 10 === 0) {
      onProgress?.({ frame: f, total: totalFrames, phase: 'encoding' })
      await yieldToUI()
    }
    // Backpressure: never let the encode queue grow unbounded, or long
    // exports eat all RAM and the tab dies (usually right at 100%).
    if (f % 20 === 19) {
      await drainEncoder(encoder, 120000, 'encoding')
    }
    if ((exportFrames as unknown as { __abort?: boolean }).__abort) {
      (exportFrames as unknown as { __abort?: boolean }).__abort = false
      try { await encoder.flush(); muxer.finalize() } catch { /* noop */ }
      throw new Error('Export cancelled')
    }
  }
  onProgress?.({ frame: totalFrames, total: totalFrames, phase: 'muxing' })
  await drainEncoder(encoder, 180000, 'finalizing')
  encoder.close()
  muxer.finalize()
  const buffer = muxer.target.buffer
  onProgress?.({ frame: totalFrames, total: totalFrames, phase: 'done' })
  return new Blob([buffer], { type: 'video/mp4' })
}

/**
 * Frame-accurate whiteboard export (thin wrapper over exportFrames).
 */
export async function exportToMp4(
  strokes: Stroke[],
  settings: RenderSettings,
  handImg: CanvasImageSource | null,
  fps = 60,
  onProgress?: (p: ExportProgress) => void,
  reveal: RevealSource | null = null,
  engine: BrushEngine = new BrushEngine(),
): Promise<Blob> {
  const tl = buildTimeline(strokes, settings.duration, 0.12, revealDurationFor(settings, reveal), resolveDurationFor(settings, reveal))
  return exportFrames(settings.duration, fps, (ctx, t) => {
    renderFrame(ctx, strokes, tl, t, settings, handImg, reveal, engine)
  }, onProgress)
}

export function cancelExport() {
  (exportFrames as unknown as { __abort?: boolean }).__abort = true
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 4000)
}
