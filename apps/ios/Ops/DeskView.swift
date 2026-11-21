import SwiftUI
import LakesideCore

/// Keir's support desk: the tickets it holds and the workers doing the work.
struct DeskView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore

    private var tickets: [JSONValue] { ops.openTickets }
    private var workers: [JSONValue] { ops.hub["workers"].array }
    private var recent: [JSONValue] { Array(ops.hub["recent"].array.prefix(8)) }

    var body: some View {
        List {
            Section {
                if tickets.isEmpty { Text("No open tickets.").foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear) }
                ForEach(tickets, id: \.["number"].string) { ticket in
                    NavigationLink { TicketDetail(ticket: ticket) } label: {
                        WorkRow(title: ticket["title"].string, meta: ticketMeta(ticket), bar: ticket["decisionPending"].bool ? OpsTheme.warn : ticket["active"]["state"].string == "running" ? OpsTheme.mint : nil)
                    }
                }.listRowBackground(Color.clear)
            } header: { SectionLabel(text: "Tickets", count: tickets.count) }
            Section {
                if workers.isEmpty { Text("No active sessions").foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear) }
                ForEach(workers, id: \.["id"].string) { worker in
                    NavigationLink { WorkerDetail(worker: worker) } label: {
                        WorkRow(title: workerTitle(worker), meta: "\(worker["runner"].string) · \(worker["model"].string)\(worker["effort"].string.isEmpty ? "" : " @\(worker["effort"].string)") · \(OpsFormat.ago(worker["updatedAt"]))", bar: OpsState.color(worker["state"].string)) {
                            OpsStatusBadge(status: OpsState.status(worker["state"].string), compact: true)
                        }
                    }
                }.listRowBackground(Color.clear)
            } header: { SectionLabel(text: "Active sessions", count: workers.count) }
            Section {
                ForEach(recent, id: \.["id"].string) { job in
                    NavigationLink { WorkerDetail(worker: job) } label: { WorkRow(title: workerTitle(job), meta: "\(OpsState.word(job["state"].string)) · \(job["model"].string) · \(OpsFormat.ago(job["updatedAt"]))") }
                }.listRowBackground(Color.clear)
            } header: { SectionLabel(text: "Recently finished") }
        }
        .listStyle(.plain)
        .refreshable { await ops.refresh(session) }
        .opsScreen()
        .navigationTitle("Desk").navigationBarTitleDisplayMode(.inline)
    }

    private func ticketMeta(_ t: JSONValue) -> String {
        var parts = ["#\(t["number"].string)", t["category"].string.capitalized]
        if !t["prs"].array.isEmpty { parts.append("PR " + t["prs"].array.map { "#\($0.string)" }.joined(separator: ", ")) }
        parts.append(OpsFormat.ago(t["createdAt"]))
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func workerTitle(_ w: JSONValue) -> String {
        let ticket = w["ticket"].number.map { "Ticket \(Int($0))" }
        let kind = w["kind"].string == "command" ? "Owner task" : w["kind"].string.capitalized
        return [ticket ?? kind, w["role"].string == "owner" && ticket != nil ? "owner" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}

/// What the ticket screen says about a ticket, decided in one place so the
/// status, the error and the timeline can never disagree with each other.
enum TicketPresentation {
    /// A running worker that has not reported for this long is stale.
    static let staleAfter: TimeInterval = 20 * 60

    /// The ticket's status from the supervisor worker's real state. Running is
    /// only ever reported for a worker that is running, not overdue, not
    /// waiting on the owner and not stale.
    static func status(raw: String, updatedAt: JSONValue = .null, timing: JSONValue = .null, ownerDecision: Bool = false, blocked: Bool = false, now: Date = Date()) -> (status: OpsStatus, label: String) {
        let lowered = raw.lowercased()
        if ownerDecision { return (.waiting, "Needs you") }
        if lowered.contains("abort") || lowered == "stalled" || timing["state"].string == "stalled" { return (.failed, "Stalled") }
        let base = OpsStatus.from(raw)
        if base == .failed { return (.failed, "Failed") }
        if base == .done { return (.done, "Done") }
        if base == .running {
            let seen = [updatedAt, timing["heartbeatAt"]].compactMap(OpsFormat.date).max()
            if timing["stale"].bool || (seen.map { now.timeIntervalSince($0) > staleAfter } ?? true) { return (.failed, "Stalled") }
        }
        if blocked || base == .blocked { return (.blocked, "Blocked") }
        if lowered == "waiting" || lowered == "held" { return (.blocked, "Waiting") }
        switch base {
        case .running: return (.running, "Running")
        case .queued: return (.queued, "Queued")
        case .waiting: return (.waiting, "Waiting")
        default: return (.idle, "Idle")
        }
    }

    /// Server prose with scheduler vocabulary and filler removed. Empty means
    /// there is nothing worth showing.
    static func clean(_ raw: String) -> String {
        let text = OpsText.scrub(raw)
        let lowered = text.lowercased()
        if lowered.contains("activation") || lowered.contains("wait review") || lowered.hasPrefix("one more") { return "" }
        if lowered.contains("has not recorded its next action") { return "" }
        return text
    }

    /// One sentence in sentence case, ending in a full stop.
    static func errorSentence(_ raw: String) -> String {
        let sentence = OpsText.firstSentence(clean(raw))
        guard let first = sentence.first else { return "" }
        let cased = first.uppercased() + sentence.dropFirst()
        return cased.hasSuffix(".") || cased.hasSuffix("!") || cased.hasSuffix("?") ? cased : cased + "."
    }
}

struct TicketDetail: View {
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    let ticket: JSONValue
    @StateObject private var supervision: TicketSupervisionModel
    @State private var detail: JSONValue = .null
    @State private var error: String?
    @State private var retrying = false
    @State private var retryNotice: String?

    init(ticket: JSONValue) {
        self.ticket = ticket
        _supervision = StateObject(wrappedValue: TicketSupervisionModel(number: ticket["number"].string))
    }

    private var number: String { ticket["number"].string }
    private var replyState: JSONValue {
        ops.hub["tickets"].array.first(where: { $0["number"].string == number })?["replyState"] ?? ticket["replyState"]
    }
    private var card: JSONValue { detail["card"] == .null ? ticket["card"] : detail["card"] }
    private var timing: JSONValue {
        .object(ticket["timing"].object.merging(detail["timing"].object.filter { $0.value != .null }) { _, latest in latest })
    }
    private var title: String { OpsText.scrub(ticket["title"].string.nonempty ?? detail["title"].string).nonempty ?? "Ticket #\(number)" }
    private var worker: JSONValue { supervision.worker }
    private var current: JSONValue { detail["current"] }
    private var decisions: [JSONValue] { detail["decisions"].array }
    /// Blockers that are not already shown as a structured decision.
    private var plainBlockers: [JSONValue] { detail["blockers"].array.filter { decisions.isEmpty || $0["kind"].string != "decision" } }
    private var ownerDecision: Bool { !decisions.isEmpty || ticket["decisionPending"].bool || detail["blockers"].array.contains { $0["kind"].string == "decision" } }
    /// Only the supervisor worker's own state counts; with no worker the
    /// ticket's recorded work is used, and nothing is ever assumed running.
    private var status: (status: OpsStatus, label: String) {
        if current == .null && supervision.worker == .null {
            return (WorkQueuePresentation.status(ticket), WorkQueuePresentation.label(ticket))
        }
        let hasWorker = worker != .null
        let job = hasWorker ? worker : current
        let raw = [job["error"].string, job["summary"].string, job["status"].string]
            .contains(where: { $0.lowercased().contains("activation aborted") }) ? "aborted" : job["state"].string
        var measuredTiming = timing.object
        let active = ticket["active"]
        if !hasWorker, active["id"] == current["id"], OpsFormat.date(active["startedAt"]) != nil {
            measuredTiming["heartbeatAt"] = active["startedAt"]
        }
        return TicketPresentation.status(raw: raw, updatedAt: job["updatedAt"],
            timing: .object(measuredTiming), ownerDecision: ownerDecision, blocked: !plainBlockers.isEmpty)
    }
    private var errorLine: String {
        guard status.status == .failed else { return "" }
        if status.label == "Stalled" { return "Keir’s last attempt stopped before it could finish." }
        for raw in [worker["error"].string, current["error"].string, worker["status"].string, current["status"].string] {
            let line = TicketPresentation.errorSentence(raw)
            if !line.isEmpty { return line }
        }
        return ""
    }

    // Three containers: the ticket's facts, the owner's decision (the only
    // standalone card with a stripe), and one grouped card holding Keir's
    // work, the timeline, the reply, actions and details as dense sections.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                OpsCard(padding: 14, spacing: 8) {
                    header
                    statusSection
                }
                decisionSection
                workCard
            }.padding(.horizontal, 16).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            if supervision.state["canMessage"].bool { TicketDirectionComposer(model: supervision) }
        }
        .opsScreen().navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The title stays in the navigation bar, so it is still readable
            // after scrolling; the number sits under it.
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("Ticket #\(number)").font(.caption2).foregroundStyle(OpsTheme.muted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Ticket \(number): \(title)")
            }
        }
        .modifier(TicketSupervisionPolling(model: supervision))
        .refreshable { await load(); await supervision.load(session) }
        .task(id: scenePhase == .active) {
            while scenePhase == .active && !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            // The full title wraps here once; the bar above keeps it reachable.
            Text(title).font(.system(.headline, design: .rounded).weight(.bold)).foregroundStyle(OpsTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text([ticket["category"].string.capitalized, ticket["createdAt"] == .null ? "" : "Opened \(OpsFormat.ago(ticket["createdAt"]))"].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(OpsTheme.muted)
        }.accessibilityElement(children: .combine)
    }

    private var statusSection: some View {
        let expected = OpsFormat.date(timing["expectedDoneAt"])
        let overdue = status.status != .done && (expected.map { $0 <= Date() } ?? false)
        let started = OpsFormat.ago(worker["startedAt"] == .null ? current["startedAt"] : worker["startedAt"])
        let since = OpsFormat.ago(timing["since"])
        return VStack(alignment: .leading, spacing: 6) {
            // Status and owner share one line.
            HStack(alignment: .center, spacing: 8) {
                OpsStatusBadge(status: status.status, label: status.label, compact: true, state: OpsWorkState.from(label: status.label))
                Spacer(minLength: 8)
                HStack(spacing: 4) {
                    Text("Owner").font(.subheadline).foregroundStyle(OpsTheme.muted)
                    Text(supervision.state == .null ? "Checking" : supervision.ownerWord).font(.subheadline.weight(.semibold))
                }
            }.accessibilityElement(children: .combine)
            if !started.isEmpty { row("Current attempt started") { Text(started).font(.subheadline.weight(.medium)) } }
            else if !since.isEmpty { row("In this state since") { Text(since).font(.subheadline.weight(.medium)) } }
            if overdue || expected != nil {
                row("Keir expected to finish") {
                    if overdue {
                        Label(expected.map { "Overdue, was \(OpsFormat.contextual($0))" } ?? "Overdue", systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.medium)).foregroundStyle(OpsTheme.caution)
                    } else if let expected {
                        Text(OpsFormat.contextual(expected)).font(.subheadline.weight(.medium))
                    }
                }
            }
            if let deadline = OpsFormat.date(timing["deadline"]) {
                row("Deadline") { Text(deadline.formatted(date: .abbreviated, time: .omitted) + " · " + OpsFormat.clock(deadline)).font(.subheadline.weight(.medium)) }
            }
        }.accessibilityIdentifier("ticket-status")
    }

    private func row<V: View>(_ key: String, @ViewBuilder _ value: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(key).font(.subheadline).foregroundStyle(OpsTheme.muted)
            Spacer(minLength: 12)
            value().multilineTextAlignment(.trailing)
        }.accessibilityElement(children: .combine)
    }

    @ViewBuilder private var decisionSection: some View {
        if !decisions.isEmpty || !plainBlockers.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                OpsMiniHeader(text: "Your decision", state: .needsYou)
                ForEach(Array(plainBlockers.enumerated()), id: \.offset) { _, blocker in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(OpsText.scrub(blocker["title"].string)).font(.subheadline.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                        if !blocker["detail"].string.isEmpty && blocker["detail"] != blocker["title"] { Text(blocker["detail"].string).font(.subheadline).textSelection(.enabled) }
                    }
                }
                ForEach(decisions, id: \.["id"].string) { TicketDecisionInline(decision: $0) { await load() } }
            }
            .opsStripeCard(OpsWorkState.needsYou.color)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("ticket-blockers")
        }
    }

    private var progressLine: String {
        let line = TicketPresentation.clean(current["status"].string).nonempty ?? TicketPresentation.clean(worker["status"].string)
        return line != playerReply && line != TicketPresentation.clean(card["status"].string) && errorLine.isEmpty ? line : ""
    }
    private var hasWork: Bool { !errorLine.isEmpty || !progressLine.isEmpty || error != nil }
    private var replyDelivery: String { verifiedReply == nil ? replyState["state"].string : "delivered" }
    private var hasReply: Bool { !playerReply.isEmpty || ["delivered", "no_receipt"].contains(replyDelivery) }

    /// Keir's work, what happened, what the player was told and what the
    /// owner can do, as sections of one surface.
    private var workCard: some View {
        let items = timeline
        return VStack(alignment: .leading, spacing: 0) {
            if hasWork || !items.isEmpty {
                block("Keir's work") {
                    if hasWork { workSection }
                    if !items.isEmpty { timelineRows(items) }
                }
            }
            if hasReply {
                if hasWork || !items.isEmpty { OpsGroupDivider(inset: 0) }
                block("Reply to the player") { replySection }
            }
            if hasWork || !items.isEmpty || hasReply { OpsGroupDivider(inset: 0) }
            block("Actions") { actionsSection }
            OpsGroupDivider(inset: 0)
            detailsSection
        }
        .padding(.horizontal, 14)
        .opsSurface()
    }

    private func block<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            OpsMiniHeader(text: title)
            content()
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var workSection: some View {
        let progress = progressLine
        if !errorLine.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OpsStateGlyph(state: .stalled)
                Text(errorLine).font(.subheadline).foregroundStyle(OpsTheme.ink).fixedSize(horizontal: false, vertical: true)
            }
        }
        if status.label == "Stalled", let task = detail["retryTaskId"].string.nonempty {
            OpsPrimaryButton(title: "Retry", icon: "arrow.clockwise", busy: retrying) {
                retrying = true
                Task {
                    defer { retrying = false }
                    do {
                        _ = try await session.post("/api/keir/app/tickets/\(number)/retry", ["taskId": .string(task)])
                        retryNotice = "Another attempt is queued"
                        await load()
                    } catch { retryNotice = error.displayMessage }
                }
            }
            if retryNotice == nil {
                Text(lastAttemptLine).font(.opsCaption).foregroundStyle(OpsTheme.muted)
            }
        }
        if let retryNotice { Text(retryNotice).font(.opsCaption).foregroundStyle(OpsTheme.muted) }
        if !progress.isEmpty { Text(progress).font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
        if let error { Text(error).font(.opsCaption).foregroundStyle(OpsTheme.danger) }
    }

    /// Something the owner cannot see elsewhere: when the stopped attempt
    /// last ran, and that a retry starts from Keir's saved result.
    private var lastAttemptLine: String {
        let at = current["updatedAt"] == .null ? timing["since"] : current["updatedAt"]
        let when = OpsFormat.date(at).map { date -> String in
            let text = OpsFormat.contextual(date)
            return "Last attempt " + (text.hasPrefix("Yesterday") ? "yesterday" + text.dropFirst("Yesterday".count) : text) + ". "
        } ?? ""
        return when + "Retry starts a new attempt from Keir’s saved result."
    }

    /// Receipts and history as one newest-first list.
    private var timeline: [(id: String, icon: String, color: Color, text: String, at: JSONValue)] {
        var items: [(Date, String, String, Color, String, JSONValue)] = []
        for (i, r) in detail["receipts"].array.enumerated() {
            let done = r["state"].string == "done"
            items.append((OpsFormat.date(r["at"]) ?? .distantPast, "r\(i)", done ? "checkmark.circle" : "clock", done ? OpsTheme.mint : OpsTheme.muted, r["label"].string, r["at"]))
        }
        for (i, h) in detail["history"].array.enumerated() {
            let text = TicketPresentation.clean(h["text"].string)
            if text.isEmpty || text == playerReply { continue }
            items.append((OpsFormat.date(h["at"]) ?? .distantPast, "h\(i)", "circle.fill", OpsTheme.muted, text, h["at"]))
        }
        if status.label == "Stalled" {
            let at = current["updatedAt"] == .null ? timing["since"] : current["updatedAt"]
            items.append((OpsFormat.date(at) ?? .distantPast, "stalled", "circle.fill", OpsWorkState.stalled.color, "Attempt stalled", at))
        }
        return items.sorted { $0.0 > $1.0 }.map { ($0.1, $0.2, $0.3, $0.4, $0.5) }
    }

    /// One dense line per event: dot, what happened, when.
    private func timelineRows(_ items: [(id: String, icon: String, color: Color, text: String, at: JSONValue)]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(items, id: \.id) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle().fill(item.color).frame(width: 7, height: 7).accessibilityHidden(true)
                    Text(item.text).font(.subheadline).foregroundStyle(OpsTheme.ink).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 6)
                    Text(OpsFormat.date(item.at).map(OpsFormat.contextual) ?? "").font(.caption).monospacedDigit()
                        .foregroundStyle(OpsTheme.muted).lineLimit(1)
                }.accessibilityElement(children: .combine)
            }
        }.padding(.top, 2)
    }

    private var verifiedReply: JSONValue? {
        detail["history"].array.first { $0["kind"].string == "Player reply" }
    }

    private var playerReply: String { verifiedReply?["text"].string.nonempty ?? "" }

    @ViewBuilder private var replySection: some View {
        let reply = playerReply
        if !reply.isEmpty {
            // A quote bar marks this as the player's own copy, not Keir's notes.
            NativeMarkdown(text: reply).font(.subheadline).textSelection(.enabled)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Capsule().fill(OpsTheme.accent.opacity(0.5)).frame(width: 3) }
        }
        if replyDelivery == "delivered" {
            // The receipt itself: delivered, and when, with the link on the same line.
            let deliveredAt = OpsFormat.date(verifiedReply?["at"] ?? replyState["at"]).map { " · " + OpsFormat.contextual($0) } ?? ""
            let address = verifiedReply?["url"].string.nonempty ?? replyState["url"].string
            HStack(spacing: 12) {
                Label("Delivered in Discord" + deliveredAt, systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.mint)
                Spacer(minLength: 0)
                if let url = URL(string: address), url.scheme == "https", url.host == "discord.com" {
                    Link(destination: url) { Label("View", systemImage: "arrow.up.right.square") }
                        .font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.accent)
                        .accessibilityLabel("View in Discord")
                }
            }
        } else {
            Label("No Discord receipt", systemImage: "bubble.left").font(.callout).foregroundStyle(OpsTheme.unanswered)
        }
    }

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            TicketDirectionsList(model: supervision)
            HStack(spacing: 18) {
                // The composer pinned below carries direction; without it the
                // sheet is the only way to give Keir an instruction.
                if !supervision.state["canMessage"].bool {
                    OwnerDirectionButton(title: "Message Keir", context: "Ticket #\(number)")
                        .font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.accent)
                }
                TicketOwnershipActions(model: supervision)
                Spacer(minLength: 0)
            }
            if supervision.state["canTake"].bool {
                Text("Take over: you handle this ticket and Keir stops working on it until you hand it back.")
                    .font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var detailsSection: some View {
        let summary = OpsText.scrub(current["summary"].string)
        let next = OpsText.scrub(worker["nextAction"].string)
        let tasks = detail["tasks"].array.filter { $0["canOpen"].bool }
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 16) {
                if !summary.isEmpty && summary != TicketPresentation.clean(current["status"].string) { NativeMarkdown(text: current["summary"].string) }
                if !next.isEmpty && next != TicketPresentation.clean(worker["status"].string) { Text("Next step: \(next)").font(.callout).textSelection(.enabled) }
                ForEach(tasks, id: \.["id"].string) { task in
                    NavigationLink("Open task: \(task["summary"].string.nonempty ?? task["state"].string)") { TaskDetail(id: task["id"].string) }
                }
                if !card["items"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        SectionLabel(text: "Fixes")
                        ForEach(Array(card["items"].array.enumerated()), id: \.offset) { _, item in
                            WorkRow(title: item["name"].string, meta: item["note"].string, bar: item["blocked"].bool ? OpsWorkState.blocked.color : nil) { StageChip(stage: item["stage"].string) }
                            Hairline()
                        }
                    }
                }
                if !detail["pullRequests"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(text: "Code changes")
                        ForEach(detail["pullRequests"].array, id: \.string) { pr in
                            if let url = URL(string: pr.string) { Link(pr.string, destination: url).font(.callout).lineLimit(1) }
                        }
                        Text("A change being accepted does not prove the fix is live. Release stages follow Keir's verified receipts.").font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                }
                if !detail["handoffs"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionLabel(text: "Owner instructions")
                        ForEach(detail["handoffs"].array, id: \.["id"].string) { handoff in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(handoff["status"].string.replacingOccurrences(of: "Support " + "Keir", with: "the support desk")).font(.callout.weight(.semibold))
                                Text("Delivered \(OpsFormat.ago(handoff["at"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                                if handoff["incorporatedAt"] != .null {
                                    Text("Read by the support desk \(OpsFormat.ago(handoff["incorporatedAt"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                                }
                                Text("Delivery and incorporation do not mean the ticket work is complete.").font(.caption).foregroundStyle(OpsTheme.muted)
                            }
                        }
                    }.accessibilityIdentifier("ticket-handoffs")
                }
                if worker != .null { SupervisedWorkerSummary(worker: worker, active: supervision.supervised) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
        } label: {
            Text("Details").font(.footnote.weight(.semibold)).foregroundStyle(OpsTheme.muted)
        }
        .font(.callout)
        .tint(OpsTheme.muted)
        .padding(.vertical, 10)
    }

    private func load() async {
        do { detail = try await session.get("/api/keir/app/tickets/\(number)"); error = nil }
        catch { if !Task.isCancelled { self.error = error.displayMessage } }
    }
}

