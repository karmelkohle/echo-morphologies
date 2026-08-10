/**
 * Ambient declarations for AudioWorkletGlobalScope.
 *
 * TypeScript's DOM library describes the main-thread half of Web Audio
 * (`AudioWorkletNode`) but not the scope the processor itself runs in, so the
 * globals below have to be declared by hand.
 */

/** Sample rate of the AudioContext that loaded this module. */
declare const sampleRate: number

/** Frames rendered by the context since it was created. */
declare const currentFrame: number

/** Context time in seconds at the start of the current block. */
declare const currentTime: number

interface AudioWorkletProcessorBase {
  readonly port: MessagePort
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessorBase
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessorBase
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessorBase & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean
  },
): void
