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
    /// Keir's ticket work queue (`/api/keir/app/work`). Shared so the Inbox
    /// badge, Ops and the Inbox list read the same tickets.
    @Published var work: JSONValue = .null
    @Published var answerReceipt: JSONValue = .null
    /// The last refresh that reached the server at all.
    @Published var updated: Date?
    /// The last time Keir's activity (running, queued, tickets) was read. The
    /// running count is only live while this is recent.
    @Published var activityUpdated: Date?
    @Published var error: String?
    /// Which panels failed on the last refresh, in plain words.
    @Published var failedPanels: [String] = []
    @Published var loading = false

    private var generation = UUID()
    func reset() {
        generation = UUID(); services = []; hub = .null; kanban = .null; host = .null; scheduler = .null
        decisions = []; alerts = []; work = .null; answerReceipt = .null; updated = nil; activityUpdated = nil; error = nil; failedPanels = []; loading = false; UNBadge.set(0)
        AttentionCenter.shared.reset()
    }
    var kpis: JSONValue { hub["kpis"] }
    var servicesDown: [JSONValue] { services.filter { !["operational", ""].contains($0["current"].string) } }
    /// Open pull requests with failing checks, exactly the list Failed checks shows.
    /// Falls back to the server count only when the hub sent no PR list.
    var failingPRs: [JSONValue] { hub["prs"].array.filter { $0["state"].string == "OPEN" && $0["ci"].string == "red" } }
    var redPRs: Int { hub["prs"] == .null ? Int(kpis["prsRed"].number ?? 0) : failingPRs.count }
    /// Exactly the rows the Blocked work lane lists.
    var blocked: [JSONValue] { kanban["blocked"].array }
    var needsOwner: [JSONValue] { kanban["needs_owner"].array }
    /// The support queue owns membership and timing. The hub adds delivery
    /// receipts and ticket detail metadata for the matching records.
    var openTickets: [JSONValue] {
        let hubTickets = hub["tickets"].array
        let queue = work["tickets"].array
        let metadata = Dictionary(hubTickets.map { ($0["number"].string, $0.object) }, uniquingKeysWith: { first, _ in first })
        let numbers = Set(queue.map { $0["number"].string })
        let fallback = work["source"]["complete"].bool ? [] : hubTickets.filter { !numbers.contains($0["number"].string) }
        return (queue.map { row in
            JSONValue.object((metadata[row["number"].string] ?? [:]).merging(row.object, uniquingKeysWith: { _, current in current }))
        } + fallback).filter { KeirTicketFollowUp.isOpen($0) }
    }
    /// The count on the Inbox tab badge: only things the owner can act on now.
    var attention: Int { AttentionCenter.shared.count }

    // MARK: Heartbeat

    /// Two missed foreground refreshes (every 30 seconds) plus slack.
    static let staleAfter: TimeInterval = 150

    enum Heartbeat: Equatable {
        case connecting
        case fresh(Date)
        /// The last good read is too old, or the newest read failed.
        case stalled(Date)
        case unreachable
    }

    /// The one answer to "is what Ops shows current?". Running counts are only
    /// presented as live while this is `.fresh`.
    func heartbeat(now: Date = Date()) -> Heartbeat {
        guard let updated else { return error == nil ? .connecting : .unreachable }
        if !failedPanels.isEmpty && failedPanels.count >= Self.panelCount { return .stalled(updated) }
        if now.timeIntervalSince(updated) > Self.staleAfter { return .stalled(updated) }
        if let activity = activityUpdated, now.timeIntervalSince(activity) > Self.staleAfter { return .stalled(activity) }
        return .fresh(updated)
    }

    /// One full sentence about freshness, for the Ops header.
    func heartbeatSentence(now: Date = Date()) -> String {
        switch heartbeat(now: now) {
        case .connecting: return "Connecting to Ops."
        case .unreachable: return "Ops could not be reached. Pull to retry."
        case .fresh(let at):
            let partial = failedPanels.isEmpty ? "" : " \(Self.list(failedPanels)) did not refresh."
            return "Updated \(OpsFormat.ago(at)).\(partial)"
        case .stalled(let at):
            return "Updates stalled. Last good data is from \(OpsFormat.ago(at)), so counts may be out of date."
        }
    }

    private static let panelCount = 7
    private static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names.last!
    }

    func refresh(_ session: AppSession) async {
        guard !loading else { return }
        let epoch = generation
        loading = true; defer { if generation == epoch { loading = false } }
        async let status = try? session.get("/api/status")
        async let keir = try? session.get("/api/keir/hub")
        async let board = try? session.get("/api/kanban/brief")
        async let schedule = try? session.get("/api/scheduler")
        async let open = try? session.get("/api/keir/app/decisions")
        async let feed = try? session.get("/api/keir/app/alerts")
        async let queue = try? session.get("/api/keir/app/work")
        let (s, k, b, h, d, a, w) = await (status, keir, board, schedule, open, feed, queue)
        guard generation == epoch else { return }
        if let s { services = s["services"].array }
        if let k { hub = k; activityUpdated = Date() }
        if let b { kanban = b }
        if let h { host = h["host"]; scheduler = h }
        if let d { decisions = d["decisions"].array }
        if let a { alerts = a["alerts"].array }
        if let w { work = w }
        rebuildAttention()
        let names = ["Service status", "Keir activity", "Work board", "Scheduler", "Decisions", "Alerts", "Ticket queue"]
        failedPanels = zip(names, [s, k, b, h, d, a, w]).filter { $0.1 == nil }.map { $0.0 }
        error = failedPanels.count == Self.panelCount ? "Ops is unreachable. Pull to retry." : failedPanels.isEmpty ? nil : "\(Self.list(failedPanels)) could not refresh."
        if failedPanels.count < Self.panelCount { updated = Date() }
    }

    /// Re-reads only decisions and the ticket queue. The Inbox calls this so its
    /// rows and the tab badge come from the same read.
    func refreshInbox(_ session: AppSession) async -> String? {
        let epoch = generation
        async let open = try? session.get("/api/keir/app/decisions")
        async let queue = try? session.get("/api/keir/app/work")
        let (d, w) = await (open, queue)
        guard generation == epoch else { return nil }
        if let d { decisions = d["decisions"].array }
        if let w { work = w }
        rebuildAttention()
        if d == nil { return "Decisions could not refresh. Pull to retry." }
        if w == nil { return "Ticket queue could not refresh. The last list is still shown." }
        return nil
    }

    private func rebuildAttention() {
        AttentionCenter.shared.setWork(decisions: decisions, ownerWork: needsOwner, tickets: openTickets)
        UNBadge.set(attention)
    }

    func answer(_ id: String, verdict: String, text: String = "", _ session: AppSession) async -> Bool {
        let epoch = generation
        do {
            let result = try await session.post("/api/keir/app/decisions/\(id)", ["verdict": .string(verdict), "text": .string(text)])
            guard epoch == generation else { return false }
            answerReceipt = result
            decisions.removeAll { $0["id"].string == id }
            rebuildAttention()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
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
    static let supervisorThread = KeirSupervisor.thread
    @Published private(set) var supervisorAvailable = false
    /// Supervisor-only state: proposals, executor line, and why it may be unusable.
    @Published var supervisor = KeirSupervisorState()
    /// False from a fresh start or an account change until the profile says
    /// whether this person has a private supervisor. Until then nothing is sent
    /// and nothing is read from Support Keir, because "main" is only a
    /// placeholder, not a place an owner's message may land.
    @Published private(set) var homeResolved = false
    var isSupervisor: Bool { thread == Self.supervisorThread }
    var personalHome: Bool { isSupervisor || thread == "main" }

    /// Settles which conversation is home for the signed-in account. An owner
    /// lands in the private supervisor; everyone else in Support Keir. A profile
    /// that is not loaded, or an inconclusive check, leaves it unresolved.
    func ensureHome(_ session: AppSession) async {
        guard !homeResolved else { return }
        let epoch = generation, scope = resumeScope
        var home = KeirSupervisor.home(profile: session.profile)
        if home == .waitingForProfile { await session.refreshProfile(); home = KeirSupervisor.home(profile: session.profile) }
        guard generation == epoch, resumeScope == scope, !homeResolved else { return }
        switch home {
        case .waitingForProfile:
            error = "Keir could not confirm your account yet. Nothing has been sent."
        case .supervisor: resolveHome(supervisor: true)
        case .support: resolveHome(supervisor: false)
        case .probe:
            let result: Result<JSONValue, Error>
            do { result = .success(try await session.get("\(KeirSupervisor.base)/status")) } catch { result = .failure(error) }
            guard generation == epoch, resumeScope == scope, !homeResolved else { return }
            switch KeirSupervisor.probe(result) {
            case .owner: resolveHome(supervisor: true)
            case .notOwner: resolveHome(supervisor: false)
            case .inconclusive: error = "Keir could not confirm your account yet. Nothing has been sent."
            }
        }
    }

    private func resolveHome(supervisor available: Bool) {
        supervisorAvailable = available
        homeResolved = true
        error = nil
        if available && !threadChosen && thread == "main" { switchThread(Self.supervisorThread) }
    }

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
    private(set) var generation = UUID()

    /// Which account's last conversation to reopen. See `KeirResume`.
    var resume: KeirResume
    private(set) var resumeScope: String?
    private var restoredScope: String?
    /// True once the owner, or a notification they opened, picked a thread.
    /// A late restore must never override that choice.
    private var threadChosen = false
    /// The owner started typing on the main thread; moving them would hide it.
    private var restoreHeld = false
    func holdRestore() { restoreHeld = true }

    init(resume: KeirResume = KeirResume()) { self.resume = resume }

    func reset() {
        supervisorAvailable = false; homeResolved = false; supervisor = KeirSupervisorState()
        resume.clear(); resumeScope = nil; restoredScope = nil; threadChosen = false; restoreHeld = false
        generation = UUID(); messages = []; tasks = []; backgroundTasks = []; questions = []; team = .null
        threads = []; thread = "main"; connected = false; working = false; sending = false; queued = 0
        models = []; modelSelection = "auto"; selectingModel = false; controls = .null; controlling = false
        error = nil; lastSentJob = nil; pending = nil; cursor = 0; version = ""; steeringTask = nil; sendMode = "new"
        AttentionCenter.shared.setQuestions([])
    }
    var stopped: Bool { controls["stopped"].bool }
    var yolo: Bool { controls["approvalMode"].string == "yolo" }
    func loadControls(_ session: AppSession) async {
        guard !isSupervisor else { return }
        let selected = thread, epoch = generation
        do {
            let result = try await session.get("/api/keir/app/controls", query: ["thread": selected])
            if thread == selected && epoch == generation { controls = result; error = nil }
        } catch { if thread == selected && epoch == generation { self.error = error.displayMessage } }
    }
    func control(_ fields: [String: JSONValue], _ session: AppSession) async {
        guard !controlling, !isSupervisor else { return }
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

    var live: [JSONValue] {
        // A supervisor job is live only while queued or running; a failed one is not work in progress.
        if isSupervisor { return tasks.filter(KeirSupervisor.isLive) }
        return tasks.filter { !["done", "cancelled", "dismissed"].contains($0["state"].string) }
    }

    func connect(_ session: AppSession) async {
        let epoch = generation
        var delay = 1.0
        while !Task.isCancelled {
            // Never read or post to a conversation before the account is known.
            if !homeResolved {
                await ensureHome(session)
                guard generation == epoch, !Task.isCancelled else { return }
                if !homeResolved {
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    delay = min(20, delay * 2)
                    continue
                }
                delay = 1
            }
            do {
                // The first read returns at once; after that the server holds the
                // request until the thread or a task changes (25s at most).
                let selected = thread
                // edits=1: this build renders a revised answer in place by id.
                let view: JSONValue
                if selected == Self.supervisorThread {
                    view = try await session.get("/api/keir/supervisor/thread", query: version.isEmpty ? [:] : ["after": String(cursor), "since": version, "wait": "25"])
                } else {
                    view = try await session.get("/api/keir/app/thread", query: ["after": String(cursor), "wait": version.isEmpty ? "0" : "25", "since": version, "thread": selected, "edits": "1"])
                }
                guard generation == epoch, !Task.isCancelled else { return }
                guard selected == thread else { continue }
                let before = version
                apply(view); connected = true; error = nil; delay = 1
                // A server that answers without waiting must not turn this into a busy loop.
                if version == before { try await Task.sleep(for: .seconds(2)) }
            } catch {
                if Task.isCancelled || generation != epoch { return }
                // "Not set up" and "owner only" are answers, not outages: the
                // server is reachable, so say so plainly and check again later.
                if thread == Self.supervisorThread, let setup = KeirSupervisor.setup(for: error) {
                    supervisor.setup = setup; connected = true; self.error = nil
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                    continue
                }
                connected = false; self.error = error.displayMessage
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                delay = min(20, delay * 2)
            }
        }
    }

    /// Takes the new rows and the revised ones, upserting by message id. Returns
    /// true only when a genuinely new Keir message was appended.
    private func merge(_ fresh: [JSONValue], _ revised: [JSONValue]) -> Bool {
        guard !fresh.isEmpty || !revised.isEmpty else { return false }
        var next = messages
        var index: [String: Int] = [:]
        for (i, row) in next.enumerated() { let id = row["id"].string; if !id.isEmpty { index[id] = i } }
        var appendedKeir = false
        for row in fresh {
            let id = row["id"].string
            guard !id.isEmpty, index[id] == nil else { continue }
            index[id] = next.count
            next.append(row)
            if row["role"].string == "keir" { appendedKeir = true }
        }
        for row in fresh + revised {
            let id = row["id"].string
            guard !id.isEmpty, let i = index[id] else { continue }
            if next[i] != row { next[i] = row }
        }
        messages = next
        return appendedKeir
    }

    private func apply(_ view: JSONValue) {
        // A revised answer keeps its id and seq and arrives in `revised`: replace
        // the row in place so the same message grows into the fuller answer.
        let rows = isSupervisor ? view["messages"].array.map(KeirSupervisor.timelineRow) : view["messages"].array
        if merge(rows, view["revised"].array) { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
        if view["controls"] != .null { controls = view["controls"] }
        if isSupervisor { supervisor.apply(view) }
        tasks = isSupervisor ? view["jobs"].array.map(KeirSupervisor.jobRow) : view["tasks"].array
        working = view["working"].bool
        queued = Int(view["queued"].number ?? 0)
        questions = view["questions"].array
        AttentionCenter.shared.setQuestions(questions)
        backgroundTasks = view["backgroundTasks"].array
        team = view["team"]
        for item in team["items"].array { _ = firstSeen(item["id"].string) }
        if !view["modelSelection"].string.isEmpty { modelSelection = view["modelSelection"].string }
        if let target = steeringTask, !live.contains(where: { $0["id"].string == target }) { steeringTask = nil; sendMode = "new" }
        cursor = Int(view["cursor"].number ?? Double(cursor))
        version = view["version"].string
        guard !isSupervisor else { return }
        let snapshot = view["activity"]
        Task { await KeirLiveActivity.shared.sync(snapshot, session: OpsServices.shared.session) }
    }

    func send(_ text: String, _ session: AppSession, voice: Bool = false, attachments: JSONValue = .array([])) async -> Bool {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!body.isEmpty || !attachments.array.isEmpty), !sending else { return false }
        if isSupervisor, session.profile["ownerSupervisorReady"] == .bool(false) {
            error = session.profile["ownerSupervisorIssue"].string.nonempty ?? "Private Keir is offline. Your draft is still here."
            return false
        }
        // The one place that decides whether a message may leave the phone.
        if case .withheld(let reason) = KeirSupervisor.destination(thread: thread, supervisorAvailable: supervisorAvailable, resolved: homeResolved, chosen: threadChosen) {
            error = reason; return false
        }
        if isSupervisor, let setup = supervisor.setup { error = "\(setup.message). Nothing was sent."; return false }
        let epoch = generation
        sending = true; defer { if epoch == generation { sending = false } }
        let selected = thread, mode = voice ? "new" : sendMode, target = voice ? nil : steeringTask
        if pending?.text != body || pending?.thread != selected || pending?.mode != mode || pending?.task != target || pending?.voice != voice || pending?.attachments != attachments {
            pending = (body, selected, mode, target, voice, attachments, UUID().uuidString)
        }
        do {
            let result: JSONValue
            if selected == Self.supervisorThread {
                guard attachments.array.isEmpty else { throw AppFailure(message: "This conversation currently accepts text and voice. Your attachments are still here.") }
                result = try await session.post("\(KeirSupervisor.base)/messages", ["text": .string(body), "clientId": .string(KeirSupervisor.clientId(pending!.id))])
            } else {
                result = try await session.post("/api/keir/app/messages", ["text": .string(body), "clientId": .string(pending!.id), "thread": .string(selected), "mode": .string(mode), "taskId": target.map(JSONValue.string) ?? .null, "voice": .bool(voice), "attachments": attachments])
            }
            guard generation == epoch else { return false }
            pending = nil; error = nil; lastSentJob = (selected == Self.supervisorThread ? result["job"]["id"] : result["jobId"]).string.nonempty
            guard thread == selected else { return true }
            if !voice { steeringTask = nil; sendMode = "new" }
            if !isSupervisor, let created = result["thread"].string.nonempty { await loadThreads(session); select(created); return true }
            if result["controls"] != .null { controls = result["controls"] }
            let message = isSupervisor ? KeirSupervisor.timelineRow(result["message"]) : result["message"]
            if result["message"] != .null, !messages.contains(where: { $0["id"] == message["id"] }) { messages.append(message); if !isSupervisor { cursor = max(cursor, Int(message["seq"].number ?? 0)) } }
            return true
        } catch { if generation == epoch { self.error = error.displayMessage }; return false }
    }

    /// Switches the visible thread because the owner (or a notification they
    /// opened) asked for it; the connection loop restarts on the new one.
    func select(_ id: String) {
        threadChosen = true
        guard id != thread else { persistThread(); return }
        switchThread(id)
        persistThread()
    }
    private func switchThread(_ id: String) {
        steeringTask = nil; sendMode = "new"; modelSelection = "auto"
        supervisor = KeirSupervisorState()
        connected = false; models = []; controls = .null; thread = id; questions = []; messages = []; tasks = []; cursor = 0; version = ""; queued = 0; working = false
    }

    /// Binds the store to the signed-in account. Until this is known nothing is
    /// saved or restored.
    func bindAccount(_ scope: String?) {
        guard scope != resumeScope else { return }
        // A different account on the same installation never inherits the
        // previous one's thread, messages, supervisor state or resolved home.
        if resumeScope != nil { reset() }
        resumeScope = scope; restoredScope = nil
        if scope != nil, threadChosen { persistThread() }
    }
    private func persistThread() {
        guard let scope = resumeScope else { return }
        let system = threads.first { $0["id"].string == thread }?["system"].bool ?? false
        if personalHome || thread == "watches" || system { resume.clear() } else { resume.save(thread, scope: scope) }
    }

    /// Reopens the last private conversation after a cold start. The saved id is
    /// checked against the live thread listing, and every step after the network
    /// read re-checks that nothing changed: the owner picked a thread, the
    /// account changed, or the owner signed out. `listing` exists for tests.
    /// Returns true only when the listing could not be read and the restore is
    /// still open, so the caller may try again.
    @discardableResult
    func resumeLastThread(_ session: AppSession, listing: (@MainActor () async -> [JSONValue]?)? = nil) async -> Bool {
        guard let scope = resumeScope, restoredScope != scope else { return false }
        guard !threadChosen, !restoreHeld, personalHome else { restoredScope = scope; return false }
        guard let saved = resume.saved(for: scope) else {
            resume.clear()   // nothing for this account; never keep another account's entry
            restoredScope = scope; return false
        }
        let epoch = generation
        let list: [JSONValue]?
        if let listing { list = await listing() } else { list = await fetchThreads(session) }
        // A failed read keeps the saved id and leaves the next attempt open.
        guard let list else { return true }
        guard generation == epoch, resumeScope == scope, !threadChosen, !restoreHeld, personalHome else { return false }
        restoredScope = scope
        threads = list
        if KeirResume.legitimate(saved, in: list) { switchThread(saved) } else { resume.clear() }
        return false
    }

    /// The cold-start restore. A first launch after a force-quit often meets a
    /// failed first read while the connection comes up; the conversation loop
    /// retries on its own, so the restore retries too instead of waiting for
    /// the next foreground. Each attempt re-checks every guard, so a thread the
    /// owner picked, a draft, a sign-out or an account change ends it. Bounded
    /// to the same short backoff as the connection; after that the next
    /// foreground tries again.
    func resumeLastThreadWhileOpen(_ session: AppSession, listing: (@MainActor () async -> [JSONValue]?)? = nil,
                                   pause: @MainActor (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) async {
        var delay = 1.0
        for attempt in 1...Self.resumeAttempts {
            guard await resumeLastThread(session, listing: listing), !Task.isCancelled, attempt < Self.resumeAttempts else { return }
            do { try await pause(delay) } catch { return }
            delay *= 2
        }
    }
    static let resumeAttempts = 5
    func loadModels(_ session: AppSession) async {
        guard !isSupervisor else { return }
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

    /// The thread listing, or nil when it could not be read or the account changed meanwhile.
    private func fetchThreads(_ session: AppSession) async -> [JSONValue]? {
        let epoch = generation
        guard let list = try? await session.get("/api/keir/app/threads"), generation == epoch else { return nil }
        return list["threads"].array
    }
    func loadThreads(_ session: AppSession) async {
        if let list = await fetchThreads(session) { threads = list }
    }
    func newThread(_ title: String, _ session: AppSession) async {
        let epoch = generation
        do { let made = try await session.post("/api/keir/app/threads", ["title": .string(title)]); guard epoch == generation else { return }; await loadThreads(session); select(made["id"].string) }
        catch { if epoch == generation { self.error = error.displayMessage } }
    }
    var conversationRows: [JSONValue] {
        guard supervisorAvailable else { return threads }
        let home = JSONValue.object(["id": .string(Self.supervisorThread), "title": .string("Keir"), "system": .bool(true), "preview": .string("Your private conversation")])
        let others = threads.map { row -> JSONValue in
            guard row["id"].string == "main" else { return row }
            var fields = row.object; fields["title"] = .string("Support Keir")
            return .object(fields)
        }
        return [home] + others
    }
    var threadTitle: String { conversationRows.first { $0["id"].string == thread }?["title"].string ?? (thread == "watches" ? "Watches" : "Keir") }

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
