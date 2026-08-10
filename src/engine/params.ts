/**
 * The parameter table — one source of truth for the DSP engine and the UI.
 *
 * The engine switches on {@link ParamId}; the interface builds its controls by
 * walking {@link PARAMS}. Adding a parameter means one entry here and one
 * `case` in EngineCore — the control appears with the right range, step,
 * formatting and section, already wired.
 *
 * Ids are stable small integers rather than strings so the same table can
 * drive a WebAssembly engine across the `engine_set_param(int, float)`
 * boundary. Never renumber an existing id.
 *
 * The base ± deviation pairs (delay, pitch, azimuth, elevation, length) are
 * msf's DeviationParam paradigm applied per grain: the base composes, the
 * deviation scatters.
 */

export const ParamId = {
  InputTrimDb: 0,
  OutputGainDb: 1,
  Mute: 2,

  GranularEnabled: 3,
  BufferSec: 4,
  DelayMs: 5,
  DelayDevMs: 6,
  Density: 7,
  LengthMs: 8,
  LengthJitter: 9,
  PitchSemis: 10,
  PitchDevSemis: 11,
  ReverseProb: 12,
  EnvShape: 13,
  Scheduler: 14,

  AzimuthDeg: 15,
  AzimuthDevDeg: 16,
  ElevationDeg: 17,
  ElevationDevDeg: 18,
} as const

export type ParamId = (typeof ParamId)[keyof typeof ParamId]

export const PARAM_COUNT = 19

export type ParamKind = 'continuous' | 'toggle' | 'enum'

/** Sections the interface renders, in this order. */
export const PARAM_GROUPS = [
  { key: 'levels', title: 'Levels' },
  { key: 'grains', title: 'Granular delay' },
  { key: 'space', title: 'Spatial target' },
] as const

export type ParamGroup = (typeof PARAM_GROUPS)[number]['key']

export interface ParamSpec {
  id: ParamId
  /** Stable machine name; used for persistence keys and DOM ids. */
  key: string
  label: string
  kind: ParamKind
  group: ParamGroup
  min: number
  max: number
  default: number
  step: number
  unit: string
  /** How long the engine takes to glide to a new value, in milliseconds.
   *  Grain parameters are read once at spawn, so most of these are 0. */
  smoothingMs: number
  /** Labels for `enum` kind; the value is the index. */
  options?: readonly string[]
  /** Visual weight of a toggle's ON state: does ON mean go, or beware. */
  toggleTone?: 'positive' | 'alarm'
  /** Short human-readable value, e.g. `-12.0 dB`. */
  format: (value: number) => string
  /** One line of help shown under the control. */
  hint?: string
}

const db = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`)
const deg = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)}°`
const pct = (value: number) => `${Math.round(value * 100)}%`

