import SwiftUI
import UIKit
import LakesideCore

// From a chat turn to the live action.
//
// In the private supervisor conversation, an owner message such as "take over
// ticket 123" gets one quiet row under it. The row never acts. It opens a sheet
// that reads the real ticket, shows what the action would do and who the worker
// is, and acts only on an explicit tap, with the ticket revision and a request
// id so a retry cannot run twice. Text written by Keir, a worker or a player is
// never parsed for commands; see `ConversationIntentParser`.
//
// The one integration point is `keirConversationActions(for:)`, applied once in
// `KeirMessage`.

extension View {
    func keirConversationActions(for message: JSONValue) -> some View {
        modifier(KeirConversationActionsModifier(message: message))
    }
}

@MainActor private struct KeirConversationActionsModifier: ViewModifier {
    let message: JSONValue
    func body(content: Content) -> some View {
        let intent = ConversationIntentParser.intent(for: message, inSupervisorThread: OpsServices.shared.keir.isSupervisor)
        if let intent {
            VStack(alignment: message["role"].string == "owner" ? .trailing : .leading, spacing: 8) {
                content
                KeirConversationActionRow(message: message, intent: intent)
            }
        } else {
            content
        }
    }
}

/// What each message already did, kept on this device so the row still shows
/// the result after a relaunch and a retry reuses its request id.
@MainActor final class ConversationActionHistory: ObservableObject {
    static let shared = ConversationActionHistory()
    @Published private(set) var ledger: ConversationActionLedger
    private let defaults: UserDefaults
    private let storageKey = "keir-conversation-actions-v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: "keir-conversation-actions-v1"), let saved = try? JSONDecoder().decode(ConversationActionLedger.self, from: data) { ledger = saved }
        else { ledger = ConversationActionLedger() }
    }
    func requestID(for key: String, op: ConversationOp, ticket: Int, text: String) -> String? {
        var next = ledger
        let id = next.requestID(for: key, op: op, ticket: ticket, text: text, now: Date().timeIntervalSince1970)
        ledger = next; save()
        return id
    }
    func complete(_ key: String, outcome: ConversationActionOutcome) {
        var next = ledger
        next.complete(key, outcome: outcome, now: Date().timeIntervalSince1970)
        ledger = next; save()
    }
    func discard(_ key: String) {
        var next = ledger
        next.discardPending(key)
        ledger = next; save()
    }
    private func save() {
        if let data = try? JSONEncoder().encode(ledger) { defaults.set(data, forKey: storageKey) }
    }
}

// MARK: row under the message

private struct KeirConversationActionRow: View {
    @EnvironmentObject private var session: AppSession
    @ObservedObject private var history = ConversationActionHistory.shared
    let message: JSONValue
    let intent: ConversationIntent
    @State private var presenting = false

    private var key: String? {
        guard let op = intent.op, let ticket = intent.ticket else { return nil }
        let scope = KeirResume.scope(profile: session.profile, server: Surface.ops.base) ?? ""
        return ConversationActionLedger.key(scope: scope, messageID: message["id"].string, op: op, ticket: ticket)
    }
    private var record: ConversationActionRecord? { key.flatMap { history.ledger.record(for: $0) } }

    private var title: String {
        switch intent {
        case .take(let n, _): return "Take over ticket #\(n)"
        case .handback(let n, _): return "Hand ticket #\(n) back to the support desk"
        case .message(let n, _): return "Message Keir on ticket #\(n)"
        case .approvals: return "Review approvals"
        case .proposal: return "Review this proposal"
        }
    }
    private var subtitle: String {
        if let record {
            if record.done, let outcome = record.outcome { return outcome.headline + " " + OpsFormat.ago(Date(timeIntervalSince1970: record.at)) }
            return "Sent, but not confirmed yet. Open to check the ticket and retry safely."
        }
        switch intent {
        case .approvals, .proposal: return "Opens the real approval. Nothing is approved until you tap it."
        default: return "Review the live ticket, then confirm. Nothing changes until you do."
        }
    }
    private var symbol: String {
        if record?.done == true { return "checkmark.circle.fill" }
        if record != nil { return "exclamationmark.circle" }
        switch intent {
        case .take: return "person.badge.plus"
        case .handback: return "arrow.uturn.backward.circle"
        case .message: return "text.bubble"
        case .approvals, .proposal: return "checkmark.shield"
        }
    }
    private var tint: Color { record?.done == true ? OpsTheme.mint : record != nil ? OpsTheme.warn : OpsTheme.sky }

