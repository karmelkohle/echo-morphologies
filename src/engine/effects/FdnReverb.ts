import type { DirectionalBus } from '../DirectionalBus'
import { Rng } from '../dsp/Rng'
import { clamp } from '../dsp/math'
import { SlotParam } from '../params'
import type { EngineConfig } from '../types'
import { SpatialTarget, type SpatialEffect } from './SpatialEffect'

/**
 * Feedback-delay-network late reverberation — spatdsp's `msf::FdnReverb`
 * (IRCAM/Jot family) at half size for the phone budget:
 *
 * - 8 mutually-prime delay lines coupled through a Householder feedback
 *   matrix (lossless, maximally mixing, O(M) per sample).
 * - Exact broadband T60 via per-line loop gain g = 10^(−3·D/(T60·fs)); HF
 *   damping as a one-pole inside the loop.
 * - Slow staggered delay modulation breaks up metallic modes.
 * - The lines fold onto the slot's lanes with alternating sign (line k →
 *   lane k mod N), so the tail arrives as N mutually decorrelated sources
 *   scattered around the slot's target — a spatially diffuse field, the
 *   msf::SpatialReverb recipe on this app's directional bus.
 */

const LINES = 8
/** Every other length from msf's 16-line table — same spread, half the cost. */
const LEN_MS = [19.1, 27.7, 37.3, 43.7, 53.5, 61.7, 71.3, 83.7]
const MAX_PREDELAY_MS = 250

export class FdnReverb implements SpatialEffect {
  t60 = 2.6
  damping = 0.3
  predelayMs = 24

  private sampleRate = 48000
  private lines: Float32Array[] = []
  private lineLen: number[] = []
  private writeIx: number[] = []
  private delaySmp: number[] = []
  private gains: number[] = []
  private lp = new Float32Array(LINES)
  private lfoPhase = new Float32Array(LINES)
  private lfoInc = new Float32Array(LINES)
  /** Per-sample line outputs; a field so process() never allocates. */
  private readonly lineOut = new Float32Array(LINES)

  private predelayBuf = new Float32Array(0)
  private predelayIx = 0

  private laneCount = 4
  private azimuths = new Float32Array(0)
  private elevations = new Float32Array(0)
  private levels = new Float32Array(0)
  private needsDraw = true
  private readonly rng: Rng

  constructor(
    private readonly target: SpatialTarget,
    seed: number,
  ) {
    this.rng = new Rng(seed >>> 0 || 0xfd4)
  }

  prepare(cfg: EngineConfig): void {
    this.sampleRate = cfg.sampleRate
    this.lines = []
    this.lineLen = []
    this.writeIx = []
    for (let k = 0; k < LINES; k++) {
      // Room-size headroom ×1.1 over the base length, plus mod depth.
      const len = Math.ceil((LEN_MS[k] / 1000) * cfg.sampleRate * 1.1) + 16
      this.lines.push(new Float32Array(len))
      this.lineLen.push(len)
      this.writeIx.push(0)
      // Slow, staggered mod rates (0.07 .. 1.0 Hz), as in msf.
      const rate = 0.07 + (0.93 * k) / (LINES - 1)
      this.lfoInc[k] = (2 * Math.PI * rate) / cfg.sampleRate
    }
    this.predelayBuf = new Float32Array(Math.ceil((MAX_PREDELAY_MS / 1000) * cfg.sampleRate) + 8)
    this.updateDelays()
    this.updateGains()
    this.reset()
  }

  reset(): void {
    for (const line of this.lines) line.fill(0)
    this.predelayBuf.fill(0)
    this.predelayIx = 0
    this.lp.fill(0)
    this.lfoPhase.fill(0)
    this.levels.fill(0)
    this.needsDraw = true
  }

  setLocal(local: number, value: number): void {
    switch (local) {
      case SlotParam.ReverbT60:
        this.t60 = clamp(value, 0.1, 30)
        this.updateGains()
        break
      case SlotParam.ReverbDamping:
        this.damping = clamp(value, 0, 1)
        break
      case SlotParam.ReverbPredelayMs:
        this.predelayMs = clamp(value, 0, MAX_PREDELAY_MS)
        break
    }
  }

