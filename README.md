# echo morphologies

A progressive web app that captures live sound from the earbuds, re-composes it
with granular synthesis and re-spatialises it with HRTF convolution — so that
walking through a city means hearing a re-imagined version of it.

This commit is **the framework, not the piece**. Audio is captured, metered,
levelled, limited and played back; the granular and HRTF stages exist in the
signal chain and pass audio through unchanged. What it proves is that the
plumbing works end to end on the target device, which is the thing worth
knowing before any DSP gets written.

## What runs today

```
capture ─▶ input trim ─▶ granular ─▶ directional bus ─▶ binaural ─▶ output gain ─▶ limiter ─▶ ears
   mono       smoothed    (bypass)      1 lane           (bypass)      smoothed     −1 dBFS    stereo
```

- Mono capture with echo cancellation, noise suppression and auto gain all
  switched off.
- Input trim and output gain, both sample-smoothed, plus a click-free mute.
- A safety limiter at −1 dBFS that cannot be switched off.
- Input and per-channel output meters with peak-hold, and a status panel that
  reports the numbers you need to trust the run: sample rates, latency, render
  rate against realtime, render-clock gaps, clipped samples, limiter activity.
- Installable and fully offline-capable.

## Getting it onto the phone

`getUserMedia` refuses to run on a plain-http origin, so the phone needs an
https URL. Two ways:

**GitHub Pages** — push, and `.github/workflows/pages.yml` builds and publishes.
The workflow turns Pages on for the repository itself the first time it runs.
Then open the published URL in Safari and use *Share → Add to Home Screen*.

That needs a plan that allows Pages on a *private* repository, which this one
is. If the deploy fails on the `configure-pages` step, that is what happened —
either make the repository public, or use the local route below and any static
host with https for sharing.

**Local, over the network** — `npm run dev:https` serves the dev server on the
LAN with a self-signed certificate. Safari will warn about the certificate; you
have to accept it before the microphone will open.

Once it launches, the status panel's *display mode* row tells you whether you
are in the installed standalone app or still in a browser tab.

## Development

```sh
npm install
npm run dev            # app on http://localhost:5173
npm run dev:worklet    # in a second terminal, rebuilds the audio engine on change
npm run build          # typecheck, worklet bundle, app bundle → dist/
npm run typecheck
npm run smoke          # build, then drive the real app in a headless browser
npm run icons          # regenerate public/icons/ from scripts/gen-icons.mjs
```

`npm run smoke` is the regression net worth keeping green: it starts the app
against a synthetic microphone and asserts that the graph runs at realtime with
no clock gaps, that the output tracks the input at exactly the output gain's
offset on both channels, and that mute reaches true silence. Those are claims
about the DSP, not just about the page loading. It needs a browser once —
`npx playwright install chromium`, or point `CHROMIUM_PATH` at one you have.

The AudioWorklet is a separate bundle (see `vite.worklet.config.ts` for why), so
`npm run dev` builds it once at start-up. Editing anything under `src/engine/`
or `src/worklet/` needs `npm run dev:worklet` running, or another `npm run dev`.

Layout:

| Path             | What lives there                                                      |
| ---------------- | --------------------------------------------------------------------- |
| `src/engine/`    | The DSP. No Web Audio, no DOM — this is the part that ports.           |
| `src/worklet/`   | Audio-thread host and the message protocol across the thread boundary. |
| `src/audio/`     | Web Audio plumbing: devices, permissions, graph, lifecycle.            |
| `src/ui/`        | Meters, controls, status table.                                        |
| `docs/`          | `ARCHITECTURE.md` — the design decisions and the road to WebAssembly.  |

## Things worth knowing before building on this

**Opening the microphone costs you the playback bandwidth.** Bluetooth earbuds
cannot run a high-quality output stream and a microphone at the same time; asking
for the mic switches AirPods into a bidirectional call mode and both directions
drop to speech bandwidth. This is a Bluetooth constraint, not a browser one — a
native iOS app hits it identically, so it is a fact about the piece rather than a
problem the port will solve. The status panel reports the negotiated *capture
rate* so you can see exactly what you got on your hardware and OS version, and
it is worth checking that number early, because it bounds what the granulator
has to work with. Wired earbuds or a separate interface side-step it entirely.

**The gain fader is not the phone's volume control.** No web API can set the iOS
system output level — `HTMLMediaElement.volume` is ignored there too — so the
fader is a gain stage inside the audio graph, applied just before the limiter.
That is the better place for it anyway: it is automatable from the composition
later, where the hardware volume never could be. The phone's own volume buttons
still work on top of it.

**Wear headphones.** The app routes a live microphone to the output. On the
phone's speaker that is a feedback loop, which is why the limiter is not
optional and the output gain defaults to −12 dB.

**iOS will interrupt you.** Calls, route changes and backgrounding suspend the
audio context. The app detects this, says so, and resumes when it can; the
*clock gaps* counter records how often it happened during a walk.

## Next

`docs/ARCHITECTURE.md` covers the engine ABI, the WebAssembly migration and the
open decisions on the HRTF set. The short version of what comes next: a capture
ring buffer and grain scheduler in `GranularStage`, then HRIR loading, a
nearest-position index and partitioned convolution in `BinauralStage`.
