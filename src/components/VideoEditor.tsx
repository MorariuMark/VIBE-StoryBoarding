import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CANVAS_H, CANVAS_W, type BrushType } from '../engine/types'
import { buildShowTimeline } from '../engine/showcase'
import { downloadBlob } from '../engine/exporter'
import {
  defaultProject, findCutBefore, fmtSec, fmtTC, isVisualKind, MOTION_DEFAULTS, projectEnd,
  sourceDuration, trackEnd,
  uidAsset, uidClip, uidPose, uidTrack, uidTransition,
  type AvatarCorner, type AvatarMode, type AvatarPopStyle, type CaptionAnim, type ClipMotion, type EditorClip,
  type EditorProject, type EditorTrack, type MediaAsset, type TextPreset, type TransitionType,
} from '../engine/editorTypes'
import {
  activeTransitionsAt, cancelEditorExport, computePeaks, contentPivot, createMediaCache,
  exportEditorProjectFrames, frozenLocal, measureTextBlock, renderEditorFrame, type MediaCache,
} from '../engine/editorRender'
import {
  cloneStrokes, describePlacement, getShowcaseSnapshot, getWhiteboardSnapshot, onAddSceneRequest,
} from '../engine/projectBridge'
import { ModeTabs, type AppMode } from './shared'
import VoiceoverWindow, { type VoiceoverInsert } from './VoiceoverWindow'

type Status = { kind: 'idle' | 'working' | 'error'; msg: string }

const KIND_STYLE: Record<EditorClip['kind'], { bar: string; badge: string; icon: string }> = {
  whiteboard: { bar: 'bg-indigo-600/90', badge: 'bg-indigo-500', icon: '✏️' },
  showcase: { bar: 'bg-fuchsia-600/90', badge: 'bg-fuchsia-500', icon: '🖼️' },
  video: { bar: 'bg-sky-600/90', badge: 'bg-sky-500', icon: '🎞️' },
  image: { bar: 'bg-emerald-600/90', badge: 'bg-emerald-500', icon: '🖼' },
  audio: { bar: 'bg-amber-600/90', badge: 'bg-amber-500', icon: '🎵' },
  text: { bar: 'bg-rose-600/90', badge: 'bg-rose-500', icon: '🔤' },
  avatar: { bar: 'bg-cyan-600/90', badge: 'bg-cyan-500', icon: '🧍' },
}

const ROW_H_VIDEO = 62
const ROW_H_AUDIO = 54
const RULER_H = 30

const MOTIONS: { id: ClipMotion; label: string; title: string }[] = [
  { id: 'none', label: 'None', title: 'No motion' },
  { id: 'fromL', label: '←', title: 'Slide in from the left' },
  { id: 'fromR', label: '→', title: 'Slide in from the right' },
  { id: 'fromT', label: '↑', title: 'Slide in from the top' },
  { id: 'fromB', label: '↓', title: 'Slide in from the bottom' },
  { id: 'zoomIn', label: 'Zoom+', title: 'Scale up while fading in' },
  { id: 'zoomOut', label: 'Zoom−', title: 'Settle down from large' },
  { id: 'pop', label: 'Pop', title: 'Springy pop' },
]

const TRANSITIONS: { id: TransitionType; label: string; title: string }[] = [
  { id: 'dissolve', label: 'Dissolve', title: 'Cross-dissolve A into B' },
  { id: 'fade-black', label: '⇄ Black', title: 'Fade out to black, back into B' },
  { id: 'dip-white', label: '⇄ White', title: 'Flash through white into B' },
  { id: 'wipeL', label: 'Wipe →', title: 'B wipes in from the left' },
  { id: 'wipeR', label: 'Wipe ←', title: 'B wipes in from the right' },
  { id: 'wipeU', label: 'Wipe ↓', title: 'B wipes in from the top' },
  { id: 'wipeD', label: 'Wipe ↑', title: 'B wipes in from the bottom' },
  { id: 'pushL', label: 'Push →', title: 'B pushes A out to the left' },
  { id: 'pushR', label: 'Push ←', title: 'B pushes A out to the right' },
  { id: 'zoom', label: 'Zoom', title: 'B zooms in over a fading A' },
]

