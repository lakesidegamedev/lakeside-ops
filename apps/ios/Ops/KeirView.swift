import SwiftUI
import PDFKit
import LakesideCore

/// The chat. Keir sits at the top, the timeline is the screen, and one pill
/// composer sits at the bottom above the dock. Work, decisions and questions
/// appear inline as objects only when they exist. Settings, stop, model,
/// routing, conversations and the desk are behind the two menus (Keir's menu
/// at the top left and "+" in the composer), so the screen itself stays quiet.
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
    @State private var confirmingYoloOff = false
    @State private var attachPhotos = false
    @State private var attachFiles = false
    enum KeirSheet: String, Identifiable { case threads, ideas, watches, memory, computer, controls, desk; var id: String { rawValue } }

    private var standalone: Bool { session.profile["mode"].string == "standalone" }

    // MARK: Timeline

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if keir.messages.isEmpty && !keir.connected { connectionPlaceholder }
                    else if keir.messages.isEmpty && keir.thread == "main" {
                        KeirStart(ticket: waitingTickets.first, draftEmpty: draftIsEmpty,
                                  speak: { voice.stop(); composing = false; voiceMode = true },
                                  suggest: suggestFollowUp)
                    }
                    DecisionAnswerReceipt()
                    if keir.messages.isEmpty && keir.thread == "watches" {
                        Text("When a watch is met, Keir reports it here.").font(.callout).foregroundStyle(OpsTheme.muted)
                            .frame(maxWidth: .infinity).padding(.top, 48)
                    }
                    ForEach(timelineRows) { row in
                        if let mark = row.mark { KeirTimeMark(date: mark) }
                        KeirMessage(message: row.message)
                            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                    }
                    ForEach(threadDecisions, id: \.["id"].string) { DecisionCard(decision: $0) }
                    ForEach(keir.questions.filter { $0["state"].string == "pending" }, id: \.["id"].string) {
                        KeirQuestions(panel: $0).keirObjectCard()
                    }
                    if keir.thread == "main", !keir.messages.isEmpty, (keir.team["open"].number ?? 0) > 0 {
                        KeirWorkingNow(team: keir.team)
                    }
                    ForEach(keir.tasks.filter { $0["computer"] != .null }, id: \.["id"].string) { task in
                        NavigationLink { KeirComputerScreen(taskId: task["id"].string) } label: {
                            KeirObjectRow(icon: "desktopcomputer", title: task["computer"]["title"].string.nonempty ?? "Keir's computer", detail: "View or take control")
                        }.buttonStyle(.plain)
                    }
                    ForEach(keir.live.filter { $0["state"].string == "running" || !$0["live"].array.isEmpty }, id: \.["id"].string) { task in
                        KeirLiveWorkCard(task: task).accessibilityIdentifier("keir-chat-working")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 12)
                .frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
                .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: keir.messages.count)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: keir.messages.count) { _, _ in withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: keir.live.count) { _, _ in guard !keir.messages.isEmpty else { return }; withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("end", anchor: .bottom) } }
        }
    }

    /// Messages with the time line, if any, that goes above each one.
    private struct TimelineRow: Identifiable {
        let id: String
        let message: JSONValue
        let mark: Date?
    }
    private var timelineRows: [TimelineRow] {
        var previous: JSONValue?
        return keir.messages.map { message in
            defer { previous = message }
            let mark = KeirTimeMark.shows(message, after: previous) ? KeirTimeMark.timestamp(message) : nil
            return TimelineRow(id: message["id"].string, message: message, mark: mark)
        }
    }

    // MARK: Chrome

    private var header: some View {
        KeirHeader(title: keir.threadTitle, presence: headerPresence, level: voice.level, sprite: sprite,
                   attention: AttentionCenter.shared.count, workCount: keir.live.count + keir.backgroundTasks.count,
                   yolo: keir.yolo, disabled: presentingSheet,
                   openThreads: { sheet = .threads },
                   openInbox: { router.activityFilter = "all"; router.tab = .activity },
                   startVoice: { voice.stop(); composing = false; voiceMode = true },
                   reviewAutonomy: { confirmingYoloOff = true }) {
            toolsMenu
        }
    }

    /// Keir's menu: places and app-wide controls. Message-level choices (model,
    /// routing, attachments, ticket drafts) are in the composer's "+" instead.
    @ViewBuilder private var toolsMenu: some View {
        Section {
            Button { presentFromMenu(.threads) } label: { Label("Conversations", systemImage: "bubble.left.and.bubble.right") }
        }
        Section {
            Button { presentFromMenu(.controls) } label: { Label("Controls, providers & voice", systemImage: "slider.horizontal.3") }
            Toggle(isOn: $spokenReplies) { Label("Speak replies", systemImage: "speaker.wave.2") }
            if !standalone {
                Button { presentFromMenu(.computer) } label: { Label("Computer history", systemImage: "desktopcomputer") }
                Button { presentFromMenu(.desk) } label: { Label("Support desk", systemImage: "lifepreserver") }
            }
            Button { afterMenu { router.showSettings = true } } label: { Label("Settings", systemImage: "gearshape") }
        }
        if keir.controls["supported"].bool {
            Section {
                Button(role: keir.stopped ? nil : .destructive) {
                    voice.stop()
                    Task { await keir.control(["action": .string(keir.stopped ? "start" : "stop")], session) }
                } label: {
                    Label(keir.stopped ? "Start Keir" : "Stop Keir", systemImage: keir.stopped ? "play.circle" : "stop.circle")
                }
                .disabled(keir.controlling)
            }
        }
    }

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            if draft.hasPrefix("/") { commands }
            if let error = voice.error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn).padding(.horizontal, 20) }
            if voice.listening {
                Text("Listening. Tap stop when you are done, then send.").font(.caption).foregroundStyle(OpsTheme.muted)
                    .padding(.horizontal, 20)
            }
            if voice.speaking {
                Button { voice.stopSpeaking() } label: { Label("Stop speaking", systemImage: "speaker.slash").font(.caption.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(OpsTheme.sky).padding(.horizontal, 20)
            }
            if let error = keir.error, keir.connected || !keir.messages.isEmpty {
                Text(error).font(.caption).foregroundStyle(OpsTheme.warn).padding(.horizontal, 20).lineLimit(2)
            }
            AttachmentTray(attachments: attachments).padding(.horizontal, 16)
            if keir.sendMode != "new" { routeChip }
            if keir.thread == "watches" {
                Button { sheet = .watches } label: {
                    Label("Manage watches", systemImage: "binoculars").font(.callout.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(KeirChatTheme.pill, in: Capsule())
                        .overlay(Capsule().strokeBorder(KeirChatTheme.stroke))
                }.buttonStyle(.plain).padding(.horizontal, 12)
            } else {
                KeirComposerPill { plusMenu } field: {
                    TextField("Message Keir", text: $draft, axis: .vertical).lineLimit(1...6).focused($composing)
                        .accessibilityIdentifier("keir-composer")
                } trailing: { trailingControl }
                .padding(.horizontal, 12)
            }
        }
        .padding(.top, 6).padding(.bottom, 8)
        .frame(maxWidth: 760).frame(maxWidth: .infinity)
        .background {
            LinearGradient(stops: [.init(color: KeirChatTheme.canvas.opacity(0), location: 0), .init(color: KeirChatTheme.canvas, location: 0.3)],
                           startPoint: .top, endPoint: .bottom)
        }
    }

    /// How the next message is routed, shown only when it is not the default.
    private var routeChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch").accessibilityHidden(true)
            Text(routeLabel).lineLimit(1)
            Spacer(minLength: 4)
            Button { keir.sendMode = "new"; keir.steeringTask = nil } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain).foregroundStyle(OpsTheme.muted)
                .accessibilityLabel("Send as a new task instead")
        }
        .font(.caption.weight(.medium)).foregroundStyle(OpsTheme.ink)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(KeirChatTheme.chrome, in: Capsule())
        .overlay(Capsule().strokeBorder(KeirChatTheme.stroke))
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keir-route-chip")
    }

    private var routeLabel: String {
        switch keir.sendMode {
        case "followup": return "Follow up on the current work"
        case "steer":
            let title = keir.live.first { $0["id"].string == keir.steeringTask }?["title"].string ?? ""
            return title.isEmpty ? "Steer the running task" : "Steer: \(title)"
        default: return "New task"
        }
    }

    // MARK: Composer

    /// Everything that shapes the next message: attach, draft a ticket
    /// follow-up, choose how it is routed and which model answers.
    private var plusMenu: some View {
        Menu {
            Section {
                Button { afterMenu { attachPhotos = true } } label: { Label("Photo library", systemImage: "photo.on.rectangle") }
                Button { afterMenu { attachFiles = true } } label: { Label("Choose file", systemImage: "doc") }
            }
            .disabled(attachments.uploading || attachments.items.count >= 6)
            KeirTicketMenu(tickets: waitingTickets, draftEmpty: draftIsEmpty, suggest: suggestFollowUp)
            Section {
                Menu {
                    routeButton("New task", mode: "new")
                    routeButton("Follow up on the current work", mode: "followup")
                    ForEach(keir.live, id: \.["id"].string) { task in
                        Button { keir.sendMode = "steer"; keir.steeringTask = task["id"].string } label: {
                            if keir.sendMode == "steer" && keir.steeringTask == task["id"].string { Label("Steer: \(task["title"].string)", systemImage: "checkmark") }
                            else { Text("Steer: \(task["title"].string)") }
                        }
                    }
                } label: { Label("Send as: \(routeLabel)", systemImage: "arrow.triangle.branch") }
                    .accessibilityIdentifier("keir-send-mode")
                modelMenu
            }
        } label: { KeirComposerIcon(system: "plus") }
            .accessibilityLabel("Add to your message")
            .accessibilityHint("Attach a photo or file, draft a ticket follow-up, or choose routing and model")
            .accessibilityIdentifier("add-attachment")
            .attachmentSources(attachments, photos: $attachPhotos, files: $attachFiles)
    }

    @ViewBuilder private func routeButton(_ title: String, mode: String) -> some View {
        Button { keir.sendMode = mode; keir.steeringTask = nil } label: {
            if keir.sendMode == mode { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }

    @ViewBuilder private var modelMenu: some View {
        if keir.controls["supported"].bool {
            Menu {
                ForEach(keir.controls["options"]["conversation"].array, id: \.["id"].string) { model in
                    Button { Task { await keir.control(["action": .string("configure"), "routes": .object(["conversation": .string(model["id"].string)])], session) } } label: {
                        Text("\(model["label"].string) · \(model["provider"].string)")
                    }.disabled(model["available"] == .bool(false))
                }
                Button { presentFromMenu(.controls) } label: { Label("Voice and work models…", systemImage: "slider.horizontal.3") }
            } label: { Label("Model: \(keir.conversationModelLabel)", systemImage: "cpu") }
                .disabled(keir.controlling).accessibilityIdentifier("keir-model")
        } else {
            Menu {
                ForEach(keir.models, id: \.["id"].string) { model in
                    Button { Task { await keir.selectModel(model["id"].string, session) } } label: {
                        if model["id"].string == keir.modelSelection { Label("\(model["provider"].string) · \(model["label"].string)", systemImage: "checkmark") }
                        else { Text("\(model["provider"].string) · \(model["label"].string)") }
                    }
                }
            } label: { Label("Model: \(keir.modelLabel)", systemImage: "cpu") }
                .disabled(keir.models.isEmpty || keir.selectingModel).accessibilityIdentifier("keir-model")
        }
    }

    /// Microphone while empty (dictation into the box), send once there is
    /// something to send, and stop while dictating.
    @ViewBuilder private var trailingControl: some View {
        if voice.listening {
            Button { voice.stopListening() } label: { KeirComposerIcon(system: "stop.circle.fill") }
                .buttonStyle(.plain)
                .accessibilityLabel("Finish dictation").accessibilityIdentifier("keir-dictate")
        } else if !draftIsEmpty || !attachments.items.isEmpty {
            Button(action: send) { KeirComposerIcon(system: "arrow.up", filled: true).opacity(sendDisabled ? 0.4 : 1) }
                .buttonStyle(.plain)
                .disabled(sendDisabled)
                .accessibilityLabel("Send to Keir").accessibilityIdentifier("keir-send")
        } else {
            Button { voiceDraft = draft; Task { await voice.start() } } label: { KeirComposerIcon(system: "mic") }
                .buttonStyle(.plain)
                .disabled(keir.stopped || voice.requesting)
                .accessibilityLabel("Dictate a message").accessibilityIdentifier("keir-dictate")
        }
    }

    private var sendDisabled: Bool { keir.stopped || attachments.uploading || keir.sending }

    private func send() {
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
    }

    // MARK: Screen

    private var screen: some View {
        timeline
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .background(KeirChatTheme.canvas.ignoresSafeArea())
        .navigationTitle("Keir").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: "\(scenePhase == .active)|\(keir.thread)|\(connectionAttempt)|\(voiceMode)") { if scenePhase == .active && !voiceMode { await keir.connect(session) } }
        .task { await keir.loadThreads(session) }
        .task(id: keir.thread) { await keir.loadModels(session); await keir.loadControls(session) }
        .onAppear { appearedAt = Date(); attachments.scope = keir.thread; handleShortcut() }
        .onChange(of: router.openKeirControls) { _, _ in handleShortcut() }
        .onChange(of: router.openKeirVoice) { _, _ in handleShortcut() }
        .onDisappear(perform: leaveConversation)
        .onChange(of: scenePhase) { _, phase in if phase != .active { voice.stop() } }
        .onChange(of: keir.thread) { old, next in drafts[old] = draft; voice.stop(); draft = drafts[next] ?? ""; attachments.scope = next; appearedAt = Date() }
    }

    var body: some View {
        screen
        .modifier(KeirViewEvents(keir: keir, voice: voice, spokenReplies: spokenReplies, voiceMode: voiceMode, appearedAt: appearedAt,
                                 approvalNeeded: presence == .approval, draft: $draft, voiceDraft: voiceDraft))
        .confirmationDialog("Turn off autonomy?", isPresented: $confirmingYoloOff, titleVisibility: .visible) {
            Button("Turn off autonomy", role: .destructive) {
                Task { await keir.control(["action": .string("configure"), "approvalMode": .string("ask")], session) }
            }
            Button("Keep it on", role: .cancel) {}
        } message: {
            Text("Keir will ask before supported owner actions again. The grant is revoked immediately.")
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
            case .desk: NavigationStack { DeskView().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { sheet = nil } } } }
            }
        }
    }

    private func leaveConversation() {
        voice.stop()
        sheetRequest?.cancel()
        if sheet == nil { presentingSheet = false }
    }

    // The thread response contains its own tasks and messages. Studio-wide
    // approvals stay accessible from Inbox without displacing this conversation.
    private var threadDecisions: [JSONValue] {
        let jobs = Set(keir.tasks.map { $0["id"].string } + keir.messages.map { $0["jobId"].string })
        return ops.decisions.filter { !$0["jobId"].string.isEmpty && jobs.contains($0["jobId"].string) }
    }

    private func handleShortcut() {
        if router.openKeirControls { router.openKeirControls = false; sheet = .controls }
        if router.openKeirVoice { router.openKeirVoice = false; voice.stop(); voiceMode = true }
    }

    private var connectionPlaceholder: some View {
        VStack(spacing: 12) {
            Text(keir.error == nil ? "Connecting to Keir" : "Keir is unavailable").font(.title3.weight(.semibold)).accessibilityIdentifier("keir-connection-state")
            Text("Your draft is kept here. Your conversation will load when the connection returns.")
                .font(.callout).foregroundStyle(OpsTheme.muted).multilineTextAlignment(.center)
            if keir.error != nil {
                Button("Retry connection") { connectionAttempt += 1 }
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, 18).frame(minHeight: 44)
                    .background(KeirChatTheme.chrome, in: Capsule())
                    .overlay(Capsule().strokeBorder(KeirChatTheme.stroke))
                    .accessibilityIdentifier("keir-retry-connection")
            }
        }
        .frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.top, 64)
    }

    /// UIKit must finish dismissing a menu before anything is presented.
    private func afterMenu(_ action: @escaping @MainActor () -> Void) {
        sheetRequest?.cancel()
        sheetRequest = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard scenePhase == .active else { return }
            action()
        }
    }

    private func presentFromMenu(_ target: KeirSheet) {
        presentingSheet = true
        sheetRequest?.cancel()
        sheetRequest = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard scenePhase == .active else { presentingSheet = false; return }
            sheet = target
        }
    }

    private var commands: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(KeirCommand.all.filter { (!standalone || !["/computer", "/ticket", "/chart"].contains($0.id)) && (draft == "/" || $0.id.hasPrefix(draft.lowercased())) }) { command in
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
                    } label: {
                        HStack { Text(command.id).font(.callout.monospaced().weight(.semibold)); Text(command.detail).font(.caption).foregroundStyle(OpsTheme.muted); Spacer() }
                            .padding(.horizontal, 16).padding(.vertical, 10).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 210)
        .background(KeirChatTheme.object, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(KeirChatTheme.stroke))
        .padding(.horizontal, 12)
        .accessibilityIdentifier("keir-commands")
    }

    // MARK: State

    private var presence: KeirPresence.State {
        if keir.stopped { return .stopped }
        if !keir.connected { return .offline }
        if voice.listening { return .listening }
        if voice.speaking { return .speaking }
        if voice.preparingSpeech { return .thinking }
        if AttentionCenter.shared.count > 0 { return .approval }
        if keir.sending { return .thinking }
        return keir.working ? .working : .ready
    }

    /// What the header says Keir is doing. Running tasks and owner attention
    /// have their own capsules, so this is only Keir's own state.
    private var headerPresence: KeirPresence.State {
        switch presence {
        case .stopped, .offline, .listening, .speaking, .thinking: return presence
        default:
            if keir.sending || (keir.working && keir.live.isEmpty && keir.backgroundTasks.isEmpty) { return .thinking }
            return .ready
        }
    }

    /// The animated Keir follows the same state. With none, he idles.
    private var sprite: String? {
        switch headerPresence {
        case .stopped: return "sleeping"
        case .offline: return "concerned"
        case .listening: return "listening"
        case .speaking: return "talking"
        case .thinking: return "thinking"
        default: return keir.working ? "working" : nil
        }
    }

    /// Tickets with no recorded Discord reply. Never offered in standalone mode,
    /// which has no studio desk.
    private var waitingTickets: [JSONValue] {
        standalone ? [] : KeirTicketFollowUp.waiting(in: ops.hub)
    }
    private var draftIsEmpty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// Fills the composer for the owner to edit. It never sends, and never
    /// replaces something already typed.
    private func suggestFollowUp(_ ticket: JSONValue) {
        guard draftIsEmpty else { return }
        draft = KeirTicketFollowUp.prompt(for: ticket)
        composing = true
    }
}

