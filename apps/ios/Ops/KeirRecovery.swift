import SwiftUI
import LakesideCore

/// Owner instructions use the same authenticated chat ingress as typed messages.
struct OwnerDirectionButton: View {
    var title = "Give Keir direction"
    let context: String
    var thread = "main"
    var taskID: String? = nil
    @State private var presenting = false
    var body: some View {
        Button { presenting = true } label: { Label(title, systemImage: "text.bubble") }
            .sheet(isPresented: $presenting) { OwnerDirectionSheet(context: context, thread: thread, taskID: taskID) }
    }
}

private struct OwnerDirectionSheet: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: OpsRouter
    @Environment(\.dismiss) private var dismiss
    let context: String
    let thread: String
    let taskID: String?
    @ObservedObject private var keir = OpsServices.shared.keir
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Work to continue") { Text(context).textSelection(.enabled) }
                Section("Your instruction") {
                    TextField("What should Keir do next?", text: $text, axis: .vertical).lineLimit(3...10)
                    Text("Existing approvals remain bound to their original actions. Keir will report any remaining blocker or new proposal.").font(.caption).foregroundStyle(.secondary)
                    if let error { Text(error).foregroundStyle(OpsTheme.warn) }
                    Button(busy ? "Sending" : "Send to Keir") { Task { await send() } }
                        .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.navigationTitle("Continue with Keir").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
        }
    }
    private func send() async {
        busy = true; defer { busy = false }
        keir.select(thread.isEmpty ? "main" : thread)
        keir.sendMode = taskID == nil ? "new" : "steer"; keir.steeringTask = taskID
        if await keir.send("Regarding \(context)\nOwner instruction: \(text)", session) {
            router.destination = nil; router.tab = .keir; dismiss()
        } else { error = keir.error ?? "The instruction was not accepted. Your text is kept here." }
    }
}

struct OpsDestinationView: View {
    let destination: OpsDestination
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group {
                switch destination {
                case .task(let id): TaskDetail(id: id)
                case .decision(let id): DecisionReview(id: id)
                case .ticket(let ticket): TicketDetail(ticket: ticket)
                case .alerts: OpsAttentionView()
                }
            }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct DecisionReview: View {
    let id: String
    @EnvironmentObject private var session: AppSession
    @State private var decision: JSONValue = .null
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if loading { ProgressView() }
                else if let error { Text(error).foregroundStyle(OpsTheme.warn); Button("Retry decision") { Task { await load() } } }
                else if decision == .null { Text("This decision is no longer pending. Check Activity for its task and result.") }
                else { DecisionCard(decision: decision) }
            }.padding(16)
        }.opsScreen().navigationTitle("Your decision").navigationBarTitleDisplayMode(.inline)
            .task(id: id) { await load() }.refreshable { await load() }
    }
    private func load() async {
        do {
            let result = try await session.get("/api/keir/app/decisions")
            decision = result["decisions"].array.first { $0["id"].string == id } ?? .null; error = nil
        } catch { self.error = error.displayMessage }
        loading = false
    }
}

struct OpsAttentionView: View {
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var session: AppSession
    var body: some View {
        List {
            if AttentionCenter.shared.count > 0 {
                Section(AttentionCenter.label) { AttentionStack() }.listRowBackground(Color.clear)
            }
            if ops.redPRs > 0 { Section("Failed checks") { NavigationLink("\(ops.redPRs) PRs need attention") { FailedPRsView() } } }
            if !ops.alerts.isEmpty { Section("Recent alerts") { ForEach(Array(ops.alerts.enumerated()), id: \.offset) { _, alert in
                VStack(alignment: .leading, spacing: 5) { Text(OpsText.scrub(alert["text"].string)); Text(OpsFormat.ago(alert["at"])).font(.caption).foregroundStyle(OpsTheme.muted) }
            } } }
            if AttentionCenter.shared.count == 0 && ops.redPRs == 0 && ops.alerts.isEmpty { Text("No current alerts.") }
            if let error = ops.error { Text(error).foregroundStyle(OpsTheme.warn) }
        }.opsScreen().navigationTitle("Needs attention").refreshable { await ops.refresh(session) }
    }
}

struct DecisionAnswerReceipt: View {
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    var body: some View {
        if ops.answerReceipt != .null {
            VStack(alignment: .leading, spacing: 8) {
                Text(ops.answerReceipt["state"].string == "approve" ? "Approval saved. Execution is tracked in the task." : "Your response was saved.").font(.callout)
                HStack {
                    if !ops.answerReceipt["jobId"].string.isEmpty { Button("View progress and remaining blockers") { router.openDecisionTask(ops.answerReceipt) } }
                    Button("Dismiss") { ops.answerReceipt = .null }
                }.font(.caption)
            }.padding(12).background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct FailedPRsView: View {
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var session: AppSession
    private var prs: [JSONValue] { ops.hub["prs"].array.filter { $0["state"].string == "OPEN" && $0["ci"].string == "red" } }
    var body: some View {
        List {
            ForEach(prs, id: \.["number"].string) { pr in
                VStack(alignment: .leading, spacing: 6) {
                    Text("#\(pr["number"].string) \(pr["title"].string)").font(.headline)
                    if let url = Endpoint.link(pr["url"].string.nonempty ?? pr["html_url"].string, base: Surface.ops.base) { Link("Open PR and failed checks", destination: url) }
                    OwnerDirectionButton(context: "PR #\(pr["number"].string): \(pr["title"].string)")
                }
            }
            if prs.isEmpty { Text("No failing open PRs in the current snapshot.") }
            if let error = ops.error { Text(error).foregroundStyle(OpsTheme.warn) }
        }.opsScreen().navigationTitle("Failed checks").refreshable { await ops.refresh(session) }
    }
}
