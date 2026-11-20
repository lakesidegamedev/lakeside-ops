import SwiftUI
import Charts
import LakesideCore

@MainActor final class KeirMetricsStore: ObservableObject {
    @Published private(set) var snapshot: JSONValue = .null
    @Published private(set) var error: String?
    @Published private(set) var loading = false

    func refresh(_ session: AppSession) async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do {
            let next = try await session.get("/api/keir/hub")
            guard !Task.isCancelled else { return }
            guard !next["kpis"].object.isEmpty, next["at"].number != nil else {
                error = "The dashboard returned an incomplete snapshot. Previous values are kept."; return
            }
            snapshot = next; error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = "Dashboard refresh failed. \(error.displayMessage)"
        }
    }
}

/// Uses the dashboard's recorded windows and counts. Missing data stays unknown.
enum KeirMetricFormat {
    static func count(_ value: JSONValue) -> String { value.number.map { $0.formatted(.number.precision(.fractionLength(0))) } ?? "Not recorded" }
    static func duration(_ value: JSONValue) -> String {
        guard let ms = value.number, ms.isFinite, ms >= 0 else { return "Not recorded" }
        if ms < 1000 { return "<1s" }
        if ms < 60_000 { return "\(Int(ms / 1000))s" }
        if ms < 3_600_000 { return "\(Int(ms / 60_000))m" }
        return String(format: "%.1fh", ms / 3_600_000)
    }
    static func percent(_ value: JSONValue) -> String { value.number.map { String(format: "%.1f%%", $0 * 100) } ?? "No sample" }
    static func label(_ key: String) -> String { key.replacingOccurrences(of: "_", with: " ").capitalized }
}