/// Side effects that follow Keir's state: spoken replies, haptics, and
/// dictation flowing into the draft. Split out so the main view's modifier
/// chain stays small enough for the type checker.
private struct KeirViewEvents: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @ObservedObject var keir: KeirStore
    @ObservedObject var voice: KeirVoice
    let spokenReplies: Bool
    let voiceMode: Bool
    let appearedAt: Date
    let approvalNeeded: Bool
    @Binding var draft: String
    let voiceDraft: String
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .sensoryFeedback(.selection, trigger: voice.listening)
            .sensoryFeedback(.warning, trigger: approvalNeeded) { _, needed in needed }
            .onChange(of: keir.stopped) { _, stopped in if stopped { voice.stop() } }
            .onChange(of: spokenReplies) { _, enabled in if !enabled { voice.stopSpeaking() } }
            .onChange(of: draft) { _, text in if keir.thread == "main", !text.isEmpty { keir.holdRestore() } }
            .onChange(of: voice.transcript) { _, text in
                draft = [voiceDraft, text].filter { !$0.isEmpty }.joined(separator: " ")
            }
            .onChange(of: keir.messages.count) { _, _ in
                guard spokenReplies, !voiceMode, !voice.listening, scenePhase == .active,
                      let message = keir.messages.last, message["role"].string == "keir",
                      (message["at"].number ?? 0) / 1000 > appearedAt.timeIntervalSince1970 else { return }
                voice.speakReply(message["text"].string, session: session)
            }
    }
}

