import XCTest
@testable import LakesideCore

final class ConversationActionTests: XCTestCase {
    // MARK: grammar, positive

    func testTakeOverPhrasings() {
        XCTAssertEqual(ConversationIntentParser.parse("take over ticket #123"), .take(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("Take over ticket 123."), .take(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("Keir, please take over #4821"), .take(ticket: 4821, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("can you take over ticket 123?"), .take(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("take over ticket 123 and tell the worker to check the ledger first"), .take(ticket: 123, text: "check the ledger first"))
        XCTAssertEqual(ConversationIntentParser.parse("take over ticket 123: check the ledger"), .take(ticket: 123, text: "check the ledger"))
    }

    func testHandBackPhrasings() {
        XCTAssertEqual(ConversationIntentParser.parse("hand ticket 123 back"), .handback(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("Hand ticket #123 back to Support Keir"), .handback(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("hand back ticket 123"), .handback(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("give #55 back to support: player confirmed fixed"), .handback(ticket: 55, text: "player confirmed fixed"))
        XCTAssertEqual(ConversationIntentParser.parse("return ticket 9 to the support desk"), .handback(ticket: 9, text: ""))
    }

    func testMessageTheWorkerPhrasings() {
        XCTAssertEqual(ConversationIntentParser.parse("message the worker on #123: the export is in the shared drive"), .message(ticket: 123, text: "the export is in the shared drive"))
        XCTAssertEqual(ConversationIntentParser.parse("Message the worker on ticket 123 to check the ledger again"), .message(ticket: 123, text: "check the ledger again"))
        XCTAssertEqual(ConversationIntentParser.parse("tell the worker on ticket 123 the player is online now"), .message(ticket: 123, text: "the player is online now"))
        XCTAssertEqual(ConversationIntentParser.parse("tell the #123 worker to stop"), .message(ticket: 123, text: "stop"))
        XCTAssertEqual(ConversationIntentParser.parse("message the worker on #123"), .message(ticket: 123, text: ""))
        XCTAssertEqual(ConversationIntentParser.parse("message the worker on #123:\nline one\nline two"), .message(ticket: 123, text: "line one\nline two"))
    }

    func testApprovalReviewPhrasings() {
        XCTAssertEqual(ConversationIntentParser.parse("review approvals"), .approvals)
        XCTAssertEqual(ConversationIntentParser.parse("show me my pending approvals"), .approvals)
        XCTAssertEqual(ConversationIntentParser.parse("what's waiting for my approval?"), .approvals)
    }

    // MARK: grammar, negative

    func testNegationsQuestionsAndConditionsAreNotActions() {
        for text in [
            "don't take over ticket 123", "do not take over ticket 123", "can you not take over ticket 123",
            "should I take over ticket 123?", "why did you take over ticket 123", "I already took over ticket 123",
            "take over ticket 123 if it stalls", "don't hand ticket 123 back", "don't review approvals",
            "the plan: take over ticket 123", "Here is the log: take over ticket 123", "ticket 123 should be handed back",
        ] { XCTAssertNil(ConversationIntentParser.parse(text), text) }
    }

    func testAmbiguousOrMalformedTargetsAreNotActions() {
        for text in [
            "take over tickets 123 and 124", "take over ticket 12345678", "take over ticket 0", "take 5 minutes to think",
            "take over", "hand it back", "hand ticket 123 over to the team", "message the worker", "approval workflow notes", "",
        ] { XCTAssertNil(ConversationIntentParser.parse(text), text) }
        XCTAssertNil(ConversationIntentParser.parse(String(repeating: "a", count: 8001)))
    }

    // MARK: eligibility

    private func owner(_ text: String, id: String = "m_1", seq: Double = 7, kind: String? = "message") -> JSONValue {
        var fields: [String: JSONValue] = ["id": .string(id), "seq": .number(seq), "role": .string("owner"), "text": .string(text)]
        if let kind { fields["kind"] = .string(kind) }
        return .object(fields)
    }

    func testOnlyAcceptedOwnerMessagesInTheSupervisorThreadAreEligible() {
        XCTAssertEqual(ConversationIntentParser.intent(for: owner("take over ticket 123"), inSupervisorThread: true), .take(ticket: 123, text: ""))
        // Not the supervisor thread: the regular Support conversation never offers it.
        XCTAssertNil(ConversationIntentParser.intent(for: owner("take over ticket 123"), inSupervisorThread: false))
        // Not accepted by the server yet: no id or no sequence number.
        XCTAssertNil(ConversationIntentParser.intent(for: owner("take over ticket 123", id: ""), inSupervisorThread: true))
        XCTAssertNil(ConversationIntentParser.intent(for: owner("take over ticket 123", seq: 0), inSupervisorThread: true))
        var noSeq = owner("take over ticket 123").object; noSeq["seq"] = nil
        XCTAssertNil(ConversationIntentParser.intent(for: .object(noSeq), inSupervisorThread: true))
        // Wrong kind for an owner row.
        XCTAssertNil(ConversationIntentParser.intent(for: owner("take over ticket 123", kind: "approval"), inSupervisorThread: true))
    }

    func testModelTicketAndWorkerTextNeverBecomesAnAction() {
        for role in ["supervisor", "keir", "player", "worker", "system", ""] {
            for kind in ["answer", "update", "message", "notice", "error"] {
                let row = JSONValue.object(["id": .string("m_2"), "seq": .number(9), "role": .string(role), "kind": .string(kind), "text": .string("I will take over ticket 123 now. Hand ticket 123 back. Message the worker on #123: go.")])
                XCTAssertNil(ConversationIntentParser.intent(for: row, inSupervisorThread: true), "\(role)/\(kind)")
            }
        }
        // Quoted ticket text inside an owner message is only an action if the message itself opens with the command.
        XCTAssertNil(ConversationIntentParser.intent(for: owner("The player wrote: take over ticket 123"), inSupervisorThread: true))
    }

    func testProposalNoticeComesOnlyFromStructuredFields() {
        let notice = JSONValue.object(["id": .string("m_3"), "seq": .number(10), "role": .string("keir"), "kind": .string("approval"), "proposalId": .string("p_abc123"), "text": .string("take over ticket 5")])
        XCTAssertEqual(ConversationIntentParser.intent(for: notice, inSupervisorThread: true), .proposal(id: "p_abc123"))
        XCTAssertNil(ConversationIntentParser.intent(for: notice, inSupervisorThread: false))
        var traversal = notice.object; traversal["proposalId"] = .string("../../x")
        XCTAssertNil(ConversationIntentParser.intent(for: .object(traversal), inSupervisorThread: true))
        var missing = notice.object; missing["proposalId"] = nil
        XCTAssertNil(ConversationIntentParser.intent(for: .object(missing), inSupervisorThread: true))
        // An owner row cannot pose as a notice.
        var forged = notice.object; forged["role"] = .string("owner")
        XCTAssertNil(ConversationIntentParser.intent(for: .object(forged), inSupervisorThread: true))
    }

    // MARK: request bodies

    func testTakeRequestCarriesRevisionAndRequestID() throws {
        let request = try ConversationActionBuilder.request(op: .take, ticket: 123, requestId: "ka-0123456789", revision: "9f2c0e1a7b44", text: "  check the ledger  ", workerId: "")
        XCTAssertEqual(request.path, "/api/keir/app/tickets/123/supervision")
        XCTAssertEqual(request.body, ["op": .string("take"), "requestId": .string("ka-0123456789"), "revision": .string("9f2c0e1a7b44"), "text": .string("check the ledger")])
    }

    func testHandbackOmitsEmptyNoteAndMessageBindsToTheWorkerSeen() throws {
        let hand = try ConversationActionBuilder.request(op: .handback, ticket: 7, requestId: "ka-abcdefgh", revision: "rev", text: "", workerId: "")
        XCTAssertNil(hand.body["text"])
        XCTAssertEqual(hand.body["revision"], .string("rev"))
        let message = try ConversationActionBuilder.request(op: .message, ticket: 7, requestId: "ka-abcdefgh", revision: "", text: "hello", workerId: "0123456789ab")
        XCTAssertEqual(message.body["workerId"], .string("0123456789ab"))
        XCTAssertNil(message.body["revision"])
    }

    func testInvalidRequestsAreRefusedBeforeTheyLeaveTheDevice() {
        XCTAssertThrowsError(try ConversationActionBuilder.request(op: .take, ticket: 1, requestId: "ka-abcdefgh", revision: "", text: "", workerId: ""))
        XCTAssertThrowsError(try ConversationActionBuilder.request(op: .message, ticket: 1, requestId: "ka-abcdefgh", revision: "", text: "   ", workerId: "w"))
        XCTAssertThrowsError(try ConversationActionBuilder.request(op: .message, ticket: 1, requestId: "ka-abcdefgh", revision: "", text: String(repeating: "x", count: 4001), workerId: "w"))
        XCTAssertThrowsError(try ConversationActionBuilder.request(op: .take, ticket: 1, requestId: "short", revision: "r", text: "", workerId: ""))
        XCTAssertThrowsError(try ConversationActionBuilder.request(op: .take, ticket: 1, requestId: "bad id with spaces", revision: "r", text: "", workerId: ""))
        XCTAssertThrowsError(try ConversationActionBuilder.request(op: .take, ticket: 0, requestId: "ka-abcdefgh", revision: "r", text: "", workerId: ""))
        XCTAssertTrue(ConversationActionBuilder.validRequestID(ConversationActionBuilder.requestID()))
    }

    func testProposalDecisionRequiresTheExactDigest() throws {
        let digest = String(repeating: "ab", count: 32)
        let request = try ConversationActionBuilder.proposalVerdict(id: "p_1", approve: true, digest: digest)
        XCTAssertEqual(request.path, "/api/keir/supervisor/proposals/p_1")
        XCTAssertEqual(request.body, ["verdict": .string("approve"), "digest": .string(digest)])
        XCTAssertThrowsError(try ConversationActionBuilder.proposalVerdict(id: "p_1", approve: true, digest: "abc"))
        XCTAssertThrowsError(try ConversationActionBuilder.proposalVerdict(id: "p_1", approve: true, digest: String(repeating: "z", count: 64)))
        XCTAssertThrowsError(try ConversationActionBuilder.proposalVerdict(id: "../other", approve: false, digest: digest))
    }

    // MARK: what the live ticket allows

    private func view(_ json: String) throws -> JSONValue { try JSONValue.parse(json) }

    func testPlanFollowsTheServerFlagsAndNamesBlockers() throws {
        let blocked = try view(#"{"ticket":1858,"state":"support","canTake":false,"takeBlockers":[{"code":"staff-claim","text":"Staff claimed this ticket"}]}"#)
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .take, view: blocked, ticket: 1858), .unavailable("Staff claimed this ticket"))
        let open = try view(#"{"ticket":1858,"state":"support","canTake":true}"#)
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .take, view: open, ticket: 1858), .ready(workerId: ""))
        // A reply for another ticket is never trusted.
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .take, view: open, ticket: 1859), .unavailable("The server answered for a different ticket, so nothing was offered."))
        let supervised = try view(#"{"ticket":5,"state":"supervised","canTake":false,"canMessage":true,"canHandback":true,"worker":{"id":"0123456789ab"}}"#)
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .take, view: supervised, ticket: 5), .unavailable("A worker is already on this ticket."))
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .message, view: supervised, ticket: 5), .ready(workerId: "0123456789ab"))
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .handback, view: supervised, ticket: 5), .ready(workerId: ""))
        let idle = try view(#"{"ticket":5,"state":"support","canMessage":false,"canHandback":false,"worker":null}"#)
        if case .ready = ConversationActionPlan.evaluate(op: .message, view: idle, ticket: 5) { XCTFail("no worker to message") }
        if case .ready = ConversationActionPlan.evaluate(op: .handback, view: idle, ticket: 5) { XCTFail("nothing to hand back") }
    }

    // MARK: outcomes prove what happened

    private let takeReply = #"{"ok":true,"op":"take","requestId":"ka-0123456789","duplicate":false,"receipt":{"takeoverId":"t1","ticket":123,"workerId":"0123456789ab","generation":2,"coordinatorTaskId":"c1","suppressedOutbox":2,"transferred":{"nextAction":"Reply with the ledger result","evidence":7,"uncertainEffects":1,"pendingApprovals":1},"at":1},"supervision":{"ticket":123,"state":"supervised","worker":{"id":"0123456789ab","identity":"keir-worker:0123456789ab","generation":2}}}"#

    func testTakeSuccessNamesTheCanonicalWorkerAndWhatMoved() throws {
        let outcome = try XCTUnwrap(ConversationActionOutcome.interpret(op: .take, ticket: 123, requestId: "ka-0123456789", response: JSONValue.parse(takeReply)))
        XCTAssertEqual(outcome.workerIdentity, "keir-worker:0123456789ab")
        XCTAssertEqual(outcome.headline, "Ticket #123 is now supervised by keir-worker:0123456789ab (takeover 2).")
        XCTAssertTrue(outcome.details.contains("Support Keir is stopped on this ticket."))
        XCTAssertTrue(outcome.details.contains("2 queued public replies from Support Keir were held back."))
        XCTAssertTrue(outcome.details.contains("1 approval still waiting for you. Nothing was approved."))
        XCTAssertTrue(outcome.details.contains("1 earlier action may or may not have run. It is listed, not repeated."))
        XCTAssertFalse(outcome.duplicate)
    }

    func testReplayIsReportedAsAlreadyDone() throws {
        let replay = takeReply.replacingOccurrences(of: #""duplicate":false"#, with: #""duplicate":true"#)
        let outcome = try XCTUnwrap(ConversationActionOutcome.interpret(op: .take, ticket: 123, requestId: "ka-0123456789", response: JSONValue.parse(replay)))
        XCTAssertTrue(outcome.duplicate)
        XCTAssertEqual(outcome.details.first, "This was already done earlier. Nothing ran a second time.")
    }

    func testReplyThatDoesNotProveTheActionIsNotReportedAsSuccess() throws {
        func interpret(_ json: String, op: ConversationOp = .take, ticket: Int = 123, id: String = "ka-0123456789") throws -> ConversationActionOutcome? {
            ConversationActionOutcome.interpret(op: op, ticket: ticket, requestId: id, response: try JSONValue.parse(json))
        }
        XCTAssertNil(try interpret(#"{"ok":true}"#))
        XCTAssertNil(try interpret(#"{}"#))
        XCTAssertNil(try interpret(takeReply.replacingOccurrences(of: #""ok":true"#, with: #""ok":false"#)))
        XCTAssertNil(try interpret(takeReply, ticket: 124))
        XCTAssertNil(try interpret(takeReply, id: "ka-someoneelse"))
        XCTAssertNil(try interpret(takeReply, op: .handback))
        XCTAssertNil(try interpret(takeReply.replacingOccurrences(of: #""state":"supervised""#, with: #""state":"support""#)))
        XCTAssertNil(try interpret(takeReply.replacingOccurrences(of: #""worker":{"id":"0123456789ab""#, with: #""worker":{"id":"ffffffffffff""#)))
        XCTAssertNil(try interpret(takeReply.replacingOccurrences(of: #","supervision":{"ticket":123,"state":"supervised","worker":{"id":"0123456789ab","identity":"keir-worker:0123456789ab","generation":2}}"#, with: "")))
    }

    func testHandbackAndMessageSuccess() throws {
        let hand = #"{"ok":true,"op":"handback","requestId":"ka-abcdefgh","duplicate":false,"receipt":{"takeoverId":"t1","ticket":8,"workerId":"0123456789ab","handoffId":"h1","coordinatorState":"active","suppressedOutbox":1,"returnedInbox":2,"at":1},"supervision":{"ticket":8,"state":"support","worker":null}}"#
        let done = try XCTUnwrap(ConversationActionOutcome.interpret(op: .handback, ticket: 8, requestId: "ka-abcdefgh", response: JSONValue.parse(hand)))
        XCTAssertEqual(done.headline, "Ticket #8 is back with Support Keir.")
        XCTAssertTrue(done.details.contains("keir-worker:0123456789ab is stopped and can no longer post or act."))
        XCTAssertTrue(done.details.contains("1 queued post from the worker was held back."))
        XCTAssertTrue(done.details.contains("2 unread directions returned to Support Keir."))
        // Still supervised after a "handback" reply means it did not work.
        XCTAssertNil(ConversationActionOutcome.interpret(op: .handback, ticket: 8, requestId: "ka-abcdefgh", response: try JSONValue.parse(hand.replacingOccurrences(of: #""state":"support""#, with: #""state":"supervised""#))))
        XCTAssertNil(ConversationActionOutcome.interpret(op: .handback, ticket: 8, requestId: "ka-abcdefgh", response: try JSONValue.parse(hand.replacingOccurrences(of: #""handoffId":"h1""#, with: #""handoffId":"""#))))

        let message = #"{"ok":true,"op":"message","requestId":"ka-msgmsgmsg","duplicate":false,"receipt":{"requestId":"ka-msgmsgmsg","ticket":8,"workerId":"0123456789ab","at":1,"workerState":"running"},"supervision":{"ticket":8,"state":"supervised","worker":{"id":"0123456789ab","identity":"keir-worker:0123456789ab"}}}"#
        let sent = try XCTUnwrap(ConversationActionOutcome.interpret(op: .message, ticket: 8, requestId: "ka-msgmsgmsg", response: JSONValue.parse(message)))
        XCTAssertEqual(sent.headline, "Your message is in the inbox of keir-worker:0123456789ab on ticket #8.")
        XCTAssertEqual(sent.details, ["Delivered to the worker, which is running. It has not necessarily read it yet."])
    }

    func testDroppedConnectionIsRecoveredFromTheServerRecordNotAssumed() throws {
        let took = try JSONValue.parse(#"{"ticket":123,"sessions":[{"takeoverId":"t1","workerId":"0123456789ab","requestIds":{"take":"ka-0123456789","handback":null}}]}"#)
        XCTAssertEqual(ConversationActionOutcome.recovered(op: .take, ticket: 123, requestId: "ka-0123456789", view: took)?.workerIdentity, "keir-worker:0123456789ab")
        XCTAssertTrue(ConversationActionOutcome.recovered(op: .take, ticket: 123, requestId: "ka-0123456789", view: took)?.recovered == true)
        XCTAssertNil(ConversationActionOutcome.recovered(op: .take, ticket: 123, requestId: "ka-other0000", view: took))
        XCTAssertNil(ConversationActionOutcome.recovered(op: .handback, ticket: 123, requestId: "ka-0123456789", view: took))
        XCTAssertNil(ConversationActionOutcome.recovered(op: .take, ticket: 124, requestId: "ka-0123456789", view: took))
        let directed = try JSONValue.parse(#"{"ticket":9,"directions":[{"requestId":"ka-msgmsgmsg","workerId":"0123456789ab","text":"x"}]}"#)
        XCTAssertNotNil(ConversationActionOutcome.recovered(op: .message, ticket: 9, requestId: "ka-msgmsgmsg", view: directed))
        XCTAssertNil(ConversationActionOutcome.recovered(op: .message, ticket: 9, requestId: "ka-nothing000", view: directed))
    }

    // MARK: failures

    func testFailureClassesDecideWhetherARetryKeepsItsRequestID() {
        XCTAssertEqual(ConversationActionFailure.classify(op: .take, statusCode: 409), .refused)
        XCTAssertEqual(ConversationActionFailure.classify(op: .message, statusCode: 400), .refused)
        XCTAssertEqual(ConversationActionFailure.classify(op: .take, statusCode: 503), .couldNotVerify)
        XCTAssertEqual(ConversationActionFailure.classify(op: .handback, statusCode: 503), .unknown)
        XCTAssertEqual(ConversationActionFailure.classify(op: .take, statusCode: 500), .unknown)
        XCTAssertEqual(ConversationActionFailure.classify(op: .take, statusCode: nil), .unknown)
        XCTAssertEqual(ConversationActionFailure.refused.explain(serverMessage: "The ticket moved. Refresh and try again."), "The ticket moved. Refresh and try again. Nothing was changed.")
        XCTAssertTrue(ConversationActionFailure.unknown.explain(serverMessage: "").contains("cannot run twice"))
    }

    // MARK: one message, one action

    func testLedgerReusesTheRequestIDUntilTheWordsChange() throws {
        var ledger = ConversationActionLedger()
        let key = ConversationActionLedger.key(scope: "s", messageID: "m_1", op: .message, ticket: 5)
        var counter = 0
        let make: () -> String = { counter += 1; return "ka-id-\(counter)00000" }
        let first = try XCTUnwrap(ledger.requestID(for: key, op: .message, ticket: 5, text: "check the ledger", now: 1, make: make))
        XCTAssertEqual(ledger.requestID(for: key, op: .message, ticket: 5, text: " check the ledger ", now: 2, make: make), first)
        let edited = try XCTUnwrap(ledger.requestID(for: key, op: .message, ticket: 5, text: "check the other ledger", now: 3, make: make))
        XCTAssertNotEqual(edited, first)
        XCTAssertEqual(counter, 2)
    }

    func testRefusedAttemptsForgetTheirIDAndFinishedMessagesNeverRunAgain() throws {
        var ledger = ConversationActionLedger()
        let key = ConversationActionLedger.key(scope: "s", messageID: "m_1", op: .take, ticket: 123)
        let id = try XCTUnwrap(ledger.requestID(for: key, op: .take, ticket: 123, text: "", now: 1))
        ledger.discardPending(key)
        XCTAssertNil(ledger.record(for: key))
        let second = try XCTUnwrap(ledger.requestID(for: key, op: .take, ticket: 123, text: "", now: 2))
        XCTAssertNotEqual(second, id)
        let outcome = try XCTUnwrap(ConversationActionOutcome.interpret(op: .take, ticket: 123, requestId: "ka-0123456789", response: JSONValue.parse(takeReply)))
        ledger.complete(key, outcome: outcome, now: 3)
        XCTAssertTrue(ledger.isDone(key))
        XCTAssertNil(ledger.requestID(for: key, op: .take, ticket: 123, text: "", now: 4))
        ledger.discardPending(key)   // a finished record is never discarded
        XCTAssertTrue(ledger.isDone(key))
    }

    func testLedgerSurvivesRelaunchWithoutStoringMessageText() throws {
        var ledger = ConversationActionLedger()
        let key = ConversationActionLedger.key(scope: "s", messageID: "m_1", op: .message, ticket: 5)
        _ = ledger.requestID(for: key, op: .message, ticket: 5, text: "secret words for the worker", now: 1)
        let data = try JSONEncoder().encode(ledger)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("secret words"))
        XCTAssertEqual(try JSONDecoder().decode(ConversationActionLedger.self, from: data), ledger)
    }

    func testLedgerIsBounded() {
        var ledger = ConversationActionLedger()
        for index in 0..<(ConversationActionLedger.limit + 25) {
            _ = ledger.requestID(for: "k\(index)", op: .take, ticket: 1, text: "", now: Double(index))
        }
        XCTAssertEqual(ledger.records.count, ConversationActionLedger.limit)
        XCTAssertNil(ledger.record(for: "k0"))
        XCTAssertNotNil(ledger.record(for: "k\(ConversationActionLedger.limit + 24)"))
    }
}
