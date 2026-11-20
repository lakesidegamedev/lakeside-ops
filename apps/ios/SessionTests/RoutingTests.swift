import XCTest
@testable import LakesideOps

@MainActor final class RoutingTests: XCTestCase {
    func testAppLandsInTheConversation() {
        XCTAssertEqual(OpsRouter().tab, .keir)
    }

    func testFeedAndGoalsOpenInsideOps() {
        let router = OpsRouter()
        router.open(.feed)
        XCTAssertEqual(router.tab, .ops)
        XCTAssertEqual(router.studioPath, [.feed])
        router.open(.goals)
        XCTAssertEqual(router.studioPath, [.goals])
    }

    func testResetReturnsToTheConversation() {
        let router = OpsRouter()
        router.open(.goals)
        router.activityFilter = "working"
        router.reset()
        XCTAssertEqual(router.tab, .keir)
        XCTAssertTrue(router.studioPath.isEmpty)
        XCTAssertEqual(router.activityFilter, "all")
    }
}
