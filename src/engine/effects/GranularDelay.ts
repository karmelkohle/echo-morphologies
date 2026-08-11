import type { DirectionalBus } from '../DirectionalBus'
import { Rng } from '../dsp/Rng'
import { clamp, dbToGain } from '../dsp/math'
import { SlotParam } from '../params'
import type { EngineConfig } from '../types'
import { SpatialTarget, type SpatialEffect } from './SpatialEffect'

/**
 * Granular re-composition of the captured stream — the spatdsp design
 * (`msf::Granular` + `GranularExpander`) as a pipeline effect:
 *
 * - Rolling capture ring; grains read the past through a seam-guarded
 *   interpolated tap. The ring is the delay line and the grain source at once.
 * - Sample-accurate onset scheduling, Sync and Poisson.
 * - Per-grain deviation draws (length, pitch, level, read delay) from the
 *   bit-compatible LCG; reversed grains as negative playback rates.
 * - Round-robin lane dealing (msf::LaneRotor); each grain draws its direction
 *   from the slot's SpatialTarget at spawn and stamps it on its lane.
 *
 * Extension over msf, as before: the explicit read-delay (base ± scatter)
 * that places the tap behind realtime. Freeze/loop, pitch quantization and
 * the structured jitter laws still layer on later.
 */

export const GrainEnvShape = {
  Hann: 0,
  Tukey: 1,
  Gaussian: 2,
  Triangle: 3,
} as const
export type GrainEnvShape = (typeof GrainEnvShape)[keyof typeof GrainEnvShape]

export const GrainScheduler = {
  Sync: 0,
  Poisson: 1,
} as const
export type GrainScheduler = (typeof GrainScheduler)[keyof typeof GrainScheduler]

/** Grain amplitude envelope in [0,1] at position t of `length` samples. */
export function grainEnvelope(shape: GrainEnvShape, t: number, length: number): number {
  if (length <= 1 || t < 0 || t >= length) return 0
  const p = t / (length - 1)
  switch (shape) {
    case GrainEnvShape.Hann:
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * p)
    case GrainEnvShape.Tukey: {
      const ha = 0.25 // half of alpha = 0.5
      if (p < ha) return 0.5 * (1 - Math.cos((Math.PI * p) / ha))
      if (p > 1 - ha) return 0.5 * (1 - Math.cos((Math.PI * (1 - p)) / ha))
      return 1
    }
    case GrainEnvShape.Gaussian: {
      const sigma = 1 / 6
      const d = (p - 0.5) / sigma
      return Math.exp(-0.5 * d * d)
    }
    case GrainEnvShape.Triangle:
      return p < 0.5 ? 2 * p : 2 * (1 - p)
  }
  return 0
}

/** Pool slot. A flat class, not an interface, so V8 keeps one hidden shape. */
class Grain {
  active = false
  elapsed = 0
  length = 0
  /** In-block onset offset; consumed in the spawn block. */
  delay = 0
  lane = 0
  /** Read-tap distance behind the write head, in samples (fractional). */
  samplesAgo = 0
  /** Playback ratio; negative = reversed (tap walks into the past). */
  pitch = 1
  gain = 1
  env: GrainEnvShape = GrainEnvShape.Hann
  /** Where this grain sounds — kept for the polar plot. */
  azimuthDeg = 0
  elevationDeg = 0
}

const MAX_GRAINS = 64
/** Ring allocation ceiling; the buffer-size parameter selects a window of it. */
const MAX_BUFFER_SEC = 20

export class GranularDelay implements SpatialEffect {
  // ── parameters (read at spawn time) ──────────────────────────────────────
  bufferSec = 8
  delayMs = 250
  delayDevMs = 120
  density = 25
  lengthMs = 90
  lengthJitter = 0.35
  pitchSemis = 0
  pitchDevSemis = 0
  reverseProb = 0
  envShape: GrainEnvShape = GrainEnvShape.Hann
  scheduler: GrainScheduler = GrainScheduler.Sync
  /** Per-grain level scatter below 0 dB, matching msf's gain jitter. */
  gainDevDb = 1.5

