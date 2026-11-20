import SwiftUI
import LakesideCore

/// One model decides what "Needs you" means. Every badge, headline, stack and
/// queue asks this object for the count, so the number cannot drift between
/// screens. Decisions come first, then open questions, then work the owner
/// flagged, then tickets held on a decision that has no loaded decision row.
/// A ticket or decision already represented is never counted twice.
@MainActor
final class AttentionCenter: ObservableObject {
    static let shared = AttentionCenter()
    static let label = "Needs you"

    @Published private var decisions: [JSONValue] = []
    @Published private var questions: [JSONValue] = []
    @Published private var ownerWork: [JSONValue] = []
    @Published private var heldTickets: [JSONValue] = []
    /// Rebuilt only when an input changes. Views read this instead of
    /// re-scrubbing every ticket on each body evaluation.
    @Published private(set) var items: [AttentionItem] = []

    private init() {}

    /// `tickets` is every ticket the app knows about (hub and work queue). Only
    /// the ones waiting on an owner decision are kept.
    func setWork(decisions: [JSONValue], ownerWork: [JSONValue], tickets: [JSONValue] = []) {
        self.decisions = decisions
        self.ownerWork = ownerWork
        self.heldTickets = tickets.filter { Self.waitsOnDecision($0) }
        rebuild()
    }

    func setQuestions(_ items: [JSONValue]) {
        questions = items.filter { $0["state"].string == "pending" }
        rebuild()
    }

    func reset() {
        decisions = []; questions = []; ownerWork = []; heldTickets = []; items = []
    }

    /// A ticket held on the owner: the server says a decision is pending, or
    /// its timing state is needs-you. Finished tickets never count.
    static func waitsOnDecision(_ ticket: JSONValue) -> Bool {
        guard KeirTicketFollowUp.isOpen(ticket) else { return false }
        return ticket["decisionPending"].bool || ticket["timing"]["state"].string == "needs-you"
    }

    private static func ticketNumber(_ value: JSONValue) -> Int? {
        if let number = value.number { return Int(number) }
        return Int(value.string)
    }

    private func rebuild() {
        items = buildItems()
    }

    private func buildItems() -> [AttentionItem] {
        var seen = Set<String>()
        var tickets = Set<Int>()
        var rows: [AttentionItem] = []

        for (index, decision) in decisions.enumerated() {
            let id = "decision:" + (decision["id"].string.nonempty ?? "index-\(index)")
            guard seen.insert(id).inserted else { continue }
            if let number = Self.ticketNumber(decision["ticket"]) { tickets.insert(number) }
            rows.append(AttentionItem(
                id: id,
                kind: .decision,
                title: OpsText.decisionTitle(decision),
                detail: OpsText.scrub(decision["reason"].string.nonempty ?? decision["question"].string),
                meta: [Self.ticketNumber(decision["ticket"]).map { "Ticket #\($0)" } ?? "", OpsFormat.ago(decision["at"])]
                    .filter { !$0.isEmpty }.joined(separator: " · "),
                ticket: decision["ticket"],
                decision: decision,
                work: .null
            ))
        }

        for (index, question) in questions.enumerated() {
            let id = "question:" + (question["id"].string.nonempty ?? "index-\(index)")
            guard seen.insert(id).inserted else { continue }
            rows.append(AttentionItem(
                id: id,
                kind: .question,
                title: OpsText.questionTitle(question),
                detail: OpsText.firstSentence(question["questions"].array.first?["prompt"].string ?? ""),
                meta: "Keir question",
                ticket: .null,
                decision: .null,
                work: .null
            ))
        }

        for (index, work) in ownerWork.enumerated() {
            let number = work["ticket"].number.map { Int($0) }
            if let number, tickets.contains(number) { continue }
            let rawID = work["id"].string.isEmpty ? work["title"].string : work["id"].string
            let id = "work:" + (rawID.isEmpty ? "index-\(index)" : rawID)
            guard seen.insert(id).inserted else { continue }
            if let number { tickets.insert(number) }
            rows.append(AttentionItem(
                id: id,
                kind: .ownerWork,
                title: OpsText.scrub(work["title"].string.nonempty ?? "Work needs a decision"),
                detail: OpsText.firstSentence(work["progress_summary"].string.nonEmptyOr(work["stale_reason"].string)),
                meta: ["Ticket #\(number.map { String($0) } ?? "")", OpsFormat.ago(work["updated_at"])]
                    .filter { !$0.isEmpty && $0 != "Ticket #" }.joined(separator: " · "),
                ticket: number.map { JSONValue.number(Double($0)) } ?? .null,
                decision: .null,
                work: work
            ))
        }

        for ticket in heldTickets {
            guard let number = Self.ticketNumber(ticket["number"]), tickets.insert(number).inserted else { continue }
            let id = "ticket:\(number)"
            guard seen.insert(id).inserted else { continue }
            let reason = ticket["timing"]["reason"].string
            rows.append(AttentionItem(
                id: id,
                kind: .ticket,
                title: OpsText.scrub(ticket["title"].string.nonempty ?? "Ticket #\(number)"),
                detail: OpsText.firstSentence(reason.isEmpty ? "Keir is waiting on your decision." : reason),
                meta: ["Ticket #\(number)", OpsFormat.ago(ticket["timing"]["since"])].filter { !$0.isEmpty }.joined(separator: " · "),
                ticket: .number(Double(number)),
                decision: .null,
                work: ticket
            ))
        }

        return rows
    }

