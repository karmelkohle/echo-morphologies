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

## Working on one stage at a time

`EngineCore.process()` is laid out as four numbered sections — capture,
granular, binaural, output — each with the stage's input and output contract
written above the call. To try something, edit the stage class, or write
straight into the buffers in the section itself and skip the call.

Stages receive buffers `EngineCore` has already zeroed and add into them. That
is the contract the real DSP wants anyway (grains accumulate; the renderer sums
one convolution per lane), and it has a useful side effect: commenting a stage
out degrades to silence rather than to whatever was in the buffer last block,
so a bypassed stage sounds like a bypassed stage instead of like a bug. Both
bypasses are verified — comment either call out and the input meter keeps
reading while the output goes to true silence.

## Pipelines

The engine runs up to three effect pipelines in parallel on the same capture
(`EngineCore`), each owning four lanes of the directional bus and one
`SpatialTarget` (azimuth/elevation ± spread). Effects implement the
`SpatialEffect` interface in `src/engine/effects/` — mono in, lanes out,
directions set as their material demands: per grain, per echo repeat, per
reverb line, per partial. Adding an effect is one class file, one entry in
params.ts (EFFECTS + EFFECT_LOCALS + local specs), one case in EngineCore's
factory.

Parameters follow a two-space id scheme: globals below 100, slot params at
100 + 100·slot + local — stable integers end to end, wasm-ready. Effect
instances are created on first selection (between render quanta, like an
HRIR swap) and cached; a slot replays its stored locals onto late-created
instances so values never depend on ordering.

## The stages as built

**Granular** (`stages/GranularStage.ts`) is a port of `msf::Granular` +
`GranularExpander`, close enough that figures transfer: rolling capture ring
with the seam-guarded interpolated read, sample-accurate onset countdown
(Sync and Poisson schedulers), the four grain envelopes, per-grain uniform
deviation draws from the bit-compatible LCG (`dsp/Rng.ts`), reversed grains
as negative playback rates, round-robin lane dealing. One deliberate
extension: an explicit read-delay parameter (base ± scatter) positions the
tap behind realtime. Not ported yet, by choice: freeze/loop, pitch
quantization, the structured jitter laws — they layer on without moving
anything.

**Binaural** (`stages/BinauralStage.ts` + `hrir/HrirSet.ts`) resolved the
brief's three worries smaller than feared, because the real sets are smaller
than the brief guessed:

1. *Storage.* KU100 Köln is 2 702 positions × 128 taps; FABIAN 11 950 × 256.
   Converted offline (scripts/sofa-to-hrir.mjs, h5wasm — SOFA never reaches
   the browser) to int16 binaries of 1.3 MB and 11.8 MB, decoded to float32
   at load (~2.8 / 24 MB resident).
2. *Lookup.* At these sizes a flat unit-vector scan wins over any tree, and
   it runs at direction-change rate (grain spawns), not sample rate.
3. *Convolution.* Time-domain FIR per lane, ~100 M MAC/s worst case at
   Köln×8 lanes — with a silent-lane skip that removes most of it at
   ordinary densities, since dead lanes ring out their tail, zero once, and
   cost nothing. Direction changes crossfade for one block. The render-rate
   status row referees; partitioned FFT is the upgrade path if a phone
   disagrees.

Sets resample linearly at load when the context rate differs from the
measurement rate (the status row says so). `msf`'s `image_source.hpp` covers
the room-response half of the brief when it comes.

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

There are no unit tests yet. What exists is `npm run smoke` — `tests/smoke.mjs`
builds, serves `dist/`, and drives the real app in headless Chromium against a
synthetic capture device.

The status panel is what it reads, and the assertions are about the DSP rather
than about the page loading: *render rate* at ~100% of realtime, *clock gaps* at
0, the output meters tracking the input at exactly the output gain's offset on
both channels, and mute reaching true silence while the input keeps reading. A
build where the graph runs but the engine is wrong passes a "did it load" check
and fails this one, which is the failure mode that will matter once there is
real DSP in `src/engine/`.

When a stage gains actual signal processing, the assertion to add alongside it
is the one that would catch it being silently bypassed — a granulator that
outputs its dry input still passes every check above.
