import SwiftUI
import LakesideCore

// MARK: Result cards

/// What a Keir reply touched: tickets, PRs, issues and heal receipts.
struct KeirCards: View {
    @EnvironmentObject private var router: OpsRouter
    let cards: [JSONValue]
    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
                if card["type"].string == "ticket" {
                    NavigationLink { TicketDetail(ticket: .object(["number": card["number"], "title": card["title"]])) } label: { row(card) }.buttonStyle(.plain)
                } else if let url = Endpoint.link(card["url"].string, base: Surface.ops.base) {
                    Link(destination: url) { row(card) }.buttonStyle(.plain)
                } else {
                    Button { router.tab = .ops } label: { row(card) }.buttonStyle(.plain)
                }
            }
        }
    }
    private func row(_ card: JSONValue) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon(card["type"].string)).font(.callout).foregroundStyle(OpsTheme.sky).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title(card)).font(.callout.weight(.semibold)).lineLimit(1)
                Text(meta(card)).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: card["type"].string == "ticket" ? "chevron.right" : "arrow.up.right").font(.caption).foregroundStyle(OpsTheme.muted)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(OpsTheme.hairline))
        .accessibilityElement(children: .combine)
    }
    private func icon(_ type: String) -> String {
        switch type { case "pr": return "arrow.triangle.pull"; case "issue": return "exclamationmark.circle"; case "ticket": return "ticket"; default: return "checkmark.seal" }
    }
    private func title(_ c: JSONValue) -> String {
        switch c["type"].string {
        case "pr": return "PR #\(c["number"].string)"
        case "issue": return c["title"].string.nonempty ?? "Issue #\(c["number"].string)"
        case "ticket": return c["title"].string.nonempty ?? "Ticket #\(c["number"].string)"
        default: return c["label"].string
        }
    }
    private func meta(_ c: JSONValue) -> String {
        switch c["type"].string {
        case "pr": return c["repository"].string
        case "issue": return "Issue #\(c["number"].string) · \(c["state"].string.capitalized)"
        case "ticket": return "Ticket #\(c["number"].string) · open in Desk"
        default: return "\(c["state"].string.capitalized) · \(OpsFormat.ago(c["at"]))"
        }
    }
}

// MARK: Threads

struct KeirThreads: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var keir: KeirStore
    @State private var naming = false
    @State private var title = ""
    @State private var renaming: JSONValue = .null
    var body: some View {
        NavigationStack {
            List {
                ForEach(keir.threads, id: \.["id"].string) { thread in
                    Button { keir.select(thread["id"].string); dismiss() } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(thread["title"].string).font(.callout.weight(.semibold))
                                    if thread["working"].bool { StateWord(text: "Working", color: OpsTheme.mint) }
                                }
                                Text(thread["preview"].string.nonempty ?? (thread["system"].bool ? "Results from your watches" : "No messages yet"))
                                    .font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
                            }
                            Spacer()
                            if thread["id"].string == keir.thread { Image(systemName: "checkmark").font(.caption) }
                        }.padding(.vertical, 4).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    .swipeActions {
                        if !thread["system"].bool && thread["id"].string != "main" {
                            Button("Archive") { Task { _ = try? await session.post("/api/keir/app/threads/\(thread["id"].string)", ["archived": .bool(true)]); await keir.loadThreads(session); if keir.thread == thread["id"].string { keir.select("main") } } }.tint(OpsTheme.warn)
                            Button("Rename") { renaming = thread; title = thread["title"].string }.tint(OpsTheme.sky)
                        }
                    }
                }.listRowBackground(Color.clear)
            }
            .listStyle(.plain).opsScreen().navigationTitle("Threads").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button { title = ""; naming = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New thread") }
            }
            .alert("New thread", isPresented: $naming) {
                TextField("What is it about?", text: $title)
                Button("Start") { let t = title; Task { await keir.newThread(t, session); dismiss() } }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Rename thread", isPresented: Binding(get: { renaming != .null }, set: { if !$0 { renaming = .null } })) {
                TextField("Title", text: $title)
                Button("Save") { let id = renaming["id"].string, t = title; Task { _ = try? await session.post("/api/keir/app/threads/\(id)", ["title": .string(t)]); await keir.loadThreads(session) } }
                Button("Cancel", role: .cancel) {}
            }
            .task { await keir.loadThreads(session) }
        }
    }
}

