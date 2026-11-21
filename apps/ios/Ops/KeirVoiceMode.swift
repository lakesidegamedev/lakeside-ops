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
    /// Identity of a spoken reply: the message id plus the revision that produced
    /// its current text, so an edited answer is spoken once more.
    private func replyStamp(_ message: JSONValue) -> String? {
        let id = message["id"].string
        guard !id.isEmpty else { return nil }
        return "\(id)@\(Int(message["editedAt"].number ?? 0))#\(Int(message["rev"].number ?? 0))"
    }
    /// The model the server reported for the reply being spoken.
    @State private var replyModel = ""
    /// Sentences already spoken in this turn, so a provisional answer revised in
    /// place is not read out twice.
    @State private var spoken: Set<String> = []
    @State private var since = Date()
    @State private var error: String?
    @State private var active = false
    @State private var listenTask: Task<Void, Never>?
    @State private var expectedJob: String?
    @State private var sendTask: Task<Void, Never>?
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
    /// UI tests pin the screen to one state so every capture is stable.
    private var preview: String? {
#if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard fixture, let index = args.firstIndex(of: "--uitest-voice-state"), index + 1 < args.count else { return nil }
        return args[index + 1]
#else
        return nil
#endif
    }
    private var preparing: Bool { preview.map { $0 == "preparing" } ?? voice.preparingSpeech }
    private var state: KeirPresence.State {
        switch preview ?? "" {
        case "listening": return .listening
        case "thinking", "preparing": return .thinking
        case "speaking", "fallback": return .speaking
        case "stopped": return .stopped
        default: break
        }
        if keir.stopped { return .stopped }
        if !keir.connected { return .offline }
        if voice.listening { return .listening }
        if voice.speaking { return .speaking }
        return waiting || voice.preparingSpeech ? .thinking : .ready
    }
    private var status: String {
        if paused && preview == nil { return "Microphone paused" }
        if preparing { return "Preparing voice" }
        switch state {
        case .listening: return "I'm listening"
        case .speaking: return "Keir is speaking"
        case .thinking: return "Thinking"
        case .stopped: return "Keir is stopped"
        case .offline: return "Reconnecting"
        default: return "Ready to talk"
        }
    }
    /// Which model is answering, only as the server reports it: the reply being
    /// produced or spoken, else the owner's choice, else the server's default.
    private var routeLabel: String {
        let options = keir.controls["options"]["voice"].array
        let name = { (id: String) in KeirProviderName.label(id, options: options) }
        let busy = voice.speaking || preparing || waiting
        if busy, let expectedJob,
           let task = keir.tasks.first(where: { $0["id"].string == expectedJob && $0["state"].string == "running" }),
           !task["provider"]["model"].string.isEmpty {
            return "This reply · " + name(task["provider"]["model"].string)
        }
        if busy, !replyModel.isEmpty { return "This reply · " + name(replyModel) }
        let selected = keir.controls["routes"]["voice"].string
        if !selected.isEmpty && selected != "auto" { return name(selected) }
        let fallback = keir.controls["defaults"]["voice"].string
        return fallback.isEmpty ? "Auto" : "Auto · " + name(fallback)
    }
    /// Which voice is really speaking. After a mid-reply hand-over the rest of
    /// the answer is in the device voice, and the line says so.
    private var voiceLine: String {
        if preview == "fallback" || (voice.usingDeviceFallback && voice.fallbackPartial) { return "Apple · fallback voice for the rest" }
        if voice.usingDeviceFallback { return "Apple · fallback voice" }
        return UserDefaults.standard.string(forKey: "keir-speech-provider") == "apple" ? "Apple · device voice" : "Microsoft Ava · online voice"
    }
    private var automaticLabel: String {
        let fallback = keir.controls["defaults"]["voice"].string
        return fallback.isEmpty ? "Automatic" : "Automatic · " + KeirProviderName.label(fallback, options: keir.controls["options"]["voice"].array)
    }
    private var screen: some View {
        VStack(spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Keir voice").font(.headline)
                    Text(voiceLine).font(.caption).foregroundStyle(OpsTheme.muted)
                    Menu {
                        ForEach(keir.controls["options"]["voice"].array, id: \.["id"].string) { model in
                            Button { Task { await keir.control(["action": .string("configure"), "routes": .object(["voice": .string(model["id"].string)])], session) } } label: {
                                Text(model["id"].string == "auto" ? automaticLabel : "\(model["label"].string) · \(model["provider"].string)")
                            }.disabled(model["available"] == .bool(false))
                        }
                    } label: { Label(routeLabel, systemImage: "cpu").font(.caption) }
                        .disabled(keir.controlling).accessibilityIdentifier("keir-voice-model")
                }
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44).background(OpsTheme.surface, in: Circle()) }.accessibilityLabel("End voice conversation")
            }
            Spacer(minLength: 12)
            KeirVoicePortrait(state: state, micLevel: voice.level, meter: voice.meter,
                              previewLevel: preview == nil ? nil : ((state == .speaking || state == .listening) ? 0.6 : 0.0))
                .accessibilityHidden(true)
            if state == .thinking {
                HStack(spacing: 12) {
                    OpsSpinner(size: 26)
                    OpsShimmerText(text: status)
                }
                .font(.largeTitle.weight(.semibold))
                .accessibilityElement(children: .ignore).accessibilityLabel(status)
            } else { Text(status).font(.largeTitle.weight(.semibold)).contentTransition(.opacity) }
            ScrollView {
                VStack(spacing: 18) {
                    if !voice.transcript.isEmpty { Text(voice.transcript).font(.title3).foregroundStyle(OpsTheme.muted) }
                    if !reply.isEmpty { Text(reply).font(.title3).textSelection(.enabled) }
                }.frame(maxWidth: .infinity)
            }.frame(maxHeight: 200)
            if let message = error ?? voice.error ?? (!keir.connected ? keir.error : nil) {
                Text(message).font(.callout).foregroundStyle(OpsTheme.warn)
                Button("Try voice again") { waiting = false; waitTask?.cancel(); paused = false; error = nil; if !keir.connected { connectionAttempt += 1 }; listen() }
                if let expectedJob { Button("Open voice task") { router.openTask(expectedJob); dismiss() } }
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
                waiting = false; expectedJob = nil; waitTask?.cancel(); sendTask?.cancel(); error = nil; voice.stop(); paused = false; listen()
            } label: { Image(systemName: "waveform").font(.title).frame(width: 76, height: 76).background(OpsTheme.sky.opacity(0.18), in: Circle()) }
                .accessibilityLabel("Interrupt and speak").disabled(keir.stopped || !keir.connected)
            Button { voice.stop(); dismiss() } label: { Image(systemName: "phone.down.fill").frame(width: 58, height: 58).background(OpsTheme.warn.opacity(0.15), in: Circle()) }.tint(OpsTheme.warn).accessibilityLabel("End voice mode")
        }
    }
    var body: some View {
        screen
            .task(id: "\(phase)|\(connectionAttempt)") { if phase == .active { await keir.connect(session) } }
            .task {
                active = true; since = Date(); if !fixture { listen() }
#if DEBUG
                if let preview {
                    if preview != "stopped" { voice.transcript = "How did the payroll fix go on turn 81?" }
                    if ["preparing", "speaking", "fallback"].contains(preview) {
                        reply = "The payroll fix held on turn 81. Every province paid its workers in full, and the budget screen now matches the treasury. I will keep an eye on turn 82."
                    }
                    if ["preparing", "speaking", "fallback"].contains(preview) { replyModel = "codex:fixture" }
                    if preview == "thinking" { waiting = true }
                    return
                }
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
            .onDisappear { active = false; listenTask?.cancel(); sendTask?.cancel(); waitTask?.cancel(); voice.stop() }
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
    private func submit() {
        let text = voice.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard active, !text.isEmpty, !waiting, !paused, phase == .active else { return }
        waiting = true; expectedJob = nil; error = nil; reply = ""; replyModel = ""; spoken = []
        sendTask = Task {
            let sent = await keir.send(text, session, voice: true)
            guard !Task.isCancelled else { return }
            expectedJob = keir.lastSentJob
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
        guard let message = VoiceTurn.reply(in: keir.messages, jobID: expectedJob),
              let stamp = replyStamp(message), stamp != lastReply else {
            if let blocker = VoiceTurn.blocker(in: keir.tasks, jobID: expectedJob) {
                waiting = false; waitTask?.cancel(); error = blocker
            }
            return
        }
        // A provisional answer is spoken now; when the revised findings edit the
        // same message (a new stamp), only their new sentences are spoken.
        lastReply = stamp; reply = message["text"].string
        waiting = message["voiceProgress"].bool || message["provisional"].bool; error = nil
        waitTask?.cancel()
        if waiting {
            // A handoff acknowledgement restarts the clock: the worker answer can take minutes.
            waitTask = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(300)) } catch { return }
                guard active, waiting else { return }
                waiting = false; error = "The answer is taking longer than expected. It will appear in the chat when it is ready."
            }
        }
        replyModel = message["provider"]["model"].string
        guard !paused, phase == .active, !fixture else { return }
        // Replies arrive whole, per revision. When a provisional answer is
        // revised, only the sentences not yet spoken are read.
        let fresh = VoiceSegments.unspoken(KeirVoice.spokenText(reply), spoken: spoken)
        guard !fresh.isEmpty else { if !waiting { listen() }; return }
        spoken.formUnion(VoiceSegments.keys(fresh))
        voice.speakReply(fresh, session: session)
    }
}

