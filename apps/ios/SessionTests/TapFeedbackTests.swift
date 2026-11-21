import XCTest
import LakesideCore
@testable import LakesideOps

/// The tap paths for approve, choose and send. The fixture transport is
/// slowed (and made to fail) so the in-between state is really exercised:
/// the in-progress state exists before the network answers, the confirmed
/// state only after it, a failure rolls back with a reason, a retry reuses
/// the same request key, and a double tap sends once.
@MainActor final class TapFeedbackTests: XCTestCase {
    /// A fixture decision whose answer does not change shared fixture state.
    private let decisionId = "abcdef123456"
    private var decisionPath: String { "/api/keir/app/decisions/\(decisionId)" }

    private func session() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return AppSession(.ops, configuration: config)
    }
    private func store() -> OpsStore {
        let ops = OpsStore()
        ops.decisions = [.object(["id": .string(decisionId), "question": .string("Ship fix #201 to the test server?")])]
        return ops
    }
    private func supportKeir(_ session: AppSession) async -> KeirStore {
        let keir = KeirStore()
        session.profile = .object(["email": .string("agent@example.test"), "ownerSupervisor": .bool(false)])
        await keir.ensureHome(session)
        return keir
    }
    private func eventually(_ timeout: TimeInterval = 3, _ check: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if check() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return check()
    }
    private func posts(_ path: String) -> [[String: Any]] {
        FixtureProtocol.actions.posts.filter { $0.path == path }.map { $0.body }
    }

    // MARK: Decisions

    func testApproveIsInFlightBeforeTheServerAnswersAndConfirmedOnlyAfter() async {
        FixtureProtocol.actions.set(delay: 0.8)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), ops = store()
        let request = Task { await ops.answer(decisionId, verdict: "approve", session) }
        let inFlight = await eventually { ops.answering[decisionId] != nil }
        XCTAssertTrue(inFlight, "the in-progress state exists while the request is outstanding")
        XCTAssertEqual(ops.answering[decisionId]?.verdict, "approve")
        XCTAssertNil(ops.answering[decisionId]?.failure)
        XCTAssertEqual(ops.decisions.count, 1, "nothing reads as approved before the server confirms")
        XCTAssertEqual(OpsStore.progressWord("approve"), "Approving")
        let confirmed = await request.value
        XCTAssertTrue(confirmed)
        XCTAssertNil(ops.answering[decisionId])
        XCTAssertTrue(ops.decisions.isEmpty, "the confirmed answer removes the decision")
    }

    func testAFailedApprovalRollsBackWithAReasonAndTheRetryReusesItsKey() async {
        FixtureProtocol.actions.set(delay: 0.1, failures: 1)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), ops = store()
        let first = await ops.answer(decisionId, verdict: "approve", session)
        XCTAssertFalse(first)
        XCTAssertEqual(ops.decisions.count, 1, "the decision is back, unanswered")
        let failure = ops.answering[decisionId]?.failure ?? ""
        XCTAssertFalse(failure.isEmpty, "the card says why")
        let retried = await ops.answer(decisionId, verdict: "approve", session)
        XCTAssertTrue(retried)
        XCTAssertNil(ops.answering[decisionId])
        let keys = posts(decisionPath).compactMap { $0["requestId"] as? String }
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(Set(keys).count, 1, "a retry after a failure is the same request")
    }

    func testADoubleTapOnApproveSendsOnce() async {
        FixtureProtocol.actions.set(delay: 0.5)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), ops = store()
        async let first = ops.answer(decisionId, verdict: "approve", session)
        async let second = ops.answer(decisionId, verdict: "approve", session)
        let results = await [first, second]
        XCTAssertEqual(results.filter { $0 }.count, 1)
        XCTAssertEqual(posts(decisionPath).count, 1, "only one approval reached the server")
    }

    func testAChoiceShowsSavingUntilTheServerAnswers() async {
        FixtureProtocol.actions.set(delay: 0.6)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), ops = store()
        let request = Task { await ops.answer(decisionId, verdict: "choose:2", session) }
        let inFlight = await eventually { ops.answering[decisionId]?.verdict == "choose:2" }
        XCTAssertTrue(inFlight)
        XCTAssertEqual(OpsStore.progressWord("choose:2"), "Saving your choice")
        _ = await request.value
        XCTAssertNil(ops.answering[decisionId])
    }

    // MARK: Messages

    func testASentMessageAppearsAtOnceAsSendingAndBecomesTheServersMessage() async {
        FixtureProtocol.actions.set(delay: 0.8)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), keir = await supportKeir(session)
        XCTAssertTrue(keir.homeResolved)
        let before = keir.messages.count
        guard let item = keir.beginSend("Is the build green?", session) else { return XCTFail("the message may be sent") }
        // Same frame as the tap: in the conversation, not yet confirmed.
        XCTAssertEqual(keir.outgoing.map(\.text), ["Is the build green?"])
        XCTAssertNil(keir.outgoing.first?.failure)
        XCTAssertEqual(keir.messages.count, before)
        let delivery = Task { await keir.deliver(item, session) }
        let reached = await eventually { !posts("/api/keir/app/messages").isEmpty }
        XCTAssertTrue(reached)
        XCTAssertEqual(keir.outgoing.count, 1, "still Sending while the server has not answered")
        let delivered = await delivery.value
        XCTAssertTrue(delivered)
        XCTAssertTrue(keir.outgoing.isEmpty, "the server's message replaced the Sending one")
        XCTAssertEqual(keir.messages.last?["role"].string, "owner")
        XCTAssertFalse(keir.sending)
    }

    func testAFailedSendStaysWithItsReasonAndTheRetryReusesItsClientId() async {
        FixtureProtocol.actions.set(delay: 0.1, failures: 1)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), keir = await supportKeir(session)
        let sent = await keir.send("Retry this one", session)
        XCTAssertFalse(sent)
        XCTAssertEqual(keir.outgoing.count, 1)
        XCTAssertNotNil(keir.outgoing.first?.failure, "the failed message says why")
        XCTAssertNotNil(keir.error)
        let id = keir.outgoing[0].id
        let again = await keir.retryOutgoing(id, session)
        XCTAssertTrue(again)
        XCTAssertTrue(keir.outgoing.isEmpty)
        let ids = posts("/api/keir/app/messages").compactMap { $0["clientId"] as? String }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(Set(ids).count, 1, "the retry carries the same send id, so it cannot post twice")
    }

    func testADoubleTapOnSendSendsOnce() async {
        FixtureProtocol.actions.set(delay: 0.4)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), keir = await supportKeir(session)
        let first = keir.beginSend("Only once", session)
        let second = keir.beginSend("Only once", session)
        XCTAssertNotNil(first)
        XCTAssertNil(second, "a second tap while sending is refused")
        if let first { _ = await keir.deliver(first, session) }
        XCTAssertEqual(posts("/api/keir/app/messages").count, 1)
        XCTAssertEqual(keir.outgoing.count, 0)
    }

    func testAnEditedFailedMessageLeavesTheConversation() async {
        FixtureProtocol.actions.set(delay: 0, failures: 1)
        defer { FixtureProtocol.actions.reset() }
        let session = session(), keir = await supportKeir(session)
        _ = await keir.send("Fix the typo", session)
        let id = keir.outgoing.first?.id ?? ""
        XCTAssertEqual(keir.discardOutgoing(id), "Fix the typo")
        XCTAssertTrue(keir.outgoing.isEmpty)
    }

    func testWhileDisconnectedNothingIsDrawnBeforeTheServerConfirms() async {
        let session = session(), keir = await supportKeir(session)
        guard let item = keir.beginSend("Offline draft", optimistic: false, session) else { return XCTFail("the message may be sent") }
        XCTAssertTrue(keir.outgoing.isEmpty, "no Sending bubble when the outcome is not near certain")
        _ = await keir.deliver(item, session)
        FixtureProtocol.actions.reset()
    }

    // MARK: Cached formatting

    func testCachedDateParsingAndScrubbingKeepTheirResults() {
        XCTAssertEqual(OpsFormat.date(.string("2026-11-21T10:00:00Z"))?.timeIntervalSince1970, 1_795_255_200)
        XCTAssertEqual(OpsFormat.date(.string("2026-11-21T10:00:00.500Z"))?.timeIntervalSince1970, 1_795_255_200.5)
        XCTAssertNil(OpsFormat.date(.string("")))
        let raw = "Ticket #12: Ticket #12   stuck in processing: started. Payroll is wrong"
        let first = OpsText.scrub(raw)
        XCTAssertEqual(OpsText.scrub(raw), first)
        XCTAssertFalse(first.contains("  "))
    }
}
