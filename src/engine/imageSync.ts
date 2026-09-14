/**
 * Image ↔ voiceover auto-sync.
 *
 * Images in the bin are named with the script wording they illustrate
 * (e.g. "The start of the french revolution happened...jpg"). This module
 * fuzzy-matches each image name to a voiceover sentence, then derives the
 * timeline span each image should cover:
 *
 *   image k shows from its segment start until its last `trailingWords`
 *   are being spoken — the transition into image k+1 plays over those
 *   final words, and the next image lands right after.
 *
 * Works for both voiceover backends: Kokoro TTS yields exact per-sentence
 * spans, and Audio8 chunks map 1:1 onto sentences (VoiceoverWindow builds
 * them that way). Recorded/uploaded audio uses STT segment spans via the
 * same `{ text, start, end }` shape.
 */

export interface TimedText {
  text: string
  start: number
  end: number
}

export interface WordSpan {
  word: string
  start: number
  end: number
}

export interface SyncOptions {
  /** words at the end of each segment covered by the transition (default 3) */
  trailingWords?: number
}

/** Lowercase, strip extension, kill punctuation — keep word tokens. */
export function normalizeText(s: string): string {
  return s
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip filename noise: extension, "image 12:" / "03 -" prefixes, counters. */
function stripNameNoise(s: string): string {
  return s
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .replace(/^\s*(image|img|pic|picture|slide|scene|frame|shot|photo)\s*\d*\s*[:\-–_.]*/i, ' ')
    .replace(/^\s*\d+\s*[:\-–_.)\]]\s*/, ' ')
    .replace(/^\s*\d+\s+/, ' ')
    .replace(/\(\d+\)|\[\d+\]/g, ' ')
    .replace(/["“”']/g, ' ')
}

function tokens(s: string): string[] {
  const n = normalizeText(stripNameNoise(s))
  return n ? n.split(' ') : []
}

/** Token equality with typo tolerance (one slip in long words still hits). */
function tokenEq(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (la < 5 || lb < 5 || Math.abs(la - lb) > 1) return false
  let diffs = 0
  let i = 0
  let j = 0
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++diffs > 1) return false
    if (la === lb) { i++; j++ }
    else if (la > lb) i++
    else j++
  }
  return diffs + (la - i) + (lb - j) <= 1
}

/** Token weight: beginnings + endings count 3×, middle 1×. */
function tokenWeights(len: number): number[] {
  const w: number[] = []
  for (let i = 0; i < len; i++) {
    w.push(1 + (i < 3 ? 2 : 0) + (i >= len - 3 ? 2 : 0))
  }
  return w
}

/** Normalize one word for comparison. */
function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export interface PhraseAlign {
  score: number
  /** target-word indices matched in order (may be empty) */
  matched: number[]
  first: number
  last: number
}

/**
 * Ends-weighted ordered alignment of a filename against sentence words.
 * Missing middle words cost little; missing opening/closing words cost
 * most; one typo per long word tolerated.
 */
export function alignPhrase(query: string, targetWords: string[]): PhraseAlign {
  const q = tokens(query)
  const t = targetWords.map(normWord)
  if (!q.length || !t.length) return { score: 0, matched: [], first: 0, last: Math.max(0, t.length - 1) }
  const w = tokenWeights(q.length)
  const total = w.reduce((a, b) => a + b, 0)
  const matched: number[] = []
  let qi = 0
  let orderedW = 0
  t.forEach((word, ti) => {
    if (qi < q.length && tokenEq(word, normWord(q[qi]))) {
      orderedW += w[qi]
      matched.push(ti)
      qi++
    }
  })
  let bagW = 0
  q.forEach((word, i) => {
    const nw = normWord(word)
    if (t.some(x => tokenEq(x, nw))) bagW += w[i]
  })
  return {
    score: (0.65 * orderedW + 0.35 * bagW) / total,
    matched,
    first: matched.length ? matched[0] : 0,
    last: matched.length ? matched[matched.length - 1] : t.length - 1,
  }
}

