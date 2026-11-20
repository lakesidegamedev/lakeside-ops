import SwiftUI
import LakesideCore

/// Owner ticket supervision: take a ticket from Support Keir for your personal
/// Keir worker, watch and direct that worker, and hand the ticket back.
/// Talks only to `/api/keir/app/tickets/:n/supervision`. Every write carries a
/// request id that is reused when the same action is retried, so a dropped
/// connection never takes a ticket twice. Take and hand back also carry the
/// revision the owner was looking at, so a stale screen cannot override staff.
/// A direction belongs to the worker it was written for: it names that worker,
/// and an unsent draft is discarded when that worker's session ends, so a
/// half-typed note can never reach a later worker the owner has not seen.
struct TicketSupervisionPanel: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    let number: String
    @State private var state: JSONValue = .null
    @State private var error: String?
    @State private var busy = false
    @State private var draft = ""
    @State private var confirming: SupervisionAction?
    /// Request ids for writes that have not been confirmed yet, keyed by action
    /// and content, so a retry replays rather than repeats.
    @State private var requestIds: [String: String] = [:]

    private var worker: JSONValue { state["worker"] }
    private var supervised: Bool { state["state"].string == "supervised" }
    /// The worker a direction typed now would reach, or empty when none can.
    private var directionTarget: String { state["canMessage"].bool ? worker["id"].string : "" }
    /// Directions for the current worker only; earlier sessions' notes are history.
    private var directions: [JSONValue] { state["directions"].array.filter { $0["workerId"] == worker["id"] } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel(text: "Ticket owner")
                if state != .null { OpsStatusBadge(status: supervised ? .running : state["state"].string == "held" ? .blocked : .done, label: ownerWord, compact: true) }
            }
            if state == .null && error == nil {
                Text("Checking who owns this ticket").font(.callout).foregroundStyle(OpsTheme.muted)
            } else if state != .null {
                Text(state["label"].string).font(.callout.weight(.semibold))
                if !state["takeBlockers"].array.isEmpty && !supervised {
                    ForEach(Array(state["takeBlockers"].array.enumerated()), id: \.offset) { _, blocker in
                        Label(blocker["text"].string, systemImage: "hand.raised").font(.caption).foregroundStyle(OpsTheme.warn)
                    }
                }
                if worker != .null { WorkerSummary(worker: worker, active: supervised) }
                if !directions.isEmpty && supervised {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Your directions").font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.muted)
                        ForEach(Array(directions.prefix(3).enumerated()), id: \.offset) { _, direction in
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: direction["readAt"] == .null ? "envelope" : "envelope.open").foregroundStyle(OpsTheme.muted)
                                Text(direction["text"].string).font(.caption).lineLimit(3)
                            }
                        }
                    }.accessibilityElement(children: .combine).accessibilityIdentifier("supervision-directions")
                }
                if state["canMessage"].bool {
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("Direct your Keir on this ticket", text: $draft, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("supervision-direction")
                        Button { Task { await send(.message, text: draft) } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                            .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("Send direction")
                    }
                    Text("Directions guide the worker. They never approve an action; approvals still come to you as cards.").font(.caption2).foregroundStyle(OpsTheme.muted)
                }
                HStack(spacing: 12) {
                    if state["canTake"].bool {
                        Button { confirming = .take } label: { Label("Take over", systemImage: "person.badge.key") }
                            .buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("supervision-take")
                    }
                    if state["canHandback"].bool {
                        Button { confirming = .handback } label: { Label("Hand back", systemImage: "arrow.uturn.backward") }
                            .buttonStyle(.bordered).disabled(busy).accessibilityIdentifier("supervision-handback")
                    }
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(OpsTheme.warn)
                Button("Refresh") { Task { await load() } }.font(.caption)
            }
        }
        .accessibilityIdentifier("ticket-supervision")
        .confirmationDialog(confirming?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let action = confirming {
                // Take and hand back never carry the direction draft: it is
                // not on screen when they are offered.
                Button(action.title) { Task { await send(action, text: "") } }
                Button("Cancel", role: .cancel) { confirming = nil }
            }
        } message: { Text(confirming?.detail ?? "") }
        // The session a draft was written for ended (hand back, staff, ticket
        // closed) or a different worker took over: the draft and any unconfirmed
        // direction request go with it.
        .onChange(of: directionTarget) { _, _ in
            draft = ""
            requestIds = requestIds.filter { !$0.key.hasPrefix("\(SupervisionAction.message.rawValue)|") }
        }
        .task(id: scenePhase == .active) {
            while scenePhase == .active && !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: .seconds(supervised ? 8 : 20)) } catch { return }
            }
        }
    }

    private var ownerWord: String {
        switch state["state"].string {
        case "supervised": return "Your Keir"
        case "held": return "Held"
        case "ended": return "Ended"
        default: return "Support Keir"
        }
    }

    private var path: String { "/api/keir/app/tickets/\(number)/supervision" }

    private func load() async {
        do { state = try await session.get(path); error = nil }
        catch { if !Task.isCancelled { self.error = error.displayMessage } }
    }

    private func send(_ action: SupervisionAction, text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // A direction names the worker it was written for; with no worker to
        // name there is nobody to send it to.
        let target = action == .message ? directionTarget : ""
        if action == .message && target.isEmpty { return }
        let key = "\(action.rawValue)|\(number)|\(target)|\(trimmed)"
        let requestId = requestIds[key] ?? "ios-\(UUID().uuidString.lowercased())"
        requestIds[key] = requestId
        var body: [String: JSONValue] = ["op": .string(action.rawValue), "requestId": .string(requestId)]
        if !trimmed.isEmpty { body["text"] = .string(trimmed) }
        if action != .message { body["revision"] = state["revision"] }
        if action == .message { body["workerId"] = .string(target) }
        busy = true; defer { busy = false; confirming = nil }
        do {
            let result = try await session.post(path, body)
            requestIds[key] = nil
            // Sent, or its session just started or ended: nothing typed carries over.
            draft = ""
            if result["supervision"] != .null { state = result["supervision"] } else { await load() }
            error = nil
        } catch {
            self.error = error.displayMessage
            // A refusal is final for this request: the next attempt is a new one.
            if let failure = error as? AppFailure, let code = failure.statusCode, (400..<500).contains(code) { requestIds[key] = nil; await load() }
        }
    }
}

