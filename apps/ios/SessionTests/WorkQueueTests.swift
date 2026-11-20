import XCTest
import LakesideCore
@testable import LakesideOps

final class WorkQueueTests: XCTestCase {
    func testWaitingAndUnassignedWorkCannotHideInFinishedHistory() {
        let waiting: JSONValue = .object(["title": .string("Coupon ledger"), "number": .number(1501), "timing": .object(["state": .string("waiting"), "overdue": .bool(false)])])
        let stuck: JSONValue = .object(["title": .string("Missing owner"), "timing": .object(["state": .string("unassigned"), "overdue": .bool(true)])])
        XCTAssertTrue(WorkQueuePresentation.matches(waiting, filter: "held", search: "1501"))
        XCTAssertFalse(WorkQueuePresentation.matches(waiting, filter: "stuck", search: ""))
        XCTAssertTrue(WorkQueuePresentation.matches(stuck, filter: "held", search: ""))
    }
    func testBlockedWorkIsNotAutomaticallyAnOwnerDecision() {
        let blocked: JSONValue = .object(["state": .string("blocked")])
        XCTAssertEqual(WorkQueuePresentation.state(blocked), "stuck")
        XCTAssertFalse(WorkQueuePresentation.matches(blocked, filter: "needs-you", search: ""))
        let approval: JSONValue = .object(["decisionPending": .bool(true)])
        XCTAssertEqual(WorkQueuePresentation.state(approval), "needs-you")
    }
    func testNeedsYouShowsOnAllAndItsOwnFilterInEitherScope() {
        XCTAssertTrue(WorkQueuePresentation.showsOwnerItems(filter: "all"))
        XCTAssertTrue(WorkQueuePresentation.showsOwnerItems(filter: "needs-you"))
        for filter in ["working", "waiting", "stuck"] {
            XCTAssertFalse(WorkQueuePresentation.showsOwnerItems(filter: filter), filter)
        }
    }
    func testEveryFilteredQueueRowIsAlsoOnAll() {
        let rows: [JSONValue] = [
            .object(["number": .number(1), "title": .string("Ledger"), "timing": .object(["state": .string("waiting")])]),
            .object(["number": .number(2), "title": .string("Payroll"), "timing": .object(["state": .string("stuck"), "overdue": .bool(true)])]),
            .object(["number": .number(3), "title": .string("Turn"), "timing": .object(["state": .string("working")])]),
            .object(["number": .number(4), "title": .string("Held"), "timing": .object(["state": .string("needs-you")])]),
        ]
        for search in ["", "Ledger", "2"] {
            let all = Set(rows.filter { WorkQueuePresentation.matches($0, filter: "all", search: search) }.map { $0["number"].string })
            for filter in ["working", "waiting", "stuck", "needs-you"] {
                let subset = Set(rows.filter { WorkQueuePresentation.matches($0, filter: filter, search: search) }.map { $0["number"].string })
                XCTAssertTrue(subset.isSubset(of: all), "\(filter) / \(search)")
            }
        }
    }
    func testAnAbortedAttemptIsStalledWithoutBeingReportedAsRunning() {
        let item: JSONValue = .object(["timing": .object([
            "state": .string("working"), "reason": .string("activation aborted: no result")
        ])])
        XCTAssertEqual(WorkQueuePresentation.label(item), "Stalled")
        XCTAssertEqual(WorkQueuePresentation.bucket(item), "stalled")
        XCTAssertEqual(WorkQueuePresentation.status(item), .failed)
    }
}