  // ── state ────────────────────────────────────────────────────────────────
  private sampleRate = 48000
  private buf = new Float32Array(0)
  private cap = 0
  private writeIx = 0
  private readonly grains: Grain[] = []
  private spawnCountdown = 0
  private laneSeq = 0
  private readonly rng: Rng
  private readonly schedRng: Rng
  private readonly seedBase: number

  constructor(
    private readonly target: SpatialTarget,
    seed: number,
  ) {
    this.seedBase = seed >>> 0 || 0xc0ffee
    this.rng = new Rng(this.seedBase)
    this.schedRng = new Rng(this.seedBase ^ 0x5c4ed)
  }

  prepare(cfg: EngineConfig): void {
    this.sampleRate = cfg.sampleRate
    this.cap = Math.ceil(MAX_BUFFER_SEC * cfg.sampleRate)
    this.buf = new Float32Array(this.cap)
    this.grains.length = 0
    for (let i = 0; i < MAX_GRAINS; i++) this.grains.push(new Grain())
    this.reset()
  }

  reset(): void {
    this.buf.fill(0)
    this.writeIx = 0
    for (const g of this.grains) g.active = false
    this.spawnCountdown = 0
    this.laneSeq = 0
    this.rng.seed(this.seedBase)
    this.schedRng.seed(this.seedBase ^ 0x5c4ed)
  }

  setLocal(local: number, value: number): void {
    switch (local) {
      case SlotParam.BufferSec:
        this.bufferSec = value
        break
      case SlotParam.DelayMs:
        this.delayMs = value
        break
      case SlotParam.DelayDevMs:
        this.delayDevMs = value
        break
      case SlotParam.Density:
        this.density = value
        break
      case SlotParam.LengthMs:
        this.lengthMs = value
        break
      case SlotParam.LengthJitter:
        this.lengthJitter = value
        break
      case SlotParam.PitchSemis:
        this.pitchSemis = value
        break
      case SlotParam.PitchDevSemis:
        this.pitchDevSemis = value
        break
      case SlotParam.ReverseProb:
        this.reverseProb = value
        break
      case SlotParam.EnvShape:
        this.envShape = Math.round(value) as GrainEnvShape
        break
      case SlotParam.Scheduler:
        this.scheduler = Math.round(value) as GrainScheduler
        break
    }
  }

  process(
    input: Float32Array,
    bus: DirectionalBus,
    laneOffset: number,
    laneCount: number,
    frames: number,
  ): void {
    this.writeInput(input, frames)
    this.schedule(frames, bus, laneOffset, laneCount)

    const used = this.usedCap()
    for (const g of this.grains) {
      if (!g.active) continue
      const out = bus.lanes[g.lane]
      const t0 = Math.min(g.delay, frames)
      g.delay = 0
      for (let t = t0; t < frames; t++) {
        if (g.elapsed >= g.length) {
          g.active = false
          break
        }
        out[t] += grainEnvelope(g.env, g.elapsed, g.length) * this.read(g.samplesAgo, used) * g.gain
        g.samplesAgo -= g.pitch
        g.elapsed++
      }
    }
  }

  snapshotVoices(out: Float32Array, at: number, max: number): number {
    let n = 0
    for (const g of this.grains) {
      if (!g.active || n >= max) continue
      out[at + n * 3] = g.azimuthDeg
      out[at + n * 3 + 1] = g.elevationDeg
      out[at + n * 3 + 2] = grainEnvelope(g.env, g.elapsed, g.length) * g.gain
      n++
    }
    return n
  }

