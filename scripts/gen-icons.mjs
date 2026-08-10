/**
 * Generates the app icons from the project logo (resources/logo/*.svg).
 *
 * The PNGs are committed, so this only needs running when the logo changes:
 *
 *     npm run icons
 *
 * Rasterization happens in the Playwright Chromium this repo already uses for
 * its smoke test — no image library dependency. Two variants are produced:
 *
 * - Rounded (the SVG as drawn) on transparency, for the browser-tab and
 *   manifest icons, where the logo's own corner radius should show.
 * - Full-bleed (corner radius stripped) for the apple-touch icon and the
 *   maskable icon, because iOS and Android launchers apply their own masks —
 *   pre-rounded corners would show as dead notches under theirs.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOGO = join(ROOT, 'resources', 'logo', 'echo-morph-logo.svg')
const OUT_DIR = join(ROOT, 'public', 'icons')

const svg = readFileSync(LOGO, 'utf8')
// Full-bleed variant: neutralize the decorative rounded-rect clip.
const fullBleed = svg.replace(/rx="\d+" ry="\d+"/, 'rx="0" ry="0"')

const TARGETS = [
  { name: 'icon-192.png', size: 192, source: svg, transparent: true },
  { name: 'icon-512.png', size: 512, source: svg, transparent: true },
  { name: 'apple-touch-icon.png', size: 180, source: fullBleed, transparent: false },
  { name: 'icon-maskable-512.png', size: 512, source: fullBleed, transparent: false },
]

mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)

for (const target of TARGETS) {
  const page = await browser.newPage({
    viewport: { width: target.size, height: target.size },
    deviceScaleFactor: 1,
  })
  await page.setContent(
    `<!doctype html><style>
       html, body { margin: 0; ${target.transparent ? '' : 'background: #0b0e13;'} }
       svg { display: block; width: ${target.size}px; height: ${target.size}px; }
     </style>${target.source}`,
    { waitUntil: 'networkidle' },
  )
  await page.screenshot({
    path: join(OUT_DIR, target.name),
    omitBackground: target.transparent,
  })
  await page.close()
  console.log(`wrote ${target.name} (${target.size}×${target.size})`)
}

await browser.close()
