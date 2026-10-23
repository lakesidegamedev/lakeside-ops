import SwiftUI
import LakesideCore

// MARK: - Scheduler

/// Checks and world simulations share one resource-aware scheduler. New sims
/// may be queued at any time; the production worker claims them only overnight.
struct SchedulerView: View {
    @EnvironmentObject private var session: AppSession
    @State private var data: JSONValue = .null
    @State private var error: String?
    @State private var loading = false

    private var checks: [JSONValue] { data["checks"].array }
    private var sims: [JSONValue] { data["worldSims"].array }
    private var running: [JSONValue] { checks.filter { $0["state"].string == "running" } }
    private var queued: [JSONValue] { checks.filter { $0["state"].string == "queued" } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if loading && data == .null { ProgressView("Loading scheduler").frame(maxWidth: .infinity, alignment: .center) }
                if let error {
                    OpsCard {
                        OpsHealthLine(status: .failed, headline: "Scheduler unavailable", detail: error)
                        OpsSecondaryButton(title: "Retry", icon: "arrow.clockwise") { Task { await load() } }
                    }
                }
                if data != .null {
                    OpsCard {
                        Text("\(running.count) running · \(queued.count) queued")
                            .font(.opsCardTitle)
                        Text("Heavy checks run one at a time and wait when memory or load is tight.")
                            .font(.caption).foregroundStyle(OpsTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HostPanel(host: data["host"])
                    checkList
                    simList
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await load() }
        .task { await load() }
        .opsScreen()
        .navigationTitle("Scheduler").navigationBarTitleDisplayMode(.inline)
    }

    private var checkList: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Checks", count: checks.count)
            if checks.isEmpty { Text("No checks in the queue.").font(.callout).foregroundStyle(OpsTheme.muted).padding(.vertical, 8) }
            ForEach(checks, id: \.["id"].string) { job in
                let status = OpsStatus.from(job["state"].string)
                let priority = job["priority"].string.isEmpty ? "" : " · \(job["priority"].string)"
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: status.icon).foregroundStyle(status.color).font(.callout).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(OpsText.scrub(job["label"].string.nonempty ?? job["preset"].string.nonempty ?? "Check"))
                            .font(.callout.weight(.semibold)).lineLimit(2)
                        Text("\(status.title) · \(folder(job["workdir"].string))\(priority) · \(OpsFormat.ago(job["requested_at"]))")
                            .font(.caption).foregroundStyle(OpsTheme.muted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                Hairline()
            }
        }
    }

    private var simList: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "World simulations", count: sims.count)
            if data["worldSimError"].string.nonempty != nil {
                Text(data["worldSimError"].string).font(.caption).foregroundStyle(OpsTheme.warn)
            } else if sims.isEmpty {
                Text("No simulations queued.").font(.callout).foregroundStyle(OpsTheme.muted).padding(.vertical, 8)
            }
            ForEach(sims, id: \.["runId"].string) { sim in
                let status = OpsStatus.from(sim["status"].string)
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: status.icon).foregroundStyle(status.color).font(.callout).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(sim["preset"].string.nonempty ?? "Simulation") · seed \(sim["seed"].string)")
                            .font(.callout.weight(.semibold)).lineLimit(2)
                        Text("\(status.title) · turn \(Int(sim["currentTurn"].number ?? 0)) of \(Int(sim["turns"].number ?? 0)) · \(OpsFormat.ago(sim["updatedAt"]))")
                            .font(.caption).foregroundStyle(OpsTheme.muted).monospacedDigit()
                        if let error = sim["error"].string.nonempty {
                            Text(OpsText.scrub(error)).font(.caption).foregroundStyle(OpsTheme.danger).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                Hairline()
            }
            Text("New runs may be queued at any time. The production worker claims them only from 03:00 through 08:00 America/New_York.")
                .font(.caption2).foregroundStyle(OpsTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
        }
    }

    private func folder(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func load() async {
        loading = true; defer { loading = false }
        do { data = try await session.get("/api/scheduler"); error = nil }
        catch { self.error = error.displayMessage }
    }
}

// MARK: - Security

struct SecurityView: View {
    @EnvironmentObject private var session: AppSession
    @State private var data: JSONValue = .null
    @State private var error: String?
    @State private var loading = false

