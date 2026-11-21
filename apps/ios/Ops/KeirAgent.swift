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
    @State private var removing: String?
    @State private var removalError: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    chatRow(keir.mainThread, title: "Main", preview: "Persistent conversation with Keir")
                }
                Section {
                    if keir.sideChats.isEmpty {
                        Text("No side chats yet.").font(.opsCaption).foregroundStyle(OpsTheme.muted)
                    }
                    ForEach(keir.sideChats, id: \.["id"].string) { thread in
                        let id = thread["id"].string
                        chatRow(id, title: thread["title"].string, preview: thread["preview"].string, running: thread["working"].bool)
                            .swipeActions(allowsFullSwipe: false) {
                                Button("Delete", role: .destructive) { removing = id }
                                Button("Rename") { renaming = thread; title = thread["title"].string }.tint(OpsTheme.accent)
                            }
                    }
                } header: { SectionLabel(text: "Side chats") }
                if !keir.systemChats.isEmpty {
                    Section {
                        ForEach(keir.systemChats, id: \.["id"].string) { thread in
                            chatRow(thread["id"].string, title: thread["title"].string, preview: thread["preview"].string)
                        }
                    } header: { SectionLabel(text: "Updates") }
                }
                if let removalError { Text(removalError).font(.opsCaption).foregroundStyle(OpsTheme.warn) }
            }
            .listStyle(.plain).opsScreen().navigationTitle("Conversations").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) { Button { title = ""; naming = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New conversation") }
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
            .alert("Delete this side chat?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Delete", role: .destructive) {
                    guard let id = removing else { return }
                    Task {
                        do { try await keir.removeSideChat(id, session); removalError = nil }
                        catch { removalError = error.displayMessage }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
            .task { await keir.loadThreads(session) }
        }
    }

    private func chatRow(_ id: String, title: String, preview: String, running: Bool = false) -> some View {
        Button { keir.select(id); dismiss() } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.opsHeadline)
                    if !preview.isEmpty { Text(preview).font(.opsCaption).foregroundStyle(OpsTheme.muted).lineLimit(2) }
                }
                Spacer()
                if running { OpsStatusBadge(status: .running, compact: true) }
                if keir.thread == id { Image(systemName: "checkmark").foregroundStyle(OpsTheme.accent) }
            }.padding(.vertical, 4).contentShape(Rectangle())
        }.buttonStyle(.plain).listRowBackground(Color.clear)
    }

}

// MARK: Activity

struct ActivityView: View {
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @EnvironmentObject private var session: AppSession
    @State private var error: String?
    @State private var search = ""
    @State private var filter = "all"
    @State private var route: InboxRoute?
    @ObservedObject private var attention = AttentionCenter.shared

    /// The queue and the badge read the same ticket list from the shared store.
    private var work: JSONValue { ops.work }
    private var tickets: [JSONValue] { ops.openTickets }
    private var trimmedSearch: String { search.trimmingCharacters(in: .whitespaces) }
    // Ordered by harm: what waits on the owner, then a player with no reply,
    // then work that has stopped. Sections follow the same order as the chips.
    private let filters = [("all", "All"), ("needs-you", "Needs you"), ("unanswered", "Unanswered"), ("stalled", "Stalled"),
                           ("stuck", "Blocked"), ("failing", "Failing checks"),
                           ("working", "Running"), ("waiting", "Queued"), ("held", "Waiting"), ("finished", "Done")]

    // MARK: Rows per filter

