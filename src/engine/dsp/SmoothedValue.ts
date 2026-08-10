import { onePoleCoeff } from './math'

/**
 * Exponentially glides towards a target, one sample at a time.
 *
 * Every user-facing gain goes through one of these. Setting a raw multiplier
 * from the UI and applying it per block puts a step discontinuity at the block
 * boundary, which is audible as a click at exactly the rate the UI updates.
 */
export class SmoothedValue {
  private current = 0
  private target = 0
  private coeff = 0
  /** Distance below which we snap, to keep the tail out of denormal range. */
  private static readonly EPSILON = 1e-9

  constructor(initial = 0) {
    this.current = initial
    this.target = initial
  }

  prepare(timeMs: number, sampleRate: number): void {
    this.coeff = onePoleCoeff(timeMs, sampleRate)
  }

  /** Glide to `value` over the configured smoothing time. */
  setTarget(value: number): void {
    this.target = value
  }

  /** Jump to `value` immediately — for `prepare()`/`reset()`, not for the UI. */
  snapTo(value: number): void {
    this.target = value
    this.current = value
  }

  /** Abandon the glide and arrive at the pending target now. */
  settle(): void {
    this.current = this.target
  }

  get value(): number {
    return this.current
  }

  get isSettled(): boolean {
    return this.current === this.target
  }

  /** Advance one sample and return the new value. */
  next(): number {
    const delta = this.current - this.target
    if (delta < SmoothedValue.EPSILON && delta > -SmoothedValue.EPSILON) {
      this.current = this.target
    } else {
      this.current = this.target + delta * this.coeff
    }
    return this.current
  }
}
