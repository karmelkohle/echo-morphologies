/**
 * Deterministic linear congruential RNG — a port of `msf::Rng` (Numerical
 * Recipes constants), bit-compatible with the spatdsp implementation so grain
 * streams can be reproduced across the two codebases from the same seed.
 */
export class Rng {
  private state: number

  constructor(seed = 0x5eed) {
    this.state = seed >>> 0 || 1
  }

  seed(s: number): void {
    this.state = s >>> 0 || 1
  }

  nextU32(): number {
    // (state * 1664525 + 1013904223) mod 2^32, in uint32 arithmetic.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0
    return this.state
  }

  /** Uniform float in [-1, 1]. */
  nextBipolar(): number {
    return this.nextU32() * (2 / 4294967295) - 1
  }
}
