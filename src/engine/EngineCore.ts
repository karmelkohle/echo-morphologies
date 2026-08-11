import { DirectionalBus } from './DirectionalBus'
import { AWeighting } from './dsp/AWeighting'
import { LevelMeter } from './dsp/LevelMeter'
import { Limiter } from './dsp/Limiter'
import { SmoothedValue } from './dsp/SmoothedValue'
import { dbToGain } from './dsp/math'
import { AdditivePads } from './effects/AdditivePads'
import { EchoDelay } from './effects/EchoDelay'
import { FdnReverb } from './effects/FdnReverb'
import { GranularDelay } from './effects/GranularDelay'
import { SpatialTarget, type SpatialEffect } from './effects/SpatialEffect'
import { METER_SLOT_COUNT, MeterSlot } from './meters'
import {
  EffectType,
  ParamId,
  PARAM_BY_ID,
  SLOT_COUNT,
  SlotParam,
  isSlotParam,
  localOfParam,
  slotOfParam,
} from './params'
import { BinauralStage } from './stages/BinauralStage'
import type { AudioEngineCore, EngineConfig } from './types'

/**
 * The whole signal chain, and the only place audio is touched.
 *
 *      1. CAPTURE      2. PIPELINES (×3)        3. BINAURAL        4. OUTPUT
 *   mic ─▶ trim ─┬─▶ slot A: effect ─▶ lanes 0-3 ─┐
 *                ├─▶ slot B: effect ─▶ lanes 4-7 ─┼▶ HRIR conv. ─▶ gain ─▶ limiter ─▶ ears
 *                └─▶ slot C: effect ─▶ lanes 8-11 ─┘
 *
 * Up to three effect pipelines run in parallel on the same capture, each
 * aiming its material at its own spatial target — granular into the left
 * hemisphere beside additive pads into the right, and so on. Each slot owns
 * four bus lanes; the binaural stage renders all twelve and neither knows nor
 * cares who fed them. Effects live in `src/engine/effects/`, one class per
 * file; EngineCore only routes params and blocks.
 *
 * Realtime rules as ever: size in prepare(), no allocation in process() —
 * with one deliberate exception: selecting an effect for the first time
 * constructs it. That happens in setParam, which the worklet runs between
 * render quanta, same as an HRIR swap.
 */

/** Bus lanes each pipeline owns; the renderer's cost ceiling is 3× this. */
export const LANES_PER_SLOT = 4

class PipelineSlot {
  effectType: EffectType = EffectType.Off
  active: SpatialEffect | null = null
  readonly target = new SpatialTarget()
  readonly wet = new SmoothedValue(1)
  /** Every local value ever set, replayed onto instances created later. */
  readonly localValues = new Map<number, number>()
  /** Instances are kept once built — switching back is instant and stateless. */
  readonly instances = new Map<EffectType, SpatialEffect>()
}

export class EngineCore implements AudioEngineCore {
  private cfg: EngineConfig = {
    sampleRate: 48000,
    maxBlockSize: 128,
    numInputChannels: 1,
    numOutputChannels: 2,
  }

  private readonly inputTrim = new SmoothedValue(1)
  private readonly outputGain = new SmoothedValue(dbToGain(-12))
  private readonly muteGain = new SmoothedValue(1)
  /** 0 = pipelines, 1 = dry microphone; ramped so the A/B never clicks. */
  private readonly dryMix = new SmoothedValue(0)
  /** Capture conditioning: the ear's contour before any pipeline reads. */
  private readonly aWeighting = new AWeighting()
  private aWeightingOn = false

  private readonly slots: PipelineSlot[] = Array.from({ length: SLOT_COUNT }, () => new PipelineSlot())
  private readonly binaural = new BinauralStage()
  private readonly limiter = new Limiter()

  private readonly inputMeter = new LevelMeter()
  private readonly leftMeter = new LevelMeter()
  private readonly rightMeter = new LevelMeter()

  private monoIn = new Float32Array(0)
  private silence = new Float32Array(0)
  private bus = new DirectionalBus(SLOT_COUNT * LANES_PER_SLOT, 0)
  private spareRight = new Float32Array(0)
  private wetLeft = new Float32Array(0)
  private wetRight = new Float32Array(0)
  private binauralWasActive = true