// MARK: Activity

struct ActivityView: View {
    @EnvironmentObject private var router: OpsRouter
    @EnvironmentObject private var session: AppSession
    @State private var tasks: [JSONValue] = []
    @State private var approvals: [JSONValue] = []
    @State private var work: JSONValue = .null
    @State private var error: String?
    @State private var search = ""
    @State private var scope = "tickets"
    @State private var filter = "all"
    private var tickets: [JSONValue] { work["tickets"].array }
    private var showTickets: Bool { scope == "tickets" && work["source"]["enabled"].bool }
    private var entries: [JSONValue] { showTickets ? tickets : tasks }
    private var visible: [JSONValue] { entries.filter { WorkQueuePresentation.matches($0, filter: filter, search: search, ticket: showTickets) }.sorted { WorkQueuePresentation.rank($0) < WorkQueuePresentation.rank($1) } }
    private let filters = [("all", "All"), ("working", "Working"), ("waiting", "Waiting"), ("stuck", "Stuck"), ("needs-you", "Needs you")]
    var body: some View {
        List {
            DecisionAnswerReceipt().listRowBackground(Color.clear)
            Section {
                if work["source"]["enabled"].bool {
                    Picker("Work type", selection: $scope) {
                        Text(work["source"]["at"] == .null ? "Tickets" : "Tickets \(tickets.count)").tag("tickets")
                        Text("Tasks \(tasks.count)").tag("tasks")
                    }.pickerStyle(.segmented).accessibilityIdentifier("work-queue-scope")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(filters, id: \.0) { key, title in
                            Button { filter = key } label: {
                                Text("\(title) \(entries.filter { WorkQueuePresentation.matches($0, filter: key, search: "", ticket: showTickets) }.count)")
                                    .font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(filter == key ? OpsTheme.sky.opacity(0.18) : OpsTheme.muted.opacity(0.08), in: Capsule())
                            }.buttonStyle(.plain).accessibilityIdentifier("work-filter-\(key)")
                        }
                    }
                }
                if let error { Label(error, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(OpsTheme.warn) }
                if !work["source"]["error"].string.isEmpty { Text(work["source"]["error"].string).font(.caption).foregroundStyle(OpsTheme.warn) }
                if work["source"]["limited"].bool { Text("The ticket source is capped at 60 results. This is not a complete list.").font(.caption).foregroundStyle(OpsTheme.warn) }
                if work["source"]["at"] != .null && showTickets {
                    Text("Ticket source checked \(OpsFormat.ago(work["source"]["at"]))").font(.caption2).foregroundStyle(OpsTheme.muted)
                }
            }.listRowBackground(Color.clear).listRowSeparator(.hidden)
            if !approvals.isEmpty && filter != "working" && filter != "waiting" {
                Section {
                    ForEach(approvals, id: \.["id"].string) { a in DecisionCard(decision: a) { await load() } }
                } header: { SectionLabel(text: "Your decisions", count: approvals.count) }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            Section {
                if visible.isEmpty { Text(showTickets && work["source"]["at"] == .null ? "Ticket list unavailable. Pull to retry." : search.isEmpty ? "No work in this view." : "No matching work.").foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear) }
                ForEach(visible, id: \.[showTickets ? "number" : "id"].string) { item in
                    NavigationLink {
                        if showTickets { TicketDetail(ticket: item) }
                        else { TaskDetail(id: item["id"].string) }
                    } label: {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                StateWord(text: WorkQueuePresentation.label(item), color: WorkQueuePresentation.color(item))
                                Spacer()
                                if showTickets { Text("#\(item["number"].string)").font(.caption.monospaced()).foregroundStyle(OpsTheme.muted) }
                            }
                            Text(item["title"].string).font(.callout.weight(.semibold)).lineLimit(2)
                            if item["timing"] != .null { WorkTimingView(value: item["timing"], compact: true) }
                            else { Text(item["summary"].string.nonempty ?? OpsState.word(item["state"].string)).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2) }
                        }.padding(.vertical, 8)
                    }.accessibilityIdentifier("work-row-\(item[showTickets ? "number" : "id"].string)")
                }.listRowBackground(Color.clear)
            } header: { SectionLabel(text: showTickets ? "Ticket queue" : "Task queue", count: visible.count) }
        }
        .listStyle(.plain).opsScreen().navigationTitle("Activity").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Ticket number or task")
        .onChange(of: router.activityFilter) { _, next in filter = next }
        .onAppear { filter = router.activityFilter }
        .refreshable { await load() }
        .task { while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(15)) } }
    }
    private func load() async {
        do { tasks = try await session.get("/api/keir/app/tasks")["tasks"].array; error = nil }
        catch { self.error = error.displayMessage }
        do { approvals = try await session.get("/api/keir/app/decisions")["decisions"].array }
        catch { self.error = "Decisions could not refresh. Pull to retry." }
        do { work = try await session.get("/api/keir/app/work") }
        catch { self.error = "Work queue could not refresh. Saved tasks remain visible." }
    }
}

