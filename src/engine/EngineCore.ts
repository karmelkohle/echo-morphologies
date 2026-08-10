import { DirectionalBus } from './DirectionalBus'
import { LevelMeter } from './dsp/LevelMeter'
import { Limiter } from './dsp/Limiter'
import { SmoothedValue } from './dsp/SmoothedValue'
import { dbToGain } from './dsp/math'
import { METER_SLOT_COUNT, MeterSlot } from './meters'
import { PARAM_BY_ID, ParamId } from './params'
import { BinauralStage } from './stages/BinauralStage'
import { GranularStage } from './stages/GranularStage'
import type { AudioEngineCore, EngineConfig } from './types'

/**
 * The whole signal chain, and the only place audio is touched.
 *
 *     capture ─▶ trim ─▶ granular ─▶ directional bus ─▶ binaural ─▶ gain ─▶ limiter ─▶ ears
 *                  │                                                  │        │
 *                input meter                                    mute ramp   output meters
 *
 * Granular and binaural are pass-throughs today (see their files); the rest is
 * real. That is the point of this commit — the frame is load-bearing, so the
 * DSP can be filled in one stage at a time without moving anything around it.
 *
 * Realtime rules this file obeys, and any future stage must too: no allocation,
 * no exceptions and no unbounded loops inside `process()`. Everything is sized
 * in `prepare()`.
 */
export class EngineCore implements AudioEngineCore {
  private cfg: EngineConfig = {
    sampleRate: 48000,
    maxBlockSize: 128,
    numInputChannels: 1,
    numOutputChannels: 2,
  }

  // Seeded from the parameter table, not from unity. The host sends the current
  // values immediately after connecting the node, but the audio thread renders
  // a block or two before they land — starting wide open would put a few
  // milliseconds of full-gain microphone into someone's ears, at the exact
  // moment they have just put the earbuds in.
  private readonly inputTrim = new SmoothedValue(defaultGain(ParamId.InputTrimDb))
  private readonly outputGain = new SmoothedValue(defaultGain(ParamId.OutputGainDb))
  private readonly muteGain = new SmoothedValue(defaultMuteGain())

  private readonly granular = new GranularStage()
  private readonly binaural = new BinauralStage()
  private readonly limiter = new Limiter()

  private readonly inputMeter = new LevelMeter()
  private readonly leftMeter = new LevelMeter()
  private readonly rightMeter = new LevelMeter()

  /** Scratch mono bus between capture and granulation. */
  private monoIn = new Float32Array(0)
  /** Silence handed to the chain when the host has no input connected. */
  private silence = new Float32Array(0)
  private bus = new DirectionalBus(1, 0)
  /** Fallback right channel for hosts that only give us one output channel. */
  private spareRight = new Float32Array(0)

  prepare(cfg: EngineConfig): void {
    this.cfg = { ...cfg }
    const { sampleRate, maxBlockSize } = this.cfg

    this.monoIn = new Float32Array(maxBlockSize)
    this.silence = new Float32Array(maxBlockSize)
    this.spareRight = new Float32Array(maxBlockSize)

    // One lane while the granulator is a pass-through. The count becomes a
    // spatial-resolution parameter once grains carry their own directions.
    this.bus = new DirectionalBus(1, maxBlockSize)

    for (const [param, smoothed] of this.smoothers()) {
      const spec = PARAM_BY_ID.get(param)
      smoothed.prepare(spec ? spec.smoothingMs : 20, sampleRate)
    }

    this.granular.prepare(this.cfg)
    this.binaural.prepare(this.cfg)
    this.limiter.prepare(sampleRate)

    this.reset()
  }

  reset(): void {
    // Parameters survive a reset; only the glide towards them is abandoned.
    this.inputTrim.settle()
    this.outputGain.settle()
    this.muteGain.settle()

    this.granular.reset()
    this.binaural.reset()
    this.limiter.reset()

    this.inputMeter.reset()
    this.leftMeter.reset()
    this.rightMeter.reset()
  }

  setParam(id: number, value: number): void {
    switch (id) {
      case ParamId.InputTrimDb:
        this.inputTrim.setTarget(dbToGain(value))
        break
      case ParamId.OutputGainDb:
        this.outputGain.setTarget(dbToGain(value))
        break
      case ParamId.Mute:
        // Ramped rather than switched: an instant mute on a loud signal is a
        // step to zero, which is a click.
        this.muteGain.setTarget(value >= 0.5 ? 0 : 1)
        break
      default:
        break
    }
  }

  process(input: readonly Float32Array[], output: readonly Float32Array[], frames: number): void {
    if (output.length === 0) return
    const n = Math.min(frames, this.cfg.maxBlockSize)

    const left = output[0]
    // A host that only hands us one output channel gets the left ear; nothing
    // reads `spareRight` back, it exists so the chain always has somewhere to
    // write and `process()` needs no per-sample branch.
    const right = output.length > 1 ? output[1] : this.spareRight

    // An input array that is absent, empty or short means the host is not
    // feeding us yet — the graph is connected before the stream flows. Silence
    // is the right reading, and it keeps the inner loop branch-free.
    const source = input.length > 0 ? input[0] : undefined
    const captured = source !== undefined && source.length >= n ? source : this.silence

    // ── capture ─────────────────────────────────────────────────────────────
    const mono = this.monoIn
    for (let i = 0; i < n; i++) {
      mono[i] = captured[i] * this.inputTrim.next()
    }
    this.inputMeter.accumulate(mono, n)

    // ── engine ──────────────────────────────────────────────────────────────
    this.granular.process(mono, this.bus, n)
    this.binaural.process(this.bus, left, right, n)

    // ── output ──────────────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const gain = this.outputGain.next() * this.muteGain.next()
      left[i] *= gain
      right[i] *= gain
    }
    this.limiter.process(left, right, n)

    this.leftMeter.accumulate(left, n)
    this.rightMeter.accumulate(right, n)
  }

  readMeters(dst: Float32Array): void {
    if (dst.length < METER_SLOT_COUNT) return

    dst[MeterSlot.InputPeak] = this.inputMeter.peakLevel
    dst[MeterSlot.InputRms] = this.inputMeter.rmsLevel
    dst[MeterSlot.OutputLeftPeak] = this.leftMeter.peakLevel
    dst[MeterSlot.OutputLeftRms] = this.leftMeter.rmsLevel
    dst[MeterSlot.OutputRightPeak] = this.rightMeter.peakLevel
    dst[MeterSlot.OutputRightRms] = this.rightMeter.rmsLevel
    dst[MeterSlot.LimiterReductionDb] = this.limiter.reductionDb
    dst[MeterSlot.InputClipCount] = this.inputMeter.clipCount

    this.inputMeter.drain()
    this.leftMeter.drain()
    this.rightMeter.drain()
    this.limiter.drainReduction()
  }

  /** Kept in sync with the fields above; used to apply the table's smoothing times. */
  private smoothers(): ReadonlyArray<readonly [ParamId, SmoothedValue]> {
    return [
      [ParamId.InputTrimDb, this.inputTrim],
      [ParamId.OutputGainDb, this.outputGain],
      [ParamId.Mute, this.muteGain],
    ]
  }
}

/** A dB parameter's default, as a linear gain. */
function defaultGain(id: ParamId): number {
  return dbToGain(PARAM_BY_ID.get(id)?.default ?? 0)
}

/** The mute ramp's resting value: 1 when the table says "not muted". */
function defaultMuteGain(): number {
  return (PARAM_BY_ID.get(ParamId.Mute)?.default ?? 0) >= 0.5 ? 0 : 1
}
