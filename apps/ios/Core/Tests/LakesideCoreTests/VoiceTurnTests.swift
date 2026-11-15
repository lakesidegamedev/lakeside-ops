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
