/**
 * The engine ABI.
 *
 * Everything under `src/engine/` is deliberately platform-free: no Web Audio,
 * no DOM, no `window`, no `AudioWorkletProcessor`. It sees planar float buffers
 * and a frame count, nothing else. That is the whole portability strategy —
 * the host (Web Audio today, AVAudioEngine tomorrow) owns devices, permissions
 * and buffers; the engine owns sound.
 *
 * The shape below is chosen to survive the move to WebAssembly. `prepare` /
 * `process` / `reset` is the same contract as `msf::Processor` in the spatdsp
 * C++ library, and `process(planar in, planar out, frames)` maps onto a wasm
 * export taking two heap pointers and a frame count with no redesign:
 *
 *     void engine_prepare(float sample_rate, int max_block, int n_in, int n_out);
 *     void engine_process(const float* const* in, float* const* out, int frames);
 *     void engine_set_param(int id, float value);
 *     void engine_read_meters(float* dst);
 *
 * See docs/ARCHITECTURE.md for the migration notes.
 */

/** Everything the engine needs to size its buffers and derive coefficients. */
export interface EngineConfig {
  /** Host sample rate in Hz. */
  sampleRate: number
  /** Largest `frames` value `process()` will ever be handed. */
  maxBlockSize: number
  /** Capture channels. One, by design — see the mono-source note in the README. */
  numInputChannels: number
  /** Render channels. Two: the binaural stage is the end of the chain. */
  numOutputChannels: number
}

/**
 * A single link in the signal chain. Stages are owned by {@link EngineCore},
 * never by the host, and must not allocate inside `process()`.
 */
export interface Stage {
  prepare(cfg: EngineConfig): void
  reset(): void
}

/**
 * The contract the audio thread calls into.
 *
 * Implemented today by the TypeScript {@link EngineCore}; the WebAssembly build
 * will implement the same interface behind a thin wrapper so the worklet does
 * not change.
 */
export interface AudioEngineCore {
  prepare(cfg: EngineConfig): void
  reset(): void
  /** Realtime-safe: may be called from the audio thread between blocks. */
  setParam(id: number, value: number): void
  /**
   * Render one block.
   *
   * @param input  Planar capture channels. May be empty (host not yet feeding
   *               audio) — implementations must treat that as silence.
   * @param output Planar render channels, fully overwritten.
   * @param frames Number of frames to render; never exceeds `maxBlockSize`.
   */
  process(input: readonly Float32Array[], output: readonly Float32Array[], frames: number): void
  /** Drains accumulated metering into `dst` and resets the accumulators. */
  readMeters(dst: Float32Array): void
}
