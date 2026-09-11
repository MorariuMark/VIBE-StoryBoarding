export interface Pt { x: number; y: number }

export interface Stroke {
  id: number
  points: Pt[]
  /** cumulative arc length in px (in 1920x1080 space) */
  length: number
  closed: boolean
}

export type FillMode = 'outlines' | 'scribble'

export type BrushType = 'marker' | 'pencil' | 'brush'

export interface RenderSettings {
  strokeColor: string
  lineWidth: number
  duration: number // seconds
  fillMode: FillMode
  anchorX: number // 0..1 within hand image, pen tip
  anchorY: number
  jitterAmp: number // px
  handScale: number
  showHand: boolean
  paperColor: string
  revealPhoto: boolean // after edges finish, fade the source photo in (sketch -> finished)
  revealDuration: number // seconds reserved at the end for the photo reveal
  resolvePhoto: boolean // painted finishes dissolve into the real photo at the very end
  drawSpeed: number // preview playback rate multiplier (export always uses full duration)
  colorAngle: number // direction (degrees, 90 = top-to-bottom) the color wipe paints the photo
  brushType: BrushType
  softness: number // 0..1 feathered dab edge (real media feel)
  grain: number // 0..1 paper-grain / bristle texture in the dabs
  taper: number // 0..1 pointed-tip pressure taper at stroke ends
}

/** Destination rect (canvas px) where the source image is placed, aspect-preserved. */
export interface Placement { dx: number; dy: number; dw: number; dh: number }

/** Source image to reveal in place after the sketch phase (photo or painted finish). */
export interface RevealSource {
  img: CanvasImageSource // finish bitmap (painted, pencil, or the photo itself)
  rect: Placement
  photo: CanvasImageSource | null // untouched original photo (for the resolve-to-photo ending)
}

export const CANVAS_W = 1920
export const CANVAS_H = 1080

export const DEFAULT_SETTINGS: RenderSettings = {
  strokeColor: '#111827',
  lineWidth: 7,
  duration: 8,
  fillMode: 'outlines',
  anchorX: 0.5,
  anchorY: 0.92,
  jitterAmp: 2.2,
  handScale: 1.0,
  showHand: true,
  paperColor: '#ffffff',
  revealPhoto: true,
  revealDuration: 2,
  resolvePhoto: false,
  drawSpeed: 1,
  colorAngle: 90,
  brushType: 'marker',
  softness: 0.05,
  grain: 0,
  taper: 0,
}
