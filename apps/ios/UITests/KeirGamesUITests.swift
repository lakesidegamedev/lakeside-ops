import XCTest

/// Connected games sheet, opened from the Keir tools menu. Runs on the built-in
/// fixtures only; no game or server is contacted and nothing is sent.
final class KeirGamesUITests: XCTestCase {
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"] + extra; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Conversation"].waitForExistence(timeout: 15))
        return app
    }
    private func composer(_ app: XCUIApplication) -> XCUIElement {
        app.textFields["keir-composer"].exists ? app.textFields["keir-composer"] : app.textViews["keir-composer"]
    }
    private func openGames(_ app: XCUIApplication) {
        let tools = app.buttons["keir-tools"]
        XCTAssertTrue(tools.waitForExistence(timeout: 15))
        for _ in 0..<3 { if tools.isHittable { break }; sleep(1) }
        tools.tap()
        let entry = app.buttons["keir-games-menu"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "the tools menu offers connected games in studio mode")
        entry.tap()
        XCTAssertTrue(app.otherElements["keir-games-sheet"].waitForExistence(timeout: 10) || app.buttons["keir-game-metroforge"].waitForExistence(timeout: 10))
    }
    /// Rows that are combined for VoiceOver may surface as text, buttons or other elements, so look at each kind.
    private func find(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 10) -> XCUIElement {
        let match = NSPredicate(format: "label CONTAINS %@", text)
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for query in [app.staticTexts, app.buttons, app.cells, app.otherElements] {
                let element = query.matching(match).firstMatch
                if element.exists { return element }
            }
            usleep(300_000)
        } while Date() < deadline
        return app.staticTexts.matching(match).firstMatch
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testSelectAGameSeeWhatKeirCanReadAndAskInTheConversation() {
        let app = launch()
        openGames(app)
        let metroforge = app.buttons["keir-game-metroforge"]
        XCTAssertTrue(metroforge.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["keir-game-ahd"].exists)
        XCTAssertTrue(app.buttons["keir-game-grand-century"].exists)
        metroforge.tap()
        XCTAssertTrue(find(app, "metroforge · mf_status").exists, "the evidence path names the read")
        XCTAssertTrue(find(app, "Preview site", timeout: 1).exists)
        XCTAssertTrue(find(app, "Not read by Keir", timeout: 1).exists, "withheld data is stated")
        XCTAssertTrue(find(app, "A House Divided desk only", timeout: 1).exists, "tickets are not claimed for MetroForge")
        XCTAssertFalse(app.buttons["keir-game-ask-tickets"].exists, "no ticket question for a game without tickets")
        capture(app, "Connected games MetroForge")
        let ask = app.buttons["keir-game-ask-health"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        ask.tap()
        let box = composer(app)
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        let draft = box.value as? String ?? ""
        XCTAssertTrue(draft.hasPrefix("About MetroForge:"), draft)
        XCTAssertTrue(draft.contains("mf_status"))
        XCTAssertTrue(draft.contains("Don't change anything or message anyone"))
        XCTAssertFalse(app.buttons["keir-game-metroforge"].exists, "the sheet closed and nothing was sent")
    }

    func testTicketQuestionsAreOnlyForAHouseDivided() {
        let app = launch()
        openGames(app)
        app.buttons["keir-game-ahd"].tap()
        XCTAssertTrue(app.buttons["keir-game-ask-tickets"].waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "engine · engine_health", timeout: 1).exists)
        app.buttons["keir-game-grand-century"].tap()
        XCTAssertTrue(find(app, "grand-century · gc_status").exists)
        XCTAssertFalse(app.buttons["keir-game-ask-tickets"].exists)
    }

    func testAnUnavailableReadAndAnUnconnectedGameAreSaidPlainly() {
        let app = launch(["--uitest-games-unavailable", "--uitest-games-unregistered"])
        openGames(app)
        app.buttons["keir-game-metroforge"].tap()
        XCTAssertTrue(find(app, "could not read this just now").exists)
        XCTAssertFalse(find(app, "Responding", timeout: 1).exists, "no numbers for a failed read")
        capture(app, "Connected games unavailable")
        app.buttons["keir-game-grand-century"].tap()
        XCTAssertTrue(find(app, "No read connection is registered").exists)
        XCTAssertFalse(app.buttons["keir-game-ask-health"].exists, "an unconnected game offers no question")
    }

    func testATypedDraftIsProtected() {
        let app = launch()
        let box = composer(app)
        XCTAssertTrue(box.waitForExistence(timeout: 10)); box.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { box.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap() }
        app.typeText("My own words")
        app.buttons["keir-tools"].tap()
        let entry = app.buttons["keir-games-menu"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5)); entry.tap()
        let metroforge = app.buttons["keir-game-metroforge"]
        XCTAssertTrue(metroforge.waitForExistence(timeout: 10)); metroforge.tap()
        let ask = app.buttons["keir-game-ask-health"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10))
        XCTAssertFalse(ask.isEnabled, "a question would replace the draft")
    }

    func testTheChosenGameIsRememberedWhenTheSheetReopens() {
        let app = launch(["--uitest-keep-games"])
        openGames(app)
        app.buttons["keir-game-grand-century"].tap()
        XCTAssertTrue(find(app, "grand-century · gc_status").exists)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["keir-tools"].waitForExistence(timeout: 10))
        openGames(app)
        XCTAssertTrue(find(app, "grand-century · gc_status").exists, "the earlier choice is restored")
    }
}