    private var findings: [JSONValue] {
        data["findings"].array.sorted { severityRank($0["severity"].string) < severityRank($1["severity"].string) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if loading && data == .null { ProgressView("Reading host posture").frame(maxWidth: .infinity, alignment: .center) }
                if let error {
                    OpsCard {
                        OpsHealthLine(status: .failed, headline: "Security posture unavailable", detail: error)
                        OpsSecondaryButton(title: "Retry", icon: "arrow.clockwise") { Task { await load() } }
                    }
                }
                if data != .null {
                    summary
                    hosts
                    findingList
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await load() }
        .task { await load() }
        .opsScreen()
        .navigationTitle("Security").navigationBarTitleDisplayMode(.inline)
    }

    private var severityCount: Int {
        ["critical", "high"].reduce(0) { $0 + Int(data["summary"]["counts"][$1].number ?? 0) }
    }

    private var summary: some View {
        let posture = data["summary"]["posture"].string
        let reachable = Int(data["summary"]["hostsReachable"].number ?? 0)
        let total = Int(data["summary"]["hostsTotal"].number ?? 0)
        return OpsCard {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(posture.isEmpty ? "Posture unknown" : posture.capitalized)
                        .font(.opsCardTitle)
                    Text("\(reachable) of \(total) hosts reporting · score \(Int(data["summary"]["score"].number ?? 0))")
                        .font(.caption).foregroundStyle(OpsTheme.muted).monospacedDigit()
                }
                Spacer()
                OpsStatusBadge(status: severityCount > 0 ? .failed : .done, label: severityCount > 0 ? "\(severityCount) critical or high" : "No critical findings")
            }
            if let generated = OpsFormat.date(data["generatedAt"]) {
                Text("Probed \(OpsFormat.ago(generated))").font(.caption2).foregroundStyle(OpsTheme.muted)
            }
        }
    }

    private var hosts: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Hosts", count: data["hosts"].array.count)
            ForEach(data["hosts"].array, id: \.["id"].string) { host in
                let ok = host["ok"].bool
                WorkRow(title: host["label"].string.nonempty ?? host["name"].string, meta: ok ? "Reporting · \(OpsFormat.ago(host["collectedAt"]))" : (host["error"].string.nonempty ?? "Not reporting"), bar: ok ? OpsTheme.mint : OpsTheme.danger) {
                    OpsStatusBadge(status: ok ? .done : .failed)
                }
                Hairline()
            }
        }
    }

    private var findingList: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Findings", count: findings.count)
            if findings.isEmpty { Text("No findings.").font(.callout).foregroundStyle(OpsTheme.muted).padding(.vertical, 8) }
            ForEach(findings, id: \.["id"].string) { finding in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        OpsStatusBadge(status: severityRank(finding["severity"].string) <= 1 ? .failed : .blocked, label: finding["severity"].string.capitalized)
                        Spacer()
                        Text(finding["hostLabel"].string).font(.caption2).foregroundStyle(OpsTheme.muted)
                    }
                    Text(OpsText.scrub(finding["title"].string)).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    if !finding["detail"].string.isEmpty {
                        Text(OpsText.scrub(finding["detail"].string)).font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let remedy = finding["remedy"].string.nonempty {
                        Text("Fix: \(OpsText.scrub(remedy))").font(.caption).foregroundStyle(OpsTheme.sky).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 9)
                .accessibilityElement(children: .combine)
                Hairline()
            }
        }
    }

    private func severityRank(_ value: String) -> Int {
        ["critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4][value.lowercased()] ?? 5
    }

    private func load() async {
        loading = true; defer { loading = false }
        do { data = try await session.get("/api/security"); error = nil }
        catch { self.error = error.displayMessage }
    }
}

// MARK: - Pull requests

struct PullRequestsView: View {
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var session: AppSession

    private var prs: [JSONValue] { ops.hub["prs"].array.filter { $0["state"].string == "OPEN" } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if prs.isEmpty { Text("No open pull requests.").font(.callout).foregroundStyle(OpsTheme.muted).padding(.vertical, 12) }
                ForEach(prs, id: \.["number"].string) { pr in
                    let red = pr["ci"].string == "red"
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            OpsStatusBadge(status: red ? .failed : .queued, label: red ? "Checks failing" : "Open")
                            Spacer()
                            Text("#\(pr["number"].string)").font(.caption.monospaced()).foregroundStyle(OpsTheme.muted)
                        }
                        Text(OpsText.scrub(pr["title"].string)).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        if let url = Endpoint.link(pr["url"].string.nonempty ?? pr["html_url"].string, base: Surface.ops.base) {
                            Link("Open on GitHub", destination: url).font(.caption.weight(.semibold))
                        }
                        OwnerDirectionButton(title: "Ask Keir to move this", context: "PR #\(pr["number"].string): \(pr["title"].string)")
                    }
                    .padding(.vertical, 10)
                    Hairline()
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await ops.refresh(session) }
        .opsScreen()
        .navigationTitle("Pull requests").navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Worktrees and agent sessions

struct WorktreesView: View {
    @EnvironmentObject private var session: AppSession
    @State private var data: JSONValue = .null
    @State private var error: String?
    @State private var loading = false

