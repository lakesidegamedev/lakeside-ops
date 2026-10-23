import SwiftUI
import LakesideCore

/// The single Ops surface. It answers the three questions in order: what needs
/// you, what Keir is doing, and whether anything is broken. Every other studio
/// surface is a drill-down from here, and each destination appears once.
struct OpsHub: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @ObservedObject private var attention = AttentionCenter.shared

    private var broken: Int { ops.servicesDown.count + ops.redPRs }
    private var openTickets: Int { Int(ops.kpis["openTickets"].number ?? 0) }
    private var running: Int { Int(ops.kpis["running"].number ?? 0) }
    private var queued: Int { Int(ops.kpis["queued"].number ?? 0) }
    private var blockedWork: Int { max(Int(ops.kanban["counts"]["blocked"].number ?? 0), ops.blocked.count) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                StarmerWidget()
                briefing
                needsYou
                queues
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

    // MARK: Briefing

    private var briefing: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(headline).font(.opsHero).foregroundStyle(OpsTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(subline).font(.callout).foregroundStyle(OpsTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let error = ops.error {
                Text(error).font(.caption).foregroundStyle(OpsTheme.warn)
            }
            if attention.count > 0 {
                OpsPrimaryButton(title: "Review \(attention.count) waiting", icon: "hand.raised.fill") {
                    router.activityFilter = "all"; router.tab = .activity
                }
                .accessibilityIdentifier("ops-review-attention")
            } else {
                OpsPrimaryButton(title: "Open Keir", icon: "bubble.left.and.text.bubble.right") {
                    router.tab = .keir
                }
                .accessibilityIdentifier("ops-open-keir")
            }
            OpsHealthLine(status: workingStatus, headline: workingHeadline, detail: workingDetail)
        }
    }

    private var headline: String {
        if ops.updated == nil && ops.error != nil { return "Ops is unreachable" }
        if broken > 0 { return broken == 1 ? "One thing is broken" : "\(broken) things are broken" }
        if blockedWork > 0 { return blockedWork == 1 ? "One queue is blocked" : "\(blockedWork) items are blocked" }
        return "Everything is healthy"
    }

    private var subline: String {
        if ops.updated == nil && ops.error != nil { return "Keir keeps working. Pull to reconnect." }
        var parts: [String] = []
        parts.append(attention.summary)
        if broken == 0 { parts.append("no failures") } else { parts.append("\(broken) failing") }
        if let updated = ops.updated { parts.append("checked \(OpsFormat.ago(updated))") }
        return parts.joined(separator: " · ")
    }

    private var workingStatus: OpsStatus {
        if running > 0 { return .running }
        if blockedWork > 0 { return .blocked }
        return .done
    }

    private var workingHeadline: String {
        if running > 0 { return "Keir is working on \(running) task\(running == 1 ? "" : "s")" }
        return "Keir is idle"
    }

    private var workingDetail: String {
        var parts: [String] = []
        if queued > 0 { parts.append("\(queued) queued") }
        if blockedWork > 0 { parts.append("\(blockedWork) blocked") }
        if !ops.servicesDown.isEmpty { parts.append("\(ops.servicesDown.count) degraded") }
        return parts.isEmpty ? "No queue and no failures." : parts.joined(separator: " · ")
    }

    // MARK: Needs you

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                SectionLabel(text: AttentionCenter.label, count: attention.count, identifier: "ops-attention-count")
                if attention.count > 0 {
                    Button("See all") { router.activityFilter = "all"; router.tab = .activity }
                        .font(.caption.weight(.semibold))
                        .accessibilityIdentifier("ops-attention-all")
                }
            }
            AttentionStack(limit: 3, showEmpty: true)
            if attention.count == 0 {
                Text("Keir will surface decisions, questions and owner work here.")
                    .font(.caption).foregroundStyle(OpsTheme.muted)
            }
        }
    }

    // MARK: Queues

    private var queues: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Queues")
            NavigationLink { DeskView() } label: {
                OpsQueueRow(title: "Support desk", detail: openTickets == 1 ? "1 open ticket" : "\(openTickets) open tickets", status: openTickets > 0 ? .queued : .done, icon: "tray.full")
            }
            NavigationLink { WorkView(lane: .now) } label: {
                OpsQueueRow(title: "Work in progress", detail: "\(Int(ops.kanban["counts"]["now"].number ?? 0)) moving", status: .running, icon: "rectangle.split.3x1")
            }
            NavigationLink { WorkView(lane: .blocked) } label: {
                OpsQueueRow(title: "Blocked", detail: "\(blockedWork) needs unblocking", status: blockedWork > 0 ? .blocked : .done, icon: "exclamationmark.triangle")
            }
            NavigationLink { WorkView(lane: .next) } label: {
                OpsQueueRow(title: "Next", detail: "\(Int(ops.kanban["counts"]["next"].number ?? 0)) queued", status: .queued, icon: "text.line.first.and.arrowtriangle.forward")
            }
            NavigationLink { HealthView() } label: {
                OpsQueueRow(title: "Health detail", detail: broken == 0 ? "Host, activity and alerts" : "\(broken) failing right now", status: broken > 0 ? .failed : .done, icon: "waveform.path.ecg")
            }
        }
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