  /** The slot's target moved; the diffuse field re-anchors around it. */
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
    for (let k = 0; k < laneCount; k++) {
      const direction = bus.directions[laneOffset + k]
      direction.azimuthDeg = this.azimuths[k]
      direction.elevationDeg = this.elevations[k]
      direction.distanceM = 1
    }

    const damp = clamp(this.damping, 0, 1) * 0.7
    const odamp = 1 - damp
    const invM = 2 / LINES
    const laneNorm = 1 / Math.sqrt(LINES / laneCount)
    const predelaySamples = Math.min(
      this.predelayBuf.length - 1,
      Math.round((this.predelayMs / 1000) * this.sampleRate),
    )
    const v = this.lineOut

    for (let i = 0; i < frames; i++) {
      // Predelay on the way in.
      this.predelayBuf[this.predelayIx] = input[i]
      let readIx = this.predelayIx - predelaySamples
      if (readIx < 0) readIx += this.predelayBuf.length
      const x = this.predelayBuf[readIx]
      this.predelayIx = (this.predelayIx + 1) % this.predelayBuf.length

      // 1) modulated reads + in-loop damping + decay gain
      let sum = 0
      for (let k = 0; k < LINES; k++) {
        const mod = 3 * Math.sin(this.lfoPhase[k])
        this.lfoPhase[k] += this.lfoInc[k]
        if (this.lfoPhase[k] >= 2 * Math.PI) this.lfoPhase[k] -= 2 * Math.PI
        const line = this.lines[k]
        const len = this.lineLen[k]
        // Interpolated read `delay+mod` samples behind the write head.
        let pos = this.writeIx[k] - (this.delaySmp[k] + mod)
        while (pos < 0) pos += len
        const i0 = Math.floor(pos) % len
        const i1 = (i0 + 1) % len
        const fr = pos - Math.floor(pos)
        const d = line[i0] * (1 - fr) + line[i1] * fr
        this.lp[k] = damp * this.lp[k] + odamp * d
        const vk = this.lp[k] * this.gains[k]
        v[k] = vk
        sum += vk
      }

      // 2) fold the decorrelated lines onto the lanes, alternating sign
      for (let k = 0; k < LINES; k++) {
        const lane = laneOffset + (k % laneCount)
        const sgn = Math.floor(k / laneCount) & 1 ? -1 : 1
        bus.lanes[lane][i] += sgn * v[k] * laneNorm
      }

      // 3) Householder feedback (y = v − (2/M)·Σv) + input injection
      const fbc = invM * sum
      for (let k = 0; k < LINES; k++) {
        const line = this.lines[k]
        line[this.writeIx[k]] = v[k] - fbc + (k & 1 ? -x : x)
        this.writeIx[k] = (this.writeIx[k] + 1) % this.lineLen[k]
      }
    }

    // Lane level followers for the plot, once per block.
    for (let k = 0; k < laneCount; k++) {
      const lane = bus.lanes[laneOffset + k]
      let peak = 0
      for (let i = 0; i < frames; i++) {
        const m = lane[i] < 0 ? -lane[i] : lane[i]
        if (m > peak) peak = m
      }
      this.levels[k] = peak > this.levels[k] ? peak : this.levels[k] * 0.94
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

  private updateDelays(): void {
    this.delaySmp = LEN_MS.map((lenMs) => (lenMs / 1000) * this.sampleRate)
  }

  private updateGains(): void {
    this.gains = this.delaySmp.map((d) => Math.pow(10, (-3 * (d / this.sampleRate)) / this.t60))
  }

  private ensureLaneArrays(laneCount: number): void {
    if (this.azimuths.length >= laneCount) return
    this.azimuths = new Float32Array(laneCount)
    this.elevations = new Float32Array(laneCount)
    this.levels = new Float32Array(laneCount)
    this.needsDraw = true
  }
}
