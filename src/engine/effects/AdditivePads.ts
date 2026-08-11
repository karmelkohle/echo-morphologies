import type { DirectionalBus } from '../DirectionalBus'
import { Rng } from '../dsp/Rng'
import { clamp } from '../dsp/math'
import { SlotParam } from '../params'
import type { EngineConfig } from '../types'
import { SpatialTarget, type SpatialEffect } from './SpatialEffect'

/**
 * Additive pads under the voice — the experimental one.
 *
 * A pitch tracker follows the fundamental of the capture (speech, humming,
 * traffic drones); an oscillator bank lays a pad at that pitch, gated by an
 * attack/release envelope on voicing. The spectrum is shaped msf.add-style:
 * partial count, a spacing factor (1.0 = the harmonic series, below
 * compresses, above stretches — msf's frequency-law macro reduced to its one
 * most playable knob), and an odd/even balance.
 *
 * Detection is time-domain autocorrelation (McLeod's normalized difference,
 * simplified): 1024-sample windows at half rate, ~46 ms hop, range 65..800 Hz.
 * Good enough to follow a voice; not trying to be a tuner. The detected f0
 * glides (one-pole, the glide param) so wobble becomes portamento instead of
 * jitter.
 *
 * Spatially: each partial sits on a lane (partial k → lane k mod N), and the
 * lanes redraw their directions from the slot's target at every retrigger —
 * a new note re-scatters the pad's spectrum around the target.
 */

const MAX_PARTIALS = 16
const WINDOW = 1024 // analysis window at half rate
const MIN_F0 = 65
const MAX_F0 = 800

export class AdditivePads implements SpatialEffect {
  attackMs = 350
  releaseMs = 1200
  partials = 8
  spacing = 1
  oddEven = 0.5
  glideMs = 120

  private sampleRate = 48000
  // ── analysis ─────────────────────────────────────────────────────────────
  /** Half-rate ring of recent input for the detector. */
  private ana = new Float32Array(WINDOW)
  private anaFill = 0
  private downsamplePhase = 0
  private downsampleAcc = 0
  // ── tracking ─────────────────────────────────────────────────────────────
  private f0 = 0
  private f0Smooth = 0
  private voiced = false
  private inputRms = 0
  /** Rising-edge memory for retriggering the spatial scatter. */
  private wasGated = false
  // ── synthesis ────────────────────────────────────────────────────────────
  private phases = new Float64Array(MAX_PARTIALS)
  private env = 0
  private laneCount = 4
  private azimuths = new Float32Array(0)
  private elevations = new Float32Array(0)
  private laneLevels = new Float32Array(0)
  private readonly rng: Rng

  constructor(
    private readonly target: SpatialTarget,
    seed: number,
  ) {
    this.rng = new Rng(seed >>> 0 || 0xadd)
  }

  prepare(cfg: EngineConfig): void {
    this.sampleRate = cfg.sampleRate
    this.reset()
  }

  reset(): void {
    this.ana.fill(0)
    this.anaFill = 0
    this.downsamplePhase = 0
    this.downsampleAcc = 0
    this.f0 = 0
    this.f0Smooth = 0
    this.voiced = false
    this.inputRms = 0
    this.wasGated = false
    this.phases.fill(0)
    this.env = 0
    this.laneLevels.fill(0)
  }

  setLocal(local: number, value: number): void {
    switch (local) {
      case SlotParam.AddAttackMs:
        this.attackMs = value
        break
      case SlotParam.AddReleaseMs:
        this.releaseMs = value
        break
      case SlotParam.AddPartials:
        this.partials = Math.round(clamp(value, 1, MAX_PARTIALS))
        break
      case SlotParam.AddSpacing:
        this.spacing = clamp(value, 0.25, 2.5)
        break
      case SlotParam.AddOddEven:
        this.oddEven = clamp(value, 0, 1)
        break
      case SlotParam.AddGlideMs:
        this.glideMs = value
        break
    }
  }

  redrawDirections(): void {
    // Directions redraw at the next retrigger anyway; force it for the case
    // of a held note while the target moves.
    this.wasGated = false
  }

