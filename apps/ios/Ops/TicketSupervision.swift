import SwiftUI
import LakesideCore

/// Owner ticket supervision: take a ticket from the support desk for your personal
/// Keir worker, watch and direct that worker, and hand the ticket back.
/// Talks only to `/api/keir/app/tickets/:n/supervision`. Every write carries a
/// request id that is reused when the same action is retried, so a dropped
/// connection never takes a ticket twice. Take and hand back also carry the
/// revision the owner was looking at, so a stale screen cannot override staff.
/// A direction belongs to the worker it was written for: it names that worker,
/// and an unsent draft is discarded when that worker's session ends, so a
/// half-typed note can never reach a later worker the owner has not seen.
@MainActor
final class TicketSupervisionModel: ObservableObject {
    let number: String
    @Published var state: JSONValue = .null
    @Published var error: String?
    @Published var busy = false
    @Published var draft = ""
    @Published var confirming: SupervisionAction?
    /// Request ids for writes that have not been confirmed yet, keyed by action
    /// and content, so a retry replays rather than repeats.
    private var requestIds: [String: String] = [:]

    init(number: String) { self.number = number }

    var worker: JSONValue { state["worker"] }
    var supervised: Bool { state["state"].string == "supervised" }
    /// The worker a direction typed now would reach, or empty when none can.
    var directionTarget: String { state["canMessage"].bool ? worker["id"].string : "" }
    /// Directions for the current worker only; earlier sessions' notes are history.
    var directions: [JSONValue] { state["directions"].array.filter { $0["workerId"] == worker["id"] } }
    var canSend: Bool { !busy && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Compact owner name: Keir, or the worker the owner supervises.
    var ownerWord: String {
        switch state["state"].string {
        case "supervised": return "Supervised worker"
        case "held": return "Held"
        case "ended": return "Ended"
        default: return "Keir"
        }
    }

    private var path: String { "/api/keir/app/tickets/\(number)/supervision" }

    func load(_ session: AppSession) async {
        do { state = try await session.get(path); error = nil }
        catch { if !Task.isCancelled { self.error = error.displayMessage } }
    }

    /// A direction belongs to the worker it was written for. When that worker
    /// changes or ends, the draft and any unconfirmed direction request go too.
    func targetChanged() {
        draft = ""
        requestIds = requestIds.filter { !$0.key.hasPrefix("\(SupervisionAction.message.rawValue)|") }
    }

    func send(_ action: SupervisionAction, text: String, _ session: AppSession) async {
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
            if result["supervision"] != .null { state = result["supervision"] } else { await load(session) }
            error = nil
        } catch {
            self.error = error.displayMessage
            // A refusal is final for this request: the next attempt is a new one.
            if let failure = error as? AppFailure, let code = failure.statusCode, (400..<500).contains(code) { requestIds[key] = nil; await load(session) }
        }
    }
}

/// Polls ownership state while the screen is foregrounded.
struct TicketSupervisionPolling: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: TicketSupervisionModel
    func body(content: Content) -> some View {
        content
            // Take and hand back never carry the direction draft: it is not on
            // screen when they are offered.
            .confirmationDialog(model.confirming?.title ?? "", isPresented: Binding(get: { model.confirming != nil }, set: { if !$0 { model.confirming = nil } }), titleVisibility: .visible) {
                if let action = model.confirming {
                    Button(action.title) { Task { await model.send(action, text: "", session) } }
                    Button("Cancel", role: .cancel) { model.confirming = nil }
                }
            } message: { Text(model.confirming?.detail ?? "") }
            .onChange(of: model.directionTarget) { _, _ in model.targetChanged() }
            .task(id: scenePhase == .active) {
                while scenePhase == .active && !Task.isCancelled {
                    await model.load(session)
                    do { try await Task.sleep(for: .seconds(model.supervised ? 8 : 20)) } catch { return }
                }
            }
    }
}