struct TaskDetail: View {
    @EnvironmentObject private var session: AppSession
    let id: String
    @EnvironmentObject private var router: OpsRouter
    @State private var replacement: String?
    @State private var task: JSONValue = .null
    @State private var busy = false
    @State private var providerSettings = false
    @State private var retryNote = ""
    @State private var retrying = false
    @State private var actionError: String?
    @State private var loadError: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let loadError {
                    Text(loadError).foregroundStyle(OpsTheme.warn)
                    Button("Retry task connection") { Task { await load() } }
                }
                if task == .null && loadError == nil { ProgressView().frame(maxWidth: .infinity) }
                if task != .null {
                    VStack(alignment: .leading, spacing: 6) {
                        StateWord(text: OpsState.word(task["state"].string), color: OpsState.color(task["state"].string))
                        Text(task["request"].string.nonempty ?? "Task").font(.title3.weight(.semibold)).tracking(-0.3).textSelection(.enabled)
                        Text([task["surface"].string == "app" ? "From the app" : "From Discord", task["model"].string, task["provider"]["effort"].string.isEmpty ? "" : "\(task["provider"]["effort"].string) effort · Jev", "started \(OpsFormat.ago(task["at"]))"].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                    if task["timing"] != .null { WorkTimingView(value: task["timing"]) }
                    if task["attention"] != .null {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(task["attention"]["title"].string, systemImage: "arrow.turn.down.right").font(.headline)
                            Text(task["attention"]["detail"].string).font(.callout).foregroundStyle(OpsTheme.muted)
                            if task["attention"]["action"].string == "retry", task["canRetry"].bool {
                                Button("Retry with current Keir") { act("retry") }.buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("task-unblock")
                            } else if task["attention"]["action"].string == "reply" {
                                Button("Reply in conversation") { if !task["thread"].string.isEmpty { OpsServices.shared.keir.select(task["thread"].string) }; router.tab = .keir }.buttonStyle(.borderedProminent)
                            }
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                    }
                    ForEach(task["decisions"].array.filter { $0["state"].string == "pending" }, id: \.["id"].string) { DecisionCard(decision: $0) { await load() } }
                    if let replacement {
                        NavigationLink("Open restarted task") { TaskDetail(id: replacement) }.font(.headline)
                    }
                    OwnerDirectionButton(title: "Give Keir direction", context: "Task \(id): \(task["request"].string)", thread: task["thread"].string, taskID: task["surface"].string == "app" ? id : nil)
                    if task["computer"] != .null {
                        NavigationLink { KeirComputerScreen(taskId: id) } label: { Label("View computer and take control", systemImage: "desktopcomputer") }
                    }
                    if !task["activeSkills"].array.isEmpty {
                        Text("Skills: \(task["activeSkills"].array.map(\.string).joined(separator: ", "))").font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                    if task["canStop"].bool && task["surface"].string == "app" {
                        Button { providerSettings = true } label: { Label("Providers for this task", systemImage: "cpu") }
                    }
                    if !task["status"].string.isEmpty && task["blocker"] == .null { Label(task["status"].string, systemImage: "ellipsis.bubble").font(.callout).foregroundStyle(OpsTheme.mint) }
                    if !task["summary"].string.isEmpty && task["blocker"] == .null {
                        VStack(alignment: .leading, spacing: 8) { SectionLabel(text: "Where it stands"); Text(task["summary"].string).font(.body).textSelection(.enabled) }
                    }
                    if !task["plan"].array.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SectionLabel(text: "Plan", count: task["plan"].array.count)
                            ForEach(Array(task["plan"].array.enumerated()), id: \.offset) { _, step in
                                HStack(alignment: .top, spacing: 10) {
                                    Group {
                                        switch step["status"].string {
                                        case "done": Image(systemName: "checkmark.circle.fill").foregroundStyle(OpsTheme.mint)
                                        case "running": Image(systemName: "circle.fill").font(.caption2).foregroundStyle(OpsTheme.mint)
                                        case "failed": Image(systemName: "xmark.circle.fill").foregroundStyle(OpsTheme.warn)
                                        case "waiting": Image(systemName: "pause.circle").foregroundStyle(OpsTheme.sky)
                                        default: Image(systemName: "circle").foregroundStyle(OpsTheme.muted)
                                        }
                                    }.frame(width: 18)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(step["title"].string).font(.callout).foregroundStyle(step["status"].string == "done" ? OpsTheme.muted : OpsTheme.ink)
                                        if !step["detail"].string.isEmpty { Text(step["detail"].string).font(.caption).foregroundStyle(OpsTheme.muted) }
                                    }
                                }
                            }
                        }
                    }
                    if !task["cards"].array.isEmpty { KeirCards(cards: task["cards"].array) }
                    if !task["live"].array.isEmpty {
                        DisclosureGroup {
                            KeirToolCalls(calls: task["live"].array).padding(.top, 6)
                        } label: { Label(task["state"].string == "running" ? "Live work" : "Tool calls", systemImage: "terminal").font(.callout.weight(.semibold)) }
                        .tint(OpsTheme.ink).accessibilityIdentifier("task-live")
                    }
                    if !task["steps"].array.isEmpty {
                        DisclosureGroup("History and diagnostics") {
                        VStack(alignment: .leading, spacing: 0) {
                            SectionLabel(text: "History").padding(.bottom, 8)
                            ForEach(Array(task["steps"].array.enumerated()), id: \.offset) { index, step in
                                HStack(alignment: .top, spacing: 12) {
                                    VStack(spacing: 0) {
                                        Circle().fill(OpsState.color(step["state"].string)).frame(width: 8, height: 8).padding(.top, 5)
                                        if index < task["steps"].array.count - 1 { Rectangle().fill(OpsTheme.hairline).frame(width: 1).frame(maxHeight: .infinity) }
                                    }
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(step["summary"].string).font(.callout)
                                        Text("\(OpsState.word(step["state"].string)) · \(OpsFormat.ago(step["at"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                                    }.padding(.bottom, 14)
                                }
                            }
                        }
                        if !task["blocker"]["message"].string.isEmpty { Text(task["blocker"]["message"].string).font(.caption.monospaced()).textSelection(.enabled) }
                        }.font(.callout)
                    }
                    if !task["receipts"].array.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            SectionLabel(text: "Receipts", count: task["receipts"].array.count)
                            ForEach(Array(task["receipts"].array.enumerated()), id: \.offset) { _, r in
                                WorkRow(title: r["label"].string, meta: "\(r["state"].string.capitalized) · \(OpsFormat.ago(r["at"]))", bar: r["state"].string == "done" ? OpsTheme.mint : OpsTheme.warn)
                                Hairline()
                            }
                        }
                    }
                    HStack(spacing: 10) {
                        if task["canPause"].bool || task["canResume"].bool {
                            Button { act(task["canResume"].bool ? "resume" : "pause") } label: {
                                Label(task["canResume"].bool ? "Resume" : "Pause", systemImage: task["canResume"].bool ? "play.fill" : "pause.fill").frame(maxWidth: .infinity).padding(.vertical, 10)
                            }.background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 10))
                        }
                        if task["canStop"].bool {
                            Button(role: .destructive) { act("stop") } label: { Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity).padding(.vertical, 10) }
                                .background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 10))
                        }
                        if task["canRetry"].bool {
                            Button { retrying = true } label: { Label("Retry", systemImage: "arrow.clockwise").fontWeight(.semibold).frame(maxWidth: .infinity).padding(.vertical, 10) }
                                .background(OpsTheme.sky, in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(OpsTheme.onAccent)
                        }
                    }.buttonStyle(.plain).disabled(busy)
                    if let actionError { Text(actionError).font(.callout).foregroundStyle(OpsTheme.warn) }
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
        .opsScreen().navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(task["state"].string == "running" ? 4 : 20)) } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if task["canRetry"].bool { Button("Retry task") { retrying = true } }
                    if task["canPause"].bool || task["canResume"].bool { Button(task["canResume"].bool ? "Resume task" : "Pause task") { act(task["canResume"].bool ? "resume" : "pause") } }
                    if task["canStop"].bool { Button("Stop task", role: .destructive) { act("stop") } }
                    if task["surface"].string == "app" && task["canStop"].bool { Button("Task providers") { providerSettings = true } }
                } label: { Image(systemName: "ellipsis") }.disabled(busy).accessibilityLabel("Task controls")
            }
        }
        .sheet(isPresented: $providerSettings) { KeirTaskProviders(task: task) }
        .alert("Retry this task", isPresented: $retrying) {
            TextField("Anything Keir should do differently?", text: $retryNote)
            Button("Retry") { act("retry", retryNote) }
            Button("Cancel", role: .cancel) {}
        }
    }
    private func load() async {
        do { task = try await session.get("/api/keir/app/tasks/\(id)"); loadError = nil }
        catch { if !Task.isCancelled { loadError = error.displayMessage } }
    }
    private func act(_ verb: String, _ note: String = "") {
        busy = true
        Task {
            do {
                let result = try await session.post("/api/keir/app/tasks/\(id)/\(verb)", verb == "retry" ? ["note": .string(note)] : [:])
                if result["restarted"].bool { replacement = result["taskId"].string }
                actionError = nil
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch { actionError = error.displayMessage }
            await load(); busy = false
        }
    }
}

