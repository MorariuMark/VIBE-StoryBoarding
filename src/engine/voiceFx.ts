/**
 * voiceFx — offline DSP for generated voiceovers.
 * Pure Float32 math (no Web Audio needed): tempo, tape-faithful pitch shift,
 * Schroeder reverb, fades, gain + normalize. Fast enough to apply live.
 */

export interface VoiceFxParams {
  /** semitones, -6..+6 (tempo-preserving granular shift) */
  pitch: number
  /** tempo multiplier, 0.5..2 (resample; pitch follows like tape) */
  tempo: number
  /** reverb wet amount, 0..0.6 */
  reverb: number
  /** room size, 0..1 (decay + spread) */
  room: number
  /** output gain, 0..2 */
  gain: number
  /** peak-normalize before gain */
  normalize: boolean
  fadeIn: number
  fadeOut: number
}

export const DEFAULT_VOICE_FX: VoiceFxParams = {
  pitch: 0,
  tempo: 1,
  reverb: 0,
  room: 0.5,
  gain: 1,
  normalize: true,
  fadeIn: 0.1,
  fadeOut: 0.3,
}

export interface FxResult {
  samples: Float32Array
  /** timing scale vs the source (1/tempo when tempo changes) */
  timeScale: number
}

function resampleTempo(samples: Float32Array, tempo: number): { out: Float32Array; timeScale: number } {
  if (Math.abs(tempo - 1) < 1e-6) return { out: samples, timeScale: 1 }
  const t = Math.min(2, Math.max(0.5, tempo))
  const n = Math.max(1, Math.round(samples.length / t))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = i * t
    const i0 = Math.floor(pos)
    const f = pos - i0
    const a = samples[Math.min(samples.length - 1, i0)]
    const b = samples[Math.min(samples.length - 1, i0 + 1)]
    out[i] = a + (b - a) * f
  }
  return { out, timeScale: 1 / t }
}

/** Tempo-preserving pitch shift (granular overlap-add, Hann window). */
function pitchShift(samples: Float32Array, rate: number, semitones: number): Float32Array {
  if (Math.abs(semitones) < 0.01) return samples
  const p = Math.pow(2, Math.min(6, Math.max(-6, semitones)) / 12)
  const N = Math.min(2048, Math.max(512, Math.round(rate * 0.085)))
  const Ha = Math.floor(N / 4)
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  const out = new Float32Array(samples.length)
  const norm = new Float32Array(samples.length)
  let inPtr = 0
  let outPtr = 0
  while (outPtr < samples.length) {
    const m = Math.min(N, samples.length - outPtr)
    for (let i = 0; i < m; i++) {
      const pos = inPtr + i
      if (pos >= samples.length - 1) break
      const i0 = Math.floor(pos)
      const f = pos - i0
      const s = samples[i0] + (samples[i0 + 1] - samples[i0]) * f
      out[outPtr + i] += s * win[i]
      norm[outPtr + i] += win[i]
    }
    inPtr += Ha * p
    outPtr += Ha
    if (inPtr >= samples.length - 1) {
      // wrap reading so tails don't go silent on pitch-down
      inPtr = inPtr % Math.max(1, samples.length - N)
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (norm[i] > 1e-4) out[i] /= norm[i]
  }
  return out
}

interface CombState { buf: Float32Array; idx: number; filter: number }

/** Freeverb-style Schroeder reverb (4 combs + 2 allpasses), mono, O(N). */
function schroeder(samples: Float32Array, rate: number, wet: number, room: number): Float32Array {
  if (wet <= 0.001) return samples
  const k = rate / 44100
  const combTuning = [29.7, 36.3, 41.1, 43.9]
  const allpassTuning = [5.0, 1.7]
  const fb = 0.7 + 0.28 * Math.min(1, Math.max(0, room))
  const damp = 0.25
  const combs: CombState[] = combTuning.map(ms => ({
    buf: new Float32Array(Math.max(2, Math.round(ms * k * (0.8 + 0.4 * room)))),
    idx: 0,
    filter: 0,
  }))
  const aps = allpassTuning.map(ms => ({
    buf: new Float32Array(Math.max(2, Math.round(ms * k))),
    idx: 0,
  }))
  const apG = 0.5
  const out = new Float32Array(samples.length)
  for (let n = 0; n < samples.length; n++) {
    const x = samples[n]
    let acc = 0
    for (const c of combs) {
      const L = c.buf.length
      const y = c.buf[c.idx]
      c.filter = y * (1 - damp) + c.filter * damp
      c.buf[c.idx] = x + c.filter * fb
      c.idx = (c.idx + 1) % L
      acc += y
    }
    acc *= 0.25
    for (const a of aps) {
      const L = a.buf.length
      const bufOut = a.buf[a.idx]
      const y = -apG * acc + bufOut
      a.buf[a.idx] = acc + apG * bufOut
      a.idx = (a.idx + 1) % L
      acc = y
    }
    out[n] = x + acc * Math.min(0.6, Math.max(0, wet)) * 2.2
  }
  return out
}

/**
 * Trim leading/trailing near-silence, keeping a small natural pad on each
 * side. Used per synthesized sentence so caption spans hug the actual speech
 * instead of starting/ending inside padding silence.
 */
export function trimSilence(
  samples: Float32Array,
  rate: number,
  threshold = 0.015,
  padSec = 0.06,
): Float32Array {
  const pad = Math.max(0, Math.round(padSec * rate))
  let start = 0
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++
  let end = samples.length
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--
  start = Math.max(0, start - pad)
  end = Math.min(samples.length, end + pad)
  if (end - start < Math.round(0.05 * rate)) return samples // too short: keep original
  if (start === 0 && end === samples.length) return samples
  return samples.slice(start, end)
}

/** Full chain: tempo → pitch → reverb → fades → normalize → gain. */
export function applyVoiceFx(input: Float32Array, rate: number, fx: VoiceFxParams): FxResult {
  const { out: sped, timeScale } = resampleTempo(input, fx.tempo)
  let s = pitchShift(sped, rate, fx.pitch)
  s = schroeder(s, rate, fx.reverb, fx.room)

  // fades
  const fi = Math.min(s.length, Math.round(Math.max(0, fx.fadeIn) * rate))
  const fo = Math.min(s.length, Math.round(Math.max(0, fx.fadeOut) * rate))
  for (let i = 0; i < fi; i++) s[i] *= i / Math.max(1, fi)
  for (let i = 0; i < fo; i++) s[s.length - 1 - i] *= i / Math.max(1, fo)

  // normalize + gain
  if (fx.normalize) {
    let peak = 0
    for (let i = 0; i < s.length; i += 3) {
      const v = Math.abs(s[i])
      if (v > peak) peak = v
    }
    if (peak > 1e-4) {
      const g = 0.95 / peak
      for (let i = 0; i < s.length; i++) s[i] *= g
    }
  }
  const g = Math.min(2, Math.max(0, fx.gain))
  if (Math.abs(g - 1) > 1e-6) {
    for (let i = 0; i < s.length; i++) s[i] *= g
  }
  // safety clamp
  for (let i = 0; i < s.length; i++) {
    if (s[i] > 1) s[i] = 1
    else if (s[i] < -1) s[i] = -1
  }
  return { samples: s, timeScale }
}
