import { PARAMS, type ParamId, type ParamSpec } from '../engine/params'

/**
 * Builds the control surface straight from the parameter table.
 *
 * Nothing here knows what a gain is. Add an entry to `PARAMS` — grain density,
 * spread, HRTF elevation offset — and its control appears with the right range,
 * step and formatting, already wired to the engine.
 */

export interface ControlHost {
  getParam(id: ParamId): number
  setParam(id: ParamId, value: number): void
}

export interface ControlSurface {
  /** Re-reads every value from the host, e.g. after a preset load. */
  refresh(): void
}

export function buildControls(container: HTMLElement, host: ControlHost): ControlSurface {
  const refreshers: Array<() => void> = []

  for (const spec of PARAMS) {
    const { element, refresh } = spec.kind === 'toggle' ? buildToggle(spec, host) : buildFader(spec, host)
    container.append(element)
    refreshers.push(refresh)
  }

  return {
    refresh: () => refreshers.forEach((fn) => fn()),
  }
}

interface BuiltControl {
  element: HTMLElement
  refresh: () => void
}

function buildFader(spec: ParamSpec, host: ControlHost): BuiltControl {
  const wrapper = document.createElement('div')
  wrapper.className = 'control'

  const head = document.createElement('div')
  head.className = 'control-head'

  const label = document.createElement('label')
  label.className = 'control-label'
  label.htmlFor = `param-${spec.key}`
  label.textContent = spec.label

  const value = document.createElement('span')
  value.className = 'control-value'

  head.append(label, value)

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.id = `param-${spec.key}`
  slider.min = String(spec.min)
  slider.max = String(spec.max)
  slider.step = String(spec.step)

  const show = (v: number) => {
    value.textContent = spec.format(v)
    slider.setAttribute('aria-valuetext', spec.format(v))
  }

  slider.addEventListener('input', () => {
    const v = Number(slider.value)
    host.setParam(spec.id, v)
    show(v)
  })

  wrapper.append(head, slider)

  if (spec.hint) {
    const hint = document.createElement('p')
    hint.className = 'control-hint'
    hint.textContent = spec.hint
    wrapper.append(hint)
  }

  const refresh = () => {
    const v = host.getParam(spec.id)
    slider.value = String(v)
    show(v)
  }
  refresh()

  return { element: wrapper, refresh }
}

function buildToggle(spec: ParamSpec, host: ControlHost): BuiltControl {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'toggle'

  const show = (on: boolean) => {
    button.setAttribute('aria-pressed', String(on))
    // The label alone when off; label plus formatted state when on, so the
    // active case reads correctly for any toggle added later.
    button.textContent = on ? `${spec.label} · ${spec.format(1)}` : spec.label
  }

  button.addEventListener('click', () => {
    const on = host.getParam(spec.id) < 0.5
    host.setParam(spec.id, on ? 1 : 0)
    show(on)
  })

  const refresh = () => show(host.getParam(spec.id) >= 0.5)
  refresh()

  return { element: button, refresh }
}
