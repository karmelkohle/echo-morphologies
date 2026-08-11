import './style.css'

import { AudioEngine, type EngineStatus, type MeterSnapshot } from './audio/AudioEngine'
import {
  EFFECT_LOCALS,
  EffectType,
  GLOBAL_PARAMS,
  ParamId,
  SLOT_COUNT,
  SlotParam,
  makeSlotParams,
  slotParamId,
  type EffectType as EffectTypeT,
} from './engine/params'
import { registerServiceWorker } from './pwa/register-sw'
import { Meter } from './ui/Meter'
import { PolarPlot, SLOT_COLORS, type SlotPlotState } from './ui/PolarPlot'
import { buildControl } from './ui/controls'
import { StatusTable } from './ui/status'

/**
 * Application wiring: two pages (play / config), controls generated from the
 * parameter table, and the polar plot fed by the engine's viz reports. Holds
 * no audio state of its own.
 */

const engine = new AudioEngine()

// ── page routing ──────────────────────────────────────────────────────────

const pagePlay = requireElement<HTMLElement>('page-play')
const pageConfig = requireElement<HTMLElement>('page-config')
const navPlay = requireElement<HTMLButtonElement>('nav-play')
const navConfig = requireElement<HTMLButtonElement>('nav-config')

function showPage(page: 'play' | 'config'): void {
  document.body.dataset.page = page
  pagePlay.hidden = page !== 'play'
  pageConfig.hidden = page !== 'config'
  navPlay.setAttribute('aria-pressed', String(page === 'play'))
  navConfig.setAttribute('aria-pressed', String(page === 'config'))
}

navPlay.addEventListener('click', () => showPage('play'))
navConfig.addEventListener('click', () => showPage('config'))

// ── shared chrome ─────────────────────────────────────────────────────────

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
requireElement<HTMLDivElement>('meters').append(
  meters.input.element,
  meters.left.element,
  meters.right.element,
)

// ── controls host: every set also refreshes the plot state ────────────────

const host = {
  getParam: (id: number) => engine.getParam(id),
  setParam: (id: number, value: number) => {
    engine.setParam(id, value)
    refreshPlotSlots()
  },
}

// Quick controls on the play page; calibration on the config page.
const byId = new Map(GLOBAL_PARAMS.map((p) => [p.id, p]))
const quick = requireElement<HTMLDivElement>('quick-controls')
for (const id of [ParamId.OutputGainDb, ParamId.Mute, ParamId.DryMonitor]) {
  quick.append(buildControl(byId.get(id)!, host).element)
}
const config = requireElement<HTMLDivElement>('config-controls')
for (const id of [ParamId.InputTrimDb, ParamId.HrirSet]) {
  config.append(buildControl(byId.get(id)!, host).element)
}

// ── microphone picker (host-level, not an engine param) ───────────────────

const inputDeviceControl = requireElement<HTMLDivElement>('input-device-control')
const inputDeviceSelect = requireElement<HTMLSelectElement>('input-device')

inputDeviceSelect.addEventListener('change', () => {
  const value = inputDeviceSelect.value
  void engine.setInputDevice(value === '' ? null : value)
})

// ── channel test ──────────────────────────────────────────────────────────

const testButtons: Array<[string, 'left' | 'right' | 'both']> = [
  ['test-left', 'left'],
  ['test-both', 'both'],
  ['test-right', 'right'],
]
for (const [id, channel] of testButtons) {
  requireElement<HTMLButtonElement>(id).addEventListener('click', () => engine.playTestTone(channel))
}

function renderChannelTest(next: EngineStatus): void {
  const enabled = next.state === 'running' || next.state === 'interrupted'
  for (const [id] of testButtons) {
    requireElement<HTMLButtonElement>(id).disabled = !enabled
  }
}

function renderInputDevices(next: EngineStatus): void {
  const devices = next.inputDevices
  if (devices.length === 0) {
    inputDeviceControl.hidden = true
    return
  }
  inputDeviceControl.hidden = false
  inputDeviceSelect.replaceChildren()
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = 'system default'
  inputDeviceSelect.append(auto)
  for (const device of devices) {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = device.label
    inputDeviceSelect.append(option)
  }
  inputDeviceSelect.value = next.inputDeviceId ?? ''
}

// ── polar plot (before the slots: their builders push state into it) ──────

const plot = new PolarPlot(requireElement<HTMLCanvasElement>('polar-plot'))
const legend = requireElement<HTMLParagraphElement>('plot-legend')

// ── effect pipeline slots ─────────────────────────────────────────────────

const SLOT_NAMES = ['A', 'B', 'C']
const slotsContainer = requireElement<HTMLElement>('slots')

interface SlotSection {
  effectControls: HTMLDivElement
  rebuildEffectControls: () => void
}

const slotSections: SlotSection[] = []

