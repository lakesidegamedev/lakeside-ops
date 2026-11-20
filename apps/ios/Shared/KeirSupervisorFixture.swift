#if DEBUG
import Foundation

/// A stand-in for the private owner supervisor server (contract v1), used only
/// by UI and session tests. Absent from Release builds. It is stateful, so a
/// test can connect, send, read the answer, and reopen against the same
/// transcript. Every value is synthetic.
///
/// It enforces the parts of the contract the iPhone can get wrong: JSON
/// content type, a same-origin Origin, an idempotent `clientId`, and a
/// proposal decision that must carry the stored digest and works only once.
/// `requests` records every call so a test can prove what was and was not hit.
final class KeirSupervisorFixture: @unchecked Sendable {
    enum Mode { case normal, notConfigured, notOwner, publishDisabled }

    /// Shared by the UI-test transport. Launch flags pick the mode:
    /// `--uitest-supervisor-unconfigured`, `-owner-only`, `-publish-disabled`, `-hold`.
    static let shared: KeirSupervisorFixture = {
        let args = ProcessInfo.processInfo.arguments
        let fixture = KeirSupervisorFixture(seedProposal: true)
        if args.contains("--uitest-supervisor-unconfigured") { fixture.mode = .notConfigured }
        else if args.contains("--uitest-supervisor-owner-only") { fixture.mode = .notOwner }
        else if args.contains("--uitest-supervisor-publish-disabled") { fixture.mode = .publishDisabled }
        fixture.answersAutomatically = !args.contains("--uitest-supervisor-hold")
        return fixture
    }()

    static let proposalId = "p_0123456789abcdef"
    static let proposalDigest = String(repeating: "ab12", count: 16)

    private let lock = NSLock()
    private var state_mode = Mode.normal
    private var state_auto = true
    private var log: [String] = []
    private var postedClientIds: [String] = []
    private var decided: [(id: String, verdict: String, digest: String)] = []
    private var messages: [[String: Any]] = []
    private var jobs: [[String: Any]] = []
    private var proposals: [[String: Any]] = []
    private var accepted: [String: (text: String, response: [String: Any])] = [:]
    private var lastSeq = 0
    private var revision = 0
    private var counter = 0

    init(seedProposal: Bool = false) {
        if seedProposal { seed() }
    }

    var mode: Mode {
        get { lock.lock(); defer { lock.unlock() }; return state_mode }
        set { lock.lock(); defer { lock.unlock() }; state_mode = newValue }
    }
    /// When false a sent message stays queued with no answer, so a test can stop the job.
    var answersAutomatically: Bool {
        get { lock.lock(); defer { lock.unlock() }; return state_auto }
        set { lock.lock(); defer { lock.unlock() }; state_auto = newValue }
    }
    /// "METHOD /path" for every request this fixture has seen, in order.
    var requests: [String] { lock.lock(); defer { lock.unlock() }; return log }
    /// The `clientId` of every message POST, including ones the fixture then refused.
    var clientIds: [String] { lock.lock(); defer { lock.unlock() }; return postedClientIds }
    /// Every verdict the fixture received: proposal id, verdict, and the digest that came with it.
    var decisions: [(id: String, verdict: String, digest: String)] { lock.lock(); defer { lock.unlock() }; return decided }

    // MARK: Transport

