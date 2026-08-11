import type { DirectionalBus } from '../DirectionalBus'
import type { Rng } from '../dsp/Rng'
import { clamp } from '../dsp/math'
import type { EngineConfig } from '../types'

/**
 * The contract every effect module in this folder implements.
 *
 * An effect is a mono-in → directional-field-out processor: it reads the
 * capture block and ADDS into a contiguous window of bus lanes
 * (`laneOffset .. laneOffset+laneCount`), setting each lane's direction as
 * its material demands — per grain, per echo repeat, per reverb line, per
 * partial. The binaural renderer downstream neither knows nor cares which
 * effect fed a lane.
 *
 * To add an effect: one class here, one entry in params.ts (EFFECTS +
 * EFFECT_LOCALS + its local specs), one case in EngineCore's effect factory.
 * The GUI, the pipeline plumbing and the renderer pick it up from there.
 *
 * Realtime rules as everywhere in the engine: size in prepare(), never
 * allocate in process().
 */
export interface SpatialEffect {
  prepare(cfg: EngineConfig): void
  reset(): void
  /** Receives this slot's effect-local params (SlotParam ids 10+). */
  setLocal(local: number, value: number): void
  process(
    input: Float32Array,
    bus: DirectionalBus,
    laneOffset: number,
    laneCount: number,
    frames: number,
  ): void
  /**
   * Appends up to `max` sounding voices as (azimuthDeg, elevationDeg, level)
   * triples starting at out[at], for the interface's polar plot. Returns how
   * many voices it wrote. Level is linear, roughly 0..1.
   */
  snapshotVoices(out: Float32Array, at: number, max: number): number
}

/**
 * Where a pipeline aims, and how far its material strays — the slot-level
 * half of msf's deviation paradigm. Effects draw directions from this at
 * whatever rate their material calls for.
 */
export class SpatialTarget {
  azimuthDeg = 0
  azimuthDevDeg = 40
  elevationDeg = 0
  elevationDevDeg = 15

  /** One drawn azimuth: target ± spread. Not wrapped; HRIR lookup is on the sphere. */
  drawAzimuth(rng: Rng): number {
    return this.azimuthDeg + rng.nextBipolar() * this.azimuthDevDeg
  }

  /** One drawn elevation, clamped to the sphere. */
  drawElevation(rng: Rng): number {
    return clamp(this.elevationDeg + rng.nextBipolar() * this.elevationDevDeg, -90, 90)
  }
}
