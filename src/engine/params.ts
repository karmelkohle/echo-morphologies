/**
 * The parameter table — one source of truth for the DSP engine and the UI.
 *
 * Two id spaces, both stable integers (a wasm engine takes them across
 * `engine_set_param(int, float)` unchanged — never renumber):
 *
 * - **Globals** (0..99): input trim, output gain, mute, HRTF set, dry monitor.
 * - **Slot params** (100+): the app runs up to {@link SLOT_COUNT} parallel
 *   effect pipelines; slot s owns ids 100+100·s .. 199+100·s, and the low two
 *   digits are a {@link SlotParam} local id. Locals 0..9 are the slot's own
 *   controls (effect choice, spatial target, wet level); 10+ belong to the
 *   effect classes in `src/engine/effects/`.
 *
 * Adding an effect = one class file in effects/, one entry in
 * {@link EFFECTS}, and its local param specs below. The GUI renders whatever
 * this table says.
 */

// ── globals ────────────────────────────────────────────────────────────────

export const ParamId = {
  InputTrimDb: 0,
  OutputGainDb: 1,
  Mute: 2,
  /** Handled by the host (it owns fetching); the engine ignores it. */
  HrirSet: 19,
  /** Routes the dry microphone to both ears instead of the pipelines. */
  DryMonitor: 20,
  /** IEC A-weighting on the capture, before anything downstream reads it. */
  CaptureWeighting: 21,
} as const

export type ParamId = (typeof ParamId)[keyof typeof ParamId]

// ── slots ──────────────────────────────────────────────────────────────────

export const SLOT_COUNT = 3
export const SLOT_PARAM_BASE = 100
export const SLOT_PARAM_SPAN = 100

/** Local (per-slot) parameter ids — the low two digits of a slot param id. */
export const SlotParam = {
  Effect: 0,
  AzimuthDeg: 1,
  AzimuthDevDeg: 2,
  ElevationDeg: 3,
  ElevationDevDeg: 4,
  WetDb: 5,

  // granular delay (10..29)
  BufferSec: 10,
  DelayMs: 11,
  DelayDevMs: 12,
  Density: 13,
  LengthMs: 14,
  LengthJitter: 15,
  PitchSemis: 16,
  PitchDevSemis: 17,
  ReverseProb: 18,
  EnvShape: 19,
  Scheduler: 20,

  // echo delay (30..39)
  EchoTimeMs: 30,
  EchoFeedback: 31,
  EchoDamping: 32,

  // fdn reverb (40..49)
  ReverbT60: 40,
  ReverbDamping: 41,
  ReverbPredelayMs: 42,

  // additive pads (50..59)
  AddAttackMs: 50,
  AddReleaseMs: 51,
  AddPartials: 52,
  AddSpacing: 53,
  AddOddEven: 54,
  AddGlideMs: 55,
} as const

export type SlotParam = (typeof SlotParam)[keyof typeof SlotParam]

export const slotParamId = (slot: number, local: number): number =>
  SLOT_PARAM_BASE + slot * SLOT_PARAM_SPAN + local

export const isSlotParam = (id: number): boolean => id >= SLOT_PARAM_BASE
export const slotOfParam = (id: number): number => Math.floor((id - SLOT_PARAM_BASE) / SLOT_PARAM_SPAN)
export const localOfParam = (id: number): number => (id - SLOT_PARAM_BASE) % SLOT_PARAM_SPAN

// ── effects ────────────────────────────────────────────────────────────────

export const EffectType = {
  Off: 0,
  Granular: 1,
  Echo: 2,
  Reverb: 3,
  Additive: 4,
} as const

export type EffectType = (typeof EffectType)[keyof typeof EffectType]

/** Display names, indexed by EffectType. */
export const EFFECTS = ['Off', 'Granular delay', 'Echo delay', 'FDN reverb', 'Additive pads'] as const

/** Which local params the GUI shows for each effect (besides the slot's own). */
export const EFFECT_LOCALS: Record<EffectType, readonly number[]> = {
  [EffectType.Off]: [],
  [EffectType.Granular]: [
    SlotParam.BufferSec,
    SlotParam.DelayMs,
    SlotParam.DelayDevMs,
    SlotParam.Density,
    SlotParam.LengthMs,
    SlotParam.LengthJitter,
    SlotParam.PitchSemis,
    SlotParam.PitchDevSemis,
    SlotParam.ReverseProb,
    SlotParam.EnvShape,
    SlotParam.Scheduler,
  ],
  [EffectType.Echo]: [SlotParam.EchoTimeMs, SlotParam.EchoFeedback, SlotParam.EchoDamping],
  [EffectType.Reverb]: [SlotParam.ReverbT60, SlotParam.ReverbDamping, SlotParam.ReverbPredelayMs],
  [EffectType.Additive]: [
    SlotParam.AddAttackMs,
    SlotParam.AddReleaseMs,
    SlotParam.AddPartials,
    SlotParam.AddSpacing,
    SlotParam.AddOddEven,
    SlotParam.AddGlideMs,
  ],
}

