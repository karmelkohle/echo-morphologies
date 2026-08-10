/**
 * End-to-end check: does the whole chain actually run and pass audio?
 *
 *     npm run smoke
 *
 * Builds are assumed done (the npm script handles it). This starts a preview
 * server, drives the app in Chromium against a synthetic capture device, and
 * asserts on what the interface reports.
 *
 * The assertions are deliberately about the DSP, not just about the plumbing:
 * the output has to track the input at exactly the output gain's offset, both
 * channels have to agree, and mute has to reach real silence. A build where the
 * graph runs but the engine is wrong passes a "did it load" test and fails this
 * one — which is the failure mode worth catching once there is real DSP in
 * `src/engine/`.
 *
 * Chromium comes from Playwright's own download (`npx playwright install
 * chromium`). Set CHROMIUM_PATH to use a browser that is already on the machine.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT ?? 4173)
const BASE = process.env.APP_URL ?? `http://localhost:${PORT}/`
/** Output gain's default, in dB. The output must sit this far under the input. */
const EXPECTED_DROP_DB = 12
const SAMPLE_MS = 6000
/** Long enough for the peak-hold to finish falling after mute. */
const MUTE_SETTLE_MS = 5000

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

// ── preview server ──────────────────────────────────────────────────────────

let server = null
if (!process.env.APP_URL) {
  // The binary directly rather than through `npx`: killing npx leaves the vite
  // process it spawned holding the port, and the next run fails to start.
  const vite = fileURLToPath(
    new URL(
      `../node_modules/.bin/vite${process.platform === 'win32' ? '.cmd' : ''}`,
      import.meta.url,
    ),
  )
  server = spawn(vite, ['preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
  })
  // Also on the way out of a failed assertion or a thrown page action: a
  // surviving preview server holds the port and the next run fails to start
  // for a reason that has nothing to do with the code.
  process.on('exit', () => server?.kill())
  await waitForServer(BASE, 15000)
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`preview server did not answer at ${url} — did \`npm run build\` succeed?`)
}

// ── browser ─────────────────────────────────────────────────────────────────

let browser
try {
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      // Grant the microphone without a prompt and feed it Chrome's synthetic
      // beeping tone, so the run needs no hardware and no human.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  })
} catch (error) {
  server?.kill()
  console.error(String(error))
  console.error('\nInstall the browser with:  npx playwright install chromium')
  console.error('Or point CHROMIUM_PATH at an existing Chromium binary.')
  process.exit(1)
}

const context = await browser.newContext({ permissions: ['microphone'] })
const page = await context.newPage()

const consoleErrors = []
const pageErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

const snapshot = () =>
  page.evaluate(() => {
    const rows = {}
    const children = [...document.getElementById('status').children]
    for (let i = 0; i < children.length - 1; i += 2) {
      rows[children[i].textContent] = children[i + 1].textContent
    }
    const notice = document.getElementById('notice')
    return {
      state: document.getElementById('state-label').textContent,
      notice: notice.hidden ? null : notice.textContent,
      meters: Object.fromEntries(
        [...document.querySelectorAll('.meter-row')].map((row) => [
          row.querySelector('.meter-name').textContent,
          row.querySelector('.meter-value').textContent,
        ]),
      ),
      rows,
    }
  })

/** The readout uses a typographic minus and shows −∞ at the floor. */
const dbOf = (text) => (text === '−∞' ? -Infinity : Number(text))