/// Take over and hand back. Take over is secondary: it never outranks the
/// ticket's own status and decision.
struct TicketOwnershipActions: View {
    @ObservedObject var model: TicketSupervisionModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.state["takeBlockers"].array.isEmpty && !model.supervised {
                ForEach(Array(model.state["takeBlockers"].array.enumerated()), id: \.offset) { _, blocker in
                    Label(blocker["text"].string, systemImage: "hand.raised").font(.caption).foregroundStyle(OpsTheme.warn)
                }
            }
            HStack(spacing: 12) {
                if model.state["canTake"].bool {
                    Button { model.confirming = .take } label: { Label("Take over", systemImage: "person.badge.key") }
                        .buttonStyle(.bordered).disabled(model.busy).accessibilityIdentifier("supervision-take")
                }
                if model.state["canHandback"].bool {
                    Button { model.confirming = .handback } label: { Label("Hand back", systemImage: "arrow.uturn.backward") }
                        .buttonStyle(.bordered).disabled(model.busy).accessibilityIdentifier("supervision-handback")
                }
            }
            if let error = model.error {
                Text(error).font(.caption).foregroundStyle(OpsTheme.warn)
            }
        }
        // A container identifier on a plain stack is copied onto every child
        // and replaces their own. Make this a container so each control keeps its id.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ticket-supervision")
    }
}

/// Directions already sent to the current worker.
struct TicketDirectionsList: View {
    @ObservedObject var model: TicketSupervisionModel
    var body: some View {
        if !model.directions.isEmpty && model.supervised {
            VStack(alignment: .leading, spacing: 4) {
                Text("Your directions").font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.muted)
                ForEach(Array(model.directions.prefix(3).enumerated()), id: \.offset) { _, direction in
                    Label(direction["text"].string, systemImage: direction["readAt"] == .null ? "paperplane" : "checkmark")
                        .font(.caption).lineLimit(3)
                }
            }.accessibilityElement(children: .combine).accessibilityIdentifier("supervision-directions")
        }
    }
}

/// The direction composer, pinned above the keyboard. One helper line sits
/// above the field; there is no plus because nothing attaches to a direction.
struct TicketDirectionComposer: View {
    @EnvironmentObject private var session: AppSession
    @ObservedObject var model: TicketSupervisionModel
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Guides the worker. Approvals still come to you.").font(.caption2).foregroundStyle(OpsTheme.muted).lineLimit(1)
                .padding(.horizontal, 16)
            KeirComposerPill { EmptyView() } field: {
                TextField("Direct your Keir", text: $model.draft, axis: .vertical).lineLimit(1...5)
                    .padding(.leading, 14)
                    .accessibilityIdentifier("supervision-direction")
            } trailing: {
                Button { Task { await model.send(.message, text: model.draft, session) } } label: {
                    KeirComposerIcon(system: "arrow.up", filled: model.canSend)
                }
                .buttonStyle(.plain)
                .disabled(!model.canSend)
                .accessibilityLabel("Send direction")
            }.padding(.horizontal, 12)
        }
        .padding(.top, 6).padding(.bottom, 8)
        .background(.bar)
    }
}

enum SupervisionAction: String, Identifiable {
    case take, message, handback
    var id: String { rawValue }
    var title: String {
        switch self {
        case .take: return "Take this ticket from the support desk"
        case .handback: return "Hand this ticket back to the support desk"
        case .message: return "Send direction"
        }
    }
    var detail: String {
        switch self {
        case .take: return "The support desk stops and its queued replies are withdrawn. The supervised worker becomes the only voice on this ticket until you hand it back. Staff claims still win."
        case .handback: return "The supervised worker stops at once and anything it had queued is withdrawn. The support desk gets its notes and next step."
        case .message: return ""
        }
    }
}

/// Technical worker detail, shown only under Details: its receipts, withdrawn
/// replies and last update. Its status and errors are on the main screen.
struct SupervisedWorkerSummary: View {
    let worker: JSONValue
    let active: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: active ? "Supervised worker" : "Last worker")
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
