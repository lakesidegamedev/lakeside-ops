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
                if workers.isEmpty { Text("No live workers.").foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear) }
                ForEach(workers, id: \.["id"].string) { worker in
                    NavigationLink { WorkerDetail(worker: worker) } label: {
                        WorkRow(title: workerTitle(worker), meta: "\(worker["runner"].string) · \(worker["model"].string)\(worker["effort"].string.isEmpty ? "" : " @\(worker["effort"].string)") · \(OpsFormat.ago(worker["updatedAt"]))", bar: OpsState.color(worker["state"].string)) {
                            OpsStatusBadge(status: OpsState.status(worker["state"].string), compact: true)
                        }
                    }
                }.listRowBackground(Color.clear)
            } header: { SectionLabel(text: "Workers", count: workers.count) }
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
        if lowered.contains("abort") { return (.failed, "Stalled") }
        let base = OpsStatus.from(raw)
        if base == .failed { return (.failed, "Failed") }
        if base == .done { return (.done, "Done") }
        if ownerDecision { return (.waiting, "Waiting on you") }
        if base == .running {
            let seen = [updatedAt, timing["heartbeatAt"]].compactMap(OpsFormat.date).max()
            if timing["stale"].bool || (seen.map { now.timeIntervalSince($0) > staleAfter } ?? true) { return (.blocked, "Stalled") }
        }
        if blocked || base == .blocked { return (.blocked, "Blocked") }
        let expected = OpsFormat.date(timing["expectedDoneAt"])
        if timing["overdue"].bool || (expected.map { $0 <= now } ?? false) { return (.blocked, "Overdue") }
        if lowered == "waiting" || lowered == "held" { return (.waiting, "Waiting") }
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

    init(ticket: JSONValue) {
        self.ticket = ticket
        _supervision = StateObject(wrappedValue: TicketSupervisionModel(number: ticket["number"].string))
    }

    private var number: String { ticket["number"].string }
    private var replyState: JSONValue {
        ops.hub["tickets"].array.first(where: { $0["number"] == ticket["number"] })?["replyState"] ?? ticket["replyState"]
    }
    private var card: JSONValue { detail["card"] == .null ? ticket["card"] : detail["card"] }
    private var timing: JSONValue { detail["timing"] == .null ? ticket["timing"] : detail["timing"] }
    private var title: String { OpsText.scrub(ticket["title"].string).nonempty ?? "Ticket #\(number)" }
    private var worker: JSONValue { supervision.worker }
    private var current: JSONValue { detail["current"] }
    private var decisions: [JSONValue] { detail["decisions"].array }
    /// Blockers that are not already shown as a structured decision.
    private var plainBlockers: [JSONValue] { detail["blockers"].array.filter { decisions.isEmpty || $0["kind"].string != "decision" } }
    private var ownerDecision: Bool { !decisions.isEmpty || ticket["decisionPending"].bool || detail["blockers"].array.contains { $0["kind"].string == "decision" } }
    /// Only the supervisor worker's own state counts; with no worker the
    /// ticket's recorded work is used, and nothing is ever assumed running.
    private var status: (status: OpsStatus, label: String) {
        let hasWorker = worker != .null
        let job = hasWorker ? worker : current
        let raw = [job["error"].string, job["summary"].string, job["status"].string]
            .contains(where: { $0.lowercased().contains("activation aborted") }) ? "aborted" : job["state"].string
        return TicketPresentation.status(
            raw: raw,
            updatedAt: hasWorker ? worker["updatedAt"] : current["updatedAt"],
            timing: timing, ownerDecision: ownerDecision, blocked: !plainBlockers.isEmpty)
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                statusSection
                decisionSection
                workSection
                timelineSection
                replySection
                actionsSection
                detailsSection
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            if supervision.state["canMessage"].bool { TicketDirectionComposer(model: supervision) }
        }
        .opsScreen().navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title).font(.headline).lineLimit(1)
                    Text("#\(number)").font(.caption2).foregroundStyle(OpsTheme.muted)
                }.accessibilityElement(children: .combine)
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
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title2.weight(.semibold)).tracking(-0.4).fixedSize(horizontal: false, vertical: true)
            Text(["#\(number)", ticket["category"].string.capitalized, ticket["createdAt"] == .null ? "" : "opened \(OpsFormat.ago(ticket["createdAt"]))"].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(OpsTheme.muted)
        }.accessibilityElement(children: .combine)
    }

    private var statusSection: some View {
        let expected = OpsFormat.date(timing["expectedDoneAt"])
        let overdue = status.label == "Overdue" || (status.status != .done && status.status != .failed && (timing["overdue"].bool || (expected.map { $0 <= Date() } ?? false)))
        let started = OpsFormat.ago(worker["startedAt"] == .null ? current["startedAt"] : worker["startedAt"])
        let since = OpsFormat.ago(timing["since"])
        return VStack(alignment: .leading, spacing: 10) {
            row("Status") { OpsStatusBadge(status: status.status, label: status.label, compact: true) }
            row("Owner") { Text(supervision.state == .null ? "Checking" : supervision.ownerWord).font(.callout) }
            if !started.isEmpty { row("Started") { Text(started).font(.callout) } }
            else if !since.isEmpty { row("Status since") { Text(since).font(.callout) } }
            row("Estimate") {
                if overdue {
                    Label(expected.map { "Overdue, was \(OpsFormat.clock($0))" } ?? "Overdue", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(OpsTheme.warn)
                } else {
                    Text(expected.map { OpsFormat.clock($0) } ?? "Not set").font(.callout)
                }
            }
            row("Deadline") { Text(OpsFormat.date(timing["deadline"]).map { $0.formatted(date: .abbreviated, time: .omitted) + " at " + OpsFormat.clock($0) } ?? "None").font(.callout) }
        }.accessibilityIdentifier("ticket-status")
    }

    private func row<V: View>(_ key: String, @ViewBuilder _ value: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(key).font(.callout).foregroundStyle(OpsTheme.muted)
            Spacer(minLength: 12)
            value().multilineTextAlignment(.trailing)
        }.accessibilityElement(children: .combine)
    }

    @ViewBuilder private var decisionSection: some View {
        if !decisions.isEmpty || !plainBlockers.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Decision")
                ForEach(Array(plainBlockers.enumerated()), id: \.offset) { _, blocker in
                    VStack(alignment: .leading, spacing: 4) {
                        Label(OpsText.scrub(blocker["title"].string), systemImage: OpsStatus.blocked.icon).font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.warn)
                        if !blocker["detail"].string.isEmpty && blocker["detail"] != blocker["title"] { Text(blocker["detail"].string).font(.callout).textSelection(.enabled) }
                    }
                }
                ForEach(decisions, id: \.["id"].string) { TicketDecisionInline(decision: $0) { await load() } }
            }.accessibilityIdentifier("ticket-blockers")
        }
    }

    private var workSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Keir's work")
            if !errorLine.isEmpty {
                Label(errorLine, systemImage: OpsStatus.failed.icon).font(.callout).foregroundStyle(OpsTheme.danger)
            }
            let line = TicketPresentation.clean(current["status"].string).nonempty ?? TicketPresentation.clean(worker["status"].string)
            if !line.isEmpty && line != playerReply && line != TicketPresentation.clean(card["status"].string) && TicketPresentation.errorSentence(line) != errorLine {
                Text(line).font(.body).textSelection(.enabled)
            }
            if current != .null {
                let updated = OpsFormat.ago(current["updatedAt"])
                if !updated.isEmpty { Text("Updated \(updated)").font(.caption).foregroundStyle(OpsTheme.muted) }
            } else if let error {
                Text(error).font(.callout).foregroundStyle(OpsTheme.warn)
                Button("Retry ticket activity") { Task { await load() } }
            } else if detail != .null {
                Text("Keir has no recorded work on this ticket yet.").font(.callout).foregroundStyle(OpsTheme.muted)
            } else {
                Text("Loading Keir's ticket activity").font(.callout).foregroundStyle(OpsTheme.muted)
            }
        }
    }

    /// Receipts and history as one newest-first list.
    private var timeline: [(id: String, icon: String, color: Color, text: String, at: JSONValue)] {
        var items: [(Date, String, String, Color, String, JSONValue)] = []
        for (i, r) in detail["receipts"].array.enumerated() {
            let done = r["state"].string == "done"
            items.append((OpsFormat.date(r["at"]) ?? .distantPast, "r\(i)", done ? "checkmark.circle" : "clock", done ? OpsTheme.mint : OpsTheme.warn, r["label"].string, r["at"]))
        }
        for (i, h) in detail["history"].array.enumerated() {
            let text = TicketPresentation.clean(h["text"].string)
            if text.isEmpty || text == playerReply { continue }
            items.append((OpsFormat.date(h["at"]) ?? .distantPast, "h\(i)", "circle.fill", OpsTheme.muted, text, h["at"]))
        }
        return items.sorted { $0.0 > $1.0 }.map { ($0.1, $0.2, $0.3, $0.4, $0.5) }
    }

    @ViewBuilder private var timelineSection: some View {
        let items = timeline
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Timeline")
                ForEach(items, id: \.id) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: item.icon).font(.caption).foregroundStyle(item.color).frame(width: 18).padding(.top, 3).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.text).font(.callout).textSelection(.enabled)
                            let when = OpsFormat.ago(item.at)
                            if !when.isEmpty { Text(when).font(.caption).foregroundStyle(OpsTheme.muted) }
                        }
                    }
                }
            }
        }
    }

    private var playerReply: String {
        let update = detail["history"].array.first { $0["kind"].string == "Player update" }
        return update?["text"].string.nonempty ?? ""
    }

    @ViewBuilder private var replySection: some View {
        let reply = playerReply
        let summary = TicketPresentation.clean(card["status"].string)
        let delivery = replyState["state"].string
        if !reply.isEmpty || !summary.isEmpty || delivery == "delivered" || delivery == "no_receipt" {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Player-facing reply")
                if !reply.isEmpty { NativeMarkdown(text: reply).textSelection(.enabled) }
                else if !summary.isEmpty { Text(summary).font(.body).textSelection(.enabled) }
                if delivery == "delivered" {
                    if let url = URL(string: replyState["url"].string), url.scheme == "https", url.host == "discord.com" {
                        Link(destination: url) { Label("View in Discord", systemImage: "arrow.up.right.square") }.font(.callout)
                    } else {
                        Label("Delivered to Discord", systemImage: "checkmark.bubble").font(.callout).foregroundStyle(OpsTheme.mint)
                    }
                } else if delivery == "no_receipt" {
                    Label("No Discord receipt", systemImage: "bubble.left").font(.callout).foregroundStyle(OpsTheme.warn)
                }
            }
        }
    }

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Actions")
            TicketDirectionsList(model: supervision)
            // The composer pinned above carries direction; without it the
            // sheet is the only way to give Keir an instruction.
            if !supervision.state["canMessage"].bool {
                OwnerDirectionButton(title: "Message Keir", context: "Ticket #\(number)")
            }
            TicketOwnershipActions(model: supervision)
        }
    }

    @ViewBuilder private var detailsSection: some View {
        let summary = OpsText.scrub(current["summary"].string)
        let next = OpsText.scrub(worker["nextAction"].string)
        let tasks = detail["tasks"].array.filter { $0["canOpen"].bool }
        DisclosureGroup("Details") {
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
                            WorkRow(title: item["name"].string, meta: item["note"].string, bar: item["blocked"].bool ? OpsTheme.warn : nil) { StageChip(stage: item["stage"].string) }
                            Hairline()
                        }
                    }
                }
                if !detail["pullRequests"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(text: "Pull requests")
                        ForEach(detail["pullRequests"].array, id: \.string) { pr in
                            if let url = URL(string: pr.string) { Link(pr.string, destination: url).font(.callout).lineLimit(1) }
                        }
                        Text("A merged PR is not proof that a fix is live. Release stages follow Keir's verified receipts.").font(.caption).foregroundStyle(OpsTheme.muted)
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
        }.font(.callout)
    }

    private func load() async {
        do { detail = try await session.get("/api/keir/app/tickets/\(number)"); error = nil }
        catch { if !Task.isCancelled { self.error = error.displayMessage } }
    }
}

