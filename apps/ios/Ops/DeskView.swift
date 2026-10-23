import SwiftUI
import LakesideCore

/// Keir's support desk: the tickets it holds and the workers doing the work.
struct DeskView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore

    private var tickets: [JSONValue] { ops.hub["tickets"].array.filter { $0["status"].string != "closed" } }
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

struct TicketDetail: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    let ticket: JSONValue
    @State private var detail: JSONValue = .null
    @State private var error: String?
    private var card: JSONValue { detail["card"] == .null ? ticket["card"] : detail["card"] }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if !detail["blockers"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Blocking progress", count: detail["blockers"].array.count)
                        ForEach(Array(detail["blockers"].array.enumerated()), id: \.offset) { _, blocker in
                            VStack(alignment: .leading, spacing: 4) {
                                Label(OpsText.scrub(blocker["title"].string), systemImage: blocker["kind"].string == "decision" ? "person.crop.circle.badge.questionmark" : OpsStatus.blocked.icon).font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.warn)
                                if !blocker["detail"].string.isEmpty && blocker["detail"] != blocker["title"] { Text(blocker["detail"].string).font(.callout).textSelection(.enabled) }
                            }
                        }
                        ForEach(detail["decisions"].array, id: \.["id"].string) { DecisionCard(decision: $0) }
                    }.accessibilityIdentifier("ticket-blockers")
                    Hairline()
                }
                OwnerDirectionButton(title: "Reply or give direction", context: "Ticket #\(ticket["number"].string)")
                ForEach(detail["tasks"].array.filter { $0["canOpen"].bool }, id: \.["id"].string) { task in
                    NavigationLink("Open task: \(task["summary"].string.nonempty ?? task["state"].string)") { TaskDetail(id: task["id"].string) }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(ticket["title"].string).font(.title2.weight(.semibold)).tracking(-0.4)
                    Text("Ticket #\(ticket["number"].string) · \(ticket["category"].string.capitalized) · opened \(OpsFormat.ago(ticket["createdAt"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                }
                if detail["timing"] != .null || ticket["timing"] != .null {
                    WorkTimingView(value: detail["timing"] == .null ? ticket["timing"] : detail["timing"])
                    Hairline()
                }
                if !detail["handoffs"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionLabel(text: "Owner instructions")
                        ForEach(detail["handoffs"].array, id: \.["id"].string) { handoff in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(handoff["status"].string).font(.callout.weight(.semibold))
                                Text("Delivered \(OpsFormat.ago(handoff["at"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                                if handoff["incorporatedAt"] != .null {
                                    Text("Read by Support Keir \(OpsFormat.ago(handoff["incorporatedAt"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                                }
                                Text("Delivery and incorporation do not mean the ticket work is complete.").font(.caption).foregroundStyle(OpsTheme.muted)
                            }
                        }
                    }.accessibilityIdentifier("ticket-handoffs")
                }
                if let error {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).font(.callout).foregroundStyle(OpsTheme.warn)
                        Button("Retry ticket activity") { Task { await load() } }
                    }
                }
                if detail["current"] != .null {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            SectionLabel(text: "Keir's work")
                            OpsStatusBadge(status: OpsStatus.from(detail["current"]["state"].string))
                        }
                        Text(OpsText.scrub(detail["current"]["status"].string).nonempty ?? "Keir has not recorded its next action.").font(.body).textSelection(.enabled)
                        if !detail["current"]["summary"].string.isEmpty && detail["current"]["summary"] != detail["current"]["status"] {
                            NativeMarkdown(text: detail["current"]["summary"].string)
                        }
                        Text("Updated \(OpsFormat.ago(detail["current"]["updatedAt"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                } else if detail != .null {
                    Text("Keir has no recorded work on this ticket yet.").font(.callout).foregroundStyle(OpsTheme.muted)
                } else if error == nil {
                    Text("Loading Keir's ticket activity").font(.callout).foregroundStyle(OpsTheme.muted)
                }
                if !card["status"].string.isEmpty {
                    VStack(alignment: .leading, spacing: 8) { SectionLabel(text: "Player-facing status"); Text(card["status"].string).font(.body) }
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
                if !detail["receipts"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(text: "What Keir did")
                        ForEach(Array(detail["receipts"].array.enumerated()), id: \.offset) { _, receipt in
                            HStack(alignment: .top) {
                                Image(systemName: receipt["state"].string == "done" ? "checkmark.circle" : "clock").foregroundStyle(receipt["state"].string == "done" ? OpsTheme.mint : OpsTheme.warn)
                                VStack(alignment: .leading, spacing: 3) { Text(receipt["label"].string).font(.callout); Text("\(receipt["state"].string.capitalized) · \(OpsFormat.ago(receipt["at"]))").font(.caption).foregroundStyle(OpsTheme.muted) }
                            }
                        }
                    }
                }
                if !detail["pullRequests"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(text: "Pull requests")
                        ForEach(detail["pullRequests"].array, id: \.string) { pr in
                            if let url = URL(string: pr.string) { Link(pr.string, destination: url).font(.callout).lineLimit(1) }
                        }
                        Text("A merged PR is not proof that a fix is live. Release stages above follow Keir's verified receipts.").font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                }
                if !detail["history"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionLabel(text: "Work history")
                        ForEach(detail["history"].array, id: \.["id"].string) { entry in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(entry["kind"].string.capitalized) · \(OpsFormat.ago(entry["at"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                                Text(entry["text"].string).font(.callout).textSelection(.enabled)
                            }
                            Hairline()
                        }
                    }
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }.opsScreen().navigationTitle("#\(ticket["number"].string)").navigationBarTitleDisplayMode(.inline)
            .refreshable { await load() }
            .task(id: scenePhase == .active) {
                while scenePhase == .active && !Task.isCancelled {
                    await load()
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                }
            }
    }
    private func load() async {
        do { detail = try await session.get("/api/keir/app/tickets/\(ticket["number"].string)"); error = nil }
        catch { if !Task.isCancelled { self.error = error.displayMessage } }
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
