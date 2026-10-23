import SwiftUI
import UserNotifications
import LakesideCore

/// Everything the owner watches, from the ops dashboard and Keir.
@MainActor final class OpsStore: ObservableObject {
    @Published var services: [JSONValue] = []
    @Published var hub: JSONValue = .null
    @Published var kanban: JSONValue = .null
    @Published var host: JSONValue = .null
    @Published var scheduler: JSONValue = .null
    @Published var decisions: [JSONValue] = []
    @Published var alerts: [JSONValue] = []
    @Published var answerReceipt: JSONValue = .null
    @Published var updated: Date?
    @Published var error: String?
    @Published var loading = false

    private var generation = UUID()
    func reset() {
        generation = UUID(); services = []; hub = .null; kanban = .null; host = .null; scheduler = .null
        decisions = []; alerts = []; answerReceipt = .null; updated = nil; error = nil; loading = false; UNBadge.set(0)
        AttentionCenter.shared.reset()
    }
    var kpis: JSONValue { hub["kpis"] }
    var servicesDown: [JSONValue] { services.filter { !["operational", ""].contains($0["current"].string) } }
    var redPRs: Int { Int(kpis["prsRed"].number ?? 0) }
    var blocked: [JSONValue] { kanban["blocked"].array }
    var needsOwner: [JSONValue] { kanban["needs_owner"].array }
    /// The count on the Pulse tab badge: only things the owner can act on now.
    var attention: Int { AttentionCenter.shared.count }

    func refresh(_ session: AppSession) async {
        guard !loading else { return }
        let epoch = generation
        loading = true; defer { if generation == epoch { loading = false } }
        async let status = try? session.get("/api/status")
        async let keir = try? session.get("/api/keir/hub")
        async let board = try? session.get("/api/kanban/brief")
        async let scheduler = try? session.get("/api/scheduler")
        async let open = try? session.get("/api/keir/app/decisions")
        async let feed = try? session.get("/api/keir/app/alerts")
        let (s, k, b, h, d, a) = await (status, keir, board, scheduler, open, feed)
        guard generation == epoch else { return }
        if let s { services = s["services"].array }
        if let k { hub = k }
        if let b { kanban = b }
        if let h { host = h["host"]; scheduler = h }
        if let d { decisions = d["decisions"].array }
        if let a { alerts = a["alerts"].array }
        AttentionCenter.shared.setWork(decisions: decisions, ownerWork: kanban["needs_owner"].array)
        let failed = [s, k, b, h, d, a].filter { $0 == nil }.count
        error = failed == 6 ? "Ops is unreachable. Pull to retry." : failed > 0 ? "Some panels could not refresh." : nil
        if failed < 6 { updated = Date() }
        UNBadge.set(attention)
    }

    func answer(_ id: String, verdict: String, text: String = "", _ session: AppSession) async -> Bool {
        let epoch = generation
        do {
            let result = try await session.post("/api/keir/app/decisions/\(id)", ["verdict": .string(verdict), "text": .string(text)])
            guard epoch == generation else { return false }
            answerReceipt = result
            decisions.removeAll { $0["id"].string == id }
            AttentionCenter.shared.setWork(decisions: decisions, ownerWork: kanban["needs_owner"].array)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            UNBadge.set(attention)
            return true
        } catch { guard epoch == generation else { return false }; self.error = error.displayMessage; UINotificationFeedbackGenerator().notificationOccurred(.error); return false }
    }
}

