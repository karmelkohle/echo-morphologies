/**
 * The parameter table — one source of truth for the DSP engine and the UI.
 *
 * The engine switches on {@link ParamId}; the interface builds its controls by
 * walking {@link PARAMS}. Adding a grain-size knob later means one entry here
 * and one `case` in EngineCore — the UI picks it up for free.
 *
 * Ids are stable small integers rather than strings so the same table can drive
 * a WebAssembly engine across the `engine_set_param(int, float)` boundary.
 */

export const ParamId = {
  InputTrimDb: 0,
  OutputGainDb: 1,
  Mute: 2,
} as const

export type ParamId = (typeof ParamId)[keyof typeof ParamId]

export const PARAM_COUNT = 3

export type ParamKind = 'continuous' | 'toggle'

export interface ParamSpec {
  id: ParamId
  /** Stable machine name; used for persistence keys and DOM ids. */
  key: string
  label: string
  kind: ParamKind
  min: number
  max: number
  default: number
  step: number
  unit: string
  /** How long the engine takes to glide to a new value, in milliseconds. */
  smoothingMs: number
  /** Short human-readable value, e.g. `-12.0 dB`. */
  format: (value: number) => string
  /** One line of help shown under the control. */
  hint?: string
}

const db = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`

export const PARAMS: readonly ParamSpec[] = [
  {
    id: ParamId.InputTrimDb,
    key: 'inputTrimDb',
    label: 'Input trim',
    kind: 'continuous',
    min: -24,
    max: 24,
    default: 0,
    step: 0.5,
    unit: 'dB',
    smoothingMs: 30,
    format: db,
    hint: 'Capture level into the engine. Aim for peaks around −12 dBFS.',
  },
  {
    id: ParamId.OutputGainDb,
    key: 'outputGainDb',
    label: 'Output gain',
    kind: 'continuous',
    min: -60,
    max: 12,
    default: -12,
    step: 0.5,
    unit: 'dB',
    smoothingMs: 30,
    format: db,
    hint: 'Playback level into the earbuds, applied before the safety limiter.',
  },
  {
    id: ParamId.Mute,
    key: 'mute',
    label: 'Mute',
    kind: 'toggle',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 8,
    format: (v) => (v >= 0.5 ? 'muted' : 'open'),
  },
]

export const PARAM_BY_ID: ReadonlyMap<ParamId, ParamSpec> = new Map(PARAMS.map((p) => [p.id, p]))

export function defaultParamValues(): Map<ParamId, number> {
  return new Map(PARAMS.map((p) => [p.id, p.default]))
}