// MARK: Ideas

struct IdeasView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: OpsRouter
    @State private var ideas: [JSONValue] = []
    @State private var loaded = false
    var body: some View {
        List {
            if loaded && ideas.isEmpty { Text("No ideas waiting. Keir files them as it finds problems on its own.").foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear) }
            ForEach(ideas, id: \.["id"].string) { idea in
                VStack(alignment: .leading, spacing: 8) {
                    Text(idea["title"].string).font(.callout.weight(.semibold))
                    if !idea["evidence"].string.isEmpty { Text(idea["evidence"].string).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(5) }
                    HStack(spacing: 14) {
                        if idea["accepted"].bool { StateWord(text: "Keir is on it", color: OpsTheme.mint) }
                        else {
                            Button("Fix it") { decide(idea, "accept") }.fontWeight(.semibold).foregroundStyle(OpsTheme.sky)
                            Button("Dismiss") { decide(idea, "dismiss") }.foregroundStyle(OpsTheme.muted)
                        }
                        Spacer()
                        if let url = URL(string: idea["url"].string) { Link("Issue #\(idea["id"].string)", destination: url).font(.caption) }
                    }.buttonStyle(.plain).font(.callout)
                }.padding(.vertical, 6)
            }.listRowBackground(Color.clear)
        }
        .listStyle(.plain).opsScreen().navigationTitle("Ideas").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }.task { await load() }
    }
    private func load() async { if let r = try? await session.get("/api/keir/app/ideas") { ideas = r["ideas"].array }; loaded = true }
    private func decide(_ idea: JSONValue, _ verdict: String) {
        Task {
            _ = try? await session.post("/api/keir/app/ideas/\(idea["id"].string)", ["verdict": .string(verdict)])
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            await load()
        }
    }
}

