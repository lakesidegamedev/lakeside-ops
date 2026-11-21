import Foundation
import LakesideCore

// The private owner supervisor, native side. For the owner it serves every
// chat with Keir in the app: the private home chat, the support desk and side
// chats, each its own conversation (`thread`). It talks only to
// /api/keir/supervisor/* on the same origin and never to the support
// operator, so it keeps working while the operator is down. Everything here
// is plain logic with no views, so it can be tested without a screen.

enum KeirSupervisor {
    static let thread = "owner-supervisor"
    static let base = "/api/keir/supervisor"

    // MARK: Contract shapes

    /// Server ids are fixed-shape tokens. Anything else is never put in a path.
    static func validJob(_ id: String) -> Bool { matches(id, "^j_[a-f0-9]{16}$") }
    static func validProposal(_ id: String) -> Bool { matches(id, "^p_[a-f0-9]{16}$") }
    static func validDigest(_ value: String) -> Bool { matches(value, "^[a-f0-9]{64}$") }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// Which of the owner's chats the supervisor answers: home, the support desk
    /// ("main") and side chats (the operator's 12-hex thread ids that are not
    /// system threads such as "watches"). Only when the account has a supervisor.
    static func serves(_ thread: String, system: Bool = false) -> Bool {
        if thread == Self.thread || thread == "main" { return true }
        return !system && matches(thread, "^[a-f0-9]{12}$")
    }

    /// Supervisor file links (owner uploads and Keir's attachments). Nothing
    /// else is fetched from or deleted at this prefix.
    static let filePrefix = base + "/files/"
    static func validFileURL(_ url: String) -> Bool { matches(url, "^/api/keir/supervisor/files/[a-f0-9]{32}$") }

    /// The client id makes a retried send idempotent: the same id and text give
    /// the same message back instead of a second job. 8 to 128 of [A-Za-z0-9_.:-].
    static func clientId(_ token: String) -> String { "ios-" + token }

    /// Queued or running. A finished, failed or cancelled job is not live work.
    static func isLive(_ job: JSONValue) -> Bool { ["queued", "running"].contains(job["state"].string) }

    /// A job as the generic work row expects it: it has no title of its own.
    static func jobRow(_ job: JSONValue) -> JSONValue {
        var fields = job.object
        let repo = job["repo"].string
        fields["title"] = .string(repo.isEmpty ? "Working on your request" : "Working in \(repo)")
        return .object(fields)
    }

    /// A thread message in the shape the shared timeline renders. The supervisor
    /// speaks as Keir; progress lines are provisional so a voice turn waits for
    /// the final answer instead of reading them out as the reply.
    static func timelineRow(_ row: JSONValue) -> JSONValue {
        var fields = row.object
        if row["role"].string == "supervisor" { fields["role"] = .string("keir") }
        if let date = OpsFormat.date(row["at"]) { fields["at"] = .number(date.timeIntervalSince1970 * 1000) }
        if row["kind"].string == "update" { fields["provisional"] = .bool(true) }
        return .object(fields)
    }

    // MARK: Which conversation a message goes to

    /// What the profile says about this account. `waitingForProfile` means the
    /// account is not known yet, so nothing may be routed.
    enum Home: Equatable { case waitingForProfile, supervisor, support, probe }

    static func home(profile: JSONValue) -> Home {
        guard !profile.object.isEmpty else { return .waitingForProfile }
        if case .bool(let on) = profile["ownerSupervisor"] { return on ? .supervisor : .support }
        // A standalone install has no studio and no supervisor.
        if profile["mode"].string == "standalone" { return .support }
        // The server did not say. Ask the supervisor itself.
        return .probe
    }

    enum Probe: Equatable { case owner, notOwner, inconclusive }

