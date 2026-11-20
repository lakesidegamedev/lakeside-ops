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
            LazyVStack(alignment: .leading, spacing: 20) {
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
            // System health and Keir's own state share one card: the answer to
            // "is anything broken, and is Keir on it" in a single glance.
            OpsCard(spacing: 12) {
                Button {
                    if ops.redPRs > 0 { router.activityFilter = "failing"; router.tab = .activity }
                } label: {
                    HStack(spacing: 12) {
                        OpsGlyph(icon: overviewIcon, tone: overviewTone, size: 40)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(headline).font(.system(.title3, design: .rounded).weight(.bold))
                                .foregroundStyle(OpsTheme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                            // Name what is wrong, so the headline is never a
                            // count with nothing behind it.
                            if !overviewDetail.isEmpty {
                                Text(overviewDetail).font(.caption).foregroundStyle(OpsTheme.muted)
                                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                        if ops.redPRs > 0 {
                            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
                        }
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .allowsHitTesting(ops.redPRs > 0)
                Rectangle().fill(OpsTheme.hairline).frame(height: 1)
                OpsHealthLine(status: keirStatus(timeline.date), headline: keirHeadline(timeline.date), detail: ops.heartbeatSentence(now: timeline.date))
                    .accessibilityIdentifier("ops-heartbeat")
            }
            .overlay {
                // A status stripe on the card edge carries the overall colour.
                HStack(spacing: 0) {
                    Rectangle().fill(overviewTone).frame(width: 4)
                    Spacer(minLength: 0)
                }
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    private var overviewDetail: String {
        let prNames: [String] = ops.failingPRs.map { (pr: JSONValue) -> String in
            pr["title"].string.nonempty ?? "Pull request #" + pr["number"].string
        }
        let serviceNames: [String] = issues
            .filter { (service: JSONValue) -> Bool in ["Failing", "Degraded"].contains(ops.serviceState(service)) }
            .map { (service: JSONValue) -> String in service["name"].string.nonempty ?? "A service" }
        let failingNames = prNames + serviceNames
        var parts: [String] = []
        if !failingNames.isEmpty { parts.append(failingNames.prefix(2).joined(separator: ", ") + (failingNames.count > 2 ? " and \(failingNames.count - 2) more" : "")) }
        let stale = issues.filter { ops.serviceState($0) == "Stale" }.count
        if stale > 0 { parts.append(stale == 1 ? "1 service has not been checked in over a day" : "\(stale) services have not been checked in over a day") }
        return parts.joined(separator: ". ")
    }

    private var overviewTone: Color {
        if broken > 0 { return OpsTheme.danger }
        return degraded > 0 ? OpsTheme.warning : OpsTheme.accent
    }

    private var overviewIcon: String {
        if broken > 0 { return "xmark.circle.fill" }
        if degraded > 0 { return "exclamationmark.triangle.fill" }
        return "waveform.path.ecg"
    }

    private var summary: some View {
        // The same buckets, labels and order as the Inbox filter chips, so a
        // number here always matches the chip it opens.
        let columns = textSize.isAccessibilitySize ? 1 : 3
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
            Button { router.activityFilter = "needs-you"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Needs you", count: attention.count, icon: "hand.raised.fill", tone: OpsTheme.warning)
            }.accessibilityIdentifier("ops-review-attention")
            Button { router.activityFilter = "unanswered"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Unanswered", count: ops.queueCount("unanswered"), icon: "bubble.left.and.exclamationmark.bubble.right.fill", tone: OpsTheme.warning)
            }
            Button { router.activityFilter = "stalled"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Stalled", count: ops.queueCount("stalled"), icon: "xmark.octagon.fill", tone: OpsTheme.danger)
            }
            Button { router.activityFilter = "stuck"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Blocked", count: blockedWork, icon: "lock.fill", tone: OpsTheme.blocked)
            }
            Button { router.activityFilter = "failing"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Failing checks", count: ops.redPRs, icon: "xmark.circle.fill", tone: OpsTheme.danger)
            }
            Button { router.activityFilter = "working"; router.tab = .activity } label: {
                OpsSummaryTile(title: "Running", count: ops.queueCount("working"), icon: "gearshape.2.fill", tone: OpsTheme.mint)
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
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Issues", count: ops.failingPRs.count + issues.count, identifier: "ops-failing-count")
            OpsGroup {
                ForEach(Array(ops.failingPRs.enumerated()), id: \.element["number"].string) { index, pr in
                    if index > 0 { OpsGroupDivider() }
                    Button { router.activityFilter = "failing"; router.tab = .activity } label: {
                        OpsQueueRow(title: pr["title"].string.nonempty ?? "Pull request #\(pr["number"].string)", detail: "Checks failing on pull request #\(pr["number"].string)", status: .failed, icon: "xmark.circle.fill")
                    }
                }
                ForEach(Array(issues.enumerated()), id: \.element["id"].string) { index, service in
                    if index > 0 || !ops.failingPRs.isEmpty { OpsGroupDivider() }
                    let state = ops.serviceState(service)
                    let status: OpsStatus = state == "Failing" ? .failed : state == "Degraded" ? .blocked : .idle
                    NavigationLink { HealthView() } label: {
                        let checked = OpsFormat.date(service["lastChecked"]).map(OpsFormat.contextual)
                        OpsQueueRow(title: service["name"].string.nonempty ?? "Service", detail: [state == "Stale" ? "No recent check" : state, checked.map { "last checked " + $0 }].compactMap { $0 }.joined(separator: ", "), status: status, icon: state == "Stale" ? "clock.badge.questionmark" : status.icon, tint: ["Stale", "Degraded"].contains(state) ? OpsTheme.warning : nil)
                    }
                }
                if issues.contains(where: { ops.serviceState($0) == "Stale" }) {
                    OpsGroupDivider()
                    Button { Task { await ops.refresh(session) } } label: {
                        HStack(spacing: 12) {
                            OpsGlyph(icon: "arrow.clockwise", tone: OpsTheme.accent, size: 30)
                            Text("Re-check services").font(.subheadline.weight(.semibold)).foregroundStyle(OpsTheme.accent)
                            Spacer(minLength: 0)
                        }.padding(.vertical, 9).contentShape(Rectangle())
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Queues

    private var queues: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Queues")
            OpsGroup {
                NavigationLink { WorkView(lane: .now) } label: {
                    OpsQueueRow(title: "Studio work in progress", detail: nowWork == 0 ? "Nothing in progress" : nowWork == 1 ? "1 item being worked on" : "\(nowWork) items being worked on", status: nowWork > 0 ? .running : .idle, icon: "rectangle.split.3x1", value: nowWork > 0 ? "\(nowWork)" : nil)
                }
                OpsGroupDivider()
                NavigationLink { WorkView(lane: .next) } label: {
                    OpsQueueRow(title: "Next", detail: nextWork == 0 ? "Nothing queued" : nextWork == 1 ? "1 item queued" : "\(nextWork) items queued", status: nextWork > 0 ? .queued : .idle, icon: "text.line.first.and.arrowtriangle.forward", value: nextWork > 0 ? "\(nextWork)" : nil)
                }
                OpsGroupDivider()
                NavigationLink { DeskView() } label: {
                    OpsQueueRow(title: "Support desk", detail: openTickets == 1 ? "1 open ticket" : openTickets == 0 ? "No open tickets" : "\(openTickets) open tickets", status: openTickets > 0 ? .queued : .idle, icon: "tray.full", value: openTickets > 0 ? "\(openTickets)" : nil)
                }
                OpsGroupDivider()
                NavigationLink { HealthView() } label: {
                    OpsQueueRow(title: "Health detail", detail: "Host, activity and alerts", status: broken > 0 ? .failed : .idle, icon: "waveform.path.ecg", tint: broken > 0 ? nil : OpsTheme.mint)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Studio systems

    private var systems: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Studio systems")
            OpsGroup {
                NavigationLink { SchedulerView() } label: {
                    OpsQueueRow(title: "Scheduler", detail: schedulerDetail, status: schedulerStatus, icon: "calendar.badge.clock")
                }
                OpsGroupDivider()
                NavigationLink { SecurityView() } label: {
                    OpsQueueRow(title: "Security", detail: "Host posture and findings", status: .queued, icon: "lock.shield")
                }
                OpsGroupDivider()
                NavigationLink { PullRequestsView() } label: {
                    OpsQueueRow(title: "Pull requests", detail: prDetail, status: ops.redPRs > 0 ? .failed : .queued, icon: "arrow.triangle.pull")
                }
                OpsGroupDivider()
                NavigationLink { WorktreesView() } label: {
                    OpsQueueRow(title: "Worktrees and agents", detail: "Live sessions and checkouts", status: .queued, icon: "point.topleft.down.to.point.bottomright.curvepath", tint: OpsTheme.mint)
                }
                OpsGroupDivider()
                NavigationLink { WorldSimsView() } label: {
                    OpsQueueRow(title: "World simulations", detail: simsDetail, status: simsStatus, icon: "globe.americas")
                }
                OpsGroupDivider()
                NavigationLink { BackupsView() } label: {
                    OpsQueueRow(title: "Backups and database", detail: "Recency, size and collections", status: .queued, icon: "externaldrive", tint: OpsTheme.mint)
                }
                OpsGroupDivider()
                NavigationLink { EventsView() } label: {
                    OpsQueueRow(title: "Event recovery", detail: "Failed deliveries waiting for replay", status: .queued, icon: "arrow.clockwise.circle")
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var schedulerDetail: String {
        let checks = ops.scheduler["checks"].array
        let runningChecks = checks.filter { $0["state"].string == "running" }.count
        let queuedChecks = checks.filter { $0["state"].string == "queued" }.count
        if runningChecks == 0 && queuedChecks == 0 { return "No checks running or queued" }
        return "Checks: \(runningChecks) running, \(queuedChecks) queued"
    }
    private var prDetail: String {
        let open = Int(ops.kpis["prsOpen"].number ?? 0)
        let red = ops.redPRs
        let openText = open == 1 ? "1 open" : "\(open) open"
        return red == 0 ? openText : openText + ", \(red) with failing checks"
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

    private var live: Bool { count > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                OpsGlyph(icon: icon, tone: live ? tone : OpsTheme.neutral, size: 26)
                Text(count.formatted()).font(.system(.title2, design: .rounded).weight(.bold).monospacedDigit())
                    .foregroundStyle(live ? tone : OpsTheme.muted)
                    .lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
            }
            Text(title).font(.opsCaption.weight(.semibold)).foregroundStyle(live ? OpsTheme.ink : OpsTheme.muted)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 70, alignment: .topLeading)
        .background(live ? tone.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .opsSurface(radius: 16)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(live ? tone.opacity(0.35) : .clear))
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
    /// A short figure shown before the chevron, such as a count.
    var value: String? = nil
    /// Overrides the status colour for the icon tile only.
    var tint: Color? = nil
    var verticalPadding: CGFloat = 9

    var body: some View {
        HStack(spacing: 12) {
            OpsGlyph(icon: icon, tone: tint ?? status.color, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if let value {
                Text(value).font(.subheadline.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(status == .idle || status == .done ? OpsTheme.muted : status.color)
            }
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
        }
        .padding(.vertical, verticalPadding)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(detail)")
        .accessibilityAddTraits(.isButton)
    }
}