    private var sessions: [JSONValue] { data["sessions"].array }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if loading && data == .null { ProgressView("Loading sessions").frame(maxWidth: .infinity).padding(.top, 40) }
                if let error {
                    OpsCard {
                        OpsHealthLine(status: .failed, headline: "Sessions unavailable", detail: error)
                        OpsSecondaryButton(title: "Retry", icon: "arrow.clockwise") { Task { await load() } }
                    }.padding(.bottom, 12)
                }
                if data != .null {
                    SectionLabel(text: "Sessions", count: sessions.count).padding(.bottom, 6)
                    if sessions.isEmpty { Text("No agent sessions or worktrees.").font(.callout).foregroundStyle(OpsTheme.muted) }
                    ForEach(Array(sessions.enumerated()), id: \.offset) { _, item in
                        let status = sessionStatus(item)
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .firstTextBaseline) {
                                OpsStatusBadge(status: status.status, label: status.word)
                                Spacer()
                                Text(item["kind"].string.nonempty ?? "agent").font(.caption2).foregroundStyle(OpsTheme.muted)
                            }
                            Text(OpsText.scrub(item["title"].string.nonempty ?? item["taskExcerpt"].string.nonempty ?? folder(item["worktreePath"].string)))
                                .font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                            let detail = item["statusLine"].string.nonempty ?? item["branch"].string.nonempty ?? ""
                            if !detail.isEmpty {
                                Text(OpsText.scrub(detail)).font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
                            }
                            if let path = item["worktreePath"].string.nonempty {
                                Text(folder(path)).font(.caption2.monospaced()).foregroundStyle(OpsTheme.muted).lineLimit(1)
                            }
                        }
                        .padding(.vertical, 9)
                        .accessibilityElement(children: .combine)
                        Hairline()
                    }
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await load() }
        .task { await load() }
        .opsScreen()
        .navigationTitle("Worktrees").navigationBarTitleDisplayMode(.inline)
    }

    private func sessionStatus(_ item: JSONValue) -> (status: OpsStatus, word: String) {
        if item["needsInput"].bool { return (.waiting, "Waiting on you") }
        switch item["activity"].string {
        case "working": return (.running, "Running")
        case "ready": return (.done, "Ready")
        default: return (OpsStatus.from(item["state"].string), item["state"].string.capitalized)
        }
    }

    private func folder(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func load() async {
        loading = true; defer { loading = false }
        do { data = try await session.get("/api/code/sessions"); error = nil }
        catch { self.error = error.displayMessage }
    }
}

// MARK: - World simulations

struct WorldSimsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var data: JSONValue = .null
    @State private var error: String?

    private var sims: [JSONValue] { data["worldSims"].array }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if data == .null && error == nil { ProgressView("Loading simulations").frame(maxWidth: .infinity).padding(.top, 40) }
                if let error { OpsCard { OpsHealthLine(status: .failed, headline: "Simulations unavailable", detail: error) } }
                if data != .null {
                    SectionLabel(text: "Recent runs", count: sims.count).padding(.bottom, 6)
                    if sims.isEmpty {
                        Text("No simulations yet.").font(.callout).foregroundStyle(OpsTheme.muted).padding(.bottom, 8)
                    }
                    ForEach(sims, id: \.["runId"].string) { sim in
                        let status = OpsStatus.from(sim["status"].string)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline) {
                                OpsStatusBadge(status: status)
                                Spacer()
                                Text("\(Int(sim["currentTurn"].number ?? 0))/\(Int(sim["turns"].number ?? 0))").font(.caption.monospacedDigit()).foregroundStyle(OpsTheme.muted)
                            }
                            Text("\(sim["preset"].string.nonempty ?? "Simulation") · seed \(sim["seed"].string)")
                                .font(.callout.weight(.semibold))
                            Text("\(sim["autonomyLevel"].string) · \(sim["marketSystemMode"].string) · \(OpsFormat.ago(sim["updatedAt"]))")
                                .font(.caption).foregroundStyle(OpsTheme.muted)
                            if let message = sim["error"].string.nonempty {
                                Text(OpsText.scrub(message)).font(.caption).foregroundStyle(OpsTheme.danger).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, 9)
                        .accessibilityElement(children: .combine)
                        Hairline()
                    }
                    Text("The production worker claims new runs only from 03:00 through 08:00 America/New_York. A run already in progress continues.")
                        .font(.caption2).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await load() }
        .task { await load() }
        .opsScreen()
        .navigationTitle("World sims").navigationBarTitleDisplayMode(.inline)
    }

    private func load() async {
        do { data = try await session.get("/api/scheduler"); error = nil }
        catch { self.error = error.displayMessage }
    }
}

// MARK: - Backups and database

