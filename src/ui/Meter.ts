import { gainToDb } from '../engine/dsp/math'

/** Bottom of the meter scale, in dBFS. Matches the tick labels in index.html. */
const FLOOR_DB = -60
const CEILING_DB = 0

/** Bar ballistics: instant rise, steady fall. */
const BAR_FALL_DB_PER_SECOND = 34

/** Peak-hold marker: freeze at a new maximum, then fall away. */
const HOLD_MS = 1200
const HOLD_FALL_DB_PER_SECOND = 24

/** Guards the ballistics against a long frame gap after a stall or a resume. */
const MAX_FRAME_S = 0.1

function dbToNorm(db: number): number {
  const t = (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * A horizontal level meter: RMS as a filled bar, instantaneous peak as a bright
 * edge, and a peak-hold marker that falls back at a fixed rate.
 *
 * The bars fall at a fixed rate rather than tracking the measurement directly.
 * The engine reports every 33 ms, and city sound is mostly transients — drawn
 * literally, the meter spends most of its time at the floor and flickers, which
 * is exactly the opposite of what a proof-of-life indicator should do. Rising
 * instantly and falling slowly is the standard answer and it reads correctly at
 * a glance while walking.
 *
 * Levels arrive on the metering clock and the bars fall on the display clock,
 * so `setLevels` and `render` are separate calls.
 */
export class Meter {
  readonly element: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D | null
  private readonly readout: HTMLSpanElement

  /** Latest measurement. */
  private peakDb = FLOOR_DB
  private rmsDb = FLOOR_DB
  /** What is actually drawn, after ballistics. */
  private shownPeakDb = FLOOR_DB
  private shownRmsDb = FLOOR_DB

  private holdDb = FLOOR_DB
  private holdSetAt = 0
  private lastFrameAt = 0

  constructor(name: string) {
    this.element = document.createElement('div')
    this.element.className = 'meter-row'

    const label = document.createElement('span')
    label.className = 'meter-name'
    label.textContent = name

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'meter-canvas'
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', `${name} level`)

    this.readout = document.createElement('span')
    this.readout.className = 'meter-value'
    this.readout.textContent = '−∞'

    this.element.append(label, this.canvas, this.readout)
    this.context = this.canvas.getContext('2d')

    // The canvas is laid out by CSS, so its backing store has to be resized to
    // match — otherwise it renders blurry on a phone's 3× display.
    new ResizeObserver(() => this.resize()).observe(this.canvas)
  }

  setLevels(peak: number, rms: number, now: number): void {
    this.peakDb = gainToDb(peak)
    this.rmsDb = gainToDb(rms)
    if (this.peakDb >= this.holdDb) {
      this.holdDb = this.peakDb
      this.holdSetAt = now
    }
  }

  clear(): void {
    this.peakDb = FLOOR_DB
    this.rmsDb = FLOOR_DB
    this.shownPeakDb = FLOOR_DB
    this.shownRmsDb = FLOOR_DB
    this.holdDb = FLOOR_DB
    this.lastFrameAt = 0
    this.readout.textContent = '−∞'
    this.readout.dataset.hot = 'false'
    this.paint()
  }

  render(now: number): void {
    const dt = this.lastFrameAt === 0 ? 0 : Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_S)
    this.lastFrameAt = now

    const fall = BAR_FALL_DB_PER_SECOND * dt
    this.shownPeakDb = Math.max(this.peakDb, this.shownPeakDb - fall)
    this.shownRmsDb = Math.max(this.rmsDb, this.shownRmsDb - fall)

    const age = now - this.holdSetAt
    if (age > HOLD_MS && this.holdDb > FLOOR_DB) {
      this.holdDb = Math.max(FLOOR_DB, this.holdDb - (HOLD_FALL_DB_PER_SECOND * (age - HOLD_MS)) / 1000)
      this.holdSetAt = now - HOLD_MS
    }

    // The number is the held peak, not the falling bar: it answers "how loud
    // did that get", which is the question you ask a meter.
    this.readout.textContent = this.holdDb <= FLOOR_DB ? '−∞' : this.holdDb.toFixed(1)
    this.readout.dataset.hot = this.holdDb >= -1 ? 'true' : 'false'

    this.paint()
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio))
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
      this.paint()
    }
  }

  private paint(): void {
    const ctx = this.context
    if (!ctx) return

    const { width, height } = this.canvas
    ctx.clearRect(0, 0, width, height)

    const gradient = ctx.createLinearGradient(0, 0, width, 0)
    gradient.addColorStop(0, '#1f8f81')
    gradient.addColorStop(dbToNorm(-12), '#5ad1c0')
    gradient.addColorStop(dbToNorm(-6), '#e8b04b')
    gradient.addColorStop(1, '#e8615a')

    // RMS body: what the signal is doing on average.
    ctx.fillStyle = gradient
    ctx.globalAlpha = 0.55
    ctx.fillRect(0, 0, dbToNorm(this.shownRmsDb) * width, height)

    // Peak body: the ceiling that actually matters for clipping.
    ctx.globalAlpha = 1
    ctx.fillRect(0, height * 0.3, dbToNorm(this.shownPeakDb) * width, height * 0.4)

    // Peak hold.
    if (this.holdDb > FLOOR_DB) {
      const x = Math.min(width - 2, dbToNorm(this.holdDb) * width)
      ctx.fillStyle = this.holdDb >= -1 ? '#ff8b85' : '#dfe9f5'
      ctx.fillRect(x, 0, 2, height)
    }
  }
}
