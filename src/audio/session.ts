/**
 * Platform glue for getting a microphone open on iOS without surprises.
 *
 * Everything in here is host-specific and expected to be thrown away when the
 * app becomes native — it is the layer that AVAudioSession replaces.
 */

/** Snapshot of what the browser actually gave us, for the status readout. */
export interface CaptureInfo {
  label: string
  channelCount: number
  sampleRate: number | null
  echoCancellation: boolean | null
  autoGainControl: boolean | null
  noiseSuppression: boolean | null
}

export class AudioPermissionError extends Error {
  constructor(
    message: string,
    /** What the user can do about it, in one sentence. */
    readonly remedy: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AudioPermissionError'
  }
}

/**
 * Declares what the page intends to do with audio, so iOS picks the matching
 * route and category.
 *
 * Without this, Safari infers a session from what the page has done so far, and
 * a page that opens a microphone tends to be inferred into a voice-call-shaped
 * session: output on the receiver rather than the earbuds, and silenced by the
 * ringer switch. `play-and-record` is the honest description of a listen-and-
 * play-back app and gets the route right.
 *
 * Safari 16.4+. A no-op everywhere else, which is harmless — this only ever
 * improves on the default.
 */
export function declareAudioSession(type: 'play-and-record' | 'playback' | 'auto'): boolean {
  // Cast rather than declare: `navigator.audioSession` is WebKit-only, and a
  // global declaration would collide the day it lands in TypeScript's DOM lib.
  const nav = navigator as unknown as { audioSession?: { type: string } }
  if (!nav.audioSession) return false
  try {
    nav.audioSession.type = type
    return true
  } catch {
    return false
  }
}

/**
 * Opens the microphone.
 *
 * The three processing flags are all switched off on purpose. Echo
 * cancellation, noise suppression and auto gain are tuned to make a voice
 * intelligible on a phone call; here they would be actively destroying the
 * material the piece is made of — the room tone, the traffic, the transients —
 * and auto gain in particular would ride the level under the granulator in a
 * way that is impossible to compose against.
 *
 * They are requested, not demanded: plain values leave them advisory, so a
 * platform that refuses still yields a stream rather than an exception.
 */
export async function openCapture(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AudioPermissionError(
      'This browser exposes no microphone API on this page.',
      isSecureContext
        ? 'Open the app in Safari or another modern browser.'
        : 'Serve the app over HTTPS — microphone access is blocked on insecure origins.',
    )
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        // `exact` on purpose: falling back to another microphone silently
        // would defeat the reason a device gets picked at all — keeping the
        // AirPods out of mono call mode.
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    })
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new AudioPermissionError(
        'Microphone access was denied.',
        'Allow the microphone for this site, then start again. In iOS Settings this lives under Safari → Microphone.',
        { cause: error },
      )
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new AudioPermissionError(
        'No usable microphone was found.',
        'Connect your AirPods and check they are the selected input.',
        { cause: error },
      )
    }
    throw new AudioPermissionError(
      'The microphone could not be opened.',
      'Close other apps that might be holding the microphone, then start again.',
      { cause: error },
    )
  }
}

export interface AudioInputDevice {
  deviceId: string
  label: string
}

/**
 * The microphones the page may pick from. Labels are only populated once a
 * capture permission has been granted, so call this after the stream opens.
 *
 * Why this matters here: opening a Bluetooth headset's own microphone drops
 * the whole link into the hands-free profile, whose *output* is mono — every
 * spatial cue the renderer produces collapses. Selecting the phone's built-in
 * microphone keeps the earbuds on stereo A2DP.
 */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== '')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `microphone ${i + 1}` }))
  } catch {
    return []
  }
}

export function describeCapture(stream: MediaStream): CaptureInfo {
  const track = stream.getAudioTracks()[0]
  if (!track) {
    return {
      label: 'no input track',
      channelCount: 0,
      sampleRate: null,
      echoCancellation: null,
      autoGainControl: null,
      noiseSuppression: null,
    }
  }

  const settings = track.getSettings()
  return {
    label: track.label || 'default input',
    channelCount: settings.channelCount ?? 1,
    sampleRate: settings.sampleRate ?? null,
    echoCancellation: settings.echoCancellation ?? null,
    autoGainControl: settings.autoGainControl ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
  }
}

interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

/**
 * Holds the screen awake while the engine runs.
 *
 * The stated use is walking around a city listening; a phone that sleeps after
 * thirty seconds suspends the AudioContext and ends the walk. Best-effort —
 * the lock is dropped by the system whenever the page is hidden, so it is
 * re-requested on every return to visibility.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null
  private wanted = false

  get supported(): boolean {
    return (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock !== undefined
  }

  async acquire(): Promise<void> {
    this.wanted = true
    await this.request()
  }

  async release(): Promise<void> {
    this.wanted = false
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release()
      } catch {
        // The system may have taken it back already; nothing to do.
      }
    }
  }

  /** Call when the page becomes visible again. */
  async refresh(): Promise<void> {
    if (this.wanted && (this.sentinel === null || this.sentinel.released)) await this.request()
  }

  private async request(): Promise<void> {
    const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock
    if (!api) return
    try {
      this.sentinel = await api.request('screen')
    } catch {
      // Denied or unavailable (low battery, background tab). Not fatal.
      this.sentinel = null
    }
  }
}
