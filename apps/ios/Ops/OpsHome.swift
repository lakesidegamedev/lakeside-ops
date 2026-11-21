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
    private var running: Bool { ops.queue.contains { $0.bucket == "working" } }
    private var queued: Bool { ops.queue.contains { $0.bucket == "waiting" } }
    private var blockedWork: Int { ops.blockedQueueCount }
    private var nowWork: Int { ops.kanban["now"].array.count }
    private var nextWork: Int { ops.kanban["next"].array.count }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
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
            // The health card answers "is anything broken"; Keir's own state
            // is a neutral line under it, so a healthy signal never sits
            // inside an alarm.
            VStack(alignment: .leading, spacing: 10) {
                OpsCard(padding: 14, spacing: 0) {
                    Button {
                        if ops.redPRs > 0 { router.activityFilter = "failing"; router.tab = .activity }
                    } label: {
                        HStack(spacing: 12) {
                            OpsGlyph(icon: overviewIcon, tone: overviewTone, size: 38)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(headline).font(.system(.title3, design: .rounded).weight(.bold))
                                    .foregroundStyle(OpsTheme.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityAddTraits(.isHeader)
                                // Name what is wrong, most severe first, so the
                                // headline is never a count with nothing behind it.
                                if !overviewDetail.isEmpty {
                                    Text(overviewDetail).font(.caption).foregroundStyle(OpsTheme.muted)
                                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
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
                }
                .opsLeadingStripe(overviewTone)
                OpsHealthLine(status: keirStatus(timeline.date), headline: keirHeadline(timeline.date), detail: ops.heartbeatSentence(now: timeline.date))
                    .padding(.horizontal, 4)
                    .accessibilityIdentifier("ops-heartbeat")
            }
        }
    }

    /// Every issue the Issues list shows, counted the same way, so the
    /// headline and the list can never disagree.
    private var issueCount: Int { ops.failingPRs.count + issues.count }

    private var overviewDetail: String {
        let prNames: [String] = ops.failingPRs.map { (pr: JSONValue) -> String in
            pr["title"].string.nonempty ?? "Change #" + pr["number"].string
        }
        let failingServices: [String] = issues
            .filter { (service: JSONValue) -> Bool in ops.serviceState(service) == "Failing" }
            .map { (service: JSONValue) -> String in service["name"].string.nonempty ?? "A service" }
        let degradedServices: [String] = issues
            .filter { (service: JSONValue) -> Bool in ops.serviceState(service) == "Degraded" }
            .map { (service: JSONValue) -> String in service["name"].string.nonempty ?? "A service" }
        let staleServices: [String] = issues
            .filter { (service: JSONValue) -> Bool in ops.serviceState(service) == "Stale" }
            .map { (service: JSONValue) -> String in service["name"].string.nonempty ?? "A service" }
        func list(_ names: [String]) -> String {
            names.prefix(2).joined(separator: ", ") + (names.count > 2 ? " and \(names.count - 2) more" : "")
        }
        var parts: [String] = []
        let failing = prNames + failingServices
        if !failing.isEmpty { parts.append("Failing: " + list(failing)) }
        if !degradedServices.isEmpty { parts.append("Slow or partly down: " + list(degradedServices)) }
        if !staleServices.isEmpty { parts.append("Not checked in over a day: " + list(staleServices)) }
        return parts.joined(separator: ". ")
    }

    private var overviewTone: Color {
        if broken > 0 { return OpsWorkState.failing.color }
        return degraded > 0 || issueCount > 0 ? OpsTheme.caution : OpsTheme.mint
    }

    private var overviewIcon: String {
        if broken > 0 { return OpsWorkState.failing.glyph }
        if degraded > 0 || issueCount > 0 { return "exclamationmark.triangle.fill" }
        return "checkmark.circle.fill"
    }

    private var summary: some View {
        // The same buckets, labels and order as the Inbox filter chips, so a
        // number here always matches the chip it opens.
        let columns = textSize.isAccessibilitySize ? 1 : 3
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
            tile(.needsYou, count: attention.count).accessibilityIdentifier("ops-review-attention")
            tile(.unanswered, count: ops.queueCount("unanswered"))
            tile(.stalled, count: ops.queueCount("stalled"))
            tile(.blocked, count: blockedWork)
            tile(.failing, count: ops.redPRs)
            tile(.running, count: ops.queueCount("working"))
        }.buttonStyle(.plain)
    }

    private var headline: String {
        if case .unreachable = ops.heartbeat() { return "Ops is unreachable" }
        // The same number as the Issues list below, with the worst part named.
        guard issueCount > 0 else { return "Nothing is failing" }
        let count = issueCount == 1 ? "1 issue" : "\(issueCount) issues"
        if broken > 0 { return count + ", \(broken) failing" }
        if degraded > 0 { return count + ", \(degraded) slow" }
        return count
    }

    private func tile(_ state: OpsWorkState, count: Int) -> some View {
        Button { router.activityFilter = state.filter; router.tab = .activity } label: {
            OpsSummaryTile(state: state, count: count)
        }
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
                        OpsQueueRow(title: pr["title"].string.nonempty ?? "Change #\(pr["number"].string)", detail: "Tests failing on fix #\(pr["number"].string), so it cannot ship yet", status: .failed, icon: OpsWorkState.failing.glyph)
                    }
                }
                ForEach(Array(issues.enumerated()), id: \.element["id"].string) { index, service in
                    if index > 0 || !ops.failingPRs.isEmpty { OpsGroupDivider() }
                    let state = ops.serviceState(service)
                    let status: OpsStatus = state == "Failing" ? .failed : state == "Degraded" ? .blocked : .idle
                    NavigationLink { HealthView() } label: {
                        let checked = OpsFormat.date(service["lastChecked"]).map(OpsFormat.contextual)
                        OpsQueueRow(title: service["name"].string.nonempty ?? "Service", detail: [state == "Stale" ? "No recent check" : state == "Degraded" ? "Slow or partly down" : state, checked.map { "last checked " + $0 }].compactMap { $0 }.joined(separator: ", "), status: status, icon: state == "Stale" ? "clock.badge.questionmark" : state == "Degraded" ? "exclamationmark.triangle.fill" : status.icon, tint: ["Stale", "Degraded"].contains(state) ? OpsTheme.caution : nil)
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
                    OpsQueueRow(title: "Studio work in progress", detail: "Studio board items being built now", status: nowWork > 0 ? .running : .idle, icon: "rectangle.split.3x1", value: "\(nowWork)")
                }
                OpsGroupDivider()
                NavigationLink { WorkView(lane: .next) } label: {
                    OpsQueueRow(title: "Up next", detail: "Studio board items waiting to start", status: nextWork > 0 ? .queued : .idle, icon: "text.line.first.and.arrowtriangle.forward", value: "\(nextWork)")
                }
                OpsGroupDivider()
                NavigationLink { DeskView() } label: {
                    OpsQueueRow(title: "Support desk", detail: "Open player tickets Keir is handling", status: openTickets > 0 ? .queued : .idle, icon: "tray.full", value: "\(openTickets)")
                }
                OpsGroupDivider()
                NavigationLink { HealthView() } label: {
                    OpsQueueRow(title: "Server health", detail: "Server load, Keir's activity and alerts", status: broken > 0 ? .failed : .idle, icon: "waveform.path.ecg", tint: broken > 0 ? nil : OpsTheme.mint)
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
                    OpsQueueRow(title: "Security", detail: "Server security scans and what they found", status: .queued, icon: "lock.shield")
                }
                OpsGroupDivider()
                NavigationLink { PullRequestsView() } label: {
                    OpsQueueRow(title: "Code changes", detail: prDetail, status: ops.redPRs > 0 ? .failed : .queued, icon: "arrow.triangle.pull")
                }
                OpsGroupDivider()
                NavigationLink { WorktreesView() } label: {
                    OpsQueueRow(title: "Agent workspaces", detail: "Coding agents working on the server now", status: .queued, icon: "point.topleft.down.to.point.bottomright.curvepath", tint: OpsTheme.mint)
                }
                OpsGroupDivider()
                NavigationLink { WorldSimsView() } label: {
                    OpsQueueRow(title: "World simulations", detail: simsDetail, status: simsStatus, icon: "globe.americas")
                }
                OpsGroupDivider()
                NavigationLink { BackupsView() } label: {
                    OpsQueueRow(title: "Backups and database", detail: "When the game data was last saved, and its size", status: .queued, icon: "externaldrive", tint: OpsTheme.mint)
                }
                OpsGroupDivider()
                NavigationLink { EventsView() } label: {
                    OpsQueueRow(title: "Event recovery", detail: "Game events that failed to arrive and can be resent", status: .queued, icon: "arrow.clockwise.circle")
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var schedulerDetail: String {
        let checks = ops.scheduler["checks"].array
        let runningChecks = checks.filter { $0["state"].string == "running" }.count
        let queuedChecks = checks.filter { $0["state"].string == "queued" }.count
        if runningChecks == 0 && queuedChecks == 0 { return "No test runs running or waiting" }
        return "Test runs: \(runningChecks) running, \(queuedChecks) waiting their turn"
    }
    private var prDetail: String {
        let open = Int(ops.kpis["prsOpen"].number ?? 0)
        let red = ops.redPRs
        let openText = open == 1 ? "1 waiting to ship" : "\(open) waiting to ship"
        return red == 0 ? openText : openText + ", \(red) with failing tests"
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

/// One count from the status system. Problem states that are non-zero get a
/// tinted, bordered tile; everything else (Running, or a zero) stays on the
/// neutral surface with only its number coloured, so the eye lands on
/// problems first.
private struct OpsSummaryTile: View {
    let state: OpsWorkState
    let count: Int

    private var live: Bool { count > 0 }
    private var alarm: Bool { live && state.isProblem }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Image(systemName: state.glyph).font(.subheadline.weight(.semibold))
                    .foregroundStyle(live ? state.color : OpsTheme.muted.opacity(0.7)).accessibilityHidden(true)
                Text(count.formatted()).font(.system(.title3, design: .rounded).weight(.bold).monospacedDigit())
                    .foregroundStyle(live ? state.color : OpsTheme.muted)
                    .lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
            }
            Text(state.title).font(.caption.weight(.semibold)).foregroundStyle(live ? OpsTheme.ink : OpsTheme.muted)
                .lineLimit(1).minimumScaleFactor(0.85)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(alarm ? state.color.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .opsSurface(radius: 14)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(alarm ? state.color.opacity(0.4) : .clear))
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(state.title), \(count)")
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
    var verticalPadding: CGFloat = 7

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
