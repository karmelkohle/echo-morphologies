import { clamp, dbToGain, gainToDb, onePoleCoeff } from './math'

/**
 * Safety limiter on the last stage before the earbuds.
 *
 * This is a hearing-protection device, not a mastering tool. The whole app is a
 * live microphone wired to headphones a few centimetres from an eardrum: one
 * slipped fader, one door slam, one feedback loop when the phone is off the
 * ears and playing through its own speaker, and the output goes somewhere
 * unpleasant. So the ceiling is always on and cannot be switched off.
 *
 * Deliberately simple: peak detection with a fast attack and slow release, no
 * lookahead. Without lookahead the gain arrives slightly after a sharp
 * transient, so a hard clamp backs it up and catches whatever slips past. That
 * clamp distorts on the way in — which is the correct trade for a limiter whose
 * job is to be inaudible right up until it saves you.
 */
export class Limiter {
  private ceiling = dbToGain(-1)
  private gain = 1
  private attackCoeff = 0
  private releaseCoeff = 0
  private worstReductionDb = 0

  /** @param ceilingDb Output ceiling in dBFS. */
  prepare(sampleRate: number, ceilingDb = -1): void {
    this.ceiling = dbToGain(ceilingDb)
    this.attackCoeff = onePoleCoeff(0.5, sampleRate)
    this.releaseCoeff = onePoleCoeff(120, sampleRate)
    this.reset()
  }

  reset(): void {
    this.gain = 1
    this.worstReductionDb = 0
  }

  /** Limits `left` and `right` in place with a linked (stereo-coherent) gain. */
  process(left: Float32Array, right: Float32Array, frames: number): void {
    const { ceiling, attackCoeff, releaseCoeff } = this
    let gain = this.gain
    let worst = this.gain

    for (let i = 0; i < frames; i++) {
      const l = left[i]
      const r = right[i]
      const magL = l < 0 ? -l : l
      const magR = r < 0 ? -r : r
      const peak = magL > magR ? magL : magR

      const target = peak > ceiling ? ceiling / peak : 1
      // Clamp down quickly, recover slowly: pumping is better than clipping.
      const coeff = target < gain ? attackCoeff : releaseCoeff
      gain = target + (gain - target) * coeff
      if (gain < worst) worst = gain

      left[i] = clamp(l * gain, -ceiling, ceiling)
      right[i] = clamp(r * gain, -ceiling, ceiling)
    }

    this.gain = gain
    const reductionDb = -gainToDb(worst)
    if (reductionDb > this.worstReductionDb) this.worstReductionDb = reductionDb
  }

  /** Worst gain reduction since the last drain, as a positive dB figure. */
  get reductionDb(): number {
    return this.worstReductionDb
  }

  drainReduction(): void {
    this.worstReductionDb = 0
  }
}
