import Foundation

// Turning an owner's chat message in the private supervisor thread into a
// reviewable, explicitly confirmed action. Nothing in this file performs a
// request. It decides what may be offered, builds the exact request the
// contract allows, and checks that a reply really proves the action happened.

public enum ConversationOp: String, Codable, Sendable { case take, message, handback }

public enum ConversationIntent: Equatable, Sendable {
    case take(ticket: Int, text: String)
    case handback(ticket: Int, text: String)
    case message(ticket: Int, text: String)
    case approvals
    case proposal(id: String)

    public var op: ConversationOp? {
        switch self {
        case .take: return .take
        case .handback: return .handback
        case .message: return .message
        case .approvals, .proposal: return nil
        }
    }
    public var ticket: Int? {
        switch self {
        case .take(let n, _), .handback(let n, _), .message(let n, _): return n
        case .approvals, .proposal: return nil
        }
    }
    public var text: String {
        switch self {
        case .take(_, let t), .handback(_, let t), .message(_, let t): return t
        case .approvals, .proposal: return ""
        }
    }
}

public enum ConversationIntentParser {
    /// An offer is only made for a message that this device's owner sent in the
    /// supervisor thread and the server accepted (it has a server id and a
    /// sequence number), or for a structured proposal notice the supervisor
    /// server wrote. Prose from the model, ticket text and worker text never
    /// reaches the text parser: a supervisor row can only ever match
    /// `proposal`, and only through its structured `kind` and `proposalId`.
    public static func intent(for message: JSONValue, inSupervisorThread: Bool) -> ConversationIntent? {
        guard inSupervisorThread else { return nil }
        let role = message["role"].string
        let kind = message["kind"].string
        if role == "owner" {
            guard kind.isEmpty || kind == "message",
                  !message["id"].string.isEmpty,
                  (message["seq"].number ?? 0) > 0,
                  message["update"] == .null || message["update"] == .bool(false) else { return nil }
            return parse(message["text"].string)
        }
        if (role == "supervisor" || role == "keir"), kind == "approval" {
            let id = message["proposalId"].string
            return validIdentifier(id) ? .proposal(id: id) : nil
        }
        return nil
    }

    /// Conservative grammar. The command has to open the message (after an
    /// optional greeting or "please"), so negations ("don't take over ..."),
    /// questions about the past, conditions and lists of several tickets all
    /// fail to match instead of being guessed at.
    public static func parse(_ raw: String) -> ConversationIntent? {
        let text = raw.replacingOccurrences(of: "\u{2019}", with: "'").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 8000 else { return nil }

        for pattern in takePatterns {
            if let g = match(lead + pattern, text), let n = ticketNumber(g[1]) { return .take(ticket: n, text: direction(g)) }
        }
        for pattern in handbackPatterns {
            if let g = match(lead + pattern, text), let n = ticketNumber(g[1]) { return .handback(ticket: n, text: direction(g)) }
        }
        for pattern in messagePatterns {
            if let g = match(lead + pattern, text), let n = ticketNumber(g[1]) { return .message(ticket: n, text: direction(g)) }
        }
        for pattern in approvalPatterns where match(lead + pattern, text) != nil { return .approvals }
        return nil
    }