/**
 * Ends-weighted ordered overlap: fraction of weighted `query` tokens found
 * in `target` in order. Missing middle words cost little; missing the
 * opening or closing words cost most.
 */
export function overlapScore(query: string, target: string): number {
  return alignPhrase(query, target.split(/\s+/).filter(Boolean)).score
}

export interface WordAnchor {
  /** VO-relative time the first filename word is spoken (image shows) */
  showAt: number
  /** VO-relative time the last ~4 filename words begin (image docks) */
  dockAt: number
  score: number
  matched: boolean
}

/**
 * Word-level anchoring: show the visual when the caption reaches the
 * first filename word, dock it when the last 3–4 filename words begin.
 * Word times are char-weighted inside the known sentence span — the same
 * estimator captions use, so visuals agree with caption cues.
 */
export function anchorPhrase(
  query: string,
  segText: string,
  segStart: number,
  segEnd: number,
  threshold = 0.3,
): WordAnchor {
  const words = segText.split(/\s+/).filter(Boolean)
  const wt = wordTimings(segText, segStart, segEnd)
  const fallback: WordAnchor = { showAt: segStart, dockAt: segEnd, score: 0, matched: false }
  if (!words.length || !wt.length || wt.length !== words.length) return fallback
  const al = alignPhrase(query, words)
  if (!al.matched.length || al.score < threshold) return { ...fallback, score: al.score }
  // dock window = start of the last 4 matched words
  const tailIdx = al.matched[Math.max(0, al.matched.length - 4)]
  return {
    showAt: wt[al.first].start,
    dockAt: Math.max(wt[al.first].start + 0.2, wt[tailIdx].start),
    score: al.score,
    matched: true,
  }
}

export interface SegMatch {
  segIndex: number
  score: number
  matched: boolean
}

/**
 * Anchor + interpolate match. Strong hits (score ≥ anchorThreshold) pin
 * as ordered anchors — even out of sequence. The rest interpolate between
 * surrounding anchors or backfill positionally, so every image lands on a
 * monotonic, gap-free segment chain no matter the filename chaos.
 */
export function matchImagesToSegments(
  imageNames: string[],
  segments: TimedText[],
  threshold = 0.3,
  anchorThreshold = 0.55,
): SegMatch[] {
  const n = imageNames.length
  const m = segments.length
  const out: SegMatch[] = imageNames.map(() => ({ segIndex: 0, score: 0, matched: false }))
  if (!n || !m) return out
  if (m === 1) {
    return out.map((o, i) => ({ ...o, segIndex: 0, matched: i === 0 }))
  }
  // pass 1: global best segment per image (full search — order-free)
  const best: { seg: number; score: number }[] = imageNames.map(name => {
    let seg = 0
    let score = 0
    for (let s = 0; s < m; s++) {
      const sc = overlapScore(name, segments[s].text)
      if (sc > score + 1e-9) {
        score = sc
        seg = s
      }
    }
    return { seg, score }
  })
  // pass 2: anchors as a max-weight increasing chain (DP) — out-of-order
  // strong hits no longer block each other; the best ordered subset wins
  const anchorAt = new Array<number>(n).fill(-1)
  const cand = best
    .map((b, i) => ({ ...b, i }))
    .filter(b => b.score >= anchorThreshold)
  const dp = cand.map(c => c.score)
  const prev = new Array<number>(cand.length).fill(-1)
  for (let a = 1; a < cand.length; a++) {
    for (let b = 0; b < a; b++) {
      if (cand[b].seg < cand[a].seg && dp[b] + cand[a].score > dp[a] + 1e-9) {
        dp[a] = dp[b] + cand[a].score
        prev[a] = b
      }
    }
  }
  let top = 0
  for (let a = 1; a < cand.length; a++) if (dp[a] > dp[top]) top = a
  if (cand.length && dp[top] > 0) {
    for (let a = top; a >= 0; a = prev[a]) {
      anchorAt[cand[a].i] = cand[a].seg
      if (prev[a] < 0) break
    }
  }
  // pass 3: fill gaps by interpolation / positional backfill
  for (let i = 0; i < n; i++) {
    if (anchorAt[i] >= 0) {
      out[i] = { segIndex: anchorAt[i], score: best[i].score, matched: true }
      continue
    }
    let prevI = -1
    let nextI = -1
    for (let a = i - 1; a >= 0; a--) if (anchorAt[a] >= 0) { prevI = a; break }
    for (let b = i + 1; b < n; b++) if (anchorAt[b] >= 0) { nextI = b; break }
    let seg: number
    if (prevI >= 0 && nextI >= 0) {
      const a = anchorAt[prevI]
      const b = anchorAt[nextI]
      const frac = (i - prevI) / (nextI - prevI)
      seg = a + Math.round(frac * (b - a))
    } else if (prevI >= 0) {
      seg = Math.min(m - 1, anchorAt[prevI] + (i - prevI))
    } else if (nextI >= 0) {
      seg = Math.max(0, anchorAt[nextI] - (nextI - i))
    } else {
      seg = Math.round((i / Math.max(1, n - 1)) * (m - 1))
    }
    const weak = best[i].seg === seg && best[i].score >= threshold
    out[i] = { segIndex: seg, score: weak ? best[i].score : 0, matched: weak }
  }
  return out
}

