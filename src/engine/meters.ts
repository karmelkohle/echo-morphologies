/**
 * Metering block layout.
 *
 * The engine writes into a flat `Float32Array` rather than returning an object
 * so the same call works against a wasm heap view later — `engine_read_meters`
 * fills N floats and the host reads them with zero marshalling.
 *
 * Levels are linear magnitudes (0…1+), not decibels; the UI converts.
 */
export const MeterSlot = {
  InputPeak: 0,
  InputRms: 1,
  OutputLeftPeak: 2,
  OutputLeftRms: 3,
  OutputRightPeak: 4,
  OutputRightRms: 5,
  /** Worst limiter gain reduction since the last read, in positive dB. */
  LimiterReductionDb: 6,
  /** Capture samples at or above 0 dBFS since the last read. */
  InputClipCount: 7,
  /** Grains sounding right now. */
  ActiveGrains: 8,
} as const

export const METER_SLOT_COUNT = 9