/// Keir himself on the voice screen, one character for every state. Speaking
/// uses the pack's talking frames chosen by the loudness of what is playing, so
/// his mouth moves with the sound and rests in the gaps; a ring and a one-pixel
/// bob follow the same level. Listening rings follow the microphone. The 80
/// pixel art is drawn at 2 points per pixel, whole device pixels on every
/// iPhone, with no smoothing. Reduce Motion and UI tests get one still frame
/// per state.
struct KeirVoicePortrait: View {
    let state: KeirPresence.State
    let micLevel: Double
    @ObservedObject var meter: KeirVoiceMeter
    var previewLevel: Double?
    @Environment(\.accessibilityReduceMotion) private var reduced

    static let side: CGFloat = 160
    static let stage: CGFloat = 232

    private var still: Bool { reduced || OpsMotion.frozen || previewLevel != nil }
    private var spriteState: String {
        switch state {
        case .speaking: return "talking"
        case .listening: return "listening"
        case .thinking, .working: return "thinking"
        case .stopped: return "sleeping"
        case .offline: return "concerned"
        default: return "idle"
        }
    }
    private var level: Double {
        if let previewLevel { return previewLevel }
        if state == .speaking { return meter.level }
        if state == .listening { return min(1, max(0, micLevel)) }
        return 0
    }
    /// Frames 5 and 2 of the talking row have the mouth closed, 0 and 3 half
    /// open, 1 and 4 wide open.
    private var mouthFrame: Int {
        let alternate = (meter.tick / 2) % 2 == 0
        if level < 0.12 { return 5 }
        if level < 0.45 { return alternate ? 0 : 3 }
        return alternate ? 1 : 4
    }
    private var stillFrame: Int {
        switch spriteState {
        case "talking": return reduced ? 0 : 1
        case "thinking": return 3
        case "sleeping": return 3
        case "concerned": return 1
        default: return 0
        }
    }

