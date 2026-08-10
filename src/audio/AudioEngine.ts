import { METER_SLOT_COUNT, MeterSlot } from '../engine/meters'
import { PARAMS, type ParamId } from '../engine/params'
import { PROCESSOR_NAME, type CommandMessage, type StatusMessage } from '../worklet/protocol'
import {
  AudioPermissionError,
  ScreenWakeLock,
  declareAudioSession,
  describeCapture,
  openCapture,
  type CaptureInfo,
} from './session'

/**
 * Web Audio plumbing: devices, permissions, graph, lifecycle.
 *
 * The counterpart to `engine/` — everything here is about the host, nothing
 * here makes a sound. When this becomes a native app, this file is the one that
 * gets rewritten against AVAudioEngine and the engine directory ports as is.
 *
 *     MediaStreamSource ─▶ AudioWorkletNode(engine-processor) ─▶ destination
 *          (mono)                    (stereo)
 */

export type EngineState = 'idle' | 'starting' | 'running' | 'interrupted' | 'error'

export interface EngineStatus {
  state: EngineState
  sampleRate: number | null
  /** Web Audio's render quantum, as reported by the worklet. */
  blockSize: number | null
  baseLatencyMs: number | null
  outputLatencyMs: number | null
  capture: CaptureInfo | null
  /** Whether iOS accepted our `play-and-record` session declaration. */
  audioSessionApplied: boolean
  screenLockHeld: boolean
  /** Present when `state` is `error`, or when a route/interruption needs saying. */
  message: string | null
  /** One actionable sentence, when there is one. */
  remedy: string | null
}

export interface MeterSnapshot {
  inputPeak: number
  inputRms: number
  leftPeak: number
  leftRms: number
  rightPeak: number
  rightRms: number
  limiterReductionDb: number
  inputClipCount: number
  /** Total render blocks since the engine started. */
  blocks: number
  /** Render-clock discontinuities since the engine started. */
  clockGaps: number
  /**
   * Measured block rate over nominal block rate. Sits at ~1 when the graph is
   * keeping up; a sustained dip means the audio thread is starving. Null until
   * two reports have arrived and there is an interval to measure over.
   */
  renderRatio: number | null
}

const WORKLET_URL = `${import.meta.env.BASE_URL}worklet/${PROCESSOR_NAME}.js`

/** Shortest interval the render rate is averaged over. */
const RENDER_WINDOW_MS = 500

export class AudioEngine {
  onStatus: ((status: EngineStatus) => void) | null = null
  onMeters: ((meters: MeterSnapshot) => void) | null = null

  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null

  private readonly wakeLock = new ScreenWakeLock()
  private readonly values = new Map<number, number>(PARAMS.map((p) => [p.id, p.default]))

  /**
   * Anchor for the render-rate measurement. Reports arrive ~30 times a second
   * and `postMessage` delivery jitters by more than the interval between them,
   * so differencing consecutive reports measures the main thread's event loop,
   * not the audio thread — it reads 10-15% low under any UI load. Averaging
   * over at least {@link RENDER_WINDOW_MS} makes the jitter cancel.
   */
  private anchorBlocks = 0
  private anchorTime = 0
  private renderRatio: number | null = null

