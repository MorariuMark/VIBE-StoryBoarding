import { FileSystemWritableFileStreamTarget, Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { CANVAS_H, CANVAS_W, type RenderSettings, type RevealSource, type Stroke } from './types'
import { buildTimeline, renderFrame, resolveDurationFor, revealDurationFor } from './renderer'
import { BrushEngine } from './brush'

export interface ExportProgress { frame: number; total: number; phase: 'encoding' | 'muxing' | 'done' }

/** User-picked save destination (File System Access). Null = Blob download. */
export interface ExportDestination {
  stream: FileSystemWritableFileStream
  fileName: string
}

/**
 * Ask the user where to save (native save dialog). Returns null when
 * dismissed or unsupported — callers fall back to an in-memory Blob.
 * Streaming straight to disk also fixes long-export OOM: a 10-minute
 * 14 Mbps video needs ~1.1 GB of contiguous ArrayBuffer, which is what
 * just died with "Array buffer allocation failed".
 */
export async function pickVideoSaveFile(suggestedName: string): Promise<ExportDestination | null> {
  try {
    const w = window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string
        types?: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream>; name: string }>
    }
    if (typeof w.showSaveFilePicker !== 'function') return null
    const handle = await w.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    })
    return { stream: await handle.createWritable(), fileName: handle.name }
  } catch {
    return null // dismissed or blocked — Blob fallback
  }
}

interface MuxerSetup {
  muxer: Muxer<ArrayBufferTarget | FileSystemWritableFileStreamTarget>
  /** fragmented file streaming keeps RAM flat on long exports */
  finalize: () => Promise<Blob | null>
  /** unfinished renders leave no residue: truncate + close the file */
  discard: () => Promise<void>
}

export function createExportMuxer(
  dest: ExportDestination | null,
  audio?: { sampleRate: number; numberOfChannels: number },
): MuxerSetup {
  const audioOpt = audio ? { audio: { codec: 'aac' as const, sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels } } : {}
  if (dest) {
    const muxer = new Muxer({
      target: new FileSystemWritableFileStreamTarget(dest.stream),
      video: { codec: 'avc', width: CANVAS_W, height: CANVAS_H },
      ...audioOpt,
      fastStart: 'fragmented',
      firstTimestampBehavior: 'offset',
    })
    return {
      muxer,
      finalize: async () => {
        muxer.finalize()
        try { await dest.stream.close() } catch { /* noop */ }
        return null
      },
      discard: async () => {
        try { await dest.stream.truncate(0) } catch { /* noop */ }
        try { await dest.stream.close() } catch { /* noop */ }
      },
    }
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: CANVAS_W, height: CANVAS_H },
    ...audioOpt,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  return {
    muxer,
    finalize: async () => {
      muxer.finalize()
      return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' })
    },
    discard: async () => { /* nothing on disk */ },
  }
}

/** H.264 High L4.2 — full 1080p60 headroom, lighter than L5.2 on weak iGPUs. */
export const EXPORT_CODEC = 'avc1.640028'

/** Opaque export canvas: no alpha compositing, lower-latency presentation. */
export function makeExportCanvas(): { off: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const off = document.createElement('canvas')
  off.width = CANVAS_W
  off.height = CANVAS_H
  const ctx = off.getContext('2d', { alpha: false, desynchronized: true })!
  // opaque canvas starts transparent-black; prime it so frame 0 is never blank
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
  return { off, ctx }
}

/** Encoder tuned for GPU: explicit hardware preference, capped level. */
export function configureHwEncoder(encoder: VideoEncoder, fps: number, bitrate = 8_000_000): void {
  encoder.configure({
    codec: EXPORT_CODEC,
    width: CANVAS_W,
    height: CANVAS_H,
    bitrate,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
  })
}

/**
 * Light backpressure: pause the pump while the HW queue is full, WITHOUT
 * flushing. flush() drains the whole pipeline and stalls the GPU — the old
 * every-20-frames flush is what made exports crawl. One flush at the end.
 */
export async function encoderBackpressure(encoder: VideoEncoder, maxQueue = 6): Promise<void> {
  let spins = 0
  while (encoder.encodeQueueSize > maxQueue && spins++ < 6000) {
    await yieldToUI()
  }
}

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
  dest: ExportDestination | null = null,
  bitrate = 8_000_000,
): Promise<Blob | null> {
  if (!('VideoEncoder' in window)) {
    throw new Error('WebCodecs VideoEncoder not available in this browser. Use Chrome or Edge 94+.')
  }
  const totalFrames = Math.max(1, Math.round(duration * fps))

  const { off, ctx } = makeExportCanvas()

  const { muxer, finalize, discard } = createExportMuxer(dest)
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('encoder error', e),
  })
  configureHwEncoder(encoder, fps, bitrate)

  try { await document.fonts.ready } catch { /* noop */ }

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
    // Backpressure without flushing: never let the encode queue grow
    // unbounded (long exports eat all RAM), but never stall the GPU either.
    if (encoder.encodeQueueSize > 6) await encoderBackpressure(encoder)
    if ((exportFrames as unknown as { __abort?: boolean }).__abort) {
      (exportFrames as unknown as { __abort?: boolean }).__abort = false;
      try { await encoder.flush(); muxer.finalize() } catch { /* noop */ }
      await discard()
      try { encoder.close() } catch { /* noop */ }
      throw new Error('Export cancelled')
    }
  }
  onProgress?.({ frame: totalFrames, total: totalFrames, phase: 'muxing' })
  await drainEncoder(encoder, 180000, 'finalizing')
  encoder.close()
  const out = await finalize()
  onProgress?.({ frame: totalFrames, total: totalFrames, phase: 'done' })
  return out
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
  dest: ExportDestination | null = null,
  bitrate = 8_000_000,
): Promise<Blob | null> {
  const tl = buildTimeline(strokes, settings.duration, 0.12, revealDurationFor(settings, reveal), resolveDurationFor(settings, reveal))
  return exportFrames(settings.duration, fps, (ctx, t) => {
    renderFrame(ctx, strokes, tl, t, settings, handImg, reveal, engine)
  }, onProgress, dest, bitrate)
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
