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
    @Environment(\.dynamicTypeSize) private var textSize

    private var broken: Int { issues.filter { ops.serviceState($0) == "Failing" }.count + ops.redPRs }
    private var degraded: Int { issues.filter { ops.serviceState($0) == "Degraded" }.count }
    private var issues: [JSONValue] { ops.servicesDown }
    private var openTickets: Int { ops.openTickets.count }
    private var activity: [JSONValue] { ops.tasks + ops.openTickets }
    private var running: Bool { activity.contains { WorkQueuePresentation.bucket($0) == "working" } }
    private var queued: Bool { activity.contains { WorkQueuePresentation.bucket($0) == "waiting" } }
    private var blockedWork: Int { ops.blockedQueueCount }
    private var nowWork: Int { ops.kanban["now"].array.count }
    private var nextWork: Int { ops.kanban["next"].array.count }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                header
                summary
                if !issues.isEmpty || ops.redPRs > 0 { failing }
                queues
                systems
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
            VStack(alignment: .leading, spacing: 12) {
                OpsCard {
                    HStack(spacing: 12) {
                        OpsGlyph(icon: overviewIcon, tone: overviewTone, size: 42)
                        Text(headline).font(.opsTitle)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                OpsHealthLine(status: keirStatus(timeline.date), headline: keirHeadline(timeline.date), detail: ops.heartbeatSentence(now: timeline.date))
                    .accessibilityIdentifier("ops-heartbeat")
            }
        }
    }

    private var overviewTone: Color {
        if broken > 0 { return OpsTheme.danger }
        return degraded > 0 ? OpsTheme.warning : OpsTheme.accent
    }

    private var overviewIcon: String {
        if broken > 0 { return "exclamationmark.octagon.fill" }
        if degraded > 0 { return "exclamationmark.triangle.fill" }
        return "waveform.path.ecg"
    }

    private var summary: some View {
        let columns = textSize.isAccessibilitySize ? 1 : 3
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
            Button { router.activityFilter = "needs-you"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Needs you", count: attention.count, icon: "hand.raised.fill", tone: OpsTheme.warning)
            }
            Button { router.activityFilter = "failing"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Failing checks", count: ops.redPRs, icon: "xmark.circle.fill", tone: OpsTheme.danger)
            }
            Button { router.activityFilter = "stuck"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Blocked work", count: blockedWork, icon: "exclamationmark.triangle.fill", tone: OpsTheme.warning)
            }
        }.buttonStyle(.plain)
    }

    private var headline: String {
        if case .unreachable = ops.heartbeat() { return "Ops is unreachable" }
        if broken > 0 { return broken == 1 ? "One thing is failing" : "\(broken) things are failing" }
        if degraded > 0 { return degraded == 1 ? "One service is degraded" : "\(degraded) services are degraded" }
        if issues.contains(where: { ops.serviceState($0) == "Stale" }) { return "Some checks are out of date" }
        return "Nothing is failing"
    }

    /// Keir's state, only claimed as running while the activity read is fresh.
    private func keirStatus(_ now: Date) -> OpsStatus {
        switch ops.heartbeat(now: now) {
        case .stalled, .unreachable: return .blocked
        case .connecting: return .idle
        case .fresh:
            if running { return .running }
            return activity.contains { WorkQueuePresentation.state($0) == "stalled" } ? .failed : .idle
        }
    }

    private func keirHeadline(_ now: Date) -> String {
        switch ops.heartbeat(now: now) {
        case .connecting: return "Checking on Keir"
        case .unreachable: return "Keir's state is unknown"
        case .stalled:
            return "Keir’s activity is out of date"
        case .fresh:
            guard ops.activityUpdated != nil else { return "Keir's activity has not loaded" }
            if running { return "Keir is working" }
            if activity.contains(where: { WorkQueuePresentation.state($0) == "stalled" }) {
                return "Keir has stalled work"
            }
            return queued ? "Keir is idle with work queued" : "Keir is idle"
        }
    }

    // MARK: Failing and blocked

    private var failing: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Issues", identifier: "ops-failing-count")
            ForEach(ops.failingPRs, id: \.["number"].string) { pr in
                Button { router.activityFilter = "failing"; router.tab = .activity } label: {
                    OpsQueueRow(title: pr["title"].string.nonempty ?? "Pull request #\(pr["number"].string)", detail: "Failing · Checks", status: .failed, icon: "xmark.circle")
                }
                Hairline()
            }
            ForEach(issues, id: \.["id"].string) { service in
                let state = ops.serviceState(service)
                let status: OpsStatus = state == "Failing" ? .failed : state == "Degraded" ? .blocked : .idle
                NavigationLink { HealthView() } label: {
                    let checked = OpsFormat.date(service["lastChecked"]).map(OpsFormat.contextual)
                    OpsQueueRow(title: service["name"].string.nonempty ?? "Service", detail: [state, checked.map { "Checked " + $0 }].compactMap { $0 }.joined(separator: " · "), status: status, icon: status.icon)
                }
                Hairline()
            }
            if issues.contains(where: { ops.serviceState($0) == "Stale" }) {
                Button { Task { await ops.refresh(session) } } label: {
                    Label("Re-check services", systemImage: "arrow.clockwise").font(.opsCaption).foregroundStyle(OpsTheme.accent)
                }.padding(.vertical, 8)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Queues

    private var queues: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Queues")
            NavigationLink { WorkView(lane: .now) } label: {
                OpsQueueRow(title: "Studio work in progress", detail: "\(nowWork)", status: .idle, icon: "rectangle.split.3x1")
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

}

struct KeirMore: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView { destinations.padding(16) }
                .opsScrollable().opsScreen().navigationTitle("More").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private var destinations: some View {
        VStack(alignment: .leading, spacing: 4) {
            NavigationLink { FeedView() } label: {
                OpsQueueRow(title: "Feed", detail: "Briefing, what Keir did, what is next", status: .idle, icon: "sparkles.rectangle.stack")
            }
            NavigationLink { GoalsView() } label: {
                OpsQueueRow(title: "Goals", detail: "Milestones and blockers", status: .idle, icon: "flag")
            }
            NavigationLink { KeirMetricsView() } label: {
                OpsQueueRow(title: "Execution metrics", detail: "Performance and monitoring", status: .idle, icon: "chart.bar.xaxis")
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

private struct OpsSummaryTile: View {
    let title: String
    let count: Int
    let icon: String
    let tone: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 4) {
                OpsGlyph(icon: icon, tone: count > 0 ? tone : OpsTheme.neutral, size: 28)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
            }
            Text(count.formatted()).font(.opsTitle.monospacedDigit()).foregroundStyle(OpsTheme.ink)
            Text(title).font(.opsCaption.weight(.semibold)).foregroundStyle(OpsTheme.muted)
                .lineLimit(2).frame(minHeight: 28, alignment: .topLeading)
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 102, alignment: .topLeading)
        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 15))
        .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(OpsTheme.hairline))
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(count)")
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