// MARK: Watches

struct WatchesView: View {
    @EnvironmentObject private var session: AppSession
    @State private var watches: [JSONValue] = []
    @State private var adding = false
    var body: some View {
        List {
            Section {
                Button { adding = true } label: { Label("Watch for something", systemImage: "plus.circle.fill").fontWeight(.semibold) }
                    .accessibilityIdentifier("watch-add").listRowBackground(Color.clear)
            } footer: { Text("Keir checks with read-only tools on your schedule and only tells you when it happens.").font(.caption) }
            Section {
                if watches.isEmpty { Text("No watches yet.").foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear) }
                ForEach(watches, id: \.["id"].string) { w in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(w["condition"].string).font(.callout.weight(.semibold)).lineLimit(3)
                            Spacer()
                            Toggle("", isOn: Binding(get: { w["active"].bool }, set: { on in update(w, ["active": .bool(on)]) })).labelsHidden()
                        }
                        Text(meta(w)).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
                    }.padding(.vertical, 4)
                    .swipeActions { Button("Remove", role: .destructive) { update(w, ["remove": .bool(true)]) } }
                }.listRowBackground(Color.clear)
            } header: { SectionLabel(text: "Watching", count: watches.filter { $0["active"].bool }.count) }
        }
        .listStyle(.plain).opsScreen().navigationTitle("Watches").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }.task { await load() }
        .sheet(isPresented: $adding) { NewWatch { await load() } }
    }
    private func meta(_ w: JSONValue) -> String {
        var parts = [w["every"].string == "15m" ? "Every 15 min" : w["every"].string.capitalized, w["once"].bool ? "once" : "repeats"]
        if w["running"].bool { parts.append("checking now") }
        else if !w["lastResult"].string.isEmpty { parts.append("last: \(w["lastResult"].string)") }
        if w["hits"].number ?? 0 > 0 { parts.append("hit \(OpsFormat.ago(w["lastHitAt"]))") }
        return parts.joined(separator: " · ")
    }
    private func load() async { if let r = try? await session.get("/api/keir/app/watches") { watches = r["watches"].array } }
    private func update(_ w: JSONValue, _ body: [String: JSONValue]) {
        Task { _ = try? await session.post("/api/keir/app/watches/\(w["id"].string)", body); await load() }
    }
}

