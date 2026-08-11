import SwiftUI
import WebKit

/// One screen, three purposes: configure a session, hear the verdict, and
/// test whether the PWA inherits the native session inside a WKWebView.
struct ProbeView: View {
    @StateObject private var probe = AudioRouteProbe()
    @State private var configuration: AudioRouteProbe.Configuration = .highQualityRecording
    @State private var showWebView = false
    /// The deployed PWA; change to a LAN dev URL when working locally.
    @State private var webAppURL = "https://karmelkohle.github.io/echo-morphologies/"

    var body: some View {
        NavigationStack {
            List {
                Section("Session configuration") {
                    Picker("Configuration", selection: $configuration) {
                        ForEach(AudioRouteProbe.Configuration.allCases) { config in
                            Text(config.rawValue).tag(config)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()

                    HStack {
                        Button(probe.isActive ? "Re-activate" : "Activate") {
                            probe.activate(configuration)
                        }
                        .buttonStyle(.borderedProminent)
                        Spacer()
                        Button("Deactivate") { probe.deactivate() }
                            .disabled(!probe.isActive)
                    }
                }

                Section("Channel test — wear the AirPods") {
                    HStack(spacing: 12) {
                        Button("◀ left · 440 Hz") { probe.playTone(left: true) }
                            .buttonStyle(.bordered)
                        Button("right · 660 Hz ▶") { probe.playTone(left: false) }
                            .buttonStyle(.bordered)
                    }
                    .disabled(!probe.isActive)

                    HStack {
                        Text("mic level")
                        Spacer()
                        Text(probe.inputLevelDb <= -119 ? "—" : String(format: "%.1f dBFS", probe.inputLevelDb))
                            .monospacedDigit()
                            .foregroundStyle(probe.inputLevelDb > -50 ? .green : .secondary)
                    }
                }

                Section("The PWA under this session") {
                    TextField("web app URL", text: $webAppURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("Load web app", isOn: $showWebView)
                    if showWebView {
                        WebAppView(urlString: webAppURL)
                            .frame(height: 420)
                        Button("Dump route while web app runs") {
                            probe.dumpRoute(reason: "web app running")
                        }
                    }
                }

                Section("Log") {
                    ForEach(Array(probe.log.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(line.hasPrefix("✅") ? .green
                                             : line.hasPrefix("❌") ? .red
                                             : line.hasPrefix("🟡") ? .orange : .primary)
                    }
                }
            }
            .navigationTitle("Route probe")
        }
    }
}

/// WKWebView host that grants microphone capture without re-prompting —
/// the app's own mic permission covers it (iOS 15+ delegate callback).
struct WebAppView: UIViewRepresentable {
    let urlString: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = context.coordinator
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let url = URL(string: urlString), webView.url != url, !urlString.isEmpty else { return }
        webView.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKUIDelegate {
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(type == .microphone ? .grant : .deny)
        }
    }
}
