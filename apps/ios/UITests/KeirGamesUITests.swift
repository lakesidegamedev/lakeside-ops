import XCTest

/// Connected games sheet, opened from the Keir tools menu. Runs on the built-in
/// fixtures only; no game or server is contacted and nothing is sent.
final class KeirGamesUITests: XCTestCase {
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"] + extra; app.launch()
        XCTAssertTrue(app.buttons["keir-threads"].waitForExistence(timeout: 15))
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
    /// The sheet is a Form: rows below the fold are not built, so they are
    /// absent from the hierarchy until scrolled to. Drag inside the sheet, up to
    /// reach the questions at the bottom or down to return to the game list,
    /// until `element` is fully on screen. Going down, a row that is built but
    /// still scrolled under the navigation bar counts as not yet reached: a tap
    /// there is swallowed by the bar and the choice never changes.
    @discardableResult
    private func reveal(_ app: XCUIApplication, _ element: @autoclosure () -> XCUIElement, down: Bool = false, attempts: Int = 8) -> XCUIElement {
        let window = app.windows.firstMatch
        let bar = app.navigationBars.firstMatch
        for _ in 0..<attempts {
            let current = element()
            if current.exists && current.isHittable && (!down || !bar.exists || current.frame.minY >= bar.frame.maxY) { return current }
            let low = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
            let high = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            if down { high.press(forDuration: 0.05, thenDragTo: low) } else { low.press(forDuration: 0.05, thenDragTo: high) }
            usleep(400_000)
        }
        return element()
    }
    /// Scroll the whole sheet down to its end, so an absent question is absent
    /// because it is not offered, not because it was never built.
    private func scrollToEnd(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        for _ in 0..<4 {
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)))
            usleep(300_000)
        }
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
        XCTAssertTrue(find(app, "Service and release health").exists || find(app, "Preview site").exists)
        XCTAssertTrue(find(app, "Preview site", timeout: 1).exists)
        XCTAssertTrue(find(app, "Leaderboard").exists, "withheld data is stated")
        let ask = reveal(app, app.buttons["keir-game-ask-health"])
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        XCTAssertTrue(find(app, "No support tickets for this game", timeout: 2).exists, "tickets are not claimed for MetroForge")
        scrollToEnd(app)
        XCTAssertTrue(ask.exists)
        XCTAssertFalse(app.buttons["keir-game-ask-tickets"].exists, "no ticket question for a game without tickets")
        capture(app, "Connected games MetroForge")
        reveal(app, ask).tap()
        let box = composer(app)
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        let draft = box.value as? String ?? ""
        XCTAssertTrue(draft.hasPrefix("About MetroForge:"), draft)
        XCTAssertTrue(draft.contains("read-only checks"))
        XCTAssertFalse(draft.contains("mf_status"))
        XCTAssertTrue(draft.contains("Don't change anything or message anyone"))
        XCTAssertFalse(app.buttons["keir-game-metroforge"].exists, "the sheet closed and nothing was sent")
    }

    func testTicketQuestionsAreOnlyForAHouseDivided() {
        let app = launch()
        openGames(app)
        app.buttons["keir-game-ahd"].tap()
        XCTAssertTrue(find(app, "Turn").exists)
        XCTAssertTrue(reveal(app, app.buttons["keir-game-ask-tickets"]).waitForExistence(timeout: 5), "A House Divided offers a ticket question")
        let grandCentury = reveal(app, app.buttons["keir-game-grand-century"], down: true)
        XCTAssertTrue(grandCentury.isHittable, "the game list is back on screen after scrolling to the questions")
        grandCentury.tap()
        XCTAssertTrue(find(app, "Grand Century").exists, "the choice moved to Grand Century")
        XCTAssertTrue(reveal(app, app.buttons["keir-game-ask-health"]).waitForExistence(timeout: 5))
        scrollToEnd(app)
        XCTAssertFalse(app.buttons["keir-game-ask-tickets"].exists)
    }

    func testAnUnavailableReadAndAnUnconnectedGameAreSaidPlainly() {
        let app = launch(["--uitest-games-unavailable", "--uitest-games-unregistered"])
        openGames(app)
        app.buttons["keir-game-metroforge"].tap()
        XCTAssertTrue(find(app, "could not read this just now").exists)
        XCTAssertFalse(find(app, "Responding", timeout: 1).exists, "no numbers for a failed read")
        capture(app, "Connected games unavailable")
        reveal(app, app.buttons["keir-game-grand-century"], down: true).tap()
        XCTAssertTrue(find(app, "No read connection is registered").exists)
        scrollToEnd(app)
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
        XCTAssertTrue(find(app, "Preview site").exists)
        let ask = reveal(app, app.buttons["keir-game-ask-health"])
        XCTAssertTrue(ask.waitForExistence(timeout: 10))
        XCTAssertFalse(ask.isEnabled, "a question would replace the draft")
    }

    func testTheChosenGameIsRememberedWhenTheSheetReopens() {
        let app = launch(["--uitest-keep-games"])
        openGames(app)
        app.buttons["keir-game-grand-century"].tap()
        XCTAssertTrue(find(app, "Grand Century").exists)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["keir-tools"].waitForExistence(timeout: 10))
        openGames(app)
        XCTAssertTrue(find(app, "Grand Century").exists, "the earlier choice is restored")
    }
}