private struct NewWatch: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    let saved: () async -> Void
    @State private var condition = ""
    @State private var every = "hourly"
    @State private var once = true
    @State private var error: String?
    private let examples = ["PR 4184 on AHDGame is merged", "Turn time goes above 90 seconds", "Ticket 1561 is resolved", "Any service on the status page is not operational"]
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Tell me when…", text: $condition, axis: .vertical).lineLimit(2...5).accessibilityIdentifier("watch-condition")
                    ForEach(examples, id: \.self) { e in Button(e) { condition = e }.font(.caption).foregroundStyle(OpsTheme.muted) }
                }
                Section {
                    Picker("Check", selection: $every) { Text("Every 15 min").tag("15m"); Text("Hourly").tag("hourly"); Text("Every 6 hours").tag("6h"); Text("Daily").tag("daily") }
                    Toggle("Stop after it happens", isOn: $once)
                }
                if let error { Text(error).foregroundStyle(OpsTheme.warn) }
            }
            .scrollContentBackground(.hidden).background(OpsTheme.background)
            .navigationTitle("New watch").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Watch") {
                        Task {
                            do { _ = try await session.post("/api/keir/app/watches", ["condition": .string(condition), "every": .string(every), "once": .bool(once)]); await saved(); dismiss() }
                            catch { self.error = error.displayMessage }
                        }
                    }.disabled(condition.trimmingCharacters(in: .whitespaces).count < 8).accessibilityIdentifier("watch-save")
                }
            }
        }
    }
}

// MARK: Memory

