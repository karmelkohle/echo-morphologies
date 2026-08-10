/**
 * Messages across the audio-thread boundary.
 *
 * Shared by both sides so a change to one end fails to compile at the other.
 *
 * Everything here is `postMessage`, not shared memory. `SharedArrayBuffer` is
 * the obvious way to hand meters back without allocating, but it needs
 * cross-origin isolation (COOP + COEP), and GitHub Pages cannot send those
 * headers. Eight numbers thirty times a second is a cost worth paying to keep
 * the app deployable on static hosting; see docs/ARCHITECTURE.md if that trade
 * ever needs revisiting.
 */

export const PROCESSOR_NAME = 'engine-processor'

/** Main thread → audio thread. */
export type CommandMessage =
  | { type: 'param'; id: number; value: number }
  | { type: 'reset' }
  /** How often to report meters, in milliseconds. 0 stops reporting. */
  | { type: 'meterInterval'; ms: number }
  /**
   * A parsed HRIR set, already resampled to the context rate — the heavy
   * loops happen on the main thread and the arrays travel in the transfer
   * list, so the audio thread only reassembles. `label` is echoed back in the
   * status so the interface can say which set is actually rendering, not
   * which one it last asked for.
   */
  | { type: 'hrir'; label: string; set: import('../engine/hrir/HrirSet').HrirSetParts }

/** Audio thread → main thread. */
export type StatusMessage =
  | {
      type: 'ready'
      sampleRate: number
      blockSize: number
    }
  | {
      type: 'hrirStatus'
      ok: boolean
      label: string
      /** Filled when ok. */
      positions?: number
      taps?: number
      /** True when the IRs were interpolated to the context rate at load. */
      resampled?: boolean
      /** Filled when not ok. */
      error?: string
    }
  | {
      type: 'meters'
      /** Laid out per `MeterSlot` in engine/meters.ts. */
      values: number[]
      /**
       * Render blocks processed since the engine started. The main thread
       * compares its rate against `sampleRate / blockSize` to show whether the
       * graph is really keeping up — the smoke test's proof of life.
       */
      blocks: number
      /**
       * Discontinuities in the render clock: blocks whose start frame was not
       * exactly one quantum after the previous one. On iOS this is what a
       * suspend/resume, an incoming call or a Bluetooth route change looks
       * like from inside the audio thread.
       */
      clockGaps: number
    }
