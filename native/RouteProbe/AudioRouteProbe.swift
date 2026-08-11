import AVFoundation
import Combine

/// Owns the AVAudioSession experiments and a tiny AVAudioEngine graph:
/// microphone level metering plus hard-panned test tones.
///
/// Everything here is deliberately verbose about what iOS *actually granted*
/// — route names, channel counts, sample rates — because the difference
/// between "requested" and "granted" is this entire investigation.
final class AudioRouteProbe: ObservableObject {

    enum Configuration: String, CaseIterable, Identifiable {
        /// iOS 26 + AirPods Pro 3: the high-quality link, HFP as fallback.
        case highQualityRecording = "HQ recording (iOS 26)"
        /// The classic split: A2DP stereo out, input falls to built-in mic.
        case a2dpSplit = "A2DP out + phone mic"
        /// The old world: hands-free profile, mono, for comparison.
        case classicHFP = "Classic HFP"

        var id: String { rawValue }
    }

    @Published private(set) var log: [String] = []
    @Published private(set) var isActive = false
    @Published private(set) var inputLevelDb: Float = -120

    private let session = AVAudioSession.sharedInstance()
    private var engine: AVAudioEngine?
    private var tonePlayer: AVAudioPlayerNode?
    private var routeObserver: NSObjectProtocol?

    // MARK: session configurations

    func activate(_ configuration: Configuration) {
        deactivate()
        do {
            switch configuration {
            case .highQualityRecording:
                if #available(iOS 26.0, *) {
                    // Apple: with both options set, the high-quality mode is
                    // preferred and HFP is only the fallback for unsupported
                    // devices — and, per the docs, in unsupported regions
                    // (the EU restriction). The route dump below is the truth.
                    try session.setCategory(
                        .playAndRecord,
                        mode: .default,
                        options: [.allowBluetooth, .bluetoothHighQualityRecording]
                    )
                } else {
                    append("⚠️ iOS 26 required for bluetoothHighQualityRecording — falling back to classic HFP")
                    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
                }
            case .a2dpSplit:
                // Stereo A2DP playback stays with the earbuds; capture falls
                // to the built-in microphone (there is no headset mic in A2DP).
                try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
            case .classicHFP:
                try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
            }

            try session.setActive(true)
            isActive = true
            append("── activated: \(configuration.rawValue) ──")
            dumpRoute(reason: "after activation")
            startEngine()
            observeRouteChanges()
        } catch {
            append("❌ \(error.localizedDescription)")
        }
    }

    func deactivate() {
        stopEngine()
        if let observer = routeObserver {
            NotificationCenter.default.removeObserver(observer)
            routeObserver = nil
        }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        isActive = false
    }

    // MARK: the verdict

    func dumpRoute(reason: String) {
        let route = session.currentRoute
        append("route (\(reason)):")
        for input in route.inputs {
            append("  in:  \(input.portName) [\(input.portType.rawValue)] ch=\(input.channels?.count ?? 0)")
        }
        for output in route.outputs {
            append("  out: \(output.portName) [\(output.portType.rawValue)] ch=\(output.channels?.count ?? 0)")
        }
        append("  outputChannels=\(session.outputNumberOfChannels)  sampleRate=\(Int(session.sampleRate)) Hz")
        let verdictStereo = session.outputNumberOfChannels >= 2
        let verdictWideband = session.sampleRate >= 32000
        append(verdictStereo && verdictWideband
               ? "✅ stereo + wideband — spatial rendering is ON the table"
               : verdictStereo
                 ? "🟡 stereo but low rate — listen to the channel test"
                 : "❌ mono route — HFP world, spatial cues collapse")
    }

    private func observeRouteChanges() {
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.dumpRoute(reason: "route change")
        }
    }

    // MARK: minimal engine — mic meter + channel-test tones

    private func startEngine() {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        append("mic format: \(Int(inputFormat.sampleRate)) Hz, \(inputFormat.channelCount) ch")

        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
            var sum: Float = 0
            let n = Int(buffer.frameLength)
            for i in 0..<n { sum += data[i] * data[i] }
            let rms = sqrt(sum / Float(max(1, n)))
            let db = 20 * log10(max(rms, 1e-6))
            DispatchQueue.main.async { self?.inputLevelDb = db }
        }

        let player = AVAudioPlayerNode()
        engine.attach(player)
        let stereo = AVAudioFormat(standardFormatWithSampleRate: session.sampleRate, channels: 2)!
        engine.connect(player, to: engine.mainMixerNode, format: stereo)

        do {
            try engine.start()
            self.engine = engine
            self.tonePlayer = player
        } catch {
            append("❌ engine: \(error.localizedDescription)")
        }
    }

    private func stopEngine() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        tonePlayer = nil
        inputLevelDb = -120
    }

    /// The same diagnostic the web app runs: 600 ms, 440 Hz hard left or
    /// 660 Hz hard right. Distinct pitches make a swapped route audible.
    func playTone(left: Bool) {
        guard let player = tonePlayer, let engine, engine.isRunning else {
            append("⚠️ activate a configuration first")
            return
        }
        let sampleRate = session.sampleRate
        let frames = AVAudioFrameCount(0.6 * sampleRate)
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buffer.frameLength = frames

        let frequency = left ? 440.0 : 660.0
        let channel = left ? 0 : 1
        let fade = Int(0.015 * sampleRate)
        if let data = buffer.floatChannelData {
            for i in 0..<Int(frames) {
                let edge = min(1.0, Double(min(i, Int(frames) - i)) / Double(fade))
                let env = Float(0.5 * (1 - cos(.pi * edge)) * 0.25)
                data[channel][i] = Float(sin(2 * .pi * frequency * Double(i) / sampleRate)) * env
                data[1 - channel][i] = 0
            }
        }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
        player.play()
        append(left ? "▶ tone LEFT · 440 Hz" : "▶ tone RIGHT · 660 Hz")
    }

    private func append(_ line: String) {
        DispatchQueue.main.async {
            self.log.append(line)
            if self.log.count > 200 { self.log.removeFirst(self.log.count - 200) }
        }
    }
}
