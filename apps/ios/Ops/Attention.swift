import SwiftUI
import LakesideCore

/// One model decides what "Needs you" means. Every badge, headline, stack and
/// queue asks this object for the count, so the number cannot drift between
/// screens. Decisions come first, then open questions, then work the owner
/// flagged; work already represented by a decision is not counted twice.
@MainActor
final class AttentionCenter: ObservableObject {
    static let shared = AttentionCenter()
    static let label = "Needs you"

    @Published private var decisions: [JSONValue] = []
    @Published private var questions: [JSONValue] = []
    @Published private var ownerWork: [JSONValue] = []

    private init() {}

    func setWork(decisions: [JSONValue], ownerWork: [JSONValue]) {
        self.decisions = decisions
        self.ownerWork = ownerWork
    }

    func setQuestions(_ items: [JSONValue]) {
        questions = items.filter { $0["state"].string == "pending" }
    }

    func reset() {
        decisions = []; questions = []; ownerWork = []
    }

    var items: [AttentionItem] {
        var seen = Set<String>()
        var tickets = Set<Int>()
        var rows: [AttentionItem] = []

        for decision in decisions {
            let id = "decision:" + decision["id"].string
            guard seen.insert(id).inserted else { continue }
            if let number = decision["ticket"].number { tickets.insert(Int(number)) }
            rows.append(AttentionItem(
                id: id,
                kind: .decision,
                title: OpsText.decisionTitle(decision),
                detail: OpsText.scrub(decision["reason"].string.nonempty ?? decision["question"].string),
                meta: [decision["ticket"].number.map { "Ticket #\(Int($0))" } ?? "", OpsFormat.ago(decision["at"])]
                    .filter { !$0.isEmpty }.joined(separator: " · "),
                ticket: decision["ticket"],
                decision: decision,
                work: .null
            ))
        }

        for question in questions {
            let id = "question:" + question["id"].string
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

        for work in ownerWork {
            let number = work["ticket"].number.map { Int($0) }
            if let number, tickets.contains(number) { continue }
            let id = "work:" + (work["id"].string.isEmpty ? work["title"].string : work["id"].string)
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

        return rows
    }

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
}

enum AttentionKind {
    case decision, question, ownerWork
}

/// The one stack rendered by Feed and the Keir briefing. Decisions keep their
/// full inline approve / reject / reply controls; questions and owner work get
/// a single tap to the place where the action lives.
struct AttentionStack: View {
    @EnvironmentObject private var router: OpsRouter
    @EnvironmentObject private var ops: OpsStore
    var limit: Int? = nil
    var showEmpty = false
    /// Question panels currently loaded in chat, so a question can be answered
    /// inline instead of only opening a destination.
    var panels: [JSONValue] = []

    private var rows: [AttentionItem] {
        let all = AttentionCenter.shared.items
        guard let limit else { return all }
        return Array(all.prefix(limit))
    }

    var body: some View {
        if rows.isEmpty {
            if showEmpty {
                OpsCard {
                    OpsHealthLine(status: .done, headline: "Nothing needs you", detail: "Keir is working through the queue.")
                }
            }
        } else {
            ForEach(rows) { item in
                switch item.kind {
                case .decision:
                    DecisionCard(decision: item.decision)
                case .question:
                    if let panel = panels.first(where: { $0["id"].string == item.id.replacingOccurrences(of: "question:", with: "") }) {
                        KeirQuestions(panel: panel)
                    } else {
                        AttentionLinkCard(
                            item: item,
                            status: .waiting,
                            action: "Answer in Keir",
                            icon: "hand.raised.fill"
                        ) { router.tab = .keir }
                    }
                case .ownerWork:
                    NavigationLink {
                        WorkItemDetail(item: item.work)
                    } label: {
                        AttentionRow(item: item, status: .waiting, action: "Open work")
                    }
                    .buttonStyle(.plain)
                }
            }
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
                OpsStatusBadge(status: status)
                Spacer(minLength: 8)
                Text(item.meta).font(.caption2).foregroundStyle(OpsTheme.muted).monospacedDigit()
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
                Image(systemName: icon).font(.caption.weight(.semibold))
                Text(action).font(.caption.weight(.semibold))
            }
            .foregroundStyle(OpsTheme.sky)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title). \(item.detail). \(action)")
    }
}

private extension String {
    func nonEmptyOr(_ other: String) -> String { isEmpty ? other : self }
}
