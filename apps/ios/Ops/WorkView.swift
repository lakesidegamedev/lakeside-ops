import SwiftUI
import LakesideCore

/// The product kanban, live lanes only: needs you, in progress, blocked, next.
struct WorkView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @State private var lane: Lane
    @State private var product = "all"

    init(lane: Lane = .now) {
        _lane = State(initialValue: lane)
    }

    enum Lane: String, CaseIterable, Identifiable {
        case needs = "needs_owner", now, blocked, next
        var id: String { rawValue }
        var title: String { self == .needs ? "Owner work" : self == .now ? "In progress" : self == .blocked ? "Blocked" : "Next" }
    }

    private var products: [String] { Array(Set(Lane.allCases.flatMap { ops.kanban[$0.rawValue].array.map { $0["product"].string } })).filter { !$0.isEmpty }.sorted() }
    private var items: [JSONValue] { ops.kanban[lane.rawValue].array.filter { product == "all" || $0["product"].string == product } }
    private func count(_ lane: Lane) -> Int { Int(ops.kanban["counts"][lane.rawValue].number ?? Double(ops.kanban[lane.rawValue].array.count)) }

    var body: some View {
        List {
            Section {
                ForEach(items, id: \.["id"].string) { item in
                    NavigationLink { WorkItemDetail(item: item) } label: {
                        WorkRow(title: item["title"].string, meta: meta(item), bar: lane == .blocked || item["needs_owner"].bool ? OpsTheme.warn : item["stale"].bool ? OpsTheme.muted : lane == .now ? OpsTheme.mint : nil)
                    }
                }.listRowBackground(Color.clear)
                if items.isEmpty { Text(lane == .needs ? "Nothing waiting on you." : "Nothing here.").foregroundStyle(OpsTheme.muted) }
            } header: {
                Picker("Lane", selection: $lane) { ForEach(Lane.allCases) { Text("\($0.title) \(count($0))").tag($0) } }
                    .pickerStyle(.segmented).textCase(nil).padding(.bottom, 6)
            }
        }
        .listStyle(.plain)
        .refreshable { await ops.refresh(session) }
        .opsScreen()
        .navigationTitle("Work").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Menu {
                Picker("Product", selection: $product) {
                    Text("All products").tag("all")
                    ForEach(products, id: \.self) { Text($0).tag($0) }
                }
            } label: { Image(systemName: product == "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }
                .accessibilityLabel("Filter by product")
        }
    }

    private func meta(_ item: JSONValue) -> String {
        [item["assigned_to"].string.nonempty ?? "Unassigned", item["product"].string, item["impact"].string == "high" ? "High impact" : "", OpsFormat.ago(item["last_progress_at"].string.isEmpty ? item["updated_at"] : item["last_progress_at"])]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

struct WorkItemDetail: View {
    let item: JSONValue
    @EnvironmentObject private var session: AppSession
    @State private var detail: JSONValue = .null
    @State private var assignee = ""
    @State private var needsOwner = false
    @State private var saving = false
    @State private var error: String?
    @State private var saved: String?
    private var value: JSONValue { detail == .null ? item : detail }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(value["title"].string).font(.title2.weight(.semibold)).tracking(-0.4)
                    Text([value["lane"].string.capitalized, value["kind"].string, value["product"].string, value["assigned_to"].string.nonempty ?? "Unassigned"].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(OpsTheme.muted)
                }
                if !value["progress_summary"].string.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(text: "Latest progress")
                        Text(value["progress_summary"].string).font(.body).textSelection(.enabled)
                        Text(OpsFormat.ago(value["last_progress_at"])).font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                }
                if !value["stale_reason"].string.isEmpty {
                    Label(value["stale_reason"].string, systemImage: "clock.badge.exclamationmark").font(.callout).foregroundStyle(OpsTheme.warn)
                }
                if !value["detail"].string.isEmpty || !value["detail_excerpt"].string.isEmpty {
                    VStack(alignment: .leading, spacing: 8) { SectionLabel(text: "Detail"); Text(value["detail"].string.nonempty ?? value["detail_excerpt"].string).font(.callout).foregroundStyle(OpsTheme.muted).textSelection(.enabled) }
                }
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Assign to", text: $assignee).textFieldStyle(.roundedBorder)
                    Toggle("Needs owner decision", isOn: $needsOwner)
                    Button(saving ? "Saving" : "Update assignment and attention") { Task { await save() } }.disabled(saving || detail == .null)
                    Text("This updates the work board. Action approvals and execution remain with the task.").font(.caption).foregroundStyle(OpsTheme.muted)
                    if let saved { Text(saved).font(.caption).foregroundStyle(OpsTheme.mint) }
                    if let error { Text(error).foregroundStyle(OpsTheme.warn); Button("Reload work item") { Task { await load() } } }
                }
                OwnerDirectionButton(title: "Reply, assign or unblock with Keir", context: "Work item #\(value["id"].string): \(value["title"].string)")
                HStack(spacing: 16) {
                    if let url = Endpoint.link(value["evidence_url"].string, base: URL(string: "https://github.com")!) { Link("Evidence", destination: url) }
                    if let gh = githubURL { Link("Issue", destination: gh) }
                }.font(.callout.weight(.semibold))
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }.opsScreen().navigationTitle("").navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do {
            detail = try await session.get("/api/kanban/items/\(item["id"].string)")
            assignee = detail["assigned_to"].string; needsOwner = detail["needs_owner"].bool; error = nil
        } catch { self.error = error.displayMessage }
    }
    private func save() async {
        saving = true; defer { saving = false }
        do {
            detail = try await session.post("/api/kanban/items/\(item["id"].string)", ["assigned_to": .string(assignee), "needs_owner": .bool(needsOwner)])
            saved = "Work board updated. Task execution is tracked separately."; error = nil
            await OpsServices.shared.ops.refresh(session)
        } catch { self.error = error.displayMessage }
    }
    private var githubURL: URL? {
        let ref = value["github"]["url"].string.nonempty ?? value["github"].string
        guard let hash = ref.firstIndex(of: "#") else { return Endpoint.link(ref, base: URL(string: "https://github.com")!) }
        return URL(string: "https://github.com/\(ref[..<hash])/issues/\(ref[ref.index(after: hash)...])")
    }
}