/// Keir's private thread with the owner.
@MainActor final class KeirStore: ObservableObject {
    @Published var messages: [JSONValue] = []
    @Published var tasks: [JSONValue] = []
    @Published var working = false
    @Published var connected = false
    @Published var sending = false
    @Published private(set) var lastSentJob: String?
    @Published var error: String?
    @Published var thread = "main"
    @Published var threads: [JSONValue] = []
    @Published var queued = 0
    @Published var questions: [JSONValue] = []
    @Published var backgroundTasks: [JSONValue] = []
    /// All of Keir's open work, including tickets and Discord requests.
    @Published var team: JSONValue = .null
    @Published var models: [JSONValue] = []
    @Published var modelSelection = "auto"
    @Published var selectingModel = false
    @Published var controls: JSONValue = .null
    @Published var controlling = false
    private var generation = UUID()
    func reset() {
        generation = UUID(); messages = []; tasks = []; backgroundTasks = []; questions = []; team = .null
        threads = []; thread = "main"; connected = false; working = false; sending = false; queued = 0
        models = []; modelSelection = "auto"; selectingModel = false; controls = .null; controlling = false
        error = nil; lastSentJob = nil; pending = nil; cursor = 0; version = ""; steeringTask = nil; sendMode = "new"
        AttentionCenter.shared.setQuestions([])
    }
    var stopped: Bool { controls["stopped"].bool }
    var yolo: Bool { controls["approvalMode"].string == "yolo" }
    func loadControls(_ session: AppSession) async {
        let selected = thread, epoch = generation
        do {
            let result = try await session.get("/api/keir/app/controls", query: ["thread": selected])
            if thread == selected && epoch == generation { controls = result; error = nil }
        } catch { if thread == selected && epoch == generation { self.error = error.displayMessage } }
    }
    func control(_ fields: [String: JSONValue], _ session: AppSession) async {
        guard !controlling else { return }
        controlling = true; defer { controlling = false }
        let selected = thread, epoch = generation
        do {
            var body = fields; body["thread"] = .string(selected)
            let result = try await session.post("/api/keir/app/controls", body)
            guard thread == selected && generation == epoch else { return }
            controls = result; error = nil
            UINotificationFeedbackGenerator().notificationOccurred(stopped ? .warning : .success)
        } catch { if generation == epoch && thread == selected { self.error = error.displayMessage; UINotificationFeedbackGenerator().notificationOccurred(.error) } }
    }

    @Published var sendMode = "new"
    @Published var steeringTask: String?
    private var cursor = 0
    private var version = ""
    private var pending: (text: String, thread: String, mode: String, task: String?, voice: Bool, attachments: JSONValue, id: String)?

    var live: [JSONValue] { tasks.filter { !["done", "cancelled", "dismissed"].contains($0["state"].string) } }

    func connect(_ session: AppSession) async {
        let epoch = generation
        var delay = 1.0
        while !Task.isCancelled {
            do {
                // The first read returns at once; after that the server holds the
                // request until the thread or a task changes (25s at most).
                let selected = thread
                let view = try await session.get("/api/keir/app/thread", query: ["after": String(cursor), "wait": version.isEmpty ? "0" : "25", "since": version, "thread": selected])
                guard generation == epoch else { return }
                guard selected == thread else { continue }
                let before = version
                apply(view); connected = true; error = nil; delay = 1
                // A server that answers without waiting must not turn this into a busy loop.
                if version == before { try await Task.sleep(for: .seconds(2)) }
            } catch {
                if Task.isCancelled || generation != epoch { return }
                connected = false; self.error = error.displayMessage
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                delay = min(20, delay * 2)
            }
        }
    }

    private func apply(_ view: JSONValue) {
        let fresh = view["messages"].array.filter { m in !messages.contains { $0["id"] == m["id"] } }
        if !fresh.isEmpty {
            messages.append(contentsOf: fresh)
            if fresh.contains(where: { $0["role"].string == "keir" }) { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
        }
        if view["controls"] != .null { controls = view["controls"] }
        tasks = view["tasks"].array
        working = view["working"].bool
        queued = Int(view["queued"].number ?? 0)
        questions = view["questions"].array
        AttentionCenter.shared.setQuestions(questions)
        backgroundTasks = view["backgroundTasks"].array
        team = view["team"]
        if !view["modelSelection"].string.isEmpty { modelSelection = view["modelSelection"].string }
        if let target = steeringTask, !live.contains(where: { $0["id"].string == target }) { steeringTask = nil; sendMode = "new" }
        cursor = Int(view["cursor"].number ?? Double(cursor))
        version = view["version"].string
        let snapshot = view["activity"]
        Task { await KeirLiveActivity.shared.sync(snapshot, session: OpsServices.shared.session) }
    }

    func send(_ text: String, _ session: AppSession, voice: Bool = false, attachments: JSONValue = .array([])) async -> Bool {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!body.isEmpty || !attachments.array.isEmpty), !sending else { return false }
        let epoch = generation
        sending = true; defer { if epoch == generation { sending = false } }
        let selected = thread, mode = voice ? "new" : sendMode, target = voice ? nil : steeringTask
        if pending?.text != body || pending?.thread != selected || pending?.mode != mode || pending?.task != target || pending?.voice != voice || pending?.attachments != attachments {
            pending = (body, selected, mode, target, voice, attachments, UUID().uuidString)
        }
        do {
            let result = try await session.post("/api/keir/app/messages", ["text": .string(body), "clientId": .string(pending!.id), "thread": .string(selected), "mode": .string(mode), "taskId": target.map(JSONValue.string) ?? .null, "voice": .bool(voice), "attachments": attachments])
            guard generation == epoch else { return false }
            pending = nil; error = nil; lastSentJob = result["jobId"].string.nonempty
            guard thread == selected else { return true }
            if !voice { steeringTask = nil; sendMode = "new" }
            if let created = result["thread"].string.nonempty { await loadThreads(session); select(created); return true }
            if result["controls"] != .null { controls = result["controls"] }
            let message = result["message"]
            if message != .null, !messages.contains(where: { $0["id"] == message["id"] }) { messages.append(message); cursor = max(cursor, Int(message["seq"].number ?? 0)) }
            return true
        } catch { if generation == epoch { self.error = error.displayMessage }; return false }
    }