    public static func validIdentifier(_ value: String) -> Bool {
        match(#"^[A-Za-z0-9_\-]{1,80}$"#, value, options: []) != nil
    }

    // MARK: patterns (shared with the JS cross-check in the report)

    static let ticket: String = #"(?:(?:ticket|case)\s*#?\s*|#)(\d{1,7})(?!\d)"#
    static let lead: String = #"^(?:(?:hey|hi|ok|okay|so|right)[,\s]+)?(?:keir[,:\s]+)?(?:(?:please|pls)[,\s]+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|i'd\s+like\s+you\s+to\s+|go\s+ahead\s+and\s+|let's\s+|lets\s+))?(?:(?:please|pls)\s+)?"#
    static let support: String = #"(?:support\s+keir|support|the\s+support\s+desk)"#
    static let note: String = #"(?:\s*[:;,]\s*(.+)|\s+-\s+(.+))?[.!?]?$"#
    static let words: String = #"(?:\s*[:;,]\s*(.+)|\s+-\s+(.+)|\s+to\s+(.+)|\s+(.+))?$"#
    static let takePatterns: [String] = [
        #"(?:take|taking)(?:\s+over)?(?:\s+the)?(?:\s+support)?\s+\#(ticket)(?:\s+over)?(?:\s+from\s+support(?:\s+keir)?)?(?:\s*[:;,]\s*(.+)|\s+-\s+(.+)|\s+(?:and|then)\s+(?:tell|ask|have)\s+(?:it|them|the\s+worker)(?:\s+to)?\s+(.+))?[.!?]?$"#
    ]
    static let handbackPatterns: [String] = [
        #"(?:hand|give|send)\s+back(?:\s+the)?\s+\#(ticket)(?:\s+(?:to\s+)?\#(support))?\#(note)"#,
        #"(?:hand|give|send)(?:\s+the)?\s+\#(ticket)\s+back(?:\s+to\s+\#(support))?\#(note)"#,
        #"return(?:\s+the)?\s+\#(ticket)\s+to\s+\#(support)\#(note)"#
    ]
    static let messagePatterns: [String] = [
        #"(?:message|tell|ping|notify|write\s+to|send\s+a\s+message\s+to|send)\s+(?:the\s+)?(?:(?:keir|ticket|support)\s+)?worker\s+(?:(?:on|for|working\s+on|assigned\s+to|handling|of)\s+)?(?:the\s+)?\#(ticket)\#(words)"#,
        #"(?:message|tell|ping|notify)\s+(?:the\s+)?\#(ticket)\s+(?:ticket\s+)?worker\#(words)"#
    ]
    static let approvalPatterns: [String] = [
        #"(?:review|show|open|check|list|see)(?:\s+me)?(?:\s+(?:the|my|all|any|pending|waiting|open|outstanding))*\s+approvals?(?:\s+(?:waiting|pending|to\s+review))?[.!?]?$"#,
        #"what(?:'s|\s+is|\s+are)?\s+(?:waiting|pending)(?:\s+(?:for|on))?\s+(?:my\s+|your\s+|an?\s+)?approvals?\??$"#,
        #"(?:anything|what)\s+(?:needs?|waiting\s+for)\s+(?:my\s+)?approval\??$"#
    ]

    private static func ticketNumber(_ value: String) -> Int? {
        guard let n = Int(value), n >= 1, n <= 9_999_999 else { return nil }
        return n
    }
    /// The last non-empty capture after the ticket number is the direction.
    private static func direction(_ groups: [String]) -> String {
        (groups.dropFirst(2).last { !$0.isEmpty } ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func match(_ pattern: String, _ text: String, options: NSRegularExpression.Options = [.caseInsensitive, .dotMatchesLineSeparators]) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        let full = NSRange(text.startIndex..., in: text)
        guard let found = regex.firstMatch(in: text, options: [], range: full) else { return nil }
        return (0..<found.numberOfRanges).map { index in
            guard let range = Range(found.range(at: index), in: text) else { return "" }
            return String(text[range])
        }
    }
}

// MARK: request building

public struct ConversationActionRequest: Equatable, Sendable {
    public let path: String
    public let body: [String: JSONValue]
}

public enum ConversationActionError: Error, Equatable, Sendable {
    case invalid(String)
    public var message: String { if case .invalid(let text) = self { return text }; return "" }
}

public enum ConversationActionBuilder {
    public static let maxText = 4000

    public static func requestID() -> String { "ka-" + UUID().uuidString.lowercased() }
    public static func validRequestID(_ id: String) -> Bool {
        id.count >= 8 && id.count <= 80 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }
    public static func supervisionPath(_ ticket: Int) -> String { "/api/keir/app/tickets/\(ticket)/supervision" }

    /// The exact body the bridge contract defines. Revision is required for
    /// take and handback so an old view cannot act on a ticket that moved.
    public static func request(op: ConversationOp, ticket: Int, requestId: String, revision: String, text: String, workerId: String) throws -> ConversationActionRequest {
        guard ticket >= 1, ticket <= 9_999_999 else { throw ConversationActionError.invalid("That ticket number is not valid.") }
        guard validRequestID(requestId) else { throw ConversationActionError.invalid("The request could not be prepared. Close this and try again.") }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard body.count <= maxText else { throw ConversationActionError.invalid("This is \(body.count) characters. The limit is \(maxText).") }
        var fields: [String: JSONValue] = ["op": .string(op.rawValue), "requestId": .string(requestId)]
        switch op {
        case .take, .handback:
            guard !revision.isEmpty else { throw ConversationActionError.invalid("The ticket state has not loaded yet. Refresh and try again.") }
            fields["revision"] = .string(revision)
            if !body.isEmpty { fields["text"] = .string(body) }
        case .message:
            guard !body.isEmpty else { throw ConversationActionError.invalid("Write the message for the worker first.") }
            fields["text"] = .string(body)
            if !workerId.isEmpty { fields["workerId"] = .string(workerId) }
        }
        return ConversationActionRequest(path: supervisionPath(ticket), body: fields)
    }

    /// Approval of a supervisor proposal, bound to the exact patch digest the
    /// server showed. A malformed id or digest is refused before any request.
    public static func proposalVerdict(id: String, approve: Bool, digest: String) throws -> ConversationActionRequest {
        guard ConversationIntentParser.validIdentifier(id) else { throw ConversationActionError.invalid("This proposal reference is not valid.") }
        guard digest.count == 64, digest.allSatisfy({ $0.isHexDigit }) else { throw ConversationActionError.invalid("This proposal has no verifiable patch digest, so it cannot be decided from here.") }
        return ConversationActionRequest(path: "/api/keir/supervisor/proposals/\(id)", body: ["verdict": .string(approve ? "approve" : "reject"), "digest": .string(digest)])
    }
}

// MARK: what the live ticket allows

public enum ConversationActionPlan: Equatable, Sendable {
    case ready(workerId: String)
    case unavailable(String)

    /// Mirrors the server's own flags; never overrides them.
    public static func evaluate(op: ConversationOp, view: JSONValue, ticket: Int) -> ConversationActionPlan {
        guard view["ticket"].number == Double(ticket) else { return .unavailable("The server answered for a different ticket, so nothing was offered.") }
        switch op {
        case .take:
            if view["canTake"].bool { return .ready(workerId: "") }
            if view["state"].string == "supervised" { return .unavailable("A worker is already on this ticket.") }
            let reasons = view["takeBlockers"].array.map { $0["text"].string }.filter { !$0.isEmpty }
            return .unavailable(reasons.isEmpty ? "The ticket cannot be taken over right now." : reasons.joined(separator: " "))
        case .message:
            guard view["canMessage"].bool, let worker = view["worker"].object["id"]?.string, !worker.isEmpty else { return .unavailable("No worker is on this ticket, so there is nobody to message.") }
            return .ready(workerId: worker)
        case .handback:
            guard view["canHandback"].bool else { return .unavailable("No worker is on this ticket, so there is nothing to hand back.") }
            return .ready(workerId: "")
        }
    }
}

// MARK: proof of what happened

public struct ConversationActionOutcome: Codable, Equatable, Sendable {
    public var op: ConversationOp
    public var ticket: Int
    public var headline: String
    public var details: [String]
    public var workerIdentity: String
    public var duplicate: Bool
    /// False when the action is proven only by re-reading the ticket after a
    /// dropped connection.
    public var recovered: Bool

    static func count(_ n: Int, _ singular: String, _ plural: String? = nil) -> String { "\(n) \(n == 1 ? singular : (plural ?? singular + "s"))" }

    /// Success is only reported when the reply is well formed and agrees with
    /// what was asked. Anything else returns nil and the caller says the result
    /// is unconfirmed.
    public static func interpret(op: ConversationOp, ticket: Int, requestId: String, response: JSONValue) -> ConversationActionOutcome? {
        guard response["ok"].bool, response["op"].string == op.rawValue, response["requestId"].string == requestId else { return nil }
        let receipt = response["receipt"]
        guard receipt != .null, receipt["ticket"].number == Double(ticket) else { return nil }
        let view = response["supervision"]
        let duplicate = response["duplicate"].bool
        let worker = receipt["workerId"].string
        var details: [String] = []
        let headline: String
        var identity = ""
        switch op {
        case .take:
            guard !worker.isEmpty, view["state"].string == "supervised", view["worker"]["id"].string == worker else { return nil }
            identity = view["worker"]["identity"].string.isEmpty ? "keir-worker:" + worker : view["worker"]["identity"].string
            headline = "Ticket #\(ticket) is now supervised by \(identity)" + (receipt["generation"].number.map { " (takeover \(Int($0)))." } ?? ".")
            details.append("Support Keir is stopped on this ticket.")
            let suppressed = Int(receipt["suppressedOutbox"].number ?? 0)
            if suppressed > 0 { details.append("\(count(suppressed, "queued public reply", "queued public replies")) from Support Keir \(suppressed == 1 ? "was" : "were") held back.") }
            let moved = receipt["transferred"]
            if moved != .null {
                let evidence = Int(moved["evidence"].number ?? 0)
                details.append("Handed to the worker: " + (moved["nextAction"].string.isEmpty ? "no recorded next step" : "next step \u{201C}\(moved["nextAction"].string)\u{201D}") + ", \(count(evidence, "piece")) of evidence.")
                let approvals = Int(moved["pendingApprovals"].number ?? 0)
                if approvals > 0 { details.append("\(count(approvals, "approval")) still waiting for you. Nothing was approved.") }
                let uncertain = Int(moved["uncertainEffects"].number ?? 0)
                if uncertain > 0 { details.append("\(count(uncertain, "earlier action")) may or may not have run. It is listed, not repeated.") }
            }
        case .message:
            guard !worker.isEmpty else { return nil }
            identity = view["worker"]["identity"].string.isEmpty ? "keir-worker:" + worker : view["worker"]["identity"].string
            headline = "Your message is in the inbox of \(identity) on ticket #\(ticket)."
            let state = receipt["workerState"].string
            details.append("Delivered to the worker" + (state.isEmpty ? "." : ", which is \(state.replacingOccurrences(of: "_", with: " ")). It has not necessarily read it yet."))
        case .handback:
            guard !receipt["handoffId"].string.isEmpty, view["state"].string != "supervised" else { return nil }
            identity = worker.isEmpty ? "" : "keir-worker:" + worker
            headline = "Ticket #\(ticket) is back with Support Keir."
            if !identity.isEmpty { details.append("\(identity) is stopped and can no longer post or act.") }
            let suppressed = Int(receipt["suppressedOutbox"].number ?? 0)
            if suppressed > 0 { details.append("\(count(suppressed, "queued post")) from the worker \(suppressed == 1 ? "was" : "were") held back.") }
            let returned = Int(receipt["returnedInbox"].number ?? 0)
            if returned > 0 { details.append("\(count(returned, "unread direction")) returned to Support Keir.") }
        }
        if duplicate { details.insert("This was already done earlier. Nothing ran a second time.", at: 0) }
        return ConversationActionOutcome(op: op, ticket: ticket, headline: headline, details: details, workerIdentity: identity, duplicate: duplicate, recovered: false)
    }

    /// After a dropped connection: did the server record this request id?
    /// `sessions` carries the take and handback ids, `directions` the message id.
    public static func recovered(op: ConversationOp, ticket: Int, requestId: String, view: JSONValue) -> ConversationActionOutcome? {
        guard view["ticket"].number == Double(ticket) else { return nil }
        switch op {
        case .take, .handback:
            let key = op == .take ? "take" : "handback"
            guard let row = view["sessions"].array.first(where: { $0["requestIds"][key].string == requestId }) else { return nil }
            let worker = row["workerId"].string
            let identity = worker.isEmpty ? "" : "keir-worker:" + worker
            let headline = op == .take ? "Ticket #\(ticket) was taken over. The connection dropped before the reply, but the server recorded it." : "Ticket #\(ticket) was handed back. The connection dropped before the reply, but the server recorded it."
            return ConversationActionOutcome(op: op, ticket: ticket, headline: headline, details: identity.isEmpty ? [] : [identity], workerIdentity: identity, duplicate: false, recovered: true)
        case .message:
            guard let row = view["directions"].array.first(where: { $0["requestId"].string == requestId }) else { return nil }
            let worker = row["workerId"].string
            let identity = worker.isEmpty ? "" : "keir-worker:" + worker
            return ConversationActionOutcome(op: op, ticket: ticket, headline: "Your message reached the worker on ticket #\(ticket). The connection dropped before the reply, but the server recorded it.", details: identity.isEmpty ? [] : [identity], workerIdentity: identity, duplicate: false, recovered: true)
        }
    }
}

// MARK: failure wording

public enum ConversationActionFailure: Equatable, Sendable {
    /// The server said no. Nothing changed. A new attempt needs a new id.
    case refused
    /// Take could not verify the ticket (support service or Discord down). Nothing changed.
    case couldNotVerify
    /// No usable answer. The action may have happened; retry with the same id.
    case unknown

    public static func classify(op: ConversationOp, statusCode: Int?) -> ConversationActionFailure {
        if let code = statusCode {
            if code == 503, op == .take { return .couldNotVerify }
            if (400..<500).contains(code) { return .refused }
            return .unknown
        }
        return .unknown
    }

    public func explain(serverMessage: String) -> String {
        switch self {
        case .refused:
            let reason = serverMessage.isEmpty ? "The server refused this." : serverMessage
            return reason + " Nothing was changed."
        case .couldNotVerify:
            return "The ticket could not be verified right now (the support service, Discord or the sign-in check is unavailable). Nothing was changed. Try again in a minute."
        case .unknown:
            return "The app did not get a clear answer, so the action may or may not have happened. Retrying uses the same request, so it cannot run twice."
        }
    }
}

// MARK: one message, one action

public struct ConversationActionRecord: Codable, Equatable, Sendable {
    public var key: String
    public var op: ConversationOp
    public var ticket: Int
    public var requestId: String
    public var textHash: String
    public var done: Bool
    public var outcome: ConversationActionOutcome?
    public var at: Double
}

/// Remembers, per message, the request id of an attempt that may still be in
/// flight and the confirmed result of one that finished. Holds no message text.
public struct ConversationActionLedger: Codable, Equatable, Sendable {
    public private(set) var records: [String: ConversationActionRecord] = [:]
    public static let limit = 200
    public init() {}

    public static func key(scope: String, messageID: String, op: ConversationOp, ticket: Int) -> String {
        "\(scope)|\(messageID)|\(op.rawValue)|\(ticket)"
    }
    public static func hash(_ text: String) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for byte in text.trimmingCharacters(in: .whitespacesAndNewlines).utf8 { h = (h ^ UInt64(byte)) &* 0x100000001b3 }
        return String(h, radix: 16)
    }
    public func record(for key: String) -> ConversationActionRecord? { records[key] }
    public func isDone(_ key: String) -> Bool { records[key]?.done == true }

    /// The same id for the same unfinished attempt (same text), a fresh one
    /// when the owner changed the words. A finished message never starts again.
    public mutating func requestID(for key: String, op: ConversationOp, ticket: Int, text: String, now: Double, make: () -> String = ConversationActionBuilder.requestID) -> String? {
        let digest = Self.hash(text)
        if let existing = records[key] {
            if existing.done { return nil }
            if existing.textHash == digest { return existing.requestId }
        }
        let id = make()
        records[key] = ConversationActionRecord(key: key, op: op, ticket: ticket, requestId: id, textHash: digest, done: false, outcome: nil, at: now)
        trim()
        return id
    }
    public mutating func complete(_ key: String, outcome: ConversationActionOutcome, now: Double) {
        guard var row = records[key] else { return }
        row.done = true; row.outcome = outcome; row.at = now
        records[key] = row
    }
    /// A definite refusal: the id was not used by the server, so forget it.
    public mutating func discardPending(_ key: String) {
        if records[key]?.done == false { records[key] = nil }
    }
    private mutating func trim() {
        guard records.count > Self.limit else { return }
        for row in records.values.sorted(by: { $0.at < $1.at }).prefix(records.count - Self.limit) { records[row.key] = nil }
    }
}
