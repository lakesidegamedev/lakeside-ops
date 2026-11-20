import XCTest
import SwiftUI
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
        router.showSettings = true
        router.reset()
        XCTAssertEqual(router.tab, .keir)
        XCTAssertTrue(router.studioPath.isEmpty)
        XCTAssertEqual(router.activityFilter, "all")
        XCTAssertFalse(router.showSettings, "a reset never leaves settings open over the chat")
    }

    /// The theme choice: system by default, and a dark theme saved by an
    /// earlier build stays dark (now true OLED black) instead of resetting.
    func testAppearanceKeepsAnEarlierDarkChoiceAndDefaultsToSystem() {
        XCTAssertNil(KeirAppearance.scheme(for: "system"))
        XCTAssertNil(KeirAppearance.scheme(for: ""), "no saved value follows the system")
        XCTAssertNil(KeirAppearance.scheme(for: "sepia"), "an unknown value follows the system")
        XCTAssertEqual(KeirAppearance.scheme(for: "light"), .light)
        XCTAssertEqual(KeirAppearance.scheme(for: "dark"), .dark)
        XCTAssertEqual(KeirAppearance.dark.title, "OLED black")
        XCTAssertEqual(KeirAppearance.allCases.map(\.rawValue), ["system", "light", "dark"])
    }

    /// True black on OLED and a light canvas, resolved per trait collection.
    func testOLEDCanvasIsTrueBlackAndLightCanvasIsNearWhite() {
        func rgb(_ color: Color, _ style: UIUserInterfaceStyle) -> [CGFloat] {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&r, green: &g, blue: &b, alpha: &a)
            return [r, g, b]
        }
        XCTAssertEqual(rgb(KeirChatTheme.canvas, .dark), [0, 0, 0])
        XCTAssertTrue(rgb(KeirChatTheme.canvas, .light).allSatisfy { $0 > 0.95 })
        XCTAssertTrue(rgb(KeirChatTheme.keirBubble, .dark).allSatisfy { $0 > 0.05 && $0 < 0.2 }, "Keir's bubble stays visible on black")
    }
}