    var body: some View {
        Button { presenting = true } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol).foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.callout.weight(.semibold))
                    Text(subtitle).font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(OpsTheme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(OpsTheme.hairline))
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 320, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("keir-action-row")
        .sheet(isPresented: $presenting) {
            switch intent {
            case .take(let n, let text): KeirTicketActionSheet(key: key ?? "", op: .take, ticket: n, prefill: text)
            case .handback(let n, let text): KeirTicketActionSheet(key: key ?? "", op: .handback, ticket: n, prefill: text)
            case .message(let n, let text): KeirTicketActionSheet(key: key ?? "", op: .message, ticket: n, prefill: text)
            case .approvals: KeirApprovalsSheet(focus: nil)
            case .proposal(let id): KeirApprovalsSheet(focus: id)
            }
        }
    }
}

// MARK: ticket action sheet

private struct KeirTicketActionSheet: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var history = ConversationActionHistory.shared
    let key: String
    let op: ConversationOp
    let ticket: Int
    @State private var text: String
    @State private var supervision: JSONValue = .null
    @State private var missing = false
    @State private var loadError: String?
    @State private var notice: String?
    @State private var busy = false

    init(key: String, op: ConversationOp, ticket: Int, prefill: String) {
        self.key = key; self.op = op; self.ticket = ticket
        _text = State(initialValue: prefill)
    }

    private var record: ConversationActionRecord? { history.ledger.record(for: key) }
    private var ticketRow: JSONValue {
        ops.hub["tickets"].array.first { $0["number"].string == String(ticket) } ?? .object(["number": .string(String(ticket))])
    }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if supervision == .null && !missing && loadError == nil { ProgressView("Reading ticket #\(ticket)") }
                    if missing {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("No supervision record for ticket #\(ticket)", systemImage: "questionmark.circle").font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.warn)
                            Text("Either this server cannot take over tickets yet, or Keir has never worked this one. Nothing was changed.").font(.callout).foregroundStyle(OpsTheme.muted)
                        }
                    }
                    if let loadError {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(loadError).font(.callout).foregroundStyle(OpsTheme.warn)
                            Button("Try again") { Task { await reload() } }
                        }
                    }
                    if supervision != .null { liveState }
                    if let outcome = record?.outcome, record?.done == true { outcomeView(outcome) }
                    else if supervision != .null { actionArea }
                    if let notice { Text(notice).font(.callout).foregroundStyle(OpsTheme.warn).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("keir-action-notice") }
                    NavigationLink { TicketDetail(ticket: ticketRow) } label: { Label("Open the full ticket", systemImage: "doc.text") }
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }
            .opsScreen()
            .navigationTitle("Ticket #\(ticket)").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await reload() }
            .task { await reload() }
        }
    }

    // What the server says right now.
    @ViewBuilder private var liveState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(supervision["label"].string.nonempty ?? "Ticket #\(ticket)").font(.headline)
            if supervision["worker"] != .null {
                let worker = supervision["worker"]
                VStack(alignment: .leading, spacing: 4) {
                    SectionLabel(text: "Takeover session")
                    Text("Session " + worker["id"].string).font(.callout.monospaced()).textSelection(.enabled)
                    Text("Takeover \(worker["generation"].string) · \(OpsState.word(worker["state"].string)) · updated \(OpsFormat.ago(worker["updatedAt"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                    if let status = worker["status"].string.nonempty { Text(OpsText.scrub(status)).font(.callout) }
                }
            }
            let directions = Array(supervision["directions"].array.suffix(3))
            if !directions.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    SectionLabel(text: "Your recent messages to Keir")
                    ForEach(directions, id: \.["requestId"].string) { direction in
                        Text(direction["text"].string).font(.callout).lineLimit(3)
                        Text(direction["readAt"].number != nil ? "Read by Keir \(OpsFormat.ago(direction["readAt"]))" : direction["deliveredAt"].number != nil ? "Delivered \(OpsFormat.ago(direction["deliveredAt"])), not read yet" : "Not delivered yet").font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                }
            }
            let approvals = supervision["holds"]["pendingApprovals"].array
            if !approvals.isEmpty {
                NavigationLink { TicketDetail(ticket: ticketRow) } label: {
                    Label("\(approvals.count) approval\(approvals.count == 1 ? "" : "s") waiting on this ticket. Review in the ticket.", systemImage: "checkmark.shield")
                }.font(.callout)
            }
            if !supervision["missing"].array.isEmpty {
                Text("Not available yet: " + supervision["missing"].array.map { $0.string }.joined(separator: ", ")).font(.caption).foregroundStyle(OpsTheme.muted)
            }
        }
    }

    @ViewBuilder private var actionArea: some View {
        switch ConversationActionPlan.evaluate(op: op, view: supervision, ticket: ticket) {
        case .unavailable(let reason):
            Label(reason, systemImage: "hand.raised").font(.callout).foregroundStyle(OpsTheme.warn).fixedSize(horizontal: false, vertical: true)
        case .ready(let workerId):
            VStack(alignment: .leading, spacing: 10) {
                Text(explanation).font(.callout).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
                TextField(placeholder, text: $text, axis: .vertical).lineLimit(2...8)
                    .padding(10).background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 10))
                if trimmed.count > ConversationActionBuilder.maxText * 9 / 10 {
                    Text("\(trimmed.count) of \(ConversationActionBuilder.maxText) characters").font(.caption).foregroundStyle(trimmed.count > ConversationActionBuilder.maxText ? OpsTheme.warn : OpsTheme.muted)
                }
                if let record, !record.done {
                    Text("An earlier attempt was sent but the ticket does not show it yet. Sending again reuses the same request, so it cannot run twice.").font(.caption).foregroundStyle(OpsTheme.muted)
                }
                Button { Task { await perform(workerId: workerId) } } label: {
                    Text(busy ? "Working" : confirmTitle).fontWeight(.semibold).frame(maxWidth: .infinity).padding(.vertical, 11)
                }
                .background(OpsTheme.sky, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(OpsTheme.onAccent)
                .disabled(busy || (op == .message && trimmed.isEmpty) || trimmed.count > ConversationActionBuilder.maxText)
                .accessibilityIdentifier("keir-action-confirm")
            }
        }
    }

    private var explanation: String {
        switch op {
        case .take: return "The support desk pauses and its queued replies are withdrawn. Keir handles the ticket under your direction."
        case .handback: return "This takeover ends immediately. The support desk resumes with the next step and evidence."
        case .message: return "Your direction goes only to Keir for this ticket. Approve changes separately."
        }
    }
    private var placeholder: String {
        switch op {
        case .take: return "First direction for Keir (optional)"
        case .handback: return "Note for the support desk (optional)"
        case .message: return "Message Keir"
        }
    }
    private var confirmTitle: String {
        switch op {
        case .take: return "Take over ticket #\(ticket)"
        case .handback: return "Hand ticket #\(ticket) back"
        case .message: return "Send to Keir"
        }
    }

    private func outcomeView(_ outcome: ConversationActionOutcome) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(outcome.headline, systemImage: "checkmark.circle.fill").font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.mint).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(outcome.details.enumerated()), id: \.offset) { _, line in
                Text(line).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            Text("Done. This message will not run the action again. Write a new message for another one.").font(.caption).foregroundStyle(OpsTheme.muted)
        }.accessibilityIdentifier("keir-action-outcome")
    }

    private func reload(settling attempt: String? = nil) async {
        do {
            let view = try await session.get(ConversationActionBuilder.supervisionPath(ticket))
            guard view["ticket"].number == Double(ticket) else { loadError = "The server answered for a different ticket. Nothing was changed."; return }
            supervision = view; missing = false; loadError = nil
            // An earlier attempt whose reply never arrived: the server's own
            // record decides whether it happened.
            let open = attempt ?? record.flatMap { $0.done ? nil : $0.requestId }
            if let open, let proven = ConversationActionOutcome.recovered(op: op, ticket: ticket, requestId: open, view: view) {
                history.complete(key, outcome: proven); notice = nil
            }
        } catch is CancellationError {
            return
        } catch {
            if (error as? AppFailure)?.statusCode == 404 { missing = true; supervision = .null; loadError = nil }
            else if supervision == .null { loadError = error.displayMessage }
            else { notice = "Could not refresh the ticket: " + error.displayMessage }
        }
    }

    private func perform(workerId: String) async {
        guard !busy else { return }
        guard let id = history.requestID(for: key, op: op, ticket: ticket, text: text) else { notice = "This message already ran its action."; return }
        let request: ConversationActionRequest
        do {
            request = try ConversationActionBuilder.request(op: op, ticket: ticket, requestId: id, revision: supervision["revision"].string, text: text, workerId: workerId)
        } catch {
            history.discard(key)
            notice = (error as? ConversationActionError)?.message ?? error.displayMessage
            return
        }
        busy = true; notice = nil
        defer { busy = false }
        do {
            let response = try await session.post(request.path, request.body)
            if let outcome = ConversationActionOutcome.interpret(op: op, ticket: ticket, requestId: id, response: response) {
                history.complete(key, outcome: outcome)
                if response["supervision"] != .null { supervision = response["supervision"] }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                notice = "The server replied, but not in a form that proves the action happened. Nothing is shown as done until the ticket confirms it. Checking now."
                await reload(settling: id)
            }
        } catch is CancellationError {
            return
        } catch {
            let failure = ConversationActionFailure.classify(op: op, statusCode: (error as? AppFailure)?.statusCode)
            notice = failure.explain(serverMessage: (error as? AppFailure)?.message ?? "")
            if failure != .unknown { history.discard(key) }
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            await reload(settling: failure == .unknown ? id : nil)
        }
    }
}