  /** Channel-test tone state; see {@link triggerTestTone}. */
  private testToneMask = 0
  private testToneRemaining = 0
  private testToneTotal = 0
  private testTonePhaseL = 0
  private testTonePhaseR = 0

  prepare(cfg: EngineConfig): void {
    this.cfg = { ...cfg }
    const { sampleRate, maxBlockSize } = this.cfg

    this.monoIn = new Float32Array(maxBlockSize)
    this.silence = new Float32Array(maxBlockSize)
    this.spareRight = new Float32Array(maxBlockSize)
    this.wetLeft = new Float32Array(maxBlockSize)
    this.wetRight = new Float32Array(maxBlockSize)
    this.bus = new DirectionalBus(SLOT_COUNT * LANES_PER_SLOT, maxBlockSize)

    this.inputTrim.prepare(this.smoothing(ParamId.InputTrimDb, 30), sampleRate)
    this.outputGain.prepare(this.smoothing(ParamId.OutputGainDb, 30), sampleRate)
    this.muteGain.prepare(this.smoothing(ParamId.Mute, 8), sampleRate)
    this.dryMix.prepare(15, sampleRate)
    this.aWeighting.prepare(sampleRate)
    for (const slot of this.slots) {
      slot.wet.prepare(20, sampleRate)
      for (const instance of slot.instances.values()) instance.prepare(this.cfg)
    }

    this.binaural.setLaneCount(SLOT_COUNT * LANES_PER_SLOT)
    this.binaural.prepare(this.cfg)
    this.limiter.prepare(sampleRate)

    this.reset()
  }

  reset(): void {
    this.inputTrim.settle()
    this.outputGain.settle()
    this.muteGain.settle()
    this.dryMix.settle()
    for (const slot of this.slots) {
      slot.wet.settle()
      slot.active?.reset()
    }
    this.binaural.reset()
    this.limiter.reset()
    this.inputMeter.reset()
    this.leftMeter.reset()
    this.rightMeter.reset()
  }

  setHrir(set: Parameters<BinauralStage['setHrir']>[0]): void {
    this.binaural.setHrir(set)
  }

  /**
   * Fires the route diagnostic: 600 ms of tone into the masked output
   * channels (bit 0 = left at 440 Hz, bit 1 = right at 660 Hz), injected
   * after mute and output gain so it sounds regardless of settings, before
   * the limiter so it cannot surprise anyone's ears. Distinct pitches per
   * side make a swapped route as audible as a collapsed one.
   */
  triggerTestTone(mask: number): void {
    this.testToneMask = mask & 0b11
    this.testToneTotal = Math.round(0.6 * this.cfg.sampleRate)
    this.testToneRemaining = this.testToneTotal
    this.testTonePhaseL = 0
    this.testTonePhaseR = 0
  }

  setParam(id: number, value: number): void {
    if (isSlotParam(id)) {
      const slotIx = slotOfParam(id)
      if (slotIx < 0 || slotIx >= SLOT_COUNT) return
      this.setSlotParam(this.slots[slotIx], slotIx, localOfParam(id), value)
      return
    }

    switch (id) {
      case ParamId.InputTrimDb:
        this.inputTrim.setTarget(dbToGain(value))
        break
      case ParamId.OutputGainDb:
        this.outputGain.setTarget(dbToGain(value))
        break
      case ParamId.Mute:
        this.muteGain.setTarget(value >= 0.5 ? 0 : 1)
        break
      case ParamId.DryMonitor:
        this.dryMix.setTarget(value >= 0.5 ? 1 : 0)
        break
      case ParamId.CaptureWeighting: {
        const on = value >= 0.5
        // Fresh state on enable: the filter must not ring out whatever was
        // in it when it was last switched off.
        if (on && !this.aWeightingOn) this.aWeighting.reset()
        this.aWeightingOn = on
        break
      }
      default:
        break
    }
  }

