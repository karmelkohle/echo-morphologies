import { DirectionalBus } from './DirectionalBus'
import { LevelMeter } from './dsp/LevelMeter'
import { Limiter } from './dsp/Limiter'
import { SmoothedValue } from './dsp/SmoothedValue'
import { dbToGain } from './dsp/math'
import { METER_SLOT_COUNT, MeterSlot } from './meters'
import { PARAM_BY_ID, ParamId } from './params'
import { BinauralStage } from './stages/BinauralStage'
import { GranularStage, type GrainEnvShape, type GrainScheduler } from './stages/GranularStage'
import type { AudioEngineCore, EngineConfig } from './types'

/** Concurrent grain streams with distinct directions; see the bus comment. */
const LANE_COUNT = 8

/**
 * The whole signal chain, and the only place audio is touched.
 *
 *        1. CAPTURE        2. GRANULAR        3. BINAURAL       4. OUTPUT
 *     mic ─▶ trim ─────▶ grain cloud ─▶ ▮▮▮ ─▶ HRTF convolve ─▶ gain ─▶ limiter ─▶ ears
 *              │                    directional bus      │       │
 *         input meter              (lanes + directions)  │   mute ramp, output meters
 *
 * `process()` below is written as those four numbered sections so a stage can
 * be swapped, rewritten or commented out on its own. Granular is the spatdsp
 * design, live; binaural is still a directionless pass-through sum.
 *
 * Each stage is handed buffers this class has already zeroed and ADDS into
 * them, which is both what the real DSP wants — grains accumulate, and the
 * renderer sums one convolution per lane — and what makes commenting a stage
 * out degrade to silence rather than to last block's audio.
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

    // The spatial resolution of the piece: how many concurrent grain streams
    // can hold distinct directions, and how many convolutions the binaural
    // stage runs per block. Grains are dealt onto lanes round-robin, so a
    // direction only blurs when more than LANE_COUNT grains overlap.
    this.bus = new DirectionalBus(LANE_COUNT, maxBlockSize)

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
    const granular = this.granular
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

      // Grain parameters are read at spawn time, so plain assignment is
      // click-free by construction — each grain is born with one value and
      // keeps it for life.
      case ParamId.GranularEnabled:
        granular.enabled = value >= 0.5
        break
      case ParamId.BufferSec:
        granular.bufferSec = value
        break
      case ParamId.DelayMs:
        granular.delayMs = value
        break
      case ParamId.DelayDevMs:
        granular.delayDevMs = value
        break
      case ParamId.Density:
        granular.density = value
        break
      case ParamId.LengthMs:
        granular.lengthMs = value
        break
      case ParamId.LengthJitter:
        granular.lengthJitter = value
        break
      case ParamId.PitchSemis:
        granular.pitchSemis = value
        break
      case ParamId.PitchDevSemis:
        granular.pitchDevSemis = value
        break
      case ParamId.ReverseProb:
        granular.reverseProb = value
        break
      case ParamId.EnvShape:
        granular.envShape = Math.round(value) as GrainEnvShape
        break
      case ParamId.Scheduler:
        granular.scheduler = Math.round(value) as GrainScheduler
        break
      case ParamId.AzimuthDeg:
        granular.azimuthDeg = value
        break
      case ParamId.AzimuthDevDeg:
        granular.azimuthDevDeg = value
        break
      case ParamId.ElevationDeg:
        granular.elevationDeg = value
        break
      case ParamId.ElevationDevDeg:
        granular.elevationDevDeg = value
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

    // ═══ 1. CAPTURE ═════════════════════════════════════════════════════════
    // Microphone in, trimmed and metered. Mono by design: one AirPod mic.
    // After this, `mono[0..n)` is the dry signal everything downstream works
    // from — the one place to tap if you want to record or analyse the input.

    const mono = this.monoIn
    for (let i = 0; i < n; i++) {
      mono[i] = captured[i] * this.inputTrim.next()
    }
    this.inputMeter.accumulate(mono, n)

    // ═══ 2. GRANULAR SYNTHESIS ══════════════════════════════════════════════
    // The spatdsp Granular design on the DirectionalBus: ring buffer, grain
    // scheduler, per-grain deviation draws, round-robin lane dealing. The
    // `Granular` toggle bypasses it into a dry lane-0 pass-through.
    //
    //   in   `mono[0..n)`, the dry capture
    //   out  `this.bus`, already zeroed — lanes are ADDED to, and each lane's
    //        direction is set at grain spawn
    //
    // Experiment either by editing stages/GranularStage.ts, or by writing
    // straight into `this.bus.lanes[k]` here and skipping the call. Commenting
    // the call out is safe and yields silence, not stale audio.

    this.bus.clear(n)
    this.granular.process(mono, this.bus, n)

    // ═══ 3. BINAURAL RENDERING (HRTF CONVOLUTION) ═══════════════════════════
    // NOT IMPLEMENTED — the stage sums the field into both ears and ignores
    // the directions entirely, so the output is dual mono.
    //
    //   in   `this.bus`, the directional field
    //   out  `left` / `right` over [0..n), already zeroed and ADDED to
    //
    // This is where each lane gets convolved with the HRIR pair for its
    // direction. Same deal: edit stages/BinauralStage.ts, or write the ears
    // directly here. Commenting the call out yields silence.

    left.fill(0, 0, n)
    right.fill(0, 0, n)
    this.binaural.process(this.bus, left, right, n)

    // ═══ 4. OUTPUT ══════════════════════════════════════════════════════════
    // Level, then protection. Nothing here shapes the sound — the limiter is a
    // safety net, not part of the instrument, so new DSP belongs above it.

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
    dst[MeterSlot.ActiveGrains] = this.granular.activeGrainCount()

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
