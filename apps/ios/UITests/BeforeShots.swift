import XCTest

/// Captures the pre-redesign screens for the before/after evidence on the
/// keir-mobile-briefing pull request. This target exists only on the evidence
/// branch and is removed after the screenshots are exported.
final class BeforeShots: XCTestCase {
    func testBeforeScreens() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-fixtures", "--uitest-dev-partner"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Keir"].waitForExistence(timeout: 20))
        snap(app, "Before Keir")
        app.buttons["keir-tools"].tap()
        sleep(1)
        snap(app, "Before Keir menu")
        dismissMenu(app)
        app.tabBars.buttons["Feed"].tap()
        sleep(1)
        snap(app, "Before Feed")
        app.tabBars.buttons["Ops"].tap()
        sleep(1)
        snap(app, "Before Ops")
    }

    private func dismissMenu(_ app: XCUIApplication) {
        let keir = app.tabBars.buttons["Keir"]
        if keir.exists { keir.tap() }
        sleep(1)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