/**
 * Char-weighted word timings inside one timed span — same estimator
 * `buildCaptions` uses, so image cuts agree with caption cues.
 */
export function wordTimings(text: string, start: number, end: number): WordSpan[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length || end <= start) return []
  const total = text.length || 1
  const dur = end - start
  let acc = 0
  return words.map(w => {
    const ws = start + (acc / total) * dur
    acc += w.length + 1
    const we = start + (Math.min(total, acc - 1) / total) * dur
    return { word: w, start: ws, end: Math.max(ws + 0.05, we) }
  })
}

/** Duration of the last `n` words of a timed span (char-weighted). */
export function trailingDuration(text: string, start: number, end: number, n: number): number {
  const wt = wordTimings(text, start, end)
  if (!wt.length) return 0
  const tail = wt.slice(Math.max(0, wt.length - n))
  return Math.max(0, end - tail[0].start)
}

export interface CutAssign {
  segIndex: number
  segStart: number
  segEnd: number
  /** absolute VO-relative time this visual should yield (seg end minus trailing words) */
  cut: number
  /** caption time the first filename word is spoken (visual shows) */
  showAt: number
  /** caption time the last ~4 filename words begin (visual docks) */
  dockAt: number
  score: number
  matched: boolean
}

/**
 * Absolute-time cut assignment. Unlike chained plans, cuts keep true
 * VO-relative times — block pauses and gaps survive instead of
 * compressing, so visuals never drift early against captions.
 */
export function assignCuts(
  imageNames: string[],
  segmentsIn: TimedText[],
  opts: SyncOptions = {},
): { assigns: CutAssign[]; voEnd: number } {
  const segments = [...segmentsIn].sort((a, b) => a.start - b.start)
  const trailingWords = Math.max(1, Math.round(opts.trailingWords ?? 3))
  const voEnd = segments.length ? segments[segments.length - 1].end : 0
  if (!imageNames.length || !segments.length) return { assigns: [], voEnd }
  const matches = matchImagesToSegments(imageNames, segments)
  return {
    assigns: matches.map((m, i) => {
      const seg = segments[m.segIndex]
      const trail = trailingDuration(seg.text, seg.start, seg.end, trailingWords)
      const anchor = anchorPhrase(imageNames[i], seg.text, seg.start, seg.end)
      return {
        segIndex: m.segIndex,
        segStart: seg.start,
        segEnd: seg.end,
        cut: Math.max(seg.start + 0.3, seg.end - trail),
        showAt: anchor.matched ? anchor.showAt : seg.start,
        dockAt: anchor.matched ? anchor.dockAt : Math.max(seg.start + 0.3, seg.end - trail),
        score: m.score,
        matched: m.matched,
      }
    }),
    voEnd,
  }
}
/**
 * Order-free sequencing for reorderable visuals (slideshows). Confident
 * hits claim their segment regardless of input order; conflicts go to the
 * higher score; weak names hold a positional slot so garbage filenames
 * never scramble deliberate ordering.
 *
 * Returns image indices in playback order.
 */