    var body: some View {
        let live = state == .speaking || state == .listening
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [OpsTheme.sky.opacity(0.14 + 0.12 * level), .clear], center: .center, startRadius: 24, endRadius: Self.stage / 2))
            if live && !reduced {
                Circle().stroke(OpsTheme.sky.opacity(0.10 + 0.35 * level), lineWidth: 2)
                    .frame(width: Self.side + 18, height: Self.side + 18)
                    .scaleEffect(1 + 0.12 * level)
                Circle().stroke(OpsTheme.sky.opacity(0.22 * level), lineWidth: 1.5)
                    .frame(width: Self.side + 18, height: Self.side + 18)
                    .scaleEffect(1 + 0.26 * level)
            }
            sprite
                .frame(width: Self.side, height: Self.side)
                .offset(y: state == .speaking && !reduced && level >= 0.45 ? -2 : 0)
        }
        .frame(width: Self.stage, height: Self.stage)
        .animation(still ? nil : .linear(duration: 0.08), value: level)
    }

    @ViewBuilder private var sprite: some View {
        if still {
            KeirSpriteStill(state: spriteState, size: .large, index: stillFrame)
        } else if state == .speaking {
            KeirSpriteStill(state: "talking", size: .large, index: mouthFrame)
        } else {
            KeirSprite(state: spriteState, size: .large)
        }
    }
}