    /// Decisions are counted once each, plus tickets held on a decision that
    /// has no decision row of its own.
    var decisionCount: Int { items.filter { $0.kind == .decision || $0.kind == .ticket }.count }

    var count: Int { items.count }

    var summary: String {
        switch count {
        case 0: return "Nothing needs you"
        case 1: return "1 thing needs you"
        default: return "\(count) things need you"
        }
    }

    var shortSummary: String {
        count == 0 ? "All clear" : "\(count) need you"
    }
}

struct AttentionItem: Identifiable {
    let id: String
    let kind: AttentionKind
    let title: String
    let detail: String
    let meta: String
    let ticket: JSONValue
    let decision: JSONValue
    let work: JSONValue

    /// The ticket this item stands for, if any. Used to keep one row per ticket.
    var ticketNumber: Int? {
        if let number = ticket.number { return Int(number) }
        return Int(ticket.string)
    }

    func matches(_ search: String) -> Bool {
        let needle = search.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "#")))
        guard !needle.isEmpty else { return true }
        if let number = ticketNumber, String(number) == needle { return true }
        return [title, detail, meta].contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    /// The short word on the card, so a decision never reads like a question.
    var kindLabel: String {
        switch kind {
        case .decision: return decision["type"].string == "choice" ? "Choose one" : "Approval"
        case .ticket: return "Decision"
        case .question: return "Question"
        case .ownerWork: return "Your call"
        }
    }
}

enum AttentionKind: Equatable {
    case decision, question, ownerWork, ticket
}

/// The one stack rendered by Ops, Feed, the Inbox and the Keir briefing.
/// Decisions keep their full inline approve / reject / reply controls;
/// questions, owner work and held tickets get a single tap to the place where
/// the action lives.
struct AttentionStack: View {
    @EnvironmentObject private var router: OpsRouter
    @EnvironmentObject private var ops: OpsStore
    @ObservedObject private var center = AttentionCenter.shared
    var limit: Int? = nil
    var showEmpty = false
    /// Only rows matching this text. Empty shows every row.
    var search = ""
    /// Question panels currently loaded in chat, so a question can be answered
    /// inline instead of only opening a destination.
    var panels: [JSONValue] = []
    var changed: () async -> Void = {}

    private var rows: [AttentionItem] {
        let all = center.items.filter { $0.matches(search) }
        guard let limit else { return all }
        return Array(all.prefix(limit))
    }

    var body: some View {
        if rows.isEmpty {
            if showEmpty {
                OpsHealthLine(status: .idle, headline: "Nothing needs you", detail: "")
            }
        } else {
            ForEach(rows) { item in
                AttentionCard(item: item, panels: panels, changed: changed)
            }
        }
    }
}

/// One Needs you row, chosen by kind. Every card fills the same width and
/// offers one action.
struct AttentionCard: View {
    @EnvironmentObject private var router: OpsRouter
    let item: AttentionItem
    var panels: [JSONValue] = []
    var changed: () async -> Void = {}

    var body: some View {
        switch item.kind {
        case .decision:
            DecisionCard(decision: item.decision, changed: changed)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .question:
            if let panel = panels.first(where: { $0["id"].string == item.id.replacingOccurrences(of: "question:", with: "") }) {
                KeirQuestions(panel: panel)
            } else {
                AttentionLinkCard(item: item, status: .waiting, action: "Answer in Keir", icon: "bubble.left") { router.tab = .keir }
            }
        case .ownerWork:
            NavigationLink {
                WorkItemDetail(item: item.work)
            } label: {
                AttentionRow(item: item, status: .waiting, action: "Open work")
            }
            .buttonStyle(.plain)
        case .ticket:
            NavigationLink {
                TicketDetail(ticket: item.work)
            } label: {
                AttentionRow(item: item, status: .waiting, action: "Open ticket")
            }
            .buttonStyle(.plain)
        }
    }
}

private struct AttentionLinkCard: View {
    let item: AttentionItem
    let status: OpsStatus
    let action: String
    let icon: String
    let run: () -> Void

    var body: some View {
        Button(action: run) {
            AttentionRow(item: item, status: status, action: action, icon: icon)
        }
        .buttonStyle(.plain)
    }
}

struct AttentionRow: View {
    let item: AttentionItem
    var status: OpsStatus = .waiting
    let action: String
    var icon: String = "arrow.right"

    var body: some View {
        OpsCard {
            HStack(alignment: .firstTextBaseline) {
                OpsStatusBadge(status: status, label: item.kindLabel)
                Spacer(minLength: 8)
                Text(item.meta).font(.caption2).foregroundStyle(OpsTheme.muted).monospacedDigit()
                    .lineLimit(1)
            }
            Text(item.title)
                .font(.opsCardTitle)
                .foregroundStyle(OpsTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if !item.detail.isEmpty, item.detail != item.title {
                Text(item.detail)
                    .font(.caption)
                    .foregroundStyle(OpsTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Text(action).font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Image(systemName: icon == "arrow.right" ? "chevron.right" : icon).font(.caption.weight(.semibold))
            }
            .foregroundStyle(OpsTheme.sky)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.kindLabel). \(item.title). \(item.detail). \(action)")
        .accessibilityAddTraits(.isButton)
    }
}

private extension String {
    func nonEmptyOr(_ other: String) -> String { isEmpty ? other : self }
}