enum SupervisionAction: String, Identifiable {
    case take, message, handback
    var id: String { rawValue }
    var title: String {
        switch self {
        case .take: return "Take this ticket from Support Keir"
        case .handback: return "Hand this ticket back to Support Keir"
        case .message: return "Send direction"
        }
    }
    var detail: String {
        switch self {
        case .take: return "Support Keir stops and its queued replies are withdrawn. Your personal Keir becomes the only voice on this ticket until you hand it back. Staff claims still win."
        case .handback: return "Your Keir stops at once and anything it had queued is withdrawn. Support Keir gets its notes and next step."
        case .message: return ""
        }
    }
}

/// What the worker is doing, its next step, and its receipts, compactly.
private struct WorkerSummary: View {
    let worker: JSONValue
    let active: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(active ? "Your Keir's worker" : "Last worker").font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.muted)
                OpsStatusBadge(status: OpsStatus.from(worker["state"].string), compact: true)
            }
            if !worker["status"].string.isEmpty { Text(OpsText.scrub(worker["status"].string)).font(.callout).textSelection(.enabled) }
            if !worker["nextAction"].string.isEmpty && worker["nextAction"] != worker["status"] {
                Text("Next: \(OpsText.scrub(worker["nextAction"].string))").font(.caption).textSelection(.enabled)
            }
            ForEach(Array(worker["receipts"].array.prefix(4).enumerated()), id: \.offset) { _, receipt in
                Label("\(receipt["label"].string) · \(OpsFormat.ago(receipt["at"]))", systemImage: receipt["state"].string == "done" ? "checkmark.circle" : "clock")
                    .font(.caption).foregroundStyle(receipt["state"].string == "done" ? OpsTheme.mint : OpsTheme.warn)
            }
            ForEach(Array(worker["outbox"].array.filter { $0["state"].string == "suppressed" }.prefix(2).enumerated()), id: \.offset) { _, entry in
                Label("Withdrawn: \(entry["text"].string)", systemImage: "xmark.bubble").font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
            }
            Text("Updated \(OpsFormat.ago(worker["updatedAt"]))").font(.caption2).foregroundStyle(OpsTheme.muted)
        }
    }
}