    private struct Entry: Identifiable {
        let item: JSONValue
        let ticket: Bool
        var key: String { item[ticket ? "number" : "id"].string }
        var id: String { (ticket ? "ticket:" : "task:") + key }
    }
    private func queueRows(_ key: String, search: String) -> [Entry] {
        let entries = ops.queueTickets.map { Entry(item: $0, ticket: true) } + ops.queueTasks.map { Entry(item: $0, ticket: false) }
        return entries.filter { WorkQueuePresentation.matches($0.item, filter: key, search: search) }
            .sorted { WorkQueuePresentation.rank($0.item) < WorkQueuePresentation.rank($1.item) }
    }
    private func failingRows(_ search: String) -> [JSONValue] {
        ops.failingPRs.filter { search.isEmpty || [$0["title"].string, $0["number"].string].contains { $0.localizedCaseInsensitiveContains(search) } }
    }
    private func ownerRows(_ key: String, search: String) -> [AttentionItem] {
        guard WorkQueuePresentation.showsOwnerItems(filter: key) else { return [] }
        return attention.items.filter { $0.matches(search) }
    }
    private func count(_ key: String) -> Int {
        queueRows(key, search: "").count + ownerRows(key, search: "").count + (["all", "failing"].contains(key) ? failingRows("").count : 0)
    }

    private var visibleQueue: [Entry] { queueRows(filter, search: trimmedSearch) }
    private var visibleOwner: [AttentionItem] { ownerRows(filter, search: trimmedSearch) }
    private var visibleFailures: [JSONValue] { ["all", "failing"].contains(filter) ? failingRows(trimmedSearch) : [] }

