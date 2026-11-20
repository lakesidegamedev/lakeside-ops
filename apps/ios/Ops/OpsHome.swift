import SwiftUI
import LakesideCore

/// The single Ops surface. It answers, in order: what is failing or blocked,
/// what needs you, and what Keir's queues hold. Every count on this screen
/// opens the exact list it counts, and every other studio surface is a
/// drill-down from here, each destination appearing once.
struct OpsHub: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @ObservedObject private var attention = AttentionCenter.shared

    private var broken: Int { ops.servicesDown.count + ops.redPRs }
    private var openTickets: Int { ops.openTickets.count }
    private var running: Int { Int(ops.kpis["running"].number ?? 0) }
    private var queued: Int { Int(ops.kpis["queued"].number ?? 0) }
    private var blockedWork: Int { ops.blocked.count }
    private var nowWork: Int { ops.kanban["now"].array.count }
    private var nextWork: Int { ops.kanban["next"].array.count }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                header
                if broken > 0 || blockedWork > 0 { failing }
                needsYou
                queues
                StarmerWidget()
                systems
                keir
            }
            .padding(16)
        }
        .opsScrollable()
        .refreshable { await ops.refresh(session) }
        .opsScreen()
        .navigationTitle("Ops")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: Header

    private var header: some View {
        // Re-read every 30 seconds so "Updated 1m ago" and a stall are honest
        // even when no refresh lands.
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            VStack(alignment: .leading, spacing: 10) {
                Text(headline).font(.opsTitle)
                    .foregroundStyle(broken > 0 ? OpsTheme.danger : blockedWork > 0 ? OpsTheme.warn : OpsTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                OpsHealthLine(status: keirStatus(timeline.date), headline: keirHeadline(timeline.date), detail: ops.heartbeatSentence(now: timeline.date))
                    .accessibilityIdentifier("ops-heartbeat")
            }
        }
    }

    private var headline: String {
        if case .unreachable = ops.heartbeat() { return "Ops is unreachable" }
        if broken > 0 { return broken == 1 ? "One thing is failing" : "\(broken) things are failing" }
        if blockedWork > 0 { return blockedWork == 1 ? "One item is blocked" : "\(blockedWork) items are blocked" }
        if attention.count > 0 { return attention.summary }
        return "Nothing is failing"
    }

    /// Keir's state, only claimed as running while the activity read is fresh.
    private func keirStatus(_ now: Date) -> OpsStatus {
        switch ops.heartbeat(now: now) {
        case .stalled, .unreachable: return .blocked
        case .connecting: return .idle
        case .fresh: return running > 0 ? .running : .idle
        }
    }

    private func keirHeadline(_ now: Date) -> String {
        switch ops.heartbeat(now: now) {
        case .connecting: return "Checking on Keir"
        case .unreachable: return "Keir's state is unknown"
        case .stalled:
            return running > 0 ? "Keir was running \(running) task\(running == 1 ? "" : "s") when last heard from" : "Keir's state is not current"
        case .fresh:
            guard ops.activityUpdated != nil else { return "Keir's activity has not loaded" }
            if running > 0 {
                let rest = queued > 0 ? ", \(queued) queued" : ""
                return "Keir is running \(running) task\(running == 1 ? "" : "s")\(rest)"
            }
            return queued > 0 ? "Keir is idle with \(queued) queued" : "Keir is idle"
        }
    }

    // MARK: Failing and blocked

    private var failing: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Failing and blocked", count: broken + blockedWork, identifier: "ops-failing-count")
            ForEach(ops.servicesDown, id: \.["id"].string) { service in
                NavigationLink { HealthView() } label: {
                    OpsQueueRow(title: service["name"].string.nonempty ?? "Service", detail: serviceDetail(service), status: .failed, icon: "exclamationmark.octagon")
                }
                Hairline()
            }
            if ops.redPRs > 0 {
                NavigationLink { FailedPRsView() } label: {
                    OpsQueueRow(title: "Failing checks", detail: ops.redPRs == 1 ? "1 open pull request" : "\(ops.redPRs) open pull requests", status: .failed, icon: "arrow.triangle.pull")
                }
                Hairline()
            }
            ForEach(Array(ops.blocked.prefix(3).enumerated()), id: \.offset) { _, item in
                NavigationLink { WorkItemDetail(item: item) } label: {
                    OpsQueueRow(title: OpsText.scrub(item["title"].string.nonempty ?? "Blocked work"), detail: blockedDetail(item), status: .blocked, icon: "exclamationmark.triangle")
                }
                Hairline()
            }
            if blockedWork > 3 {
                NavigationLink { WorkView(lane: .blocked) } label: {
                    OpsQueueRow(title: "All blocked work", detail: "\(blockedWork) items", status: .blocked, icon: "list.bullet")
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func serviceDetail(_ service: JSONValue) -> String {
        let state = service["current"].string.capitalized
        let checked = OpsFormat.ago(service["lastChecked"])
        return checked.isEmpty ? state : "\(state) · checked \(checked)"
    }

    private func blockedDetail(_ item: JSONValue) -> String {
        let reason = OpsText.firstSentence(item["stale_reason"].string.nonempty ?? item["progress_summary"].string)
        let since = OpsFormat.ago(item["updated_at"])
        return [reason, since.isEmpty ? "" : "since \(since)"].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Needs you

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: 10) {
            if attention.count == 0 {
                Text("Nothing needs you.").font(.caption).foregroundStyle(OpsTheme.muted)
                    .accessibilityIdentifier("ops-attention-count")
            } else {
                HStack(alignment: .firstTextBaseline) {
                    SectionLabel(text: AttentionCenter.label, count: attention.count, identifier: "ops-attention-count")
                    Button("Review all \(attention.count)") { router.activityFilter = "needs-you"; router.tab = .activity }
                        .font(.caption.weight(.semibold))
                        .accessibilityIdentifier("ops-review-attention")
                }
                AttentionStack(limit: 3, showEmpty: false)
            }
        }
    }

    // MARK: Queues

    private var queues: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Queues")
            NavigationLink { WorkView(lane: .now) } label: {
                OpsQueueRow(title: "Studio work in progress", detail: "\(nowWork)", status: .idle, icon: "rectangle.split.3x1")
            }
            Hairline()
            NavigationLink { WorkView(lane: .blocked) } label: {
                OpsQueueRow(title: "Blocked", detail: "\(blockedWork)", status: blockedWork > 0 ? .blocked : .idle, icon: "exclamationmark.triangle")
            }
            Hairline()
            NavigationLink { WorkView(lane: .next) } label: {
                OpsQueueRow(title: "Next", detail: nextWork == 0 ? "Nothing queued" : "\(nextWork) queued", status: nextWork > 0 ? .queued : .idle, icon: "text.line.first.and.arrowtriangle.forward")
            }
            Hairline()
            NavigationLink { DeskView() } label: {
                OpsQueueRow(title: "Support desk", detail: openTickets == 1 ? "1 open ticket" : openTickets == 0 ? "No open tickets" : "\(openTickets) open tickets", status: openTickets > 0 ? .queued : .idle, icon: "tray.full")
            }
            Hairline()
            NavigationLink { HealthView() } label: {
                OpsQueueRow(title: "Health detail", detail: "Host, activity and alerts", status: broken > 0 ? .failed : .idle, icon: "waveform.path.ecg")
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Studio systems

    private var systems: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Studio systems")
            NavigationLink { SchedulerView() } label: {
                OpsQueueRow(title: "Scheduler", detail: schedulerDetail, status: schedulerStatus, icon: "calendar.badge.clock")
            }
            NavigationLink { SecurityView() } label: {
                OpsQueueRow(title: "Security", detail: "Host posture and findings", status: .queued, icon: "lock.shield")
            }
            NavigationLink { PullRequestsView() } label: {
                OpsQueueRow(title: "Pull requests", detail: "\(Int(ops.kpis["prsOpen"].number ?? 0)) open · \(ops.redPRs) failing checks", status: ops.redPRs > 0 ? .failed : .queued, icon: "arrow.triangle.pull")
            }
            NavigationLink { WorktreesView() } label: {
                OpsQueueRow(title: "Worktrees and agents", detail: "Live sessions and checkouts", status: .queued, icon: "point.topleft.down.to.point.bottomright.curvepath")
            }
            NavigationLink { WorldSimsView() } label: {
                OpsQueueRow(title: "World simulations", detail: simsDetail, status: simsStatus, icon: "globe.americas")
            }
            NavigationLink { BackupsView() } label: {
                OpsQueueRow(title: "Backups and database", detail: "Recency, size and collections", status: .queued, icon: "externaldrive")
            }
            NavigationLink { EventsView() } label: {
                OpsQueueRow(title: "Event recovery", detail: "Failed deliveries waiting for replay", status: .queued, icon: "arrow.clockwise.circle")
            }
        }
    }

    private var schedulerDetail: String {
        let checks = ops.scheduler["checks"].array
        let runningChecks = checks.filter { $0["state"].string == "running" }.count
        let queuedChecks = checks.filter { $0["state"].string == "queued" }.count
        return "\(runningChecks) checks running · \(queuedChecks) queued"
    }
    private var schedulerStatus: OpsStatus {
        if ops.scheduler == .null { return .idle }
        let checks = ops.scheduler["checks"].array
        if checks.contains(where: { $0["state"].string == "running" }) { return .running }
        return checks.isEmpty ? .done : .queued
    }
    private var simsDetail: String {
        let sims = ops.scheduler["worldSims"].array
        if ops.scheduler["worldSimError"].string.nonempty != nil { return "Sim queue unreachable" }
        let live = sims.filter { ["running", "queued", "claimed"].contains($0["status"].string) }.count
        return live == 0 ? "No run active · overnight window" : "\(live) active or queued"
    }
    private var simsStatus: OpsStatus {
        if ops.scheduler["worldSimError"].string.nonempty != nil { return .failed }
        if ops.scheduler == .null { return .idle }
        let live = ops.scheduler["worldSims"].array.filter { $0["status"].string == "running" }.count
        return live > 0 ? .running : .queued
    }

    // MARK: Keir surfaces

    private var keir: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Keir")
            NavigationLink(value: StudioRoute.feed) {
                OpsQueueRow(title: "Feed", detail: "Briefing, what Keir did, what is next", status: .idle, icon: "sparkles.rectangle.stack")
            }
            NavigationLink(value: StudioRoute.goals) {
                OpsQueueRow(title: "Goals", detail: "Milestones and blockers", status: .idle, icon: "flag")
            }
            NavigationLink { KeirMetricsView() } label: {
                OpsQueueRow(title: "Dashboard", detail: "Execution metrics and monitoring", status: .idle, icon: "chart.bar.xaxis")
            }
            NavigationLink { IdeasView() } label: {
                OpsQueueRow(title: "Ideas", detail: "Triage what Keir found", status: .queued, icon: "lightbulb")
            }
            NavigationLink { WatchesView() } label: {
                OpsQueueRow(title: "Watches", detail: "Tell Keir when something changes", status: .idle, icon: "binoculars")
            }
            NavigationLink { MemoryView() } label: {
                OpsQueueRow(title: "Memory", detail: "What Keir keeps across sessions", status: .idle, icon: "brain")
            }
            NavigationLink { FilesView() } label: {
                OpsQueueRow(title: "Files", detail: "Reports and charts", status: .idle, icon: "doc.richtext")
            }
            NavigationLink { UpcomingView() } label: {
                OpsQueueRow(title: "Upcoming", detail: "What Keir does next", status: .idle, icon: "calendar")
            }
        }
    }
}

struct OpsQueueRow: View {
    let title: String
    let detail: String
    var status: OpsStatus = .idle
    let icon: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.callout)
                .foregroundStyle(status.color)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                Text(detail).font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(detail)")
        .accessibilityAddTraits(.isButton)
    }
}
