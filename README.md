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

**GitHub Pages** — `.github/workflows/pages.yml` builds and publishes on every
push. It needs one manual step first, which no workflow can do for itself:
*Settings → Pages → Source: **GitHub Actions***. Until that is set the build
still runs and stays green, and the deploy is skipped with a note in the run
summary. Once it is set, push (or re-run the workflow) and the URL appears in
the deploy job. Open it in Safari and use *Share → Add to Home Screen*.

This repository is private, so Pages also needs a plan that allows Pages on
private repositories. If the setting is not offered, making the repository
public is the simplest fix; otherwise use the local route below, or any static
host that serves https.

**Local, over the network** — `npm run dev:https` serves the dev server on the
LAN with a self-signed certificate. Safari will warn about the certificate; you
have to accept it before the microphone will open.

Once it launches, the status panel's *display mode* row tells you whether you
are in the installed standalone app or still in a browser tab.

## Keeping a second copy in step

`.github/workflows/mirror.yml` pushes every commit on to a copy of this
repository in another account — useful when the account that can actually
publish Pages is not the account the work happens in. It does nothing until two
values exist under *Settings → Secrets and variables → Actions*:

| Tab           | Name           | Value                                                              |
| ------------- | -------------- | ------------------------------------------------------------------ |
| **Variables** | `MIRROR_REPO`  | `owner/name` of the target                                           |
| **Secrets**   | `MIRROR_TOKEN` | fine-grained PAT issued by the target's account, scoped to that one repository, with **Contents: Read and write** *and* **Workflows: Read and write** |

The tab matters: the two tabs are separate stores, and the workflow reads
`MIRROR_REPO` from Variables only. If either value is missing or misplaced, the
mirror run says exactly which and where, rather than pushing nothing.

Both token permissions are needed. Contents alone looks sufficient and is not —
this repository carries files under `.github/workflows/`, and GitHub rejects any
token-authored push that creates or changes a workflow file unless the token
also carries Workflows.

Files tracked by Git LFS (the HRTF sets under `resources/hrtfs/`) are mirrored
for real: the LFS objects are pushed into the target's LFS storage before the
commits, so the target never holds pointers it cannot resolve. Each mirror run
re-downloads those objects from this repository's LFS storage, which counts
against its LFS bandwidth quota — with ~47 MB of sets that is roughly twenty
runs per free-tier month. If that starts to bite, add a cache step, or store
anything under GitHub's 100 MB blob limit as plain git objects instead.

Because the token belongs to the target's account, that account is what performs
the push and what the target's history records — the source account never
appears there. The commits themselves are authored by `Claude
<noreply@anthropic.com>`, so they carry no account identity either. The one
thing that *would* carry it is this file: nothing here names the source
repository, deliberately, since the target may be public. Keep it that way.

The mirror is downstream, not a second place to work: the push is forced, so a
commit that exists only there is overwritten on the next push here. Forcing is
unavoidable when the target was populated by copying files in, because its
history is unrelated to this one and no fast-forward joins them. Don't set these
two values on the mirror, or the pair will push at each other.

To pull by hand instead, from a clone of the target — filling in the source
repository rather than committing it here:

```sh
git remote add upstream https://github.com/<source-owner>/<source-repo>.git
git fetch upstream
git reset --hard upstream/main
git push --force
```

That needs credentials for the source, if it is private.

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