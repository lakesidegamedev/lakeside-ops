import SwiftUI
import PDFKit
import LakesideCore

struct KeirView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @ObservedObject var keir: KeirStore
    @State private var draft = ""
    @StateObject private var attachments = ChatAttachments(keir: true)
    @StateObject private var voice = KeirVoice()
    @AppStorage("keir-spoken-replies") private var spokenReplies = false
    @State private var voiceDraft = ""
    @State private var voiceMode = false
    @State private var drafts: [String: String] = [:]
    @State private var appearedAt = Date()
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sheet: KeirSheet?
    @State private var presentingSheet = false
    @State private var sheetRequest: Task<Void, Never>?
    @State private var connectionAttempt = 0
    enum KeirSheet: String, Identifiable { case threads, ideas, watches, memory, computer, controls; var id: String { rawValue } }

    private var content: some View {
        VStack(spacing: 0) {
            runtimeStrip
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        DecisionAnswerReceipt()
                        if !ops.decisions.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                SectionLabel(text: "Needs you", count: ops.decisions.count)
                                ForEach(ops.decisions, id: \.["id"].string) { DecisionCard(decision: $0) }
                            }
                        }
                        if keir.messages.isEmpty && !keir.connected { connectionPlaceholder }
                        else if keir.messages.isEmpty && keir.thread == "main" { KeirEmpty { draft = $0; composing = true } }
                        if keir.messages.isEmpty && keir.thread == "watches" { Text("When a watch is met, Keir reports it here.").font(.callout).foregroundStyle(OpsTheme.muted).padding(.top, 24) }
                        ForEach(keir.messages, id: \.["id"].string) { KeirMessage(message: $0).transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)) }
                        ForEach(keir.tasks.filter { $0["computer"] != .null }, id: \.["id"].string) { task in
                            NavigationLink { KeirComputerScreen(taskId: task["id"].string) } label: {
                                Label("\(task["computer"]["title"].string.nonempty ?? "Keir's computer") · View or take control", systemImage: "desktopcomputer").font(.callout)
                            }
                        }
                        ForEach(keir.live.filter { $0["state"].string == "running" || !$0["live"].array.isEmpty }, id: \.["id"].string) { task in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(task["status"].string.nonempty ?? "Working on your request").font(.caption).foregroundStyle(OpsTheme.muted)
                                if !task["live"].array.isEmpty { KeirToolCalls(calls: task["live"].array) }
                            }.accessibilityIdentifier("keir-chat-working")
                        }
                        if keir.thread == "main", (keir.team["open"].number ?? 0) > 0 { KeirWorkingNow(team: keir.team) }
                        ForEach(keir.questions.filter { $0["state"].string == "pending" }, id: \.["id"].string) { KeirQuestions(panel: $0) }
                        Color.clear.frame(height: 1).id("end")
                    }.padding(.horizontal, 16).padding(.vertical, 16)
                        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: keir.messages.count)
                }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(.bottom)
                .onChange(of: keir.messages.count) { _, _ in withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: keir.live.count) { _, _ in withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("end", anchor: .bottom) } }
            }
            if draft.hasPrefix("/") { commands }

            if let error = voice.error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn).padding(.horizontal, 16) }
            if voice.listening { Text("Listening. Tap the microphone to finish, then send.").font(.caption).foregroundStyle(OpsTheme.sky).padding(.horizontal, 16).padding(.vertical, 4) }
            if voice.speaking {
                Button { voice.stopSpeaking() } label: { Label("Stop speaking", systemImage: "speaker.slash").font(.caption) }.padding(.vertical, 6)
            }
            if let error = keir.error, keir.connected || !keir.messages.isEmpty { Text(error).font(.caption).foregroundStyle(OpsTheme.warn).padding(.horizontal, 16).padding(.bottom, 4).lineLimit(2) }
            if keir.thread == "watches" {
                Button { sheet = .watches } label: { Label("Manage watches", systemImage: "binoculars").fontWeight(.semibold).frame(maxWidth: .infinity).padding(.vertical, 12) }
                    .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 16)).padding(.horizontal, 12).padding(.bottom, 8)
            } else { composer }
        }
    }

    private var navigationContent: some View {
        content
        .opsScreen()
        .navigationTitle("Keir").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button { presentFromMenu(.controls) } label: { Label("Controls, providers & voice", systemImage: "slider.horizontal.3") }
                    Toggle(isOn: $spokenReplies) { Label("Speak replies", systemImage: "speaker.wave.2") }
                    if session.profile["mode"].string != "standalone" {
                    Button { presentFromMenu(.computer) } label: { Label("Computer history", systemImage: "desktopcomputer") }
                    Button { presentFromMenu(.ideas) } label: { Label("Ideas", systemImage: "lightbulb") }
                    Button { presentFromMenu(.watches) } label: { Label("Watches", systemImage: "binoculars") }
                    }
                    Button { presentFromMenu(.memory) } label: { Label("Memory", systemImage: "brain") }
                } label: { Image(systemName: "line.3.horizontal") }.accessibilityLabel("Keir tools").accessibilityIdentifier("keir-tools").disabled(presentingSheet)
            }
            ToolbarItem(placement: .topBarTrailing) {
                if keir.controls["supported"].bool {
                    Button {
                        voice.stop()
                        Task { await keir.control(["action": .string(keir.stopped ? "start" : "stop")], session) }
                    } label: { Image(systemName: keir.stopped ? "play.fill" : "stop.fill") }
                        .tint(keir.stopped ? OpsTheme.mint : OpsTheme.ink)
                        .accessibilityLabel(keir.stopped ? "Start Keir" : "Stop Keir")
                        .disabled(keir.controlling).accessibilityIdentifier("keir-kill-switch")
                }
            }
            ToolbarItem(placement: .principal) {
                Button { sheet = .threads } label: { HStack(spacing: 6) {
                    Text(keir.threadTitle).font(.headline).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(OpsTheme.muted)
                }.fixedSize() }.buttonStyle(.plain).accessibilityIdentifier("keir-threads").disabled(presentingSheet)
            }
        }
    }

    private var lifecycleContent: some View {
        navigationContent
        .task(id: "\(scenePhase == .active)|\(keir.thread)|\(connectionAttempt)|\(voiceMode)") { if scenePhase == .active && !voiceMode { await keir.connect(session) } }
        .task { await keir.loadThreads(session) }
        .task(id: keir.thread) { await keir.loadModels(session); await keir.loadControls(session) }
        .onAppear { appearedAt = Date(); handleShortcut() }
        .onChange(of: router.openKeirControls) { _, _ in handleShortcut() }
        .onAppear { attachments.scope = keir.thread }
        .onChange(of: router.openKeirVoice) { _, _ in handleShortcut() }
        .onDisappear(perform: leaveConversation)
        .onChange(of: scenePhase) { _, phase in if phase != .active { voice.stop() } }
        .onChange(of: keir.thread) { old, next in drafts[old] = draft; voice.stop(); draft = drafts[next] ?? ""; attachments.scope = next; appearedAt = Date() }
    }

    var body: some View {
        lifecycleContent
        .sensoryFeedback(.selection, trigger: voice.listening)
        .sensoryFeedback(.warning, trigger: presence == .approval) { _, needed in needed }
        .onChange(of: keir.stopped) { _, stopped in if stopped { voice.stop() } }
        .onChange(of: spokenReplies) { _, enabled in if !enabled { voice.stopSpeaking() } }
        .onChange(of: voice.transcript) { _, text in
            draft = [voiceDraft, text].filter { !$0.isEmpty }.joined(separator: " ")
        }
        .onChange(of: keir.messages.count) { _, _ in
            guard spokenReplies, !voiceMode, !voice.listening, scenePhase == .active,
                  let message = keir.messages.last, message["role"].string == "keir",
                  (message["at"].number ?? 0) / 1000 > appearedAt.timeIntervalSince1970 else { return }
            voice.speakReply(message["text"].string, session: session)
        }
        .fullScreenCover(isPresented: $voiceMode) { KeirVoiceMode(keir: keir) }
        .onChange(of: sheet) { _, next in if next != nil { presentingSheet = true } }
        .sheet(item: $sheet, onDismiss: { presentingSheet = false }) { which in
            switch which {
            case .controls: KeirControls(keir: keir, voice: voice)
            case .threads: KeirThreads(keir: keir)
            case .computer: NavigationStack { KeirComputer().toolbar { Button("Done") { sheet = nil } } }
            case .ideas: NavigationStack { IdeasView().toolbar { Button("Done") { sheet = nil } } }
            case .watches: NavigationStack { WatchesView().toolbar { Button("Done") { sheet = nil } } }
            case .memory: NavigationStack { MemoryView().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { sheet = nil } } } }
            }
        }
    }

    private func leaveConversation() {
        voice.stop()
        sheetRequest?.cancel()
        if sheet == nil { presentingSheet = false }
    }

    private var runtimeStrip: some View {
        HStack(spacing: 12) {
            if presence != .ready {
                Button { router.tab = .activity } label: { KeirPresence(state: presence, level: voice.level) }.buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            if keir.yolo {
                Button { sheet = .controls } label: { Label("YOLO", systemImage: "bolt.fill").font(.caption.weight(.semibold)) }
                    .tint(OpsTheme.warn).accessibilityLabel("YOLO: supported actions only. Open approval settings")
                    .accessibilityIdentifier("keir-yolo-banner")
            }
        }.padding(.horizontal, 18).padding(.vertical, presence == .ready && !keir.yolo ? 0 : 8)
    }

    private func handleShortcut() {
        if router.openKeirControls { router.openKeirControls = false; sheet = .controls }
        if router.openKeirVoice { router.openKeirVoice = false; voice.stop(); voiceMode = true }
    }
    private var connectionPlaceholder: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(keir.error == nil ? "Connecting to Keir" : "Keir is unavailable").font(.title2.weight(.semibold)).accessibilityIdentifier("keir-connection-state")
            Text("Your draft is kept here. Your conversation will load when the connection returns.").font(.callout).foregroundStyle(OpsTheme.muted)
            if keir.error != nil {
                Button("Retry connection") { connectionAttempt += 1 }.font(.callout.weight(.semibold)).accessibilityIdentifier("keir-retry-connection")
            }
        }.padding(.vertical, 24)
    }

    private func presentFromMenu(_ target: KeirSheet) {
        sheetRequest?.cancel()
        presentingSheet = true
        sheetRequest = Task { @MainActor in
            // UIKit must finish dismissing the menu before presenting a sheet.
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard scenePhase == .active else { presentingSheet = false; return }
            sheet = target
        }
    }

    private var commands: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(KeirCommand.all.filter { (session.profile["mode"].string != "standalone" || !["/computer", "/ticket", "/chart"].contains($0.id)) && (draft == "/" || $0.id.hasPrefix(draft.lowercased())) }) { command in
                    Button {
                        if let prompt = command.prompt { draft = prompt; composing = true }
                        else {
                            draft = ""; composing = false
                            switch command.id {
                            case "/computer": sheet = .computer
                            case "/new": sheet = .threads
                            case "/model", "/approval", "/skills": sheet = .controls
                            case "/stop", "/start", "/status": let text = command.id; Task { _ = await keir.send(text, session) }
                            case "/tasks": OpsServices.shared.router.tab = .activity
                            default: break
                            }
                        }
                    } label: { HStack { Text(command.id).font(.callout.monospaced().weight(.semibold)); Text(command.detail).font(.caption).foregroundStyle(OpsTheme.muted); Spacer() }.padding(.horizontal, 18).padding(.vertical, 10).contentShape(Rectangle()) }.buttonStyle(.plain)
                        .accessibilityIdentifier("keir-command-\(command.id.dropFirst())")
                }
            }
        }.frame(maxHeight: 210).background(OpsTheme.surface).accessibilityIdentifier("keir-commands")
    }

    private var activityStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 16) {
                ForEach(keir.live, id: \.["id"].string) { task in
                    NavigationLink { TaskDetail(id: task["id"].string) } label: {
                        HStack(spacing: 6) {
                            Circle().fill(OpsState.color(task["state"].string)).frame(width: 6, height: 6)
                            Text(task["title"].string.nonempty ?? task["status"].string.nonempty ?? "Task").lineLimit(1)
                            Text(task["steering"].bool ? "Updating direction" : OpsState.word(task["state"].string)).foregroundStyle(OpsTheme.muted)
                        }.font(.caption).frame(maxWidth: 280)
                    }.buttonStyle(.plain)
                }
                ForEach(keir.backgroundTasks, id: \.["id"].string) { task in
                    Button { keir.select(task["thread"].string) } label: {
                        Label(task["title"].string, systemImage: "arrow.up.right").font(.caption).lineLimit(1).frame(maxWidth: 200)
                    }.buttonStyle(.plain).foregroundStyle(OpsTheme.muted)
                }
            }.padding(.horizontal, 16).padding(.vertical, 10)
        }.overlay(alignment: .top) { Hairline() }.accessibilityIdentifier("keir-activity-strip")
    }

    private var needsInput: Int { keir.tasks.filter { !$0["approvals"].array.isEmpty || $0["state"].string == "blocked" }.count + keir.questions.filter { $0["state"].string == "pending" }.count }
    private var presence: KeirPresence.State {
        if keir.stopped { return .stopped }
        if !keir.connected { return .offline }
        if voice.listening { return .listening }
        if voice.speaking { return .speaking }
        if voice.preparingSpeech { return .thinking }
        if needsInput > 0 { return .approval }
        if keir.sending { return .thinking }
        return keir.working ? .working : .ready
    }
    private var stopsInstead: Bool { keir.working && attachments.items.isEmpty && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    @ViewBuilder private var modelPicker: some View {
        if keir.controls["supported"].bool {
            Menu {
                ForEach(keir.controls["options"]["conversation"].array, id: \.["id"].string) { model in
                    Button { Task { await keir.control(["action": .string("configure"), "routes": .object(["conversation": .string(model["id"].string)])], session) } } label: {
                        Text("\(model["label"].string) · \(model["provider"].string)")
                    }.disabled(model["available"] == .bool(false))
                }
                Button { sheet = .controls } label: { Label("Voice and work models…", systemImage: "slider.horizontal.3") }
            } label: { Label(keir.conversationModelLabel, systemImage: "cpu").lineLimit(1) }
                .disabled(keir.controlling).accessibilityIdentifier("keir-model")
        } else {
            Menu {
                ForEach(keir.models, id: \.["id"].string) { model in
                    Button { Task { await keir.selectModel(model["id"].string, session) } } label: {
                        if model["id"].string == keir.modelSelection { Label("\(model["provider"].string) · \(model["label"].string)", systemImage: "checkmark") }
                        else { Text("\(model["provider"].string) · \(model["label"].string)") }
                    }
                }
            } label: { Label(keir.modelLabel, systemImage: "cpu").lineLimit(1) }
                .disabled(keir.models.isEmpty || keir.selectingModel).accessibilityIdentifier("keir-model")
        }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 12) {
            modelPicker
            Spacer(minLength: 4)
            if !keir.live.isEmpty || !keir.backgroundTasks.isEmpty {
                Button { router.tab = .activity } label: {
                    Label(needsInput > 0 ? "\(needsInput) need you" : "\(keir.live.count + keir.backgroundTasks.count) tasks", systemImage: needsInput > 0 ? "hand.raised" : "list.bullet")
                }.accessibilityIdentifier("keir-activity-strip")
            }
            Menu {
                Button("New task") { keir.sendMode = "new"; keir.steeringTask = nil }
                Button("Follow up") { keir.sendMode = "followup"; keir.steeringTask = nil }
                ForEach(keir.live, id: \.["id"].string) { task in
                    Button("Steer: \(task["title"].string)") { keir.sendMode = "steer"; keir.steeringTask = task["id"].string }
                }
            } label: { Image(systemName: "arrow.triangle.branch") }
                .accessibilityLabel("Message routing").accessibilityIdentifier("keir-send-mode")
        }.font(.caption).foregroundStyle(OpsTheme.muted).padding(.horizontal, 20).padding(.vertical, 6)
        AttachmentTray(attachments: attachments).padding(.horizontal, 16)
        HStack(alignment: .bottom, spacing: 10) {
            AttachmentPicker(attachments: attachments, compact: true)
            Button {
                voice.stop(); composing = false; voiceMode = true
            } label: {
                Image(systemName: "waveform").foregroundStyle(OpsTheme.sky).frame(width: 28, height: 34)
            }.accessibilityLabel("Start voice conversation").accessibilityIdentifier("keir-microphone")
            TextField("Message Keir", text: $draft, axis: .vertical).lineLimit(1...6).focused($composing)
                .accessibilityIdentifier("keir-composer").padding(.vertical, 8)
            Button {
                if stopsInstead { OpsServices.shared.router.tab = .activity; return }
                voice.stopListening()
                composing = false
                let text = draft, files = attachments.payload, selected = keir.thread
                Task {
                    if await keir.send(text, session, attachments: files) {
                        attachments.sent(files, in: selected)
                        if keir.thread == selected && draft == text { draft = "" }
                        else if drafts[selected] == text { drafts[selected] = "" }
                    }
                }
            } label: {
                Image(systemName: stopsInstead ? "list.bullet" : "arrow.up").font(.body.weight(.semibold)).frame(width: 34, height: 34)
                    .background(stopsInstead ? OpsTheme.raised : OpsTheme.sky, in: Circle()).foregroundStyle(stopsInstead ? OpsTheme.ink : OpsTheme.onAccent)
                    .contentTransition(.symbolEffect(.replace))
            }
            .disabled(keir.stopped || attachments.uploading || (!stopsInstead && (keir.sending || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.items.isEmpty))))
            .accessibilityLabel(stopsInstead ? "View ongoing work" : "Send to Keir").accessibilityIdentifier("keir-send")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(OpsTheme.hairline))
        .padding(.horizontal, 12).padding(.bottom, 8)
        }
    }
}

