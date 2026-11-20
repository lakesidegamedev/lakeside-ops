import XCTest
import LakesideCore
@testable import LakesideOps

final class WorkQueueTests: XCTestCase {
    func testWaitingAndUnassignedWorkCannotHideInFinishedHistory() {
        let waiting: JSONValue = .object(["title": .string("Coupon ledger"), "number": .number(1501), "timing": .object(["state": .string("waiting"), "overdue": .bool(false)])])
        let stuck: JSONValue = .object(["title": .string("Missing owner"), "timing": .object(["state": .string("unassigned"), "overdue": .bool(true)])])
        XCTAssertTrue(WorkQueuePresentation.matches(waiting, filter: "waiting", search: "1501", ticket: true))
        XCTAssertFalse(WorkQueuePresentation.matches(waiting, filter: "stuck", search: "", ticket: true))
        XCTAssertTrue(WorkQueuePresentation.matches(stuck, filter: "stuck", search: "", ticket: true))
        XCTAssertLessThan(WorkQueuePresentation.rank(stuck), WorkQueuePresentation.rank(waiting))
    }
    func testBlockedWorkIsNotAutomaticallyAnOwnerDecision() {
        let blocked: JSONValue = .object(["state": .string("blocked")])
        XCTAssertEqual(WorkQueuePresentation.state(blocked), "stuck")
        XCTAssertFalse(WorkQueuePresentation.matches(blocked, filter: "needs-you", search: "", ticket: false))
        let approval: JSONValue = .object(["decisionPending": .bool(true)])
        XCTAssertEqual(WorkQueuePresentation.state(approval), "needs-you")
    }
    func testDefaultInboxLeadsWithOwnerPingsAndAnyNarrowingLeadsWithTheQueue() {
        XCTAssertTrue(WorkQueuePresentation.leadsWithOwnerItems(scope: "tickets", filter: "all", search: ""))
        XCTAssertTrue(WorkQueuePresentation.leadsWithOwnerItems(scope: "tickets", filter: "all", search: "  "))
        for filter in ["working", "waiting", "stuck", "needs-you"] {
            XCTAssertFalse(WorkQueuePresentation.leadsWithOwnerItems(scope: "tickets", filter: filter, search: ""), filter)
        }
        XCTAssertFalse(WorkQueuePresentation.leadsWithOwnerItems(scope: "tasks", filter: "all", search: ""))
        XCTAssertFalse(WorkQueuePresentation.leadsWithOwnerItems(scope: "tickets", filter: "all", search: "1501"))
    }
    func testOwnerDecisionsShowOnTheDefaultViewAndDecisionsOnly() {
        XCTAssertTrue(WorkQueuePresentation.showsOwnerItems(scope: "tickets", filter: "all", search: ""))
        XCTAssertTrue(WorkQueuePresentation.showsOwnerItems(scope: "tickets", filter: "needs-you", search: ""))
        XCTAssertTrue(WorkQueuePresentation.showsOwnerItems(scope: "tasks", filter: "needs-you", search: ""))
        for filter in ["working", "waiting", "stuck"] {
            XCTAssertFalse(WorkQueuePresentation.showsOwnerItems(scope: "tickets", filter: filter, search: ""), filter)
        }
        XCTAssertFalse(WorkQueuePresentation.showsOwnerItems(scope: "tasks", filter: "all", search: ""))
        XCTAssertFalse(WorkQueuePresentation.showsOwnerItems(scope: "tickets", filter: "all", search: "ledger"))
    }
}