    func handle(_ request: URLRequest, enabled: Bool = true) -> (status: Int, data: Data) {
        guard let url = request.url else { return reply(400, ["error": "bad request"]) }
        let method = request.httpMethod ?? "GET"
        // The body stream can only be read once, so read it up front.
        let body = method == "POST" ? Self.body(of: request) : nil
        lock.lock(); defer { lock.unlock() }
        log.append("\(method) \(url.path)")
        if url.path.hasSuffix("/messages"), let id = body?["clientId"] as? String { postedClientIds.append(id) }
        guard enabled else { return reply(404, ["error": "not found"]) }
        switch state_mode {
        case .notConfigured: return reply(503, ["error": "The private supervisor is not set up on this server.", "configured": false, "missing": ["KEIR_SUPERVISOR_DIR"]])
        case .notOwner: return reply(403, ["error": "The private supervisor is for the owner only."])
        default: break
        }
        let route = String(url.path.dropFirst("/api/keir/supervisor".count))
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        if route == "/status" && method == "GET" { return reply(200, status()) }
        if method == "POST" {
            let type = (request.value(forHTTPHeaderField: "Content-Type") ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
            guard type == "application/json" else { return reply(415, ["error": "JSON required"]) }
            let authority = (url.host ?? "") + (url.port.map { ":\($0)" } ?? "")
            if let origin = request.value(forHTTPHeaderField: "Origin"), origin != "https://\(authority)" { return reply(403, ["error": "Unexpected origin"]) }
            if route == "/messages" { return post(body) }
            if route.hasPrefix("/jobs/"), route.hasSuffix("/cancel") { return cancel(String(route.dropFirst(6).dropLast(7))) }
            if route.hasPrefix("/proposals/") { return decide(String(route.dropFirst(11)), body) }
            return reply(404, ["error": "not found"])
        }
        guard method == "GET" else { return reply(405, ["error": "method not allowed"]) }
        if route == "/thread" { return thread(after: query["after"].flatMap { Int($0) }, limit: Int(query["limit"] ?? "") ?? 50) }
        if route == "/proposals" { return reply(200, ["proposals": proposals]) }
        return reply(404, ["error": "not found"])
    }

    // MARK: Routes (the lock is held)

    private func status() -> [String: Any] {
        ["configured": true, "missing": [] as [Any], "executor": executor(), "sandbox": ["available": true, "reason": NSNull()],
         "repos": [["key": "lakeside-ops", "available": true, "base": "origin/main", "publish": state_mode == .publishDisabled ? "disabled" : "enabled"]],
         "runner": ["owner": true, "queued": 0, "running": NSNull()], "guardian": ["available": false, "reason": "no guardian in the fixture"]]
    }

    private func executor() -> [String: Any] { ["available": true, "reason": NSNull(), "runner": "claude", "model": "claude-opus-5-5"] }

    private func thread(after: Int?, limit: Int) -> (status: Int, data: Data) {
        let capped = max(1, min(200, limit))
        let rows: [[String: Any]]
        if let after { rows = Array(messages.filter { ($0["seq"] as? Int ?? 0) > after }.prefix(capped)) }
        else { rows = Array(messages.suffix(capped)) }
        let live = jobs.filter { ["queued", "running"].contains($0["state"] as? String ?? "") }
        let running = jobs.first { $0["state"] as? String == "running" }
        return reply(200, ["messages": rows, "cursor": lastSeq, "working": !live.isEmpty, "version": "\(lastSeq):\(revision)",
                           "current": running ?? NSNull(), "queued": jobs.filter { $0["state"] as? String == "queued" }.count,
                           "jobs": jobs, "proposals": proposals, "executor": executor()])
    }

    private func post(_ body: [String: Any]?) -> (status: Int, data: Data) {
        let text = body?["text"] as? String ?? ""
        let clientId = body?["clientId"] as? String ?? ""
        guard (1...8000).contains(text.count) else { return reply(400, ["error": "text must be 1 to 8000 characters"]) }
        guard clientId.range(of: "^[A-Za-z0-9_.:-]{8,128}$", options: .regularExpression) != nil else { return reply(400, ["error": "invalid clientId"]) }
        if let earlier = accepted[clientId] {
            guard earlier.text == text else { return reply(409, ["error": "clientId was used for a different message"]) }
            var again = earlier.response; again["duplicate"] = true
            return reply(200, again)
        }
        let jobId = nextId("j")
        let message = append(["role": "owner", "kind": "message", "text": text, "jobId": jobId, "clientId": clientId])
        var job: [String: Any] = ["id": jobId, "state": "queued", "attempts": 0, "repo": "lakeside-ops", "createdAt": stamp(lastSeq)]
        jobs.append(job)
        if state_auto {
            job["state"] = "done"; job["attempts"] = 1; job["finishedAt"] = stamp(lastSeq + 1); jobs[jobs.count - 1] = job
            _ = append(["role": "supervisor", "kind": "answer", "text": "Looked at it: \(text)", "jobId": jobId])
        }
        revision += 1
        let response: [String: Any] = ["accepted": true, "duplicate": false, "message": message, "job": ["id": jobId, "state": "queued", "queuePosition": 0]]
        accepted[clientId] = (text, response)
        return reply(202, response)
    }

    private func cancel(_ jobId: String) -> (status: Int, data: Data) {
        guard let index = jobs.firstIndex(where: { $0["id"] as? String == jobId }) else { return reply(404, ["error": "not found"]) }
        guard ["queued", "running"].contains(jobs[index]["state"] as? String ?? "") else { return reply(409, ["error": "Job already finished"]) }
        jobs[index]["state"] = "cancelled"; revision += 1
        _ = append(["role": "supervisor", "kind": "notice", "text": "Stopped. The workspace and its changes are kept.", "jobId": jobId])
        return reply(200, ["cancelled": true, "job": jobs[index]])
    }

    private func decide(_ id: String, _ body: [String: Any]?) -> (status: Int, data: Data) {
        guard let index = proposals.firstIndex(where: { $0["id"] as? String == id }) else { return reply(404, ["error": "not found"]) }
        let verdict = body?["verdict"] as? String ?? "", digest = body?["digest"] as? String ?? ""
        guard ["approve", "reject"].contains(verdict) else { return reply(400, ["error": "verdict must be approve or reject"]) }
        decided.append((id, verdict, digest))
        guard digest == proposals[index]["digest"] as? String else { return reply(409, ["error": "The digest does not match the frozen patch."]) }
        guard proposals[index]["state"] as? String == "pending" else { return reply(409, ["error": "This proposal was already decided."]) }
        if verdict == "approve" {
            if state_mode == .publishDisabled { return reply(409, ["error": "Publishing is not enabled on this server. The proposal stays pending.", "proposal": proposals[index]]) }
            proposals[index]["state"] = "published"; proposals[index]["branch"] = "keir-supervisor/\(id)"; proposals[index]["prUrl"] = "https://github.example.test/lakeside-ops/pull/1"
        } else { proposals[index]["state"] = "rejected" }
        revision += 1
        return reply(200, ["proposal": proposals[index]])
    }

    // MARK: State

    private func seed() {
        let jobId = nextId("j")
        _ = append(["role": "owner", "kind": "message", "text": "Fix the flaky test in apps/web/foo.test.js", "jobId": jobId, "clientId": "ios-seed-0001"])
        jobs.append(["id": jobId, "state": "done", "attempts": 1, "repo": "lakeside-ops", "workspace": "w_51c0000000000000", "changedFiles": ["apps/web/foo.js"], "createdAt": stamp(1), "finishedAt": stamp(2)])
        _ = append(["role": "supervisor", "kind": "answer", "text": "Found it: the test races the timer. I patched it and the file passes.", "jobId": jobId])
        _ = append(["role": "supervisor", "kind": "approval", "text": "I have a patch ready. Approve it below to publish a pull request.", "jobId": jobId, "proposalId": Self.proposalId])
        proposals.append(["id": Self.proposalId, "jobId": jobId, "repo": "lakeside-ops", "state": "pending", "title": "fix(web): stop the flaky timer race",
                          "files": ["apps/web/foo.js", "apps/web/foo.test.js"], "digest": Self.proposalDigest,
                          "tests": "node --test apps/web/foo.test.js: pass 4, fail 0", "createdAt": stamp(3)])
        revision += 1
    }

    @discardableResult
    private func append(_ fields: [String: Any]) -> [String: Any] {
        lastSeq += 1
        var row = fields
        row["seq"] = lastSeq; row["id"] = String(format: "m_%016x", lastSeq); row["at"] = stamp(lastSeq)
        messages.append(row); revision += 1
        return row
    }

    private func nextId(_ prefix: String) -> String { counter += 1; return String(format: "\(prefix)_%016x", counter) }

    private func stamp(_ offset: Int) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: 1_795_000_000 + Double(offset)))
    }

    private func reply(_ status: Int, _ body: [String: Any]) -> (status: Int, data: Data) {
        (status, (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8))
    }

    /// URLSession hands the body over as a stream.
    static func body(of request: URLRequest) -> [String: Any]? {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
#endif
