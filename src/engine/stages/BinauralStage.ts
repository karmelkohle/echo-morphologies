import type { DirectionalBus } from '../DirectionalBus'
import type { HrirSet } from '../hrir/HrirSet'
import type { EngineConfig, Stage } from '../types'

/**
 * HRTF rendering of the directional field to a pair of ears.
 *
 * Each lane is convolved with the HRIR pair measured nearest to its direction
 * and the results sum — the plan `binaural_speaker.hpp` implements in msf,
 * with the lane count bounding the convolution count no matter how dense the
 * grain cloud is.
 *
 * Time-domain FIR, deliberately: at 128 taps (Köln @48 kHz) × 8 lanes × 2
 * ears × 128-frame blocks this is ~100 M multiply-adds per second, which a
 * phone's JIT handles — and the silent-lane skip below removes most of it at
 * ordinary grain densities, because a lane whose grains have died emits
 * nothing and is not convolved. The status panel's render-rate row is the
 * referee; partitioned FFT convolution is the documented next step if a
 * device disagrees.
 *
 * When a lane's direction moves to a different measured position, the lane
 * renders both IRs for one block and crossfades, so grain-rate direction
 * changes do not click. Until a set is loaded the stage falls back to the
 * directionless sum it started life as.
 */

/** Per-lane convolution state. */
class LaneState {
  /** Input history: `taps` samples of tail, then the current block. */
  history = new Float32Array(0)
  /** Index into the HRIR set the lane currently renders from. */
  irIndex = -1
  /** Previous index during a one-block crossfade, else -1. */
  fadeFromIndex = -1
  lastAzimuth = Number.NaN
  lastElevation = Number.NaN
  /** Samples of silence seen in a row; lets the convolution be skipped. */
  silentRun = 0
}

export class BinauralStage implements Stage {
  private maxBlockSize = 0
  private set: HrirSet | null = null
  private lanes: LaneState[] = []
  private historyLen = 0
  private laneCount = 8

  /** How many bus lanes to size state for; call before a set loads. */
  setLaneCount(count: number): void {
    this.laneCount = Math.max(1, count)
  }

  prepare(cfg: EngineConfig): void {
    this.maxBlockSize = cfg.maxBlockSize
    this.applySet(this.set)
    this.reset()
  }

  reset(): void {
    for (const lane of this.lanes) {
      lane.history.fill(0)
      lane.irIndex = -1
      lane.fadeFromIndex = -1
      lane.lastAzimuth = Number.NaN
      lane.lastElevation = Number.NaN
      lane.silentRun = 0
    }
  }

  /**
   * Swap the HRIR set (or clear it with null). Runs on the audio thread but
   * between render quanta (port message handling), which is where the lane
   * state is rebuilt — `process()` itself never allocates.
   */
  setHrir(set: HrirSet | null): void {
    this.set = set
    this.applySet(set)
  }

  get hrirSet(): HrirSet | null {
    return this.set
  }

  private applySet(set: HrirSet | null): void {
    this.lanes = []
    if (set === null) return
    this.historyLen = set.taps + this.maxBlockSize
    for (let i = 0; i < this.laneCount; i++) {
      const lane = new LaneState()
      lane.history = new Float32Array(this.historyLen)
      this.lanes.push(lane)
    }
  }

  /**
   * @param bus   Directional field for this block.
   * @param left  Left-ear output, zeroed by the caller and ADDED to.
   * @param right Right-ear output, same.
   */
  process(bus: DirectionalBus, left: Float32Array, right: Float32Array, frames: number): void {
    const n = Math.min(frames, this.maxBlockSize)
    const set = this.set

    if (set === null) {
      // No HRIRs yet: the directionless sum the smoke test's reference path
      // relies on — honest dual mono, no fake panning.
      for (const lane of bus.lanes) {
        for (let i = 0; i < n; i++) {
          const x = lane[i]
          left[i] += x
          right[i] += x
        }
      }
      return
    }

    const taps = set.taps
    for (let laneIx = 0; laneIx < bus.laneCount; laneIx++) {
      const input = bus.lanes[laneIx]
      // Sized in applySet(); a bus wider than laneCount clips to what exists
      // rather than allocating on the render path.
      if (laneIx >= this.lanes.length) break
      const state = this.lanes[laneIx]

      // ── silence skip ──────────────────────────────────────────────────────
      let silent = true
      for (let i = 0; i < n; i++) {
        if (input[i] !== 0) {
          silent = false
          break
        }
      }
      if (silent) {
        // The tail is only safe to skip once it had fully rung out BEFORE
        // this block — judged on the run of silence accumulated so far, not
        // including this block, or the last taps-worth of ring-out is
        // truncated at the block edge. At the moment skipping starts the
        // history is zeroed, exactly once: skipping without clearing would
        // leave pre-silence audio in the tail, and the next grain on this
        // lane would drag a ghost of it back out.
        const before = state.silentRun
        state.silentRun += n
        if (before >= taps) {
          if (before - n < taps) state.history.fill(0)
          continue
        }
      } else {
        state.silentRun = 0
      }

      // ── direction tracking ───────────────────────────────────────────────
      const direction = bus.directions[laneIx]
      if (direction.azimuthDeg !== state.lastAzimuth || direction.elevationDeg !== state.lastElevation) {
        state.lastAzimuth = direction.azimuthDeg
        state.lastElevation = direction.elevationDeg
        const next = set.nearest(direction.azimuthDeg, direction.elevationDeg)
        if (next !== state.irIndex) {
          state.fadeFromIndex = state.irIndex
          state.irIndex = next
        }
      }
      if (state.irIndex < 0) state.irIndex = set.nearest(0, 0)

      // ── history update ───────────────────────────────────────────────────
      // Layout: [taps of tail][block]. Shift the newest `taps` samples down,
      // append the block after them.
      const history = state.history
      history.copyWithin(0, n, taps + n)
      history.set(input.subarray(0, n), taps)

      // ── convolve ─────────────────────────────────────────────────────────
      const fading = state.fadeFromIndex >= 0
      this.convolveInto(set, state.irIndex, history, left, right, n, taps, fading ? 'in' : 'full')
      if (fading) {
        this.convolveInto(set, state.fadeFromIndex, history, left, right, n, taps, 'out')
        state.fadeFromIndex = -1
      }
    }
  }

  /**
   * FIR of one lane into both ears. `mode` shapes the block gain: 'full' is
   * unity, 'in'/'out' are the two halves of the one-block linear crossfade.
   */
  private convolveInto(
    set: HrirSet,
    irIndex: number,
    history: Float32Array,
    left: Float32Array,
    right: Float32Array,
    n: number,
    taps: number,
    mode: 'full' | 'in' | 'out',
  ): void {
    const irs = set.irs
    const leftBase = set.irOffset(irIndex, 0)
    const rightBase = set.irOffset(irIndex, 1)
    const fadeStep = mode === 'full' ? 0 : 1 / n

    for (let t = 0; t < n; t++) {
      // history index of "now": taps + t; ir[k] weights the sample k back.
      const base = taps + t
      let accL = 0
      let accR = 0
      for (let k = 0; k < taps; k++) {
        const x = history[base - k]
        accL += irs[leftBase + k] * x
        accR += irs[rightBase + k] * x
      }
      const gain = mode === 'full' ? 1 : mode === 'in' ? fadeStep * (t + 1) : 1 - fadeStep * (t + 1)
      left[t] += accL * gain
      right[t] += accR * gain
    }
  }
}