for (let s = 0; s < SLOT_COUNT; s++) {
  const specs = makeSlotParams(s)
  const specByLocal = new Map(specs.map((p) => [p.id - slotParamId(s, 0), p]))

  const section = document.createElement('section')
  section.className = 'panel slot'
  section.style.setProperty('--slot-color', SLOT_COLORS[s])

  const heading = document.createElement('h2')
  heading.className = 'slot-head'
  heading.innerHTML = `<span class="slot-chip"></span>pipeline ${SLOT_NAMES[s]}`
  section.append(heading)

  const controls = document.createElement('div')
  controls.className = 'controls'
  section.append(controls)

  // The effect picker, then the spatial target, then the chosen effect's own
  // parameters (rebuilt on every effect change).
  const effectSpec = specByLocal.get(SlotParam.Effect)!
  const picker = buildControl(effectSpec, {
    getParam: host.getParam,
    setParam: (id, value) => {
      host.setParam(id, value)
      rebuild()
    },
  })
  controls.append(picker.element)

  const spatial = document.createElement('div')
  spatial.className = 'controls slot-spatial'
  for (const local of [
    SlotParam.WetDb,
    SlotParam.AzimuthDeg,
    SlotParam.AzimuthDevDeg,
    SlotParam.ElevationDeg,
    SlotParam.ElevationDevDeg,
  ]) {
    spatial.append(buildControl(specByLocal.get(local)!, host).element)
  }
  controls.append(spatial)

  const effectControls = document.createElement('div')
  effectControls.className = 'controls slot-effect'
  controls.append(effectControls)

  const rebuild = () => {
    effectControls.replaceChildren()
    const effect = Math.round(engine.getParam(slotParamId(s, SlotParam.Effect))) as EffectTypeT
    spatial.hidden = effect === EffectType.Off
    for (const local of EFFECT_LOCALS[effect] ?? []) {
      const spec = specByLocal.get(local)
      if (spec) effectControls.append(buildControl(spec, host).element)
    }
    refreshPlotSlots()
  }
  rebuild()

  slotSections.push({ effectControls, rebuildEffectControls: rebuild })
  slotsContainer.append(section)
}

// ── polar plot state ──────────────────────────────────────────────────────

function refreshPlotSlots(): void {
  const states: SlotPlotState[] = []
  const legendBits: string[] = []
  for (let s = 0; s < SLOT_COUNT; s++) {
    const effect = Math.round(engine.getParam(slotParamId(s, SlotParam.Effect))) as EffectTypeT
    const active = effect !== EffectType.Off
    states.push({
      active,
      azimuthDeg: engine.getParam(slotParamId(s, SlotParam.AzimuthDeg)),
      azimuthDevDeg: engine.getParam(slotParamId(s, SlotParam.AzimuthDevDeg)),
      elevationDeg: engine.getParam(slotParamId(s, SlotParam.ElevationDeg)),
      elevationDevDeg: engine.getParam(slotParamId(s, SlotParam.ElevationDevDeg)),
    })
    if (active) {
      legendBits.push(
        `<span class="legend-item" style="--slot-color:${SLOT_COLORS[s]}">${SLOT_NAMES[s]}</span>`,
      )
    }
  }
  plot.setSlots(states)
  legend.innerHTML = legendBits.length
    ? `sounding: ${legendBits.join(' ')}`
    : 'no pipeline active — pick an effect below'
}

refreshPlotSlots()

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
      // Already reflected in the status banner; this keeps the console quiet.
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
    plot.setViz([])
    plot.render()
  } else {
    startAnimation()
  }
}

engine.onMeters = (snapshot) => {
  const now = performance.now()
  meters.input.setLevels(snapshot.inputPeak, snapshot.inputRms, now)
  meters.left.setLevels(snapshot.leftPeak, snapshot.leftRms, now)
  meters.right.setLevels(snapshot.rightPeak, snapshot.rightRms, now)
  plot.setViz(snapshot.viz)
  renderMeters(snapshot)
}

function renderStatus(next: EngineStatus): void {
  stateBadge.dataset.state = next.state
  stateLabel.textContent = next.state

  const stopping = next.state !== 'idle' && next.state !== 'error'
  transport.textContent = stopping ? 'Stop' : 'Start listening'
  transport.dataset.mode = stopping ? 'stop' : 'start'
  headphoneWarning.hidden = stopping

  renderInputDevices(next)
  renderChannelTest(next)

  // Route problems outrank ordinary messages: a mono route silently unmakes
  // the whole piece, so it takes over the banner until fixed.
  const message = next.routeWarning ?? next.message
  const remedyText = next.routeWarning ? null : next.remedy
  if (message) {
    notice.hidden = false
    notice.textContent = message
    if (remedyText) {
      const remedy = document.createElement('span')
      remedy.className = 'remedy'
      remedy.textContent = remedyText
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
  status.set(
    'output channels',
    next.outputChannels !== null ? String(next.outputChannels) : '—',
    next.outputChannels !== null && next.outputChannels < 2 ? 'alert' : 'neutral',
  )
  status.set('screen wake lock', next.screenLockHeld ? 'held' : 'not available')
  status.set('display mode', displayMode())

  const hrtf = next.hrtf
  switch (hrtf.state) {
    case 'none':
      status.set('hrtf set', '—')
      break
    case 'loading':
      status.set('hrtf set', `loading ${hrtf.label}…`, 'warn')
      break
    case 'active':
      status.set(
        'hrtf set',
        `${hrtf.label} · ${hrtf.positions.toLocaleString()} pos × ${hrtf.taps} taps` +
          (hrtf.resampled ? ' · resampled' : ''),
        'good',
      )
      break
    case 'error':
      status.set('hrtf set', `${hrtf.label} failed: ${hrtf.message}`, 'alert')
      break
  }
}

function renderMeters(snapshot: MeterSnapshot | null): void {
  if (!snapshot) {
    status.set('render rate', '—')
    status.set('clock gaps', '—')
    status.set('input clipping', '—')
    status.set('limiter', '—')
    status.set('voices sounding', '—')
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
  status.set('voices sounding', String(Math.round(snapshot.activeVoices)))
}

// ── animation ─────────────────────────────────────────────────────────────

let frame = 0

function startAnimation(): void {
  if (frame !== 0) return
  const tick = () => {
    // The loop must survive any single frame's failure — a dead loop freezes
    // every meter readout, which reads as the whole engine having stopped.
    try {
      const now = performance.now()
      for (const meter of Object.values(meters)) meter.render(now)
      plot.render()
    } finally {
      frame = requestAnimationFrame(tick)
    }
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
plot.render()
void registerServiceWorker()