/// A tappable inline object: an icon tile, a title and one line of detail.
struct KeirObjectRow: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.callout).foregroundStyle(OpsTheme.sky)
                .frame(width: 34, height: 34)
                .background(OpsTheme.sky.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.ink).lineLimit(2)
                Text(detail).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
        }
        .keirObjectCard(padding: 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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
                Spacer(minLength: 56)
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(message["attachments"].array, id: \.["id"].string) { KeirAttachment(attachment: $0) }
                    if !message["text"].string.isEmpty {
                        Text(message["text"].string).textSelection(.enabled)
                            .foregroundStyle(KeirChatTheme.ownerInk)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(KeirChatTheme.ownerBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }
            }.accessibilityLabel("You: \(message["text"].string)")
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !message["text"].string.isEmpty {
                    NativeMarkdown(text: message["text"].string, fills: false)
                        .textSelection(.enabled)
                        .foregroundStyle(OpsTheme.ink)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(KeirChatTheme.keirBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
                ForEach(message["attachments"].array, id: \.["id"].string) { KeirAttachment(attachment: $0) }
                if !message["activity"].array.isEmpty { KeirToolCalls(calls: message["activity"].array) }
                // Keir revises this same message with the fuller answer; the line
                // underneath says what he is doing meanwhile.
                if let progress = message["progress"].string.nonempty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        LoadingShimmer(text: progress).font(.caption)
                    }
                    .padding(.leading, 6)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Keir is working: \(progress)")
                }
                if !message["chart"].string.isEmpty { KeirChart(name: message["chart"].string) }
                if !message["cards"].array.isEmpty { KeirCards(cards: message["cards"].array) }
                if message["computer"] != .null, !message["jobId"].string.isEmpty {
                    NavigationLink { KeirComputerScreen(taskId: message["jobId"].string) } label: {
                        KeirObjectRow(icon: "desktopcomputer", title: "Computer result", detail: "Open what Keir did on the computer")
                    }.buttonStyle(.plain)
                }
                if message["editedAt"] != .null {
                    Text("Edited").font(.caption2).foregroundStyle(OpsTheme.muted).padding(.leading, 6)
                }
            }
            .padding(.trailing, 32)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Keir, \(OpsFormat.ago(message["at"]))")
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
            if let image { Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous)) }
            else { RoundedRectangle(cornerRadius: 18, style: .continuous).fill(KeirChatTheme.keirBubble).frame(height: 180).overlay(ProgressView()) }
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
                OpsStatusBadge(status: .waiting, label: decision["type"].string == "choice" ? "Choose one" : "Approval")
                if let n = decision["ticket"].number { Text("Ticket \(Int(n))").font(.caption).foregroundStyle(OpsTheme.muted) }
                Spacer()
                Text(OpsFormat.ago(decision["at"])).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            if !decision["review"]["title"].string.isEmpty {
                Text(decision["review"]["title"].string).font(.headline)
            }
            Text(OpsText.decisionTitle(decision)).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            let question = OpsText.scrub(decision["question"].string)
            if !question.isEmpty && question != OpsText.decisionTitle(decision) {
                Text(question).font(.callout).foregroundStyle(decision["tldr"].string.isEmpty ? OpsTheme.ink : OpsTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if decision["type"].string != "choice" && decision["review"]["scope"] != .null {
                Text(decision["review"]["scope"].pretty).font(.caption.monospaced()).textSelection(.enabled)
            }
            if question.count > 300 || decision["scope"] != .null {
                DisclosureGroup("Review full action and scope") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(question).fixedSize(horizontal: false, vertical: true)
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
            if decision["type"].string == "choice" {
                ForEach(decision["options"].array, id: \.["id"].string) { option in
                    Button { act("choose:" + option["id"].string) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(option["label"].string + (option["recommended"].bool ? " (recommended)" : "")).fontWeight(.semibold)
                            if !option["detail"].string.isEmpty { Text(option["detail"].string).font(.caption) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                    }.background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous)).disabled(busy || decision["canAnswer"] == .bool(false))
                }
                Text("Your choice gives direction. Actions needing permission get a separate approval.").font(.caption).foregroundStyle(OpsTheme.muted)
                Button("Ask a question or give another answer") { explaining = true }.disabled(busy)
            } else {
            Text("Approve authorizes this operation. Decline prevents it. Asking a question gives no approval.").font(.caption).foregroundStyle(OpsTheme.muted)
            // Decline on the left, approve on the right, both full capsules: the
            // same shape an approval sheet uses, with reply one tap away.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { decisionButtons }
                VStack(spacing: 8) { decisionButtons }
            }.buttonStyle(.plain).disabled(busy || decision["canAnswer"] == .bool(false))
            }
            if decision["canRefresh"].bool { Button("Request a fresh proposal") { act("refresh") }.disabled(busy) }
            if decision["canAnswer"] == .bool(false) {
                OwnerDirectionButton(title: "Ask Keir to recover this work", context: "Decision \(decision["id"].string) for task \(decision["jobId"].string): \(decision["question"].string)")
            }
            if !decision["jobId"].string.isEmpty { Button("Open task and result") { router.openDecisionTask(decision) } }
        }
        .keirObjectCard()
        }
        }
        .buttonStyle(.plain)
        .alert("Reply to Keir", isPresented: $explaining) {
            TextField("What should Keir explain or change?", text: $note)
            Button("Send") { act("explain", note) }
            Button("Cancel", role: .cancel) {}
        }
    }
    @ViewBuilder private var decisionButtons: some View {
        Button { act("reject") } label: {
            Text("Decline").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                .background(OpsTheme.raised, in: Capsule())
        }
        Button { act("approve") } label: {
            Text("Approve this action").fontWeight(.semibold).lineLimit(2).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 8)
                .background(decision["canApprove"] == .bool(false) ? OpsTheme.raised : OpsTheme.sky, in: Capsule())
                .foregroundStyle(decision["canApprove"] == .bool(false) ? OpsTheme.muted : OpsTheme.onAccent)
        }
        .disabled(decision["canApprove"] == .bool(false)).accessibilityIdentifier("decision-approve")
        Button { explaining = true } label: {
            Image(systemName: "text.bubble").frame(width: 44, height: 44).background(OpsTheme.raised, in: Circle())
        }.accessibilityLabel("Reply or ask why")
    }
    private func act(_ verdict: String, _ text: String = "") {
        busy = true
        Task {
            if await ops.answer(decision["id"].string, verdict: verdict, text: text, session) {
                outcome = verdict == "approve" ? "Approval saved. Keir will report the execution result." : verdict == "reject" ? "Rejection saved" : verdict == "refresh" ? "Fresh review requested. No action was approved." : verdict.hasPrefix("choose:") ? "Choice saved. Keir will continue with your selection." : "Reply sent"
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
            if let bytes, let image = UIImage(data: bytes) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 240, maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            } else {
                // A file is an object: its kind as a tile, then the name and type.
                HStack(spacing: 10) {
                    Image(systemName: fileIcon)
                        .font(.callout).foregroundStyle(attachment["type"].string == "application/pdf" ? OpsTheme.danger : OpsTheme.sky)
                        .frame(width: 34, height: 40)
                        .background(KeirChatTheme.keirBubble, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment["name"].string).font(.callout.weight(.medium)).foregroundStyle(OpsTheme.ink).lineLimit(2)
                        Text(fileKind).font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10).frame(maxWidth: 280, alignment: .leading)
                .background(KeirChatTheme.object, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(KeirChatTheme.stroke))
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
    private var fileIcon: String {
        let type = attachment["type"].string
        if type.hasPrefix("image/") { return "photo" }
        if type == "application/pdf" { return "doc.richtext" }
        return "doc.text"
    }
    private var fileKind: String {
        let type = attachment["type"].string
        if type.hasPrefix("image/") { return "Image" }
        if type == "application/pdf" { return "PDF" }
        let ext = (attachment["name"].string as NSString).pathExtension
        return ext.isEmpty ? "File" : ext.uppercased()
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