// ── HRIR sets ──────────────────────────────────────────────────────────────

/**
 * The HRIR sets the app ships — the single truth the enum options, the value
 * formatting and the host's fetch table all derive from.
 */
export const HRIR_SETS = [
  { label: 'KU100 · Köln L2702', file: 'ku100-koeln.bin' },
  { label: 'FABIAN · HATO 0°', file: 'fabian-hato0.bin' },
] as const

// ── spec plumbing ──────────────────────────────────────────────────────────

export type ParamKind = 'continuous' | 'toggle' | 'enum'

export interface ParamSpec {
  /** Full engine id (globals verbatim; slot params via slotParamId). */
  id: number
  /** Stable machine name; DOM ids are `param-<key>`. */
  key: string
  label: string
  kind: ParamKind
  min: number
  max: number
  default: number
  step: number
  unit: string
  /** Engine-side smoothing; grain-style spawn params are 0. */
  smoothingMs: number
  /** Labels for `enum` kind; the value is the index. */
  options?: readonly string[]
  /** Visual weight of a toggle's ON state: does ON mean go, or beware. */
  toggleTone?: 'positive' | 'alarm'
  format: (value: number) => string
  hint?: string
}

const db = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`)
const deg = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)}°`
const pct = (value: number) => `${Math.round(value * 100)}%`
const enumFormat = (options: readonly string[]) => (value: number) => options[Math.round(value)] ?? '?'

const ENV_SHAPES = ['Hann', 'Tukey', 'Gaussian', 'Triangle']
const SCHEDULERS = ['Metronomic', 'Poisson']
const HRIR_LABELS = HRIR_SETS.map((s) => s.label)

// ── global specs ───────────────────────────────────────────────────────────

export const GLOBAL_PARAMS: readonly ParamSpec[] = [
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
    toggleTone: 'alarm',
  },
  {
    id: ParamId.HrirSet,
    key: 'hrirSet',
    label: 'HRTF set',
    kind: 'enum',
    min: 0,
    max: HRIR_SETS.length - 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    options: HRIR_LABELS,
    format: enumFormat(HRIR_LABELS),
    hint: 'Which measured head renders the field. FABIAN is a 12 MB download.',
  },
  {
    id: ParamId.DryMonitor,
    key: 'dryMonitor',
    label: 'Dry monitor',
    kind: 'toggle',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    format: (v) => (v >= 0.5 ? 'dry mic' : 'pipelines'),
    toggleTone: 'alarm',
    hint: 'Hears the untouched microphone instead of the pipelines — the A/B reference.',
  },
  {
    id: ParamId.CaptureWeighting,
    key: 'captureWeighting',
    label: 'Capture weighting',
    kind: 'toggle',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    format: (v) => (v >= 0.5 ? 'A-weighted' : 'flat'),
    toggleTone: 'positive',
    hint:
      'IEC A-weighting on the microphone before every pipeline and meter — ' +
      'tames traffic rumble and wind the way the ear’s own contour does.',
  },
]

// ── slot spec factory ──────────────────────────────────────────────────────