// MARK: approvals

/// The real approval surfaces, opened from the conversation: supervisor
/// proposals (bound to the exact patch digest) and the studio decision cards
/// already used everywhere else. Neither is a new queue and neither routes
/// through the Support conversation.
private struct KeirApprovalsSheet: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @Environment(\.dismiss) private var dismiss
    let focus: String?
    @State private var proposals: [JSONValue] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var results: [String: String] = [:]
    @State private var deciding: Set<String> = []

    private var shownProposals: [JSONValue] {
        if let focus { return proposals.filter { $0["id"].string == focus } }
        return proposals.filter { $0["state"].string == "pending" }
    }
    private var decisions: [JSONValue] { focus == nil ? Array(ops.decisions.prefix(5)) : [] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Approving publishes only the exact patch shown. Replies in chat such as \u{201C}yes, go ahead\u{201D} are never treated as approval.").font(.caption).foregroundStyle(OpsTheme.muted)
                    if let error {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(error).font(.callout).foregroundStyle(OpsTheme.warn)
                            Button("Try again") { Task { await load() } }
                        }
                    }
                    if !loaded && error == nil { ProgressView("Loading") }
                    if let focus, loaded, error == nil, shownProposals.isEmpty {
                        Text("Proposal \(focus) is no longer listed. It may be older than the newest twenty. Nothing was approved.").font(.callout).foregroundStyle(OpsTheme.muted)
                    }
                    ForEach(shownProposals, id: \.["id"].string) { proposal in
                        KeirConversationApprovalCard(proposal: proposal, result: results[proposal["id"].string], busy: deciding.contains(proposal["id"].string)) { approve in
                            Task { await decide(proposal, approve: approve) }
                        }
                    }
                    if focus == nil {
                        if !decisions.isEmpty {
                            SectionLabel(text: "Waiting for you", count: ops.decisions.count)
                            ForEach(decisions, id: \.["id"].string) { DecisionCard(decision: $0) }
                            if ops.decisions.count > decisions.count {
                                Button("See all \(ops.decisions.count) in Inbox") { router.tab = .activity; dismiss() }
                            }
                        } else if loaded && error == nil && shownProposals.isEmpty {
                            Text("Nothing is waiting for your approval.").font(.callout).foregroundStyle(OpsTheme.muted)
                        }
                    }
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }
            .opsScreen()
            .navigationTitle("Approvals").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            let result = try await session.get("/api/keir/supervisor/proposals")
            proposals = result["proposals"].array; loaded = true; error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.displayMessage
        }
    }

    private func decide(_ proposal: JSONValue, approve: Bool) async {
        let id = proposal["id"].string
        guard !deciding.contains(id) else { return }
        let request: ConversationActionRequest
        do { request = try ConversationActionBuilder.proposalVerdict(id: id, approve: approve, digest: proposal["digest"].string) }
        catch { results[id] = (error as? ConversationActionError)?.message ?? error.displayMessage; return }
        deciding.insert(id)
        defer { deciding.remove(id) }
        do {
            let response = try await session.post(request.path, request.body)
            let state = response["proposal"]["state"].string
            if approve {
                if state == "published" {
                    let branch = response["proposal"]["branch"].string
                    results[id] = "Published" + (branch.isEmpty ? "." : " as branch \(branch).") + (response["proposal"]["prUrl"].string.isEmpty ? "" : " Pull request: " + response["proposal"]["prUrl"].string)
                } else { results[id] = "The server did not confirm publishing, so nothing is shown as published. Reloading." }
            } else {
                results[id] = state.isEmpty || state == "pending" ? "The server did not confirm the rejection. Reloading." : "Rejected. Nothing was published."
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
        } catch is CancellationError {
            return
        } catch {
            results[id] = ((error as? AppFailure)?.message ?? error.displayMessage) + " Nothing was published."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            await load()
        }
    }
}

