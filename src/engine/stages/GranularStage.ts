import type { DirectionalBus } from '../DirectionalBus'
import { Rng } from '../dsp/Rng'
import { clamp, dbToGain } from '../dsp/math'
import type { EngineConfig, Stage } from '../types'

/**
 * Granular re-composition of the captured stream — a TypeScript port of the
 * spatdsp design (`msf::Granular` + `GranularExpander`), kept close enough
 * that figures and behavior transfer between the two codebases:
 *
 * - Rolling capture ring buffer; grains read *the past* through an
 *   interpolated tap, so the buffer is the delay line and the grain source
 *   at once. The seam guard in {@link read} matches msf exactly.
 * - Sample-accurate onset scheduling: a countdown in samples places each
 *   onset at its true in-block offset instead of quantizing to block edges.
 *   Sync (metronomic, sr/density) and Poisson (exponential inter-onset,
 *   seeded) schedulers, as in msf.
 * - Per-grain parameter draws at spawn: length, pitch and read delay each
 *   jitter around their base by a deviation range — msf's DeviationParam
 *   paradigm applied per grain (uniform law).
 * - Each grain draws a direction (target azimuth/elevation ± deviation) and
 *   is dealt onto a lane round-robin (msf::LaneRotor). The lane's direction
 *   is set to the grain's at spawn, so the binaural stage renders each grain
 *   stream from its own place — msf's `process_lanes` model on the
 *   DirectionalBus.
 * - Reversed grains store a negative playback rate; the tap then walks deeper
 *   into the past, msf's exact mechanism.
 *
 * Differences from msf, both deliberate:
 * - An explicit read-delay parameter (base ± deviation) positions the tap
 *   behind realtime; msf's non-frozen mode always reads just behind the head.
 * - Freeze/loop, pitch quantization and the structured jitter laws are not
 *   ported yet — they layer onto this without moving anything.
 *
 * Realtime rules hold: everything is sized in `prepare()`, `process()`
 * allocates nothing.
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
}

const MAX_GRAINS = 64
/** Ring allocation ceiling; the buffer-size parameter selects a window of it. */
const MAX_BUFFER_SEC = 20

export class GranularStage implements Stage {
  // ── parameters (set from EngineCore, read at spawn time) ─────────────────
  enabled = true
  bufferSec = 8
  delayMs = 250
  delayDevMs = 120
  density = 25
  lengthMs = 90
  /** Relative jitter 0..1 on the grain length. */
  lengthJitter = 0.35
  pitchSemis = 0
  pitchDevSemis = 0
  reverseProb = 0
  envShape: GrainEnvShape = GrainEnvShape.Hann
  scheduler: GrainScheduler = GrainScheduler.Sync
  /** Per-grain level scatter below 0 dB, matching msf's gain jitter. */
  gainDevDb = 1.5
  // Direction the cloud is composed around, and how far grains stray from it.
  azimuthDeg = 0
  azimuthDevDeg = 40
  elevationDeg = 0
  elevationDevDeg = 15

  // ── state ────────────────────────────────────────────────────────────────
  private sampleRate = 48000
  private buf = new Float32Array(0)
  private cap = 0
  private writeIx = 0
  private readonly grains: Grain[] = []
  private spawnCountdown = 0
  private spawnCount = 0
  private laneSeq = 0
  private readonly rng = new Rng()
  private readonly schedRng = new Rng()
  private seedBase = 0xc0ffee

  prepare(cfg: EngineConfig): void {
    this.sampleRate = cfg.sampleRate
    this.cap = Math.ceil(MAX_BUFFER_SEC * cfg.sampleRate)
    this.buf = new Float32Array(this.cap)
    this.grains.length = 0
    for (let i = 0; i < MAX_GRAINS; i++) this.grains.push(new Grain())
    this.seedBase = 0xc0ffee
    this.reset()
  }

