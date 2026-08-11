/**
 * End-to-end check: does the whole chain actually run and pass audio?
 *
 *     npm run smoke
 *
 * Drives the real app in headless Chromium against a synthetic capture
 * device and asserts on what the interface reports. The assertions are about
 * the DSP, not the page loading: the dry monitor must measure exactly the
 * output gain's offset on both ears, lateralized grains must favor the
 * correct ear, every effect must hold realtime, and two pipelines in
 * parallel must too.
 *
 * Chromium comes from Playwright's own download (`npx playwright install
 * chromium`); set CHROMIUM_PATH to use one already on the machine.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT ?? 4173)
const BASE = process.env.APP_URL ?? `http://localhost:${PORT}/`
/** Output gain's default, in dB. The dry monitor must sit this far under input. */
const EXPECTED_DROP_DB = 12
const SAMPLE_MS = 5000
/** Long enough for the peak-hold ballistics to fall away between phases. */
const SETTLE_MS = 4200

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

// ── preview server ──────────────────────────────────────────────────────────

let server = null
if (!process.env.APP_URL) {
  const vite = fileURLToPath(
    new URL(`../node_modules/.bin/vite${process.platform === 'win32' ? '.cmd' : ''}`, import.meta.url),
  )
  server = spawn(vite, ['preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
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
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
} catch (error) {
  server?.kill()
  console.error(String(error))
  console.error('\nInstall the browser with:  npx playwright install chromium')
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

/** Set a control by DOM id, firing the event its builder listens for. */
const drive = (key, value) =>
  page.evaluate(
    ([k, v]) => {
      const el = document.getElementById(`param-${k}`)
      if (!el) throw new Error(`no control param-${k}`)
      el.value = String(v)
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    },
    [key, value],
  )

/** The readout uses a typographic minus and shows −∞ at the floor. */
const dbOf = (text) => (text === '−∞' ? -Infinity : Number(text))

const sampleWindow = async (label, durationMs) => {
  const peaks = { input: -Infinity, 'out L': -Infinity, 'out R': -Infinity }
  let last = null
  let maxVoices = 0
  for (const deadline = Date.now() + durationMs; Date.now() < deadline; ) {
    last = await snapshot()
    for (const [name, text] of Object.entries(last.meters)) {
      peaks[name] = Math.max(peaks[name], dbOf(text))
    }
    maxVoices = Math.max(maxVoices, Number(last.rows['voices sounding'] ?? 0) || 0)
    await page.waitForTimeout(60)
  }
  console.log(`\n--- ${label} ---`)
  console.log('peaks:', peaks, '| max voices:', maxVoices)
  return { peaks, last, maxVoices }
}

const realtime = (phase, last) => {
  const rate = Number((last.rows['render rate'] ?? '').replace(/[^0-9.]/g, ''))
  check(rate >= 95, `${phase}: render rate ${last.rows['render rate']}`)
  check(last.rows['clock gaps'] === '0', `${phase}: clock gaps ${last.rows['clock gaps']}`)
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.click('#transport')

// ── Phase 1: default pipeline — granular on slot A ─────────────────────────
const granular = await sampleWindow('granular (slot A default)', SAMPLE_MS)
check(granular.last.state === 'running', `state was "${granular.last.state}"`)
check(!granular.last.notice, `notice shown: ${granular.last.notice}`)
check(granular.peaks.input > -40, `input never moved (${granular.peaks.input} dB)`)
check(granular.peaks['out L'] > -40, `granular out L never moved (${granular.peaks['out L']} dB)`)
check(granular.peaks['out R'] > -40, `granular out R never moved (${granular.peaks['out R']} dB)`)
check(granular.maxVoices > 0, 'no voices while granular ran')
realtime('granular', granular.last)
check(
  granular.last.rows['render quantum'] === '128 frames',
  `render quantum ${granular.last.rows['render quantum']}`,
)
check(
  granular.last.rows['capture processing'] === 'none (raw)',
  `capture processing ${granular.last.rows['capture processing']}`,
)

// ── Phase 2: dry monitor — the exact reference path ────────────────────────
await page.click('#param-dryMonitor')
await page.waitForTimeout(SETTLE_MS)
const dry = await sampleWindow('dry monitor', SAMPLE_MS)
check(dry.peaks['out L'] > -40, `dry out L never moved (${dry.peaks['out L']} dB)`)
const drop = dry.peaks.input - dry.peaks['out L']
check(
  Math.abs(drop - EXPECTED_DROP_DB) < 3,
  `dry input→output drop was ${drop.toFixed(1)} dB, expected ~${EXPECTED_DROP_DB}`,
)
check(
  Math.abs(dry.peaks['out L'] - dry.peaks['out R']) < 0.2,
  `dry ears disagree: L ${dry.peaks['out L']} vs R ${dry.peaks['out R']}`,
)

// Mute must reach silence while the input keeps reading; the readout is a
// decaying peak hold, so wait out the ballistics and check where it settled.
await page.click('#param-mute')
let mutedInputPeak = -Infinity
for (const deadline = Date.now() + SETTLE_MS + 1000; Date.now() < deadline; ) {
  const s = await snapshot()
  mutedInputPeak = Math.max(mutedInputPeak, dbOf(s.meters.input))
  await page.waitForTimeout(60)
}
const muted = await snapshot()
console.log('\nmuted: input peaked at', mutedInputPeak, '· out L settled at', muted.meters['out L'])
check(mutedInputPeak > -40, `input died while muted (${mutedInputPeak} dB)`)
check(muted.meters['out L'] === '−∞', `output not silent while muted (${muted.meters['out L']})`)

// ── Channel test under mute: the tone is the ONLY signal, so this measures
// the stereo separation of the whole output stage in isolation. The buttons
// live on the config page.
await page.click('#nav-config')
await page.click('#test-left')
await page.click('#nav-play')
let toneL = -Infinity
let toneR = -Infinity
for (const deadline = Date.now() + 1500; Date.now() < deadline; ) {
  const s = await snapshot()
  toneL = Math.max(toneL, dbOf(s.meters['out L']))
  toneR = Math.max(toneR, dbOf(s.meters['out R']))
  await page.waitForTimeout(50)
}
console.log('left-only test tone: L', toneL, 'dB · R', toneR, 'dB')
check(toneL > -24, `left test tone did not sound (L peaked at ${toneL} dB)`)
check(toneR === -Infinity, `left test tone leaked into the right ear (R ${toneR} dB)`)
await page.waitForTimeout(SETTLE_MS)

await page.click('#param-mute')
await page.click('#param-dryMonitor')

// ── Phase 3: lateralization — the HRIR path, end to end ────────────────────
// Slot A's grains aimed hard left: if the loader, the nearest-position index,
// the convolution and the coordinate handedness all work, the LEFT ear comes
// out louder — signed, so swapped ears fail loudly.
await drive('s0-azimuthDeg', 90)
await drive('s0-azimuthDevDeg', 0)
await drive('s0-elevationDeg', 0)
await drive('s0-elevationDevDeg', 0)

for (const deadline = Date.now() + 10000; Date.now() < deadline; ) {
  const s = await snapshot()
  const row = s.rows['hrtf set'] ?? ''
  if (row.includes('pos ×') || row.includes('failed')) break
  await page.waitForTimeout(120)
}
const hrtfRow = (await snapshot()).rows['hrtf set'] ?? ''
console.log('\nhrtf set:', hrtfRow)
check(/2,702 pos × \d+ taps/.test(hrtfRow), `hrtf row: "${hrtfRow}"`)

const lateral = await sampleWindow('grains hard left (az +90°)', SAMPLE_MS)
check(lateral.maxVoices > 0, 'no voices in the lateralization phase')
const ild = lateral.peaks['out L'] - lateral.peaks['out R']
check(ild >= 1.5, `az +90° should favor the LEFT ear by ≥1.5 dB, measured L−R = ${ild.toFixed(1)} dB`)
realtime('lateralization', lateral.last)

// ── Phase 4: every effect holds realtime ───────────────────────────────────
await drive('s0-azimuthDevDeg', 40)

await drive('s0-effect', 2) // echo delay
const echo = await sampleWindow('echo delay', SAMPLE_MS)
check(echo.peaks['out L'] > -45, `echo out L never moved (${echo.peaks['out L']} dB)`)
realtime('echo', echo.last)

await drive('s0-effect', 3) // fdn reverb
const reverb = await sampleWindow('fdn reverb', SAMPLE_MS)
check(reverb.peaks['out L'] > -45, `reverb out L never moved (${reverb.peaks['out L']} dB)`)
realtime('reverb', reverb.last)

await drive('s0-effect', 4) // additive pads — detection depends on the fake
const additive = await sampleWindow('additive pads', SAMPLE_MS) // mic's material,
realtime('additive', additive.last) // so only the graph health is asserted.

// ── Phase 5: two pipelines in parallel ─────────────────────────────────────
await drive('s0-effect', 1) // granular back on A
await drive('s1-effect', 3) // reverb on B
const parallel = await sampleWindow('granular ∥ reverb', SAMPLE_MS)
check(parallel.peaks['out L'] > -40, `parallel out L never moved (${parallel.peaks['out L']} dB)`)
check(parallel.maxVoices > 0, 'no voices with two pipelines')
realtime('parallel', parallel.last)

// ── Phase 5b: A-weighted capture stays alive and realtime ──────────────────
// The fake mic's beep is mid-band, where A-weighting is ~0 dB, so the level
// assertion holds; the phase proves the filter runs without breaking the
// graph rather than measuring its curve (that is verified numerically in
// the filter's design).
await page.click('#nav-config')
await page.click('#param-captureWeighting')
await page.click('#nav-play')
const weighted = await sampleWindow('A-weighted capture', SAMPLE_MS)
check(weighted.peaks.input > -43, `A-weighted input died (${weighted.peaks.input} dB)`)
check(weighted.peaks['out L'] > -43, `A-weighted out L died (${weighted.peaks['out L']} dB)`)
realtime('a-weighting', weighted.last)
await page.click('#nav-config')
await page.click('#param-captureWeighting')
await page.click('#nav-play')

await drive('s1-effect', 0)

// ── stop ───────────────────────────────────────────────────────────────────
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
