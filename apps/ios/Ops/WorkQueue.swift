import SwiftUI
import LakesideCore

enum WorkQueuePresentation {
    static func state(_ item: JSONValue) -> String {
        let value = item["timing"]["state"].string
        if !value.isEmpty { return value }
        if item["decisionPending"].bool { return "needs-you" }
        switch item["state"].string {
        case "running": return "working"
        case "blocked": return "stuck"
        case "done", "dismissed", "cancelled": return "finished"
        default: return "waiting"
        }
    }
    static func matches(_ item: JSONValue, filter: String, search: String, ticket: Bool) -> Bool {
        let s = state(item)
        let statusMatches = filter == "all" || (filter == "stuck" ? s == "stuck" || s == "unassigned" || item["timing"]["overdue"].bool : filter == "waiting" ? ["waiting", "queued", "held"].contains(s) : s == filter)
        let text = [item["title"].string, item["number"].string, item["ticket"].string, item["timing"]["reason"].string].joined(separator: " ")
        return statusMatches && (search.isEmpty || text.localizedCaseInsensitiveContains(search))
    }
    static func rank(_ item: JSONValue) -> Int {
        if state(item) == "needs-you" { return 0 }
        if item["timing"]["overdue"].bool || ["stuck", "unassigned"].contains(state(item)) { return 1 }
        return ["working": 2, "queued": 3, "waiting": 4, "held": 5, "finished": 6][state(item)] ?? 5
    }
    static func label(_ item: JSONValue) -> String {
        let s = state(item)
        if item["timing"]["overdue"].bool && !["stuck", "unassigned", "needs-you"].contains(s) { return "Overdue" }
        return ["working": "Running", "waiting": "Queued", "queued": "Queued", "held": "Held", "stuck": "Blocked", "unassigned": "Unassigned", "needs-you": "Needs you", "finished": "Done"][s] ?? OpsStatus.from(s).title
    }
    static func status(_ item: JSONValue) -> OpsStatus {
        if item["timing"]["overdue"].bool { return .blocked }
        return OpsStatus.from(state(item))
    }
    static func color(_ item: JSONValue) -> Color {
        if state(item) == "unassigned" { return OpsTheme.muted }
        return status(item).color
    }
}

struct WorkTimingView: View {
    let value: JSONValue
    var compact = false
    private var estimate: Text {
        if let expected = OpsFormat.date(value["expectedDoneAt"]) {
            return Text(expected <= Date() ? "Keir's task estimate is overdue" : "Task estimate: \(expected.formatted(date: .omitted, time: .shortened))")
        }
        return Text(value["etaLabel"].string.nonempty ?? "Completion time not established")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 10) {
            if !value["reason"].string.isEmpty {
                Text(OpsText.scrub(value["reason"].string)).font(compact ? .caption : .callout).lineLimit(compact ? 2 : nil)
            }
            if !compact && !value["milestone"].string.isEmpty && value["milestone"] != value["reason"] {
                Label(OpsText.scrub(value["milestone"].string), systemImage: "flag").font(.callout)
            }
            if !value["next"].string.isEmpty {
                Text("Next: \(OpsText.scrub(value["next"].string))").font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(compact ? 2 : nil)
            }
            HStack(spacing: 12) {
                if value["since"] != .null { Label("Since \(OpsFormat.ago(value["since"]))", systemImage: "clock").font(.caption2) }
                if let check = OpsFormat.date(value["nextCheckAt"]) {
                    Text(check <= Date() ? "Check due" : "Check \(OpsFormat.ago(check))").font(.caption2).foregroundStyle(check <= Date() ? OpsTheme.warn : OpsTheme.muted)
                } else if ["waiting", "queued"].contains(value["state"].string) {
                    Text("No check scheduled").font(.caption2).foregroundStyle(OpsTheme.warn)
                }
            }.foregroundStyle(OpsTheme.muted)
            if compact && value["state"].string != "finished" {
                estimate.font(.caption2).foregroundStyle(OpsTheme.muted)
            }
            if !compact {
                estimate.font(.caption).foregroundStyle(OpsTheme.muted)
                if !value["estimateBasis"].string.isEmpty { Text(value["estimateBasis"].string).font(.caption).foregroundStyle(OpsTheme.muted) }
                if let review = OpsFormat.date(value["reviewAt"]) { Text("Wait review \(OpsFormat.ago(review))").font(.caption).foregroundStyle(review <= Date() ? OpsTheme.warn : OpsTheme.muted) }
                if let deadline = OpsFormat.date(value["deadline"]) { Text("Task deadline \(deadline.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(OpsTheme.muted) }
            }
        }.accessibilityElement(children: .combine)
    }
}
