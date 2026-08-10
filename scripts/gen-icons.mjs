/**
 * Generates the app icons.
 *
 * The PNGs are committed, so this only needs running when the mark changes —
 * it exists so the icons stay editable as code rather than as binaries nobody
 * can regenerate. Encoder is hand-rolled on `node:zlib` to keep the project's
 * dependency list at "vite and typescript".
 *
 *     node scripts/gen-icons.mjs
 *
 * The mark is a grain cloud: points on a Fibonacci spiral, larger and brighter
 * towards the centre, which is roughly what the granulator's directional field
 * looks like when you plot it.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const BACKGROUND = [0x0b, 0x0e, 0x13]
const NEAR = [0x7f, 0xe6, 0xd6] // centre of the cloud
const FAR = [0x1b, 0x6f, 0x66] // outer edge
const RING = [0x2a, 0x3a, 0x48]

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const GRAIN_COUNT = 96

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const head = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head, data])), 0)
  return Buffer.concat([length, head, data, crc])
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── the mark ────────────────────────────────────────────────────────────────

/**
 * @param size    Square edge in pixels.
 * @param extent  Cloud radius as a fraction of the edge. Keep at or below 0.30
 *                for maskable icons so nothing lands in the region a launcher
 *                may crop away.
 */
function renderIcon(size, extent) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = BACKGROUND[0]
    pixels[i * 4 + 1] = BACKGROUND[1]
    pixels[i * 4 + 2] = BACKGROUND[2]
    pixels[i * 4 + 3] = 0xff
  }

  const centre = size / 2
  const radius = size * extent

  const blend = (x, y, colour, alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= size || y >= size) return
    const a = Math.min(1, alpha)
    const i = (y * size + x) * 4
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * (1 - a) + colour[c] * a)
  }

  // Framing ring, one pixel-ish wide with soft edges.
  const ringRadius = radius * 1.26
  const ringWidth = Math.max(1, size * 0.008)
  const outer = Math.ceil(ringRadius + ringWidth + 2)
  for (let y = Math.max(0, Math.floor(centre - outer)); y < Math.min(size, centre + outer); y++) {
    for (let x = Math.max(0, Math.floor(centre - outer)); x < Math.min(size, centre + outer); x++) {
      const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre)
      const edge = Math.abs(distance - ringRadius)
      blend(x, y, RING, 1 - edge / ringWidth)
    }
  }

  // Grain cloud.
  for (let i = 0; i < GRAIN_COUNT; i++) {
    const t = (i + 0.5) / GRAIN_COUNT
    const r = radius * Math.sqrt(t)
    const theta = i * GOLDEN_ANGLE
    const gx = centre + r * Math.cos(theta)
    const gy = centre + r * Math.sin(theta)

    const dotRadius = size * 0.02 * (1.45 - 0.75 * t)
    const colour = [0, 1, 2].map((c) => NEAR[c] + (FAR[c] - NEAR[c]) * t)
    const opacity = 1 - 0.35 * t

    const span = Math.ceil(dotRadius + 1.5)
    for (let y = Math.floor(gy - span); y <= gy + span; y++) {
      for (let x = Math.floor(gx - span); x <= gx + span; x++) {
        const distance = Math.hypot(x + 0.5 - gx, y + 0.5 - gy)
        // One-pixel linear ramp at the edge as cheap antialiasing.
        blend(x, y, colour, Math.min(1, dotRadius - distance + 0.5) * opacity)
      }
    }
  }

  return encodePng(size, size, pixels)
}

// ── output ──────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true })

const targets = [
  ['icon-192.png', 192, 0.34],
  ['icon-512.png', 512, 0.34],
  ['icon-maskable-512.png', 512, 0.28],
  ['apple-touch-icon.png', 180, 0.34],
]

for (const [name, size, extent] of targets) {
  const file = join(OUT_DIR, name)
  writeFileSync(file, renderIcon(size, extent))
  console.log(`wrote ${name} (${size}×${size})`)
}