  process(
    input: Float32Array,
    bus: DirectionalBus,
    laneOffset: number,
    laneCount: number,
    frames: number,
  ): void {
    this.laneCount = laneCount
    this.ensureLaneArrays(laneCount)

    // ── feed the detector (half-rate: average sample pairs) ───────────────
    let sumSquares = 0
    for (let i = 0; i < frames; i++) {
      const x = input[i]
      sumSquares += x * x
      if (this.downsamplePhase === 0) {
        this.downsampleAcc = x
        this.downsamplePhase = 1
      } else {
        this.pushAnalysis((this.downsampleAcc + x) * 0.5)
        this.downsamplePhase = 0
      }
    }
    const blockRms = Math.sqrt(sumSquares / frames)
    // Slowish follower so the pad breathes with the voice, not each syllable.
    this.inputRms += (blockRms - this.inputRms) * 0.08

    // ── gate + envelope ───────────────────────────────────────────────────
    const gated = this.voiced && this.inputRms > 0.003
    if (gated && !this.wasGated) {
      // Retrigger: the pad finds new places around the target.
      for (let k = 0; k < laneCount; k++) {
        this.azimuths[k] = this.target.drawAzimuth(this.rng)
        this.elevations[k] = this.target.drawElevation(this.rng)
      }
    }
    this.wasGated = gated

    for (let k = 0; k < laneCount; k++) {
      const direction = bus.directions[laneOffset + k]
      direction.azimuthDeg = this.azimuths[k]
      direction.elevationDeg = this.elevations[k]
      direction.distanceM = 1
    }

    if (!gated && this.env < 1e-4) {
      for (let k = 0; k < this.laneLevels.length; k++) this.laneLevels[k] *= 0.9
      return
    }

    // One-pole attack/release per block (block-rate is smooth enough at the
    // pad time constants this effect deals in).
    const blockSec = frames / this.sampleRate
    const tau = gated ? Math.max(0.005, this.attackMs / 1000) : Math.max(0.02, this.releaseMs / 1000)
    const a = 1 - Math.exp(-blockSec / tau)
    this.env += ((gated ? 1 : 0) - this.env) * a

    // Glide toward the detected pitch.
    const glideTau = Math.max(0.005, this.glideMs / 1000)
    const g = 1 - Math.exp(-blockSec / glideTau)
    if (this.f0 > 0) {
      if (this.f0Smooth <= 0) this.f0Smooth = this.f0
      this.f0Smooth += (this.f0 - this.f0Smooth) * g
    }
    if (this.f0Smooth <= 0) return

    // ── render the bank ───────────────────────────────────────────────────
    const nyquist = this.sampleRate * 0.45
    // The pad sits under the voice: overall level tracks the input follower.
    const padLevel = this.env * Math.min(0.5, this.inputRms * 4)
    const count = this.partials

    for (let k = 0; k < count; k++) {
      const freq = this.f0Smooth * (1 + k * this.spacing)
      if (freq >= nyquist) break
      // Odd/even balance: partial index k → harmonic number k+1.
      const isOdd = (k + 1) % 2 === 1
      const balance = isOdd ? clamp(this.oddEven * 2, 0, 1) : clamp((1 - this.oddEven) * 2, 0, 1)
      const amp = (padLevel * balance) / (1 + k)
      if (amp <= 0) {
        // Keep phase rolling so the partial re-enters in phase.
        this.phases[k] += ((2 * Math.PI * freq) / this.sampleRate) * frames
        continue
      }

      const lane = bus.lanes[laneOffset + (k % laneCount)]
      const inc = (2 * Math.PI * freq) / this.sampleRate
      let phase = this.phases[k]
      for (let i = 0; i < frames; i++) {
        lane[i] += Math.sin(phase) * amp
        phase += inc
      }
      this.phases[k] = phase % (2 * Math.PI)

      const laneIx = k % laneCount
      if (amp > this.laneLevels[laneIx]) this.laneLevels[laneIx] = amp
    }
    for (let k = 0; k < this.laneLevels.length; k++) this.laneLevels[k] *= 0.97
  }

  snapshotVoices(out: Float32Array, at: number, max: number): number {
    const n = Math.min(this.laneCount, max)
    for (let k = 0; k < n; k++) {
      out[at + k * 3] = this.azimuths[k]
      out[at + k * 3 + 1] = this.elevations[k]
      out[at + k * 3 + 2] = Math.min(1, this.laneLevels[k] * 3)
    }
    return n
  }

  /** Half-rate sample into the analysis ring; a full window runs detection. */
  private pushAnalysis(sample: number): void {
    this.ana[this.anaFill++] = sample
    if (this.anaFill < WINDOW) return
    this.anaFill = 0
    this.detect()
  }

  /**
   * Normalized-difference pitch detection (McLeod, simplified) on the
   * half-rate window: for each candidate lag, autocorrelation over combined
   * energy. Runs ~21× a second at 48 kHz — off the per-sample path.
   */
  private detect(): void {
    const buf = this.ana
    const halfRate = this.sampleRate / 2
    const minLag = Math.max(2, Math.floor(halfRate / MAX_F0))
    const maxLag = Math.min(WINDOW - 2, Math.ceil(halfRate / MIN_F0))

    let energy = 0
    for (let i = 0; i < WINDOW; i++) energy += buf[i] * buf[i]
    if (energy < 1e-6) {
      this.voiced = false
      return
    }

    let bestLag = 0
    let bestValue = 0
    let prev = 0
    let rising = false
    for (let lag = minLag; lag <= maxLag; lag++) {
      let ac = 0
      let m = 0
      const span = WINDOW - lag
      for (let i = 0; i < span; i++) {
        const a = buf[i]
        const b = buf[i + lag]
        ac += a * b
        m += a * a + b * b
      }
      const value = m > 0 ? (2 * ac) / m : 0
      // First clear peak wins over the global one: favors the fundamental
      // over subharmonics that score marginally higher at double the lag.
      if (rising && value < prev && prev > 0.5) {
        bestLag = lag - 1
        bestValue = prev
        break
      }
      rising = value > prev
      if (value > bestValue) {
        bestValue = value
        bestLag = lag
      }
      prev = value
    }

    if (bestValue > 0.45 && bestLag > 0) {
      this.f0 = halfRate / bestLag
      this.voiced = true
    } else {
      this.voiced = false
    }
  }

  private ensureLaneArrays(laneCount: number): void {
    if (this.azimuths.length >= laneCount) return
    this.azimuths = new Float32Array(laneCount)
    this.elevations = new Float32Array(laneCount)
    this.laneLevels = new Float32Array(laneCount)
  }
}
