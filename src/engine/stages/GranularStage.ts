import type { DirectionalBus } from '../DirectionalBus'
import { FRONT } from '../DirectionalBus'
import type { EngineConfig, Stage } from '../types'

/**
 * Granular re-composition of the captured stream. **Currently a pass-through.**
 *
 * The stage is wired into the chain and owns the right boundaries, but the
 * grain scheduler is not written yet — it copies the capture into lane 0 and
 * leaves the rest of the field silent, so the smoke test hears its own input.
 *
 * What lands here:
 *
 * - A capture ring buffer, a few seconds long, written by `process()` and read
 *   at an offset. Grains are read from the past, so the buffer is the delay
 *   line and the grain source at once.
 * - A grain scheduler emitting onsets at a density, each grain taking a
 *   read position, a duration, a playback rate and a window from the parameter
 *   set plus a deterministic RNG (seeded, so a walk can be reproduced).
 * - A position composer assigning every grain a {@link Direction}. This is the
 *   artistic core: with one microphone there is no direction of arrival to
 *   recover, so direction is composed rather than measured.
 * - Accumulation into the nearest lane of the {@link DirectionalBus}.
 *
 * `msf`'s `granular_expander.hpp` already does this in C++ against the same lane
 * model; porting it through Emscripten is the intended path, not a rewrite.
 */
export class GranularStage implements Stage {
  private frames = 0

  prepare(cfg: EngineConfig): void {
    this.frames = cfg.maxBlockSize
    this.reset()
  }

  reset(): void {
    // No state yet. The ring buffer and the live grain list are zeroed here.
  }

  /**
   * @param input Mono capture for this block.
   * @param bus   Destination field, zeroed by the caller. Lanes are ADDED to —
   *             grains accumulate, and the additive contract matches
   *             `msf::SourceExpander` so the C++ implementation drops in.
   *             Directions are assigned, not accumulated.
   */
  process(input: Float32Array, bus: DirectionalBus, frames: number): void {
    // Pass-through placeholder: the whole capture arrives dry, straight ahead.
    const lane = bus.lanes[0]
    const n = Math.min(frames, lane.length, this.frames)
    for (let i = 0; i < n; i++) lane[i] += input[i]

    const direction = bus.directions[0]
    direction.azimuthDeg = FRONT.azimuthDeg
    direction.elevationDeg = FRONT.elevationDeg
    direction.distanceM = FRONT.distanceM
  }
}
