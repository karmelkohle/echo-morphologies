import { PARAMS, PARAM_GROUPS, type ParamId, type ParamSpec } from '../engine/params'

/**
 * Builds the control surface straight from the parameter table.
 *
 * Nothing here knows what a gain or a grain is. Add an entry to `PARAMS` and
 * its control appears in the right section with the right range, step and
 * formatting, already wired to the engine.
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

  for (const group of PARAM_GROUPS) {
    const specs = PARAMS.filter((p) => p.group === group.key)
    if (specs.length === 0) continue

    const heading = document.createElement('h3')
    heading.className = 'control-group'
    heading.textContent = group.title
    container.append(heading)

    for (const spec of specs) {
      const built =
        spec.kind === 'toggle'
          ? buildToggle(spec, host)
          : spec.kind === 'enum'
            ? buildSelect(spec, host)
            : buildFader(spec, host)
      container.append(built.element)
      refreshers.push(built.refresh)
    }
  }

  return {
    refresh: () => refreshers.forEach((fn) => fn()),
  }
}

interface BuiltControl {
  element: HTMLElement
  refresh: () => void
}

function controlHead(spec: ParamSpec): { head: HTMLDivElement; value: HTMLSpanElement } {
  const head = document.createElement('div')
  head.className = 'control-head'

  const label = document.createElement('label')
  label.className = 'control-label'
  label.htmlFor = `param-${spec.key}`
  label.textContent = spec.label

  const value = document.createElement('span')
  value.className = 'control-value'

  head.append(label, value)
  return { head, value }
}

function withHint(wrapper: HTMLElement, spec: ParamSpec): void {
  if (!spec.hint) return
  const hint = document.createElement('p')
  hint.className = 'control-hint'
  hint.textContent = spec.hint
  wrapper.append(hint)
}

function buildFader(spec: ParamSpec, host: ControlHost): BuiltControl {
  const wrapper = document.createElement('div')
  wrapper.className = 'control'

  const { head, value } = controlHead(spec)

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
  withHint(wrapper, spec)

  const refresh = () => {
    const v = host.getParam(spec.id)
    slider.value = String(v)
    show(v)
  }
  refresh()

  return { element: wrapper, refresh }
}

function buildSelect(spec: ParamSpec, host: ControlHost): BuiltControl {
  const wrapper = document.createElement('div')
  wrapper.className = 'control'

  const { head, value } = controlHead(spec)

  const select = document.createElement('select')
  select.id = `param-${spec.key}`
  select.className = 'enum'
  for (const [index, name] of (spec.options ?? []).entries()) {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = name
    select.append(option)
  }

  const show = (v: number) => {
    value.textContent = spec.format(v)
  }

  select.addEventListener('change', () => {
    const v = Number(select.value)
    host.setParam(spec.id, v)
    show(v)
  })

  wrapper.append(head, select)
  withHint(wrapper, spec)

  const refresh = () => {
    const v = Math.round(host.getParam(spec.id))
    select.value = String(v)
    show(v)
  }
  refresh()

  return { element: wrapper, refresh }
}

function buildToggle(spec: ParamSpec, host: ControlHost): BuiltControl {
  const wrapper = document.createElement('div')
  wrapper.className = 'control'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'toggle'
  button.id = `param-${spec.key}`
  button.dataset.tone = spec.toggleTone ?? 'alarm'

  const show = (on: boolean) => {
    button.setAttribute('aria-pressed', String(on))
    button.textContent = `${spec.label} · ${spec.format(on ? 1 : 0)}`
  }

  button.addEventListener('click', () => {
    const on = host.getParam(spec.id) < 0.5
    host.setParam(spec.id, on ? 1 : 0)
    show(on)
  })

  wrapper.append(button)
  withHint(wrapper, spec)

  const refresh = () => show(host.getParam(spec.id) >= 0.5)
  refresh()

  return { element: wrapper, refresh }
}