export function orderBySegments(
  imageNames: string[],
  segments: TimedText[],
  threshold = 0.3,
): number[] {
  const n = imageNames.length
  const m = segments.length
  const idx = imageNames.map((_, i) => i)
  if (!n || !m) return idx
  const scored = imageNames.map(name => {
    let seg = 0
    let score = 0
    for (let s = 0; s < m; s++) {
      const sc = overlapScore(name, segments[s].text)
      if (sc > score + 1e-9) {
        score = sc
        seg = s
      }
    }
    return { seg, score }
  })
  // conflict: two images, one segment — higher score claims it
  const claimed = new Map<number, number>()
  const anchored = new Array<number>(n).fill(-1)
  const byScore = idx.slice().sort((a, b) => scored[b].score - scored[a].score)
  for (const i of byScore) {
    if (scored[i].score < 0.55) break
    if (!claimed.has(scored[i].seg)) {
      claimed.set(scored[i].seg, i)
      anchored[i] = scored[i].seg
    }
  }
  const key = (i: number): number => {
    const seg = anchored[i] >= 0 ? anchored[i] : (scored[i].score >= threshold ? scored[i].seg : -1)
    if (seg >= 0 && seg < m) {
      const anc = anchorPhrase(imageNames[i], segments[seg].text, segments[seg].start, segments[seg].end)
      const frac = anc.matched
        ? Math.max(0, Math.min(0.95, (anc.showAt - segments[seg].start) / Math.max(0.1, segments[seg].end - segments[seg].start)))
        : (i / Math.max(1, n)) * 0.8
      return seg + frac * 0.99 + i * 1e-6
    }
    // positional fallback: fractional slot across the narration
    return n > 1 ? (i / (n - 1)) * (m - 1) + 0.5e-6 * i : 0
  }
  return idx.sort((a, b) => key(a) - key(b) || a - b)
}

export interface RunSlice {
  /** index into the input image order */
  imgIdx: number
  /** absolute VO-relative span owned by this image */
  start: number
  end: number
  segIndex: number
  score: number
  matched: boolean
  /** true for the first image of a segment run (transition boundary) */
  runStart: boolean
}

export interface LayoutOpts {
  /** per-image floor, sketch + transition + margin (showcase) or ~0.5 (clips) */
  minSlice?: number
  /** extra hold past the narration end for the final image */
  tail?: number
}

/**
 * Fair run-grouped layout. Consecutive images sharing one segment split
 * its window evenly (no rush cascades); windows anchor to absolute
 * segment times with a minimum-length cascade (no unbounded stuck);
 * pauses stretch the owning image instead of drifting the chain early.
 */
export function layoutRuns(
  assigns: CutAssign[],
  voEnd: number,
  opts: LayoutOpts = {},
): RunSlice[] {
  const minSlice = opts.minSlice ?? 0.5
  const tail = opts.tail ?? 0.5
  const out: RunSlice[] = []
  if (!assigns.length) return out
  // group consecutive images that share one segment
  const runs: { segIndex: number; idx: number[] }[] = []
  assigns.forEach((a, i) => {
    const last = runs[runs.length - 1]
    if (last && last.segIndex === a.segIndex) last.idx.push(i)
    else runs.push({ segIndex: a.segIndex, idx: [i] })
  })
  // absolute boundaries with minimum-length cascade
  const b: number[] = []
  runs.forEach((run, r) => {
    const segStart = assigns[run.idx[0]].segStart
    b.push(r === 0 ? segStart : Math.max(segStart, b[r - 1] + runs[r - 1].idx.length * minSlice))
  })
  runs.forEach((run, r) => {
    const runEnd = r + 1 < runs.length
      ? b[r + 1]
      : Math.max(voEnd + tail, b[r] + run.idx.length * minSlice)
    const slice = (runEnd - b[r]) / run.idx.length
    run.idx.forEach((imgIdx, k) => {
      const a = assigns[imgIdx]
      out.push({
        imgIdx,
        start: b[r] + k * slice,
        end: b[r] + (k + 1) * slice,
        segIndex: a.segIndex,
        score: a.score,
        matched: a.matched,
        runStart: k === 0,
      })
    })
  })
  return out.sort((x, y) => x.imgIdx - y.imgIdx)
}