const sampleWindow = async (label, durationMs) => {
  const peaks = { input: -Infinity, 'out L': -Infinity, 'out R': -Infinity }
  let last = null
  let maxGrains = 0
  for (const deadline = Date.now() + durationMs; Date.now() < deadline; ) {
    last = await snapshot()
    for (const [name, text] of Object.entries(last.meters)) {
      peaks[name] = Math.max(peaks[name], dbOf(text))
    }
    maxGrains = Math.max(maxGrains, Number(last.rows['grains sounding'] ?? 0) || 0)
    await page.waitForTimeout(60)
  }
  console.log(`\n--- ${label} ---`)
  console.log('peaks:', peaks, '| max grains sounding:', maxGrains)
  return { peaks, last, maxGrains }
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.click('#transport')

// ── Phase 1: granular active (the default) ─────────────────────────────────
// The grain cloud reads the past through jittered taps, so exact levels are
// not predictable — what must hold is that the chain is audibly alive, grains
// are actually sounding, and the graph keeps realtime.
const granular = await sampleWindow('granular active', SAMPLE_MS)
check(granular.last.state === 'running', `state was "${granular.last.state}", expected "running"`)
check(!granular.last.notice, `notice shown: ${granular.last.notice}`)
check(granular.peaks.input > -40, `input meter never moved (max ${granular.peaks.input} dB)`)
check(granular.peaks['out L'] > -40, `granular out L never moved (max ${granular.peaks['out L']} dB)`)
check(granular.peaks['out R'] > -40, `granular out R never moved (max ${granular.peaks['out R']} dB)`)
check(granular.maxGrains > 0, 'no grains ever sounded while granular was on')
check(granular.maxGrains <= 64, `grain count ${granular.maxGrains} exceeds the pool`)

const granularRate = Number((granular.last.rows['render rate'] ?? '').replace(/[^0-9.]/g, ''))
check(granularRate >= 95, `render rate with granular on: ${granular.last.rows['render rate']}`)
check(granular.last.rows['clock gaps'] === '0', `clock gaps ${granular.last.rows['clock gaps']}`)
check(
  granular.last.rows['render quantum'] === '128 frames',
  `render quantum ${granular.last.rows['render quantum']}`,
)
check(
  granular.last.rows['capture processing'] === 'none (raw)',
  `capture processing ${granular.last.rows['capture processing']}`,
)

// ── Phase 2: granular bypassed — the exact reference path ──────────────────
// Bypass must restore the provable pass-through: output tracks input at
// exactly the output gain's offset, and both ears agree. The meter readouts
// are decaying peak holds, so phase 1's louder, lateralized residue has to
// fall away first (1.2 s hold + ~2 s fall) or this window maxes over it.
await page.click('#param-granular')
await page.waitForTimeout(4200)
const bypass = await sampleWindow('granular bypassed', SAMPLE_MS)
check(bypass.peaks['out L'] > -40, `bypass out L never moved (max ${bypass.peaks['out L']} dB)`)

const drop = bypass.peaks.input - bypass.peaks['out L']
check(
  Math.abs(drop - EXPECTED_DROP_DB) < 3,
  `bypass input→output drop was ${drop.toFixed(1)} dB, expected ~${EXPECTED_DROP_DB}`,
)
check(
  Math.abs(bypass.peaks['out L'] - bypass.peaks['out R']) < 0.2,
  `bypass channels disagree: L ${bypass.peaks['out L']} vs R ${bypass.peaks['out R']}`,
)
check(bypass.last.rows['grains sounding'] === '0', 'grains still sounding while bypassed')

// Mute must reach silence while the input keeps reading. The readout is a
// decaying peak hold, so wait out the ballistics and check where it settled.
await page.click('#param-mute')
let mutedInputPeak = -Infinity
for (const deadline = Date.now() + MUTE_SETTLE_MS; Date.now() < deadline; ) {
  const s = await snapshot()
  mutedInputPeak = Math.max(mutedInputPeak, dbOf(s.meters.input))
  await page.waitForTimeout(60)
}
const muted = await snapshot()
console.log('muted: input peaked at', mutedInputPeak, '· out L settled at', muted.meters['out L'])

check(mutedInputPeak > -40, `input died while muted (max ${mutedInputPeak} dB)`)
check(
  muted.meters['out L'] === '−∞',
  `output did not fall silent while muted (settled at ${muted.meters['out L']})`,
)
await page.click('#param-mute')

// ── Phase 3: lateralization — the HRIR path, end to end ────────────────────
// Every grain aimed hard left (azimuth +90°, zero spread): if the loader, the
// nearest-position index, the per-lane convolution and the coordinate
// handedness all work, the LEFT ear must come out louder — signed, not just
// different. A duller assertion would pass with the ears swapped.
await page.evaluate(() => {
  const drive = (key, value) => {
    const el = document.getElementById(`param-${key}`)
    el.value = String(value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  drive('azimuthDeg', 90)
  drive('azimuthDevDeg', 0)
  drive('elevationDeg', 0)
  drive('elevationDevDeg', 0)
})
await page.click('#param-granular') // re-enable after the bypass phase

// The set loads async at start; normally long done by now, but don't race it.
for (const deadline = Date.now() + 10000; Date.now() < deadline; ) {
  const s = await snapshot()
  const row = s.rows['hrtf set'] ?? ''
  if (row.includes('pos ×')) break
  if (row.includes('failed')) break
  await page.waitForTimeout(120)
}
const hrtfRow = (await snapshot()).rows['hrtf set'] ?? ''
console.log('\nhrtf set:', hrtfRow)
// Tap count varies with the context rate (the set resamples to match — this
// headless context runs at 44.1 kHz), so assert the set and position count.
check(/2,702 pos × \d+ taps/.test(hrtfRow), `hrtf row: "${hrtfRow}"`)

const lateral = await sampleWindow('grains hard left (az +90°)', SAMPLE_MS)
check(lateral.maxGrains > 0, 'no grains sounded in the lateralization phase')
check(lateral.peaks['out L'] > -40, `left ear silent at az +90 (${lateral.peaks['out L']} dB)`)
const ild = lateral.peaks['out L'] - lateral.peaks['out R']
check(
  ild >= 1.5,
  `azimuth +90° should favor the LEFT ear by ≥1.5 dB, measured L−R = ${ild.toFixed(1)} dB`,
)
const lateralRate = Number((lateral.last.rows['render rate'] ?? '').replace(/[^0-9.]/g, ''))
check(lateralRate >= 95, `render rate with HRIR convolution: ${lateral.last.rows['render rate']}`)
check(lateral.last.rows['clock gaps'] === '0', `clock gaps ${lateral.last.rows['clock gaps']}`)

await page.click('#transport')
await page.waitForTimeout(600)
const stopped = await snapshot()
check(stopped.state === 'idle', `state after stop was "${stopped.state}"`)

check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
check(consoleErrors.length === 0, `console errors: ${consoleErrors.join('; ')}`)

await browser.close()
server?.kill()

console.log(failures.length === 0 ? '\nPASS' : `\nFAIL (${failures.length})`)
for (const failure of failures) console.log(' •', failure)
process.exit(failures.length === 0 ? 0 : 1)