private struct KeirEmpty: View {
    let pick: (String) -> Void
    private let prompts = ["What needs my attention right now?", "How did the last turn go?", "Which PRs are waiting on me?", "Promote development to production"]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Keir").font(.system(size: 34, weight: .bold, design: .rounded)).tracking(-1)
            Text("Owner channel. Anything you ask here carries your authority, the same as a DM.").font(.callout).foregroundStyle(OpsTheme.muted)
            VStack(spacing: 0) {
                ForEach(prompts, id: \.self) { prompt in
                    Button { pick(prompt) } label: {
                        HStack { Text(prompt).font(.callout); Spacer(); Image(systemName: "arrow.up.left").font(.caption) }.padding(.vertical, 12)
                    }.buttonStyle(.plain)
                    Hairline()
                }
            }
        }.padding(.top, 24)
    }
}

private struct KeirMessage: View {
    @EnvironmentObject private var session: AppSession
    let message: JSONValue
    private var owner: Bool { message["role"].string == "owner" }
    var body: some View {
        if message["update"].bool && !message["items"].array.isEmpty { KeirUpdateMessage(message: message) }
        else if owner {
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .leading, spacing: 8) {
                    if !message["text"].string.isEmpty { Text(message["text"].string).textSelection(.enabled) }
                    ForEach(message["attachments"].array, id: \.["id"].string) { KeirAttachment(attachment: $0) }
                }.padding(.horizontal, 14).padding(.vertical, 10)
                    .background(OpsTheme.sky.opacity(0.16), in: RoundedRectangle(cornerRadius: 18))
            }.accessibilityLabel("You: \(message["text"].string)")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text("Keir").font(.caption.weight(.semibold))
                    Text(OpsFormat.ago(message["at"])).font(.caption).foregroundStyle(OpsTheme.muted)
                }
                if !message["activity"].array.isEmpty { KeirToolCalls(calls: message["activity"].array) }
                NativeMarkdown(text: message["text"].string).textSelection(.enabled)
                if !message["chart"].string.isEmpty { KeirChart(name: message["chart"].string) }
                if !message["cards"].array.isEmpty { KeirCards(cards: message["cards"].array) }
                if message["computer"] != .null, !message["jobId"].string.isEmpty {
                    NavigationLink { KeirComputerScreen(taskId: message["jobId"].string) } label: { Label("Open computer result", systemImage: "desktopcomputer") }
                }
            }
            .contextMenu {
                Button { UIPasteboard.general.string = message["text"].string } label: { Label("Copy", systemImage: "doc.on.doc") }
                ShareLink(item: message["text"].string)
            }
        }
    }
}

