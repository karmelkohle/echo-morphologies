import type { DirectionalBus } from '../DirectionalBus'
import type { EngineConfig, Stage } from '../types'

/**
 * HRTF rendering of the directional field to a pair of ears.
 * **Currently a pass-through.**
 *
 * The stage sums every lane equally into both channels — correct plumbing,
 * no spatialisation. A dual-mono sum is the honest placeholder: it makes no
 * claim about position, where a fake ILD/ITD pan would sound like the renderer
 * is working when it is not.
 *
 * What lands here:
 *
 * - The HRIR set, 256 taps per ear across roughly 20 000 positions. At float32
 *   that is 20 000 × 256 × 2 × 4 B ≈ 41 MB resident, loaded once at start-up;
 *   int16 with a per-position scale halves it, which is worth having on iOS
 *   where a tab's memory budget is not generous.
 * - A nearest-position lookup by direction. The brief calls this the main
 *   subtlety and it is: a linear scan of 20 000 positions per grain is not
 *   viable, so the set needs an index — bucketed equirectangular bins with a
 *   neighbour search, or a spherical KD-tree. Decide before the set is loaded,
 *   because the index shape wants to match the storage layout.
 * - Partitioned uniform-block convolution per lane. At 256 taps and 128-frame
 *   quanta that is two partitions per ear; frequency-domain with a cached
 *   forward transform of the input block, shared across lanes.
 * - Crossfading when a lane's direction changes, so movement does not click.
 *
 * `msf`'s `binaural_speaker.hpp` holds the per-position HRIR convolution matrix
 * this maps onto, and `image_source.hpp` covers the room-response half of the
 * brief once the direct path works.
 */
export class BinauralStage implements Stage {
  private maxBlockSize = 0

  prepare(cfg: EngineConfig): void {
    this.maxBlockSize = cfg.maxBlockSize
    this.reset()
  }

  reset(): void {
    // No state yet. Convolution tails and crossfade state are cleared here.
  }

  /**
   * @param bus   Directional field for this block.
   * @param left  Left-ear output, zeroed by the caller and ADDED to.
   * @param right Right-ear output, same.
   *
   * Additive because the real renderer sums one convolution per lane; writing
   * the ears rather than accumulating them would mean the last lane wins.
   */
  process(bus: DirectionalBus, left: Float32Array, right: Float32Array, frames: number): void {
    const n = Math.min(frames, this.maxBlockSize)

    // Pass-through placeholder: sum the field, ignore its directions.
    for (const lane of bus.lanes) {
      for (let i = 0; i < n; i++) {
        const x = lane[i]
        left[i] += x
        right[i] += x
      }
    }
  }
}
