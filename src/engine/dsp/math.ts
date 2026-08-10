/** Small shared numerics. Kept dependency-free so the engine stays portable. */

/** Amplitude below which we treat a signal as silence (−200 dBFS). */
export const SILENCE = 1e-10

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, SILENCE))
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * One-pole smoothing coefficient: the per-sample factor that decays a step to
 * 1/e of its size in `timeMs`. Returns 0 for a non-positive time, which makes
 * the smoother snap instantly.
 */
export function onePoleCoeff(timeMs: number, sampleRate: number): number {
  if (timeMs <= 0 || sampleRate <= 0) return 0
  return Math.exp(-1 / ((timeMs / 1000) * sampleRate))
}
