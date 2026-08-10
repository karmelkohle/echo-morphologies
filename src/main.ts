import './style.css'

import { AudioEngine, type EngineStatus, type MeterSnapshot } from './audio/AudioEngine'
import { registerServiceWorker } from './pwa/register-sw'
import { Meter } from './ui/Meter'
import { buildControls } from './ui/controls'
import { StatusTable } from './ui/status'

/**
 * Application wiring. Holds no audio state of its own — it reflects the engine
 * and forwards gestures to it.
 */

const engine = new AudioEngine()

const transport = requireElement<HTMLButtonElement>('transport')
const stateBadge = requireElement<HTMLDivElement>('state-badge')
const stateLabel = requireElement<HTMLSpanElement>('state-label')
const notice = requireElement<HTMLParagraphElement>('notice')
const headphoneWarning = requireElement<HTMLElement>('headphone-warning')
const status = new StatusTable(requireElement<HTMLDListElement>('status'))

const meters = {
  input: new Meter('input'),
  left: new Meter('out L'),
  right: new Meter('out R'),
}
const meterContainer = requireElement<HTMLDivElement>('meters')
meterContainer.append(meters.input.element, meters.left.element, meters.right.element)

buildControls(requireElement<HTMLDivElement>('controls'), engine)

// ── transport ─────────────────────────────────────────────────────────────

let busy = false

transport.addEventListener('click', () => {
  if (busy) return
  busy = true
  transport.disabled = true

  const running = engine.getStatus().state !== 'idle' && engine.getStatus().state !== 'error'
  const action = running ? engine.stop() : engine.start()

  action
    .catch(() => {
      // The failure is already reflected in the status banner; swallowing it
      // here just keeps it out of the console as an unhandled rejection.
    })
    .finally(() => {
      busy = false
      transport.disabled = false
    })
})

// ── engine → interface ────────────────────────────────────────────────────

engine.onStatus = (next) => {
  renderStatus(next)
  if (next.state === 'idle' || next.state === 'error') {
    stopAnimation()
    for (const meter of Object.values(meters)) meter.clear()
    renderMeters(null)
  } else {
    startAnimation()
  }
}

engine.onMeters = (snapshot) => {
  const now = performance.now()
  meters.input.setLevels(snapshot.inputPeak, snapshot.inputRms, now)
  meters.left.setLevels(snapshot.leftPeak, snapshot.leftRms, now)
  meters.right.setLevels(snapshot.rightPeak, snapshot.rightRms, now)
  renderMeters(snapshot)
}

function renderStatus(next: EngineStatus): void {
  stateBadge.dataset.state = next.state
  stateLabel.textContent = next.state

  const stopping = next.state !== 'idle' && next.state !== 'error'
  transport.textContent = stopping ? 'Stop' : 'Start listening'
  transport.dataset.mode = stopping ? 'stop' : 'start'
  headphoneWarning.hidden = stopping

  if (next.message) {
    notice.hidden = false
    notice.textContent = next.message
    if (next.remedy) {
      const remedy = document.createElement('span')
      remedy.className = 'remedy'
      remedy.textContent = next.remedy
      notice.append(remedy)
    }
  } else {
    notice.hidden = true
    notice.textContent = ''
  }

  status.set('sample rate', next.sampleRate ? `${next.sampleRate.toLocaleString()} Hz` : '—')
  status.set('render quantum', next.blockSize ? `${next.blockSize} frames` : '—')
  status.set('base latency', formatMs(next.baseLatencyMs))
  status.set('output latency', formatMs(next.outputLatencyMs))
  status.set('input', next.capture?.label ?? '—')
  status.set('input channels', next.capture ? String(next.capture.channelCount) : '—')
  // Worth watching on Bluetooth: opening the microphone drops AirPods into a
  // bidirectional call mode, and this is where you see what bandwidth survived.
  status.set(
    'capture rate',
    next.capture?.sampleRate ? `${next.capture.sampleRate.toLocaleString()} Hz` : '—',
    next.capture?.sampleRate && next.capture.sampleRate < 32000 ? 'warn' : 'neutral',
  )
  // Anything the platform left switched on is worth flagging: it is destroying
  // the material the piece is made of before the engine ever sees it.
  const processing = next.capture ? describeProcessing(next.capture) : null
  status.set(
    'capture processing',
    processing ?? '—',
    processing !== null && processing !== 'none (raw)' ? 'warn' : 'neutral',
  )
  status.set(
    'ios audio session',
    next.audioSessionApplied ? 'play-and-record' : 'not available',
    next.audioSessionApplied ? 'good' : 'neutral',
  )
  status.set('screen wake lock', next.screenLockHeld ? 'held' : 'not available')
  status.set('display mode', displayMode())
}

function renderMeters(snapshot: MeterSnapshot | null): void {
  if (!snapshot) {
    status.set('render rate', '—')
    status.set('clock gaps', '—')
    status.set('input clipping', '—')
    status.set('limiter', '—')
    status.set('grains sounding', '—')
    return
  }

  // The smoke test in one number: the audio thread should be delivering blocks
  // at very close to the nominal rate. A sustained dip means it is starving.
  if (snapshot.renderRatio === null) {
    status.set('render rate', 'measuring…')
  } else {
    const percent = Math.round(snapshot.renderRatio * 100)
    status.set(
      'render rate',
      `${percent}% of realtime`,
      percent >= 95 ? 'good' : percent >= 80 ? 'warn' : 'alert',
    )
  }
  status.set('clock gaps', String(snapshot.clockGaps), snapshot.clockGaps > 0 ? 'warn' : 'neutral')
  status.set(
    'input clipping',
    snapshot.inputClipCount > 0 ? `${snapshot.inputClipCount} samples` : 'none',
    snapshot.inputClipCount > 0 ? 'alert' : 'neutral',
  )
  status.set(
    'limiter',
    snapshot.limiterReductionDb > 0.05 ? `−${snapshot.limiterReductionDb.toFixed(1)} dB` : 'inactive',
    snapshot.limiterReductionDb > 0.05 ? 'warn' : 'neutral',
  )
  status.set('grains sounding', String(Math.round(snapshot.activeGrains)))
}

// ── animation ─────────────────────────────────────────────────────────────

let frame = 0

function startAnimation(): void {
  if (frame !== 0) return
  const tick = () => {
    const now = performance.now()
    for (const meter of Object.values(meters)) meter.render(now)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}

function stopAnimation(): void {
  if (frame === 0) return
  cancelAnimationFrame(frame)
  frame = 0
}

// ── helpers ───────────────────────────────────────────────────────────────

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id} — index.html and main.ts disagree.`)
  return element as T
}

function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(1)} ms`
}

function describeProcessing(capture: {
  echoCancellation: boolean | null
  autoGainControl: boolean | null
  noiseSuppression: boolean | null
}): string {
  const active = [
    capture.echoCancellation ? 'echo cancel' : null,
    capture.autoGainControl ? 'auto gain' : null,
    capture.noiseSuppression ? 'noise suppress' : null,
  ].filter((entry): entry is string => entry !== null)
  return active.length === 0 ? 'none (raw)' : active.join(', ')
}

function displayMode(): string {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone (installed)'
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone
  return iosStandalone ? 'standalone (installed)' : 'browser tab'
}

renderStatus(engine.getStatus())
renderMeters(null)
void registerServiceWorker()
