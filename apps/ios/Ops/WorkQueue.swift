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
            let heartbeat = [timing["heartbeatAt"], item["active"]["updatedAt"], item["updatedAt"]].compactMap(OpsFormat.date).max()
            if heartbeat.map({ Date().timeIntervalSince($0) > TicketPresentation.staleAfter }) ?? true { return "stalled" }
        }
        if !value.isEmpty { return value }
        switch item["state"].string {
        case "running": return "working"
        case "blocked": return "stuck"
        case "done", "dismissed", "cancelled": return "finished"
        default: return "waiting"
        }
    }
    static func bucket(_ item: JSONValue) -> String {
        let state = state(item)
        if state == "needs-you" || state == "finished" { return state }
        if item["timing"]["overdue"].bool || ["stuck", "stalled", "unassigned"].contains(state) { return "stuck" }
        return state == "working" ? "working" : "waiting"
    }
    static func matches(_ item: JSONValue, filter: String, search: String, ticket: Bool) -> Bool {
        let text = [item["title"].string, item["number"].string, item["ticket"].string, item["timing"]["reason"].string].joined(separator: " ")
        return (filter == "all" || filter == bucket(item)) && (search.isEmpty || text.localizedCaseInsensitiveContains(search))
    }
    /// The default Inbox (Tickets, All, no search) leads with owner pings:
    /// Needs you, then the work groups. A filter,
    /// a search or the Tasks scope is a request for specific work, so the
    /// matching queue rows lead instead.
    static func leadsWithOwnerItems(scope: String, filter: String, search: String) -> Bool {
        scope == "tickets" && filter == "all" && search.trimmingCharacters(in: .whitespaces).isEmpty
    }
    /// Needs you shows on All and on its own filter, in either scope. A search
    /// narrows its rows instead of hiding the section, so every row a filter
    /// shows is also on All with the same search. Running, Queued and Blocked
    /// leave it out rather than mixing unrelated cards into the result.
    static func showsOwnerItems(filter: String) -> Bool {
        filter == "all" || filter == "needs-you"
    }
    static func rank(_ item: JSONValue) -> Int {
        if state(item) == "needs-you" { return 0 }
        if bucket(item) == "stuck" { return 1 }
        return ["working": 2, "queued": 3, "waiting": 4, "held": 5, "finished": 6][state(item)] ?? 5
    }
    static func label(_ item: JSONValue) -> String {
        let s = state(item)
        if s == "stalled" { return "Stalled" }
        if item["timing"]["overdue"].bool && !["stuck", "unassigned", "needs-you"].contains(s) { return "Overdue" }
        return ["working": "Running", "waiting": "Queued", "queued": "Queued", "held": "Held", "stuck": "Blocked", "unassigned": "Unassigned", "needs-you": "Needs you", "finished": "Done"][s] ?? OpsStatus.from(s).title
    }
    static func status(_ item: JSONValue) -> OpsStatus {
        if state(item) == "stalled" && item["timing"]["reason"].string.localizedCaseInsensitiveContains("aborted") { return .failed }
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