/// An open decision. A structured choice with real options answers inline
/// through the same decision endpoint the decision card uses; anything else
/// (approvals, choices without options) keeps the full decision card.
struct TicketDecisionInline: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    let decision: JSONValue
    var showQuestion = true
    var changed: () async -> Void
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var outcome: String?
    @State private var failure: String?
    @State private var busy = false

    private var options: [JSONValue] { decision["options"].array.filter { !$0["id"].string.isEmpty && !$0["label"].string.isEmpty } }
    private var inline: Bool { decision["type"].string == "choice" && options.count >= 2 && decision["canAnswer"] != .bool(false) }

    var body: some View {
        if !inline {
            DecisionCard(decision: decision, changed: changed)
        } else if let outcome {
            Label(outcome, systemImage: "checkmark.circle").font(.callout).foregroundStyle(OpsTheme.muted)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                // One question line, never three stacked headings: the full
                // question when there is one, the short title otherwise.
                let question = OpsText.scrub(decision["question"].string)
                let line = question.nonempty ?? OpsText.decisionTitle(decision)
                if showQuestion || !question.isEmpty {
                    Text(line).font(.subheadline.weight(.semibold)).foregroundStyle(OpsTheme.ink).fixedSize(horizontal: false, vertical: true)
                }
                if let pick = recommended {
                    OpsIconLine(text: "Keir recommends: " + pick["label"].string, icon: "star.fill",
                                color: OpsTheme.accent, font: .caption.weight(.semibold))
                }
                if let failure { Text(failure).font(.caption).foregroundStyle(OpsTheme.danger) }
                if explained {
                    VStack(spacing: 6) { buttons }.disabled(busy)
                } else {
                    let layout = options.count > 2 || textSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
                    layout { buttons }.disabled(busy)
                    // The effect of each option is not in the data: say so
                    // plainly and keep a way to ask, instead of a bare guess.
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("Keir has not said what each option changes.").font(.caption).foregroundStyle(OpsTheme.muted)
                        OwnerDirectionButton(title: "Ask", context: "Decision \(decision["id"].string): \(line)")
                            .font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.accent)
                    }
                }
            }
        }
    }

    /// Options that carry a one-line effect are listed full width so the
    /// effect can sit under each label.
    private var explained: Bool { options.contains { !$0["detail"].string.isEmpty } }
    private var recommended: JSONValue? { options.first { $0["recommended"].bool } }

    @ViewBuilder private var buttons: some View {
        ForEach(options, id: \.["id"].string) { option in
            let isPick = option["recommended"].bool
            let effect = OpsText.scrub(option["detail"].string)
            Button { choose(option["id"].string) } label: {
                if explained {
                    // Label, then the one-line effect for players, left aligned
                    // so the two options read as a comparison.
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(option["label"].string).font(.subheadline.weight(.semibold)).lineLimit(2)
                                if isPick {
                                    Text("Recommended").font(.caption2.weight(.bold))
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(OpsTheme.onAccent.opacity(0.22), in: Capsule())
                                }
                            }
                            Text(effect.nonempty ?? "No effect described").font(.caption).opacity(effect.isEmpty ? 0.6 : 0.9)
                                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right.circle.fill").font(.callout).opacity(0.8).accessibilityHidden(true)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .background(isPick ? OpsTheme.sky : OpsTheme.sky.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(isPick ? Color.clear : OpsTheme.sky.opacity(0.35)))
                    .foregroundStyle(isPick ? OpsTheme.onAccent : OpsTheme.ink)
                } else {
                    Text(option["label"].string).font(.subheadline.weight(.semibold)).lineLimit(2).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 10)
                        .background(isPick ? OpsTheme.sky : OpsTheme.sky.opacity(0.85), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .foregroundStyle(OpsTheme.onAccent)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(option["label"].string + (isPick ? ", recommended" : "") + (effect.isEmpty ? "" : ". " + effect))
            .accessibilityIdentifier("ticket-decision-\(option["id"].string)")
        }
    }

    private func choose(_ id: String) {
        busy = true
        Task {
            if await ops.answer(decision["id"].string, verdict: "choose:" + id, session) {
                outcome = "Choice saved. Keir will continue with your selection."
                await changed()
            } else { failure = ops.error ?? "The choice could not be saved. Refresh and try again." }
            busy = false
        }
    }
}