/** Natural file order — prioritizes parsed numerical index (e.g. "01_", "[open 1]"), then numeric locale comparison. */
export function sortByName<T>(arr: T[], pick: (x: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const na = pick(a), nb = pick(b)
    const pa = parseTaggedFilename(na)
    const pb = parseTaggedFilename(nb)
    if (pa.index !== null && pb.index !== null && pa.index !== pb.index) {
      return pa.index - pb.index
    }
    return na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/** Flatten voice blocks to sentence-level timed segments. */
export function sentencesOf(blocks: { text: string; start: number; end: number; sentences?: TimedText[] }[]): TimedText[] {
  const out: TimedText[] = []
  for (const b of blocks) {
    if (b.sentences?.length) out.push(...b.sentences)
    else out.push({ text: b.text, start: b.start, end: b.end })
  }
  return out.sort((a, b) => a.start - b.start)
}

export interface TaggedNameInfo {
  /** 1-based index if detected from prefix or tag (e.g. 1 from "01_" or "[img:1]") */
  index: number | null
  tagIndex: number | null
  /** specific trigger phrase between [img:X] ... [/img:X] */
  triggerText: string | null
  /** full sentence text without tags or numeric prefix */
  fullText: string
  raw: string
}

/**
 * Parse structured image filenames containing indices and trigger markers.
 * Supports Windows-safe (no slashes or colons) and legacy conventions:
 *   01_sentence [open 1] trigger phrase [close 1] rest of sentence.jpg
 *   01_sentence [open] trigger phrase [close] rest of sentence.jpg
 *   01_sentence [img 1] trigger phrase [end 1] rest of sentence.jpg
 *   01_sentence [start 1] trigger phrase [end 1] rest of sentence.jpg
 *   01_sentence [trigger phrase] rest of sentence.jpg
 *   01_sentence ++trigger phrase++ rest of sentence.jpg
 *   01_sentence [img:1] trigger phrase [/img:1] rest of sentence.jpg
 *   01_raw sentence text.jpg
 */
export function parseTaggedFilename(filename: string): TaggedNameInfo {
  const base = filename.replace(/\.[a-z0-9]{2,5}$/i, '').trim()
  const numMatch = base.match(/^(\d+)[\s_\-.:]/)
  const index = numMatch ? parseInt(numMatch[1], 10) : null

  // 1. Explicit tag pairs (Windows-safe & legacy):
  //    [open 1] ... [close 1]  or  [open] ... [close]
  //    [img 1] ... [end 1]    or  [img] ... [end]
  //    [start 1] ... [end 1]  or  [start] ... [end]
  //    [slide 1] ... [end 1]  or  [slide] ... [close]
  //    [img:1] ... [/img:1]
  const pairMatch = base.match(/\[(?:open|start|img|slide)[\s:_]*(\d*)\]\s*([\s\S]*?)\s*\[(?:\/|close|end|stop|_img|_slide)(?:[\s:_]*\d*)\]/i)

  // 2. Double-plus markers: ++trigger phrase++
  const plusMatch = base.match(/\+\+([^+]+)\+\+/)

  // 3. Simple bracket phrase in numbered file: 01_Sentence [trigger phrase] rest.jpg
  const singleBracketMatch = base.match(/\[([^[\]]+)\]/)

  let tagIndex: number | null = null
  let triggerText: string | null = null

  if (pairMatch) {
    if (pairMatch[1] && /^\d+$/.test(pairMatch[1])) {
      tagIndex = parseInt(pairMatch[1], 10)
    }
    triggerText = pairMatch[2].trim()
  } else if (plusMatch) {
    triggerText = plusMatch[1].trim()
  } else if (singleBracketMatch && index !== null && !/^(?:open|close|start|end|img|slide|stop)[\s:_]*\d*$/i.test(singleBracketMatch[1].trim())) {
    triggerText = singleBracketMatch[1].trim()
  }

  const fullText = base
    .replace(/^(\d+)[\s_\-.:]+/, '')
    .replace(/\[(?:open|start|img|slide)[\s:_]*\d*\]/gi, ' ')
    .replace(/\[(?:\/|close|end|stop|_img|_slide)(?:[\s:_]*\d*)\]/gi, ' ')
    .replace(/\[\/?(?:img|slide)(?:[\s:_]*\d*)\]/gi, ' ')
    .replace(/\[([^[\]]+)\]/g, (_m, g1) => g1)
    .replace(/\+\+[^+]+\+\+/g, (m) => m.slice(2, -2))
    .replace(/\s+/g, ' ')
    .trim()

  return {
    index: tagIndex ?? index,
    tagIndex,
    triggerText: triggerText && triggerText.length > 0 ? triggerText : null,
    fullText,
    raw: filename,
  }
}

/**
 * Locate exact audio/caption timestamps for a trigger phrase inside a timed sentence.
 */
export function findTriggerSpan(
  sentenceText: string,
  triggerText: string,
  segStart: number,
  segEnd: number,
): { openAt: number; closeAt: number; matched: boolean } {
  const wt = wordTimings(sentenceText, segStart, segEnd)
  if (!wt.length || !triggerText.trim()) {
    return { openAt: segStart, closeAt: segEnd, matched: false }
  }

  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const sentenceWords = wt.map(w => clean(w.word))
  const triggerWords = triggerText.split(/\s+/).map(clean).filter(Boolean)

  if (!triggerWords.length) {
    return { openAt: segStart, closeAt: segEnd, matched: false }
  }

  // Pass 1: exact contiguous sub-sequence match
  for (let i = 0; i <= sentenceWords.length - triggerWords.length; i++) {
    let match = true
    for (let j = 0; j < triggerWords.length; j++) {
      if (sentenceWords[i + j] !== triggerWords[j]) {
        match = false
        break
      }
    }
    if (match) {
      return {
        openAt: wt[i].start,
        closeAt: wt[i + triggerWords.length - 1].end,
        matched: true,
      }
    }
  }

  // Pass 2: match start and end boundary words with boundary tolerance
  const firstWord = triggerWords[0]
  const lastWord = triggerWords[triggerWords.length - 1]
  const startIdx = sentenceWords.indexOf(firstWord)
  if (startIdx >= 0) {
    const endIdx = sentenceWords.lastIndexOf(lastWord)
    if (endIdx >= startIdx) {
      return {
        openAt: wt[startIdx].start,
        closeAt: wt[endIdx].end,
        matched: true,
      }
    }
  }

  return { openAt: segStart, closeAt: segEnd, matched: false }
}

// ---------------------------------------------------------------------------
// Caption-grounded sync planner (two-phase: calculate everything first,
// then the caller applies the plan to clips in one pass).
//
// Ground truth is the karaoke caption highlight (renderTextLayer): within
// one caption cue, words flip to the highlight color in order, each word's
// flip time splitting [cue.start, cue.end] proportionally to
// max(1, word.length). The word clock below reproduces that exact math, so
// an image whose trigger words highlight at T shows/docks at T —
// captions, voiceover and visuals share one clock by construction.
// ---------------------------------------------------------------------------

/** One caption cue: words in order with its absolute span. */
export interface WordClockCue {
  words: string[]
  start: number
  end: number
}

/** One word with the absolute time its caption highlight flips on/off. */
export interface CaptionWord {
  word: string
  start: number
  end: number
}

/**
 * Build the highlight word clock from caption cues. Uses the identical
 * subdivision the karaoke renderer uses (weights = max(1, length)), so
 * each word's span is exactly when it renders highlighted.
 */
export function captionWordClock(cues: WordClockCue[]): CaptionWord[] {
  const out: CaptionWord[] = []
  for (const cue of cues) {
    const words = cue.words.filter(Boolean)
    if (!words.length || cue.end <= cue.start) continue
    const weights = words.map(w => Math.max(1, w.length))
    const total = weights.reduce((a, b) => a + b, 0) || 1
    const dur = cue.end - cue.start
    let acc = 0
    words.forEach((w, i) => {
      const s = cue.start + (acc / total) * dur
      acc += weights[i]
      const e = cue.start + (acc / total) * dur
      out.push({ word: w, start: s, end: Math.max(s + 0.01, e) })
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * Rebuild the cue stream `buildCaptions` would produce for these sentences
 * (same <=maxWords chunking, same char-weighted cue spans, same overlap
 * fix), then return its highlight word clock. Used when no caption clips
 * exist on the timeline yet.
 */
export function sentenceWordClock(sentences: TimedText[], maxWords = 8): CaptionWord[] {
  const cues: WordClockCue[] = []
  for (const s of sentences) {
    const words = s.text.split(/\s+/).filter(Boolean)
    const dur = s.end - s.start
    if (!words.length || dur <= 0.05) continue
    const totalChars = s.text.length || 1
    let acc = 0
    for (let i = 0; i < words.length; i += maxWords) {
      const slice = words.slice(i, i + maxWords)
      const sliceLen = slice.join(' ').length
      const cs = s.start + (acc / totalChars) * dur
      acc += sliceLen + 1
      const ce = s.start + (Math.min(totalChars, acc - 1) / totalChars) * dur
      cues.push({ words: slice, start: cs, end: Math.max(cs + 0.3, ce) })
    }
  }
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i].start = cues[i - 1].end
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3
  }
  return captionWordClock(cues)
}

/**
 * Locate a trigger phrase in the caption word clock. Prefers a contiguous
 * run inside the hint window (the image's own sentence span); falls back
 * to a global contiguous run, then to first/last boundary words.
 */
export function findTriggerInClock(
  triggerText: string,
  clock: CaptionWord[],
  hintStart = -Infinity,
  hintEnd = Infinity,
): { openAt: number; closeAt: number; matched: boolean } {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const tw = triggerText.split(/\s+/).map(clean).filter(Boolean)
  if (!tw.length || !clock.length) return { openAt: hintStart, closeAt: hintEnd, matched: false }
  const cw = clock.map(c => clean(c.word))
  const inHint = (i: number) => clock[i].start >= hintStart && clock[i].start <= hintEnd

  const scan = (onlyHint: boolean): { openAt: number; closeAt: number; matched: boolean } | null => {
    for (let i = 0; i <= cw.length - tw.length; i++) {
      if (onlyHint && !inHint(i)) continue
      let ok = true
      for (let j = 0; j < tw.length; j++) {
        if (cw[i + j] !== tw[j]) { ok = false; break }
      }
      if (ok) return { openAt: clock[i].start, closeAt: clock[i + tw.length - 1].end, matched: true }
    }
    return null
  }
  return scan(true) ?? scan(false) ?? (() => {
    const first = tw[0]
    const last = tw[tw.length - 1]
    const s = cw.indexOf(first)
    if (s < 0) return { openAt: hintStart, closeAt: hintEnd, matched: false }
    const e = cw.lastIndexOf(last)
    if (e < s) return { openAt: hintStart, closeAt: hintEnd, matched: false }
    return { openAt: clock[s].start, closeAt: clock[e].end, matched: true }
  })()
}

export interface PlannedImage {
  /** index into the input (playback-ordered) image array */
  imgIdx: number
  segIndex: number
  /** caption-clock time the first trigger word highlights (show) */
  openAt: number
  /** caption-clock time the last trigger word ends (dock) */
  closeAt: number
  /** absolute clip start (openAt minus dissolve-aware lead-in) */
  start: number
  /** absolute clip end (covers the gap, outgoing dissolves out as next arrives) */
  end: number
  /** dissolve duration into this clip, sized from the inter-tag gap */
  transIn: number
  score: number
  matched: boolean
}

export interface PlanSyncOptions {
  /** max seconds the image appears before its first trigger word (default 0.3) */
  preRollMax?: number
  /** dissolve floor/ceiling in seconds (defaults 0.15 / 0.5) */
  minTrans?: number
  maxTrans?: number
  /** hold after the final image's trigger ends (default 0.5) */
  endTail?: number
  /** minimum clip length (default 0.3) */
  minDur?: number
  /** fallback cut when no trigger matches: words at seg end covered by transition (default 3) */
  trailingWords?: number
}

/**
 * PHASE 1 (pure — no clip mutation): assign every image its sentence,
 * resolve open/close against the caption word clock, then size each
 * dissolve from the time gap between neighbouring tags and derive
 * absolute clip spans. The caller applies the returned plan in one pass.
 */
export function planImageSync(
  imageNames: string[],
  segmentsIn: TimedText[],
  clock: CaptionWord[],
  opts: PlanSyncOptions = {},
): PlannedImage[] {
  const segments = [...segmentsIn].sort((a, b) => a.start - b.start)
  const n = imageNames.length
  if (!n || !segments.length) return []
  const preRollMax = opts.preRollMax ?? 0.3
  const minTrans = opts.minTrans ?? 0.15
  const maxTrans = opts.maxTrans ?? 0.5
  const endTail = opts.endTail ?? 0.5
  const minDur = opts.minDur ?? 0.3
  const trailingWords = Math.max(1, Math.round(opts.trailingWords ?? 3))

  const parsed = imageNames.map(parseTaggedFilename)
  const opens: number[] = new Array(n)
  const closes: number[] = new Array(n)
  const segIdx: number[] = new Array(n)
  const scores: number[] = new Array(n)
  const matched: boolean[] = new Array(n)

  imageNames.forEach((name, i) => {
    const p = parsed[i]
    let seg = segments[Math.min(segments.length - 1, i)]
    let sc = 0
    if (p.index !== null && p.index >= 1 && p.index <= segments.length) {
      seg = segments[p.index - 1]
      sc = 1
    } else if (p.fullText) {
      let best = 0
      let bestSc = 0
      for (let s = 0; s < segments.length; s++) {
        const v = overlapScore(p.fullText, segments[s].text)
        if (v > bestSc) { bestSc = v; best = s }
      }
      if (bestSc >= 0.2) { seg = segments[best]; sc = bestSc }
    }
    segIdx[i] = segments.indexOf(seg)
    if (p.triggerText && clock.length) {
      const hit = findTriggerInClock(p.triggerText, clock, seg.start, seg.end)
      if (hit.matched && isFinite(hit.openAt) && isFinite(hit.closeAt)) {
        opens[i] = hit.openAt
        closes[i] = Math.max(hit.openAt + 0.2, hit.closeAt)
        scores[i] = sc || 0.5
        matched[i] = true
        return
      }
    }
    // fallback: whole-sentence span minus trailing words (as before)
    const trail = trailingDuration(seg.text, seg.start, seg.end, trailingWords)
    opens[i] = seg.start
    closes[i] = Math.max(seg.start + 0.5, seg.end - trail)
    scores[i] = sc
    matched[i] = sc >= 0.2
  })

  // dissolves sized from the inter-tag gap: half the breathing room,
  // clamped; overlapping tags get the floor (near-hard cut).
  const trans: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const gap = opens[i] - closes[i - 1]
    trans[i] = gap < 0
      ? minTrans
      : Math.min(maxTrans, Math.max(minTrans, gap * 0.5))
  }

  // absolute spans: B starts with a lead-in capped by its own dissolve so
  // the dissolve completes right as the trigger word highlights; A holds
  // (static frame) across the gap and is fully dissolved out as B lands.
  const plan: PlannedImage[] = new Array(n)
  const starts: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const lead = i === 0 ? 0 : Math.min(preRollMax, trans[i])
    starts[i] = Math.max(0, opens[i] - lead)
  }
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? starts[i + 1] + trans[i + 1] : closes[i] + endTail
    plan[i] = {
      imgIdx: i,
      segIndex: segIdx[i],
      openAt: opens[i],
      closeAt: closes[i],
      start: starts[i],
      end: Math.max(starts[i] + minDur, end),
      transIn: trans[i],
      score: scores[i],
      matched: matched[i],
    }
  }
  return plan
}
