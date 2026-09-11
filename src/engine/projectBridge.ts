/**
 * projectBridge — in-memory live link between the Whiteboard / Showcase tabs
 * and the Video Editor tab.
 *
 * Clips added to the editor are NOT baked video files: they keep live
 * references to strokes / settings / images, so they stay editable both
 * from their source tab (live link) and inside the editor inspector.
 */
import type { Placement, RenderSettings, RevealSource, Stroke } from './types'
import type { LineupOptions, ShowItem, SketchEntry, SketchIntroOptions, TileStyle } from './showcase'

export interface WhiteboardSnapshot {
  strokes: Stroke[]
  settings: RenderSettings
  reveal: RevealSource | null
  fileName: string
  updatedAt: number
}

export interface ShowcaseSnapshot {
  items: ShowItem[]
  hold: number
  trans: number
  lineup: LineupOptions
  tileStyle: TileStyle
  bg: string | CanvasImageSource
  sketchOptions: SketchIntroOptions
  sketchEntries: Map<number, SketchEntry>
  updatedAt: number
}

export type EditorRequestKind = 'whiteboard' | 'showcase'

let wb: WhiteboardSnapshot | null = null
let sc: ShowcaseSnapshot | null = null

export function setWhiteboardSnapshot(s: Omit<WhiteboardSnapshot, 'updatedAt'>) {
  wb = { ...s, updatedAt: Date.now() }
}

export function getWhiteboardSnapshot(): WhiteboardSnapshot | null {
  return wb
}

export function setShowcaseSnapshot(s: Omit<ShowcaseSnapshot, 'updatedAt'>) {
  sc = { ...s, updatedAt: Date.now() }
}

export function getShowcaseSnapshot(): ShowcaseSnapshot | null {
  return sc
}

/** Ask the (possibly hidden) editor to append a live scene clip. */
export function requestAddSceneToEditor(kind: EditorRequestKind) {
  window.dispatchEvent(new CustomEvent<EditorRequestKind>('handscribe:add-scene', { detail: kind }))
}

export function onAddSceneRequest(cb: (kind: EditorRequestKind) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<EditorRequestKind>).detail)
  window.addEventListener('handscribe:add-scene', h)
  return () => window.removeEventListener('handscribe:add-scene', h)
}

/** Deep-copy strokes so timeline trims never mutate the source tab. */
export function cloneStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.map(s => ({ ...s, points: s.points.map(p => ({ ...p })) }))
}

export function describePlacement(r: Placement | null | undefined): Placement | null {
  if (!r) return null
  return { ...r }
}
