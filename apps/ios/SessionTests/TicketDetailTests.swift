import XCTest
import LakesideCore
@testable import LakesideOps

final class TicketDetailTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testRunningOnlyForFreshRunningWorker() {
        let fresh = JSONValue.number((now.timeIntervalSince1970 - 60) * 1000)
        XCTAssertEqual(TicketPresentation.status(raw: "running", updatedAt: fresh, now: now).label, "Running")
        let old = JSONValue.number((now.timeIntervalSince1970 - 3600) * 1000)
        XCTAssertEqual(TicketPresentation.status(raw: "running", updatedAt: old, now: now).label, "Stalled")
    }

    func testAbortedBlockedAndOverdueAreNeverRunning() {
        XCTAssertEqual(TicketPresentation.status(raw: "aborted", now: now).status, .failed)
        XCTAssertEqual(TicketPresentation.status(raw: "running", ownerDecision: true, now: now).label, "Waiting on you")
        XCTAssertEqual(TicketPresentation.status(raw: "running", blocked: true, now: now).label, "Blocked")
        let overdue = JSONValue.object(["overdue": .bool(true)])
        XCTAssertEqual(TicketPresentation.status(raw: "running", timing: overdue, now: now).label, "Overdue")
        XCTAssertEqual(TicketPresentation.status(raw: "", now: now).status, .idle)
    }

    func testSchedulerVocabularyIsRemoved() {
        XCTAssertEqual(TicketPresentation.clean("One more activation is queued"), "")
        XCTAssertEqual(TicketPresentation.clean("Wait review in 5m"), "")
        XCTAssertEqual(TicketPresentation.clean("Keir has not recorded its next action."), "")
        XCTAssertEqual(TicketPresentation.clean("Reading the payroll code"), "Reading the payroll code")
    }

    func testErrorIsOneSentenceCaseSentence() {
        XCTAssertEqual(TicketPresentation.errorSentence("worker aborted by supervisor. Retry later"), "Worker aborted by supervisor.")
    }
}