  private status: EngineStatus = {
    state: 'idle',
    sampleRate: null,
    blockSize: null,
    baseLatencyMs: null,
    outputLatencyMs: null,
    capture: null,
    audioSessionApplied: false,
    screenLockHeld: false,
    message: null,
    remedy: null,
  }

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.recover()
    })
  }

  getStatus(): EngineStatus {
    return { ...this.status }
  }

  getParam(id: ParamId): number {
    return this.values.get(id) ?? 0
  }

  /**
   * Sets a parameter, whether or not the engine is running. Values set while
   * stopped are applied when it next starts, so the interface never has to
   * care about ordering.
   */
  setParam(id: ParamId, value: number): void {
    this.values.set(id, value)
    this.send({ type: 'param', id, value })
  }

  /**
   * Builds and starts the graph. **Must be called from a user gesture** — iOS
   * will not let an AudioContext run otherwise, and the first thing this does
   * is create one while the gesture is still live.
   */
  async start(): Promise<void> {
    if (this.status.state === 'starting' || this.status.state === 'running') return

    this.patchStatus({ state: 'starting', message: null, remedy: null })

    let context: AudioContext | null = null
    let stream: MediaStream | null = null

    try {
      if (typeof AudioContext === 'undefined') {
        throw new AudioPermissionError(
          'This browser has no Web Audio support.',
          'Use Safari 14.5 or later on iOS, or any current desktop browser.',
        )
      }

      // Order matters. Declare the session before anything opens a device, and
      // create the context synchronously so it inherits the user gesture that
      // got us here — every `await` below happens after that is banked.
      const audioSessionApplied = declareAudioSession('play-and-record')
      context = new AudioContext({ latencyHint: 'interactive' })
      const unlocked = context.resume()

      stream = await openCapture()
      await unlocked
      await context.audioWorklet.addModule(WORKLET_URL)

      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        // One microphone by design. `explicit` + `speakers` means a host that
        // hands us more than one capture channel gets downmixed properly
        // instead of having channels silently dropped.
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })

      node.port.onmessage = (event: MessageEvent<StatusMessage>) => this.handleStatus(event.data)
      node.onprocessorerror = () => {
        this.fail('The audio engine stopped unexpectedly.', 'Stop and start again to rebuild it.')
      }

      source.connect(node)
      node.connect(context.destination)

      context.onstatechange = () => this.handleContextState()

      this.context = context
      this.stream = stream
      this.source = source
      this.node = node

      for (const [id, value] of this.values) this.send({ type: 'param', id, value })

      this.anchorBlocks = 0
      this.anchorTime = 0
      this.renderRatio = null

      await this.wakeLock.acquire()

      this.patchStatus({
        state: context.state === 'running' ? 'running' : 'interrupted',
        sampleRate: context.sampleRate,
        baseLatencyMs: toMs(context.baseLatency),
        outputLatencyMs: toMs((context as AudioContext & { outputLatency?: number }).outputLatency),
        capture: describeCapture(stream),
        audioSessionApplied,
        screenLockHeld: this.wakeLock.supported,
      })
    } catch (error) {
      // Nothing half-built is left running: a stream still open holds the
      // microphone indicator on and keeps the AirPods in call mode.
      stream?.getTracks().forEach((track) => track.stop())
      if (context) await context.close().catch(() => undefined)
      this.context = null
      this.stream = null
      this.source = null
      this.node = null

      if (error instanceof AudioPermissionError) {
        this.fail(error.message, error.remedy)
      } else {
        this.fail(
          error instanceof Error ? error.message : 'The audio engine failed to start.',
          'Reload the page and try again.',
        )
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    this.node?.disconnect()
    this.source?.disconnect()
    if (this.node) this.node.port.onmessage = null
    this.stream?.getTracks().forEach((track) => track.stop())

    const context = this.context
    this.context = null
    this.stream = null
    this.source = null
    this.node = null

    if (context) {
      context.onstatechange = null
      await context.close().catch(() => undefined)
    }
    await this.wakeLock.release()

    this.patchStatus({
      state: 'idle',
      sampleRate: null,
      blockSize: null,
      baseLatencyMs: null,
      outputLatencyMs: null,
      capture: null,
      screenLockHeld: false,
      message: null,
      remedy: null,
    })
  }

  private send(message: CommandMessage): void {
    this.node?.port.postMessage(message)
  }

  private handleStatus(message: StatusMessage): void {
    if (message.type === 'ready') {
      this.patchStatus({ blockSize: message.blockSize })
      return
    }

    const values = message.values
    if (values.length < METER_SLOT_COUNT) return

    this.updateRenderRatio(message.blocks)

    this.onMeters?.({
      inputPeak: values[MeterSlot.InputPeak],
      inputRms: values[MeterSlot.InputRms],
      leftPeak: values[MeterSlot.OutputLeftPeak],
      leftRms: values[MeterSlot.OutputLeftRms],
      rightPeak: values[MeterSlot.OutputRightPeak],
      rightRms: values[MeterSlot.OutputRightRms],
      limiterReductionDb: values[MeterSlot.LimiterReductionDb],
      inputClipCount: values[MeterSlot.InputClipCount],
      blocks: message.blocks,
      clockGaps: message.clockGaps,
      renderRatio: this.renderRatio,
    })
  }

  /**
   * Re-measures the render rate whenever a full window has elapsed. The anchor
   * is only ever moved together with the value it produced, so every reading
   * covers a real interval of at least {@link RENDER_WINDOW_MS}.
   */
  private updateRenderRatio(blocks: number): void {
    const now = performance.now()
    if (this.anchorTime === 0) {
      this.anchorTime = now
      this.anchorBlocks = blocks
      return
    }

    const elapsed = now - this.anchorTime
    if (elapsed < RENDER_WINDOW_MS) return

    const blockSize = this.status.blockSize ?? 128
    const sampleRate = this.status.sampleRate ?? 48000
    const expected = (sampleRate / blockSize) * (elapsed / 1000)
    this.renderRatio = expected > 0 ? (blocks - this.anchorBlocks) / expected : null
    this.anchorTime = now
    this.anchorBlocks = blocks
  }

  private handleContextState(): void {
    const context = this.context
    if (!context) return

    if (context.state === 'running') {
      this.patchStatus({
        state: 'running',
        message: null,
        remedy: null,
        outputLatencyMs: toMs((context as AudioContext & { outputLatency?: number }).outputLatency),
      })
      return
    }

    // Suspended without us asking: a call arrived, the route changed, or iOS
    // decided a backgrounded page does not get the microphone.
    this.patchStatus({
      state: 'interrupted',
      message: 'Audio was interrupted by the system.',
      remedy: 'Bring the app back to the foreground; it resumes on its own.',
    })
  }

  /** Best-effort resume after the page comes back to the foreground. */
  private async recover(): Promise<void> {
    await this.wakeLock.refresh()
    const context = this.context
    if (!context || context.state === 'running') return
    try {
      await context.resume()
    } catch {
      // Needs another gesture; the Start button is still there.
    }
  }

  private fail(message: string, remedy: string): void {
    this.patchStatus({ state: 'error', message, remedy })
  }

  private patchStatus(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus?.(this.getStatus())
  }
}

function toMs(seconds: number | undefined): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null
}