struct MemoryView: View {
    @EnvironmentObject private var session: AppSession
    @State private var notes: [JSONValue] = []
    @State private var total = 0
    @State private var search = ""
    @State private var kind = ""
    @State private var adding = false
    @State private var lesson = ""
    @State private var error: String?
    var body: some View {
        List {
            if let error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn).listRowBackground(Color.clear) }
            Section {
                ForEach(notes, id: \.["id"].string) { note in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(note["text"].string).font(.callout).lineLimit(6).textSelection(.enabled)
                        Text([note["owner"].bool ? "You told Keir" : note["kind"].string.capitalized, note["ticket"].number.map { "Ticket \(Int($0))" } ?? "", OpsFormat.ago(note["at"])].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(note["owner"].bool ? OpsTheme.sky : OpsTheme.muted)
                    }.padding(.vertical, 4)
                    .swipeActions { Button("Forget", role: .destructive) { forget(note) } }
                }.listRowBackground(Color.clear)
            } header: {
                Picker("Kind", selection: $kind) { Text("All").tag(""); Text("Lessons").tag("lesson"); Text("Decisions").tag("decision"); Text("Mechanics").tag("mechanic"); Text("Resolutions").tag("resolution") }
                    .pickerStyle(.segmented).textCase(nil).padding(.bottom, 4)
            } footer: { Text("\(total) notes. Swipe to forget.").font(.caption) }
        }
        .listStyle(.plain).opsScreen().navigationTitle("Memory").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Search what Keir knows")
        .toolbar { Button { lesson = ""; adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Teach Keir") }
        .alert("Teach Keir", isPresented: $adding) {
            TextField("A lesson Keir should always follow", text: $lesson)
            Button("Save") { save() }
            Button("Cancel", role: .cancel) {}
        }
        .task(id: "\(search)|\(kind)") { try? await Task.sleep(for: .milliseconds(250)); await load() }
    }
    private func load() async {
        do { let r = try await session.get("/api/keir/app/memory", query: ["q": search, "kind": kind]); notes = r["notes"].array; total = Int(r["total"].number ?? 0); error = nil }
        catch { self.error = error.displayMessage }
    }
    private func save() {
        Task {
            do { _ = try await session.post("/api/keir/app/memory", ["text": .string(lesson)]); await load() }
            catch { self.error = error.displayMessage }
        }
    }
    private func forget(_ note: JSONValue) {
        Task { _ = try? await session.post("/api/keir/app/memory/\(note["id"].string)/forget", [:]); await load() }
    }
}


/// Source-specific activity for both chat and task details. Inputs and outputs
/// stay in the protected task trace; the conversation shows the operation.
struct KeirToolCalls: View {
    let calls: [JSONValue]
    @State private var expanded = false
    private struct CallRow: Identifiable {
        let id: String
        let call: JSONValue
    }
    private var visible: [CallRow] {
        let rows = calls.enumerated().map { index, call in
            CallRow(id: call["id"].string.nonempty ?? "legacy-\(index)-\(call["tool"].string)", call: call)
        }
        return expanded ? rows : Array(rows.suffix(3))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(visible) { row in
                let call = row.call
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: call["icon"].string.nonempty ?? "wrench.and.screwdriver")
                        .foregroundStyle(call["state"].string == "failed" ? OpsTheme.warn : OpsTheme.sky)
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(call["title"].string.nonempty ?? call["tool"].string).font(.caption.weight(.semibold))
                        HStack(spacing: 5) {
                            Text(call["source"].string.nonempty ?? "Keir")
                            if !call["what"].string.isEmpty { Text("·"); Text(call["what"].string).lineLimit(1) }
                        }.font(.caption2).foregroundStyle(OpsTheme.muted)
                    }
                    Spacer(minLength: 4)
                    if call["state"].string == "running" { ProgressView().controlSize(.mini).accessibilityLabel("Running") }
                    else if call["state"].string == "failed" || call["ok"] == .bool(false) { Image(systemName: "exclamationmark.circle").foregroundStyle(OpsTheme.warn).accessibilityLabel("Failed") }
                    else { Image(systemName: "checkmark").foregroundStyle(OpsTheme.mint).accessibilityLabel("Completed") }
                }.font(.caption)
                    .accessibilityIdentifier("keir-tool-\(call["id"].string)")
            }
            if calls.count > 3 {
                Button(expanded ? "Show less" : "Show all \(calls.count) tool calls") { expanded.toggle() }.font(.caption2)
            }
        }.padding(10).background(OpsTheme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
    }
}