  private setSlotParam(slot: PipelineSlot, slotIx: number, local: number, value: number): void {
    switch (local) {
      case SlotParam.Effect: {
        const type = Math.round(value) as EffectType
        if (type === slot.effectType) return
        slot.effectType = type
        slot.active = type === EffectType.Off ? null : this.instantiate(slot, slotIx, type)
        // A fresh activation starts from silence — stale rings and tails from
        // the last time this effect ran would be minutes old.
        slot.active?.reset()
        // The lanes this slot owns may still carry the previous effect's
        // block; they are cleared next process(), and the renderer's
        // silent-lane logic rings the convolution tails out.
        break
      }
      case SlotParam.AzimuthDeg:
        slot.target.azimuthDeg = value
        this.pokeDirections(slot)
        break
      case SlotParam.AzimuthDevDeg:
        slot.target.azimuthDevDeg = Math.max(0, value)
        this.pokeDirections(slot)
        break
      case SlotParam.ElevationDeg:
        slot.target.elevationDeg = value
        this.pokeDirections(slot)
        break
      case SlotParam.ElevationDevDeg:
        slot.target.elevationDevDeg = Math.max(0, value)
        this.pokeDirections(slot)
        break
      case SlotParam.WetDb:
        slot.wet.setTarget(dbToGain(value))
        break
      default:
        slot.localValues.set(local, value)
        slot.active?.setLocal(local, value)
        break
    }
  }

  /** Effects that hold drawn directions re-scatter when the target moves. */
  private pokeDirections(slot: PipelineSlot): void {
    const active = slot.active as { redrawDirections?: () => void } | null
    active?.redrawDirections?.()
  }

  private instantiate(slot: PipelineSlot, slotIx: number, type: EffectType): SpatialEffect {
    let instance = slot.instances.get(type)
    if (!instance) {
      const seed = (0x5eed ^ (slotIx * 0x9e3779b9) ^ (type * 0x85ebca6b)) >>> 0
      switch (type) {
        case EffectType.Granular:
          instance = new GranularDelay(slot.target, seed)
          break
        case EffectType.Echo:
          instance = new EchoDelay(slot.target, seed)
          break
        case EffectType.Reverb:
          instance = new FdnReverb(slot.target, seed)
          break
        case EffectType.Additive:
          instance = new AdditivePads(slot.target, seed)
          break
        default:
          throw new Error(`unknown effect type ${type}`)
      }
      instance.prepare(this.cfg)
      for (const [local, value] of slot.localValues) instance.setLocal(local, value)
      slot.instances.set(type, instance)
    }
    return instance
  }