struct KeirMetricsView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = KeirMetricsStore()
    private var hub: JSONValue { store.snapshot }
    private var kpis: JSONValue { hub["kpis"] }

    var body: some View {
        List {
            Section {
                if let error = store.error {
                    Text(error).foregroundStyle(OpsTheme.warn)
                    if hub != .null { Text("Showing the last successful snapshot.").foregroundStyle(OpsTheme.muted) }
                    Button("Retry dashboard") { Task { await store.refresh(session) } }.accessibilityIdentifier("metrics-retry")
                }
                if hub == .null {
                    Text(store.loading ? "Loading dashboard" : "Dashboard unavailable").foregroundStyle(OpsTheme.muted)
                } else {
                    LabeledContent("Operator", value: hub["paused"].bool ? "Paused" : "Active")
                    LabeledContent("Release", value: hub["release"]["version"].string.nonempty ?? "Not recorded")
                    Text("Snapshot \(OpsFormat.ago(hub["at"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                }
            }
            if hub != .null {
                activationSection
                throughputSection
                Section("Activations by provider, 24h") { KeirActivityChart(buckets: hub["activity"].array) }
                qualitySection
                judgementSection
                watchSection
                attemptsSection
                sourceSection
            }
        }
        .listStyle(.insetGrouped).opsScreen().navigationTitle("Keir dashboard").navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("keir-metrics-list")
        .refreshable { await store.refresh(session) }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await store.refresh(session)
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }

    private var activationSection: some View {
        Section("Execution, last 24h") {
            metric("Activations", kpis["activations24h"])
            LabeledContent("Successful activations", value: KeirMetricFormat.percent(kpis["successRate24h"]))
            LabeledContent("Median activation", value: KeirMetricFormat.duration(kpis["medianActivationMs"]))
            LabeledContent("P90 activation", value: KeirMetricFormat.duration(kpis["p90ActivationMs"]))
            metric("Running now", kpis["running"])
            metric("Queued", kpis["queued"])
            metric("Waiting", kpis["waiting"])
            metric("Blocked", kpis["blocked"])
            metric("Pending decisions", kpis["decisionsPending"])
            metric("Open PRs", kpis["prsOpen"])
            metric("Failing PRs", kpis["prsRed"])
            Text("Run success measures task execution. Ticket resolution is verified separately.").font(.caption).foregroundStyle(OpsTheme.muted)
        }
    }

    private var throughputSection: some View {
        Section("Delivery and resource use") {
            let flow = hub["throughput"], counts = flow["counts"], cost = flow["cost"]
            if flow == .null { Text("Throughput is not available in this snapshot.").foregroundStyle(OpsTheme.muted) }
            else {
                Text("Window: \(KeirMetricFormat.duration(flow["windowMs"]))").font(.caption).foregroundStyle(OpsTheme.muted)
                metric("Distinct root tickets", counts["ticketRoots"])
                metric("Actionable root tickets", counts["actionableTicketRoots"])
                metric("Under observation", counts["monitoringTicketRoots"])
                metric("Root jobs", counts["rootJobs"])
                metric("Live delegated jobs", counts["childJobs"])
                ForEach(["executing", "queued", "dependency", "ci", "owner", "turn", "schedule", "other"], id: \.self) { key in
                    metric(waitLabel(key), counts[key])
                }
                LabeledContent("Completed model time", value: KeirMetricFormat.duration(cost["modelMs"]))
                metric("Completed activations", cost["activations"])
                metric("Budget exhaustions", cost["exhausted"])
                metric("Repeatedly exhausted roots", cost["repeatedRoots"])
                metric("Timeouts", cost["timedOut"])
                Text(flow["note"].string).font(.caption).foregroundStyle(OpsTheme.muted)
                ForEach(flow["work"].array, id: \.["id"].string) { row in
                    DisclosureGroup {
                        LabeledContent("Stage", value: KeirMetricFormat.label(row["stage"].string))
                        LabeledContent("Wait", value: waitLabel(row["category"].string))
                        LabeledContent("Wait age", value: KeirMetricFormat.duration(row["ageMs"]))
                        if row["ageBasis"].string == "last-job-update" { Text("Age is since the last job update; exact wait start is unknown.").font(.caption).foregroundStyle(OpsTheme.muted) }
                        metric("Live delegated jobs", row["children"])
                        metric("Activations in window", row["activations"])
                        LabeledContent("Completed model time", value: KeirMetricFormat.duration(row["modelMs"]))
                        NavigationLink("Open task") { TaskDetail(id: row["id"].string) }
                    } label: { LabeledContent(row["label"].string, value: KeirMetricFormat.label(row["stage"].string)) }
                }
                if (flow["hiddenWork"].number ?? 0) > 0 { Text("\(KeirMetricFormat.count(flow["hiddenWork"])) additional tasks omitted by the dashboard's bounded sample.").font(.caption) }
                if flow["supportSample"]["available"].bool {
                    Text("Support-list sample: \(KeirMetricFormat.count(flow["supportSample"]["count"])) of at most \(KeirMetricFormat.count(flow["supportSample"]["limit"])) recent records. This is not the total support backlog.").font(.caption).foregroundStyle(OpsTheme.muted)
                } else { Text("Support sample unavailable.").font(.caption).foregroundStyle(OpsTheme.warn) }
            }
        }
    }

    private var qualitySection: some View {
        Section("Resolution quality") {
            let quality = hub["quality"]
            if quality == .null { Text("No shadow quality sample yet.").foregroundStyle(OpsTheme.muted) }
            else {
                LabeledContent("Median time to closure", value: KeirMetricFormat.duration(quality["time_to_closure"]["median_ms"]))
                LabeledContent("P90 time to closure", value: KeirMetricFormat.duration(quality["time_to_closure"]["p90_ms"]))
                LabeledContent("Median decision latency", value: KeirMetricFormat.duration(quality["decision_latency"]["median_ms"]))
                LabeledContent("P90 decision latency", value: KeirMetricFormat.duration(quality["decision_latency"]["p90_ms"]))
                metric("Tickets in quality sample", quality["tickets"])
                metric("Closed in quality sample", quality["closed"])
                metric("Unanswered asks", quality["decisions_unanswered"])
                LabeledContent("Oldest open age", value: KeirMetricFormat.duration(quality["oldest_open_age_ms"]))
                MetricDistribution(values: quality["labels"], empty: "No resolution labels recorded.")
            }
        }
    }

    private var judgementSection: some View {
        Section("Request quality, 7d") {
            let jev = hub["jev"]
            if jev == .null { Text("No request-quality snapshot.").foregroundStyle(OpsTheme.muted) }
            else {
                metric("Requests classified", jev["tagged"])
                metric("Instruction-injection flags", jev["injections"])
                metric("Posts screened", jev["screened"])
                metric("Refused as leaks", jev["refused"])
                DisclosureGroup("Request types") { MetricDistribution(values: jev["tags"]["kind"], empty: "No request types recorded.") }
                DisclosureGroup("Player mood") { MetricDistribution(values: jev["tags"]["mood"], empty: "No mood labels recorded.") }
                DisclosureGroup("Screening flags") { MetricDistribution(values: jev["labels"], empty: "No screening flags recorded.") }
            }
        }
    }

    private var watchSection: some View {
        Section("Monitoring") {
            let watch = hub["watch"]
            if watch == .null { Text("Monitoring snapshot unavailable.").foregroundStyle(OpsTheme.muted) }
            else {
                LabeledContent("Status", value: KeirMetricFormat.label(watch["status"].string))
                LabeledContent("Mode", value: KeirMetricFormat.label(watch["mode"].string))
                if watch["paused"].bool { Text("Operator paused. These are the last recorded observations.").foregroundStyle(OpsTheme.warn) }
                metric("Open findings", watch["openFindings"])
                LabeledContent("New tasks this hour", value: "\(KeirMetricFormat.count(watch["budget"]["hourUsed"])) / \(KeirMetricFormat.count(watch["budget"]["perHour"]))")
                LabeledContent("New tasks today", value: "\(KeirMetricFormat.count(watch["budget"]["dayUsed"])) / \(KeirMetricFormat.count(watch["budget"]["perDay"]))")
                metric("Caught before a report", watch["score"]["caughtFirst"])
                metric("Player reported first", watch["score"]["playerFirst"])
                LabeledContent("Confirmed caught-first share", value: watch["score"]["share"].number.map { "\(Int($0))%" } ?? "No sample")
                Text("Compared only when a later player report links the issue.").font(.caption).foregroundStyle(OpsTheme.muted)
                ForEach(watch["sensors"].array, id: \.["id"].string) { sensor in
                    DisclosureGroup {
                        Text("Last success: \(OpsFormat.ago(sensor["lastSuccessAt"]).nonempty ?? "Not recorded")").font(.caption)
                        if !sensor["error"].string.isEmpty { Text(sensor["error"].string).font(.caption).foregroundStyle(OpsTheme.warn) }
                    } label: { LabeledContent(sensor["label"].string, value: KeirMetricFormat.label(sensor["status"].string)) }
                }
                let caps = watch["capabilities"]
                DisclosureGroup("Recorded capabilities, 24h") {
                    metric("Authority carried", caps["authorityCarried"])
                    metric("Issues closed live", caps["issuesClosedLive"])
                    metric("Errors resolved", caps["sentryResolved"])
                    metric("Held promotions", caps["heldPromotions"])
                    metric("Sensor failures", caps["sensorFailures"])
                    metric("Skill failures", caps["skillFailures"])
                    Text(caps["scope"].string).font(.caption).foregroundStyle(OpsTheme.muted)
                }
            }
        }
    }

    private var attemptsSection: some View {
        Section("Recent runner attempts") {
            if hub["attempts"].array.isEmpty { Text("No attempts in the dashboard sample.").foregroundStyle(OpsTheme.muted) }
            ForEach(hub["attempts"].array.prefix(10), id: \.["id"].string) { attempt in
                DisclosureGroup(attempt["label"].string.nonempty ?? attempt["task_id"].string) {
                    LabeledContent("Provider", value: attempt["provider"].string)
                    LabeledContent("Model", value: attempt["model"].string)
                    LabeledContent("Duration", value: KeirMetricFormat.duration(attempt["duration_ms"]))
                    metric("Tool calls", attempt["tool_calls"])
                    LabeledContent("Outcome", value: attempt["timed_out"].bool ? "Timed out" : attempt["quota_hold"].bool ? "Quota hold" : attempt["exit_code"] == .null ? "Not recorded" : "Exit \(attempt["exit_code"].string)")
                }
            }
        }
    }

    private var sourceSection: some View {
        Section("Models and data sources") {
            ForEach(hub["routing"].object.keys.sorted(), id: \.self) { lane in
                LabeledContent(KeirMetricFormat.label(lane), value: hub["routing"][lane].string)
            }
            ForEach(hub["sources"].object.keys.sorted(), id: \.self) { key in
                let freshness = hub["sourceFreshness"][key]
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent(KeirMetricFormat.label(key), value: hub["sources"][key].string)
                    if freshness["at"] != .null { Text("Last successful snapshot \(OpsFormat.ago(freshness["at"]))").font(.caption).foregroundStyle(OpsTheme.muted) }
                    if freshness["refreshing"].bool { Text("Refreshing in background").font(.caption).foregroundStyle(OpsTheme.muted) }
                    if !freshness["error"].string.isEmpty { Text("Using previous data: \(freshness["error"].string)").font(.caption).foregroundStyle(OpsTheme.warn) }
                }
            }
        }
    }

    private func metric(_ label: String, _ value: JSONValue) -> some View { LabeledContent(label, value: KeirMetricFormat.count(value)).monospacedDigit() }
    private func waitLabel(_ key: String) -> String {
        switch key {
        case "executing": return "Executing"
        case "dependency": return "Waiting on delegated work"
        case "ci": return "Waiting on checks"
        case "owner": return "Owner decision"
        case "turn": return "Waiting on a game turn"
        case "schedule": return "Owner-hours release hold"
        case "other": return "Unrecorded wait reason"
        default: return KeirMetricFormat.label(key)
        }
    }
}

private struct MetricDistribution: View {
    let values: JSONValue
    let empty: String
    private var keys: [String] { values.object.keys.sorted { (values[$0].number ?? 0) > (values[$1].number ?? 0) } }
    var body: some View {
        if keys.isEmpty { Text(empty).font(.caption).foregroundStyle(OpsTheme.muted) }
        else {
            Chart(keys, id: \.self) { key in
                BarMark(x: .value("Count", values[key].number ?? 0), y: .value("Label", KeirMetricFormat.label(key))).foregroundStyle(OpsTheme.sky)
            }.frame(height: CGFloat(max(100, keys.count * 30)))
            ForEach(keys, id: \.self) { key in LabeledContent(KeirMetricFormat.label(key), value: KeirMetricFormat.count(values[key])) }
        }
    }
}