/// An open decision. A structured choice with real options answers inline
/// through the same decision endpoint the decision card uses; anything else
/// (approvals, choices without options) keeps the full decision card.
private struct TicketDecisionInline: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    let decision: JSONValue
    var changed: () async -> Void
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
            VStack(alignment: .leading, spacing: 10) {
                let headline = OpsText.decisionTitle(decision)
                Text(headline).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                let question = OpsText.scrub(decision["question"].string)
                if !question.isEmpty && question != headline { Text(question).font(.callout).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true) }
                if let failure { Text(failure).font(.caption).foregroundStyle(OpsTheme.warn) }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { buttons }
                    VStack(spacing: 8) { buttons }
                }.disabled(busy)
            }
        }
    }

    @ViewBuilder private var buttons: some View {
        ForEach(options, id: \.["id"].string) { option in
            let recommended = option["recommended"].bool
            Button { choose(option["id"].string) } label: {
                Text(option["label"].string).fontWeight(.semibold).lineLimit(2).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 8)
                    .background(recommended ? OpsTheme.sky : OpsTheme.raised, in: Capsule())
                    .foregroundStyle(recommended ? OpsTheme.onAccent : OpsTheme.ink)
            }.buttonStyle(.plain).accessibilityIdentifier("ticket-decision-\(option["id"].string)")
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
