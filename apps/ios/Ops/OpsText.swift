import Foundation
import LakesideCore

/// Composes the short, human titles the app shows for Keir's work and status
/// updates. Server prose is used as supporting detail only; the headline is
/// always built from structured fields so an empty template or a pasted user
/// question can never become a status line.
enum OpsText {
    /// Collapses whitespace and removes known empty-template artifacts.
    static func scrub(_ raw: String) -> String {
        guard !raw.isEmpty else { return "" }
        var text = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)

        let artifacts = [
            "(?i)^ticket\\s*#?\\s*[0-9]+\\s*:\\s*ticket\\s*#?\\s*[0-9]+\\s*",
            "(?i)\\b(it me or )?turn been stuck in processing\\s*:\\s*started\\.?",
            "(?i)\\bstuck in processing\\s*:\\s*started\\.?",
            "(?i)\\bwas\\s*:\\s*\\.?\\s*$",
            "(?i)\\bwas\\s*:\\s*.*$",
            "(?i)\\bticket\\s*:\\s*(started|open|processing|in\\s+progress)?\\s*\\.?",
            "(?i)\\bit me or\\b",
            "(?i)\\bstatus\\s*:\\s*\\.",
        ]
        for pattern in artifacts {
            text = text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: " :–—-"))
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasPrefix(".") { text.removeFirst() }
        while text.hasSuffix("..") { text.removeLast() }
        if text == "." { text = "" }
        if text.range(of: "^(started|open|processing|in progress)\\.*$", options: [.regularExpression, .caseInsensitive]) != nil { return "" }
        return text
    }

    /// The first sentence, with no ellipsis. Used for a one-line reason.
    static func firstSentence(_ raw: String) -> String {
        let text = scrub(raw)
        guard !text.isEmpty else { return "" }
        if let end = text.firstIndex(where: { ".!?".contains($0) }) {
            return String(text[...end]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    /// A title that never repeats a ticket number the row already shows.
    static func workTitle(_ item: JSONValue) -> String {
        let number = item["ticket"].number
        let title = scrub(item["title"].string.nonempty ?? item["summary"].string.nonempty ?? "")
        if let number {
            let cleaned = title.isEmpty ? "" : deTicket(title, number: Int(number))
            return cleaned.isEmpty ? "Ticket #\(Int(number))" : "#\(Int(number)) \(cleaned)"
        }
        if !title.isEmpty { return title }
        return stateWord(item["state"].string)
    }

    static func ticketLine(number: JSONValue, title: String) -> String {
        let n = number.number
        let clean = scrub(title)
        if let n {
            let cleaned = clean.isEmpty ? "" : deTicket(clean, number: Int(n))
            return cleaned.isEmpty ? "Ticket #\(Int(n))" : "#\(Int(n)) \(cleaned)"
        }
        return clean
    }

    /// "Ticket 1651: Ticket 1651 remains open" becomes "Ticket #1651 remains open".
    static func deTicket(_ title: String, number: Int) -> String {
        var text = title
        let patterns = [
            "(?i)^\\s*ticket\\s*#?\\s*\(number)\\s*[:·-]\\s*",
            "(?i)\\bticket\\s*#?\\s*\(number)\\s+remains\\s+open\\b"
        ]
        if let first = patterns.first {
            text = text.replacingOccurrences(of: first, with: "", options: .regularExpression)
        }
        text = text.replacingOccurrences(of: patterns[1], with: "remains open", options: .regularExpression)
        return scrub(text)
    }

    /// The headline for a Keir progress update item: kind, then structured
    /// ticket data. `item["text"]` is never the headline.
    static func updateTitle(_ item: JSONValue) -> String {
        let kind = item["kind"].string
        let number = item["ticket"].number
        let known = scrub(item["title"].string.nonempty ?? "")
        let parsed = number.flatMap { textSubject(item["text"].string, number: Int($0)) } ?? ""
        let subject = [known, scrub(parsed)].first { !$0.isEmpty } ?? stateHeadline(kind)
        if let number {
            let cleaned = deTicket(subject, number: Int(number))
            return "#\(Int(number)) \(cleaned.isEmpty ? stateHeadline(kind) : cleaned)"
        }
        return subject
    }

    /// The server writes updates as "Ticket 1575, Factory demand refund: …".
    /// The words before the colon are the ticket's own title, so they are safe
    /// to promote into a headline.
    private static func textSubject(_ text: String, number: Int) -> String? {
        let pattern = "(?i)^ticket\\s*#?\\s*\(number)\\s*,\\s*([^:]{3,80}):"
        guard let range = text.range(of: pattern, options: .regularExpression) else { return nil }
        let matched = String(text[range])
        guard let comma = matched.firstIndex(of: ",") else { return nil }
        let subject = String(matched[matched.index(after: comma)...])
            .trimmingCharacters(in: CharacterSet(charactersIn: " :"))
        return subject.isEmpty ? nil : subject
    }

    /// The supporting line for an update item, with the ticket prefix removed
    /// so it does not repeat the headline.
    static func updateDetail(_ item: JSONValue) -> String {
        var text = scrub(item["text"].string)
        guard !text.isEmpty else { return "" }
        let number = item["ticket"].number
        if let number {
            text = text.replacingOccurrences(
                of: "(?i)^ticket\\s*#?\\s*\(Int(number))\\s*,?[^:]{0,120}:\\s*",
                with: "", options: .regularExpression
            )
        }
        text = text.replacingOccurrences(of: "(?i)^ticket\\s*#?\\s*[0-9]+\\s*:\\s*", with: "", options: .regularExpression)
        text = scrub(text)
        if ["remains open", "started", "open"].contains(text.lowercased()) { return "" }
        return text
    }

    /// A decision's title: its explicit summary, else a clean first line of the
    /// question, else a ticket-scoped fallback.
    static func decisionTitle(_ decision: JSONValue) -> String {
        if let tldr = decision["tldr"].string.nonempty { return scrub(tldr) }
        let question = firstSentence(decision["question"].string)
        if !question.isEmpty, question.count <= 90 { return question }
        if let number = decision["ticket"].number { return "Decision for Ticket #\(Int(number))" }
        return decision["signoff"].bool ? "Sign-off needed" : "Decision needed"
    }

    /// A question panel's title, never raw option text.
    static func questionTitle(_ panel: JSONValue) -> String {
        if let title = panel["title"].string.nonempty { return scrub(title) }
        let prompt = panel["questions"].array.first?["prompt"].string ?? ""
        let sentence = firstSentence(prompt)
        return sentence.isEmpty ? "Keir needs an answer" : sentence
    }

    static func detail(for kind: String?) -> String {
        switch kind {
        case "needs-you": return "Keir is waiting on your decision."
        case "blocked", "stuck", "paused": return "Work cannot continue until this is unblocked."
        default: return ""
        }
    }

    static func stateWord(_ raw: String) -> String {
        let status = OpsStatus.from(raw)
        switch raw.lowercased().replacingOccurrences(of: "_", with: "-") {
        case "needs-you", "needs-owner", "needsowner", "attention": return "Needs you"
        case "working", "running", "executing", "active", "processing": return "Running"
        case "blocked", "stuck", "stalled": return "Blocked"
        case "failed", "red", "error": return "Failed"
        case "done", "finished", "merged", "closed", "complete": return "Done"
        case "queued", "waiting", "held", "paused", "open", "next": return "Queued"
        default: return status.title
        }
    }

    private static func stateHeadline(_ kind: String) -> String {
        switch kind {
        case "needs-you": return "Decision needed"
        case "blocked", "stuck", "paused": return "Work paused"
        case "started": return "Work started"
        case "stage": return "Stage updated"
        case "pr", "merged": return "Pull request updated"
        case "finished", "live": return "Work finished"
        default: return "Progress update"
        }
    }
}