/// The release pipeline as Keir reports it to players.
struct StageChip: View {
    let stage: String
    var body: some View {
        let (label, color): (String, Color) = switch stage {
        case "main": ("Live", OpsTheme.mint)
        case "sandbox", "staging": ("Sandbox", OpsTheme.sky)
        case "dev", "development": ("Dev", OpsTheme.sky)
        case "built", "pr": ("Built", OpsTheme.muted)
        default: (stage.capitalized, OpsTheme.muted)
        }
        Text(label).font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 3).overlay(Capsule().strokeBorder(color.opacity(0.5)))
    }
}

private struct WorkerDetail: View {
    let worker: JSONValue
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { OpsStatusBadge(status: OpsStatus.from(worker["state"].string)); Spacer(); Text(OpsFormat.ago(worker["updatedAt"])).font(.caption).foregroundStyle(OpsTheme.muted) }
                Text(worker["summary"].string.nonempty ?? "No summary yet.").font(.body).textSelection(.enabled)
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "Run")
                    row("Model", "\(worker["runner"].string) · \(worker["model"].string)")
                    row("Effort", worker["effort"].string)
                    row("Rounds", worker["rounds"].string)
                    row("Engine", worker["via"].string)
                    if worker["wakeAt"].number != nil { row("Wakes", OpsFormat.ago(worker["wakeAt"])) }
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }.opsScreen().navigationTitle(worker["ticket"].number.map { "Ticket \(Int($0))" } ?? "Task").navigationBarTitleDisplayMode(.inline)
    }
    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundStyle(OpsTheme.muted); Spacer(); Text(v.nonempty ?? "-").monospacedDigit() }.font(.callout)
    }
}