/** Spec templates for slot locals; `makeSlotParams` stamps slot ids on them. */
const SLOT_LOCAL_SPECS: ReadonlyArray<Omit<ParamSpec, 'id' | 'key'> & { local: number; keyBase: string }> = [
  {
    local: SlotParam.Effect,
    keyBase: 'effect',
    label: 'Effect',
    kind: 'enum',
    min: 0,
    max: EFFECTS.length - 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    options: EFFECTS,
    format: enumFormat(EFFECTS),
  },
  {
    local: SlotParam.AzimuthDeg,
    keyBase: 'azimuthDeg',
    label: 'Azimuth',
    kind: 'continuous',
    min: -180,
    max: 180,
    default: 0,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: deg,
    hint: '0° ahead, positive to the left.',
  },
  {
    local: SlotParam.AzimuthDevDeg,
    keyBase: 'azimuthDevDeg',
    label: 'Azimuth spread',
    kind: 'continuous',
    min: 0,
    max: 180,
    default: 40,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: (v) => `±${Math.round(v)}°`,
  },
  {
    local: SlotParam.ElevationDeg,
    keyBase: 'elevationDeg',
    label: 'Elevation',
    kind: 'continuous',
    min: -90,
    max: 90,
    default: 0,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: deg,
  },
  {
    local: SlotParam.ElevationDevDeg,
    keyBase: 'elevationDevDeg',
    label: 'Elevation spread',
    kind: 'continuous',
    min: 0,
    max: 90,
    default: 15,
    step: 1,
    unit: '°',
    smoothingMs: 0,
    format: (v) => `±${Math.round(v)}°`,
  },
  {
    local: SlotParam.WetDb,
    keyBase: 'wetDb',
    label: 'Level',
    kind: 'continuous',
    min: -60,
    max: 12,
    default: 0,
    step: 0.5,
    unit: 'dB',
    smoothingMs: 20,
    format: db,
    hint: 'This pipeline’s level in the mix.',
  },

  // granular
  {
    local: SlotParam.BufferSec,
    keyBase: 'bufferSec',
    label: 'Buffer size',
    kind: 'continuous',
    min: 0.5,
    max: 20,
    default: 8,
    step: 0.5,
    unit: 's',
    smoothingMs: 0,
    format: (v) => `${v.toFixed(1)} s`,
    hint: 'How much of the past the ring keeps for grains to read.',
  },
  {
    local: SlotParam.DelayMs,
    keyBase: 'delayMs',
    label: 'Read delay',
    kind: 'continuous',
    min: 0,
    max: 8000,
    default: 250,
    step: 10,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
    hint: 'How far behind realtime the grains read.',
  },
  {
    local: SlotParam.DelayDevMs,
    keyBase: 'delayDevMs',
    label: 'Delay scatter',
    kind: 'continuous',
    min: 0,
    max: 4000,
    default: 120,
    step: 10,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },
  {
    local: SlotParam.Density,
    keyBase: 'density',
    label: 'Density',
    kind: 'continuous',
    min: 0.5,
    max: 150,
    default: 25,
    step: 0.5,
    unit: '/s',
    smoothingMs: 0,
    format: (v) => `${v.toFixed(1)} /s`,
  },
  {
    local: SlotParam.LengthMs,
    keyBase: 'lengthMs',
    label: 'Grain length',
    kind: 'continuous',
    min: 5,
    max: 500,
    default: 90,
    step: 5,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },
  {
    local: SlotParam.LengthJitter,
    keyBase: 'lengthJitter',
    label: 'Length jitter',
    kind: 'continuous',
    min: 0,
    max: 1,
    default: 0.35,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
  },
  {
    local: SlotParam.PitchSemis,
    keyBase: 'pitchSemis',
    label: 'Pitch',
    kind: 'continuous',
    min: -24,
    max: 24,
    default: 0,
    step: 1,
    unit: 'st',
    smoothingMs: 0,
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} st`,
  },
  {
    local: SlotParam.PitchDevSemis,
    keyBase: 'pitchDevSemis',
    label: 'Pitch scatter',
    kind: 'continuous',
    min: 0,
    max: 24,
    default: 0,
    step: 0.5,
    unit: 'st',
    smoothingMs: 0,
    format: (v) => `±${v.toFixed(1)} st`,
  },
  {
    local: SlotParam.ReverseProb,
    keyBase: 'reverseProb',
    label: 'Reverse grains',
    kind: 'continuous',
    min: 0,
    max: 1,
    default: 0,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
  },
  {
    local: SlotParam.EnvShape,
    keyBase: 'envShape',
    label: 'Grain window',
    kind: 'enum',
    min: 0,
    max: 3,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    options: ENV_SHAPES,
    format: enumFormat(ENV_SHAPES),
  },
  {
    local: SlotParam.Scheduler,
    keyBase: 'scheduler',
    label: 'Onset timing',
    kind: 'enum',
    min: 0,
    max: 1,
    default: 0,
    step: 1,
    unit: '',
    smoothingMs: 0,
    options: SCHEDULERS,
    format: enumFormat(SCHEDULERS),
  },

  // echo
  {
    local: SlotParam.EchoTimeMs,
    keyBase: 'echoTimeMs',
    label: 'Echo time',
    kind: 'continuous',
    min: 60,
    max: 2000,
    default: 420,
    step: 10,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
    hint: 'Spacing between repeats; each repeat lands at its own drawn direction.',
  },
  {
    local: SlotParam.EchoFeedback,
    keyBase: 'echoFeedback',
    label: 'Feedback',
    kind: 'continuous',
    min: 0,
    max: 0.95,
    default: 0.5,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
  },
  {
    local: SlotParam.EchoDamping,
    keyBase: 'echoDamping',
    label: 'Damping',
    kind: 'continuous',
    min: 0,
    max: 1,
    default: 0.35,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
    hint: 'Later repeats lose highs, like a room.',
  },

  // reverb
  {
    local: SlotParam.ReverbT60,
    keyBase: 'reverbT60',
    label: 'Decay (T60)',
    kind: 'continuous',
    min: 0.3,
    max: 12,
    default: 2.6,
    step: 0.1,
    unit: 's',
    smoothingMs: 0,
    format: (v) => `${v.toFixed(1)} s`,
  },
  {
    local: SlotParam.ReverbDamping,
    keyBase: 'reverbDamping',
    label: 'HF damping',
    kind: 'continuous',
    min: 0,
    max: 1,
    default: 0.3,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: pct,
  },
  {
    local: SlotParam.ReverbPredelayMs,
    keyBase: 'reverbPredelayMs',
    label: 'Predelay',
    kind: 'continuous',
    min: 0,
    max: 250,
    default: 24,
    step: 2,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },

  // additive
  {
    local: SlotParam.AddAttackMs,
    keyBase: 'addAttackMs',
    label: 'Attack',
    kind: 'continuous',
    min: 5,
    max: 4000,
    default: 350,
    step: 5,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },
  {
    local: SlotParam.AddReleaseMs,
    keyBase: 'addReleaseMs',
    label: 'Release',
    kind: 'continuous',
    min: 20,
    max: 8000,
    default: 1200,
    step: 20,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },
  {
    local: SlotParam.AddPartials,
    keyBase: 'addPartials',
    label: 'Partials',
    kind: 'continuous',
    min: 1,
    max: 16,
    default: 8,
    step: 1,
    unit: '',
    smoothingMs: 0,
    format: (v) => `${Math.round(v)}`,
    hint: 'How many harmonics the pad stacks on the detected pitch.',
  },
  {
    local: SlotParam.AddSpacing,
    keyBase: 'addSpacing',
    label: 'Spacing',
    kind: 'continuous',
    min: 0.25,
    max: 2.5,
    default: 1,
    step: 0.05,
    unit: '×',
    smoothingMs: 0,
    format: (v) => `${v.toFixed(2)}×`,
    hint: '1.0 is the harmonic series; below compresses, above stretches.',
  },
  {
    local: SlotParam.AddOddEven,
    keyBase: 'addOddEven',
    label: 'Odd / even',
    kind: 'continuous',
    min: 0,
    max: 1,
    default: 0.5,
    step: 0.05,
    unit: '',
    smoothingMs: 0,
    format: (v) => (v < 0.45 ? `even ${pct(1 - v)}` : v > 0.55 ? `odd ${pct(v)}` : 'balanced'),
    hint: '0.5 keeps all partials; the ends favor odd or even ones.',
  },
  {
    local: SlotParam.AddGlideMs,
    keyBase: 'addGlideMs',
    label: 'Pitch glide',
    kind: 'continuous',
    min: 0,
    max: 2000,
    default: 120,
    step: 10,
    unit: 'ms',
    smoothingMs: 0,
    format: ms,
  },
]

/** All specs for one slot, ids stamped. Keys read `s0-density` etc. */
export function makeSlotParams(slot: number): ParamSpec[] {
  return SLOT_LOCAL_SPECS.map(({ local, keyBase, ...rest }) => ({
    ...rest,
    id: slotParamId(slot, local),
    key: `s${slot}-${keyBase}`,
  }))
}

/** Every spec the app has: globals plus all slots. */
export const PARAMS: readonly ParamSpec[] = [
  ...GLOBAL_PARAMS,
  ...Array.from({ length: SLOT_COUNT }, (_, s) => makeSlotParams(s)).flat(),
]

export const PARAM_BY_ID: ReadonlyMap<number, ParamSpec> = new Map(PARAMS.map((p) => [p.id, p]))

export function defaultParamValues(): Map<number, number> {
  const values = new Map(PARAMS.map((p) => [p.id, p.default]))
  // Slot 0 wakes up as the granular delay — the piece as it has been so far.
  values.set(slotParamId(0, SlotParam.Effect), EffectType.Granular)
  // Parked slots point elsewhere so enabling them is immediately audible as
  // a second place, not a doubling of the first.
  values.set(slotParamId(1, SlotParam.AzimuthDeg), 70)
  values.set(slotParamId(2, SlotParam.AzimuthDeg), -70)
  return values
}