  process(input: readonly Float32Array[], output: readonly Float32Array[], frames: number): void {
    if (output.length === 0) return
    const n = Math.min(frames, this.cfg.maxBlockSize)

    const left = output[0]
    const right = output.length > 1 ? output[1] : this.spareRight
    const source = input.length > 0 ? input[0] : undefined
    const captured = source !== undefined && source.length >= n ? source : this.silence

    // ═══ 1. CAPTURE ═════════════════════════════════════════════════════════
    // Microphone in, trimmed and metered. `mono[0..n)` is the dry signal
    // every pipeline reads — the one place to tap for recording or analysis.

    const mono = this.monoIn
    for (let i = 0; i < n; i++) {
      mono[i] = captured[i] * this.inputTrim.next()
    }
    // Optional A-weighting, before the meter and before any pipeline writes
    // the ring — everything downstream, dry monitor included, hears the
    // conditioned capture, so the A/B stays a comparison of processing.
    if (this.aWeightingOn) this.aWeighting.process(mono, n)
    this.inputMeter.accumulate(mono, n)

    // ═══ 2. PIPELINES ═══════════════════════════════════════════════════════
    // Each active slot granulates / echoes / reverberates / synthesizes the
    // same capture into its own four lanes and aims them at its own target,
    // then its wet level rides a smoothed gain over those lanes.

    this.bus.clear(n)
    for (let s = 0; s < SLOT_COUNT; s++) {
      const slot = this.slots[s]
      const effect = slot.active
      if (!effect) continue
      const laneOffset = s * LANES_PER_SLOT
      effect.process(mono, this.bus, laneOffset, LANES_PER_SLOT, n)

      if (slot.wet.isSettled && slot.wet.value === 1) continue
      for (let i = 0; i < n; i++) {
        const g = slot.wet.next()
        for (let l = 0; l < LANES_PER_SLOT; l++) this.bus.lanes[laneOffset + l][i] *= g
      }
    }

    // ═══ 3. BINAURAL RENDERING (HRTF CONVOLUTION) ═══════════════════════════
    // All twelve lanes through the HRIR pair nearest their directions. The
    // dry-monitor toggle A/Bs the whole pipeline stage against the raw
    // microphone through a short equal-gain fade.

    left.fill(0, 0, n)
    right.fill(0, 0, n)

    const fullyDry = this.dryMix.isSettled && this.dryMix.value === 1
    if (fullyDry) {
      this.binauralWasActive = false
      for (let i = 0; i < n; i++) {
        left[i] = mono[i]
        right[i] = mono[i]
      }
    } else {
      if (!this.binauralWasActive) this.binaural.reset()
      this.binauralWasActive = true

      if (this.dryMix.isSettled && this.dryMix.value === 0) {
        this.binaural.process(this.bus, left, right, n)
      } else {
        const wetL = this.wetLeft
        const wetR = this.wetRight
        wetL.fill(0, 0, n)
        wetR.fill(0, 0, n)
        this.binaural.process(this.bus, wetL, wetR, n)
        for (let i = 0; i < n; i++) {
          const m = this.dryMix.next()
          const wet = 1 - m
          left[i] = wetL[i] * wet + mono[i] * m
          right[i] = wetR[i] * wet + mono[i] * m
        }
      }
    }

    // ═══ 4. OUTPUT ══════════════════════════════════════════════════════════
    // Level, then protection. The limiter is a safety net, not part of the
    // instrument; new DSP belongs above it.

    for (let i = 0; i < n; i++) {
      const gain = this.outputGain.next() * this.muteGain.next()
      left[i] *= gain
      right[i] *= gain
    }

    if (this.testToneRemaining > 0) this.renderTestTone(left, right, n)

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

  /**
   * Fills `out` with sounding voices for the interface's polar plot, as
   * (slot, azimuthDeg, elevationDeg, level) quads. Returns the voice count.
   */
  readViz(out: Float32Array, maxPerSlot: number): number {
    let total = 0
    for (let s = 0; s < SLOT_COUNT; s++) {
      const effect = this.slots[s].active
      if (!effect) continue
      const written = effect.snapshotVoices(this.vizScratch, 0, maxPerSlot)
      for (let v = 0; v < written; v++) {
        const base = total * 4
        if (base + 4 > out.length) return total
        out[base] = s
        out[base + 1] = this.vizScratch[v * 3]
        out[base + 2] = this.vizScratch[v * 3 + 1]
        out[base + 3] = this.vizScratch[v * 3 + 2]
        total++
      }
    }
    return total
  }

  /** Renders the channel-test tone; −18 dBFS peak, 15 ms raised-cosine fades. */
  private renderTestTone(left: Float32Array, right: Float32Array, n: number): void {
    const sr = this.cfg.sampleRate
    const incL = (2 * Math.PI * 440) / sr
    const incR = (2 * Math.PI * 660) / sr
    const fade = Math.max(1, Math.round(0.015 * sr))
    const amp = 0.125

    for (let i = 0; i < n && this.testToneRemaining > 0; i++, this.testToneRemaining--) {
      const elapsed = this.testToneTotal - this.testToneRemaining
      const edge = Math.min(1, elapsed / fade, this.testToneRemaining / fade)
      const env = amp * 0.5 * (1 - Math.cos(Math.PI * Math.min(1, edge)))
      if (this.testToneMask & 1) {
        left[i] += Math.sin(this.testTonePhaseL) * env
        this.testTonePhaseL += incL
      }
      if (this.testToneMask & 2) {
        right[i] += Math.sin(this.testTonePhaseR) * env
        this.testTonePhaseR += incR
      }
    }
  }

  private readonly vizScratch = new Float32Array(64 * 3)

  private smoothing(id: number, fallback: number): number {
    return PARAM_BY_ID.get(id)?.smoothingMs ?? fallback
  }
}
