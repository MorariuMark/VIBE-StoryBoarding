import { useRef } from 'react'

export type AppMode = 'whiteboard' | 'showcase' | 'editor'

const MODE_META: Record<AppMode, { label: string; title: string }> = {
  whiteboard: { label: '✏️ Whiteboard', title: 'Hand-drawn whiteboard animation' },
  showcase: { label: '🖼️ Showcase', title: 'Multi-image showcase slideshow' },
  editor: { label: '🎬 Editor', title: 'Multi-track video editor — scenes stay editable' },
}

export function ModeTabs({ mode, onMode }: { mode: AppMode; onMode: (m: AppMode) => void }) {
  return (
    <div className="flex rounded-lg bg-zinc-800 border border-zinc-700 p-0.5 gap-0.5">
      {(['whiteboard', 'showcase', 'editor'] as AppMode[]).map(m => (
        <button
          key={m}
          onClick={() => onMode(m)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition ${mode === m ? 'bg-indigo-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'}`}
          title={MODE_META[m].title}
        >
          {MODE_META[m].label}
        </button>
      ))}
    </div>
  )
}

export function ScrubBar({ value, max, revealStart, resolveStart, onSeek }: { value: number; max: number; revealStart: number | null; resolveStart?: number | null; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const revealFrac = revealStart !== null && max > 0 ? revealStart / max : 1
  const resolveFrac = resolveStart !== null && resolveStart !== undefined && max > 0 ? resolveStart / max : 1

  const seekFromClientX = (clientX: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    onSeek(Math.min(max, Math.max(0, ((clientX - r.left) / r.width) * max)))
  }

  return (
    <div
      ref={ref}
      onPointerDown={e => { dragging.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); seekFromClientX(e.clientX) }}
      onPointerMove={e => { if (dragging.current) seekFromClientX(e.clientX) }}
      onPointerUp={() => { dragging.current = false }}
      onPointerCancel={() => { dragging.current = false }}
      className="relative h-7 rounded-lg bg-zinc-800 border border-zinc-700 cursor-pointer overflow-hidden select-none touch-none"
      title="Scrub the timeline"
    >
      {/* coloring zone */}
      {revealStart !== null && (
        <div className="absolute inset-y-0 right-0 bg-amber-400/15 border-l border-amber-400/50" style={{ left: `${revealFrac * 100}%` }} />
      )}
      {/* photo-resolve zone */}
      {resolveStart !== null && resolveStart !== undefined && (
        <div className="absolute inset-y-0 right-0 bg-emerald-400/20 border-l border-emerald-400/60" style={{ left: `${resolveFrac * 100}%` }} />
      )}
      {/* played fill */}
      <div className="absolute inset-y-0 left-0 bg-indigo-600/80" style={{ width: `${frac * 100}%` }} />
      {/* reveal-start tick */}
      {revealStart !== null && (
        <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${revealFrac * 100}%` }} />
      )}
      {/* resolve-start tick */}
      {resolveStart !== null && resolveStart !== undefined && (
        <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${resolveFrac * 100}%` }} />
      )}
      {/* playhead */}
      <div className="absolute inset-y-0 flex items-center" style={{ left: `calc(${frac * 100}% - 7px)` }}>
        <div className="w-3.5 h-3.5 rounded-full bg-white shadow border border-indigo-300" />
      </div>
    </div>
  )
}
