import type { DirectionalBus } from '../DirectionalBus'
import { Rng } from '../dsp/Rng'
import { clamp } from '../dsp/math'
import { SlotParam } from '../params'
import type { EngineConfig } from '../types'
import { SpatialTarget, type SpatialEffect } from './SpatialEffect'

/**
 * A spatial echo: one repeat per lane, each at its own drawn direction.
 *
 * Deliberately a multi-tap FIR rather than a feedback loop — with the repeats
 * as separate taps, each one is a separate signal that can sit on its own
 * lane at its own place, which is the whole point here. Repeat k reads
 * (k+1)·time behind the write head at gain feedback^(k+1), through k+1 passes
 * of a one-pole lowpass so later repeats dull the way a room dulls them.
 *
 * Directions redraw whenever the target moves (EngineCore pokes
 * `redrawDirections`) — the echoes are places, and they hold still until told
 * otherwise.
 */

const MAX_TIME_MS = 2000

export class EchoDelay implements SpatialEffect {
  timeMs = 420
  feedback = 0.5
  damping = 0.35

  private sampleRate = 48000
  private buf = new Float32Array(0)
  private cap = 0
  private writeIx = 0
  private laneCount = 4
  /** Per-tap one-pole lowpass state (cascade depth = tap index + 1). */
  private lp = new Float32Array(0)
  /** Per-tap level follower for the polar plot. */
  private levels = new Float32Array(0)
  private azimuths = new Float32Array(0)
  private elevations = new Float32Array(0)
  private needsDraw = true
  private readonly rng: Rng

  constructor(
    private readonly target: SpatialTarget,
    seed: number,
  ) {
    this.rng = new Rng(seed >>> 0 || 0xec40)
  }

  prepare(cfg: EngineConfig): void {
    this.sampleRate = cfg.sampleRate
    // Enough ring for the last repeat of the longest time on the most lanes.
    this.cap = Math.ceil(((MAX_TIME_MS * 8) / 1000) * cfg.sampleRate) + cfg.maxBlockSize
    this.buf = new Float32Array(this.cap)
    this.reset()
  }

  reset(): void {
    this.buf.fill(0)
    this.writeIx = 0
    this.lp.fill(0)
    this.levels.fill(0)
    this.needsDraw = true
  }

  setLocal(local: number, value: number): void {
    switch (local) {
      case SlotParam.EchoTimeMs:
        this.timeMs = clamp(value, 10, MAX_TIME_MS)
        break
      case SlotParam.EchoFeedback:
        this.feedback = clamp(value, 0, 0.98)
        break
      case SlotParam.EchoDamping:
        this.damping = clamp(value, 0, 1)
        break
    }
  }

  /** The slot's target moved; the repeats find new places. */
  redrawDirections(): void {
    this.needsDraw = true
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

    if (this.needsDraw) {
      this.needsDraw = false
      for (let k = 0; k < laneCount; k++) {
        this.azimuths[k] = this.target.drawAzimuth(this.rng)
        this.elevations[k] = this.target.drawElevation(this.rng)
      }
    }

    // Repeats hold their places; restate them (directions are shared state
    // the previous occupant of these lanes may have moved).
    for (let k = 0; k < laneCount; k++) {
      const direction = bus.directions[laneOffset + k]
      direction.azimuthDeg = this.azimuths[k]
      direction.elevationDeg = this.elevations[k]
      direction.distanceM = 1
    }

    const delaySamples = Math.max(1, Math.round((this.timeMs / 1000) * this.sampleRate))
    // One-pole coefficient per damping pass; 0 damping = transparent.
    const alpha = 1 - clamp(this.damping, 0, 1) * 0.85

    for (let i = 0; i < frames; i++) {
      this.buf[this.writeIx] = input[i]

      for (let k = 0; k < laneCount; k++) {
        const tapDelay = delaySamples * (k + 1)
        if (tapDelay >= this.cap) break
        let ix = this.writeIx - tapDelay
        if (ix < 0) ix += this.cap
        const dry = this.buf[ix] * Math.pow(this.feedback, k + 1)
        // Cascaded damping: repeat k has passed the lowpass k+1 times, which
        // one running state per tap approximates closely enough at echo rates.
        this.lp[k] += (dry - this.lp[k]) * alpha
        const y = this.lp[k]
        bus.lanes[laneOffset + k][i] += y
        const mag = y < 0 ? -y : y
        this.levels[k] = mag > this.levels[k] ? mag : this.levels[k] * 0.9995
      }

      this.writeIx = (this.writeIx + 1) % this.cap
    }
  }

  snapshotVoices(out: Float32Array, at: number, max: number): number {
    const n = Math.min(this.laneCount, max)
    for (let k = 0; k < n; k++) {
      out[at + k * 3] = this.azimuths[k]
      out[at + k * 3 + 1] = this.elevations[k]
      out[at + k * 3 + 2] = this.levels[k]
    }
    return n
  }

  private ensureLaneArrays(laneCount: number): void {
    if (this.lp.length >= laneCount) return
    // Grows only on lane-count change (engine constant), not per block.
    this.lp = new Float32Array(laneCount)
    this.levels = new Float32Array(laneCount)
    this.azimuths = new Float32Array(laneCount)
    this.elevations = new Float32Array(laneCount)
    this.needsDraw = true
  }
}
