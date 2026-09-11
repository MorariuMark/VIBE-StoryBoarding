/**
 * editorTypes — multi-track NLE project model.
 *
 * Tracks are typed (video / audio). Visual scene clips (whiteboard, showcase,
 * video, image, text) live on video tracks and composite bottom-to-top.
 * Audio clips live on audio tracks and mix during preview.
 */
import type { Placement, RenderSettings, Stroke } from './types'
import type { LineupOptions, ShowItem, SketchEntry, SketchIntroOptions, TileStyle } from './showcase'

export type EditorClipKind = 'whiteboard' | 'showcase' | 'video' | 'image' | 'audio' | 'text' | 'avatar'

export type AvatarMode = 'present' | 'popup'
export type AvatarCorner = 'random' | 'BL' | 'BR' | 'TL' | 'TR'
export type AvatarPopStyle = 'mixed' | 'pop' | 'fade' | 'slide'

/** One avatar pose/expression image in the project library. */
export interface AvatarPose {
  id: number
  url: string
  name: string
}

export interface AvatarClipData {
  /** ordered pose urls — cycle (present) or random-pick (popup) source */
  poseUrls: string[]
  /** present = on screen the whole clip; popup = random timed appearances */
  mode: AvatarMode
  /** popup mode: number of appearances across the clip */
  popCount: number
  /** popup mode: fixed entrance style, mixed = random per appearance */
  popStyle: AvatarPopStyle
  /** popup mode: hold-length multiplier (0.5..2) */
  holdMul: number
  /** present mode: seconds per pose, 0 = fixed first pose */
  poseInterval: number
  /** 0..1 drift/bob amplitude */
  wander: number
  /** global motion speed multiplier (0.25..2) — bob, drift, wobble */
  animSpeed: number
  /** base size multiplier (multiplies clip.scale) */
  avatarScale: number
  /** anchor corner(s) for popup appearances */
  corner: AvatarCorner
  /** fine offset from the anchor, px */
  offX: number
  offY: number
  /** rotation, degrees */
  rot: number
  /** mirror horizontally */
  flip: boolean
  /** soft drop shadow */
  shadow: boolean
  /** fade/pop length per appearance (seconds) */
  fadeDur: number
}

export interface WhiteboardClipData {
  strokes: Stroke[]
  settings: RenderSettings
  revealImg: CanvasImageSource | null
  photoImg: CanvasImageSource | null
  revealRect: Placement | null
  sourceName: string
}

export interface ShowcaseClipData {
  items: ShowItem[]
  hold: number
  trans: number
  lineup: LineupOptions
  tileStyle: TileStyle
  bg: string | CanvasImageSource
  sketchOptions: SketchIntroOptions
  sketchEntries: Map<number, SketchEntry>
  sourceName: string
}

export interface VideoClipData {
  url: string
  name: string
  naturalDuration: number
  videoWidth: number
  videoHeight: number
  fit: 'contain' | 'cover' | 'stretch'
}

export interface ImageClipData {
  url: string
  name: string
  fit: 'contain' | 'cover' | 'stretch'
  kenBurns: boolean
}

export interface AudioClipData {
  url: string
  name: string
  naturalDuration: number
  peaks: number[]
}

export type TextPreset = 'title' | 'lower' | 'caption'

export type CaptionAnim = 'none' | 'fade' | 'pop' | 'karaoke'

export interface TextClipData {
  text: string
  preset: TextPreset
  fontSize: number
  color: string
  bg: string
  fontFamily: string
  /** caption animation style (default 'none') */
  anim?: CaptionAnim
  /** vertical anchor 0..1 of screen height (overrides preset position) */
  posY?: number
  /** words for karaoke highlight (defaults to text split on whitespace) */
  words?: string[]
  /** highlight color for spoken karaoke words (default #fde047) */
  hiColor?: string
}

export type ClipPayload =
  | { kind: 'whiteboard'; data: WhiteboardClipData }
  | { kind: 'showcase'; data: ShowcaseClipData }
  | { kind: 'video'; data: VideoClipData }
  | { kind: 'image'; data: ImageClipData }
  | { kind: 'audio'; data: AudioClipData }
  | { kind: 'text'; data: TextClipData }
  | { kind: 'avatar'; data: AvatarClipData }

/** Entrance/exit motion presets (transform-based; opacity stays on fadeIn/fadeOut). */
export type ClipMotion = 'none' | 'fromL' | 'fromR' | 'fromT' | 'fromB' | 'zoomIn' | 'zoomOut' | 'pop'

/** Transition played over the first `duration` seconds of the incoming clip. */
export type TransitionType =
  | 'dissolve' | 'fade-black' | 'dip-white'
  | 'wipeL' | 'wipeR' | 'wipeU' | 'wipeD'
  | 'pushL' | 'pushR' | 'zoom'

export interface ClipTransition {
  id: number
  trackId: number
  /** incoming clip (B) — the transition covers [B.start, B.start + duration] */
  clipId: number
  type: TransitionType
  duration: number
}

