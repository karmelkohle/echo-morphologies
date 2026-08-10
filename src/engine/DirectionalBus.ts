/**
 * The intermediate signal between granulation and binaural rendering.
 *
 * Why this exists, rather than granular writing mono and binaural reading mono:
 * the point of the piece is that each grain sits at its own composed position.
 * A mono hand-off between the two stages would throw that away before the
 * renderer ever saw it, and no amount of downstream spatialisation gets it back.
 *
 * So the granulator does not output a signal, it outputs a *field*: a small set
 * of lanes, each tagged with a direction, that the renderer convolves with the
 * matching HRIR pair and sums. Grains are assigned to the lane nearest their
 * intended direction, which bounds the work at `laneCount` convolutions per
 * block no matter how dense the cloud gets — the same trick `msf`'s spatial
 * reverb uses when it encodes its late field at 16 Fibonacci directions.
 *
 * This is `msf::SourceExpander` in miniature: mono in, N tagged lanes out.
 */

/**
 * A position on the sphere around the listener.
 *
 * Convention is shared with the spatdsp/msf library so figures move between the
 * two without conversion: degrees throughout, azimuth 0° = straight ahead and
 * positive counter-clockwise over [-180, +180], elevation over [-90, +90],
 * distance in metres with 1 m as the reference.
 */
export interface Direction {
  azimuthDeg: number
  elevationDeg: number
  distanceM: number
}

export const FRONT: Direction = { azimuthDeg: 0, elevationDeg: 0, distanceM: 1 }

/** Planar lanes plus the direction each lane is rendered from. */
export class DirectionalBus {
  readonly lanes: Float32Array[] = []
  readonly directions: Direction[] = []

  constructor(
    readonly laneCount: number,
    maxBlockSize: number,
  ) {
    for (let i = 0; i < laneCount; i++) {
      this.lanes.push(new Float32Array(maxBlockSize))
      this.directions.push({ ...FRONT })
    }
  }

  /** Zero the audio in every lane. Directions are left alone. */
  clear(frames: number): void {
    for (const lane of this.lanes) lane.fill(0, 0, frames)
  }
}
