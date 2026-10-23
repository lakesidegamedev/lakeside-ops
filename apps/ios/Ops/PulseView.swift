import SwiftUI
import Charts
import LakesideCore

/// Health detail behind the Ops headline: host resources, Keir throughput,
/// recent alerts and one aggregate uptime line. The per-service catalogue is
/// deliberately gone; a degraded surface is called out once, not listed.
struct HealthView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                headline
                aggregate
                keirSummary
                NavigationLink { KeirMetricsView() } label: {
                    OpsQueueRow(title: "Keir dashboard", detail: "Execution metrics and monitoring", status: .queued, icon: "chart.bar.xaxis")
                }
                HostPanel(host: ops.host)
                KeirActivityChart(buckets: ops.hub["activity"].array)
                if !ops.alerts.isEmpty { AlertsPanel(alerts: Array(ops.alerts.prefix(6))) }
                if let updated = ops.updated {
                    Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(OpsTheme.muted).frame(maxWidth: .infinity)
                }
            }.padding(16)
        }
        .opsScrollable()
        .refreshable { await ops.refresh(session) }
        .opsScreen()
        .navigationTitle("Health").navigationBarTitleDisplayMode(.inline)
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 6) {
            let down = ops.servicesDown.count
            Text(down == 0 ? "Everything is up." : down == 1 ? "One surface is degraded." : "\(down) surfaces are degraded.")
                .font(.opsHero).fixedSize(horizontal: false, vertical: true)
            Text(keirLine).font(.callout).foregroundStyle(OpsTheme.muted)
            if let error = ops.error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn) }
        }
    }

    private var keirLine: String {
        if ops.hub["paused"].bool { return "Keir is paused." }
        let running = Int(ops.kpis["running"].number ?? 0)
        return running > 0 ? "Keir is running \(running) task\(running == 1 ? "" : "s")." : "Keir is idle."
    }

    /// One line for the whole estate: how many are up and the worst 7-day
    /// uptime. No per-service rows.
    private var aggregate: some View {
        let total = ops.services.count
        let up = total - ops.servicesDown.count
        let worst = ops.services.compactMap { $0["uptime7d"].number }.min()
        return OpsCard {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(up) of \(total) up").font(.opsCardTitle)
                    Text("Worst 7-day uptime \(OpsFormat.percentValue(worst))")
                        .font(.caption).foregroundStyle(OpsTheme.muted).monospacedDigit()
                }
                Spacer()
                OpsStatusBadge(status: ops.servicesDown.isEmpty ? .done : .failed)
            }
        }
    }

    private var keirSummary: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Keir")
            HStack(spacing: 12) {
                Figure(value: "\(Int(ops.kpis["openTickets"].number ?? 0))", label: "Open tickets")
                Figure(value: "\(Int(ops.kpis["live"].number ?? 0))", label: "Live tasks", tone: OpsTheme.mint)
                Figure(value: "\(Int(ops.kpis["prsOpen"].number ?? 0))", label: ops.redPRs > 0 ? "PRs, \(ops.redPRs) red" : "Open PRs", tone: ops.redPRs > 0 ? OpsTheme.warn : OpsTheme.ink)
                Figure(value: OpsFormat.percent(ops.kpis["successRate24h"].number), label: "Success 24h")
            }
        }
    }
}

/// Host load, memory, disk and the shared check scheduler.
struct HostPanel: View {
    let host: JSONValue
    var body: some View {
        if host != .null {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Box")
                Gauge(label: "CPU", value: (host["cpuUsedPct"].number ?? 0) / 100)
                Gauge(label: "Memory", value: (host["memory"]["usedPct"].number ?? 0) / 100)
                Gauge(label: "Disk", value: (host["disk"]["usedPct"].number ?? 0) / 100)
                Text("Load \(host["load"].array.prefix(3).map { String(format: "%.1f", $0.number ?? 0) }.joined(separator: " · ")) · checks \(Int(host["checks"]["running"].number ?? 0)) running, \(Int(host["checks"]["queued"].number ?? 0)) queued")
                    .font(.caption).foregroundStyle(OpsTheme.muted).monospacedDigit()
            }
        }
    }
    private struct Gauge: View {
        let label: String
        let value: Double
        var body: some View {
            HStack(spacing: 10) {
                Text(label).font(.caption).foregroundStyle(OpsTheme.muted).frame(minWidth: 56, alignment: .leading)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(OpsTheme.raised)
                        Capsule().fill(value > 0.85 ? OpsTheme.warn : OpsTheme.sky).frame(width: max(4, g.size.width * min(1, value)))
                    }
                }.frame(height: 6)
                Text(OpsFormat.percent(value)).font(.caption.weight(.medium)).monospacedDigit().frame(minWidth: 40, alignment: .trailing)
            }.accessibilityElement(children: .combine)
        }
    }
}

struct KeirActivityChart: View {
    let buckets: [JSONValue]
    private struct Point: Identifiable { let id = UUID(); let at: Date; let provider: String; let count: Double }
    private var points: [Point] {
        buckets.suffix(24).flatMap { b -> [Point] in
            let at = OpsFormat.date(b["at"]) ?? Date()
            return ["claude", "codex", "muse", "agy", "other"].compactMap { p in
                guard let n = b[p].number, n > 0 else { return nil }
                return Point(at: at, provider: p == "agy" ? "Gemini" : p.capitalized, count: n)
            }
        }
    }
    var body: some View {
        if !points.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Keir activations, 24h")
                Chart(points) { p in
                    BarMark(x: .value("Hour", p.at, unit: .hour), y: .value("Activations", p.count)).foregroundStyle(by: .value("Model", p.provider))
                }
                .chartForegroundStyleScale(["Claude": OpsTheme.sky, "Codex": OpsTheme.mint, "Muse": OpsTheme.warn, "Gemini": OpsTheme.muted, "Other": OpsTheme.hairline])
                .chartLegend(position: .bottom, alignment: .leading)
                .chartXAxis { AxisMarks(values: .stride(by: .hour, count: 6)) { _ in AxisValueLabel(format: .dateTime.hour()) } }
                .frame(height: 150)
            }
        }
    }
}

struct AlertsPanel: View {
    let alerts: [JSONValue]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Recent alerts")
            ForEach(Array(alerts.enumerated()), id: \.offset) { _, alert in
                WorkRow(title: OpsText.scrub(alert["text"].string), meta: "\(alert["kind"].string.capitalized) · \(OpsFormat.ago(alert["at"]))", bar: alert["kind"].string == "incident" ? OpsTheme.warn : nil)
                Hairline()
            }
        }
    }
}
