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

/// Keir's whole queue as one line that answers "what is Keir doing now?":
/// the ticket it is on, how long it has been on it, and how deep the queue is.
/// Expanded, each ticket is its own collapsible thread.
struct KeirWorkingNow: View {
    @EnvironmentObject private var router: OpsRouter
    @ObservedObject private var keir = OpsServices.shared.keir
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let team: JSONValue
    @State private var expanded: Set<String> = []

    private func count(_ key: String) -> Int { Int(team[key].number ?? 0) }
    private var items: [JSONValue] { team["items"].array }
    private var current: JSONValue? {
        items.first { $0["state"].string == "needs-you" || $0["state"].string == "stuck" }
            ?? items.first { $0["state"].string == "working" }
            ?? items.first
    }
    private var waiting: Int { count("needsYou") + count("stuck") }
    private var queueDepth: Int { max(0, count("open") - (current == nil ? 0 : 1)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) {
                    if expanded.isEmpty { expanded = Set(items.map { $0["id"].string }) } else { expanded.removeAll() }
                }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Keir is on \(current.map { OpsText.workTitle($0) } ?? "its queue"). \(statusLine)")
            .accessibilityHint("Shows every ticket Keir is working on")
            .accessibilityIdentifier("keir-working-now")

            if expanded.count > 0 {
                VStack(spacing: 0) {
                    ForEach(items, id: \.id) { item in
                        Hairline()
                        thread(item)
                    }
                    Hairline()
                    Button { router.tab = .activity } label: {
                        Label("All work in Activity", systemImage: "list.bullet.rectangle")
                            .font(.caption.weight(.semibold))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                    }
                    .buttonStyle(.plain).foregroundStyle(OpsTheme.sky)
                    .accessibilityIdentifier("keir-working-all")
                }
                .transition(.opacity)
            }
        }
        .background(OpsTheme.surface)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var statusLine: String {
        guard let current else { return "Nothing in the queue" }
        let elapsed = elapsed(for: current)
        var parts = [elapsed]
        if waiting > 0 { parts.append("\(waiting) waiting on you") }
        if queueDepth > 0 { parts.append("\(queueDepth) in queue") }
        return parts.joined(separator: " · ")
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle().fill(current.map { OpsStatus.from($0["state"].string).color } ?? OpsTheme.muted)
                        .frame(width: 7, height: 7)
                    Text(current.map { OpsText.workTitle($0) } ?? "Keir's queue")
                        .font(.callout.weight(.semibold))
                        .lineLimit(2)
                        .foregroundStyle(OpsTheme.ink)
                }
                Text(statusLine).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold)).foregroundStyle(OpsTheme.muted)
                .rotationEffect(.degrees(expanded.count > 0 ? 180 : 0))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    /// Elapsed time comes from the task's recorded start when the server has
    /// one, then from the moment this session first saw the item.
    private func elapsed(for item: JSONValue) -> String {
        let id = item["id"].string
        let task = keir.tasks.first { $0["id"].string == id }
        let start = OpsFormat.date(task?["at"] ?? .null) ?? keir.firstSeen(id)
        return OpsFormat.span(max(0, Date().timeIntervalSince(start)))
    }

    private func thread(_ item: JSONValue) -> some View {
        let id = item["id"].string
        let open = expanded.contains(id)
        let status = OpsStatus.from(item["state"].string)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) {
                    if open { expanded.remove(id) } else { expanded.insert(id) }
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    OpsStatusBadge(status: status, compact: true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(OpsText.workTitle(item)).font(.callout.weight(.medium)).lineLimit(2)
                        Text("\(elapsed(for: item)) · \(OpsText.scrub(item["reason"].string))")
                            .font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2).foregroundStyle(OpsTheme.muted)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, 16).padding(.vertical, 10).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("keir-working-row-\(id)")
            .accessibilityLabel("\(OpsText.workTitle(item)). \(status.title). \(elapsed(for: item)). \(OpsText.scrub(item["reason"].string))")

            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if !item["reason"].string.isEmpty {
                        Text(OpsText.scrub(item["reason"].string))
                            .font(.caption).foregroundStyle(OpsTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    KeirWorkLink(link: item["link"].string, ticket: item["ticket"], jobId: item["id"].string, title: item["title"].string) {
                        HStack(spacing: 6) {
                            Text(item["link"].string == "ticket" ? "Open ticket" : "Open work")
                            Image(systemName: "arrow.up.right")
                        }
                        .font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.sky)
                    }
                    .accessibilityIdentifier("keir-working-open-\(id)")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.bottom, 12)
            }
        }
    }
}

/// A progress update Keir posted on his own. The headline is composed from the
/// item's kind and ticket; server prose is supporting detail only, so an empty
/// template or a pasted question can never become a status line.
struct KeirUpdateMessage: View {
    @EnvironmentObject private var ops: OpsStore
    let message: JSONValue

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

    private func status(_ kind: String) -> (OpsStatus, String) {
        switch kind {
        case "needs-you": return (.waiting, "Needs you")
        case "stuck", "paused", "blocked": return (.blocked, "Blocked")
        case "finished", "live", "merged", "done": return (.done, "Done")
        case "failed", "error": return (.failed, "Failed")
        case "started": return (.running, "Started")
        default: return (.queued, "Update")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Keir").font(.caption.weight(.semibold))
                Text("Progress").font(.caption).foregroundStyle(OpsTheme.muted)
                Text(OpsFormat.ago(message["at"])).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(message["items"].array.enumerated()), id: \.offset) { index, item in
                    if index > 0 { Hairline() }
                    let state = status(item["kind"].string)
                    KeirWorkLink(link: item["link"].string, ticket: item["ticket"], jobId: item["jobId"].string, title: item["title"].string) {
                        HStack(alignment: .top, spacing: 10) {
                            OpsStatusBadge(status: state.0, label: state.1, compact: true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(OpsText.updateTitle(item))
                                    .font(.callout.weight(.medium))
                                    .fixedSize(horizontal: false, vertical: true)
                                let detail = OpsText.updateDetail(item)
                                if !detail.isEmpty {
                                    Text(detail).font(.caption).foregroundStyle(OpsTheme.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                    }
                }
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
