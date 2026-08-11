import SwiftUI

/// The route probe: answers, on a real device, the one question the web app
/// cannot — which Bluetooth link mode iOS grants each AVAudioSession
/// configuration, and whether the new AirPods high-quality recording mode
/// (iOS 26, AirPods Pro 3) carries stereo output beside the AirPods mic.
///
/// Three screens of purpose:
///  1. Pick a session configuration, activate it, read the granted route.
///  2. Fire the same channel test the web app uses (440 Hz left, 660 Hz
///     right) and listen: two distinct sides = the mode is real.
///  3. Load the PWA in a WKWebView under the natively-configured session to
///     learn whether the whole web engine can ride on it unchanged.
@main
struct RouteProbeApp: App {
    var body: some Scene {
        WindowGroup {
            ProbeView()
        }
    }
}
