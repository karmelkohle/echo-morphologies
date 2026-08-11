import { EngineCore } from '../engine/EngineCore'
import { HrirSet } from '../engine/hrir/HrirSet'
import { METER_SLOT_COUNT, MeterSlot } from '../engine/meters'
import { PROCESSOR_NAME, type CommandMessage, type StatusMessage } from './protocol'

/** Voices reported per pipeline slot for the polar plot. */
const VIZ_PER_SLOT = 16

/**
 * The audio-thread host for {@link EngineCore}.
 *
 * This file is the Web Audio half of the port boundary, and it is deliberately
 * thin: unpack the block, call the engine, pack the meters. Anything that makes
 * a sound belongs one directory over in `engine/`, where AVAudioEngine — or a
 * WebAssembly build of the same DSP — can reach it unchanged.
 */

/**
 * Web Audio renders in 128-frame quanta today. The engine is sized larger so a
 * bigger quantum in a future spec revision widens the block rather than
 * truncating it, at a cost of a few kilobytes.
 */
const MAX_BLOCK_SIZE = 512

/** Blocks to let the graph settle before the clock-gap counter starts. */
const SETTLING_BLOCKS = 4

class EngineProcessor extends AudioWorkletProcessor {
  private readonly core = new EngineCore()
  private readonly meterScratch = new Float32Array(METER_SLOT_COUNT)
  private readonly vizScratch = new Float32Array(3 * VIZ_PER_SLOT * 4)

  private blocks = 0
  private clockGaps = 0
  private nextExpectedFrame = 0

  private meterIntervalFrames = 0
  private framesSinceReport = 0

  constructor() {
    super()

    this.core.prepare({
      sampleRate,
      maxBlockSize: MAX_BLOCK_SIZE,
      numInputChannels: 1,
      numOutputChannels: 2,
    })
    this.setMeterInterval(33)

    this.port.onmessage = (event: MessageEvent<CommandMessage>) => this.handleCommand(event.data)
    this.post({ type: 'ready', sampleRate, blockSize: 128 })
  }

  private handleCommand(message: CommandMessage): void {
    switch (message.type) {
      case 'param':
        this.core.setParam(message.id, message.value)
        break
      case 'reset':
        this.core.reset()
        break
      case 'meterInterval':
        this.setMeterInterval(message.ms)
        break
      case 'testTone':
        this.core.triggerTestTone(message.mask)
        break
      case 'hrir':
        try {
          const set = HrirSet.fromParts(message.set)
          this.core.setHrir(set)
          this.post({
            type: 'hrirStatus',
            ok: true,
            label: message.label,
            positions: set.positionCount,
            taps: set.taps,
            resampled: set.resampled,
          })
        } catch (error) {
          this.post({
            type: 'hrirStatus',
            ok: false,
            label: message.label,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        break
    }
  }

  private setMeterInterval(ms: number): void {
    this.meterIntervalFrames = Math.max(0, Math.round((ms / 1000) * sampleRate))
    this.framesSinceReport = 0
  }

  private post(message: StatusMessage): void {
    this.port.postMessage(message)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (output === undefined || output.length === 0) return true

    const frames = output[0].length
    this.core.process(inputs[0] ?? [], output, frames)

    this.trackRenderClock(frames)
    this.reportMeters(frames)
    return true
  }

  /**
   * Watches the frame clock for gaps. In a healthy graph each block starts
   * exactly one quantum after the last; anything else means the context was
   * interrupted between them.
   *
   * The opening blocks are not counted. Building the graph — opening the
   * device, loading this module, connecting the nodes — spans a discontinuity
   * by construction, and reporting it as a glitch would leave the counter
   * sitting at 1 from the moment the app starts, which teaches you to ignore it.
   */
  private trackRenderClock(frames: number): void {
    this.blocks++
    if (this.blocks > SETTLING_BLOCKS && currentFrame !== this.nextExpectedFrame) {
      this.clockGaps++
    }
    this.nextExpectedFrame = currentFrame + frames
  }

  private reportMeters(frames: number): void {
    if (this.meterIntervalFrames === 0) return

    this.framesSinceReport += frames
    if (this.framesSinceReport < this.meterIntervalFrames) return
    this.framesSinceReport = 0

    this.core.readMeters(this.meterScratch)
    const voices = this.core.readViz(this.vizScratch, VIZ_PER_SLOT)
    this.meterScratch[MeterSlot.ActiveVoices] = voices
    // Allocates on the audio thread. Small, bounded, ~30 Hz, and the shared
    // memory alternative costs cross-origin isolation — see protocol.ts.
    this.post({
      type: 'meters',
      values: Array.from(this.meterScratch),
      viz: Array.from(this.vizScratch.subarray(0, voices * 4)),
      blocks: this.blocks,
      clockGaps: this.clockGaps,
    })
  }
}

registerProcessor(PROCESSOR_NAME, EngineProcessor)
