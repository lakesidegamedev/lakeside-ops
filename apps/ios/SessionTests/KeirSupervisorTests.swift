import XCTest
import LakesideCore
@testable import LakesideOps

/// The server the support operator normally provides is offline here: every
/// /api/keir/app/* call fails and is recorded. Only the supervisor fixture and
/// the profile answer, so anything that quietly depended on the operator, or
/// sent an owner's message to Support Keir, shows up as a recorded hit.
final class OperatorOfflineProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var operatorHits: [String] = []
    private static var profileBody: [String: Any]?
    static var fixture = KeirSupervisorFixture()

    static func reset(profile: [String: Any]?) {
        lock.lock(); defer { lock.unlock() }
        fixture = KeirSupervisorFixture(); operatorHits = []; profileBody = profile
    }
    static func setProfile(_ profile: [String: Any]?) { lock.lock(); defer { lock.unlock() }; profileBody = profile }
    static var operatorRequests: [String] { lock.lock(); defer { lock.unlock() }; return operatorHits }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        var status = 404
        var data = Data(#"{"error":"not found"}"#.utf8)
        if url.path.hasPrefix(KeirSupervisor.base + "/") {
            (status, data) = Self.fixture.handle(request)
        } else if url.path == "/api/me" {
            Self.lock.lock(); let profile = Self.profileBody; Self.lock.unlock()
            if let profile { status = 200; data = (try? JSONSerialization.data(withJSONObject: profile)) ?? data }
            else { status = 503; data = Data(#"{"error":"profile unavailable"}"#.utf8) }
        } else if url.path.hasPrefix("/api/keir/app/") {
            Self.lock.lock(); Self.operatorHits.append("\(request.httpMethod ?? "GET") \(url.path)"); Self.lock.unlock()
            status = 502; data = Data(#"{"error":"Keir backend is unavailable"}"#.utf8)
        }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Native readiness of the private owner supervisor on the iPhone: connect,
/// send, answer and reopen with the support operator offline; proposals the
/// owner can read and decide with one tap bound to the exact patch; and an
/// owner's message never reaching Support Keir while the account is unknown.
@MainActor final class KeirSupervisorTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!
    private var tasks: [Task<Void, Never>] = []
    private let owner: [String: Any] = ["email": "owner@example.test", "role": "admin", "ownerSupervisor": true]
    private var ownerScope: String { KeirResume.scope(profile: .object(["email": .string("owner@example.test")]), server: Surface.ops.base)! }
    private var otherScope: String { KeirResume.scope(profile: .object(["email": .string("someone@example.test")]), server: Surface.ops.base)! }
    private var fixture: KeirSupervisorFixture { OperatorOfflineProtocol.fixture }

    override func setUp() async throws {
        suite = "keir-supervisor-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        OperatorOfflineProtocol.reset(profile: owner)
    }
    override func tearDown() async throws {
        tasks.forEach { $0.cancel() }; tasks = []
        UserDefaults().removePersistentDomain(forName: suite)
    }

    // MARK: Helpers

    private func session(profile: JSONValue? = nil) -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OperatorOfflineProtocol.self]
        let session = AppSession(.ops, configuration: config)
        session.profile = profile ?? .object(["email": .string("owner@example.test"), "role": .string("admin"), "ownerSupervisor": .bool(true)])
        return session
    }
    private func store(scope: String?) -> KeirStore {
        let keir = KeirStore(resume: KeirResume(defaults: defaults))
        keir.bindAccount(scope)
        return keir
    }
    /// A store as the app leaves it once sign-in has finished: bound, resolved and reading.
    private func opened(_ session: AppSession, connect: Bool = true) async -> KeirStore {
        let keir = store(scope: ownerScope)
        await keir.ensureHome(session)
        if connect { tasks.append(Task { await keir.connect(session) }) }
        return keir
    }
    private func eventually(_ timeout: Double = 12, _ condition: @MainActor () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(40))
        }
        return condition()
    }
    private func withheld(_ destination: KeirSupervisor.Destination) -> Bool {
        if case .withheld = destination { return true }
        return false
    }

    // MARK: Independent connect, send, response and reopen

    func testConnectSendAnswerAndReopenWithTheSupportOperatorOffline() async {
        let session = session()
        let keir = await opened(session)
        XCTAssertTrue(keir.homeResolved)
        XCTAssertTrue(keir.isSupervisor, "an owner lands in the private conversation")
        let connected = await eventually { keir.connected }
        XCTAssertTrue(connected)
        XCTAssertTrue(keir.messages.isEmpty)

        let sent = await keir.send("  Fix the flaky test in apps/web/foo.test.js ", session)
        XCTAssertTrue(sent)
        XCTAssertEqual(keir.messages.first?["role"].string, "owner")
        XCTAssertEqual(keir.messages.first?["text"].string, "Fix the flaky test in apps/web/foo.test.js")

        // The answer comes through the long poll, not the send response.
        let answered = await eventually { keir.messages.contains { $0["kind"].string == "answer" } }
        XCTAssertTrue(answered)
        XCTAssertEqual(keir.messages.last?["role"].string, "keir", "the supervisor speaks as Keir in the shared timeline")
        XCTAssertGreaterThan(keir.messages.last?["at"].number ?? 0, 1_000_000_000_000, "timestamps become milliseconds for the time marks")
        XCTAssertFalse(keir.working)
        XCTAssertNil(keir.error)

        // Reopen: a brand new store with nothing local rebuilds from the server.
        tasks.forEach { $0.cancel() }; tasks = []
        let reopened = await opened(session)
        let restored = await eventually { reopened.messages.count == 2 }
        XCTAssertTrue(restored)
        XCTAssertEqual(reopened.messages.map { $0["text"].string }, keir.messages.map { $0["text"].string })
        XCTAssertEqual(reopened.messages.filter { $0["role"].string == "owner" }.count, 1, "reopening never re-sends")

        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, [], "nothing depended on the support operator")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.contains("/api/keir/supervisor/") })
        XCTAssertEqual(fixture.requests.filter { $0.hasPrefix("POST") }.count, 1)
    }

    func testAReplayedClientIdIsOneJobAndADifferentTextIsRefused() async throws {
        let session = session()
        let first = try await session.post("/api/keir/supervisor/messages", ["text": .string("hello"), "clientId": .string("ios-replay-0001")])
        let again = try await session.post("/api/keir/supervisor/messages", ["text": .string("hello"), "clientId": .string("ios-replay-0001")])
        XCTAssertFalse(first["duplicate"].bool)
        XCTAssertTrue(again["duplicate"].bool)
        XCTAssertEqual(first["message"]["id"], again["message"]["id"])
        XCTAssertEqual(first["job"]["id"], again["job"]["id"])
        do {
            _ = try await session.post("/api/keir/supervisor/messages", ["text": .string("something else"), "clientId": .string("ios-replay-0001")])
            XCTFail("the same clientId with different text must be refused")
        } catch { XCTAssertEqual((error as? AppFailure)?.statusCode, 409) }
    }

    func testARetriedSendReusesItsClientIdSoItCannotDuplicate() async {
        let session = session()
        let keir = await opened(session, connect: false)
        fixture.mode = .notOwner          // the write is refused once
        XCTAssertFalse(await keir.send("retry me", session))
        fixture.mode = .normal
        XCTAssertTrue(await keir.send("retry me", session))
        XCTAssertEqual(fixture.clientIds.count, 2)
        XCTAssertEqual(Set(fixture.clientIds).count, 1, "the retry carries the same clientId")
        XCTAssertTrue(fixture.clientIds[0].hasPrefix("ios-"))
        XCTAssertEqual(keir.messages.filter { $0["role"].string == "owner" }.count, 1)
    }

    func testCancellingARunningJobStopsItAndKeepsTheConversation() async {
        fixture.answersAutomatically = false
        let session = session()
        let keir = await opened(session)
        _ = await eventually { keir.connected }
        XCTAssertTrue(await keir.send("Look at the build", session))
        let running = await eventually { keir.supervisorLiveJob != nil }
        XCTAssertTrue(running)
        XCTAssertEqual(keir.live.count, 1)
        XCTAssertEqual(keir.supervisorLiveJob?["title"].string, "Working in lakeside-ops")
        await keir.cancelSupervisorJob(keir.supervisorLiveJob?["id"].string ?? "", session)
        let stopped = await eventually { keir.supervisorLiveJob == nil && keir.messages.contains { $0["kind"].string == "notice" } }
        XCTAssertTrue(stopped)
        XCTAssertTrue(keir.live.isEmpty, "a cancelled job is not live work")
        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, [])
    }

    func testOnlyAWellFormedJobIdIsEverPutInAPath() async {
        let session = session()
        let keir = await opened(session, connect: false)
        await keir.cancelSupervisorJob("../proposals/x", session)
        XCTAssertFalse(fixture.requests.contains { $0.contains("cancel") })
    }

    // MARK: Proposals

    func testAProposalShowsItsPatchAndAnApprovalSendsTheDisplayedDigestOnce() async {
        OperatorOfflineProtocol.fixture = KeirSupervisorFixture(seedProposal: true)
        let session = session()
        let keir = await opened(session)
        let loaded = await eventually { keir.supervisor.pending.count == 1 }
        XCTAssertTrue(loaded)
        XCTAssertTrue(keir.messages.contains { $0["kind"].string == "approval" && $0["proposalId"].string == KeirSupervisorFixture.proposalId })

        let proposal = keir.supervisor.pending[0]
        XCTAssertEqual(proposal.title, "fix(web): stop the flaky timer race")
        XCTAssertEqual(proposal.summary, "2 files in lakeside-ops")
        XCTAssertEqual(proposal.files, ["apps/web/foo.js", "apps/web/foo.test.js"])
        XCTAssertEqual(proposal.tests, "node --test apps/web/foo.test.js: pass 4, fail 0")
        XCTAssertEqual(proposal.digestPrefix, String(KeirSupervisorFixture.proposalDigest.prefix(12)))
        XCTAssertTrue(proposal.canDecide)

        let approved = await keir.decide(proposal, approve: true, session)
        XCTAssertTrue(approved)
        XCTAssertEqual(fixture.decisions.map { $0.verdict }, ["approve"])
        XCTAssertEqual(fixture.decisions.map { $0.digest }, [KeirSupervisorFixture.proposalDigest], "the displayed digest is sent verbatim")
        XCTAssertTrue(keir.supervisor.pending.isEmpty)
        XCTAssertEqual(keir.supervisor.decided.first?.state, "published")
        XCTAssertEqual(keir.supervisor.decided.first?.prURL?.host, "github.example.test")

        // A second tap on the same, now decided, proposal sends nothing.
        let again = await keir.decide(proposal, approve: true, session)
        XCTAssertFalse(again)
        XCTAssertEqual(fixture.decisions.count, 1)
        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, [])
    }

    func testAProposalThatChangedSinceItWasShownIsNeverApproved() async {
        OperatorOfflineProtocol.fixture = KeirSupervisorFixture(seedProposal: true)
        let session = session()
        let keir = await opened(session)
        _ = await eventually { keir.supervisor.pending.count == 1 }
        let stale = KeirProposal(.object(["id": .string(KeirSupervisorFixture.proposalId), "state": .string("pending"),
                                          "digest": .string(String(repeating: "cd34", count: 16)), "title": .string("old patch")]))!
        let ok = await keir.decide(stale, approve: true, session)
        XCTAssertFalse(ok)
        XCTAssertTrue(fixture.decisions.isEmpty, "nothing was sent for a digest that is not the one on screen")
        XCTAssertNotNil(keir.supervisor.decisionNotes[KeirSupervisorFixture.proposalId])
        XCTAssertEqual(keir.supervisor.pending.count, 1)
    }

    func testTypingYesInTheChatNeverApprovesAnything() async {
        OperatorOfflineProtocol.fixture = KeirSupervisorFixture(seedProposal: true)
        let session = session()
        let keir = await opened(session)
        _ = await eventually { keir.supervisor.pending.count == 1 }
        XCTAssertTrue(await keir.send("yes, go ahead and approve it", session))
        XCTAssertTrue(fixture.decisions.isEmpty)
        XCTAssertFalse(fixture.requests.contains { $0.hasPrefix("POST /api/keir/supervisor/proposals/") })
        XCTAssertEqual(keir.supervisor.pending.count, 1)
    }

    func testWhenPublishingIsOffApproveFailsHonestlyAndDeclineStillWorks() async {
        let seeded = KeirSupervisorFixture(seedProposal: true)
        seeded.mode = .publishDisabled
        OperatorOfflineProtocol.fixture = seeded
        let session = session()
        let keir = await opened(session)
        _ = await eventually { keir.supervisor.pending.count == 1 }
        let proposal = keir.supervisor.pending[0]
        let approved = await keir.decide(proposal, approve: true, session)
        XCTAssertFalse(approved)
        XCTAssertTrue(keir.supervisor.decisionNotes[proposal.id]?.contains("Publishing is not enabled") ?? false)
        XCTAssertEqual(keir.supervisor.pending.count, 1, "the proposal stays pending")
        let declined = await keir.decide(proposal, approve: false, session)
        XCTAssertTrue(declined)
        XCTAssertEqual(keir.supervisor.decided.first?.state, "rejected")
    }

    func testProposalParsingRejectsBadIdsAndNonHttpsLinks() {
        XCTAssertNil(KeirProposal(.object(["id": .string("../x")])))
        XCTAssertNil(KeirProposal(.object(["id": .string("p_XYZ")])))
        let plain = KeirProposal(.object(["id": .string("p_0123456789abcdef"), "state": .string("published"), "digest": .string("short"), "prUrl": .string("http://example.test/pr/1")]))!
        XCTAssertNil(plain.prURL, "only https links are ever opened")
        XCTAssertFalse(plain.canDecide)
        let script = KeirProposal(.object(["id": .string("p_0123456789abcdef"), "prUrl": .string("javascript:alert(1)")]))!
        XCTAssertNil(script.prURL)
        XCTAssertTrue(KeirSupervisor.validDigest(KeirSupervisorFixture.proposalDigest))
        XCTAssertFalse(KeirSupervisor.validDigest(String(repeating: "AB12", count: 16)))
    }

    // MARK: The account, the profile and Support Keir

    func testNothingLeavesThePhoneBeforeTheAccountIsKnown() async {
        OperatorOfflineProtocol.setProfile(nil)                       // /api/me is failing
        let session = session(profile: .null)
        let keir = store(scope: nil)
        XCTAssertFalse(keir.homeResolved)
        XCTAssertEqual(keir.thread, "main", "main is a placeholder until the account is known")
        XCTAssertFalse(await keir.send("private note for Keir", session))
        XCTAssertNotNil(keir.error)

        await keir.ensureHome(session)
        XCTAssertFalse(keir.homeResolved, "an unreadable profile never defaults to Support Keir")
        XCTAssertFalse(await keir.send("private note for Keir", session))
        XCTAssertFalse(fixture.requests.contains { $0.hasPrefix("POST") })
        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, [], "and never reached Support Keir")

        OperatorOfflineProtocol.setProfile(owner)                    // the profile loads
        await keir.ensureHome(session)
        XCTAssertTrue(keir.homeResolved)
        XCTAssertTrue(keir.isSupervisor)
    }

    func testTypingBeforeTheProfileLoadsDoesNotPinAnOwnerOnSupportKeir() async {
        let keir = store(scope: ownerScope)
        keir.holdRestore()   // the old rule: a draft on "main" blocked the move to the private chat
        await keir.ensureHome(session())
        XCTAssertTrue(keir.isSupervisor)
    }

    func testSwitchingAccountDropsEverythingAndSendsNothing() async {
        let session = session()
        let keir = await opened(session)
        _ = await eventually { keir.connected }
        XCTAssertTrue(await keir.send("owner only", session))
        XCTAssertEqual(keir.messages.first?["text"].string, "owner only")
        tasks.forEach { $0.cancel() }; tasks = []

        keir.bindAccount(otherScope)
        XCTAssertFalse(keir.homeResolved)
        XCTAssertFalse(keir.supervisorAvailable)
        XCTAssertEqual(keir.thread, "main")
        XCTAssertTrue(keir.messages.isEmpty, "the previous account's messages are gone")
        XCTAssertTrue(keir.supervisor.proposals.isEmpty)

        let posts = fixture.requests.filter { $0.hasPrefix("POST") }.count
        XCTAssertFalse(await keir.send("meant for the owner's private chat", session))
        XCTAssertEqual(fixture.requests.filter { $0.hasPrefix("POST") }.count, posts)
        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, [], "not handed to Support Keir either")
    }

    func testAnAccountWithoutASupervisorUsesSupportKeirAndSendsThereOnly() async {
        let plain: JSONValue = .object(["email": .string("player@example.test"), "role": .string("user"), "ownerSupervisor": .bool(false)])
        let session = session(profile: plain)
        let keir = store(scope: otherScope)
        await keir.ensureHome(session)
        XCTAssertTrue(keir.homeResolved)
        XCTAssertFalse(keir.supervisorAvailable)
        XCTAssertEqual(keir.thread, "main")
        _ = await keir.send("hello support", session)      // the operator is down, so this fails, but it went to the right place
        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, ["POST /api/keir/app/messages"])
        XCTAssertFalse(fixture.requests.contains { $0.hasPrefix("POST") })
    }

    func testAnOwnerReachesSupportKeirOnlyByChoosingIt() async {
        let session = session()
        let keir = await opened(session, connect: false)
        keir.select("main")
        XCTAssertEqual(keir.thread, "main")
        _ = await keir.send("a ticket question", session)
        XCTAssertEqual(OperatorOfflineProtocol.operatorRequests, ["POST /api/keir/app/messages"])
    }

    func testWhoseConversationIsHome() {
        XCTAssertEqual(KeirSupervisor.home(profile: .null), .waitingForProfile)
        XCTAssertEqual(KeirSupervisor.home(profile: .object([:])), .waitingForProfile)
        XCTAssertEqual(KeirSupervisor.home(profile: .object(["ownerSupervisor": .bool(true)])), .supervisor)
        XCTAssertEqual(KeirSupervisor.home(profile: .object(["email": .string("a@b.test"), "ownerSupervisor": .bool(false)])), .support)
        XCTAssertEqual(KeirSupervisor.home(profile: .object(["email": .string("a@b.test"), "mode": .string("standalone")])), .support)
        XCTAssertEqual(KeirSupervisor.home(profile: .object(["email": .string("a@b.test")])), .probe)
    }

    func testTheDestinationRules() {
        let t = KeirSupervisor.thread
        XCTAssertTrue(withheld(KeirSupervisor.destination(thread: "main", supervisorAvailable: false, resolved: false, chosen: false)))
        XCTAssertTrue(withheld(KeirSupervisor.destination(thread: t, supervisorAvailable: true, resolved: false, chosen: false)))
        XCTAssertEqual(KeirSupervisor.destination(thread: t, supervisorAvailable: true, resolved: true, chosen: false), .supervisor)
        XCTAssertTrue(withheld(KeirSupervisor.destination(thread: t, supervisorAvailable: false, resolved: true, chosen: false)))
        XCTAssertTrue(withheld(KeirSupervisor.destination(thread: "main", supervisorAvailable: true, resolved: true, chosen: false)))
        XCTAssertEqual(KeirSupervisor.destination(thread: "main", supervisorAvailable: true, resolved: true, chosen: true), .support)
        XCTAssertEqual(KeirSupervisor.destination(thread: "main", supervisorAvailable: false, resolved: true, chosen: false), .support)
    }

    // MARK: Discovery when the profile does not say

    func testAProfileWithoutAFlagAsksTheSupervisorAndAnOwnerGetsIt() async {
        let session = session(profile: .object(["email": .string("owner@example.test"), "role": .string("admin")]))
        let keir = store(scope: ownerScope)
        await keir.ensureHome(session)
        XCTAssertTrue(keir.homeResolved)
        XCTAssertTrue(keir.isSupervisor)
        XCTAssertEqual(fixture.requests, ["GET /api/keir/supervisor/status"])
    }

    func testAnotherAdminIsRefusedByTheServerAndLandsOnSupportKeirInsteadOfWaiting() async {
        fixture.mode = .notOwner
        let session = session(profile: .object(["email": .string("admin@example.test"), "role": .string("admin")]))
        let keir = store(scope: otherScope)
        await keir.ensureHome(session)
        XCTAssertTrue(keir.homeResolved)
        XCTAssertFalse(keir.supervisorAvailable)
        XCTAssertEqual(keir.thread, "main")
    }

    func testAStandaloneInstallNeverAsksForASupervisor() async {
        let session = session(profile: .object(["email": .string("me@example.test"), "mode": .string("standalone")]))
        let keir = store(scope: otherScope)
        await keir.ensureHome(session)
        XCTAssertTrue(keir.homeResolved)
        XCTAssertTrue(fixture.requests.isEmpty)
    }

    func testTheProbeSettlesOnAClearAnswerAndRetriesOnAFault() {
        XCTAssertEqual(KeirSupervisor.probe(.success(.object(["configured": .bool(true)]))), .owner)
        XCTAssertEqual(KeirSupervisor.probe(.success(.object(["error": .string("No test fixture")]))), .notOwner)
        XCTAssertEqual(KeirSupervisor.probe(.failure(AppFailure(message: "", statusCode: 403))), .notOwner)
        XCTAssertEqual(KeirSupervisor.probe(.failure(AppFailure(message: "", statusCode: 404))), .notOwner)
        XCTAssertEqual(KeirSupervisor.probe(.failure(AppFailure(message: "page", kind: .unexpectedResponse))), .notOwner)
        XCTAssertEqual(KeirSupervisor.probe(.failure(AppFailure(message: "", statusCode: 503, payload: .object(["configured": .bool(false)])))), .owner,
                       "not set up is still the owner's server")
        XCTAssertEqual(KeirSupervisor.probe(.failure(AppFailure(message: "", statusCode: 503))), .inconclusive)
        XCTAssertEqual(KeirSupervisor.probe(.failure(AppFailure(message: "", statusCode: 502))), .inconclusive)
        XCTAssertEqual(KeirSupervisor.probe(.failure(URLError(.notConnectedToInternet))), .inconclusive)
    }

    // MARK: Honest states

    func testAServerWithoutASupervisorIsAStateNotAnOutage() async {
        fixture.mode = .notConfigured
        let session = session()
        let keir = await opened(session)
        let shown = await eventually { keir.supervisor.setup == .notConfigured }
        XCTAssertTrue(shown)
        XCTAssertTrue(keir.connected, "the server is reachable, so this is not 'reconnecting'")
        XCTAssertNil(keir.error)
        XCTAssertEqual(KeirSupervisor.Setup.notConfigured.message, "Private supervisor is not set up on this server")
        XCTAssertFalse(await keir.send("anyone there?", session))
        XCTAssertFalse(fixture.requests.contains { $0.hasPrefix("POST") }, "nothing is sent to a server that has no supervisor")
    }

    func testFailedAndCancelledJobsAreNotLiveWork() {
        for state in ["queued", "running"] { XCTAssertTrue(KeirSupervisor.isLive(.object(["state": .string(state)]))) }
        for state in ["done", "failed", "cancelled", "error", ""] { XCTAssertFalse(KeirSupervisor.isLive(.object(["state": .string(state)])), state) }
    }

    func testProgressLinesAreProvisionalSoAVoiceTurnWaitsForTheAnswer() {
        let update = KeirSupervisor.timelineRow(.object(["role": .string("supervisor"), "kind": .string("update"), "at": .string("2026-11-20T07:01:02.000Z"), "text": .string("Patching")]))
        XCTAssertEqual(update["role"].string, "keir")
        XCTAssertTrue(update["provisional"].bool)
        let answer = KeirSupervisor.timelineRow(.object(["role": .string("supervisor"), "kind": .string("answer"), "text": .string("Done")]))
        XCTAssertFalse(answer["provisional"].bool)
        XCTAssertEqual(KeirSupervisor.timelineRow(.object(["role": .string("owner"), "text": .string("hi")]))["role"].string, "owner")
    }

    func testTheExecutorLineSaysWhyJobsCannotRun() {
        var state = KeirSupervisorState()
        state.apply(.object(["executor": .object(["available": .bool(false), "reason": .string("runner binary not found")])]))
        XCTAssertEqual(state.executorNotice, "The supervisor cannot run jobs right now: runner binary not found")
        state.apply(.object(["executor": .object(["available": .bool(true), "reason": .null])]))
        XCTAssertNil(state.executorNotice)
    }
}
