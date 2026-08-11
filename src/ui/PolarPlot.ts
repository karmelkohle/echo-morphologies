import { SLOT_COUNT } from '../engine/params'

/**
 * Top-down view of the field around the listener's head.
 *
 * Mapping: front (azimuth 0°) is up, positive azimuth — the app's
 * counter-clockwise, spatdsp convention — is to the LEFT, matching what the
 * ears do. Radius carries elevation: straight overhead (+90°) is the centre,
 * the horizon (0°) is the mid ring, and −90° is the rim. A dot walking
 * outward is sinking below you.
 *
 * Three layers per active slot, in the slot's colour:
 * - a translucent wedge for the spread (azimuth ± dev between the elevation
 *   band's radii) — where material MAY land,
 * - a ring dot for the target — where it is aimed,
 * - small dots for the voices actually sounding, brightness following level.
 */

export interface SlotPlotState {
  active: boolean
  azimuthDeg: number
  azimuthDevDeg: number
  elevationDeg: number
  elevationDevDeg: number
}

export const SLOT_COLORS = ['#5ad1c0', '#f18b73', '#9a8da7']

const TAU = Math.PI * 2

export class PolarPlot {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D | null
  private slots: SlotPlotState[] = []
  /** (slot, az, el, level) quads from the engine's viz report. */
  private viz: number[] = []
  /** Voices fade rather than blink: keyed dots decay between reports. */
  private dirty = true

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.context = canvas.getContext('2d')
    new ResizeObserver(() => this.resize()).observe(canvas)
    this.resize()
  }

  setSlots(slots: SlotPlotState[]): void {
    this.slots = slots
    this.dirty = true
  }

  setViz(viz: number[]): void {
    this.viz = viz
    this.dirty = true
  }

  render(): void {
    if (!this.dirty) return
    this.dirty = false
    this.paint()
  }

  private resize(): void {
    // A hidden page reports zero width; keep the last real backing store
    // rather than collapsing to a 1-pixel canvas with a negative plot radius.
    if (this.canvas.clientWidth === 0) return
    const ratio = window.devicePixelRatio || 1
    const size = Math.max(1, Math.round(this.canvas.clientWidth * ratio))
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size
      this.canvas.height = size
      this.dirty = true
      this.paint()
    }
  }

  /** Elevation → radius (fraction of R): +90 centre, 0 mid, −90 rim. */
  private radiusOf(elevationDeg: number): number {
    return (90 - Math.max(-90, Math.min(90, elevationDeg))) / 180
  }

  /** Azimuth → canvas angle. 0° up, positive counter-clockwise (left). */
  private angleOf(azimuthDeg: number): number {
    return (-azimuthDeg * Math.PI) / 180 - Math.PI / 2
  }

  private paint(): void {
    const ctx = this.context
    if (!ctx) return
    const size = this.canvas.width
    const cx = size / 2
    const cy = size / 2
    const R = size / 2 - 6 * (window.devicePixelRatio || 1)
    // Too small to draw meaningfully — and negative radii throw.
    if (R <= 8) return

    ctx.clearRect(0, 0, size, size)

    // ── ground: rings and axes ───────────────────────────────────────────
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(141, 153, 171, 0.18)'
    for (const el of [60, 30, -30, -60]) {
      ctx.beginPath()
      ctx.arc(cx, cy, R * this.radiusOf(el), 0, TAU)
      ctx.stroke()
    }
    // The horizon carries more weight: it is where the world usually is.
    ctx.strokeStyle = 'rgba(141, 153, 171, 0.4)'
    ctx.beginPath()
    ctx.arc(cx, cy, R * this.radiusOf(0), 0, TAU)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(141, 153, 171, 0.25)'
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, TAU)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(141, 153, 171, 0.12)'
    ctx.beginPath()
    ctx.moveTo(cx, cy - R)
    ctx.lineTo(cx, cy + R)
    ctx.moveTo(cx - R, cy)
    ctx.lineTo(cx + R, cy)
    ctx.stroke()

    const scale = window.devicePixelRatio || 1
    ctx.fillStyle = 'rgba(141, 153, 171, 0.55)'
    ctx.font = `${11 * scale}px ui-sans-serif, system-ui`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('front', cx, cy - R - -10 * scale)
    ctx.fillText('L', cx - R + 12 * scale, cy)
    ctx.fillText('R', cx + R - 12 * scale, cy)
    ctx.fillText('back', cx, cy + R - 10 * scale)

    // Listener.
    ctx.fillStyle = 'rgba(232, 237, 245, 0.8)'
    ctx.beginPath()
    ctx.arc(cx, cy, 3 * scale, 0, TAU)
    ctx.fill()

    // ── per-slot: spread wedge + target ──────────────────────────────────
    for (let s = 0; s < Math.min(SLOT_COUNT, this.slots.length); s++) {
      const slot = this.slots[s]
      if (!slot.active) continue
      const color = SLOT_COLORS[s]

      const rInner = R * this.radiusOf(slot.elevationDeg + slot.elevationDevDeg)
      const rOuter = R * this.radiusOf(slot.elevationDeg - slot.elevationDevDeg)
      // Canvas arcs run clockwise for growing angles; our azimuth runs the
      // other way, so the wedge spans [angle(az+dev), angle(az−dev)].
      const a0 = this.angleOf(slot.azimuthDeg + slot.azimuthDevDeg)
      const a1 = this.angleOf(slot.azimuthDeg - slot.azimuthDevDeg)

      ctx.fillStyle = color + '22'
      ctx.strokeStyle = color + '55'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(rOuter, 1), a0, a1)
      ctx.arc(cx, cy, Math.max(rInner, 0.5), a1, a0, true)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()

      const tr = R * this.radiusOf(slot.elevationDeg)
      const ta = this.angleOf(slot.azimuthDeg)
      const tx = cx + tr * Math.cos(ta)
      const ty = cy + tr * Math.sin(ta)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(tx, ty, 6 * scale, 0, TAU)
      ctx.fill()
      ctx.strokeStyle = 'rgba(11, 14, 19, 0.7)'
      ctx.lineWidth = 2 * scale
      ctx.stroke()
    }

    // ── voices ────────────────────────────────────────────────────────────
    for (let v = 0; v + 3 < this.viz.length; v += 4) {
      const s = Math.round(this.viz[v])
      const az = this.viz[v + 1]
      const el = this.viz[v + 2]
      const level = Math.max(0, Math.min(1, this.viz[v + 3]))
      if (level <= 0.001) continue
      const color = SLOT_COLORS[s] ?? SLOT_COLORS[0]

      const r = R * this.radiusOf(el)
      const a = this.angleOf(az)
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)

      // Brightness carries level: alpha and a touch of size.
      const alpha = 0.25 + 0.75 * Math.sqrt(level)
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, (2 + 2 * level) * scale, 0, TAU)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }
}
