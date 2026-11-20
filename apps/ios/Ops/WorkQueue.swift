import SwiftUI
import LakesideCore

enum WorkQueuePresentation {
    static func state(_ item: JSONValue) -> String {
        let timing = item["timing"]
        let value = timing["state"].string
        if value == "needs-you" || (value.isEmpty && item["decisionPending"].bool) { return "needs-you" }
        let reason = timing["reason"].string.lowercased()
        if reason.contains("activation aborted") { return "stalled" }
        if value == "working" || (value.isEmpty && item["state"].string == "running") {
            let heartbeat = [timing["heartbeatAt"], item["active"]["updatedAt"], item["active"]["startedAt"], item["updatedAt"]].compactMap(OpsFormat.date).max()
            if heartbeat.map({ Date().timeIntervalSince($0) > TicketPresentation.staleAfter }) ?? true { return "stalled" }
        }
        if !value.isEmpty { return value }
        switch item["state"].string {
        case "running": return "working"
        case "blocked", "stuck": return "stuck"
        case "stalled": return "stalled"
        case "queued": return "queued"
        case "done", "dismissed", "cancelled": return "finished"
        default: return "waiting"
        }
    }
    static func bucket(_ item: JSONValue) -> String {
        let state = state(item)
        if state == "needs-you" || state == "finished" || state == "stalled" { return state }
        if item["replyState"]["state"].string == "no_receipt" { return "unanswered" }
        if state == "stuck" { return "stuck" }
        if state == "working" { return "working" }
        return ["held", "waiting", "unassigned"].contains(state) ? "held" : "waiting"
    }
    static func matches(_ item: JSONValue, filter: String, search: String) -> Bool {
        let text = [item["title"].string, item["number"].string, item["ticket"].string, item["timing"]["reason"].string].joined(separator: " ")
        return (filter == "all" || filter == bucket(item)) && (search.isEmpty || text.localizedCaseInsensitiveContains(search))
    }
    static func showsOwnerItems(filter: String) -> Bool {
        filter == "all" || filter == "needs-you"
    }
    static func rank(_ item: JSONValue) -> Int {
        if state(item) == "needs-you" { return 0 }
        if bucket(item) == "stuck" { return 1 }
        return ["working": 2, "queued": 3, "waiting": 4, "held": 5, "finished": 6][state(item)] ?? 5
    }
    static func label(_ item: JSONValue) -> String {
        ["stalled": "Stalled", "stuck": "Blocked", "unanswered": "Unanswered", "working": "Running",
         "waiting": "Queued", "held": "Waiting", "needs-you": "Needs you", "finished": "Done"][bucket(item)] ?? "Unknown"
    }
    static func status(_ item: JSONValue) -> OpsStatus {
        switch bucket(item) {
        case "stalled": return .failed
        case "stuck", "unanswered", "held": return .blocked
        case "needs-you": return .waiting
        case "working": return .running
        case "finished": return .done
        default: return .queued
        }
    }
    /// One colour per bucket: amber waits on the owner or a player, red is
    /// stalled, violet is blocked on something else, mint is running.
    static func color(_ item: JSONValue) -> Color {
        switch bucket(item) {
        case "stalled": return OpsTheme.danger
        case "stuck": return OpsTheme.blocked
        case "unanswered", "needs-you": return OpsTheme.warning
        case "working": return OpsTheme.mint
        case "finished", "held": return OpsTheme.muted
        default: return OpsTheme.sky
        }
    }

}

struct WorkTimingView: View {
    let value: JSONValue
    var compact = false
    /// Queue rows show the age on their top line beside the chevron.
    var showsSince = true
    private var estimate: Text {
        if let expected = OpsFormat.date(value["expectedDoneAt"]) {
            return Text(expected <= Date() ? "Keir's task estimate is overdue" : "Task estimate: \(OpsFormat.clock(expected))")
        }
        return Text("")
    }
    /// A compact row says nothing about completion unless there is an estimate.
    private var hasEstimate: Bool {
        OpsFormat.date(value["expectedDoneAt"]) != nil
    }
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 10) {
            if !value["reason"].string.isEmpty {
                Text(value["reason"].string.localizedCaseInsensitiveContains("activation aborted") ? "Keir’s last attempt stopped before it could finish." : OpsText.scrub(value["reason"].string)).font(compact ? .caption : .callout).lineLimit(compact ? 2 : nil)
            }
            if !compact && !value["milestone"].string.isEmpty && value["milestone"] != value["reason"] {
                Label(OpsText.scrub(value["milestone"].string), systemImage: "flag").font(.callout)
            }
            if !value["next"].string.isEmpty && value["next"].string != "Keir will record the next result." {
                Text("Next: \(OpsText.scrub(value["next"].string))").font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(compact ? 2 : nil)
            }
            HStack(spacing: 12) {
                if showsSince && value["since"] != .null { Label("Since \(OpsFormat.ago(value["since"]))", systemImage: "clock").font(.caption2) }
                if let check = OpsFormat.date(value["nextCheckAt"]) {
                    Text(check <= Date() ? "Check due" : "Check \(OpsFormat.ago(check))").font(.caption2).foregroundStyle(check <= Date() ? OpsTheme.warn : OpsTheme.muted)
                } else if ["waiting", "queued"].contains(value["state"].string) {
                    Text("No check scheduled").font(.caption2).foregroundStyle(OpsTheme.warn)
                }
            }.foregroundStyle(OpsTheme.muted)
            if compact && value["state"].string != "finished" && hasEstimate {
                estimate.font(.caption2).foregroundStyle(value["overdue"].bool ? OpsTheme.warn : OpsTheme.muted)
            }
            if !compact {
                if hasEstimate { estimate.font(.caption).foregroundStyle(value["overdue"].bool ? OpsTheme.warn : OpsTheme.muted) }
                if !value["estimateBasis"].string.isEmpty { Text(value["estimateBasis"].string).font(.caption).foregroundStyle(OpsTheme.muted) }
                if let deadline = OpsFormat.date(value["deadline"]) { Text("Task deadline \(deadline.formatted(date: .abbreviated, time: .omitted) + " at " + OpsFormat.clock(deadline))").font(.caption).foregroundStyle(OpsTheme.muted) }
            }
        }.accessibilityElement(children: .combine)
    }
}