export interface EditorClip {
  id: number
  trackId: number
  kind: EditorClipKind
  name: string
  /** global timeline position (seconds) */
  start: number
  /** timeline length (seconds) — trim/split/extend this, not the source */
  duration: number
  /** offset into the source (seconds) — left trim */
  offset: number
  volume: number // 0..1.5 (audio + video audio)
  opacity: number // 0..1 (visual)
  scale: number // 0.2..3 transform
  /** position, percent of half-screen (-100..100, 0 = centered) on each axis */
  x: number
  y: number
  /** rotation, degrees (clockwise) */
  rotation?: number
  fadeIn: number // seconds
  fadeOut: number
  muted: boolean
  /** clip-level lock: pinned in place (no move/trim) until unlocked */
  locked?: boolean
  animIn: ClipMotion
  animInDur: number // seconds
  animOut: ClipMotion
  animOutDur: number // seconds
  payload: ClipPayload
}

export interface EditorTrack {
  id: number
  kind: 'video' | 'audio'
  name: string
  hidden: boolean
  locked: boolean
  muted: boolean
}

export interface EditorProject {
  tracks: EditorTrack[]
  clips: EditorClip[]
  transitions: ClipTransition[]
  /** avatar pose/expression library (clips snapshot urls at creation) */
  avatars: AvatarPose[]
  /** sequence length (seconds) */
  duration: number
  bg: string
}

export type MediaAssetKind = 'video' | 'image' | 'audio'

export interface MediaAsset {
  id: number
  kind: MediaAssetKind
  name: string
  url: string
  naturalDuration: number
  videoWidth: number
  videoHeight: number
  peaks: number[]
}

let nextClipId = 1000
let nextTrackId = 100
let nextAssetId = 5000
let nextTransitionId = 9000
let nextPoseId = 7000

export const uidClip = () => nextClipId++
export const uidTrack = () => nextTrackId++
export const uidAsset = () => nextAssetId++
export const uidTransition = () => nextTransitionId++
export const uidPose = () => nextPoseId++

/** Default (inert) motion block for new clips. */
export const MOTION_DEFAULTS = {
  animIn: 'none' as ClipMotion,
  animInDur: 0.6,
  animOut: 'none' as ClipMotion,
  animOutDur: 0.6,
}

export const isVisualKind = (k: EditorClipKind) => k !== 'audio'
export const isAudioKind = (k: EditorClipKind) => k === 'audio' || k === 'video'

export function defaultProject(): EditorProject {
  return {
    tracks: [
      { id: uidTrack(), kind: 'video', name: 'V2 · Titles', hidden: false, locked: false, muted: false },
      { id: uidTrack(), kind: 'video', name: 'V1 · Scenes', hidden: false, locked: false, muted: false },
      { id: uidTrack(), kind: 'audio', name: 'A1 · Audio', hidden: false, locked: false, muted: false },
    ],
    clips: [],
    transitions: [],
    avatars: [],
    duration: 20,
    bg: '#000000',
  }
}

/**
 * The clip feeding the cut right before `clip` on the same video track
 * (butt cuts and near-cuts within tolerance) — the "A" side of a transition.
 */
export function findCutBefore(project: EditorProject, clip: EditorClip): EditorClip | null {
  if (!isVisualKind(clip.kind)) return null
  let best: EditorClip | null = null
  for (const c of project.clips) {
    if (c.id === clip.id || c.trackId !== clip.trackId || !isVisualKind(c.kind)) continue
    const end = c.start + c.duration
    if (end <= clip.start + 0.26 && (!best || end > best.start + best.duration)) best = c
  }
  return best
}

export function transitionForClip(project: EditorProject, clipId: number): ClipTransition | undefined {
  return project.transitions.find(t => t.clipId === clipId)
}

export function trackEnd(project: EditorProject, trackId: number): number {
  let end = 0
  for (const c of project.clips) {
    if (c.trackId === trackId) end = Math.max(end, c.start + c.duration)
  }
  return end
}

export function projectEnd(project: EditorProject): number {
  let end = 0
  for (const c of project.clips) end = Math.max(end, c.start + c.duration)
  return end
}

/** Intrinsic source length (before timeline trimming). */
export function sourceDuration(clip: EditorClip): number {
  const p = clip.payload
  switch (p.kind) {
    case 'whiteboard': return Math.max(0.5, p.data.settings.duration)
    case 'showcase': {
      const n = p.data.items.length
      const sketch = p.data.sketchOptions.enabled ? p.data.sketchOptions.duration : 0
      return n ? n * (sketch + p.data.hold + p.data.trans) + 1.2 : 2
    }
    case 'video': return Math.max(0.5, p.data.naturalDuration || clip.duration)
    case 'image':
    case 'avatar': return Math.max(1, clip.duration)
    case 'audio': return Math.max(0.5, p.data.naturalDuration || clip.duration)
    case 'text': return Math.max(0.5, clip.duration)
  }
}

export function fmtTC(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  const whole = Math.floor(r)
  const frames = Math.floor((r - whole) * 30)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(m)}:${p2(whole)}:${p2(frames)}`
}

export function fmtSec(sec: number): string {
  return `${Math.max(0, sec).toFixed(1)}s`
}
