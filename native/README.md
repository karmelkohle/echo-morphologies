# Route probe — the native session experiment

Three Swift files that answer, on a real device, what no web page can ask:
**which Bluetooth link mode does iOS grant each `AVAudioSession`
configuration** — and specifically whether iOS 26's
`bluetoothHighQualityRecording` (AirPods Pro 3 / Pro 2 / 4) really carries
**stereo output beside the AirPods microphone**, which Safari's web sessions
refuse (any live mic + Bluetooth output = call mode, mono, field-verified).

Heads-up before spending time: Apple's documentation says Bluetooth
High Quality Recording **is not currently supported in the European Union**.
On an EU-region iPhone the option may silently fall back to HFP — which this
probe makes visible immediately. That outcome is not a bug in the probe; it
is the answer.

## Build (≈10 minutes, needs a Mac with Xcode 26)

1. Xcode → *File → New → Project → iOS → App*.
   - Product name: `RouteProbe` · Interface: SwiftUI · Language: Swift.
2. Delete the generated `ContentView.swift`; drag the three files from this
   folder into the project (copy items if needed):
   `RouteProbeApp.swift`, `AudioRouteProbe.swift`, `ProbeView.swift`
   (`RouteProbeApp.swift` replaces the generated `@main` file — delete that
   one too).
3. Target → *Info* → add **Privacy – Microphone Usage Description**
   (`NSMicrophoneUsageDescription`), e.g. "Route diagnostics".
4. Signing: your personal team; run on the iPhone (a free account is fine).

## Read the result

Wear the AirPods, then for each configuration in the picker press
**Activate** and read the log:

| Log verdict | Meaning |
| --- | --- |
| `✅ stereo + wideband` | The mode carries ≥2 output channels at ≥32 kHz. Press the tone buttons: low tone ONLY left and high tone ONLY right confirms real stereo — the piece works over AirPods with their own mic. |
| `🟡 stereo but low rate` | Two channels negotiated but a call-grade rate; trust the tone test over the numbers. |
| `❌ mono route` | HFP world. With *HQ recording* selected on iOS 26 + AirPods Pro 3, this most likely means the EU restriction is in effect on this device. |

The **mic level** row proves which microphone is live (tap an AirPod stem /
speak close to the phone and watch what moves). Route changes are logged as
they happen, so you can watch iOS renegotiate in real time.

## The strategic second half: the PWA inside the session

The *"Load web app"* toggle embeds the deployed PWA in a WKWebView **while
the natively-configured session is active**, and grants it microphone access
through the app's own permission. Then press *"Dump route while web app
runs"*:

- **Route stays stereo/wideband while the web engine runs** → the entire
  existing web app can BE the native app: a shell of roughly this size owns
  the session, and `src/engine/` never needs porting to ship. That would be
  the shortest possible path to "the piece, on AirPods, as designed".
- **Route collapses to HFP when the web app starts capturing** → WebKit
  overrides the host session for its own capture, and the native port needs
  the real plan: the engine behind AVAudioEngine (the wasm route documented
  in `docs/ARCHITECTURE.md`), with this probe's session code as its base.

Either way the probe has paid for itself: it tells us which native
architecture to build before writing any of it.

## Notes

- Written blind on Linux — not compiled here. Expect at most trivial fixes
  (an API rename between SDK betas); the session logic is standard.
- `.allowBluetooth` is spelled `.allowBluetoothHFP` in newer SDKs; both
  compile on Xcode 26, the old name with a deprecation warning.
- The web URL field defaults to the public mirror's Pages deployment; point
  it at a LAN dev server (`npm run dev:https`) to iterate against local code.
