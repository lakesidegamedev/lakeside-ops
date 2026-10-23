import SwiftUI
import LakesideCore

/// A foreground voice conversation: silence submits a turn, replies play, then
/// listening resumes. Ending the mode releases the microphone and playback.
struct KeirVoiceMode: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @ObservedObject var keir: KeirStore
    @StateObject private var voice = KeirVoice()
    @State private var waiting = false
    @State private var paused = false
    @State private var reply = ""
    @State private var lastReply = ""
    @State private var requestedRoute = ""
    @State private var since = Date()
    @State private var error: String?
    @State private var active = false
    @State private var listenTask: Task<Void, Never>?
    @State private var request: VoiceRequest?
    @State private var preserveTask = false
    @State private var expectedJob: String?
    @State private var waitTask: Task<Void, Never>?
    @State private var connectionAttempt = 0
    @EnvironmentObject private var router: OpsRouter
    private var fixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("--uitest-fixtures")
#else
        false
#endif
    }
    private var state: KeirPresence.State {
        if keir.stopped { return .stopped }
        if !keir.connected { return .offline }
        if voice.listening { return .listening }
        if voice.speaking { return .speaking }
        return waiting || voice.preparingSpeech ? .thinking : .ready
    }
    private var status: String {
        if paused { return "Microphone paused" }
        if voice.preparingSpeech { return "Preparing voice" }
        switch state {
        case .listening: return "I'm listening"
        case .speaking: return "Keir is speaking"
        case .thinking: return "Thinking"
        case .stopped: return "Keir is stopped"
        case .offline: return "Reconnecting"
        default: return "Ready to talk"
        }
    }
    private var routeLabel: String {
        if let current = keir.tasks.first(where: { $0["id"].string == expectedJob && $0["state"].string == "running" }), !current["provider"]["model"].string.isEmpty {
            return "Requested: " + current["provider"]["model"].string
        }
        if !requestedRoute.isEmpty { return "Requested: " + requestedRoute }
        let selected = keir.controls["routes"]["voice"].string
        if !selected.isEmpty && selected != "auto" { return "Selected: " + selected }
        return "Auto · Gemini / DeepSeek alternating"
    }
    private var screen: some View {
        VStack(spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Keir voice").font(.headline)
                    Text(voice.usingDeviceFallback ? "Apple · fallback voice" : UserDefaults.standard.string(forKey: "keir-speech-provider") == "apple" ? "Apple · device voice" : "Microsoft Ava · online voice").font(.caption).foregroundStyle(OpsTheme.muted)
                    Menu {
                        ForEach(keir.controls["options"]["voice"].array, id: \.["id"].string) { model in
                            Button { Task { requestedRoute = ""; await keir.control(["action": .string("configure"), "routes": .object(["voice": .string(model["id"].string)])], session) } } label: {
                                Text(model["id"].string == "auto" ? "Automatic · \(KeirProviderName.label(keir.controls["defaults"]["voice"].string, options: keir.controls["options"]["voice"].array))" : "\(model["label"].string) · \(model["provider"].string)")
                            }.disabled(model["available"] == .bool(false))
                        }
                    } label: { Label(routeLabel, systemImage: "cpu").font(.caption) }
                        .disabled(keir.controlling).accessibilityIdentifier("keir-voice-model")
                }
                Spacer()
                Button { endVoice(); dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44).background(OpsTheme.surface, in: Circle()) }.accessibilityLabel("End voice conversation")
            }
            Spacer(minLength: 12)
            KeirVoiceOrb(state: state, level: voice.level).frame(width: 190, height: 190).accessibilityHidden(true)
            if state == .thinking { LoadingShimmer(text: status).font(.largeTitle.weight(.semibold)) }
            else { Text(status).font(.largeTitle.weight(.semibold)).contentTransition(.opacity) }
            ScrollView {
                VStack(spacing: 18) {
                    if !voice.transcript.isEmpty { Text(voice.transcript).font(.title3).foregroundStyle(OpsTheme.muted) }
                    if !reply.isEmpty { Text(reply).font(.title3).textSelection(.enabled) }
                }.frame(maxWidth: .infinity)
            }.frame(maxHeight: 200)
            if let message = error ?? voice.error ?? (!keir.connected ? keir.error : nil) {
                Text(message).font(.callout).foregroundStyle(OpsTheme.warn)
                Button("Try voice again") { cancelRequest(); waiting = false; waitTask?.cancel(); paused = false; error = nil; if !keir.connected { connectionAttempt += 1 }; listen() }
                if let expectedJob { Button("Open voice task") { preserveTask = true; router.openTask(expectedJob); dismiss() } }
                Button("Open iOS Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
            }
            Text("Pause to send. Tap the waveform to interrupt.").font(.caption).foregroundStyle(OpsTheme.muted)
            Spacer(minLength: 12)
            controls
        }.padding(24).opsScreen()
    }
    private var controls: some View {
        HStack(spacing: 22) {
            Button {
                paused.toggle(); voice.stop()
                if !paused { listen() }
            } label: { Image(systemName: paused ? "mic.slash.fill" : "mic.fill").frame(width: 58, height: 58).background(OpsTheme.surface, in: Circle()) }
                .accessibilityLabel(paused ? "Resume microphone" : "Pause microphone")
            Button {
                cancelRequest(); waiting = false; expectedJob = nil; waitTask?.cancel(); error = nil; voice.stop(); paused = false; listen()
            } label: { Image(systemName: "waveform").font(.title).frame(width: 76, height: 76).background(OpsTheme.sky.opacity(0.18), in: Circle()) }
                .accessibilityLabel("Interrupt and speak").disabled(keir.stopped || !keir.connected)
            Button { endVoice(); dismiss() } label: { Image(systemName: "phone.down.fill").frame(width: 58, height: 58).background(OpsTheme.warn.opacity(0.15), in: Circle()) }.tint(OpsTheme.warn).accessibilityLabel("End voice mode")
        }
    }
    var body: some View {
        screen
            .task(id: "\(phase)|\(connectionAttempt)") { if phase == .active { await keir.connect(session) } }
            .task {
                active = true; since = Date(); if !fixture { listen() }
#if DEBUG
                if fixture && ProcessInfo.processInfo.arguments.contains("--uitest-late-voice") {
                    expectedJob = "fixture-late-voice"; waiting = false
                    error = "The voice reply has not arrived. Open the task to check progress, or try another turn."
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                    guard active else { return }
                    keir.messages.append(.object(["id": .string("fixture-late-answer"), "role": .string("keir"), "jobId": .string("fixture-late-voice"), "text": .string("The late answer is now ready.")]))
                    return
                }
#endif
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if !fixture && active && !paused && !waiting && !voice.requesting && !voice.listening && !voice.speaking && !voice.preparingSpeech && voice.error == nil {
                    error = "Voice has not started. Check the connection and microphone permissions, then try again."
                }
            }
            .onDisappear { if !preserveTask { cancelRequest() }; active = false; listenTask?.cancel(); waitTask?.cancel(); voice.stop() }
            .onChange(of: phase) { _, next in
                if next == .active && !paused && !fixture { listen() }
                else if next == .background || (next != .active && !voice.requesting) { paused = true; voice.stop() }
            }
            .onChange(of: keir.stopped) { _, stopped in if stopped { paused = true; voice.stop() } }
            .onChange(of: keir.connected) { _, connected in if connected && !fixture { listen() } }
            .onChange(of: keir.tasks) { _, _ in receive() }
            .onChange(of: voice.completedTurn) { _, _ in submit() }
            .onChange(of: voice.speaking) { was, speaking in
                if was && !speaking { receive(); if !waiting && voice.error == nil { listen() } }
            }
            .onChange(of: voice.preparingSpeech) { _, preparing in if !preparing && !voice.speaking { receive() } }
            .onChange(of: keir.messages.count) { _, _ in receive() }
    }
    private func listen() {
        guard active, !paused, !waiting, !voice.listening, !voice.requesting, !voice.speaking, !voice.preparingSpeech, !keir.stopped, keir.connected, phase == .active else { return }
        error = nil; listenTask?.cancel(); listenTask = Task { await voice.start(automatic: true) }
    }
    private func cancelRequest() {
        request?.cancel()
        request = nil
    }
    private func endVoice() {
        cancelRequest(); active = false
        listenTask?.cancel(); waitTask?.cancel(); voice.stop()
    }
    private func submit() {
        let text = voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard active, !text.isEmpty, !waiting, !paused, phase == .active else { return }
        waiting = true; expectedJob = nil; error = nil; reply = ""
        let turn = VoiceRequest { jobID in
            // This task survives dismissal so the accepted server job is stopped.
            Task { await keir.stop(jobID, session) }
        }
        request = turn
        Task {
            // Do not cancel this HTTP send on hangup: retain its receipt and stop it.
            let sent = await keir.send(text, session, voice: true, accepted: { turn.accept($0) })
            guard active, request === turn, !turn.cancelled else { return }
            expectedJob = turn.jobID
            if sent {
                receive()
                if waiting {
                    waitTask?.cancel()
                    waitTask = Task { @MainActor in
                        do { try await Task.sleep(for: .seconds(90)) } catch { return }
                        guard active, waiting else { return }
                        waiting = false; error = "The voice reply has not arrived. Open the task to check progress, or try another turn."
                    }
                }
            }
            if !sent { waiting = false; error = keir.error ?? "Couldn't send. Tap to try again." }
        }
    }
    private func receive() {
        guard active, let expectedJob, !voice.speaking, !voice.preparingSpeech else { return }
        // Keep the accepted turn after timeout, without interrupting a new utterance.
        if voice.listening && !voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
        guard let message = VoiceTurn.reply(in: keir.messages, jobID: expectedJob), message["id"].string != lastReply else {
            if let blocker = VoiceTurn.blocker(in: keir.tasks, jobID: expectedJob) {
                waiting = false; waitTask?.cancel(); error = blocker
            }
            return
        }
        lastReply = message["id"].string; reply = message["text"].string; waiting = message["voiceProgress"].bool; error = nil
        waitTask?.cancel()
        if waiting {
            // A handoff acknowledgement restarts the clock: the worker answer can take minutes.
            waitTask = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(300)) } catch { return }
                guard active, waiting else { return }
                waiting = false; error = "The answer is taking longer than expected. It will appear in the chat when it is ready."
            }
        }
        requestedRoute = message["provider"]["model"].string
        guard !paused, phase == .active, !fixture else { return }
        voice.speakReply(reply, session: session)
    }
}

private struct KeirVoiceOrb: View {
    let state: KeirPresence.State
    let level: Double
    @Environment(\.accessibilityReduceMotion) private var reduced
    var body: some View {
        ZStack {
            Circle().fill(RadialGradient(colors: [OpsTheme.sky.opacity(0.14), .clear], center: .center, startRadius: 15, endRadius: 95))
            if state == .listening {
                KeirAudioWaveform(level: level).scaleEffect(3)
            } else if state == .speaking {
                Image(systemName: "speaker.wave.2").font(.system(size: 68, weight: .light)).foregroundStyle(OpsTheme.sky)
                    .symbolEffect(.variableColor.iterative, options: .repeating, isActive: !reduced)
            } else {
                Image(systemName: state == .stopped ? "stop.circle" : "bubble.left.and.bubble.right")
                    .font(.system(size: 60, weight: .ultraLight)).foregroundStyle(OpsTheme.sky.opacity(0.7))
            }
        }.animation(reduced ? nil : .smooth(duration: 0.2), value: state)
    }
}