export const PARAMS: readonly ParamSpec[] = [
  // ── levels ────────────────────────────────────────────────────────────────
  {
    id: ParamId.InputTrimDb,
    key: 'inputTrimDb',
    label: 'Input trim',
    kind: 'continuous',
    group: 'levels',
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
    group: 'levels',
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
    group: 'levels',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 8,
    format: (v) => (v >= 0.5 ? 'muted' : 'open'),
    toggleTone: 'alarm',
  },

  // ── granular delay ───────────────────────────────────────────────────────
  {
    id: ParamId.GranularEnabled,
    key: 'granular',
    label: 'Granular',
    kind: 'toggle',
    group: 'grains',
    min: 0,
    max: 1,
    default: 1,
    step: 1,
    unit: '',
    smoothingMs: 0,
    format: (v) => (v >= 0.5 ? 'on' : 'bypassed'),
    toggleTone: 'positive',
    hint: 'Off routes the microphone straight through — the A/B reference.',
  },
  {
    id: ParamId.BufferSec,
    key: 'bufferSec',
    label: 'Buffer size',
    kind: 'continuous',
    group: 'grains',
    min: 0.5,
    max: 20,
    default: 8,
    step: 0.5,
    unit: 's',
    smoothingMs: 0,
    format: (v) => `${v.toFixed(1)} s`,
    hint: 'How much of the past the ring buffer keeps for grains to read.',
  },
  {
    id: ParamId.DelayMs,
    key: 'delayMs',
    label: 'Read delay',
    kind: 'continuous',
    group: 'grains',
    min: 0,
    max: 8000,
    default: 250,
    step: 10,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
    hint: 'How far behind realtime the grains read. 0 stays at the present.',
  },
  {
    id: ParamId.DelayDevMs,
    key: 'delayDevMs',
    label: 'Delay scatter',
    kind: 'continuous',
    group: 'grains',
    min: 0,
    max: 4000,
    default: 120,
    step: 10,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
    hint: 'Each grain lands within ± this of the read delay.',
  },
  {
    id: ParamId.Density,
    key: 'density',
    label: 'Density',
    kind: 'continuous',
    group: 'grains',
    min: 0.5,
    max: 150,
    default: 25,
    step: 0.5,
    unit: '/s',
    smoothingMs: 0,
    format: (v) => `${v.toFixed(1)} /s`,
    hint: 'Grain onsets per second.',
  },
  {
    id: ParamId.LengthMs,
    key: 'lengthMs',
    label: 'Grain length',
    kind: 'continuous',
    group: 'grains',
    min: 5,
    max: 500,
    default: 90,
    step: 5,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },
  {
    id: ParamId.LengthJitter,
    key: 'lengthJitter',
    label: 'Length jitter',
    kind: 'continuous',
    group: 'grains',
    min: 0,
    max: 1,
    default: 0.35,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
    hint: 'Relative scatter of each grain’s length.',
  },
  {
    id: ParamId.PitchSemis,
    key: 'pitchSemis',
    label: 'Pitch',
    kind: 'continuous',
    group: 'grains',
    min: -24,
    max: 24,
    default: 0,
    step: 1,
    unit: 'st',
    smoothingMs: 0,
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} st`,
    hint: 'Per-grain playback transposition.',
  },
  {
    id: ParamId.PitchDevSemis,
    key: 'pitchDevSemis',
    label: 'Pitch scatter',
    kind: 'continuous',
    group: 'grains',
    min: 0,
    max: 24,
    default: 0,
    step: 0.5,
    unit: 'st',
    smoothingMs: 0,
    format: (v) => `±${v.toFixed(1)} st`,
  },
  {
    id: ParamId.ReverseProb,
    key: 'reverseProb',
    label: 'Reverse grains',
    kind: 'continuous',
    group: 'grains',
    min: 0,
    max: 1,
    default: 0,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
    hint: 'Chance a grain plays its slice backwards.',
  },
  {
    id: ParamId.EnvShape,
    key: 'envShape',
    label: 'Grain window',
    kind: 'enum',
    group: 'grains',
    min: 0,
    max: 3,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    options: ['Hann', 'Tukey', 'Gaussian', 'Triangle'],
    format: (v) => ['Hann', 'Tukey', 'Gaussian', 'Triangle'][Math.round(v)] ?? '?',
  },
  {
    id: ParamId.Scheduler,
    key: 'scheduler',
    label: 'Onset timing',
    kind: 'enum',
    group: 'grains',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    options: ['Metronomic', 'Poisson'],
    format: (v) => ['Metronomic', 'Poisson'][Math.round(v)] ?? '?',
    hint: 'Poisson kills the machine-gun effect at low densities.',
  },

  // ── spatial target ───────────────────────────────────────────────────────
  {
    id: ParamId.AzimuthDeg,
    key: 'azimuthDeg',
    label: 'Azimuth',
    kind: 'continuous',
    group: 'space',
    min: -180,
    max: 180,
    default: 0,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: deg,
    hint: '0° is straight ahead; positive is counter-clockwise (to the left).',
  },
  {
    id: ParamId.AzimuthDevDeg,
    key: 'azimuthDevDeg',
    label: 'Azimuth spread',
    kind: 'continuous',
    group: 'space',
    min: 0,
    max: 180,
    default: 40,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: (v) => `±${Math.round(v)}°`,
    hint: 'Each grain draws its direction within ± this of the target.',
  },
  {
    id: ParamId.ElevationDeg,
    key: 'elevationDeg',
    label: 'Elevation',
    kind: 'continuous',
    group: 'space',
    min: -90,
    max: 90,
    default: 0,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: deg,
  },
  {
    id: ParamId.ElevationDevDeg,
    key: 'elevationDevDeg',
    label: 'Elevation spread',
    kind: 'continuous',
    group: 'space',
    min: 0,
    max: 90,
    default: 15,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: (v) => `±${Math.round(v)}°`,
  },
]

export const PARAM_BY_ID: ReadonlyMap<ParamId, ParamSpec> = new Map(PARAMS.map((p) => [p.id, p]))

export function defaultParamValues(): Map<ParamId, number> {
  return new Map(PARAMS.map((p) => [p.id, p.default]))
}