private struct KeirConversationApprovalCard: View {
    let proposal: JSONValue
    let result: String?
    let busy: Bool
    let decide: (Bool) -> Void
    @State private var confirming = false

    private var pending: Bool { proposal["state"].string == "pending" }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                OpsStatusBadge(status: pending ? .waiting : .done, label: pending ? "Approval" : proposal["state"].string.capitalized)
                if let repo = proposal["repo"].string.nonempty { Text(repo).font(.caption).foregroundStyle(OpsTheme.muted) }
                Spacer()
                Text(OpsFormat.ago(proposal["createdAt"])).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            Text(proposal["title"].string.nonempty ?? "Proposed change").font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            let files = proposal["files"].array.map { $0.string }
            if !files.isEmpty {
                Text(files.prefix(6).joined(separator: "\n") + (files.count > 6 ? "\n and \(files.count - 6) more" : "")).font(.caption.monospaced()).textSelection(.enabled)
            }
            if let tests = proposal["tests"].string.nonempty { Text(tests).font(.caption).foregroundStyle(OpsTheme.muted) }
            if let digest = proposal["digest"].string.nonempty { Text("Patch fingerprint \(digest.prefix(12))").font(.caption.monospaced()).foregroundStyle(OpsTheme.muted) }
            if let result {
                Text(result).font(.callout).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("proposal-result")
            } else if pending {
                HStack(spacing: 10) {
                    Button { confirming = true } label: { Text(busy ? "Working" : "Approve and publish").fontWeight(.semibold).frame(maxWidth: .infinity).padding(.vertical, 9) }
                        .background(OpsTheme.sky, in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(OpsTheme.onAccent)
                        .accessibilityIdentifier("proposal-approve")
                    Button { decide(false) } label: { Text("Reject").frame(maxWidth: .infinity).padding(.vertical, 9) }
                        .background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 10))
                }.buttonStyle(.plain).disabled(busy)
            }
        }
        .padding(14)
        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1).fill(OpsTheme.warn).frame(width: 2).padding(.vertical, 14) }
        .confirmationDialog("Publish this exact patch as a pull request?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Approve and publish") { decide(true) }
            Button("Cancel", role: .cancel) {}
        }
    }
}
