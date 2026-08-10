/**
 * Accumulating peak / RMS detector.
 *
 * The audio thread runs ~375 blocks per second at 128 frames / 48 kHz, but the
 * interface only redraws ~30 times per second. Reporting the last block's level
 * would sample the signal instead of measuring it, and short transients — the
 * ones that matter for a clip indicator — would fall between reads. So this
 * accumulates continuously and the reader drains it.
 */
export class LevelMeter {
  private peak = 0
  private sumOfSquares = 0
  private frames = 0
  private clips = 0

  /** Fold one block into the running measurement. */
  accumulate(buffer: Float32Array, frames: number): void {
    let peak = this.peak
    let sum = this.sumOfSquares
    let clips = this.clips
    for (let i = 0; i < frames; i++) {
      const x = buffer[i]
      const magnitude = x < 0 ? -x : x
      if (magnitude > peak) peak = magnitude
      if (magnitude >= 1) clips++
      sum += x * x
    }
    this.peak = peak
    this.sumOfSquares = sum
    this.clips = clips
    this.frames += frames
  }

  /** Highest magnitude since the last drain. */
  get peakLevel(): number {
    return this.peak
  }

  /** Root-mean-square over every frame since the last drain. */
  get rmsLevel(): number {
    return this.frames > 0 ? Math.sqrt(this.sumOfSquares / this.frames) : 0
  }

  /** Samples at or above full scale since the last drain. */
  get clipCount(): number {
    return this.clips
  }

  /** Start a fresh measurement window. Call right after reading. */
  drain(): void {
    this.peak = 0
    this.sumOfSquares = 0
    this.frames = 0
    this.clips = 0
  }

  reset(): void {
    this.drain()
  }
}