struct BackupsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var backups: JSONValue = .null
    @State private var database: JSONValue = .null
    @State private var error: String?

    private var entries: [JSONValue] { backups["backups"].array }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if backups == .null && database == .null && error == nil {
                    ProgressView("Reading backups").frame(maxWidth: .infinity).padding(.top, 40)
                }
                if let error { OpsCard { OpsHealthLine(status: .failed, headline: "Backups unavailable", detail: error) } }
                if let latest = entries.first {
                    OpsCard {
                        Text("Latest backup \(latest["date"].string)").font(.opsCardTitle)
                        Text("\(Int(latest["collections"].number ?? 0)) collections · \(bytes(latest["totalBytes"].number ?? 0)) · \(OpsFormat.ago(.string(latest["date"].string)))")
                            .font(.caption).foregroundStyle(OpsTheme.muted).monospacedDigit()
                        Text("\(entries.count) backups retained").font(.caption2).foregroundStyle(OpsTheme.muted)
                    }
                } else if backups != .null {
                    OpsCard { OpsHealthLine(status: .blocked, headline: "No backups found", detail: "The backup directory has no dated snapshots.") }
                }
                if !entries.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        SectionLabel(text: "Snapshots", count: entries.count)
                        ForEach(Array(entries.prefix(20).enumerated()), id: \.offset) { _, entry in
                            HStack {
                                Text(entry["date"].string).font(.callout.monospaced())
                                Spacer()
                                Text("\(Int(entry["collections"].number ?? 0)) collections · \(bytes(entry["totalBytes"].number ?? 0))")
                                    .font(.caption).foregroundStyle(OpsTheme.muted).monospacedDigit()
                            }.padding(.vertical, 8)
                            Hairline()
                        }
                    }
                }
                if database != .null {
                    VStack(alignment: .leading, spacing: 4) {
                        SectionLabel(text: "Database")
                        row("Collections", "\(Int(database["collections"].number ?? 0))")
                        row("Documents", "\(Int(database["totalDocuments"].number ?? 0))")
                        row("Data", bytes(database["dataSize"].number ?? 0))
                        row("Indexes", bytes(database["indexSize"].number ?? 0))
                    }
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await load() }
        .task { await load() }
        .opsScreen()
        .navigationTitle("Backups").navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack { Text(title).foregroundStyle(OpsTheme.muted); Spacer(); Text(value).monospacedDigit() }
            .font(.callout).padding(.vertical, 7)
    }

    private func bytes(_ value: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(max(0, value)), countStyle: .file)
    }

    private func load() async {
        async let b = try? session.get("/api/backups")
        async let d = try? session.get("/api/db/stats")
        let (bv, dv) = await (b, d)
        if let bv { backups = bv }
        if let dv { database = dv }
        error = bv == nil && dv == nil ? "Backups and database could not be read." : nil
    }
}

// MARK: - Event recovery

struct EventsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var events: [JSONValue] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var replaying: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if !loaded { ProgressView("Reading event stream").frame(maxWidth: .infinity).padding(.top, 40) }
                if let error { OpsCard { OpsHealthLine(status: .failed, headline: "Event recovery unavailable", detail: error) } }
                if loaded && events.isEmpty && error == nil {
                    OpsCard { OpsHealthLine(status: .done, headline: "No failed deliveries", detail: "Every event in the stream has been consumed.") }
                }
                if !events.isEmpty {
                    SectionLabel(text: "Failed deliveries", count: events.count).padding(.bottom, 6)
                    ForEach(events, id: \.["streamId"].string) { event in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .firstTextBaseline) {
                                OpsStatusBadge(status: .failed, label: "Failed")
                                Spacer()
                                Text(event["type"].string).font(.caption2.monospaced()).foregroundStyle(OpsTheme.muted)
                            }
                            if let message = event["error"].string.nonempty {
                                Text(OpsText.scrub(message)).font(.callout).fixedSize(horizontal: false, vertical: true)
                            }
                            Text("\(event["source"].string) · \(OpsFormat.ago(event["occurredAt"]))")
                                .font(.caption).foregroundStyle(OpsTheme.muted)
                            Button(replaying == event["streamId"].string ? "Replaying" : "Replay event") {
                                Task { await replay(event["streamId"].string) }
                            }
                            .font(.caption.weight(.semibold))
                            .disabled(replaying != nil)
                        }
                        .padding(.vertical, 9)
                        Hairline()
                    }
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await load() }
        .task { await load() }
        .opsScreen()
        .navigationTitle("Event recovery").navigationBarTitleDisplayMode(.inline)
    }

    private func load() async {
        do { events = try await session.get("/api/events/dead-letters")["events"].array; error = nil }
        catch { self.error = error.displayMessage }
        loaded = true
    }

    private func replay(_ streamId: String) async {
        replaying = streamId; defer { replaying = nil }
        do {
            _ = try await session.post("/api/events/dead-letters/\(streamId)/replay", [:])
            events.removeAll { $0["streamId"].string == streamId }
        } catch { self.error = error.displayMessage }
    }
}