  reset(): void {
    this.buf.fill(0)
    this.writeIx = 0
    for (const g of this.grains) g.active = false
    this.spawnCountdown = 0
    this.spawnCount = 0
    this.laneSeq = 0
    this.rng.seed(this.seedBase)
    this.schedRng.seed(this.seedBase ^ 0x5c4ed)
  }

  activeGrainCount(): number {
    let n = 0
    for (const g of this.grains) if (g.active) n++
    return n
  }

  /**
   * @param input Mono capture for this block.
   * @param bus   Destination field, zeroed by the caller. Lanes are ADDED to —
   *             grains accumulate, and the additive contract matches
   *             `msf::SourceExpander` so the C++ implementation drops in.
   *             Directions are assigned at spawn, not accumulated.
   */
  process(input: Float32Array, bus: DirectionalBus, frames: number): void {
    if (!this.enabled) {
      // Bypass: the capture arrives dry on lane 0, straight ahead — the
      // smoke test's reference path, and an honest A/B for the ear. Grains
      // in flight are retired, not paused: their read taps would be ancient
      // by the time the stage re-enables, and a paused grain would resurrect
      // as a burst from the distant past.
      for (const g of this.grains) g.active = false
      const lane = bus.lanes[0]
      const n = Math.min(frames, lane.length)
      for (let i = 0; i < n; i++) lane[i] += input[i]
      const d = bus.directions[0]
      d.azimuthDeg = 0
      d.elevationDeg = 0
      d.distanceM = 1
      return
    }

    this.writeInput(input, frames)
    this.schedule(frames, bus)

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
        out[t] += grainEnvelope(g.env, g.elapsed, g.length) * this.read(g.samplesAgo) * g.gain
        g.samplesAgo -= g.pitch
        g.elapsed++
      }
    }
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
  private read(samplesAgo: number): number {
    const used = this.usedCap()
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

  private schedule(n: number, bus: DirectionalBus): void {
    if (this.density <= 0) return
    const per = this.sampleRate / this.density
    this.spawnCountdown -= n
    while (this.spawnCountdown <= 0) {
      // Due at in-block sample n + countdown (countdown ≤ 0 here), so onsets
      // land sr/density apart instead of quantizing to block boundaries.
      const off = clamp(Math.floor(n + this.spawnCountdown), 0, n - 1)
      this.spawn(off, bus)
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

  private spawn(startOffset: number, bus: DirectionalBus): void {
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

    const azimuth = this.azimuthDeg + this.centered(this.azimuthDevDeg)
    const elevation = clamp(this.elevationDeg + this.centered(this.elevationDevDeg), -90, 90)

    let reversed = false
    if (this.reverseProb > 0) reversed = 0.5 * (this.rng.nextBipolar() + 1) < this.reverseProb

    const used = this.usedCap()
    // msf spawns at len·pf so a sped-up grain cannot overrun the write head;
    // the read-delay parameter then pushes the tap further into the past.
    const delaySamples = Math.max(0, ((this.delayMs + this.centered(this.delayDevMs)) / 1000) * this.sampleRate)
    let ago = len * Math.max(pf, 1) + delaySamples
    // A reversed grain walks a further len·(1+pf) into the past; keep its
    // whole path inside the window so it does not fade into the seam guard.
    const travel = reversed ? len * (1 + pf) : 0
    ago = clamp(ago, 1, Math.max(1, used - 2 - travel))

    slot.active = true
    slot.elapsed = 0
    slot.length = len
    slot.delay = startOffset
    slot.samplesAgo = ago
    slot.pitch = reversed ? -pf : pf
    slot.gain = gain
    slot.env = this.envShape

    // Round-robin lane dealing (msf::LaneRotor); the lane takes the grain's
    // direction at spawn, so the renderer follows the newest occupant.
    const laneCount = Math.max(1, bus.laneCount)
    slot.lane = this.laneSeq % laneCount
    this.laneSeq++
    const direction = bus.directions[slot.lane]
    direction.azimuthDeg = azimuth
    direction.elevationDeg = elevation
    direction.distanceM = 1

    this.spawnCount++
  }
}