    /// Reads the answer of GET /status. Only a clear "no" or a clear "yes"
    /// settles the account; a network or server fault leaves it open to retry.
    static func probe(_ result: Result<JSONValue, Error>) -> Probe {
        switch result {
        case .success(let status):
            return status["configured"] == .bool(true) ? .owner : .notOwner
        case .failure(let error):
            if setup(for: error) == .notConfigured { return .owner }
            guard let failure = error as? AppFailure else { return .inconclusive }
            if failure.statusCode == 403 || failure.statusCode == 404 { return .notOwner }
            // A web page or other non-JSON answer: this server has no such route.
            if failure.kind == .unexpectedResponse && failure.statusCode == nil { return .notOwner }
            return .inconclusive
        }
    }

    /// Why the private conversation cannot be used on this server right now.
    enum Setup: Equatable {
        case notConfigured, notOwner
        var message: String {
            switch self {
            case .notConfigured: return "Private supervisor is not set up on this server"
            case .notOwner: return "The private supervisor is for the owner only"
            }
        }
    }

    /// For reads only. A refused write can also be a CSRF 403, which says nothing about the owner.
    static func setup(for error: Error) -> Setup? {
        guard let failure = error as? AppFailure else { return nil }
        if failure.statusCode == 503, failure.payload["configured"] == .bool(false) { return .notConfigured }
        if failure.statusCode == 403 { return .notOwner }
        return nil
    }

    enum Destination: Equatable { case supervisor, support, withheld(String) }

    /// Where a message typed now would go. For an owner with a supervisor every
    /// chat they have with Keir (home, the support desk they opened, side chats)
    /// goes to the supervisor; the support desk is never a default for an owner.
    /// Everyone else talks to the support operator.
    static func destination(thread: String, supervisorAvailable: Bool, resolved: Bool, chosen: Bool, system: Bool = false) -> Destination {
        guard resolved else { return .withheld("Keir is still checking which account this is. Nothing was sent.") }
        if thread == Self.thread {
            return supervisorAvailable ? .supervisor : .withheld("Your private conversation is not available. Nothing was sent.")
        }
        if thread == "main", supervisorAvailable, !chosen {
            return .withheld("Open support desk yourself to message the support desk. Nothing was sent.")
        }
        if supervisorAvailable && serves(thread, system: system) { return .supervisor }
        return .support
    }
}

// MARK: - Proposals

/// A publish request frozen to one exact patch. Approval is the digest of that
/// patch sent back verbatim: there is no free-text approval anywhere.
struct KeirProposal: Equatable, Identifiable {
    let id: String
    let jobId: String
    let repo: String
    let state: String
    let title: String
    let files: [String]
    let tests: String
    let digest: String
    let branch: String
    let prURL: URL?
    let createdAt: JSONValue

    init?(_ json: JSONValue) {
        let id = json["id"].string
        guard KeirSupervisor.validProposal(id) else { return nil }
        self.id = id
        jobId = json["jobId"].string
        repo = json["repo"].string
        state = json["state"].string
        title = json["title"].string
        files = json["files"].array.map { $0.string }.filter { !$0.isEmpty }
        tests = json["tests"].string
        digest = json["digest"].string
        branch = json["branch"].string
        createdAt = json["createdAt"]
        // Only a plain https link is ever opened.
        let link = URL(string: json["prUrl"].string)
        prURL = link?.scheme?.lowercased() == "https" && link?.host?.isEmpty == false ? link : nil
    }

    var isPending: Bool { state == "pending" }
    /// A proposal without a real frozen-patch digest cannot be approved.
    var canDecide: Bool { isPending && KeirSupervisor.validDigest(digest) }
    var digestPrefix: String { String(digest.prefix(12)) }

    /// "3 files in lakeside-ops", the patch at a glance.
    var summary: String {
        let count = "\(files.count) file\(files.count == 1 ? "" : "s")"
        return repo.isEmpty ? count : "\(count) in \(repo)"
    }
}

// MARK: - State

/// Everything the supervisor view adds to the shared thread: the proposals,
/// the running job, the executor's honesty line, and why it may be unusable.
struct KeirSupervisorState: Equatable {
    var proposals: [KeirProposal] = []
    var executor: JSONValue = .null
    var setup: KeirSupervisor.Setup?
    /// The proposal waiting on the server's answer, so a second tap does nothing.
    var deciding: String?
    var decisionNotes: [String: String] = [:]
    var stopping = false