    var body: some View {
        List {
            DecisionAnswerReceipt().listRowBackground(Color.clear).listRowSeparator(.hidden)
            ownerSections
            queueSection
            if visibleQueue.isEmpty && visibleOwner.isEmpty && visibleFailures.isEmpty {
                Text(emptyText).font(.callout).foregroundStyle(OpsTheme.muted)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .accessibilityIdentifier("inbox-empty")
            }
        }
        .listStyle(.plain)
        .opsScrollable()
        // The scope and filter controls sit outside the List so tapping one
        // never rebuilds or scrolls the row the tap came from.
        .safeAreaInset(edge: .top, spacing: 0) { queueControls }
        .frame(maxWidth: 820).frame(maxWidth: .infinity)
        .opsScreen().navigationTitle("Inbox").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Ticket number or task")
        .navigationDestination(item: $route) { destination($0) }
        .onChange(of: router.activityFilter) { _, next in route = nil; filter = next }
        .onAppear { filter = router.activityFilter }
        .refreshable { await load() }
        .task { while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(15)) } }
    }

    /// One sentence for an empty view, never one per section.
    private var emptyText: String {
        if !trimmedSearch.isEmpty { return "Nothing matches \u{201C}\(trimmedSearch)\u{201D}." }
        switch filter {
        case "needs-you": return "Nothing needs you."
        case "stuck": return "Nothing is blocked."
        case "working": return "Nothing is running."
        case "waiting": return "Nothing is queued."
        default: return "Nothing in this view."
        }
    }

    @ViewBuilder private var queueControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Edge to edge: chips scroll under the screen edges, starting at
            // the same inset as the rows below. The selected chip is always
            // scrolled into view, and the trailing edge fades so the row reads
            // as scrollable.
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(filters, id: \.0) { key, title in
                            chip(key, title).id(key)
                        }
                    }
                }
                .contentMargins(.horizontal, 16, for: .scrollContent)
                .mask {
                    HStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 10)
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 36)
                    }
                }
                .onAppear { reveal(filter, proxy, animated: false) }
                .onChange(of: filter) { _, next in reveal(next, proxy, animated: true) }
            }
            VStack(alignment: .leading, spacing: 4) {
                if let error { Label(error, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(OpsTheme.warn) }
                if !work["source"]["error"].string.isEmpty { Text(work["source"]["error"].string).font(.caption).foregroundStyle(OpsTheme.warn) }
                if work["source"]["limited"].bool { Text("The ticket source is capped at 60 results. This is not a complete list.").font(.caption).foregroundStyle(OpsTheme.warn) }
                if let checked = OpsFormat.date(work["source"]["at"]), Date().timeIntervalSince(checked) > OpsStore.staleAfter {
                    Text("Ticket list last updated \(OpsFormat.ago(checked)). It may be out of date.").font(.caption).foregroundStyle(OpsTheme.warn)
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpsTheme.background)
    }

    private func reveal(_ key: String, _ proxy: ScrollViewProxy, animated: Bool) {
        // The first chips are already in view; only scroll for the rest.
        let anchor: UnitPoint = ["all", "needs-you"].contains(key) ? .leading : .center
        // One run loop later, so the chips have been laid out.
        DispatchQueue.main.async {
            if animated { withAnimation(.snappy) { proxy.scrollTo(key, anchor: anchor) } }
            else { proxy.scrollTo(key, anchor: anchor) }
        }
    }

    private func chip(_ key: String, _ title: String) -> some View {
        let value = count(key)
        let selected = filter == key
        let state = OpsWorkState.from(filter: key)
        // A chip with work in a problem state carries that state's hue on its
        // glyph and count; the selected chip is filled so it reads at a glance.
        let live = value > 0 && (state?.isProblem ?? false)
        return Button { filter = key } label: {
            HStack(spacing: 4) {
                if let state {
                    Image(systemName: state.glyph).font(.caption2.weight(.semibold))
                        .foregroundStyle(selected ? OpsTheme.onAccent : value == 0 ? OpsTheme.muted.opacity(0.7) : state.color)
                        .accessibilityHidden(true)
                }
                Text(title)
                Text("\(value)").monospacedDigit()
                    .foregroundStyle(selected ? OpsTheme.onAccent.opacity(0.85) : live ? state?.color ?? OpsTheme.muted : OpsTheme.muted)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(selected ? OpsTheme.onAccent : value == 0 ? OpsTheme.muted : OpsTheme.ink)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(selected ? OpsTheme.sky : live ? (state?.color ?? OpsTheme.muted).opacity(0.1) : OpsTheme.muted.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(value)")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("work-filter-\(key)")
    }

    @ViewBuilder private var ownerSections: some View {
        if !visibleOwner.isEmpty {
            Group {
                queueHeader(AttentionCenter.label, state: .needsYou, count: visibleOwner.count, identifier: "inbox-attention-count")
                ForEach(visibleOwner) { item in
                    ownerCard(item)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .opsLeadingStripe(OpsWorkState.needsYou.color)
                        .inboxRow(card: true)
                }
            }
        }
    }

    @ViewBuilder private func ownerCard(_ item: AttentionItem) -> some View {
        switch item.kind {
        case .decision:
            if item.decision["type"].string == "choice", let number = item.ticketNumber {
                InboxTicketDecision(item: item, knownChoice: item.decision, open: { route = .ticket(String(number)) }) { await load() }
            } else {
                DecisionCard(decision: item.decision) { await load() }
            }
        case .question:
            Button { router.tab = .keir } label: { AttentionRow(item: item, action: "Answer in the conversation", icon: "bubble.left") }.buttonStyle(.plain)
        case .ownerWork:
            Button { route = .attention(item.id) } label: { AttentionRow(item: item, action: "View details") }.buttonStyle(.plain)
        case .task:
            Button { route = .task(item.work["id"].string) } label: { AttentionRow(item: item, action: "Open task") }.buttonStyle(.plain)
        case .ticket:
            InboxTicketDecision(item: item, open: { route = .attention(item.id) }) { await load() }
        }
    }

    /// Plain groups, not List sections: a section adds its own tall gap
    /// above each header, which cost a row per section.
    /// Lists of like items are dense rows on one shared surface per section,
    /// all with the same anatomy. Only Needs-you items, which ask the owner
    /// for a decision, get standalone cards.
    @ViewBuilder private var queueSection: some View {
        ForEach(filters.dropFirst(), id: \.0) { key, title in
            let rows = visibleQueue.filter { WorkQueuePresentation.bucket($0.item) == key }
            let state = OpsWorkState.from(filter: key)
            if key == "failing" && !visibleFailures.isEmpty {
                Group {
                    queueHeader("Failing checks", state: .failing, count: visibleFailures.count)
                    OpsGroup {
                        ForEach(Array(visibleFailures.enumerated()), id: \.element["number"].string) { index, pr in
                            if index > 0 { OpsGroupDivider(inset: 28) }
                            if let url = URL(string: pr["url"].string.nonempty ?? pr["html_url"].string), url.scheme == "https" {
                                Link(destination: url) { failingLabel(pr) }.buttonStyle(.plain)
                            } else { failingLabel(pr) }
                        }
                    }
                    .inboxRow(card: true)
                }
            }
            if !rows.isEmpty {
                Group {
                    queueHeader(title, state: state, count: rows.count)
                    OpsGroup {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { OpsGroupDivider(inset: 28) }
                            Button { route = row.ticket ? .ticket(row.key) : .task(row.key) } label: {
                                if key == "unanswered" { UnansweredRow(ticket: row.item) }
                                else { QueueRow(item: row.item, ticket: row.ticket) }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("work-row-\(row.key)")
                        }
                    }
                    .inboxRow(card: true)
                }
            }
        }
        if filter != "all" && (!visibleQueue.isEmpty || !visibleOwner.isEmpty || !visibleFailures.isEmpty) {
            filterFooter
        }
    }

    /// Under a filtered list: says the view is filtered and offers the way
    /// back, so a short list is never read as the whole Inbox.
    private var filterFooter: some View {
        let title = filters.first { $0.0 == filter }?.1 ?? "this filter"
        let needsYou = count("needs-you")
        return VStack(alignment: .leading, spacing: 6) {
            Text("Showing \(title) only.").font(.caption).foregroundStyle(OpsTheme.muted)
            HStack(spacing: 14) {
                Button { filter = "all" } label: {
                    Label("Show all \(count("all"))", systemImage: "line.3.horizontal.decrease.circle")
                }
                if filter != "needs-you" && needsYou > 0 {
                    Button { filter = "needs-you" } label: {
                        Label("\(needsYou) need you", systemImage: OpsWorkState.needsYou.glyph)
                    }.foregroundStyle(OpsWorkState.needsYou.color)
                }
            }
            .font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.accent)
            .buttonStyle(.plain)
        }
        .padding(.top, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("inbox-filter-footer")
    }

    private func failingLabel(_ pr: JSONValue) -> some View {
        OpsWorkRow(state: .failing, title: pr["title"].string.nonempty ?? "Change #\(pr["number"].string)",
                   subtitle: "Tests failing on fix #\(pr["number"].string). Keir cannot ship it yet.",
                   age: OpsFormat.date(pr["updatedAt"]).map { OpsAge(date: $0) }, stateWord: "Failing")
    }

    private func queueHeader(_ title: String, state: OpsWorkState? = nil, count: Int, identifier: String? = nil) -> some View {
        // A plain row, not a pinned section header, so it scrolls away with
        // its rows instead of sliding over them. Small, and in the state's
        // hue and glyph, so it costs one line.
        OpsMiniHeader(text: title, state: state, count: count, identifier: identifier)
            .padding(.top, 10).padding(.bottom, 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    @ViewBuilder private func destination(_ route: InboxRoute) -> some View {
        switch route {
        case .task(let id): TaskDetail(id: id)
        case .ticket(let number):
            TicketDetail(ticket: (tickets + ops.hub["tickets"].array).first { $0["number"].string == number } ?? .object(["number": .string(number)]))
        case .attention(let id):
            if let item = attention.items.first(where: { $0.id == id }) {
                if item.kind == .ticket { TicketDetail(ticket: item.work) } else { WorkItemDetail(item: item.work) }
            } else {
                Text("This item is no longer waiting on you.").foregroundStyle(OpsTheme.muted).padding()
            }
        }
    }

    private func load() async {
        error = await ops.refreshInbox(session)
    }
}

private struct InboxTicketDecision: View {
    @EnvironmentObject private var session: AppSession
    let item: AttentionItem
    var knownChoice: JSONValue?
    let open: () -> Void
    let changed: () async -> Void
    @State private var choices: [JSONValue] = []

    var body: some View {
        OpsCard {
            Button(action: open) { AttentionRow(item: item, action: "View ticket", card: false) }.buttonStyle(.plain)
            ForEach(knownChoice.map { [$0] } ?? choices, id: \.["id"].string) { choice in
                TicketDecisionInline(decision: choice, showQuestion: false, changed: changed)
            }
        }
        .task(id: item.id) {
            guard knownChoice == nil, let number = item.ticketNumber,
                  let detail = try? await session.get("/api/keir/app/tickets/\(number)") else { return }
            choices = detail["decisions"].array.filter { $0["type"].string == "choice" && $0["state"].string == "pending" }
        }
    }
}

enum InboxRoute: Hashable, Identifiable {
    case task(String), ticket(String), attention(String)
    var id: String {
        switch self {
        case .task(let id): return "task:\(id)"
        case .ticket(let number): return "ticket:\(number)"
        case .attention(let id): return "attention:\(id)"
        }
    }
}

private extension View {
    /// Same insets for every Inbox row, so cards share one width and list
    /// dividers start where the text starts.
    func inboxRow(card: Bool = false) -> some View {
        self
            .listRowInsets(EdgeInsets(top: card ? 5 : 0, leading: 16, bottom: card ? 5 : 0, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(card ? .hidden : .visible)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
            .alignmentGuide(.listRowSeparatorTrailing) { $0.width }
    }
}

/// A queue item in the shared row anatomy. The subtitle carries the ticket
/// number and what happens next, addressed to the owner where there is a
/// step for them, so a Blocked row always says what unblocks it.
private struct QueueRow: View {
    let item: JSONValue
    let ticket: Bool

    private var since: OpsAge? {
        let value = item["timing"]["since"] != .null ? item["timing"]["since"] : item["updatedAt"]
        // Finished work never escalates; its age is history, not a warning.
        let limit = state == .done ? TimeInterval.infinity : OpsAge.ownerLimit
        return OpsFormat.date(value).map { OpsAge(date: $0, limit: limit) }
    }
    private var state: OpsWorkState { WorkQueuePresentation.workState(item) }

    private var reason: String {
        let raw = item["timing"]["reason"].string
        if raw.localizedCaseInsensitiveContains("activation aborted") { return "Keir’s last attempt stopped before it could finish" }
        return OpsText.scrub(raw.nonempty ?? item["summary"].string)
    }
    private var next: String {
        let raw = OpsText.scrub(item["timing"]["next"].string)
        if !raw.isEmpty && raw != "Keir will record the next result." { return "Next: " + raw }
        switch state {
        case .blocked: return "Open to see what Keir needs to continue"
        case .stalled: return "Open the ticket to retry"
        default: return ""
        }
    }

    /// When Keir looks again, if a check is scheduled.
    private var check: String {
        guard let at = OpsFormat.date(item["timing"]["nextCheckAt"]) else { return "" }
        return at <= Date() ? "Check due" : "Check \(OpsFormat.ago(at))"
    }

    var body: some View {
        let number = ticket ? "#" + item["number"].string : ""
        let subtitle = [number, reason].filter { !$0.isEmpty }.joined(separator: " · ")
        let note = [next, check].filter { !$0.isEmpty }.joined(separator: " · ")
        OpsWorkRow(state: state, title: item["title"].string, subtitle: subtitle, note: note, age: since,
                   stateWord: WorkQueuePresentation.label(item))
    }
}

/// A ticket with no recorded reply. The wait is the point of the row; its age
/// escalates like every other age, after two hours for a player.
private struct UnansweredRow: View {
    let ticket: JSONValue

    private var opened: Date? { OpsFormat.date(ticket["createdAt"]) }

    var body: some View {
        let age = opened.map { OpsAge(date: $0, limit: OpsAge.playerLimit) }
        OpsWorkRow(state: .unanswered, title: KeirTicketFollowUp.title(ticket),
                   subtitle: "#\(ticket["number"].string) · " + (age.map { "No reply recorded for \($0.text.replacingOccurrences(of: " ago", with: ""))" } ?? "No reply recorded"),
                   age: age)
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
                            Label(OpsText.scrub(task["attention"]["title"].string), systemImage: OpsStatus.waiting.icon).font(.headline)
                            Text(OpsText.scrub(task["attention"]["detail"].string)).font(.callout).foregroundStyle(OpsTheme.muted)
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
                    if !task["status"].string.isEmpty && task["blocker"] == .null { Label(OpsText.scrub(task["status"].string), systemImage: "ellipsis.bubble").font(.callout).foregroundStyle(OpsTheme.mint) }
                    if !task["summary"].string.isEmpty && task["blocker"] == .null {
                        VStack(alignment: .leading, spacing: 8) { SectionLabel(text: "Where it stands"); Text(task["summary"].string).font(.body).textSelection(.enabled) }
                    }
                    if !task["plan"].array.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SectionLabel(text: "Plan", count: task["plan"].array.count)
                            ForEach(Array(task["plan"].array.enumerated()), id: \.offset) { _, step in
                                let status = OpsStatus.from(step["status"].string)
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: status.icon)
                                        .font(.callout)
                                        .foregroundStyle(status.color)
                                        .frame(width: 18)
                                        .accessibilityLabel("Status: \(status.title)")
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
                        if !task["blocker"]["message"].string.isEmpty { Text(task["blocker"]["message"].string).font(.caption).textSelection(.enabled) }
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
    @State private var busy: String?

    var body: some View {
        List {
            if loaded && ideas.isEmpty {
                Text("No ideas waiting. Keir files them as it finds problems on its own.")
                    .foregroundStyle(OpsTheme.muted).listRowBackground(Color.clear)
            }
            ForEach(ideas, id: \.["id"].string) { idea in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: idea["kind"].string == "issue" ? "exclamationmark.circle" : "lightbulb")
                            .foregroundStyle(OpsTheme.sky).accessibilityHidden(true)
                        Text(idea["kind"].string == "issue" ? "Problem" : "Idea")
                            .font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted)
                        Spacer()
                        if idea["accepted"].bool { StateWord(text: "Keir is on it", color: OpsTheme.mint) }
                    }
                    Text(OpsText.scrub(idea["title"].string))
                        .font(.callout.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    let reason = OpsText.firstSentence(idea["reason"].string.nonempty ?? idea["evidence"].string)
                    if !reason.isEmpty {
                        Label(reason, systemImage: "info.circle")
                            .font(.caption).foregroundStyle(OpsTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !idea["evidence"].string.isEmpty {
                        DisclosureGroup("Evidence") {
                            Text(OpsText.scrub(idea["evidence"].string))
                                .font(.caption).foregroundStyle(OpsTheme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        .font(.caption.weight(.semibold))
                    }
                    HStack(spacing: 14) {
                        if !idea["accepted"].bool {
                            Button {
                                decide(idea, "accept")
                            } label: {
                                Label("Fix it", systemImage: "play.fill").font(.callout.weight(.semibold))
                            }
                            .buttonStyle(.borderedProminent).tint(OpsTheme.sky)
                            .disabled(busy != nil)
                            .accessibilityIdentifier("idea-start-\(idea["id"].string)")
                        }
                        if let url = URL(string: idea["url"].string) {
                            Link("Issue #\(idea["id"].string)", destination: url).font(.caption)
                        }
                        Spacer()
                    }
                }
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    if !idea["accepted"].bool {
                        Button { decide(idea, "accept") } label: { Label("Start", systemImage: "play.fill") }.tint(OpsTheme.sky)
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) { decide(idea, "dismiss") } label: { Label("Dismiss", systemImage: "xmark") }
                }
            }
        }
        .listStyle(.plain).opsScreen().navigationTitle("Ideas").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }.task { await load() }
    }

    private func load() async {
        if let r = try? await session.get("/api/keir/app/ideas") { ideas = r["ideas"].array }
        loaded = true
    }

    private func decide(_ idea: JSONValue, _ verdict: String) {
        let id = idea["id"].string
        busy = id
        Task {
            _ = try? await session.post("/api/keir/app/ideas/\(id)", ["verdict": .string(verdict)])
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            await load()
            busy = nil
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