private struct KeirChart: View {
    @EnvironmentObject private var session: AppSession
    let name: String
    @State private var image: UIImage?
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12)) }
            else { RoundedRectangle(cornerRadius: 12).fill(OpsTheme.surface).frame(height: 180).overlay(ProgressView()) }
        }
        .task(id: name) {
            if let data = try? await session.data("/api/keir/app/artifacts/\(name)") { image = UIImage(data: data) }
        }.accessibilityLabel("Chart from Keir")
    }
}

/// An open question from Keir. Approve is the primary action; reject and
/// explain stay one tap away.
struct DecisionCard: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    let decision: JSONValue
    var changed: () async -> Void = {}
    @State private var outcome: String?
    @State private var actionError: String?
    @State private var explaining = false
    @State private var note = ""
    @State private var busy = false
    var body: some View {
        Group {
        if let outcome {
            VStack(alignment: .leading, spacing: 8) {
                Label(outcome, systemImage: "checkmark.circle").font(.callout).foregroundStyle(OpsTheme.muted)
                if !decision["jobId"].string.isEmpty { Button("View progress and remaining blockers") { router.openDecisionTask(decision) } }
            }
        }
        else {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                StateWord(text: decision["signoff"].bool ? "Sign-off" : "Decision", color: OpsTheme.warn)
                if let n = decision["ticket"].number { Text("Ticket \(Int(n))").font(.caption).foregroundStyle(OpsTheme.muted) }
                Spacer()
                Text(OpsFormat.ago(decision["at"])).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            if !decision["tldr"].string.isEmpty { Text(decision["tldr"].string).font(.callout.weight(.semibold)) }
            Text(decision["question"].string).font(.callout).foregroundStyle(decision["tldr"].string.isEmpty ? OpsTheme.ink : OpsTheme.muted).lineLimit(8)
            if decision["question"].string.count > 300 || decision["scope"] != .null {
                DisclosureGroup("Review full action and scope") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(decision["question"].string).fixedSize(horizontal: false, vertical: true)
                        if !decision["kind"].string.isEmpty { LabeledContent("Action", value: decision["kind"].string) }
                        if decision["args"] != .null { Text(decision["args"].pretty).font(.caption.monospaced()) }
                        if decision["scope"] != .null { Text(decision["scope"].pretty).font(.caption.monospaced()).accessibilityIdentifier("decision-scope") }
                        if !decision["digest"].string.isEmpty { LabeledContent("Proposal", value: String(decision["digest"].string.prefix(12))) }
                        if let expires = OpsFormat.date(decision["expiresAt"]) { Text("Expires \(expires.formatted())").font(.caption) }
                    }.font(.callout).textSelection(.enabled)
                }
            }
            if !decision["reason"].string.isEmpty { Text(decision["reason"].string).font(.caption).foregroundStyle(OpsTheme.warn) }
            if let actionError { Text(actionError).font(.caption).foregroundStyle(OpsTheme.warn) }
            HStack(spacing: 10) {
                Button { act("approve") } label: { Text("Approve").fontWeight(.semibold).frame(maxWidth: .infinity).padding(.vertical, 9) }
                    .background(OpsTheme.sky, in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(OpsTheme.onAccent)
                    .disabled(decision["canApprove"] == .bool(false)).accessibilityIdentifier("decision-approve")
                Button { act("reject") } label: { Text("Reject").frame(maxWidth: .infinity).padding(.vertical, 9) }
                    .background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 10))
                Button { explaining = true } label: { Image(systemName: "text.bubble").padding(.vertical, 9).padding(.horizontal, 12) }
                    .background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 10)).accessibilityLabel("Reply or ask why")
            }.buttonStyle(.plain).disabled(busy || decision["canAnswer"] == .bool(false))
            if decision["canRefresh"].bool { Button("Request a fresh proposal") { act("refresh") }.disabled(busy) }
            if decision["canAnswer"] == .bool(false) {
                OwnerDirectionButton(title: "Ask Keir to recover this work", context: "Decision \(decision["id"].string) for task \(decision["jobId"].string): \(decision["question"].string)")
            }
            if !decision["jobId"].string.isEmpty { Button("Open task and result") { router.openDecisionTask(decision) } }
        }
        .padding(14)
        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1).fill(OpsTheme.warn).frame(width: 2).padding(.vertical, 14) }
        }
        }
        .buttonStyle(.plain)
        .alert("Reply to Keir", isPresented: $explaining) {
            TextField("What should Keir explain or change?", text: $note)
            Button("Send") { act("explain", note) }
            Button("Cancel", role: .cancel) {}
        }
    }
    private func act(_ verdict: String, _ text: String = "") {
        busy = true
        Task {
            if await ops.answer(decision["id"].string, verdict: verdict, text: text, session) {
                outcome = verdict == "approve" ? "Approval saved. Keir will report the execution result." : verdict == "reject" ? "Rejection saved" : verdict == "refresh" ? "Fresh review requested. No action was approved." : "Reply sent"
                await changed()
            } else { actionError = ops.error ?? "The decision could not be saved. Refresh and try again." }
            busy = false
        }
    }
}