export default function VideoEditor({ mode, onMode }: { mode: AppMode; onMode: (m: AppMode) => void }) {
  const [project, setProject] = useState<EditorProject>(() => defaultProject())
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pxPerSec, setPxPerSec] = useState(42)
  const [snap, setSnap] = useState(true)
  const [expFps, setExpFps] = useState(30)
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: 'Build your film: add a Whiteboard or Showcase scene, or drop in media' })
  const [exportPct, setExportPct] = useState<number | null>(null)
  const [voOpen, setVoOpen] = useState(false)
  const [showBox, setShowBox] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const fileVideoRef = useRef<HTMLInputElement>(null)
  const fileImageRef = useRef<HTMLInputElement>(null)
  const fileAudioRef = useRef<HTMLInputElement>(null)
  const fileAvatarRef = useRef<HTMLInputElement>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const rafRef = useRef(0)
  const lastTsRef = useRef(0)
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(1)
  const projectRef = useRef(project)
  const cacheRef = useRef<MediaCache>(createMediaCache())
  const lastSeekRef = useRef<Map<string, number>>(new Map())

  projectRef.current = project
  timeRef.current = time
  playingRef.current = playing
  speedRef.current = speed

  const selected = useMemo(() => project.clips.find(c => c.id === selectedId) ?? null, [project.clips, selectedId])
  /** w/h of the selected avatar's first pose (for the transform box); null = fallback */
  const selectedPoseAspect = useMemo(() => {
    if (!selected || selected.payload.kind !== 'avatar') return null
    const im = cacheRef.current.images.get(selected.payload.data.poseUrls[0])
    return im && im.naturalWidth > 0 ? im.naturalWidth / im.naturalHeight : null
  }, [selected])
  const captionTotal = useMemo(
    () => project.clips.filter(c => c.payload.kind === 'text' && c.payload.data.preset === 'caption').length,
    [project.clips],
  )

  /** Bulk edit: push the selected caption's style onto every caption clip. */
  const applyCaptionStyleToAll = useCallback(() => {
    const src = projectRef.current.clips.find(c => c.id === selectedId)
    if (!src || src.payload.kind !== 'text') return
    const s = src.payload.data
    const style = {
      fontSize: s.fontSize, color: s.color, bg: s.bg, fontFamily: s.fontFamily,
      anim: s.anim, posY: s.posY, hiColor: s.hiColor,
    }
    const targets = projectRef.current.clips.filter(c => c.payload.kind === 'text' && c.payload.data.preset === 'caption')
    if (!targets.length) return
    setProject(prev => ({
      ...prev,
      clips: prev.clips.map(c => (c.payload.kind === 'text' && c.payload.data.preset === 'caption'
        ? { ...c, payload: { kind: 'text' as const, data: { ...c.payload.data, ...style } } }
        : c)),
    }))
    setStatus({ kind: 'idle', msg: `Caption style applied to all ${targets.length} captions at once` })
  }, [selectedId])
  const videoTracks = useMemo(() => project.tracks.filter(t => t.kind === 'video'), [project.tracks])
  const audioTracks = useMemo(() => project.tracks.filter(t => t.kind === 'audio'), [project.tracks])
  const totalW = Math.max(600, (project.duration + 4) * pxPerSec)

  // ---------- media cache reconciliation ----------
  const syncCache = useCallback((p: EditorProject) => {
    const cache = cacheRef.current
    // images (shared by url — stateless), incl. avatar poses + library
    const imgUrls = new Set<string>()
    for (const c of p.clips) {
      if (c.payload.kind === 'image') imgUrls.add(c.payload.data.url)
      if (c.payload.kind === 'avatar') c.payload.data.poseUrls.forEach(u => imgUrls.add(u))
    }
    for (const pose of p.avatars) imgUrls.add(pose.url)
    for (const u of imgUrls) {
      if (!cache.images.has(u)) {
        const img = new Image()
        img.src = u
        cache.images.set(u, img)
      }
    }
    for (const u of [...cache.images.keys()]) {
      if (!imgUrls.has(u)) { cache.images.delete(u) }
    }
    // videos + audios are owned per-clip (independent playheads)
    const wantV = new Map<number, string>()
    const wantA = new Map<number, string>()
    for (const c of p.clips) {
      if (c.payload.kind === 'video') wantV.set(c.id, c.payload.data.url)
      if (c.payload.kind === 'audio') wantA.set(c.id, c.payload.data.url)
    }
    for (const [id, url] of wantV) {
      const key = `v${id}`
      const el = cache.videos.get(key)
      if (!el || el.dataset.src !== url) {
        el?.pause()
        const v = document.createElement('video')
        v.src = url
        v.preload = 'auto'
        v.crossOrigin = 'anonymous'
        v.dataset.src = url
        cache.videos.set(key, v)
      }
    }
    for (const key of [...cache.videos.keys()]) {
      const id = Number(key.slice(1))
      if (!wantV.has(id)) {
        try { cache.videos.get(key)?.pause() } catch { /* noop */ }
        cache.videos.delete(key)
      }
    }
    for (const [id, url] of wantA) {
      const key = `a${id}`
      const el = cache.audios.get(key)
      if (!el || el.dataset.src !== url) {
        el?.pause()
        const a = document.createElement('audio')
        a.src = url
        a.preload = 'auto'
        a.dataset.src = url
        cache.audios.set(key, a)
      }
    }
    for (const key of [...cache.audios.keys()]) {
      const id = Number(key.slice(1))
      if (!wantA.has(id)) {
        try { cache.audios.get(key)?.pause() } catch { /* noop */ }
        cache.audios.delete(key)
      }
    }
  }, [])

  useEffect(() => { syncCache(project) }, [project, syncCache])

  // pause everything on unmount
  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      cancelAnimationFrame(rafRef.current)
      cache.videos.forEach(v => { try { v.pause() } catch { /* noop */ } })
      cache.audios.forEach(a => { try { a.pause() } catch { /* noop */ } })
    }
  }, [])

  // pause everything when the tab is hidden (tabs stay mounted to keep progress)
  useEffect(() => {
    if (mode !== 'editor') {
      if (playingRef.current) {
        playingRef.current = false
        setPlaying(false)
      }
      const cache = cacheRef.current
      cache.videos.forEach(v => { try { v.pause() } catch { /* noop */ } })
      cache.audios.forEach(a => { try { a.pause() } catch { /* noop */ } })
    }
  }, [mode])

  // ---------- preview loop (idles while the tab is hidden) ----------
  useEffect(() => {
    const loop = (ts: number) => {
      try {
        if (modeRef.current !== 'editor') {
          lastTsRef.current = ts
          return
        }
        const dt = Math.min(0.1, lastTsRef.current ? (ts - lastTsRef.current) / 1000 : 0) * speedRef.current
        lastTsRef.current = ts
        const p = projectRef.current
        if (playingRef.current) {
          let t = timeRef.current + dt
          if (t >= p.duration) {
            t = p.duration
            playingRef.current = false
            setPlaying(false)
          }
          timeRef.current = t
          setTime(t)
        }
        syncTimelineMedia(p, timeRef.current, playingRef.current, speedRef.current)
        const canvas = canvasRef.current
        if (canvas) {
          renderEditorFrame(canvas.getContext('2d')!, p, timeRef.current, cacheRef.current)
        }
      } finally {
        rafRef.current = requestAnimationFrame(loop)
      }
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const syncTimelineMedia = (p: EditorProject, t: number, isPlaying: boolean, speed: number) => {
    const cache = cacheRef.current
    const now = performance.now()
    // keep media playback rate glued to the transport speed — otherwise audio
    // (and caption sync with it) drifts whenever preview speed isn't 1×
    const matchRate = (el: HTMLMediaElement) => {
      const s = Math.min(4, Math.max(0.25, speed))
      if (Math.abs((el.playbackRate || 1) - s) > 0.01) {
        try {
          el.playbackRate = s
        } catch { /* noop */ }
      }
    }
    for (const clip of p.clips) {
      const active = t >= clip.start && t < clip.start + clip.duration
      const local = t - clip.start + clip.offset
      if (clip.payload.kind === 'video') {
        const v = cache.videos.get(`v${clip.id}`)
        if (!v) continue
        const track = p.tracks.find(tr => tr.id === clip.trackId)
        const silent = clip.muted || track?.muted || clip.volume <= 0.001
        v.muted = silent
        try { v.volume = silent ? 0 : Math.min(1, clip.volume) } catch { /* noop */ }
        if (active && isPlaying) matchRate(v)
        if (active && isPlaying && !track?.hidden) {
          if (Math.abs(v.currentTime - local) > 0.38) {
            const last = lastSeekRef.current.get(`v${clip.id}`) ?? 0
            if (now - last > 220) {
              lastSeekRef.current.set(`v${clip.id}`, now)
              try { v.currentTime = Math.max(0, Math.min(local, (v.duration || local + 1) - 0.05)) } catch { /* noop */ }
            }
          }
          if (v.paused) { void v.play().catch(() => undefined) }
        } else if (active && !isPlaying) {
          if (!v.paused) { try { v.pause() } catch { /* noop */ } }
          if (v.readyState >= 1 && Math.abs(v.currentTime - local) > 0.3) {
            const last = lastSeekRef.current.get(`v${clip.id}`) ?? 0
            if (now - last > 200) {
              lastSeekRef.current.set(`v${clip.id}`, now)
              try { v.currentTime = Math.max(0, local) } catch { /* noop */ }
            }
          }
        } else if (!active && !v.paused) {
          try { v.pause() } catch { /* noop */ }
        }
      } else if (clip.payload.kind === 'audio') {
        const a = cache.audios.get(`a${clip.id}`)
        if (!a) continue
        const track = p.tracks.find(tr => tr.id === clip.trackId)
        const silent = clip.muted || track?.muted || clip.volume <= 0.001
        a.muted = silent
        try { a.volume = silent ? 0 : Math.min(1, clip.volume) } catch { /* noop */ }
        if (active && isPlaying) {
          matchRate(a)
          // tight correction: captions key off the timeline clock, so the
          // narration must not drift from it (small nudges beat long lags)
          if (Math.abs(a.currentTime - local) > 0.25) {
            try { a.currentTime = Math.max(0, local) } catch { /* noop */ }
          }
          if (a.paused) { void a.play().catch(() => undefined) }
        } else if (!active && !a.paused) {
          try { a.pause() } catch { /* noop */ }
        } else if (active && !isPlaying && !a.paused) {
          try { a.pause() } catch { /* noop */ }
        }
      }
    }
    // transition A-sides render frozen at their end frame: hold video sources
    // paused on that frame (they read as inactive above, so handle them here)
    for (const at of activeTransitionsAt(p, t)) {
      if (at.a.payload.kind !== 'video') continue
      const v = cache.videos.get(`v${at.a.id}`)
      if (!v || v.readyState < 1) continue
      const frozen = Math.max(0, frozenLocal(at.a))
      if (!v.paused) {
        try { v.pause() } catch { /* noop */ }
      }
      if (Math.abs(v.currentTime - frozen) > 0.3) {
        const last = lastSeekRef.current.get(`v${at.a.id}`) ?? 0
        if (now - last > 200) {
          lastSeekRef.current.set(`v${at.a.id}`, now)
          try { v.currentTime = frozen } catch { /* noop */ }
        }
      }
    }
  }

  // ---------- transport ----------
  const onSeek = useCallback((t: number) => {
    const c = Math.min(projectRef.current.duration, Math.max(0, t))
    timeRef.current = c
    setTime(c)
  }, [])

  const onPlayFromStart = useCallback(() => {
    if (!projectRef.current.clips.length) {
      setStatus({ kind: 'error', msg: 'Timeline is empty — add a scene or media first.' })
      return
    }
    timeRef.current = 0
    setTime(0)
    lastTsRef.current = 0
    playingRef.current = true
    setPlaying(true)
  }, [])

  const onPauseToggle = useCallback(() => {
    if (playingRef.current) {
      playingRef.current = false
      setPlaying(false)
    } else {
      if (!projectRef.current.clips.length) return
      if (timeRef.current >= projectRef.current.duration - 0.01) {
        timeRef.current = 0
        setTime(0)
      }
      lastTsRef.current = 0
      playingRef.current = true
      setPlaying(true)
    }
  }, [])

  // ---------- project helpers ----------
  const extendToFit = useCallback((extraEnd: number) => {
    setProject(prev => (extraEnd > prev.duration ? { ...prev, duration: Math.ceil(extraEnd + 1) } : prev))
  }, [])

  /** Main scenes track (V1) — new scenes append here; overlays stay on top. */
  const firstVideoTrack = useCallback((): EditorTrack | undefined => {
    const vs = projectRef.current.tracks.filter(t => t.kind === 'video')
    return vs.find(t => t.name.includes('Scenes')) ?? vs[vs.length - 1] ?? vs[0]
  }, [])

  const firstAudioTrack = useCallback((): EditorTrack | undefined => {
    return projectRef.current.tracks.find(t => t.kind === 'audio')
  }, [])

  const updateClip = useCallback((id: number, patch: Partial<EditorClip>) => {
    setProject(prev => ({ ...prev, clips: prev.clips.map(c => (c.id === id ? { ...c, ...patch } : c)) }))
  }, [])

  const deleteClip = useCallback((id: number) => {
    setProject(prev => ({
      ...prev,
      clips: prev.clips.filter(c => c.id !== id),
      transitions: prev.transitions.filter(t => t.clipId !== id),
    }))
    setSelectedId(sel => (sel === id ? null : sel))
  }, [])

  const duplicateSelected = useCallback(() => {
    const c = projectRef.current.clips.find(x => x.id === selectedId)
    if (!c) return
    const copy: EditorClip = {
      ...c,
      id: uidClip(),
      name: `${c.name} copy`,
      start: c.start + c.duration,
      locked: false,
      payload: cloneClipPayload(c.payload),
    }
    setProject(prev => ({ ...prev, clips: [...prev.clips, copy], duration: Math.max(prev.duration, copy.start + copy.duration) }))
    setSelectedId(copy.id)
  }, [selectedId])

  const splitAtPlayhead = useCallback(() => {
    const t = timeRef.current
    setProject(prev => {
      const out: EditorClip[] = []
      let changed = false
      for (const c of prev.clips) {
        if (t > c.start + 0.05 && t < c.start + c.duration - 0.05) {
          const cut = t - c.start
          const a: EditorClip = { ...c, duration: cut, fadeOut: 0 }
          const b: EditorClip = {
            ...c, id: uidClip(), start: t, duration: c.duration - cut,
            offset: c.offset + cut, fadeIn: 0, payload: cloneClipPayload(c.payload),
          }
          // video/audio/text payloads share urls — safe to shallow copy
          out.push(a, b)
          changed = true
        } else out.push(c)
      }
      if (!changed) {
        setStatus({ kind: 'error', msg: 'Playhead is not over a clip — nothing to split.' })
      }
      return { ...prev, clips: out }
    })
  }, [])

  const fitDuration = useCallback(() => {
    setProject(prev => ({ ...prev, duration: Math.max(2, Math.ceil(projectEnd(prev) + 0.5)) }))
  }, [])

  // ---------- transitions ----------
  const addTransition = useCallback((clipId: number, type: TransitionType = 'dissolve', duration = 0.5) => {
    const p = projectRef.current
    const clip = p.clips.find(c => c.id === clipId)
    if (!clip) return
    const cut = findCutBefore(p, clip)
    if (!cut) {
      setStatus({ kind: 'error', msg: 'No adjacent clip before this one — butt it against another clip to transition.' })
      return
    }
    const d = Math.min(Math.max(0.2, duration), Math.max(0.2, clip.duration))
    setProject(prev => {
      const rest = prev.transitions.filter(t => t.clipId !== clipId)
      return {
        ...prev,
        transitions: [...rest, { id: uidTransition(), trackId: clip.trackId, clipId, type, duration: d }],
      }
    })
    setStatus({ kind: 'idle', msg: `${TRANSITIONS.find(t => t.id === type)?.label} added: ${cut.name} → ${clip.name}` })
  }, [])

  const removeTransition = useCallback((clipId: number) => {
    setProject(prev => ({ ...prev, transitions: prev.transitions.filter(t => t.clipId !== clipId) }))
  }, [])

  /** One click: cross-dissolve every bare cut on every video track. */
  const dissolveAllCuts = useCallback(() => {
    const p = projectRef.current
    let added = 0
    const fresh = [...p.transitions]
    for (const clip of p.clips) {
      if (!isVisualKind(clip.kind)) continue
      if (fresh.some(t => t.clipId === clip.id)) continue
      if (!findCutBefore(p, clip)) continue
      fresh.push({ id: uidTransition(), trackId: clip.trackId, clipId: clip.id, type: 'dissolve', duration: Math.min(0.4, clip.duration) })
      added++
    }
    if (!added) {
      setStatus({ kind: 'error', msg: 'No bare cuts found — every cut already has a transition.' })
      return
    }
    setProject(prev => ({ ...prev, transitions: fresh }))
    setStatus({ kind: 'idle', msg: `Dissolve added to ${added} cut${added === 1 ? '' : 's'}` })
  }, [])

  // ---------- scene clips (editable, not baked) ----------
  const addWhiteboardScene = useCallback(() => {
    const snapWb = getWhiteboardSnapshot()
    if (!snapWb || !snapWb.strokes.length) {
      setStatus({ kind: 'error', msg: 'Whiteboard tab is empty — load an image there first, or use “Send to Editor” from that tab.' })
      return
    }
    const track = firstVideoTrack()
    if (!track) return
    const dur = Math.max(1, snapWb.settings.duration)
    const start = trackEnd(projectRef.current, track.id)
    const clip: EditorClip = {
      id: uidClip(), trackId: track.id, kind: 'whiteboard',
      name: `✏️ ${snapWb.fileName.slice(0, 28)}`,
      start, duration: dur, offset: 0,
      volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0, muted: false,
      locked: true,
      ...MOTION_DEFAULTS,
      payload: {
        kind: 'whiteboard',
        data: {
          strokes: cloneStrokes(snapWb.strokes),
          settings: { ...snapWb.settings },
          revealImg: snapWb.reveal?.img ?? null,
          photoImg: snapWb.reveal?.photo ?? null,
          revealRect: describePlacement(snapWb.reveal?.rect),
          sourceName: snapWb.fileName,
        },
      },
    }
    setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, start + dur) }))
    setSelectedId(clip.id)
    setStatus({ kind: 'idle', msg: `Whiteboard scene added (${snapWb.strokes.length} strokes) — pinned 🔒, unlock in the Inspector to move it` })
  }, [firstVideoTrack])

  const addShowcaseScene = useCallback(() => {
    const snapSc = getShowcaseSnapshot()
    if (!snapSc || !snapSc.items.length) {
      setStatus({ kind: 'error', msg: 'Showcase tab is empty — add images there first, or use “Send to Editor” from that tab.' })
      return
    }
    const track = firstVideoTrack()
    if (!track) return
    const sketchDur = snapSc.sketchOptions.enabled ? snapSc.sketchOptions.duration : 0
    const tl = buildShowTimeline(snapSc.items, snapSc.hold, snapSc.trans, 1.2, snapSc.lineup, sketchDur)
    const dur = Math.max(1, tl.total)
    const start = trackEnd(projectRef.current, track.id)
    const clip: EditorClip = {
      id: uidClip(), trackId: track.id, kind: 'showcase',
      name: `🖼️ Showcase (${snapSc.items.length})`,
      start, duration: dur, offset: 0,
      volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0, muted: false,
      locked: true,
      ...MOTION_DEFAULTS,
      payload: {
        kind: 'showcase',
        data: {
          items: [...snapSc.items], hold: snapSc.hold, trans: snapSc.trans,
          lineup: { ...snapSc.lineup }, tileStyle: { ...snapSc.tileStyle }, bg: snapSc.bg,
          sketchOptions: { ...snapSc.sketchOptions },
          sketchEntries: snapSc.sketchEntries,
          sourceName: `${snapSc.items.length} images`,
        },
      },
    }
    setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, start + dur) }))
    setSelectedId(clip.id)
    setStatus({ kind: 'idle', msg: `Showcase scene added (${snapSc.items.length} images) — pinned 🔒, unlock in the Inspector to move it` })
  }, [firstVideoTrack])

  useEffect(() => {
    return onAddSceneRequest(kind => {
      onMode('editor')
      // let the tab switch paint first
      setTimeout(() => {
        if (kind === 'whiteboard') addWhiteboardScene()
        else addShowcaseScene()
      }, 60)
    })
  }, [addWhiteboardScene, addShowcaseScene, onMode])

  // ---------- uploads ----------
  const addVideoFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    setStatus({ kind: 'working', msg: `Loading ${files.length} video(s)…` })
    const fresh: MediaAsset[] = []
    for (const f of Array.from(files)) {
      if (!/\.(mp4|webm|mov|m4v)$/i.test(f.name) && !f.type.startsWith('video')) continue
      const url = URL.createObjectURL(f)
      try {
        const meta = await probeVideo(url)
        fresh.push({ id: uidAsset(), kind: 'video', name: f.name, url, naturalDuration: meta.duration, videoWidth: meta.w, videoHeight: meta.h, peaks: [] })
      } catch { /* skip */ }
    }
    if (fresh.length) {
      setAssets(prev => [...prev, ...fresh])
      setStatus({ kind: 'idle', msg: `${fresh.length} video(s) in the bin — press ＋ to add to the timeline` })
    } else setStatus({ kind: 'error', msg: 'No readable video files.' })
  }, [])

  const addImageFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    setStatus({ kind: 'working', msg: `Loading ${files.length} image(s)…` })
    const fresh: MediaAsset[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image')) continue
      const url = URL.createObjectURL(f)
      try {
        await probeImage(url)
        fresh.push({ id: uidAsset(), kind: 'image', name: f.name, url, naturalDuration: 4, videoWidth: 0, videoHeight: 0, peaks: [] })
      } catch { /* skip */ }
    }
    if (fresh.length) {
      setAssets(prev => [...prev, ...fresh])
      setStatus({ kind: 'idle', msg: `${fresh.length} image(s) in the bin` })
    } else setStatus({ kind: 'error', msg: 'No readable images.' })
  }, [])

  const addAudioFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    setStatus({ kind: 'working', msg: `Loading ${files.length} audio file(s)…` })
    const fresh: MediaAsset[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('audio') && !/\.(mp3|wav|ogg|m4a)$/i.test(f.name)) continue
      const url = URL.createObjectURL(f)
      try {
        const dur = await probeAudio(url)
        const peaks = await computePeaks(url)
        fresh.push({ id: uidAsset(), kind: 'audio', name: f.name, url, naturalDuration: dur, videoWidth: 0, videoHeight: 0, peaks })
      } catch {
        fresh.push({ id: uidAsset(), kind: 'audio', name: f.name, url, naturalDuration: 10, videoWidth: 0, videoHeight: 0, peaks: [] })
      }
    }
    if (fresh.length) {
      setAssets(prev => [...prev, ...fresh])
      setStatus({ kind: 'idle', msg: `${fresh.length} audio file(s) in the bin` })
    } else setStatus({ kind: 'error', msg: 'No readable audio files.' })
  }, [])

  const addAssetToTimeline = useCallback((asset: MediaAsset) => {
    if (asset.kind === 'audio') {
      const track = firstAudioTrack()
      if (!track) return
      const start = trackEnd(projectRef.current, track.id)
      const clip: EditorClip = {
        id: uidClip(), trackId: track.id, kind: 'audio', name: `🎵 ${asset.name}`,
        start, duration: Math.max(1, asset.naturalDuration), offset: 0,
        volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0.3, fadeOut: 0.3, muted: false,
        ...MOTION_DEFAULTS,
        payload: { kind: 'audio', data: { url: asset.url, name: asset.name, naturalDuration: asset.naturalDuration, peaks: asset.peaks } },
      }
      setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, start + clip.duration) }))
      setSelectedId(clip.id)
      return
    }
    const track = firstVideoTrack()
    if (!track) return
    const start = trackEnd(projectRef.current, track.id)
    if (asset.kind === 'video') {
      const clip: EditorClip = {
        id: uidClip(), trackId: track.id, kind: 'video', name: `🎞️ ${asset.name}`,
        start, duration: Math.max(1, asset.naturalDuration), offset: 0,
        volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0, muted: false,
        ...MOTION_DEFAULTS,
        payload: { kind: 'video', data: { url: asset.url, name: asset.name, naturalDuration: asset.naturalDuration, videoWidth: asset.videoWidth, videoHeight: asset.videoHeight, fit: 'contain' } },
      }
      setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, start + clip.duration) }))
      setSelectedId(clip.id)
    } else {
      const clip: EditorClip = {
        id: uidClip(), trackId: track.id, kind: 'image', name: `🖼 ${asset.name}`,
        start, duration: 4, offset: 0,
        volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0.3, fadeOut: 0.3, muted: false,
        ...MOTION_DEFAULTS,
        payload: { kind: 'image', data: { url: asset.url, name: asset.name, fit: 'contain', kenBurns: true } },
      }
      setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, start + clip.duration) }))
      setSelectedId(clip.id)
    }
  }, [firstAudioTrack, firstVideoTrack])

  const addTextClip = useCallback((preset: TextPreset) => {
    const track = projectRef.current.tracks.find(t => t.kind === 'video')
    if (!track) return
    const start = timeRef.current
    const defaults: Record<TextPreset, { text: string; fontSize: number }> = {
      title: { text: 'Your Title', fontSize: 120 },
      lower: { text: 'Name — Role', fontSize: 54 },
      caption: { text: 'Caption text', fontSize: 44 },
    }
    const clip: EditorClip = {
      id: uidClip(), trackId: track.id, kind: 'text',
      name: `🔤 ${preset === 'title' ? 'Title' : preset === 'lower' ? 'Lower third' : 'Caption'}`,
      start, duration: 3, offset: 0,
      volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0.3, fadeOut: 0.3, muted: false,
      ...MOTION_DEFAULTS,
      payload: {
        kind: 'text',
        data: {
          text: defaults[preset].text, preset, fontSize: defaults[preset].fontSize,
          color: '#ffffff', bg: preset === 'title' ? 'transparent' : 'rgba(0,0,0,0.72)', fontFamily: 'Inter, system-ui, sans-serif',
        },
      },
    }
    setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, start + 3) }))
    setSelectedId(clip.id)
  }, [])

  // ---------- intros & outros ----------
  const titleClip = (
    trackId: number, start: number, duration: number, name: string, text: string,
    opts: {
      fontSize: number; color?: string; bg?: string; preset?: TextPreset;
      animIn?: ClipMotion; animInDur?: number; y?: number;
    },
  ): EditorClip => ({
    id: uidClip(), trackId, kind: 'text', name, start, duration, offset: 0,
    volume: 1, opacity: 1, scale: 1, x: 0, y: (opts.y ?? 0) / 5.4, // px → percent of half-screen
    fadeIn: 0.3, fadeOut: 0.4, muted: false,
    ...MOTION_DEFAULTS,
    animIn: opts.animIn ?? 'none',
    animInDur: opts.animInDur ?? 0.6,
    payload: {
      kind: 'text',
      data: {
        text, preset: opts.preset ?? 'title', fontSize: opts.fontSize,
        color: opts.color ?? '#ffffff', bg: opts.bg ?? 'transparent',
        fontFamily: 'Inter, system-ui, sans-serif',
      },
    },
  })

  /** Push every clip later to open a gap of `dur` at time zero. */
  const rippleInsert = useCallback((dur: number) => {
    setProject(prev => ({
      ...prev,
      clips: prev.clips.map(c => ({ ...c, start: c.start + dur })),
      duration: prev.duration + dur,
    }))
    onSeek(0)
  }, [onSeek])

  const introOpener = useCallback(() => {
    const track = projectRef.current.tracks.find(t => t.kind === 'video')
    if (!track) return
    const D = 3.5
    rippleInsert(D)
    const title = titleClip(track.id, 0, D, '🔤 Opener title', 'Your Title', { fontSize: 132, animIn: 'zoomIn', animInDur: 1.2, y: -50 })
    const sub = titleClip(track.id, 1.1, D - 1.1, '🔤 Opener subtitle', 'A short tagline goes here', { fontSize: 52, preset: 'lower', animIn: 'fromB', animInDur: 0.8, y: 170 })
    setProject(prev => ({ ...prev, clips: [...prev.clips, title, sub] }))
    setSelectedId(title.id)
    setStatus({ kind: 'idle', msg: 'Cinematic opener added — edit the titles, motion and timing in the Inspector' })
  }, [rippleInsert])

  const introIdent = useCallback(() => {
    const track = projectRef.current.tracks.find(t => t.kind === 'video')
    if (!track) return
    const D = 2.5
    rippleInsert(D)
    const title = titleClip(track.id, 0, D, '🔤 Channel ident', 'Channel Name', { fontSize: 110, animIn: 'pop', animInDur: 0.7 })
    setProject(prev => ({ ...prev, clips: [...prev.clips, title] }))
    setSelectedId(title.id)
    setStatus({ kind: 'idle', msg: 'Channel ident added — swap in your name and tune the pop' })
  }, [rippleInsert])

  const outroEndCard = useCallback(() => {
    const p = projectRef.current
    const track = p.tracks.find(t => t.kind === 'video')
    if (!track) return
    const at = Math.max(projectEnd(p), 0)
    const D = 4
    const title = titleClip(track.id, at, D, '🔤 End card', 'Thanks for watching', { fontSize: 110, animIn: 'pop', animInDur: 0.7, y: -60 })
    const sub = titleClip(track.id, at + 0.8, D - 0.8, '🔤 End card sub', 'Like & subscribe for more', { fontSize: 50, preset: 'lower', animIn: 'fromB', animInDur: 0.6, y: 150 })
    setProject(prev => ({ ...prev, clips: [...prev.clips, title, sub], duration: Math.max(prev.duration, at + D) }))
    setSelectedId(title.id)
    setStatus({ kind: 'idle', msg: 'End card appended — edit the text and motion freely' })
  }, [])

  const outroSubscribe = useCallback(() => {
    const p = projectRef.current
    const track = p.tracks.find(t => t.kind === 'video')
    if (!track) return
    const at = Math.max(projectEnd(p), 0)
    const D = 3
    const title = titleClip(track.id, at, D, '🔤 Subscribe bumper', '🔔 Subscribe', { fontSize: 120, animIn: 'pop', animInDur: 0.6 })
    const sub = titleClip(track.id, at + 0.6, D - 0.6, '🔤 Bumper sub', 'New videos every week', { fontSize: 48, preset: 'caption', animIn: 'fromB', animInDur: 0.5, y: 170 })
    setProject(prev => ({ ...prev, clips: [...prev.clips, title, sub], duration: Math.max(prev.duration, at + D) }))
    setSelectedId(title.id)
    setStatus({ kind: 'idle', msg: 'Subscribe bumper appended' })
  }, [])

  const outroFade = useCallback(() => {
    const end = projectEnd(projectRef.current)
    if (end <= 0) {
      setStatus({ kind: 'error', msg: 'Timeline is empty — nothing to fade out.' })
      return
    }
    setProject(prev => ({
      ...prev,
      clips: prev.clips.map(c => (Math.abs(c.start + c.duration - end) < 0.01 ? { ...c, fadeOut: Math.max(c.fadeOut, 0.8) } : c)),
      duration: Math.max(prev.duration, end + 0.8),
    }))
    setStatus({ kind: 'idle', msg: 'Fade-out finish applied — final clips dissolve out over 0.8s' })
  }, [])

  // ---------- avatar host ----------
  const addAvatarPoses = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    setStatus({ kind: 'working', msg: `Loading ${files.length} pose(s)…` })
    const fresh: { id: number; url: string; name: string }[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image')) continue
      const url = URL.createObjectURL(f)
      try {
        await probeImage(url)
        fresh.push({ id: uidPose(), url, name: f.name })
      } catch { /* skip unreadable */ }
    }
    if (!fresh.length) {
      setStatus({ kind: 'error', msg: 'No readable images.' })
      return
    }
    setProject(prev => ({ ...prev, avatars: [...prev.avatars, ...fresh] }))
    setStatus({ kind: 'idle', msg: `${fresh.length} pose${fresh.length === 1 ? '' : 's'} added — upload expressions/poses, then drop a host clip` })
  }, [])

  const removeAvatarPose = useCallback((id: number) => {
    setProject(prev => {
      const gone = prev.avatars.find(a => a.id === id)
      return {
        ...prev,
        avatars: prev.avatars.filter(a => a.id !== id),
        clips: prev.clips.map(c => (c.payload.kind === 'avatar' && gone
          ? { ...c, payload: { ...c.payload, data: { ...c.payload.data, poseUrls: c.payload.data.poseUrls.filter(u => u !== gone.url) } } }
          : c)),
      }
    })
  }, [])

  const avatarClipBase = (
    trackId: number, start: number, duration: number, name: string,
    mode: AvatarMode, poseUrls: string[],
  ): EditorClip => ({
    id: uidClip(), trackId, kind: 'avatar', name, start, duration, offset: 0,
    volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0.3, fadeOut: 0.4, muted: false,
    ...MOTION_DEFAULTS,
    payload: {
      kind: 'avatar',
      data: {
        poseUrls, mode, popCount: 4, popStyle: 'mixed', holdMul: 1, poseInterval: 2.5,
        wander: 0.6, animSpeed: 1, avatarScale: 1, corner: 'random',
        offX: 0, offY: 0, rot: 0, flip: false, shadow: true, fadeDur: 0.35,
      },
    },
  })

  /** Presenter overlay spanning the whole video. */
  const addPresenterClip = useCallback(() => {
    const p = projectRef.current
    if (!p.avatars.length) {
      setStatus({ kind: 'error', msg: 'Upload at least one avatar pose first.' })
      return
    }
    const track = p.tracks.find(t => t.kind === 'video')
    if (!track) return
    const dur = Math.max(4, p.duration)
    const clip = avatarClipBase(track.id, 0, dur, '🧍 Host presenter', 'present', p.avatars.map(a => a.url))
    setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, dur) }))
    setSelectedId(clip.id)
    setStatus({ kind: 'idle', msg: 'Host presenter added over the whole video — poses, motion and corners in the Inspector' })
  }, [])

  /** Random pop-ups at the playhead. */
  const addPopupClip = useCallback(() => {
    const p = projectRef.current
    if (!p.avatars.length) {
      setStatus({ kind: 'error', msg: 'Upload at least one avatar pose first.' })
      return
    }
    const track = p.tracks.find(t => t.kind === 'video')
    if (!track) return
    const at = Math.min(Math.max(0, timeRef.current), p.duration)
    const D = 8
    const clip = avatarClipBase(track.id, at, D, '🧍 Host pop-ups', 'popup', p.avatars.map(a => a.url))
    setProject(prev => ({ ...prev, clips: [...prev.clips, clip], duration: Math.max(prev.duration, at + D) }))
    setSelectedId(clip.id)
    setStatus({ kind: 'idle', msg: 'Host pop-ups added — count, corners and style in the Inspector' })
  }, [])

  /** Insert a generated AI voiceover (+ synced captions) at the playhead. */
  const insertVoiceover = useCallback((ins: VoiceoverInsert) => {
    const p = projectRef.current
    const aTrack = p.tracks.find(t => t.kind === 'audio')
    const vTrack = p.tracks.find(t => t.kind === 'video')
    if (!aTrack || !vTrack) return
    const at = Math.min(Math.max(0, timeRef.current), p.duration)
    const voId = uidClip()
    const voClip: EditorClip = {
      id: voId, trackId: aTrack.id, kind: 'audio', name: ins.name,
      start: at, duration: Math.max(0.5, ins.naturalDuration), offset: 0,
      volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0.2, fadeOut: 0.4, muted: false,
      ...MOTION_DEFAULTS,
      payload: { kind: 'audio', data: { url: ins.url, name: ins.name, naturalDuration: ins.naturalDuration, peaks: ins.peaks } },
    }
    const capClips: EditorClip[] = ins.captions.map((c, i) => ({
      id: uidClip(), trackId: vTrack.id, kind: 'text', name: `💬 ${i + 1}`,
      start: at + c.start, duration: Math.max(0.3, c.end - c.start), offset: 0,
      volume: 1, opacity: 1, scale: 1, x: 0, y: 0, fadeIn: 0.08, fadeOut: 0.08, muted: false,
      ...MOTION_DEFAULTS,
      payload: {
        kind: 'text',
        data: {
          text: c.text, preset: 'caption', fontSize: ins.captionStyle.fontSize,
          color: ins.captionStyle.color, bg: ins.captionStyle.bg, fontFamily: ins.captionStyle.fontFamily,
          anim: ins.captionStyle.anim, posY: ins.captionStyle.posY,
          words: c.words, hiColor: ins.captionStyle.hiColor,
        },
      },
    }))
    const end = Math.max(at + voClip.duration, ...capClips.map(c => c.start + c.duration))
    setAssets(prev => [...prev, {
      id: uidAsset(), kind: 'audio', name: ins.name, url: ins.url,
      naturalDuration: ins.naturalDuration, videoWidth: 0, videoHeight: 0, peaks: ins.peaks,
    }])
    setProject(prev => ({
      ...prev,
      clips: [...prev.clips, voClip, ...capClips],
      duration: Math.max(prev.duration, Math.ceil(end + 0.5)),
    }))
    setSelectedId(voId)
    setStatus({
      kind: 'idle',
      msg: `Voiceover added (${ins.voiceLabel}, ${voClip.duration.toFixed(1)}s)${capClips.length ? ` + ${capClips.length} synced captions` : ''} — trim, fade & restyle freely`,
    })
    setVoOpen(false)
  }, [])

  // ---------- export ----------
  const onExport = useCallback(async () => {
    if (!projectRef.current.clips.length) {
      setStatus({ kind: 'error', msg: 'Timeline is empty — nothing to export.' })
      return
    }
    try {
      playingRef.current = false
      setPlaying(false)
      setExportPct(0)
      setStatus({ kind: 'working', msg: 'Rendering 1080p MP4 frame-by-frame (video mix)…' })
      const blob = await exportEditorProjectFrames(projectRef.current, cacheRef.current, expFps, (f, total) => {
        setExportPct(Math.round((f / total) * 100))
      })
      downloadBlob(blob, `editor-${Date.now()}.mp4`)
      setStatus({ kind: 'idle', msg: `Exported ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4 · 1920×1080 @${expFps}fps (audio is preview-only)` })
    } catch (e) {
      setStatus({ kind: 'error', msg: e instanceof Error ? e.message : 'Export failed' })
    } finally {
      setExportPct(null)
    }
  }, [expFps])

  // ---------- keyboard (only while this tab is visible) ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (modeRef.current !== 'editor') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.code === 'Space') { e.preventDefault(); onPauseToggle() }
      else if (e.key === 's' || e.key === 'S') splitAtPlayhead()
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId !== null) deleteClip(selectedId)
      } else if (e.key === 'ArrowLeft') onSeek(timeRef.current - 1)
      else if (e.key === 'ArrowRight') onSeek(timeRef.current + 1)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onPauseToggle, splitAtPlayhead, selectedId, deleteClip, onSeek])

  const rulerSteps = useMemo(() => {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60]
    const step = steps.find(s => s * pxPerSec >= 72) ?? 60
    const ticks: number[] = []
    for (let t = 0; t <= project.duration + 0.001; t += step) ticks.push(t)
    return { step, ticks }
  }, [pxPerSec, project.duration])

  const moveTrack = useCallback((id: number, dir: -1 | 1) => {
    setProject(prev => {
      const clip = prev.clips.find(c => c.id === id)
      if (!clip) return prev
      const same = prev.tracks.filter(t => t.kind === (isVisualKind(clip.kind) ? 'video' : 'audio'))
      const i = same.findIndex(t => t.id === clip.trackId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= same.length) return prev
      return { ...prev, clips: prev.clips.map(c => (c.id === id ? { ...c, trackId: same[j].id } : c)) }
    })
  }, [])

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900/70 backdrop-blur">
        <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center text-xl">🎬</div>
        <div>
          <h1 className="font-bold text-lg leading-none tracking-tight">Editor</h1>
          <p className="text-xs text-zinc-400">multi-track timeline · scenes stay editable</p>
        </div>
        <div className="flex-1" />
        <ModeTabs mode={mode} onMode={onMode} />
        <div className="hidden lg:flex items-center gap-2 text-xs text-zinc-400">
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">1920×1080</span>
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700">{project.clips.length} clips</span>
          <span className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 font-mono">{fmtTC(time)} / {fmtTC(project.duration)}</span>
        </div>
        <button
          onClick={() => setVoOpen(true)}
          title="AI voiceover studio — Kokoro-82M TTS, auto captions, add straight to the timeline"
          className="ml-1 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 font-semibold text-sm shadow-lg shadow-violet-950"
        >
          🎙 Voiceover
        </button>
        <select value={expFps} onChange={e => setExpFps(+e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs font-mono" title="Export frame rate">
          {[24, 30, 60].map(v => <option key={v} value={v}>{v} fps</option>)}
        </select>
        <button
          onClick={() => void onExport()}
          disabled={!project.clips.length || exportPct !== null}
          className="ml-1 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 font-semibold text-sm shadow-lg shadow-emerald-950"
        >
          {exportPct !== null ? `Rendering ${exportPct}%…` : '⬇ Export MP4'}
        </button>
        {exportPct !== null && (
          <button onClick={() => cancelEditorExport()} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm border border-zinc-700">Cancel</button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        {/* media bin */}
        <aside className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-900/50 p-4 overflow-y-auto space-y-5">
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">1 · Scenes (editable)</h2>
            <div className="space-y-2">
              <button onClick={addWhiteboardScene} className="w-full text-left p-3 rounded-xl bg-indigo-950/50 hover:bg-indigo-900/50 border border-indigo-800/60 transition">
                <div className="text-sm font-semibold">✏️ ＋ Whiteboard scene</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">Live sketch from the Whiteboard tab — ink, timing & reveal stay editable</div>
              </button>
              <button onClick={addShowcaseScene} className="w-full text-left p-3 rounded-xl bg-fuchsia-950/50 hover:bg-fuchsia-900/50 border border-fuchsia-800/60 transition">
                <div className="text-sm font-semibold">🖼️ ＋ Showcase scene</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">Live slideshow from the Showcase tab — hold, motion & layout stay editable</div>
              </button>
            </div>
          </section>

          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">2 · Media bin</h2>
            <div className="grid grid-cols-3 gap-1.5">
              <button onClick={() => fileVideoRef.current?.click()} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">🎞️ Video</button>
              <button onClick={() => fileImageRef.current?.click()} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">🖼 Image</button>
              <button onClick={() => fileAudioRef.current?.click()} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">🎵 Audio</button>
            </div>
            <input ref={fileVideoRef} type="file" accept="video/*" multiple className="hidden" onChange={e => { void addVideoFiles(e.target.files); e.target.value = '' }} />
            <input ref={fileImageRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { void addImageFiles(e.target.files); e.target.value = '' }} />
            <input ref={fileAudioRef} type="file" accept="audio/*" multiple className="hidden" onChange={e => { void addAudioFiles(e.target.files); e.target.value = '' }} />
            <div className="mt-2 space-y-1.5">
              {assets.map(a => (
                <div key={a.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/60">
                  {a.kind === 'image'
                    ? <img src={a.url} alt={a.name} className="w-12 h-8 object-cover rounded border border-zinc-700" />
                    : <span className="w-12 h-8 rounded bg-zinc-700 flex items-center justify-center text-lg">{a.kind === 'video' ? '🎞️' : '🎵'}</span>}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate text-zinc-200" title={a.name}>{a.name}</div>
                    <div className="text-[10px] text-zinc-500 font-mono">{fmtSec(a.naturalDuration)}</div>
                  </div>
                  <button onClick={() => addAssetToTimeline(a)} className="px-2 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600" title="Add to timeline">＋</button>
                </div>
              ))}
              {!assets.length && <p className="text-xs text-zinc-500">No uploads yet.</p>}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">3 · Titles</h2>
            <div className="grid grid-cols-3 gap-1.5">
              {(['title', 'lower', 'caption'] as TextPreset[]).map(p => (
                <button key={p} onClick={() => addTextClip(p)} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 capitalize">{p === 'lower' ? 'Lower 3rd' : p}</button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">Titles land on the top video track at the playhead.</p>
          </section>

          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">4 · Intros & outros</h2>
            <div className="space-y-2">
              <div>
                <div className="text-[11px] text-zinc-500 mb-1.5">Openers (ripple the timeline open)</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button onClick={introOpener} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="3.5s cinematic title + tagline at time zero">🎞 Cinematic</button>
                  <button onClick={introIdent} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="2.5s channel ident with a pop">👋 Ident</button>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-zinc-500 mb-1.5">Endings (appended at the end)</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button onClick={outroEndCard} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="4s thanks-for-watching card">🙏 End card</button>
                  <button onClick={outroSubscribe} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="3s subscribe bumper">🔔 Subscribe</button>
                </div>
                <button onClick={outroFade} className="w-full mt-1.5 px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Fade the final clips out over 0.8s">🌑 Fade-out finish</button>
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">Everything lands as editable clips — restyle in the Inspector.</p>
          </section>

          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">5 · Avatar host 🧍</h2>
            <button onClick={() => fileAvatarRef.current?.click()} className="w-full px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-dashed border-zinc-600" title="Upload one image per pose / expression">
              ⬆ Upload poses / expressions
            </button>
            <input ref={fileAvatarRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { void addAvatarPoses(e.target.files); e.target.value = '' }} />
            {project.avatars.length > 0 && (
              <div className="grid grid-cols-4 gap-1.5 mt-2">
                {project.avatars.map(a => (
                  <div key={a.id} className="relative group rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800" title={a.name}>
                    <img src={a.url} alt={a.name} className="w-full h-14 object-cover" />
                    <button
                      onClick={() => removeAvatarPose(a.id)}
                      className="absolute top-0.5 right-0.5 w-5 h-5 rounded bg-black/70 hover:bg-red-900 text-[10px] opacity-0 group-hover:opacity-100"
                      title={`Remove ${a.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1.5 mt-2">
              <button onClick={addPresenterClip} className="px-2 py-2 text-xs rounded-lg bg-cyan-800 hover:bg-cyan-700 border border-cyan-700" title="Avatar stays on screen for the whole video, cycling poses">🧍 Presenter</button>
              <button onClick={addPopupClip} className="px-2 py-2 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Avatar pops up at random spots for 8s from the playhead">💥 Pop-ups</button>
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">Poses, corners, pop count, wander & fades are all optional in the Inspector.</p>
          </section>

          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">Sequence</h2>
            <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2">
              <div className="flex justify-between text-xs"><span>Duration</span><span className="font-mono text-zinc-400">{fmtSec(project.duration)}</span></div>
              <input
                type="range" min={2} max={180} step={1} value={project.duration}
                onChange={e => setProject(prev => ({ ...prev, duration: +e.target.value }))}
                className="w-full"
              />
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={fitDuration} className="px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">Fit to clips</button>
                <button
                  onClick={() => { setProject(defaultProject()); setSelectedId(null); onSeek(0); setStatus({ kind: 'idle', msg: 'Timeline cleared' }) }}
                  className="px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-red-900 border border-zinc-700"
                >
                  Clear
                </button>
              </div>
              <div className="flex justify-between text-xs items-center pt-1">
                <span>Background</span>
                <input type="color" value={project.bg} onChange={e => setProject(prev => ({ ...prev, bg: e.target.value }))} className="w-10 h-7 rounded cursor-pointer bg-transparent" />
              </div>
            </div>
          </section>
        </aside>

        {/* center: preview + timeline */}
        <main className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <div className={`mx-4 mt-3 px-3 py-2 rounded-lg text-xs border ${status.kind === 'error' ? 'bg-red-950/60 border-red-800 text-red-200' : status.kind === 'working' ? 'bg-amber-950/60 border-amber-800 text-amber-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}>
            {status.msg}
          </div>

          <div className="flex-1 flex min-h-0">
            {/* preview */}
            <div className="flex-1 flex flex-col min-w-0 p-4">
              <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
                <div ref={previewBoxRef} className="relative h-full aspect-video max-w-full rounded-xl overflow-hidden border border-zinc-800 shadow-2xl bg-black">
                  <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="block h-full w-auto max-w-full" />
                  {selected && selected.kind !== 'audio' && showBox && (
                    <TransformBox
                      clip={selected}
                      containerRef={previewBoxRef}
                      poseAspect={selectedPoseAspect}
                      onPatch={(p) => updateClip(selected.id, p)}
                    />
                  )}
                  {!project.clips.length && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 bg-zinc-950/80">
                      <div className="text-5xl mb-3">🎬</div>
                      <p className="font-semibold text-zinc-300">Timeline is empty</p>
                      <p className="text-sm">add a Whiteboard / Showcase scene or upload media</p>
                    </div>
                  )}
                </div>
              </div>
              {/* transport */}
              <div className="pt-3 flex items-center gap-2 justify-center flex-wrap">
                <button onClick={onPlayFromStart} className="h-9 px-4 rounded-full bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold" title="Play from start">⏮ Play</button>
                <button onClick={onPauseToggle} className="w-9 h-9 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Play / pause (Space)">
                  {playing ? '⏸' : '▶'}
                </button>
                <button onClick={() => onSeek(0)} className="w-9 h-9 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm" title="Go to start">⏪</button>
                <button onClick={() => onSeek(time - 1)} className="px-2.5 h-9 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono" title="Back 1s (←)">−1s</button>
                <button onClick={() => onSeek(time + 1)} className="px-2.5 h-9 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono" title="Forward 1s (→)">＋1s</button>
                <span className="text-xs font-mono text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">{fmtTC(time)} <span className="text-zinc-600">/ {fmtTC(project.duration)}</span></span>
                <select value={speed} onChange={e => setSpeed(+e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs font-mono" title="Preview speed">
                  {[0.5, 1, 1.5, 2].map(v => <option key={v} value={v}>{v}×</option>)}
                </select>
              </div>
            </div>

            {/* inspector */}
            <aside className="w-80 shrink-0 border-l border-zinc-800 bg-zinc-900/50 p-4 overflow-y-auto">
              <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">Inspector</h2>
              {!selected ? (
                <div className="text-xs text-zinc-500 leading-relaxed p-3 rounded-xl bg-zinc-800/40 border border-zinc-800">
                  Click a timeline clip to edit it.<br /><br />
                  • Drag the body to move, drag the <span className="text-zinc-300">◂ ▸ edges</span> to trim<br />
                  • <span className="font-mono">S</span> splits at the playhead · <span className="font-mono">Space</span> plays · <span className="font-mono">Del</span> removes<br />
                  • Scene clips stay live — change ink, timing, layout right here
                </div>
              ) : (
                <Inspector
                  clip={selected}
                  captionCount={captionTotal}
                  transition={project.transitions.find(t => t.clipId === selected.id)}
                  cutName={(() => { const c = findCutBefore(project, selected); return c ? c.name : null })()}
                  libraryPoseCount={project.avatars.length}
                  onPatch={(p) => updateClip(selected.id, p)}
                  onDelete={() => deleteClip(selected.id)}
                  onDuplicate={duplicateSelected}
                  onMoveTrack={(d) => moveTrack(selected.id, d)}
                  onFitSource={() => fitClipToSource(selected)}
                  onApplyStyleToAll={applyCaptionStyleToAll}
                  onAddTransition={(type) => addTransition(selected.id, type)}
                  showBox={showBox}
                  onToggleBox={() => setShowBox(v => !v)}
                  onReloadPoses={() => {
                    const urls = projectRef.current.avatars.map(a => a.url)
                    if (!urls.length) {
                      setStatus({ kind: 'error', msg: 'Avatar library is empty — upload poses first.' })
                      return
                    }
                    updateClip(selected.id, {
                      payload: selected.payload.kind === 'avatar'
                        ? { ...selected.payload, data: { ...selected.payload.data, poseUrls: [...urls] } }
                        : selected.payload,
                    })
                    setStatus({ kind: 'idle', msg: `Clip now uses all ${urls.length} library poses` })
                  }}
                  onRemoveTransition={() => removeTransition(selected.id)}
                  onTransitionPatch={(p) => setProject(prev => ({
                    ...prev,
                    transitions: prev.transitions.map(t => t.clipId === selected.id ? { ...t, ...p } : t),
                  }))}
                />
              )}
            </aside>
          </div>

          {/* timeline */}
          <div className="border-t border-zinc-800 bg-zinc-900/60">
            {/* timeline toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 flex-wrap">
              <button onClick={splitAtPlayhead} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Split clips at playhead (S)">✂ Split</button>
              <button onClick={duplicateSelected} disabled={!selected} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40" title="Duplicate selected">⧉ Duplicate</button>
              <button onClick={() => selected && deleteClip(selected.id)} disabled={!selected} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-red-900 border border-zinc-700 disabled:opacity-40" title="Delete selected (Del)">🗑 Delete</button>
              <button onClick={dissolveAllCuts} className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Cross-dissolve every bare cut on every video track">✨ Dissolves on all cuts</button>
              <label className="flex items-center gap-1.5 text-xs text-zinc-300 ml-1">
                <input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} className="accent-emerald-500" /> Snap
              </label>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 ml-1">
                <span>Zoom</span>
                <input type="range" min={12} max={140} value={pxPerSec} onChange={e => setPxPerSec(+e.target.value)} className="w-28" />
              </div>
              <button
                onClick={() => setProject(prev => {
                  const t: EditorTrack = { id: uidTrack(), kind: 'video', name: `V${prev.tracks.filter(x => x.kind === 'video').length + 1} · Overlay`, hidden: false, locked: false, muted: false }
                  const vids = prev.tracks.filter(x => x.kind === 'video')
                  const auds = prev.tracks.filter(x => x.kind === 'audio')
                  return { ...prev, tracks: [...vids, t, ...auds] }
                })}
                className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
                title="Add a video track"
              >
                ＋ V track
              </button>
              <button
                onClick={() => setProject(prev => ({ ...prev, tracks: [...prev.tracks, { id: uidTrack(), kind: 'audio', name: `A${prev.tracks.filter(x => x.kind === 'audio').length + 1} · Audio`, hidden: false, locked: false, muted: false }] }))}
                className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
                title="Add an audio track"
              >
                ＋ A track
              </button>
              <div className="flex-1" />
              <span className="text-[11px] text-zinc-500 hidden md:block">drag clips to move · drag edges to trim · click ruler to seek</span>
            </div>

            <div className="flex border-t border-zinc-800" style={{ height: 264 }}>
              {/* track headers */}
              <div className="w-44 shrink-0 bg-zinc-900/80 border-r border-zinc-800 overflow-hidden">
                <div style={{ height: RULER_H }} className="border-b border-zinc-800 flex items-center px-3 text-[11px] text-zinc-500 font-mono">
                  {fmtTC(time)}
                </div>
                {project.tracks.map(t => (
                  <TrackHeader
                    key={t.id} track={t} height={t.kind === 'video' ? ROW_H_VIDEO : ROW_H_AUDIO}
                    onToggle={() => setProject(prev => ({ ...prev, tracks: prev.tracks.map(x => x.id === t.id ? (x.kind === 'video' ? { ...x, hidden: !x.hidden } : { ...x, muted: !x.muted }) : x) }))}
                    onLock={() => setProject(prev => ({ ...prev, tracks: prev.tracks.map(x => x.id === t.id ? { ...x, locked: !x.locked } : x) }))}
                    onDelete={() => setProject(prev => {
                      if (prev.clips.some(c => c.trackId === t.id)) {
                        setStatus({ kind: 'error', msg: 'Track is not empty — move or delete its clips first.' })
                        return prev
                      }
                      if (prev.tracks.length <= 1) return prev
                      return { ...prev, tracks: prev.tracks.filter(x => x.id !== t.id) }
                    })}
                  />
                ))}
              </div>
              {/* scrollable lanes */}
              <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden relative" onPointerDown={e => {
                // click on empty lane seeks
                if ((e.target as HTMLElement).dataset.lane === '1') {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  // account for scroll
                  const x = e.clientX - rect.left + e.currentTarget.scrollLeft
                  onSeek(x / pxPerSec)
                }
              }}>
                <div className="relative" style={{ width: totalW, height: RULER_H + project.tracks.length * 70 }}>
                  {/* ruler */}
                  <Ruler ticks={rulerSteps.ticks} pxPerSec={pxPerSec} duration={project.duration} onSeek={onSeek} />
                  {/* lanes */}
                  {project.tracks.map((t, ti) => {
                    const top = RULER_H + ti * 70
                    const h = t.kind === 'video' ? ROW_H_VIDEO : ROW_H_AUDIO
                    return (
                      <div
                        key={t.id} data-lane="1"
                        className={`absolute left-0 right-0 border-b border-zinc-800/80 ${t.kind === 'video' ? 'bg-zinc-950/40' : 'bg-zinc-900/40'}`}
                        style={{ top, height: 70 }}
                      >
                        <div className="absolute left-0 right-0 top-1" style={{ height: h }}>
                          {project.clips.filter(c => c.trackId === t.id).map(c => (
                            <TimelineClip
                              key={c.id} clip={c} pxPerSec={pxPerSec} selected={c.id === selectedId}
                              locked={t.locked} snap={snap} project={project}
                              transition={project.transitions.find(tr => tr.clipId === c.id)}
                              onSelect={() => setSelectedId(c.id)}
                              onChange={(patch) => updateClip(c.id, patch)}
                              onMoveTrack={(d) => moveTrack(c.id, d)}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {/* playhead */}
                  <div className="absolute top-0 bottom-0 w-px bg-emerald-400 z-20 pointer-events-none" style={{ left: time * pxPerSec }}>
                    <div className="w-3 h-3 bg-emerald-400 rotate-45 -translate-x-[5px] -translate-y-[1px]" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
      {voOpen && <VoiceoverWindow onClose={() => setVoOpen(false)} onInsert={insertVoiceover} />}
    </div>
  )

  function fitClipToSource(clip: EditorClip) {
    const src = sourceDuration(clip)
    updateClip(clip.id, { duration: Math.max(0.5, src - Math.min(clip.offset, src - 0.5)) })
    setProject(prev => ({ ...prev, duration: Math.max(prev.duration, clip.start + Math.max(0.5, src - clip.offset)) }))
    void extendToFit(clip.start + src)
  }
}

// ================= track header =================
function TrackHeader({ track, height, onToggle, onLock, onDelete }: {
  track: EditorTrack; height: number; onToggle: () => void; onLock: () => void; onDelete: () => void
}) {
  const off = track.kind === 'video' ? track.hidden : track.muted
  return (
    <div className="border-b border-zinc-800/80 px-2 flex items-center gap-1.5" style={{ height: 70 }}>
      <div className={`w-1.5 rounded-full self-stretch my-2 ${track.kind === 'video' ? 'bg-emerald-600/70' : 'bg-amber-600/70'}`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate">{track.name}</div>
        <div className="text-[10px] text-zinc-500 font-mono uppercase">{track.kind}</div>
      </div>
      <button onClick={onToggle} title={track.kind === 'video' ? 'Show / hide' : 'Mute / unmute'} className={`w-7 h-7 rounded text-sm ${off ? 'bg-red-900/60' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
        {track.kind === 'video' ? (track.hidden ? '🚫' : '👁') : (track.muted ? '🔇' : '🔊')}
      </button>
      <button onClick={onLock} title="Lock track" className={`w-7 h-7 rounded text-sm ${track.locked ? 'bg-amber-900/60' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
        {track.locked ? '🔒' : '🔓'}
      </button>
      <button onClick={onDelete} title="Delete track (must be empty)" className="w-7 h-7 rounded text-xs bg-zinc-800 hover:bg-red-900">✕</button>
      <span className="hidden">{height}</span>
    </div>
  )
}

// ================= ruler =================
function Ruler({ ticks, pxPerSec, duration, onSeek }: { ticks: number[]; pxPerSec: number; duration: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef(false)
  const seek = (clientX: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    onSeek(Math.min(duration, Math.max(0, (clientX - r.left) / pxPerSec)))
  }
  return (
    <div
      ref={ref}
      onPointerDown={e => { drag.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); seek(e.clientX) }}
      onPointerMove={e => { if (drag.current) seek(e.clientX) }}
      onPointerUp={() => { drag.current = false }}
      onPointerCancel={() => { drag.current = false }}
      className="absolute top-0 left-0 right-0 bg-zinc-900 border-b border-zinc-800 cursor-ew-resize select-none touch-none z-10"
      style={{ height: RULER_H }}
    >
      {ticks.map(t => (
        <div key={t} className="absolute top-0 bottom-0 border-l border-zinc-700/70" style={{ left: t * pxPerSec }}>
          <span className="text-[10px] font-mono text-zinc-400 ml-1">{fmtTC(t)}</span>
        </div>
      ))}
    </div>
  )
}

// ================= timeline clip (drag + trim) =================
function TimelineClip({ clip, pxPerSec, selected, locked, snap, project, transition, onSelect, onChange, onMoveTrack }: {
  clip: EditorClip; pxPerSec: number; selected: boolean; locked: boolean; snap: boolean
  project: EditorProject; transition?: { type: TransitionType; duration: number }
  onSelect: () => void; onChange: (p: Partial<EditorClip>) => void; onMoveTrack: (d: -1 | 1) => void
}) {
  const st = KIND_STYLE[clip.kind]
  // track lock or pinned clip: no move/trim until unlocked
  const isLocked = locked || clip.locked === true
  const drag = useRef<null | {
    mode: 'move' | 'l' | 'r'; startX: number; startY: number;
    origStart: number; origDuration: number; origOffset: number; trackSteps: number;
  }>(null)

  const edges = useMemo(() => {
    const s = new Set<number>([0])
    for (const c of project.clips) {
      if (c.id === clip.id) continue
      s.add(c.start); s.add(c.start + c.duration)
    }
    return [...s]
  }, [project.clips, clip.id])

  const doDrag = (e: PointerEvent, el: HTMLElement) => {
    const d = drag.current
    if (!d) return
    const dxSec = (e.clientX - d.startX) / pxPerSec
    if (d.mode === 'move') {
      let ns = Math.max(0, d.origStart + dxSec)
      if (snap) {
        for (const edge of edges) {
          if (Math.abs(ns - edge) * pxPerSec < 9) { ns = edge; break }
          if (Math.abs(ns + d.origDuration - edge) * pxPerSec < 9) { ns = edge - d.origDuration; break }
        }
      }
      // vertical track switching (same-kind tracks only)
      const steps = Math.round((e.clientY - d.startY) / 70)
      if (steps !== d.trackSteps) {
        d.trackSteps = steps
        if (steps !== 0) {
          onMoveTrack(steps > 0 ? 1 : -1)
          d.startY = e.clientY
          d.trackSteps = 0
        }
      }
      el.style.opacity = '0.85'
      onChange({ start: Math.max(0, ns) })
    } else if (d.mode === 'l') {
      const maxStart = d.origStart + d.origDuration - 0.2
      let ns = Math.min(maxStart, Math.max(0, d.origStart + dxSec))
      if (snap) {
        for (const edge of edges) {
          if (Math.abs(ns - edge) * pxPerSec < 9) { ns = Math.min(maxStart, edge); break }
        }
      }
      const delta = ns - d.origStart
      onChange({ start: ns, duration: d.origDuration - delta, offset: Math.max(0, d.origOffset + delta) })
    } else {
      onChange({ duration: Math.max(0.2, d.origDuration + dxSec) })
    }
  }

  const peaks = clip.payload.kind === 'audio' ? clip.payload.data.peaks : null
  const thumbUrl = clip.payload.kind === 'image'
    ? clip.payload.data.url
    : clip.payload.kind === 'avatar'
      ? (clip.payload.data.poseUrls[0] ?? null)
      : null

  return (
    <div
      onPointerDown={e => {
        if (isLocked) return
        e.stopPropagation()
        onSelect()
        drag.current = { mode: 'move', startX: e.clientX, startY: e.clientY, origStart: clip.start, origDuration: clip.duration, origOffset: clip.offset, trackSteps: 0 }
        const el = e.currentTarget as HTMLElement
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        const move = (ev: PointerEvent) => doDrag(ev, el)
        const up = () => {
          drag.current = null
          el.style.opacity = ''
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }}
      onDoubleClick={e => { e.stopPropagation(); onSelect() }}
      className={`absolute top-0 bottom-0 rounded-lg border-2 overflow-hidden cursor-grab active:cursor-grabbing select-none touch-none group ${selected ? 'border-white shadow-[0_0_0_2px_rgba(16,185,129,0.7)] z-10' : 'border-black/40'}`}
      style={{ left: clip.start * pxPerSec, width: Math.max(14, clip.duration * pxPerSec) }}
      title={`${clip.name} · ${fmtSec(clip.duration)} — drag to move, drag edges to trim`}
    >
      <div className={`absolute inset-0 ${st.bar}`} />
      {thumbUrl && <img src={thumbUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover opacity-50 pointer-events-none" />}
      {peaks && peaks.length > 0 && (
        <div className="absolute inset-x-1 inset-y-0 flex items-center gap-[1px] opacity-80 pointer-events-none">
          {peaks.filter((_, i) => i % 3 === 0).map((p, i) => (
            <div key={i} className="flex-1 bg-amber-200/90 rounded-sm" style={{ height: `${Math.max(8, p * 100)}%` }} />
          ))}
        </div>
      )}
      <div className="absolute inset-x-0 top-0 px-1.5 pt-0.5 flex items-center gap-1 pointer-events-none">
        <span className={`text-[9px] px-1 rounded font-bold text-white ${st.badge}`}>{clip.kind === 'whiteboard' ? 'SKETCH' : clip.kind.toUpperCase().slice(0, 6)}</span>
        {clip.locked && <span className="text-[9px] px-1 rounded font-bold bg-black/60 text-amber-300" title="Pinned — unlock in the Inspector to move or trim">🔒</span>}
        {clip.duration * pxPerSec > 110 && <span className="text-[11px] text-white/95 truncate font-medium">{clip.name}</span>}
      </div>
      <div className="absolute bottom-0.5 left-1.5 text-[10px] font-mono text-white/80 pointer-events-none">
        {clip.duration * pxPerSec > 60 ? fmtSec(clip.duration) : ''}
      </div>
      {/* incoming-transition wedge at the clip's head */}
      {transition && clip.kind !== 'audio' && (
        <div
          className="absolute left-0 top-0 bottom-0 pointer-events-none bg-gradient-to-r from-amber-300/90 via-amber-300/40 to-transparent border-r-2 border-amber-200/90"
          style={{ width: Math.max(6, Math.min(transition.duration, clip.duration) * pxPerSec) }}
          title={`Transition into this clip: ${TRANSITIONS.find(t => t.id === transition.type)?.label} ${transition.duration.toFixed(1)}s — edit in the Inspector`}
        >
          <span className="absolute left-0.5 top-0.5 text-[9px] font-bold text-amber-950">◣</span>
        </div>
      )}
      {/* trim handles */}
      {!isLocked && (
        <>
          <div
            onPointerDown={e => {
              e.stopPropagation()
              drag.current = { mode: 'l', startX: e.clientX, startY: e.clientY, origStart: clip.start, origDuration: clip.duration, origOffset: clip.offset, trackSteps: 0 }
              const root = (e.currentTarget as HTMLElement).parentElement as HTMLElement
              ;(e.target as Element).setPointerCapture?.(e.pointerId)
              const move = (ev: PointerEvent) => doDrag(ev, root)
              const up = () => {
                drag.current = null
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
                window.removeEventListener('pointercancel', up)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
              window.addEventListener('pointercancel', up)
            }}
            className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize bg-white/0 hover:bg-white/50 flex items-center justify-center"
            title="Trim start"
          >
            <div className="w-1 h-6 rounded bg-white/80 opacity-0 group-hover:opacity-100" />
          </div>
          <div
            onPointerDown={e => {
              e.stopPropagation()
              drag.current = { mode: 'r', startX: e.clientX, startY: e.clientY, origStart: clip.start, origDuration: clip.duration, origOffset: clip.offset, trackSteps: 0 }
              const root = (e.currentTarget as HTMLElement).parentElement as HTMLElement
              ;(e.target as Element).setPointerCapture?.(e.pointerId)
              const move = (ev: PointerEvent) => doDrag(ev, root)
              const up = () => {
                drag.current = null
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
                window.removeEventListener('pointercancel', up)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
              window.addEventListener('pointercancel', up)
            }}
            className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize bg-white/0 hover:bg-white/50 flex items-center justify-center"
            title="Trim end"
          >
            <div className="w-1 h-6 rounded bg-white/80 opacity-0 group-hover:opacity-100" />
          </div>
        </>
      )}
    </div>
  )
}

// ================= viewport transform box (Photoshop-style) =================
function TransformBox({ clip, containerRef, poseAspect, onPatch }: {
  clip: EditorClip
  containerRef: RefObject<HTMLDivElement>
  poseAspect: number | null // w/h of the avatar pose, if known
  onPatch: (p: Partial<EditorClip>) => void
}) {
  const [, setTick] = useState(0)
  const drag = useRef<null | {
    mode: 'move' | 'scale' | 'rotate'
    startX: number; startY: number
    origX: number; origY: number; origScale: number; origRot: number
    cx: number; cy: number; grabDist: number; grabAngle: number
  }>(null)

  // frame in canvas coords: pivot-anchored center, content-sized, rotated
  const P = contentPivot(clip)
  const xPx = (clip.x / 100) * (CANVAS_W / 2)
  const yPx = (clip.y / 100) * (CANVAS_H / 2)
  const cx = P.x + xPx
  const cy = P.y + yPx
  const rot = clip.rotation ?? 0
  let w = CANVAS_W
  let h = CANVAS_H
  if (clip.payload.kind === 'text') {
    const m = measureTextBlock(clip.payload.data)
    w = m.w
    h = m.h
  } else if (clip.payload.kind === 'avatar' && clip.payload.data.mode === 'present') {
    h = 340 * Math.max(0.2, clip.payload.data.avatarScale || 1)
    w = h * (poseAspect ?? 1)
  }
  const sw = Math.max(8, w * clip.scale)
  const sh = Math.max(8, h * clip.scale)

  const toCanvas = (clientX: number, clientY: number) => {
    const el = containerRef.current
    if (!el) return { x: cx, y: cy }
    const r = el.getBoundingClientRect()
    return {
      x: (clientX - r.left) * (CANVAS_W / Math.max(1, r.width)),
      y: (clientY - r.top) * (CANVAS_H / Math.max(1, r.height)),
    }
  }

  type PtEvent = { clientX: number; clientY: number; stopPropagation: () => void; preventDefault: () => void }
  const begin = (e: PtEvent, mode: 'move' | 'scale' | 'rotate') => {
    e.stopPropagation()
    e.preventDefault()
    const pt = toCanvas(e.clientX, e.clientY)
    drag.current = {
      mode,
      startX: pt.x, startY: pt.y,
      origX: clip.x, origY: clip.y, origScale: clip.scale, origRot: rot,
      cx, cy,
      grabDist: Math.hypot(pt.x - cx, pt.y - cy),
      grabAngle: (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI,
    }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      const el = containerRef.current
      if (!d || !el) return
      const r = el.getBoundingClientRect()
      const qx = (ev.clientX - r.left) * (CANVAS_W / Math.max(1, r.width))
      const qy = (ev.clientY - r.top) * (CANVAS_H / Math.max(1, r.height))
      if (d.mode === 'move') {
        onPatch({
          x: Math.round((d.origX + ((qx - d.startX) / (CANVAS_W / 2)) * 100) * 10) / 10,
          y: Math.round((d.origY + ((qy - d.startY) / (CANVAS_H / 2)) * 100) * 10) / 10,
        })
      } else if (d.mode === 'scale') {
        const dist = Math.hypot(qx - d.cx, qy - d.cy)
        const s = Math.min(5, Math.max(0.05, (d.origScale * dist) / Math.max(20, d.grabDist)))
        onPatch({ scale: Math.round(s * 100) / 100 })
      } else {
        const ang = (Math.atan2(qy - d.cy, qx - d.cx) * 180) / Math.PI
        let nr = ang - d.grabAngle + d.origRot
        if (ev.shiftKey) nr = Math.round(nr / 15) * 15
        nr = Math.round((((nr + 540) % 360) - 180) * 10) / 10
        onPatch({ rotation: nr })
      }
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const poseUrl = clip.payload.kind === 'avatar' ? clip.payload.data.poseUrls[0] : null
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  return (
    <>
      {/* re-render once the pose image loads so the box hugs it exactly */}
      {poseUrl && <img src={poseUrl} className="hidden" alt="" onLoad={() => setTick(t => t + 1)} />}
      <svg
        className="absolute inset-0 w-full h-full z-10 touch-none"
        viewBox="0 0 1920 1080"
        onPointerDown={e => e.stopPropagation()}
      >
        <g transform={`rotate(${rot} ${cx} ${cy})`}>
          <rect
            x={cx - sw / 2} y={cy - sh / 2} width={sw} height={sh}
            fill="rgba(16,185,129,0.07)" stroke="#10b981" strokeWidth={4}
            vectorEffect="non-scaling-stroke" style={{ cursor: 'move' }}
            onPointerDown={e => begin(e, 'move')}
          >
            <title>Drag to move (position −100…100%)</title>
          </rect>
          {corners.map(([sx, sy]) => (
            <rect
              key={`${sx}${sy}`}
              x={cx + ((sx * sw) / 2) - 16} y={cy + ((sy * sh) / 2) - 16} width={32} height={32}
              fill="#10b981" stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke"
              style={{ cursor: 'nwse-resize' }}
              onPointerDown={e => begin(e, 'scale')}
            >
              <title>Pull to scale (center stays put)</title>
            </rect>
          ))}
          <line x1={cx} y1={cy - sh / 2} x2={cx} y2={cy - sh / 2 - 80} stroke="#10b981" strokeWidth={4} vectorEffect="non-scaling-stroke" />
          <circle
            cx={cx} cy={cy - sh / 2 - 105} r={22}
            fill="#10b981" stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke"
            style={{ cursor: 'grab' }}
            onPointerDown={e => begin(e, 'rotate')}
          >
            <title>Drag to rotate (Shift = snap 15°)</title>
          </circle>
        </g>
      </svg>
    </>
  )
}

// ================= inspector =================
function Inspector({ clip, captionCount, transition, cutName, libraryPoseCount, showBox, onPatch, onDelete, onDuplicate, onMoveTrack, onFitSource, onApplyStyleToAll, onAddTransition, onReloadPoses, onRemoveTransition, onTransitionPatch, onToggleBox }: {
  clip: EditorClip
  captionCount: number
  transition?: { type: TransitionType; duration: number }
  cutName: string | null
  libraryPoseCount: number
  showBox: boolean
  onToggleBox: () => void
  onReloadPoses: () => void
  onPatch: (p: Partial<EditorClip>) => void
  onDelete: () => void
  onDuplicate: () => void
  onMoveTrack: (d: -1 | 1) => void
  onFitSource: () => void
  onApplyStyleToAll: () => void
  onAddTransition: (type: TransitionType) => void
  onRemoveTransition: () => void
  onTransitionPatch: (p: Partial<{ type: TransitionType; duration: number }>) => void
}) {
  const src = sourceDuration(clip)
  const setPayload = (fn: (p: EditorClip['payload']) => EditorClip['payload']) => {
    onPatch({ payload: fn(clip.payload) })
  }
  // Narrowed locals — TS drops `clip.payload` narrowing inside event-handler
  // closures, so each kind section works through these instead.
  const wb = clip.payload.kind === 'whiteboard' ? clip.payload.data : null
  const av = clip.payload.kind === 'avatar' ? clip.payload.data : null
  const sc = clip.payload.kind === 'showcase' ? clip.payload.data : null
  const vi = clip.payload.kind === 'video' || clip.payload.kind === 'image' ? clip.payload.data : null
  const im = clip.payload.kind === 'image' ? clip.payload.data : null
  const tx = clip.payload.kind === 'text' ? clip.payload.data : null
  return (
    <div className="space-y-4">
      <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2">
        <input
          value={clip.name} onChange={e => onPatch({ name: e.target.value })}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm font-semibold"
        />
        <div className="text-[11px] font-mono text-zinc-400">
          {KIND_STYLE[clip.kind].icon} {clip.kind} · source {fmtSec(src)}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <NumField label="Start" value={clip.start} step={0.1} min={0} onChange={v => onPatch({ start: Math.max(0, v) })} />
          <NumField label="Length" value={clip.duration} step={0.1} min={0.2} onChange={v => onPatch({ duration: Math.max(0.2, v) })} />
          <NumField label="Offset" value={clip.offset} step={0.1} min={0} onChange={v => onPatch({ offset: Math.max(0, v) })} />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button onClick={onFitSource} className="px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Set clip length to the full source duration">Fit to source</button>
          <div className="grid grid-cols-4 gap-1">
            <button onClick={() => onMoveTrack(-1)} className="py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Move to track above">▲</button>
            <button onClick={() => onMoveTrack(1)} className="py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Move to track below">▼</button>
            <button onClick={onDuplicate} className="py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Duplicate">⧉</button>
            <button
              onClick={() => onPatch({ locked: !(clip.locked === true) })}
              className={`py-1.5 text-xs rounded-lg border ${clip.locked ? 'bg-amber-600 border-amber-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
              title={clip.locked ? 'Pinned — click to unlock (move/trim)' : 'Pin in place (lock move/trim)'}
            >
              {clip.locked ? '🔒' : '🔓'}
            </button>
          </div>
        </div>
        <button onClick={onDelete} className="w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-red-900 border border-zinc-700">🗑 Remove clip</button>
      </div>

      {/* transform + mix */}
      <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Transform & mix</h3>
          {clip.kind !== 'audio' && (
            <button
              onClick={onToggleBox}
              className={`px-2 py-1 text-[11px] rounded-lg border ${showBox ? 'bg-emerald-600 border-emerald-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
              title="Photoshop-style transform box in the viewport: drag to move, pull corners to scale, top handle rotates"
            >
              ⛶ Box {showBox ? 'on' : 'off'}
            </button>
          )}
        </div>
        {clip.kind !== 'audio' && (
          <>
            <Slider label="Opacity" value={clip.opacity} min={0} max={1} step={0.01} fmt={v => `${Math.round(v * 100)}%`} onChange={v => onPatch({ opacity: v })} />
            <Slider label="Scale" value={clip.scale} min={0.05} max={5} step={0.01} fmt={v => `${Math.round(v * 100)}%`} onChange={v => onPatch({ scale: v })} />
            <Slider label="Position X" value={clip.x} min={-100} max={100} step={1} fmt={v => `${Math.round(v)}%`} onChange={v => onPatch({ x: v })} />
            <Slider label="Position Y" value={clip.y} min={-100} max={100} step={1} fmt={v => `${Math.round(v)}%`} onChange={v => onPatch({ y: v })} />
            <Slider label="Rotation" value={clip.rotation ?? 0} min={-180} max={180} step={1} fmt={v => `${Math.round(v)}°`} onChange={v => onPatch({ rotation: v })} />
          </>
        )}
        {(clip.kind === 'audio' || clip.kind === 'video') && (
          <>
            <Slider label="Volume" value={clip.volume} min={0} max={1.5} step={0.01} fmt={v => `${Math.round(v * 100)}%`} onChange={v => onPatch({ volume: v })} />
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={clip.muted} onChange={e => onPatch({ muted: e.target.checked })} className="accent-emerald-500" /> Mute clip
            </label>
          </>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Slider label="Fade in" value={clip.fadeIn} min={0} max={3} step={0.1} fmt={v => `${v.toFixed(1)}s`} onChange={v => onPatch({ fadeIn: v })} />
          <Slider label="Fade out" value={clip.fadeOut} min={0} max={3} step={0.1} fmt={v => `${v.toFixed(1)}s`} onChange={v => onPatch({ fadeOut: v })} />
        </div>
      </div>

      {/* motion: entrance / exit animation */}
      {clip.kind !== 'audio' && (
        <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">🎞 Motion</h3>
          <div>
            <div className="text-xs text-zinc-300 mb-1.5">Entrance</div>
            <div className="grid grid-cols-4 gap-1">
              {MOTIONS.map(m => (
                <button
                  key={m.id}
                  onClick={() => onPatch({ animIn: m.id })}
                  className={`px-1 py-1.5 text-xs rounded-lg border ${clip.animIn === m.id ? 'bg-emerald-600 border-emerald-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                  title={m.title}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {clip.animIn !== 'none' && (
              <Slider label="Entrance length" value={clip.animInDur} min={0.2} max={3} step={0.1} fmt={v => `${v.toFixed(1)}s`} onChange={v => onPatch({ animInDur: v })} />
            )}
          </div>
          <div>
            <div className="text-xs text-zinc-300 mb-1.5">Exit</div>
            <div className="grid grid-cols-4 gap-1">
              {MOTIONS.map(m => (
                <button
                  key={m.id}
                  onClick={() => onPatch({ animOut: m.id })}
                  className={`px-1 py-1.5 text-xs rounded-lg border ${clip.animOut === m.id ? 'bg-emerald-600 border-emerald-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                  title={m.title}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {clip.animOut !== 'none' && (
              <Slider label="Exit length" value={clip.animOutDur} min={0.2} max={3} step={0.1} fmt={v => `${v.toFixed(1)}s`} onChange={v => onPatch({ animOutDur: v })} />
            )}
          </div>
        </div>
      )}

      {/* incoming transition at this clip's head */}
      {clip.kind !== 'audio' && (
        <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/50 space-y-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-amber-300/90">🔀 Transition in</h3>
          {transition ? (
            <>
              <div className="grid grid-cols-2 gap-1">
                {TRANSITIONS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => onTransitionPatch({ type: t.id })}
                    className={`px-2 py-1.5 text-xs rounded-lg border ${transition.type === t.id ? 'bg-amber-500 border-amber-400 text-black font-semibold' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                    title={t.title}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <Slider label="Duration" value={transition.duration} min={0.2} max={Math.max(0.3, clip.duration)} step={0.1} fmt={v => `${v.toFixed(1)}s`} onChange={v => onTransitionPatch({ duration: v })} />
              <p className="text-[11px] text-zinc-400">Plays over the first {transition.duration.toFixed(1)}s{cutName ? <>, melting <span className="text-zinc-200">{cutName}</span> into this clip</> : ''}.</p>
              <button onClick={onRemoveTransition} className="w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-red-900 border border-zinc-700">Remove transition</button>
            </>
          ) : cutName ? (
            <>
              <p className="text-[11px] text-zinc-400 leading-relaxed">Cut from <span className="text-zinc-200">{cutName}</span> — pick a transition into this clip:</p>
              <div className="grid grid-cols-2 gap-1">
                {TRANSITIONS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => onAddTransition(t.id)}
                    className="px-2 py-1.5 text-xs rounded-lg border bg-zinc-800 border-zinc-700 hover:bg-zinc-700"
                    title={t.title}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[11px] text-zinc-500 leading-relaxed">No adjacent clip before this one — butt it against another clip on this track to unlock transitions.</p>
          )}
        </div>
      )}

      {/* avatar host — full settings panel, everything applies live */}
      {av && (
        <div className="p-3 rounded-xl bg-cyan-950/40 border border-cyan-800/50 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">🧍 Host avatar</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300 font-bold" title="Every change renders instantly in the preview">● LIVE</span>
          </div>

          <div>
            <div className="text-xs text-zinc-300 mb-1.5">Behavior</div>
            <div className="grid grid-cols-2 gap-1">
              {(['present', 'popup'] as AvatarMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, mode: m } } : p)}
                  className={`px-2 py-1.5 text-xs rounded-lg border ${av.mode === m ? 'bg-cyan-600 border-cyan-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                  title={m === 'present' ? 'Stays on screen for the whole clip' : 'Pops up at random spots and times'}
                >
                  {m === 'present' ? '🧍 Present' : '💥 Pop-ups'}
                </button>
              ))}
            </div>
          </div>

          {av.mode === 'popup' ? (
            <div className="space-y-2.5">
              <div>
                <div className="text-xs text-zinc-300 mb-1.5">Pop-up style</div>
                <div className="grid grid-cols-4 gap-1">
                  {(['mixed', 'pop', 'fade', 'slide'] as AvatarPopStyle[]).map(s => (
                    <button
                      key={s}
                      onClick={() => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, popStyle: s } } : p)}
                      className={`px-1 py-1.5 text-xs rounded-lg border capitalize ${(av.popStyle ?? 'mixed') === s ? 'bg-cyan-600 border-cyan-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                      title={s === 'mixed' ? 'Random style per appearance' : `${s} entrance every time`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <Slider label="Appearances" value={av.popCount} min={1} max={10} step={1} fmt={v => `${Math.round(v)}×`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, popCount: Math.round(v) } } : p)} />
              <Slider label="Hold length" value={av.holdMul ?? 1} min={0.5} max={2} step={0.1} fmt={v => `${v.toFixed(1)}×`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, holdMul: v } } : p)} />
              <Slider label="Pop / fade length" value={av.fadeDur} min={0.1} max={1} step={0.05} fmt={v => `${v.toFixed(2)}s`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, fadeDur: v } } : p)} />
            </div>
          ) : (
            <Slider label="Pose cycle" value={av.poseInterval} min={0} max={6} step={0.5} fmt={v => (v < 0.1 ? 'fixed pose' : `${v.toFixed(1)}s`)} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, poseInterval: v } } : p)} />
          )}

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-1.5">Transform</div>
            <div className="space-y-2.5">
              <Slider label="Size" value={av.avatarScale} min={0.4} max={1.6} step={0.05} fmt={v => `${Math.round(v * 100)}%`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, avatarScale: v } } : p)} />
              <Slider label="Offset X" value={av.offX ?? 0} min={-480} max={480} step={5} fmt={v => `${Math.round(v)}px`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, offX: v } } : p)} />
              <Slider label="Offset Y" value={av.offY ?? 0} min={-270} max={270} step={5} fmt={v => `${Math.round(v)}px`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, offY: v } } : p)} />
              <Slider label="Rotation" value={av.rot ?? 0} min={-180} max={180} step={1} fmt={v => `${Math.round(v)}°`} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, rot: v } } : p)} />
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, flip: !p.data.flip } } : p)}
                  className={`px-2 py-1.5 text-xs rounded-lg border ${av.flip ? 'bg-cyan-600 border-cyan-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                  title="Mirror horizontally"
                >
                  {av.flip ? '✓ ' : ''}🪞 Mirror
                </button>
                <button
                  onClick={() => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, shadow: !(p.data.shadow ?? true) } } : p)}
                  className={`px-2 py-1.5 text-xs rounded-lg border ${(av.shadow ?? true) ? 'bg-cyan-600 border-cyan-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                  title="Soft drop shadow"
                >
                  {(av.shadow ?? true) ? '✓ ' : ''}🌑 Shadow
                </button>
              </div>
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-300 mb-1.5">Corners</div>
            <div className="grid grid-cols-5 gap-1">
              {(['random', 'BL', 'BR', 'TL', 'TR'] as AvatarCorner[]).map(c => (
                <button
                  key={c}
                  onClick={() => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, corner: c } } : p)}
                  className={`px-1 py-1.5 text-[11px] rounded-lg border ${av.corner === c ? 'bg-cyan-600 border-cyan-500' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'}`}
                  title={c === 'random' ? 'Random corners' : c === 'BL' ? 'Bottom left' : c === 'BR' ? 'Bottom right' : c === 'TL' ? 'Top left' : 'Top right'}
                >
                  {c === 'random' ? '🎲' : c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-1.5">Dynamics · speed</div>
            <div className="space-y-2.5">
              <Slider label="Wander / bounce" value={av.wander} min={0} max={1} step={0.05} fmt={v => (v <= 0 ? 'still' : `${Math.round(v * 100)}%`)} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, wander: v } } : p)} />
              <Slider label="Motion speed" value={av.animSpeed ?? 1} min={0} max={2} step={0.05} fmt={v => (v < 0.01 ? 'frozen' : `${v.toFixed(2)}×`)} onChange={v => setPayload(p => p.kind === 'avatar' ? { ...p, data: { ...p.data, animSpeed: v } } : p)} />
              <p className="text-[11px] text-zinc-500">Tip: Wander 0% or speed frozen = no motion at all.</p>
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-1.5">Poses</div>
            <div className="text-[11px] text-zinc-400 mb-1.5">{av.poseUrls.length} pose{av.poseUrls.length === 1 ? '' : 's'} in this clip · {libraryPoseCount} in library</div>
            <button onClick={onReloadPoses} className="w-full px-2 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" title="Replace this clip's poses with the current library">
              🔄 Use current library poses
            </button>
          </div>
        </div>
      )}

      {/* kind-specific live editing */}
      {wb && (
        <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-800/50 space-y-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-indigo-300">✏️ Sketch — live edit</h3>
          <div className="flex items-center gap-2 text-xs">
            <span>Ink</span>
            <input type="color" value={wb.settings.strokeColor} onChange={e => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, strokeColor: e.target.value } } } : p)} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
            <span className="ml-1">Paper</span>
            <input type="color" value={wb.settings.paperColor} onChange={e => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, paperColor: e.target.value } } } : p)} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
          </div>
          <Slider label="Line width" value={wb.settings.lineWidth} min={2} max={22} step={0.5} fmt={v => `${v.toFixed(1)}px`} onChange={v => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, lineWidth: v } } } : p)} />
          <div className="grid grid-cols-3 gap-1">
            {(['marker', 'pencil', 'brush'] as BrushType[]).map(b => (
              <button
                key={b}
                onClick={() => setPayload(p => {
                  if (p.kind !== 'whiteboard') return p
                  const presets: Record<BrushType, { softness: number; grain: number; taper: number }> = {
                    marker: { softness: 0.05, grain: 0, taper: 0 },
                    pencil: { softness: 0.35, grain: 0.65, taper: 0.5 },
                    brush: { softness: 0.8, grain: 0.3, taper: 0.85 },
                  }
                  return { ...p, data: { ...p.data, settings: { ...p.data.settings, brushType: b, ...presets[b] } } }
                })}
                className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${wb.settings.brushType === b ? 'bg-indigo-600 border-indigo-500' : 'bg-zinc-800 border-zinc-700'}`}
              >
                {b}
              </button>
            ))}
          </div>
          <Slider label="Sketch length" value={wb.settings.duration} min={1} max={30} step={0.5} fmt={v => `${v.toFixed(1)}s`} onChange={v => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, duration: v } } } : p)} />
          <label className="flex items-center gap-2 text-xs text-zinc-200">
            <input type="checkbox" checked={wb.settings.revealPhoto} onChange={e => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, revealPhoto: e.target.checked } } } : p)} className="accent-indigo-500" />
            Photo finish {wb.revealImg ? '' : '(no photo in this scene)'}
          </label>
          {wb.settings.revealPhoto && (
            <Slider label="Reveal length" value={wb.settings.revealDuration} min={0.5} max={6} step={0.5} fmt={v => `${v.toFixed(1)}s`} onChange={v => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, revealDuration: v } } } : p)} />
          )}
          <label className="flex items-center gap-2 text-xs text-zinc-200">
            <input type="checkbox" checked={wb.settings.showHand} onChange={e => setPayload(p => p.kind === 'whiteboard' ? { ...p, data: { ...p.data, settings: { ...p.data.settings, showHand: e.target.checked } } } : p)} className="accent-indigo-500" />
            Show drawing hand
          </label>
          <p className="text-[11px] text-zinc-400">Strokes: {wb.strokes.length} · {wb.sourceName}</p>
        </div>
      )}

      {sc && (
        <div className="p-3 rounded-xl bg-fuchsia-950/40 border border-fuchsia-800/50 space-y-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-fuchsia-300">🖼️ Slideshow — live edit</h3>
          <Slider label="Full-size hold" value={sc.hold} min={1} max={8} step={0.5} fmt={v => `${v.toFixed(1)}s`} onChange={v => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, hold: v } } : p)} />
          <Slider label="Dock move" value={sc.trans} min={0.4} max={2} step={0.1} fmt={v => `${v.toFixed(1)}s`} onChange={v => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, trans: v } } : p)} />
          <div className="grid grid-cols-3 gap-1">
            {(['dock', 'grid', 'scatter'] as const).map(l => (
              <button key={l} onClick={() => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, lineup: { ...p.data.lineup, layout: l } } } : p)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${sc.lineup.layout === l ? 'bg-fuchsia-600 border-fuchsia-500' : 'bg-zinc-800 border-zinc-700'}`}>{l}</button>
            ))}
          </div>
          <Slider label="Tile size" value={sc.lineup.tileSize} min={80} max={320} step={5} fmt={v => `${Math.round(v)}px`} onChange={v => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, lineup: { ...p.data.lineup, tileSize: v } } } : p)} />
          <Slider label="Corner radius" value={sc.tileStyle.radius} min={0} max={200} step={1} fmt={v => `${Math.round(v)}px`} onChange={v => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, tileStyle: { ...p.data.tileStyle, radius: v } } } : p)} />
          <label className="flex items-center gap-2 text-xs text-zinc-200">
            <input type="checkbox" checked={sc.sketchOptions.enabled} onChange={e => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, sketchOptions: { ...p.data.sketchOptions, enabled: e.target.checked } } } : p)} className="accent-fuchsia-500" />
            ✏️ Sketch intro {sc.sketchEntries.size ? `(${sc.sketchEntries.size}/${sc.items.length} ready)` : '(no vectors — enable it in the Showcase tab first)'}
          </label>
          {sc.sketchOptions.enabled && (
            <Slider label="Sketch time" value={sc.sketchOptions.duration} min={1} max={8} step={0.5} fmt={v => `${v.toFixed(1)}s`} onChange={v => setPayload(p => p.kind === 'showcase' ? { ...p, data: { ...p.data, sketchOptions: { ...p.data.sketchOptions, duration: v } } } : p)} />
          )}
          <p className="text-[11px] text-zinc-400">Images: {sc.items.length} — reorder in the Showcase tab, then re-add. Tip: use “Fit to source” after changing hold/sketch.</p>
        </div>
      )}

      {vi && (
        <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Framing</h3>
          <div className="grid grid-cols-3 gap-1">
            {(['contain', 'cover', 'stretch'] as const).map(f => (
              <button
                key={f}
                onClick={() => setPayload(p => {
                  if (p.kind === 'video') return { ...p, data: { ...p.data, fit: f } }
                  if (p.kind === 'image') return { ...p, data: { ...p.data, fit: f } }
                  return p
                })}
                className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${vi.fit === f ? 'bg-emerald-600 border-emerald-500' : 'bg-zinc-800 border-zinc-700'}`}
              >
                {f}
              </button>
            ))}
          </div>
          {im && (
            <label className="flex items-center gap-2 text-xs text-zinc-200">
              <input type="checkbox" checked={im.kenBurns} onChange={e => setPayload(p => p.kind === 'image' ? { ...p, data: { ...p.data, kenBurns: e.target.checked } } : p)} className="accent-emerald-500" />
              Slow Ken Burns zoom
            </label>
          )}
        </div>
      )}

      {tx && (
        <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/50 space-y-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-rose-300">🔤 Title text</h3>
          <textarea
            value={tx.text} onChange={e => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, text: e.target.value } } : p)}
            rows={2} className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm"
          />
          <div className="grid grid-cols-3 gap-1">
            {(['title', 'lower', 'caption'] as TextPreset[]).map(p => (
              <button key={p} onClick={() => setPayload(x => x.kind === 'text' ? { ...x, data: { ...x.data, preset: p } } : x)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${tx.preset === p ? 'bg-rose-600 border-rose-500' : 'bg-zinc-800 border-zinc-700'}`}>{p === 'lower' ? 'Lower' : p}</button>
            ))}
          </div>
          <Slider label="Font size" value={tx.fontSize} min={20} max={200} step={2} fmt={v => `${Math.round(v)}px`} onChange={v => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, fontSize: v } } : p)} />
          <div className="flex items-center gap-2 text-xs">
            <span>Color</span>
            <input type="color" value={tx.color} onChange={e => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, color: e.target.value } } : p)} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
            <select value={tx.fontFamily} onChange={e => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, fontFamily: e.target.value } } : p)} className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-1.5 py-1.5 text-xs">
              <option value="Inter, system-ui, sans-serif">Inter</option>
              <option value="Georgia, serif">Georgia</option>
              <option value="'Courier New', monospace">Courier</option>
              <option value="Impact, sans-serif">Impact</option>
            </select>
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1.5">Animation</div>
            <div className="grid grid-cols-4 gap-1">
              {(['none', 'fade', 'pop', 'karaoke'] as CaptionAnim[]).map(a => (
                <button key={a} onClick={() => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, anim: a } } : p)} className={`px-2 py-1.5 text-xs rounded-lg border capitalize ${(tx.anim ?? 'none') === a ? 'bg-rose-600 border-rose-500' : 'bg-zinc-800 border-zinc-700'}`}>{a}</button>
              ))}
            </div>
          </div>
          {(tx.anim ?? 'none') === 'karaoke' && (
            <div className="flex items-center gap-2 text-xs">
              <span>Spoken highlight</span>
              <input type="color" value={tx.hiColor ?? '#fde047'} onChange={e => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, hiColor: e.target.value } } : p)} className="w-9 h-7 rounded bg-transparent cursor-pointer" />
            </div>
          )}
          <Slider label="Screen position" value={tx.posY ?? (tx.preset === 'lower' ? 0.78 : tx.preset === 'caption' ? 0.88 : 0.5)} min={0.08} max={0.94} step={0.01} fmt={v => (v < 0.3 ? 'top' : v > 0.7 ? 'bottom' : 'center')} onChange={v => setPayload(p => p.kind === 'text' ? { ...p, data: { ...p.data, posY: v } } : p)} />
          {tx.preset === 'caption' && captionCount > 1 && (
            <div className="p-2.5 rounded-lg bg-zinc-900/70 border border-dashed border-zinc-600">
              <div className="text-[11px] text-zinc-400 mb-1.5">Bulk edit — {captionCount} captions on the timeline</div>
              <button onClick={onApplyStyleToAll} className="w-full px-2 py-1.5 text-xs rounded-lg bg-violet-700 hover:bg-violet-600 font-medium" title="Copy this caption's font, colors, animation and position onto every caption clip">
                ✨ Apply this style to all captions
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1"><span className="text-zinc-300">{label}</span><span className="font-mono text-zinc-400">{fmt(value)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} className="w-full" />
    </div>
  )
}

function NumField({ label, value, step, min, onChange }: { label: string; value: number; step: number; min: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <input
        type="number" value={Number(value.toFixed(2))} step={step} min={min}
        onChange={e => onChange(+e.target.value)}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-1.5 py-1 text-xs font-mono"
      />
    </label>
  )
}

// ================= probes & clone =================
function probeVideo(url: string): Promise<{ duration: number; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => resolve({ duration: v.duration || 5, w: v.videoWidth || 1920, h: v.videoHeight || 1080 })
    v.onerror = () => reject(new Error('video unreadable'))
    v.src = url
  })
}

function probeImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('image unreadable'))
    img.src = url
  })
}

function probeAudio(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(a.duration || 10)
    a.onerror = () => reject(new Error('audio unreadable'))
    a.src = url
  })
}

/**
 * Clone a clip payload for split/duplicate. Image/video elements are live
 * references — they must be kept by reference (they are not cloneable),
 * while strokes/settings/options are deep-copied so clips edit independently.
 */
function cloneClipPayload(p: EditorClip['payload']): EditorClip['payload'] {
  switch (p.kind) {
    case 'whiteboard':
      return {
        ...p,
        data: {
          ...p.data,
          strokes: cloneStrokes(p.data.strokes),
          settings: { ...p.data.settings },
          revealRect: p.data.revealRect ? { ...p.data.revealRect } : null,
        },
      }
    case 'showcase':
      return {
        ...p,
        data: {
          ...p.data,
          items: [...p.data.items],
          lineup: { ...p.data.lineup },
          tileStyle: { ...p.data.tileStyle },
          sketchOptions: { ...p.data.sketchOptions },
          // sketch vectors are an immutable detection snapshot — shared by ref
        },
      }
    case 'audio':
      return { ...p, data: { ...p.data, peaks: [...p.data.peaks] } }
    case 'avatar':
      return { ...p, data: { ...p.data, poseUrls: [...p.data.poseUrls] } }
    case 'video':
      return { ...p, data: { ...p.data } }
    case 'image':
      return { ...p, data: { ...p.data } }
    case 'text':
      return { ...p, data: { ...p.data } }
  }
}
