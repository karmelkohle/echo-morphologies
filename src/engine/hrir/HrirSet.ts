/**
 * An HRIR set in the app's binary format (see scripts/sofa-to-hrir.mjs for
 * the layout and for why SOFA itself never reaches the browser).
 *
 * Platform-free on purpose: parsing takes an ArrayBuffer, lookup takes angles.
 * The host fetches the bytes; a native port hands them over the same way.
 */

import { clamp } from '../dsp/math'

const MAGIC = 0x52495248 // 'HRIR'
const DEG = Math.PI / 180

/**
 * The flat form a set travels in between threads. Parsing and resampling are
 * loops over megabytes — main-thread work; the audio thread reassembles from
 * these parts without touching a sample.
 */
export interface HrirSetParts {
  sampleRate: number
  positionCount: number
  taps: number
  resampled: boolean
  positions: Float32Array
  irs: Float32Array
  vectors: Float32Array
}

export class HrirSet {
  private constructor(
    /** Rate the IRs are valid at after any resampling. */
    readonly sampleRate: number,
    readonly positionCount: number,
    readonly taps: number,
    /** (azimuthDeg, elevationDeg) pairs, positionCount × 2. */
    readonly positions: Float32Array,
    /** positionCount × 2 ears × taps, left ear first. */
    readonly irs: Float32Array,
    /** Unit vectors per position, positionCount × 3, for nearest lookup. */
    private readonly vectors: Float32Array,
    /** True if the IRs were interpolated to a new rate at load. */
    readonly resampled: boolean,
  ) {}

  static parse(buffer: ArrayBuffer): HrirSet {
    const view = new DataView(buffer)
    if (buffer.byteLength < 24 || view.getUint32(0, true) !== MAGIC) {
      throw new Error('not an HRIR binary')
    }
    const version = view.getUint32(4, true)
    if (version !== 1) throw new Error(`unsupported HRIR format version ${version}`)

    const sampleRate = view.getFloat32(8, true)
    const count = view.getUint32(12, true)
    const taps = view.getUint32(16, true)
    const scale = view.getFloat32(20, true)

    const expected = 24 + count * 8 + count * 2 * taps * 2
    if (buffer.byteLength !== expected) {
      throw new Error(`HRIR binary is ${buffer.byteLength} bytes, expected ${expected}`)
    }

    const positions = new Float32Array(buffer, 24, count * 2).slice()
    const quantized = new Int16Array(buffer, 24 + count * 8, count * 2 * taps)
    const irs = new Float32Array(quantized.length)
    const dequant = scale / 32767
    for (let i = 0; i < quantized.length; i++) irs[i] = quantized[i] * dequant

    const vectors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const az = positions[i * 2] * DEG
      const el = positions[i * 2 + 1] * DEG
      const cosEl = Math.cos(el)
      // Az 0 = front (+x), CCW positive (+y is left), +z up — matching the
      // spatdsp convention the whole app speaks.
      vectors[i * 3] = cosEl * Math.cos(az)
      vectors[i * 3 + 1] = cosEl * Math.sin(az)
      vectors[i * 3 + 2] = Math.sin(el)
    }

    return new HrirSet(sampleRate, count, taps, positions, irs, vectors, false)
  }

  static fromParts(parts: HrirSetParts): HrirSet {
    return new HrirSet(
      parts.sampleRate,
      parts.positionCount,
      parts.taps,
      parts.positions,
      parts.irs,
      parts.vectors,
      parts.resampled,
    )
  }

  /** The transferable form; pass the buffers in the postMessage transfer list. */
  toParts(): { parts: HrirSetParts; transfer: ArrayBuffer[] } {
    const parts: HrirSetParts = {
      sampleRate: this.sampleRate,
      positionCount: this.positionCount,
      taps: this.taps,
      resampled: this.resampled,
      positions: this.positions,
      irs: this.irs,
      vectors: this.vectors,
    }
    return { parts, transfer: [this.positions.buffer, this.irs.buffer, this.vectors.buffer] as ArrayBuffer[] }
  }

  /** Base offset of the left-ear IR for position `index`; right follows. */
  irOffset(index: number, ear: 0 | 1): number {
    return (index * 2 + ear) * this.taps
  }

  /**
   * Index of the measured position nearest to a direction.
   *
   * A linear scan over unit-vector dot products: ~2 700 (Köln) to ~12 000
   * (FABIAN) multiply-adds, and it only runs when a lane's direction actually
   * changes — grain-spawn rate, not sample rate. Flat memory beats a tree at
   * these sizes; revisit only if a set with far more positions arrives.
   */
  nearest(azimuthDeg: number, elevationDeg: number): number {
    const az = azimuthDeg * DEG
    const el = clamp(elevationDeg, -90, 90) * DEG
    const cosEl = Math.cos(el)
    const x = cosEl * Math.cos(az)
    const y = cosEl * Math.sin(az)
    const z = Math.sin(el)

    const v = this.vectors
    let best = 0
    let bestDot = -2
    for (let i = 0; i < this.positionCount; i++) {
      const dot = x * v[i * 3] + y * v[i * 3 + 1] + z * v[i * 3 + 2]
      if (dot > bestDot) {
        bestDot = dot
        best = i
      }
    }
    return best
  }

  /**
   * Linear-interpolation resample of every IR to `targetRate`.
   *
   * Linear interpolation costs a little high-frequency accuracy; for a first
   * rendering path that is the right trade against shipping a resampler, and
   * the status panel says when it has happened. Positions are unchanged.
   */
  resampleTo(targetRate: number): HrirSet {
    if (Math.abs(targetRate - this.sampleRate) < 0.5) return this
    const ratio = this.sampleRate / targetRate
    const newTaps = Math.max(2, Math.round(this.taps / ratio))
    const irs = new Float32Array(this.positionCount * 2 * newTaps)

    for (let p = 0; p < this.positionCount * 2; p++) {
      const src = p * this.taps
      const dst = p * newTaps
      for (let t = 0; t < newTaps; t++) {
        const pos = t * ratio
        const i0 = Math.floor(pos)
        const i1 = Math.min(i0 + 1, this.taps - 1)
        const fr = pos - i0
        irs[dst + t] = this.irs[src + i0] * (1 - fr) + this.irs[src + i1] * fr
      }
    }

    return new HrirSet(targetRate, this.positionCount, newTaps, this.positions, irs, this.vectors, true)
  }
}