  private writeInput(mono: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      this.buf[this.writeIx] = mono[i]
      this.writeIx = (this.writeIx + 1) % this.cap
    }
    // The write head moved on, so every open read tap recedes with it.
    for (const g of this.grains) if (g.active) g.samplesAgo += n
  }

  /** Interpolated tap `samplesAgo` behind the write head; msf's read(). */
  private read(samplesAgo: number, used: number): number {
    // used - 1: linear interpolation touches one sample older than the tap,
    // so a tap in (used-1, used) would blend across the ring seam.
    if (samplesAgo < 0 || samplesAgo >= used - 1) return 0
    let pos = this.writeIx - 1 - samplesAgo
    while (pos < 0) pos += this.cap
    const i0 = Math.floor(pos) % this.cap
    const i1 = (i0 + 1) % this.cap
    const fr = pos - Math.floor(pos)
    return this.buf[i0] * (1 - fr) + this.buf[i1] * fr
  }

  /** The window of the ring the buffer-size parameter exposes. */
  private usedCap(): number {
    const want = Math.ceil(clamp(this.bufferSec, 0.5, MAX_BUFFER_SEC) * this.sampleRate)
    return Math.min(want, this.cap)
  }

  private schedule(n: number, bus: DirectionalBus, laneOffset: number, laneCount: number): void {
    if (this.density <= 0) return
    const per = this.sampleRate / this.density
    this.spawnCountdown -= n
    while (this.spawnCountdown <= 0) {
      // Due at in-block sample n + countdown (countdown ≤ 0 here), so onsets
      // land sr/density apart instead of quantizing to block boundaries.
      const off = clamp(Math.floor(n + this.spawnCountdown), 0, n - 1)
      this.spawn(off, bus, laneOffset, laneCount)
      this.spawnCountdown += this.scheduler === GrainScheduler.Poisson ? this.poissonInterval(per) : per
    }
  }

  /** Exponential inter-onset time with mean `per` samples, floored at one. */
  private poissonInterval(per: number): number {
    const u = (this.schedRng.nextU32() >>> 8) / 16777216 // [0, 1)
    return Math.max(1, -per * Math.log(1 - u))
  }

  /** One deviation draw in [-half, +half]; msf's centered(). */
  private centered(half: number): number {
    return half <= 0 ? 0 : this.rng.nextBipolar() * half
  }

  private spawn(startOffset: number, bus: DirectionalBus, laneOffset: number, laneCount: number): void {
    let slot: Grain | null = null
    for (const g of this.grains) {
      if (!g.active) {
        slot = g
        break
      }
    }
    if (slot === null) return

    const lenMs = Math.max(1, this.lengthMs * (1 + this.centered(clamp(this.lengthJitter, 0, 1))))
    const len = Math.max(2, Math.round((lenMs / 1000) * this.sampleRate))
    const semis = this.pitchSemis + this.centered(this.pitchDevSemis)
    const pf = clamp(Math.pow(2, semis / 12), 1 / 32, 32)
    // Scatter below unity only: grains thin out, they never spike.
    const gain = dbToGain(-Math.abs(this.centered(this.gainDevDb)))

    const azimuth = this.target.drawAzimuth(this.rng)
    const elevation = this.target.drawElevation(this.rng)

    let reversed = false
    if (this.reverseProb > 0) reversed = 0.5 * (this.rng.nextBipolar() + 1) < this.reverseProb

    const used = this.usedCap()
    // msf spawns at len·pf so a sped-up grain cannot overrun the write head;
    // the read-delay parameter then pushes the tap further into the past.
    const delaySamples = Math.max(0, ((this.delayMs + this.centered(this.delayDevMs)) / 1000) * this.sampleRate)
    let ago = len * Math.max(pf, 1) + delaySamples
    // Keep the grain's whole path inside the window, or its back half fades
    // into the seam guard. A reversed grain walks len·(1+pf) deeper (aging
    // plus backwards playback); a slowed forward grain still drifts back by
    // len·(1−pf), because aging outruns its read rate.
    const travel = reversed ? len * (1 + pf) : len * Math.max(0, 1 - pf)
    ago = clamp(ago, 1, Math.max(1, used - 2 - travel))

    slot.active = true
    slot.elapsed = 0
    slot.length = len
    slot.delay = startOffset
    slot.samplesAgo = ago
    slot.pitch = reversed ? -pf : pf
    slot.gain = gain
    slot.env = this.envShape
    slot.azimuthDeg = azimuth
    slot.elevationDeg = elevation

    // Round-robin lane dealing (msf::LaneRotor); the lane takes the grain's
    // direction at spawn, so the renderer follows the newest occupant.
    const lane = laneOffset + (this.laneSeq % Math.max(1, laneCount))
    this.laneSeq++
    slot.lane = lane
    const direction = bus.directions[lane]
    direction.azimuthDeg = azimuth
    direction.elevationDeg = elevation
    direction.distanceM = 1
  }
}
