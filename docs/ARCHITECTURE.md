# Architecture

The brief asks for a web app now and a native iOS app later, sharing one DSP
core. Everything below follows from taking that seriously: the split between
what ports and what gets rewritten is decided up front, and the boundary is
drawn where a WebAssembly module can sit without redesign.

## Four layers

```
┌─ ui/ ──────────────── meters, faders, status ──── DOM, rewritten natively
├─ audio/ ───────────── devices, permissions, graph ─ Web Audio, rewritten natively
├─ worklet/ ─────────── audio-thread host ─────────── thin, rewritten natively
└─ engine/ ──────────── the DSP ──────────────────── ports unchanged
```

`engine/` imports nothing from the platform. It sees planar `Float32Array`s and
a frame count. That constraint is the whole portability strategy, and it is
worth defending in review — one `AudioContext` reference in there and the port
stops being mechanical.

## The engine ABI

`AudioEngineCore` in `src/engine/types.ts`:

```ts
prepare(config)                      // allocate, derive coefficients
reset()                              // clear state, keep parameters
setParam(id: number, value: number)  // realtime-safe
process(input[], output[], frames)   // render one block
readMeters(dst: Float32Array)        // drain accumulated metering
```

`prepare` / `process` / `reset` is deliberately the same contract as
`msf::Processor` in the **spatdsp** library, so code moves between the two
without an adapter. Parameters are integer ids rather than strings, and meters
are a flat float array rather than an object, because both cross a wasm boundary
as-is:

```c
void engine_prepare(float sample_rate, int max_block, int n_in, int n_out);
void engine_process(const float* const* in, float* const* out, int frames);
void engine_set_param(int id, float value);
void engine_read_meters(float* dst);
```

Realtime rules inside `process()`: no allocation, no exceptions, no unbounded
loops. Everything is sized in `prepare()`.

## The directional bus

The one design decision here that is not obvious, and the one most expensive to
get wrong.

The naive chain is granular (mono → mono) then binaural (mono → stereo). It is
wrong, because the point of the piece is that each grain sits at its own
composed position, and a mono hand-off discards that before the renderer sees
it. Nothing downstream recovers it.

So `GranularStage` does not output a signal, it outputs a field:
`DirectionalBus`, a small set of lanes each tagged with a direction.
`BinauralStage` convolves each lane with the HRIR pair for its direction and
sums. Grains are assigned to the nearest lane, which bounds the work at
`laneCount` convolutions per block however dense the cloud gets — the trick
`msf`'s spatial reverb uses when it encodes its late field at 16 Fibonacci
directions.

This makes the granulator an instance of `msf::SourceExpander`: mono in, N
tagged lanes out. `granular_expander.hpp` already implements that in C++ against
the same model.

Today `laneCount` is 1 and both stages pass audio through. The lane count
becomes a spatial-resolution parameter — the knob that trades convolution cost
against how finely composed positions can be resolved.

Coordinates match spatdsp exactly, so figures move between the projects without
conversion: degrees, azimuth 0° straight ahead and positive counter-clockwise
over [−180, +180], elevation over [−90, +90], distance in metres, reference 1 m.

## Filling in the stages

**Granular.** A capture ring buffer of a few seconds — it is the delay line and
the grain source at once. A scheduler emitting onsets at a density, each grain
taking read position, duration, playback rate and window from the parameter
table plus a seeded RNG, so a walk can be reproduced. Then a position composer:
with one microphone there is no direction of arrival to recover, so direction is
composed, and that composer is the artistic core of the piece rather than a
technical detail.

**Binaural.** Three problems, in the order they bite:

1. *Storage.* 256 taps × 2 ears × ~20 000 positions × 4 bytes ≈ 41 MB resident.
   Loadable once at start-up, but iOS is not generous with a tab's memory
   budget; int16 with a per-position scale halves it and is worth measuring
   before committing to float32.
2. *Lookup.* The brief calls nearest-position lookup the main subtlety and it
   is. A linear scan of 20 000 positions per grain is not viable. Bucketed
   equirectangular bins with a neighbour search, or a spherical KD-tree. Decide
   this before the set is loaded — the index wants to match the storage layout,
   and retrofitting one to the other means rewriting both.
3. *Convolution.* Partitioned uniform-block, per lane. At 256 taps against
   128-frame quanta that is two partitions per ear, frequency-domain, with the
   forward transform of the input block computed once and shared across lanes.
   Crossfade when a lane's direction changes, or movement clicks.

`msf`'s `binaural_speaker.hpp` holds the per-position HRIR convolution matrix
this maps onto, and `image_source.hpp` covers the room-response half of the
brief once the direct path works.

## Adding a parameter

`src/engine/params.ts` is the single source of truth. Add an entry and the
control appears in the interface with the right range, step and formatting,
already wired; add a `case` in `EngineCore.setParam` and the engine responds.
Nothing in `ui/` knows what a gain is.

Ids are small integers so the same table drives a wasm engine unchanged.

## Constraints that shaped the code

**No SharedArrayBuffer.** The tidy way to move meters off the audio thread is
shared memory, which needs cross-origin isolation (COOP + COEP). GitHub Pages
cannot send those headers. Meters therefore go by `postMessage` — eight numbers
about thirty times a second, which allocates on the audio thread but is small,
bounded and worth it to keep the app deployable on static hosting. If the engine
ever needs a real audio-rate channel between threads, this is the decision to
revisit, and it costs a hosting change.

**One microphone.** Both native and web expose AirPods as a single mono input,
so direction of arrival and beamforming are off the table by construction. This
is why the directional bus carries composed positions rather than measured ones.

**Bluetooth bandwidth.** Opening the mic switches AirPods into bidirectional
call mode and both directions drop to speech bandwidth. It is a Bluetooth
constraint, so the native port inherits it unchanged — plan the material around
it rather than expecting the rewrite to fix it. The status panel reports the
negotiated capture rate.

**Not realtime-critical.** The brief settles this: the piece does not need low
latency, which is what makes the web viable at all. Nothing in the engine
assumes a small block, and `MAX_BLOCK_SIZE` in the worklet is 512 so a larger
future render quantum widens the block rather than truncating it.

## Verifying a change

There are no unit tests yet. What exists is an end-to-end check that the graph
runs, which is the failure mode that actually bites: run `npm run build`, serve
`dist/`, and drive it in a browser with a fake capture device
(`--use-fake-device-for-media-stream`). The status panel is built for this — a
run is healthy when *render rate* sits at ~100% of realtime, *clock gaps* stays
at 0, and the output meters track the input with exactly the output gain's
offset. That last one is a real assertion about the DSP, not just about the
plumbing: at the default −12 dB the output must read 12 dB under the input, and
mute must take the output to silence while the input keeps reading.
