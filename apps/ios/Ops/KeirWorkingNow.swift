import SwiftUI
import LakesideCore

/// Where a piece of Keir's work opens in the app. Ticket and Discord work has
/// no owner task view, so it opens its ticket or the Activity queue.
struct KeirWorkLink<Content: View>: View {
    @EnvironmentObject private var router: OpsRouter
    let link: String
    let ticket: JSONValue
    let jobId: String
    let title: String
    @ViewBuilder let label: () -> Content
    var body: some View {
        if link == "ticket", ticket != .null {
            NavigationLink { TicketDetail(ticket: .object(["number": ticket, "title": .string(title)])) } label: { label() }.buttonStyle(.plain)
        } else if link == "task", !jobId.isEmpty {
            NavigationLink { TaskDetail(id: jobId) } label: { label() }.buttonStyle(.plain)
        } else {
            Button { router.tab = .activity } label: { label() }.buttonStyle(.plain)
        }
    }
}

enum KeirWorkState {
    static func color(_ state: String) -> Color {
        switch state {
        case "needs-you", "stuck": return OpsTheme.warn
        case "working": return OpsTheme.mint
        case "queued", "waiting": return OpsTheme.sky
        default: return OpsTheme.muted
        }
    }
    static func word(_ state: String) -> String {
        ["needs-you": "Needs you", "stuck": "Stuck", "working": "Working", "queued": "Queued", "waiting": "Waiting", "held": "Held"][state] ?? state.capitalized
    }
}

/// Everything Keir is doing, not only this conversation: tickets, findings and
/// Discord requests. Collapsed it is one line in the chat; expanded it lists
/// the work that most needs attention, each row opening that work.
struct KeirWorkingNow: View {
    @EnvironmentObject private var router: OpsRouter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let team: JSONValue
    @State private var expanded = false
    private func count(_ key: String) -> Int { Int(team[key].number ?? 0) }
    private var summary: String {
        let waiting = count("open") - count("working") - count("needsYou") - count("stuck")
        return [count("needsYou") > 0 ? "\(count("needsYou")) need you" : nil, count("stuck") > 0 ? "\(count("stuck")) stuck" : nil,
                count("working") > 0 ? "\(count("working")) working" : nil, waiting > 0 ? "\(waiting) waiting" : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }
    private var dot: Color { count("needsYou") + count("stuck") > 0 ? OpsTheme.warn : count("working") > 0 ? OpsTheme.mint : OpsTheme.muted }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(reduceMotion ? nil : .snappy) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Circle().fill(dot).frame(width: 7, height: 7)
                    Text("Keir is on \(count("open"))").font(.caption.weight(.semibold))
                    Text(summary).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(OpsTheme.muted)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }.padding(.horizontal, 16).padding(.vertical, 9).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("Keir is working on \(count("open")) items. \(summary)")
                .accessibilityHint(expanded ? "Hides the list" : "Shows what Keir is working on")
                .accessibilityIdentifier("keir-working-now")
            if expanded {
                VStack(spacing: 0) {
                    ForEach(team["items"].array, id: \.["id"].string) { item in
                        Hairline()
                        KeirWorkLink(link: item["link"].string, ticket: item["ticket"], jobId: item["id"].string, title: item["title"].string) {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                StateWord(text: KeirWorkState.word(item["state"].string), color: KeirWorkState.color(item["state"].string)).frame(width: 74, alignment: .leading)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item["ticket"] == .null ? item["title"].string : "#\(item["ticket"].string) \(item["title"].string)").font(.callout.weight(.medium)).lineLimit(1)
                                    if !item["reason"].string.isEmpty { Text(item["reason"].string).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2) }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(OpsTheme.muted)
                            }.padding(.horizontal, 16).padding(.vertical, 10).contentShape(Rectangle())
                        }.accessibilityIdentifier("keir-working-row-\(item["id"].string)")
                    }
                    Hairline()
                    Button { router.tab = .activity } label: {
                        Label("All work in Activity", systemImage: "list.bullet.rectangle").font(.caption.weight(.semibold))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 10)
                    }.buttonStyle(.plain).foregroundStyle(OpsTheme.sky).accessibilityIdentifier("keir-working-all")
                }.transition(.opacity)
            }
        }
        .background(OpsTheme.surface)
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// A progress update Keir posted on his own: one line per change, each opening
/// the work it is about.
struct KeirUpdateMessage: View {
    @EnvironmentObject private var ops: OpsStore
    let message: JSONValue
    /// Pending decisions this update is waiting on, answerable here with buttons
    /// instead of typing an instruction into chat.
    private var openDecisions: [JSONValue] {
        let waiting = message["items"].array.filter { ["needs-you", "paused", "stuck"].contains($0["kind"].string) }
        var seen = Set<String>()
        return ops.decisions.filter { d in
            waiting.contains { item in
                (!item["jobId"].string.isEmpty && item["jobId"].string == d["jobId"].string)
                || (item["ticket"].number != nil && item["ticket"].number == d["ticket"].number)
            } && seen.insert(d["id"].string).inserted
        }
    }
    private func icon(_ kind: String) -> (String, Color) {
        switch kind {
        case "needs-you": return ("hand.raised.fill", OpsTheme.warn)
        case "stuck", "paused": return ("pause.circle.fill", OpsTheme.warn)
        case "finished", "live": return ("checkmark.circle.fill", OpsTheme.mint)
        case "pr", "merged": return ("arrow.triangle.pull", OpsTheme.sky)
        case "started": return ("play.circle.fill", OpsTheme.sky)
        default: return ("arrow.right.circle.fill", OpsTheme.sky)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Keir").font(.caption.weight(.semibold))
                Text("Progress update").font(.caption).foregroundStyle(OpsTheme.muted)
                Text(OpsFormat.ago(message["at"])).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(message["items"].array.enumerated()), id: \.offset) { index, item in
                    if index > 0 { Hairline() }
                    KeirWorkLink(link: item["link"].string, ticket: item["ticket"], jobId: item["jobId"].string, title: "") {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: icon(item["kind"].string).0).foregroundStyle(icon(item["kind"].string).1).font(.callout)
                            Text(item["text"].string).font(.callout).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                        }.padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                    }
                }
                if message["text"].string.contains("more in Activity") { Hairline(); Text(message["text"].string.components(separatedBy: "\n").last?.replacingOccurrences(of: "- ", with: "") ?? "").font(.caption).foregroundStyle(OpsTheme.muted).padding(.horizontal, 12).padding(.vertical, 8) }
            }
            .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(OpsTheme.hairline))
            if !message["cards"].array.isEmpty { KeirCards(cards: message["cards"].array) }
            ForEach(openDecisions, id: \.["id"].string) { DecisionCard(decision: $0) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keir-update-message")
        .contextMenu {
            Button { UIPasteboard.general.string = message["text"].string } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }
}