private struct KeirAttachment: View {
    @EnvironmentObject private var session: AppSession
    let attachment: JSONValue
    @State private var bytes: Data?
    @State private var error: String?
    @State private var loading = false
    @State private var opened = false
    var body: some View {
        Button {
            opened = true
        } label: {
            HStack(spacing: 8) {
                if let bytes, let image = UIImage(data: bytes) {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 220, maxHeight: 180).clipShape(RoundedRectangle(cornerRadius: 10))
                } else { Image(systemName: attachment["type"].string.hasPrefix("image/") ? "photo" : "doc") }
                Text(attachment["name"].string).font(.caption).lineLimit(2)
            }
        }.buttonStyle(.plain).accessibilityLabel("Open attachment \(attachment["name"].string)")
        .task(id: attachment["id"].string) {
            guard attachment["type"].string.hasPrefix("image/") else { return }
            await load()
        }
        .sheet(isPresented: $opened) {
            NavigationStack {
                Group {
                    if let bytes {
                        if let image = UIImage(data: bytes) { Image(uiImage: image).resizable().scaledToFit().padding() }
                        else if attachment["type"].string == "application/pdf" { KeirPDF(data: bytes) }
                        else { ScrollView { Text(String(decoding: bytes.prefix(200000), as: UTF8.self)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() } }
                    } else if let error { ContentUnavailableView("Attachment unavailable", systemImage: "doc.badge.ellipsis", description: Text(error)) }
                    else { ProgressView("Loading attachment") }
                }.navigationTitle(attachment["name"].string).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { opened = false } } }
                    .task { await load() }
            }
        }
    }
    private func load() async {
        guard bytes == nil, !loading else { return }
        let url = attachment["url"].string
        guard url.hasPrefix("/api/keir/app/uploads/"), !url.contains("..") else { error = "Invalid private attachment reference"; return }
        loading = true; defer { loading = false }
        do { bytes = try await session.data(url, accept: attachment["type"].string, limit: 10 * 1024 * 1024); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

private struct KeirPDF: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.document = PDFDocument(data: data); return view }
    func updateUIView(_ view: PDFView, context: Context) { if view.document == nil { view.document = PDFDocument(data: data) } }
}
