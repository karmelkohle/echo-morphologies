import { HrirSet } from '../engine/hrir/HrirSet'
import { METER_SLOT_COUNT, MeterSlot } from '../engine/meters'
import { HRIR_SETS, ParamId, defaultParamValues } from '../engine/params'
import { PROCESSOR_NAME, type CommandMessage, type StatusMessage } from '../worklet/protocol'
import {
  AudioPermissionError,
  ScreenWakeLock,
  declareAudioSession,
  describeCapture,
  listAudioInputs,
  openCapture,
  type AudioInputDevice,
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

/** What the binaural renderer is working with right now. */
export type HrtfStatus =
  | { state: 'none' }
  | { state: 'loading'; label: string }
  | { state: 'active'; label: string; positions: number; taps: number; resampled: boolean }
  | { state: 'error'; label: string; message: string }


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
  hrtf: HrtfStatus
  /** Microphones the user may pick from; labeled once permission exists. */
  inputDevices: AudioInputDevice[]
  /** The picked microphone, or null for the platform default. */
  inputDeviceId: string | null
  /** Channels the output route actually carries; 1 = spatial cues collapse. */
  outputChannels: number | null
  /** A route problem worth shouting about (mono output, call-mode capture). */
  routeWarning: string | null
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
  activeVoices: number
  /** (slot, azimuthDeg, elevationDeg, level) quads for the polar plot. */
  viz: number[]
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
  private readonly values = defaultParamValues()

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
    hrtf: { state: 'none' },
    inputDevices: [],
    inputDeviceId: null,
    outputChannels: null,
    routeWarning: null,
  }

  /** Guards against a slow fetch overwriting a newer set choice. */
  private hrirLoadToken = 0

  /**
   * Output leaves through a real `<audio>` element rather than
   * `context.destination`: a page that is *playing media* keeps its audio
   * session alive through an iOS screen lock (with the play-and-record
   * session declared), where a bare Web Audio graph is suspended. The same
   * trick every web conferencing app uses.
   */
  private audioElement: HTMLAudioElement | null = null

  private static readonly INPUT_DEVICE_KEY = 'echo-morph.inputDevice'

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.recover()
    })
    // Earbuds appear and vanish mid-session; keep the picker honest.
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (this.node) void this.refreshInputDevices()
    })
  }

  getStatus(): EngineStatus {
    return { ...this.status }
  }

  getParam(id: number): number {
    return this.values.get(id) ?? 0
  }

  /**
   * Sets a parameter, whether or not the engine is running. Values set while
   * stopped are applied when it next starts, so the interface never has to
   * care about ordering.
   */
  setParam(id: number, value: number): void {
    this.values.set(id, value)
    this.send({ type: 'param', id, value })
    // The set choice is host business: the engine cannot fetch.
    if (id === ParamId.HrirSet && this.node) void this.loadHrirSet(Math.round(value))
  }

  /**
   * Fetches an HRIR set, parses and resamples it on this thread, and hands
   * the arrays to the audio thread by transfer. Safe to call repeatedly; a
   * newer call wins over a slower older one.
   */
  private async loadHrirSet(index: number): Promise<void> {
    const source = HRIR_SETS[index] ?? HRIR_SETS[0]
    const token = ++this.hrirLoadToken
    this.patchStatus({ hrtf: { state: 'loading', label: source.label } })

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}hrtf/${source.file}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = await response.arrayBuffer()
      if (token !== this.hrirLoadToken || !this.node) return

      const contextRate = this.status.sampleRate ?? this.context?.sampleRate ?? 48000
      const set = HrirSet.parse(bytes).resampleTo(contextRate)
      const { parts, transfer } = set.toParts()
      this.node.port.postMessage({ type: 'hrir', label: source.label, set: parts }, transfer)
      // The worklet's hrirStatus reply flips the status to active.
    } catch (error) {
      // Same guards as the success path: a stale failure must not overwrite a
      // newer load, and a failure landing after stop() must not resurrect an
      // error banner onto an idle engine.
      if (token !== this.hrirLoadToken || !this.node) return
      this.patchStatus({
        hrtf: {
          state: 'error',
          label: source.label,
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
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

      const savedDevice = this.readSavedInputDevice()
      try {
        stream = await openCapture(savedDevice ?? undefined)
      } catch (error) {
        // The remembered microphone may be gone (unpaired earbuds, another
        // machine). The default input is the right fallback, not a failure.
        if (savedDevice === null) throw error
        this.forgetSavedInputDevice()
        stream = await openCapture()
      }
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
      await this.routeOutput(context, node)

      context.onstatechange = () => this.handleContextState()

      this.context = context
      this.stream = stream
      this.source = source
      this.node = node

      for (const [id, value] of this.values) this.send({ type: 'param', id, value })
      void this.loadHrirSet(Math.round(this.values.get(ParamId.HrirSet) ?? 0))

      this.anchorBlocks = 0
      this.anchorTime = 0
      this.renderRatio = null

      await this.wakeLock.acquire()
      this.installMediaSession()

      const capture = describeCapture(stream)
      const outputChannels = context.destination.maxChannelCount || 2
      this.patchStatus({
        state: context.state === 'running' ? 'running' : 'interrupted',
        sampleRate: context.sampleRate,
        baseLatencyMs: toMs(context.baseLatency),
        outputLatencyMs: toMs((context as AudioContext & { outputLatency?: number }).outputLatency),
        capture,
        audioSessionApplied,
        screenLockHeld: this.wakeLock.supported,
        inputDeviceId: savedDevice,
        outputChannels,
        routeWarning: routeWarningFor(capture, outputChannels),
      })

      // Labels only exist after permission, so the device list comes last.
      void this.refreshInputDevices()
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

    if (this.audioElement) {
      this.audioElement.onpause = null
      this.audioElement.pause()
      this.audioElement.srcObject = null
      this.audioElement = null
    }

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
      hrtf: { state: 'none' },
      outputChannels: null,
      routeWarning: null,
    })
  }

  /**
   * Swaps the capture to another microphone while the graph keeps running.
   * The choice is remembered for the next start.
   */
  async setInputDevice(deviceId: string | null): Promise<void> {
    if (deviceId) localStorage.setItem(AudioEngine.INPUT_DEVICE_KEY, deviceId)
    else this.forgetSavedInputDevice()
    this.patchStatus({ inputDeviceId: deviceId })

    const context = this.context
    const node = this.node
    if (!context || !node) return

    try {
      const stream = await openCapture(deviceId ?? undefined)
      // New source first, then retire the old — no capture gap.
      const source = context.createMediaStreamSource(stream)
      source.connect(node)
      this.source?.disconnect()
      this.stream?.getTracks().forEach((track) => track.stop())
      this.source = source
      this.stream = stream

      const capture = describeCapture(stream)
      const outputChannels = context.destination.maxChannelCount || 2
      this.patchStatus({
        capture,
        outputChannels,
        routeWarning: routeWarningFor(capture, outputChannels),
      })
      void this.refreshInputDevices()
    } catch (error) {
      this.patchStatus({
        message:
          error instanceof AudioPermissionError
            ? error.message
            : 'That microphone could not be opened.',
        remedy: 'The previous input keeps running; pick another device.',
      })
    }
  }

  private readSavedInputDevice(): string | null {
    try {
      return localStorage.getItem(AudioEngine.INPUT_DEVICE_KEY)
    } catch {
      return null
    }
  }

  private forgetSavedInputDevice(): void {
    try {
      localStorage.removeItem(AudioEngine.INPUT_DEVICE_KEY)
    } catch {
      // Storage may be unavailable (private mode); the choice just won't stick.
    }
  }

  private async refreshInputDevices(): Promise<void> {
    const inputDevices = await listAudioInputs()
    this.patchStatus({ inputDevices })
  }

  /**
   * Connects the worklet's output to the speakers through an `<audio>`
   * element (see the field comment for why). Falls back to a direct
   * destination connection when the element refuses to play.
   */
  private async routeOutput(context: AudioContext, node: AudioWorkletNode): Promise<void> {
    try {
      const destination = context.createMediaStreamDestination()
      node.connect(destination)
      const element = new Audio()
      element.srcObject = destination.stream
      element.setAttribute('playsinline', '')
      await element.play()
      // iOS pauses the element on route changes and interruptions; a paused
      // element while running means silence, so restart it.
      element.onpause = () => {
        if (this.context) void element.play().catch(() => undefined)
      }
      this.audioElement = element
    } catch {
      this.audioElement = null
      node.connect(context.destination)
    }
  }

  /**
   * Lock-screen presence: with media playing and handlers registered, iOS
   * shows the app on the lock screen and keeps the session alive; the pause
   * handler doubles as a remote mute.
   */
  private installMediaSession(): void {
    const session = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession
    if (!session) return
    try {
      session.metadata = new MediaMetadata({
        title: 'echo morphologies',
        artist: 'live spatial re-composition',
      })
      session.playbackState = 'playing'
      session.setActionHandler('pause', () => {
        this.setParam(ParamId.Mute, 1)
        session.playbackState = 'paused'
      })
      session.setActionHandler('play', () => {
        this.setParam(ParamId.Mute, 0)
        session.playbackState = 'playing'
      })
    } catch {
      // MediaSession is progressive enhancement; absence changes nothing.
    }
  }

  private send(message: CommandMessage): void {
    this.node?.port.postMessage(message)
  }

  private handleStatus(message: StatusMessage): void {
    if (message.type === 'ready') {
      this.patchStatus({ blockSize: message.blockSize })
      return
    }

    if (message.type === 'hrirStatus') {
      this.patchStatus({
        hrtf: message.ok
          ? {
              state: 'active',
              label: message.label,
              positions: message.positions ?? 0,
              taps: message.taps ?? 0,
              resampled: message.resampled ?? false,
            }
          : { state: 'error', label: message.label, message: message.error ?? 'unknown failure' },
      })
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
      activeVoices: values[MeterSlot.ActiveVoices],
      viz: message.viz,
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
    if (!context) return
    // The output element pauses across locks and route changes even when the
    // context survives; a paused element is silence, so always nudge it.
    if (this.audioElement && this.audioElement.paused) {
      void this.audioElement.play().catch(() => undefined)
    }
    if (context.state === 'running') return
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

/**
 * Names the route problems that silently destroy the piece. A Bluetooth
 * headset whose own microphone is open drops to the hands-free profile:
 * capture falls to speech bandwidth and — the part that masquerades as a DSP
 * bug — the OUTPUT goes mono, collapsing every spatial cue the renderer
 * produces. The cure is capturing from the phone's built-in microphone so
 * the earbuds stay on stereo A2DP.
 */
function routeWarningFor(capture: CaptureInfo, outputChannels: number): string | null {
  if (outputChannels < 2) {
    return (
      'The output route is MONO — spatialization cannot be heard. This is ' +
      'Bluetooth call mode: pick the phone’s built-in microphone under ' +
      'config → calibration so the earbuds keep their stereo profile.'
    )
  }
  if (capture.sampleRate !== null && capture.sampleRate < 24000) {
    return (
      `Capture is running at ${Math.round(capture.sampleRate / 1000)} kHz — ` +
      'Bluetooth call mode. Pick the phone’s built-in microphone under ' +
      'config → calibration for full bandwidth and safe stereo output.'
    )
  }
  return null
}