    /// Switches the visible thread; the connection loop restarts on the new one.
    func select(_ id: String) {
        guard id != thread else { return }
        steeringTask = nil; sendMode = "new"; modelSelection = "auto"
        connected = false; models = []; controls = .null; thread = id; questions = []; messages = []; tasks = []; cursor = 0; version = ""; queued = 0; working = false
    }
    func loadModels(_ session: AppSession) async {
        let selected = thread, epoch = generation
        do {
            let result = try await session.get("/api/keir/app/models", query: ["thread": selected])
            guard selected == thread && generation == epoch else { return }
            models = result["models"].array; modelSelection = result["selection"].string.nonempty ?? "auto"
        } catch { if generation == epoch && thread == selected { models = []; self.error = error.displayMessage } }
    }
    func selectModel(_ id: String, _ session: AppSession) async {
        guard !selectingModel else { return }
        selectingModel = true; defer { selectingModel = false }
        let selected = thread, epoch = generation
        do {
            let result = try await session.post("/api/keir/app/models", ["thread": .string(selected), "selection": .string(id)])
            guard selected == thread && generation == epoch else { return }
            modelSelection = result["selection"].string; error = nil
        } catch { if generation == epoch && thread == selected { self.error = error.displayMessage } }
    }
    var conversationModelLabel: String {
        let selection = controls["routes"]["conversation"].string.nonempty ?? modelSelection
        let route = selection == "auto" ? controls["defaults"]["conversation"].string : selection
        let label = KeirProviderName.label(route, options: controls["options"]["conversation"].array)
        return "Chat · \(label.isEmpty ? "Installation default" : label)"
    }
    var modelLabel: String { models.first { $0["id"].string == modelSelection }?["label"].string ?? "Auto" }

    func loadThreads(_ session: AppSession) async {
        let epoch = generation
        if let list = try? await session.get("/api/keir/app/threads"), generation == epoch { threads = list["threads"].array }
    }
    func newThread(_ title: String, _ session: AppSession) async {
        let epoch = generation
        do { let made = try await session.post("/api/keir/app/threads", ["title": .string(title)]); guard epoch == generation else { return }; await loadThreads(session); select(made["id"].string) }
        catch { if epoch == generation { self.error = error.displayMessage } }
    }
    var threadTitle: String { threads.first { $0["id"].string == thread }?["title"].string ?? (thread == "watches" ? "Watches" : "Keir") }

    private var observedStart: [String: Date] = [:]

    /// The first moment this session saw a piece of work. Used only when the
    /// server has no recorded start for it.
    func firstSeen(_ id: String) -> Date {
        if let seen = observedStart[id] { return seen }
        let now = Date(); observedStart[id] = now; return now
    }

    func stop(_ task: String, _ session: AppSession) async {
        do { _ = try await session.post("/api/keir/app/cancel", ["taskId": .string(task)]); tasks.removeAll { $0["id"].string == task } }
        catch { self.error = error.displayMessage }
    }
}

enum UNBadge {
    static func set(_ count: Int) { UNUserNotificationCenter.current().setBadgeCount(count) { _ in } }
}