    var pending: [KeirProposal] { proposals.filter(\.isPending) }
    /// Published and rejected proposals, newest first, for a quiet result row.
    var decided: [KeirProposal] { Array(proposals.filter { !$0.isPending && ($0.state == "published" || $0.state == "rejected") }.prefix(3)) }

    /// A line to show when the executor cannot run jobs, with the server's own reason.
    var executorNotice: String? {
        guard executor["available"] == .bool(false) else { return nil }
        let reason = executor["reason"].string
        return reason.isEmpty ? "The supervisor cannot run jobs right now." : "The supervisor cannot run jobs right now: \(reason)"
    }

    mutating func apply(_ view: JSONValue) {
        setup = nil
        if view["proposals"] != .null { proposals = view["proposals"].array.compactMap(KeirProposal.init) }
        if view["executor"] != .null { executor = view["executor"] }
        let open = Set(pending.map(\.id))
        decisionNotes = decisionNotes.filter { open.contains($0.key) }
    }

    mutating func replace(_ proposal: KeirProposal) {
        if let index = proposals.firstIndex(where: { $0.id == proposal.id }) { proposals[index] = proposal }
        else { proposals.insert(proposal, at: 0) }
    }
}

// MARK: - Owner actions

extension KeirStore {
    /// The job the owner can stop, if one is queued or running.
    var supervisorLiveJob: JSONValue? { isSupervisor ? tasks.first(where: KeirSupervisor.isLive) : nil }

    /// One tap, bound to the patch on screen. The digest of the displayed
    /// proposal is sent back verbatim; if the proposal has changed since it was
    /// shown, or is no longer pending, nothing is sent.
    @discardableResult
    func decide(_ proposal: KeirProposal, approve: Bool, _ session: AppSession) async -> Bool {
        guard isSupervisor, supervisor.deciding == nil else { return false }
        guard let shown = supervisor.proposals.first(where: { $0.id == proposal.id }),
              shown.digest == proposal.digest, shown.canDecide else {
            supervisor.decisionNotes[proposal.id] = "This proposal changed or was already decided. Review it again."
            return false
        }
        let epoch = generation
        supervisor.deciding = proposal.id; supervisor.decisionNotes[proposal.id] = nil
        defer { if generation == epoch { supervisor.deciding = nil } }
        do {
            let result = try await session.post("\(KeirSupervisor.base)/proposals/\(proposal.id)",
                                                ["verdict": .string(approve ? "approve" : "reject"), "digest": .string(proposal.digest)])
            guard generation == epoch else { return false }
            if let updated = KeirProposal(result["proposal"]) { supervisor.replace(updated) }
            return true
        } catch {
            guard generation == epoch else { return false }
            supervisor.decisionNotes[proposal.id] = error.displayMessage
            await refreshProposals(session)
            return false
        }
    }

    func refreshProposals(_ session: AppSession) async {
        let epoch = generation
        guard isSupervisor, let result = try? await session.get("\(KeirSupervisor.base)/proposals"), generation == epoch else { return }
        supervisor.proposals = result["proposals"].array.compactMap(KeirProposal.init)
    }

    /// Stops a queued or running job. The server keeps the workspace and its changes.
    func cancelSupervisorJob(_ id: String, _ session: AppSession) async {
        guard isSupervisor, KeirSupervisor.validJob(id), !supervisor.stopping else { return }
        let epoch = generation
        supervisor.stopping = true
        defer { if generation == epoch { supervisor.stopping = false } }
        do {
            _ = try await session.post("\(KeirSupervisor.base)/jobs/\(id)/cancel", [:])
            guard generation == epoch else { return }
            error = nil
        } catch {
            guard generation == epoch else { return }
            self.error = error.displayMessage
        }
    }
}
