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

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.click('#transport')

// The synthetic microphone beeps intermittently, so a single reading lands in a
// gap as often as not. Poll and keep the loudest.
const peaks = { input: -Infinity, 'out L': -Infinity, 'out R': -Infinity }
let running = null
for (const deadline = Date.now() + SAMPLE_MS; Date.now() < deadline; ) {
  running = await snapshot()
  for (const [name, text] of Object.entries(running.meters)) {
    peaks[name] = Math.max(peaks[name], dbOf(text))
  }
  await page.waitForTimeout(60)
}

console.log('state:', running.state)
console.log('peaks:', peaks)
console.log('status:', running.rows)

check(running.state === 'running', `state was "${running.state}", expected "running"`)
check(!running.notice, `notice shown: ${running.notice}`)
check(peaks.input > -40, `input meter never moved (max ${peaks.input} dB)`)
check(peaks['out L'] > -40, `out L never moved (max ${peaks['out L']} dB)`)
check(peaks['out R'] > -40, `out R never moved (max ${peaks['out R']} dB)`)

const drop = peaks.input - peaks['out L']
check(
  Math.abs(drop - EXPECTED_DROP_DB) < 3,
  `input→output drop was ${drop.toFixed(1)} dB, expected ~${EXPECTED_DROP_DB}`,
)
check(
  Math.abs(peaks['out L'] - peaks['out R']) < 0.2,
  `channels disagree: L ${peaks['out L']} vs R ${peaks['out R']}`,
)

const renderRate = Number((running.rows['render rate'] ?? '').replace(/[^0-9.]/g, ''))
check(renderRate >= 95, `render rate ${running.rows['render rate']}`)
check(running.rows['clock gaps'] === '0', `clock gaps ${running.rows['clock gaps']}`)
check(running.rows['render quantum'] === '128 frames', `render quantum ${running.rows['render quantum']}`)
check(
  running.rows['capture processing'] === 'none (raw)',
  `capture processing ${running.rows['capture processing']}`,
)

// Mute must reach silence while the input keeps reading. The readout is a
// decaying peak hold, so wait out the ballistics and check where it settled.
await page.click('button.toggle')
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
await page.click('button.toggle')

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
