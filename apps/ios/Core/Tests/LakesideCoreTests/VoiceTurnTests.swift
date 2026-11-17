import XCTest
@testable import LakesideCore

final class VoiceTurnTests: XCTestCase {
    func testFindsReplyBeforeUnrelatedProgressInSameBatch() throws {
        let messages = try JSONValue.parse(#"[{"id":"voice","role":"keir","jobId":"a","text":"Hello"},{"id":"update","role":"keir","jobId":"b","text":"Another task"}]"#).array
        XCTAssertEqual(VoiceTurn.reply(in: messages, jobID: "a")?["id"].string, "voice")
        XCTAssertNil(VoiceTurn.reply(in: messages, jobID: "missing"))
    }
    func testBlockedAndApprovalStatesOfferRecovery() throws {
        let tasks = try JSONValue.parse(#"[{"id":"a","state":"blocked","summary":"Provider unavailable"},{"id":"b","state":"waiting","approvals":[{"id":"d"}]}]"#).array
        XCTAssertEqual(VoiceTurn.blocker(in: tasks, jobID: "a"), "Provider unavailable")
        XCTAssertNotNil(VoiceTurn.blocker(in: tasks, jobID: "b"))
        XCTAssertNil(VoiceTurn.blocker(in: tasks, jobID: "other"))
    }
}

@MainActor final class VoiceRequestTests: XCTestCase {
    func testHangupBeforeReceiptCancelsExactlyTheAcceptedJob() {
        var stopped: [String] = []
        let request = VoiceRequest { stopped.append($0) }
        request.cancel()
        XCTAssertTrue(stopped.isEmpty)
        request.accept("old-call")
        request.cancel(); request.accept("other-call")
        XCTAssertEqual(stopped, ["old-call"])
    }
    func testInterruptAfterReceiptDoesNotCancelTheNextCall() {
        var stopped: [String] = []
        let old = VoiceRequest { stopped.append($0) }
        let next = VoiceRequest { stopped.append($0) }
        old.accept("old-call"); next.accept("next-call")
        old.cancel(); old.cancel()
        XCTAssertEqual(stopped, ["old-call"])
        XCTAssertFalse(next.cancelled)
    }
    func testOpeningTheTaskCanKeepTheAcceptedRequestRunning() {
        var stopped: [String] = []
        let request = VoiceRequest { stopped.append($0) }
        request.accept("continuing-call")
        XCTAssertEqual(request.jobID, "continuing-call")
        XCTAssertTrue(stopped.isEmpty)
    }
}
