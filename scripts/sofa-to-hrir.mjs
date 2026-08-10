/**
 * Converts the SOFA HRIR sets in resources/hrtfs/ into the compact binary the
 * app loads at runtime (public/hrtf/*.bin).
 *
 *     npm run hrtf
 *
 * Why not parse SOFA in the app: SOFA is an HDF5 container, and dragging a
 * WASM HDF5 reader into the page costs more than the data it would read. The
 * app's format is a flat header + positions + int16 samples, readable with a
 * DataView in a dozen lines, and the int16 quantization is ~96 dB of range —
 * measurement noise in any HRIR set is far above that floor.
 *
 * The output is committed, so this only needs running when the source sets
 * change. Requires the real files (`git lfs pull`), not the pointers.
 *
 * Binary layout (little-endian):
 *   0   u32   magic 'HRIR' (0x52495248)
 *   4   u32   format version (1)
 *   8   f32   sample rate the IRs were measured at
 *   12  u32   position count M
 *   16  u32   taps per ear N
 *   20  f32   scale: int16 value × scale/32767 = float sample
 *   24  f32×2M  positions, (azimuthDeg, elevationDeg) pairs —
 *               azimuth converted to [-180,180], 0 = front, CCW positive
 *   …   i16×(M·2·N) IRs, per position: left ear N taps, then right ear N taps
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h5wasm from 'h5wasm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'hrtf')

const SETS = [
  { source: 'HRIR_L2702_koln.sofa', out: 'ku100-koeln.bin', label: 'KU100 Köln L2702' },
  { source: 'FABIAN_HRIR_measured_HATO_0.sofa', out: 'fabian-hato0.bin', label: 'FABIAN measured HATO 0°' },
]

await h5wasm.ready

mkdirSync(OUT_DIR, { recursive: true })

for (const set of SETS) {
  const sofaPath = join(ROOT, 'resources', 'hrtfs', set.source)
  const bytes = readFileSync(sofaPath)
  if (bytes.length < 1024) {
    throw new Error(`${set.source} looks like an LFS pointer — run 'git lfs pull' first`)
  }

  h5wasm.FS.writeFile('/work.sofa', new Uint8Array(bytes))
  const file = new h5wasm.File('/work.sofa', 'r')

  const conventions = file.attrs['SOFAConventions']?.value
  if (conventions !== 'SimpleFreeFieldHRIR') {
    throw new Error(`${set.source}: expected SimpleFreeFieldHRIR, found ${conventions}`)
  }

  const ir = file.get('Data.IR')
  const pos = file.get('SourcePosition')
  const [m, ears, taps] = ir.shape
  if (ears !== 2) throw new Error(`${set.source}: expected 2 receivers, found ${ears}`)
  const sampleRate = Number(file.get('Data.SamplingRate').value[0])

  // The app assumes receiver 0 is the LEFT ear and SourcePosition is
  // spherical degrees. Both hold for the shipped sets, but the convention
  // only *recommends* them — a set violating either would convert without
  // complaint into mirrored or garbage spatialization, so refuse instead.
  const posType = pos.attrs['Type']?.value
  if (posType !== 'spherical') {
    throw new Error(`${set.source}: SourcePosition is '${posType}', expected spherical`)
  }
  // ReceiverPosition is [2 receivers × (x,y,z) × 1]; +y is the listener's left.
  const receiverY = Number(file.get('ReceiverPosition').value[1])
  if (!(receiverY > 0)) {
    throw new Error(
      `${set.source}: receiver 0 sits at y=${receiverY}, expected the left ear (+y) first`,
    )
  }

  // Everything at once: Köln is 2.7k×2×128, FABIAN 12k×2×256 — both fit fine.
  const irData = ir.value // Float64Array, [m][ear][tap] flattened
  const posData = pos.value // Float64Array, [m][3] flattened (az, el, dist)

  let peak = 0
  for (let i = 0; i < irData.length; i++) {
    const a = Math.abs(irData[i])
    if (a > peak) peak = a
  }
  if (!(peak > 0)) throw new Error(`${set.source}: silent IR data`)

  const headerBytes = 24
  const out = new ArrayBuffer(headerBytes + m * 2 * 4 + m * 2 * taps * 2)
  const view = new DataView(out)
  view.setUint32(0, 0x52495248, true) // 'HRIR' little-endian
  view.setUint32(4, 1, true)
  view.setFloat32(8, sampleRate, true)
  view.setUint32(12, m, true)
  view.setUint32(16, taps, true)
  view.setFloat32(20, peak, true)

  let azMin = Infinity
  let azMax = -Infinity
  let elMin = Infinity
  let elMax = -Infinity
  for (let i = 0; i < m; i++) {
    // SOFA spherical: azimuth 0..360°, 0 = front, counter-clockwise positive;
    // the app speaks [-180, +180] with the same zero and the same handedness.
    const azSofa = posData[i * 3]
    const az = ((azSofa + 180) % 360) - 180
    const el = posData[i * 3 + 1]
    view.setFloat32(headerBytes + i * 8, az, true)
    view.setFloat32(headerBytes + i * 8 + 4, el, true)
    azMin = Math.min(azMin, az)
    azMax = Math.max(azMax, az)
    elMin = Math.min(elMin, el)
    elMax = Math.max(elMax, el)
  }

  const irBase = headerBytes + m * 8
  const quantScale = 32767 / peak
  for (let i = 0; i < irData.length; i++) {
    view.setInt16(irBase + i * 2, Math.round(irData[i] * quantScale), true)
  }

  writeFileSync(join(OUT_DIR, set.out), Buffer.from(out))
  const mb = (out.byteLength / 1024 / 1024).toFixed(2)
  console.log(
    `${set.out}: ${m} positions × 2 ears × ${taps} taps @ ${sampleRate} Hz, ` +
      `az [${azMin.toFixed(0)}°, ${azMax.toFixed(0)}°], el [${elMin.toFixed(0)}°, ${elMax.toFixed(0)}°], ` +
      `peak ${peak.toFixed(3)}, ${mb} MB  (${set.label})`,
  )

  file.close()
  h5wasm.FS.unlink('/work.sofa')
}
