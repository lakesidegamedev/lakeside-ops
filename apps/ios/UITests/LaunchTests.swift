import XCTest

/// Lakeside Ops UI tests. Every test runs against built-in fixtures and never
/// contacts a server. Rows that are buttons or navigation links expose one
/// combined label, so lookups match on label text rather than exact static text.
final class LaunchTests: XCTestCase {
    private func launch() -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 15))
        return app
    }
    /// Polls the element types that carry text. A descendants(.any) query over the
    /// whole app is slow enough to time out on a loaded CI runner.
    private func find(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 10) -> XCUIElement {
        let match = NSPredicate(format: "label CONTAINS %@", text)
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for query in [app.staticTexts, app.buttons, app.cells, app.links, app.otherElements] {
                let element = query.matching(match).firstMatch
                if element.exists { return element }
            }
            usleep(300_000)
        } while Date() < deadline
        return app.staticTexts.matching(match).firstMatch
    }
    /// Moves to a place in the app by its name before the redesign: Keir and
    /// Activity are the Chat and Inbox tabs of the dock, and Feed and Goals are
    /// opened from Ops.
    private func go(_ app: XCUIApplication, _ place: String) {
        switch place {
        case "Keir": app.tabBars.buttons["Chat"].tap()
        case "Activity": app.tabBars.buttons["Inbox"].tap()
        case "Feed", "Goals":
            app.tabBars.buttons["Ops"].tap()
            openRow(app, place)
        default: app.tabBars.buttons[place].tap()
        }
    }
    /// Opens an item from the Keir tools menu, waiting out any closing sheet.
    private func openTool(_ app: XCUIApplication, _ name: String, destinationTitle: String? = nil) {
        let tools = app.buttons["keir-tools"]
        for _ in 0..<4 {
            if tools.waitForExistence(timeout: 5) && tools.isHittable && tools.isEnabled { tools.tap() }
            if app.buttons[name].waitForExistence(timeout: 3) {
                app.buttons[name].tap()
                if app.navigationBars[destinationTitle ?? name].waitForExistence(timeout: 5) { return }
            }
        }
        XCTFail("Keir tools menu did not offer \(name)")
    }
    /// Opens a row in the Ops list by the start of its combined label. Returning
    /// from a detail keeps the list where it was, so the target can be below or
    /// above the viewport: search down to the end, then back up to the top. The
    /// search counts swipes, not seconds. At accessibility text sizes the list is
    /// many screens long and each swipe waits longer for the app to settle, so a
    /// time budget ran out before the last rows (Feed, Goals) were reached.
    private func openRow(_ app: XCUIApplication, _ title: String, swipes: Int = 16, file: StaticString = #filePath, line: UInt = #line) {
        let matches = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title))
        func open() -> Bool {
            let row = matches.firstMatch
            guard row.exists && row.isHittable else { return false }
            row.tap(); return true
        }
        _ = app.navigationBars["Ops"].waitForExistence(timeout: 5)
        if open() { return }
        let directions: [() -> Void] = [{ app.swipeUp() }, { app.swipeDown() }]
        for swipe in directions {
            for _ in 0..<swipes {
                swipe()
                if open() { return }
            }
        }
        let fallback = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if fallback.exists && fallback.isHittable { fallback.tap(); return }
        XCTFail("Ops row \(title) is missing or not hittable", file: file, line: line)
    }
    /// Scrolls until `element` can be tapped and reports whether it can. A
    /// screen popped back to keeps its scroll position, and a lazy stack drops
    /// views far off screen, so a control at the top (the briefing's primary
    /// action after returning from Feed) is searched for upward first.
    private func reveal(_ app: XCUIApplication, _ element: XCUIElement, swipes: Int = 16) -> Bool {
        if element.waitForExistence(timeout: 3) && element.isHittable { return true }
        let directions: [() -> Void] = [{ app.swipeDown() }, { app.swipeUp() }]
        for swipe in directions {
            for _ in 0..<swipes {
                swipe()
                if element.exists && element.isHittable { return true }
            }
        }
        return false
    }
    /// Polls a condition that has no single element to wait on.
    private func eventually(timeout: TimeInterval = 8, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            usleep(250_000)
        } while Date() < deadline
        return false
    }
    private func digits(_ text: String) -> String {
        text.filter(\.isNumber)
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    /// Opens one of Keir's menus (the top-left tools menu or the composer's
    /// "+") and taps the item whose label starts with `item`. Menu items are
    /// matched by label because SwiftUI does not pass identifiers into menus.
    ///
    /// With `until`, the choice counts only once its outcome shows. A tap that
    /// lands while the menu is still animating is dropped and the menu stays
    /// open, so that case chooses again. A menu that closed without the outcome
    /// is an app failure and is reported, never retried.
    @discardableResult
    private func chooseFromMenu(_ app: XCUIApplication, _ menu: String, _ item: String, until outcome: (() -> Bool)? = nil,
                                file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let opener = app.buttons[menu]
        let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", item)).firstMatch
        for _ in 0..<4 {
            if !entry.exists, opener.waitForExistence(timeout: 5) && opener.isHittable && opener.isEnabled { opener.tap() }
            guard entry.waitForExistence(timeout: 3) else { continue }
            entry.tap()
            guard let outcome else { return true }
            if eventually(outcome) { return true }
            guard entry.exists else {
                XCTFail("choosing \(item) from \(menu) closed the menu but had no effect", file: file, line: line)
                return false
            }
        }
        XCTFail("\(menu) did not offer \(item)", file: file, line: line)
        return false
    }
    /// Reads the label of a menu item without choosing it, then closes the menu.
    private func menuItemLabel(_ app: XCUIApplication, _ menu: String, _ item: String) -> String {
        let opener = app.buttons[menu]
        XCTAssertTrue(opener.waitForExistence(timeout: 8))
        opener.tap()
        let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", item)).firstMatch
        let label = entry.waitForExistence(timeout: 5) ? entry.label : ""
        dismissMenu(app, closing: entry)
        return label
    }
    /// A tap outside an open menu closes it without reaching what is under it.
    /// Pass an item of the menu to wait until the menu has really closed: the
    /// next menu opened while this one still animates out can swallow its tap.
    private func dismissMenu(_ app: XCUIApplication, closing item: XCUIElement? = nil, file: StaticString = #filePath, line: UInt = #line) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.35)).tap()
        if let item, item.exists {
            XCTAssertTrue(item.waitForNonExistence(timeout: 5), "the menu closed", file: file, line: line)
            usleep(300_000)
        } else {
            sleep(1)
        }
    }

    func testIdeasSwipeTriage() {
        let app = launch()
        go(app, "Ops")
        openRow(app, "Ideas")
        let cell = app.cells.firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "CI runs the full matrix").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Every back-merge with no content change").exists, "the reason line is visible without opening evidence")
        capture(app, "Ideas with a reason line")
        cell.swipeLeft()
        let dismiss = app.buttons["Dismiss"]
        XCTAssertTrue(dismiss.waitForExistence(timeout: 5))
        dismiss.tap()
        XCTAssertTrue(find(app, "No ideas waiting", timeout: 10).exists, "the dismissed idea leaves the triage list")
        capture(app, "Idea dismissed by swipe")
    }

    /// Captures the four screens the redesign PR must show, with the dev-partner
    /// fixture so Keir has live work to display.
    func testRedesignEvidenceScreens() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-dev-partner"]; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["keir-working-now"].waitForExistence(timeout: 15))
        capture(app, "After Keir")
        app.buttons["keir-tools"].tap()
        sleep(1)
        capture(app, "After Keir menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)).tap()
        sleep(1)
        go(app, "Feed")
        XCTAssertTrue(app.navigationBars["Feed"].waitForExistence(timeout: 10))
        sleep(1)
        capture(app, "After Feed")
        go(app, "Ops")
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 10))
        sleep(1)
        capture(app, "After Ops")
    }

    func testAccessibilityTextSizeKeepsPrimaryActionsReachable() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-fixtures", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Ops"].waitForExistence(timeout: 20))
        go(app, "Feed")
        XCTAssertTrue(app.navigationBars["Feed"].waitForExistence(timeout: 15), "Feed opens from Ops at accessibility sizes")
        let feedAction = app.buttons["feed-review-attention"]
        XCTAssertTrue(feedAction.waitForExistence(timeout: 15))
        XCTAssertTrue(reveal(app, feedAction), "the primary action stays reachable at accessibility sizes")
        capture(app, "Feed at accessibility text size")
        // The Ops tab returns to the list where it was left, near Feed at the
        // bottom; the briefing's action is reached by scrolling back up.
        go(app, "Ops")
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 10))
        let opsAction = app.buttons["ops-review-attention"]
        XCTAssertTrue(reveal(app, opsAction), "the Ops primary action stays reachable at accessibility sizes")
        capture(app, "Ops at accessibility text size")
        go(app, "Keir")
        XCTAssertTrue(app.textFields["keir-composer"].waitForExistence(timeout: 10) || app.textViews["keir-composer"].exists)
        // The chat chrome stays reachable at the largest text size.
        for id in ["keir-tools", "keir-threads", "keir-microphone", "add-attachment"] {
            XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 5) && app.buttons[id].isHittable, "\(id) is reachable at accessibility sizes")
        }
        capture(app, "Chat at accessibility text size")
    }

    func testKeirComposerOffersPhotosAndFiles() {
        let app = launch()
        let attach = app.buttons["add-attachment"]
        XCTAssertTrue(attach.waitForExistence(timeout: 10))
        attach.tap()
        XCTAssertTrue(app.buttons["Photo library"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Choose file"].exists)
        capture(app, "Keir photo and file attachment choices")
        // The system may present a popover without a Cancel action. Each test
        // launches a fresh app, so no synthetic dismissal is needed here.
    }

    func testKeirThreadDecisionAndReply() {
        let app = launch()
        XCTAssertTrue(find(app, "How did the last turn go?").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["decision-approve"].waitForExistence(timeout: 10))
        capture(app, "Keir thread with a decision")
        let composer = app.textFields["keir-composer"].exists ? app.textFields["keir-composer"] : app.textViews["keir-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.typeText("Which PRs are waiting on me?")
        app.buttons["keir-send"].tap()
        XCTAssertTrue(find(app, "Two PRs are waiting on you").waitForExistence(timeout: 15))
        capture(app, "Keir reply")
        // The answer scrolls to the latest message. Scroll back to the approval
        // explicitly rather than relying on XCTest's lazy-stack auto-scroll.
        let keyboardGone = NSPredicate(format: "exists == false")
        expectation(for: keyboardGone, evaluatedWith: app.keyboards.firstMatch)
        waitForExpectations(timeout: 5)
        for _ in 0..<8 {
            if app.buttons["decision-approve"].isHittable { break }
            app.scrollViews.firstMatch.swipeDown()
        }
        guard app.buttons["decision-approve"].isHittable else { XCTFail("Approval is not visible after scrolling to older messages"); return }
        app.buttons["decision-approve"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["decision-approve"])
        waitForExpectations(timeout: 5)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testFeedWithBriefIdeasAndUpcoming() {
        let app = launch()
        go(app, "Feed")
        XCTAssertTrue(find(app, "Completed model activations").waitForExistence(timeout: 10))
        capture(app, "Feed overview with activity graph")
        for _ in 0..<5 { if find(app, "CI runs the full matrix", timeout: 1).exists { break }; app.swipeUp() }
        XCTAssertTrue(find(app, "CI runs the full matrix").exists)
        for _ in 0..<5 { if find(app, "Morning brief", timeout: 1).exists { break }; app.swipeUp() }
        XCTAssertTrue(find(app, "Morning brief").exists)
        capture(app, "Feed entries")
        XCTAssertTrue(app.buttons["brief-now"].exists)
    }

    func testGoalsListDetailAndNewGoal() {
        let app = launch()
        go(app, "Goals")
        let goal = find(app, "Median turn time under 60 seconds")
        XCTAssertTrue(goal.waitForExistence(timeout: 10))
        capture(app, "Goals")
        goal.tap()
        XCTAssertTrue(find(app, "Capture phase timings for 20 turns").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Settlement dominates").exists)
        capture(app, "Goal detail")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["goal-add"].tap()
        let example = app.buttons["Every bug ticket answered within 2 hours"]
        XCTAssertTrue(example.waitForExistence(timeout: 5)); example.tap()
        capture(app, "New goal")
        app.buttons["goal-save"].tap()
        XCTAssertTrue(find(app, "Every bug ticket answered within 2 hours").waitForExistence(timeout: 10))
    }

    func testTicketQueueShowsBlockedWaitAndNextCheck() {
        let app = launch()
        go(app, "Activity")
        XCTAssertTrue(app.buttons["work-filter-stuck"].waitForExistence(timeout: 10))
        app.buttons["work-filter-stuck"].tap()
        XCTAssertTrue(find(app, "Verify an interrupted action").waitForExistence(timeout: 10))
        XCTAssertFalse(find(app, "Bond coupon ledger", timeout: 1).exists)
        capture(app, "Ticket queue filtered to stuck work")
        app.buttons["work-filter-waiting"].tap()
        XCTAssertTrue(find(app, "Bond coupon ledger").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Read the check result").exists)
        XCTAssertTrue(find(app, "Check in").exists)
        // A compact row says nothing about completion when there is no estimate.
        XCTAssertFalse(find(app, "Completion time not established", timeout: 1).exists)
        capture(app, "Ticket queue with timed wait and next milestone")
    }

    func testActivityApprovalsPlanAndLiveWork() {
        let app = launch()
        go(app, "Activity")
        XCTAssertTrue(find(app, "Merge #201").waitForExistence(timeout: 10))
        capture(app, "Activity with approvals")
        app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tasks")).firstMatch.tap()
        let task = find(app, "Promote development to production")
        XCTAssertTrue(task.waitForExistence(timeout: 10))
        app.swipeUp()
        app.buttons["work-row-abcdef012345"].tap()
        XCTAssertTrue(find(app, "Promote staging to main").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Merged PR #210").exists)
        app.buttons["task-live"].tap()
        XCTAssertTrue(find(app, "railway.railway_status").waitForExistence(timeout: 5))
        capture(app, "Task with plan and live work")
    }

    func testOpsHubScreens() {
        let app = launch()
        go(app, "Ops")
        // Needs you lists only decisions and owner work; a degraded service is a
        // health fact, not an owner decision, and never appears as a separate list.
        if !find(app, "Merge #201 to development", timeout: 3).exists { app.swipeUp() }
        XCTAssertTrue(find(app, "Merge #201 to development").waitForExistence(timeout: 10))
        XCTAssertFalse(find(app, "Lakeside Ask is degraded").exists)
        capture(app, "Ops briefing")
        openRow(app, "Health detail")
        XCTAssertTrue(app.navigationBars["Health"].waitForExistence(timeout: 10))
        capture(app, "Health detail")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 5))
        openRow(app, "Support desk")
        XCTAssertTrue(app.navigationBars["Desk"].waitForExistence(timeout: 15))
        XCTAssertTrue(find(app, "Budget screen shows zero funding", timeout: 20).waitForExistence(timeout: 20))
        capture(app, "Desk")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 5))
        openRow(app, "Studio work in progress")
        XCTAssertTrue(find(app, "Keir chat in Lakeside Ops").waitForExistence(timeout: 10))
        capture(app, "Work")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 5))
        openRow(app, "Files")
        let report = find(app, "Turn time breakdown")
        XCTAssertTrue(report.waitForExistence(timeout: 10)); report.tap()
        XCTAssertTrue(find(app, "Settlement took 15.6s").waitForExistence(timeout: 10))
        capture(app, "File")
    }

    func testStarmerWidgetFlipsToWork() {
        let app = launch()
        go(app, "Ops")
        let line = app.staticTexts["ops-starmer-line"]
        for _ in 0..<4 where !line.exists { app.swipeUp() }
        XCTAssertTrue(line.waitForExistence(timeout: 15))
        XCTAssertTrue(find(app, "Two turns ran clean").exists)
        capture(app, "Ops widget line")
        app.buttons["ops-starmer-flip"].tap()
        let working = app.staticTexts["ops-starmer-working"]
        XCTAssertTrue(working.waitForExistence(timeout: 5))
        XCTAssertTrue(find(app, "Open Inbox to view tickets and tasks.").waitForExistence(timeout: 5))
        capture(app, "Ops widget working")
    }

    /// Four stable states for the PR evidence. The widget reads the forced
    /// state from the launch arguments, so the screenshots do not depend on
    /// timing or on what the fixture happens to be doing.
    func testKeirSpriteStateScreenshots() {
        for state in ["idle", "talking", "thinking", "alert"] {
            let app = XCUIApplication()
            app.launchArguments = ["--uitest-fixtures", "--uitest-starmer-state", state]
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Ops"].waitForExistence(timeout: 20), state)
            go(app, "Ops")
            let line = app.staticTexts["ops-starmer-line"]
            for _ in 0..<4 where !line.exists { app.swipeUp() }
            XCTAssertTrue(line.waitForExistence(timeout: 15), state)
            capture(app, "Keir \(state)")
            app.terminate()
        }
    }

    func testAwayRecapShowsAndDismisses() {
        let app = launch()
        go(app, "Feed")
        // The app can restore the previous test's scroll position. Start at the
        // top so the recap, which sits under the hero, is on screen.
        for _ in 0..<3 { app.swipeDown() }
        let dismiss = app.buttons["recap-dismiss"]
        for _ in 0..<4 where !dismiss.exists { app.swipeUp() }
        XCTAssertTrue(dismiss.waitForExistence(timeout: 15))
        XCTAssertTrue(find(app, "Merged PR #210").exists)
        capture(app, "While you were away")
        dismiss.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "WHILE YOU WERE AWAY")).firstMatch.waitForNonExistence(timeout: 5))
    }

    func testOpsSystemsDrillDowns() {
        let app = launch()
        go(app, "Ops")
        for (row, title, evidence) in [
            ("Scheduler", "Scheduler", "ios-simulator"),
            ("Security", "Security", "fail2ban recidive jail"),
            ("Pull requests", "Pull requests", "Keir mobile briefing redesign"),
            ("Worktrees and agents", "Worktrees", "Keir mobile briefing"),
            ("World simulations", "World sims", "seed-1991"),
            ("Backups and database", "Backups", "2026-10-15"),
            ("Event recovery", "Event recovery", "Receipt store timed out")
        ] {
            openRow(app, row)
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "\(row) did not open")
            XCTAssertTrue(find(app, evidence).waitForExistence(timeout: 10), "\(row) is missing \(evidence)")
            capture(app, row)
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.tabBars.buttons["Ops"].waitForExistence(timeout: 5))
        }
    }

    func testConversationIsHomeAndContextChipOpensInbox() {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].isSelected, "The app must land in the chat")
        let chip = app.buttons["keir-chip-attention"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        chip.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Inbox"].isSelected)
        capture(app, "Inbox from the needs-you capsule")
    }

    func testAttentionCountsMatchAcrossScreens() {
        let app = launch()
        go(app, "Feed")
        let feedButton = app.buttons["feed-review-attention"]
        XCTAssertTrue(feedButton.waitForExistence(timeout: 10))
        let feedCount = digits(feedButton.label)
        XCTAssertFalse(feedCount.isEmpty)
        XCTAssertEqual(app.staticTexts["feed-attention-count"].label, feedCount)
        // Back on Ops the list keeps the scroll position that reached Feed, so
        // the briefing at the top is scrolled back into view.
        go(app, "Ops")
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 10))
        let opsButton = app.buttons["ops-review-attention"]
        XCTAssertTrue(reveal(app, opsButton), "the Ops briefing offers the review action")
        XCTAssertEqual(digits(opsButton.label), feedCount, "Feed and Ops disagree on the count")
        let opsCount = app.staticTexts["ops-attention-count"]
        XCTAssertTrue(reveal(app, opsCount))
        XCTAssertEqual(opsCount.label, feedCount)
        go(app, "Keir")
        let chip = app.buttons["keir-chip-attention"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCTAssertEqual(digits(chip.label), feedCount, "The Inbox shortcut and Feed disagree on the count")
        capture(app, "Keir attention count matches")
    }

    func testKeirToolsMenuDoesNotDuplicateOps() {
        let app = launch()
        app.buttons["keir-tools"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Controls, providers")).firstMatch.waitForExistence(timeout: 5))
        for duplicated in ["Ideas", "Watches", "Memory"] {
            XCTAssertFalse(app.buttons[duplicated].exists, "\(duplicated) must live only in Ops")
        }
        capture(app, "Keir tools menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)).tap()
        sleep(1)
        go(app, "Ops")
        for destination in ["Ideas", "Watches", "Memory"] {
            openRow(app, destination)
            XCTAssertTrue(app.navigationBars[destination].waitForExistence(timeout: 10), "\(destination) is missing from Ops")
            app.navigationBars.buttons.firstMatch.tap()
        }
        capture(app, "Ops destinations")
    }

    func testBrokenStatusTextNeverBecomesAStatus() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-broken-status"]; app.launch()
        XCTAssertTrue(app.buttons["keir-working-now"].waitForExistence(timeout: 15))
        XCTAssertFalse(find(app, "It me or turn been stuck", timeout: 2).exists)
        XCTAssertFalse(find(app, "Was:", timeout: 1).exists)
        XCTAssertTrue(find(app, "Work started").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "#1651").exists)
        capture(app, "Clean status from broken prose")
    }


    func testWatchesMemoryAndThreads() {
        let app = launch()
        go(app, "Ops")
        openRow(app, "Watches")
        XCTAssertTrue(find(app, "PR 201 is merged").waitForExistence(timeout: 10))
        app.buttons["watch-add"].tap()
        let example = app.buttons["Turn time goes above 90 seconds"]
        XCTAssertTrue(example.waitForExistence(timeout: 5)); example.tap()
        app.buttons["watch-save"].tap()
        XCTAssertTrue(find(app, "Turn time goes above 90 seconds").waitForExistence(timeout: 10))
        capture(app, "Watches")
        app.navigationBars.buttons.firstMatch.tap()
        openRow(app, "Memory")
        XCTAssertTrue(find(app, "Never promote economy changes").waitForExistence(timeout: 10))
        capture(app, "Memory")
        app.navigationBars.buttons.firstMatch.tap()
        go(app, "Keir")
        let threads = app.buttons["keir-threads"]
        XCTAssertTrue(threads.waitForExistence(timeout: 5))
        for _ in 0..<3 { if threads.isHittable { break }; sleep(1) }
        threads.tap()
        XCTAssertTrue(find(app, "Bond market").waitForExistence(timeout: 10))
        capture(app, "Threads")
    }

    func testNativeStopStartAndYoloControls() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        // Stop and start are a deliberate choice in Keir's menu, not a
        // permanent button on the chat.
        XCTAssertTrue(app.buttons["keir-tools"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Stop Keir"].exists, "stop is not on screen until the menu opens")
        // The header pill reads Stopped while Keir is stopped.
        let stopped = { self.find(app, "Stopped", timeout: 0.5).exists }
        chooseFromMenu(app, "keir-tools", "Stop Keir", until: stopped)
        XCTAssertTrue(find(app, "Stopped").waitForExistence(timeout: 5))
        XCTAssertTrue(menuItemLabel(app, "keir-tools", "Start Keir").contains("Start")); capture(app, "Keir stopped")
        chooseFromMenu(app, "keir-tools", "Start Keir", until: { !stopped() })
        XCTAssertTrue(find(app, "Stopped", timeout: 2).waitForNonExistence(timeout: 5))
        XCTAssertTrue(menuItemLabel(app, "keir-tools", "Stop Keir").contains("Stop"))
        chooseFromMenu(app, "keir-tools", "Controls, providers", until: { app.navigationBars["Keir controls"].exists })
        let yolo = app.switches["keir-yolo"]
        XCTAssertTrue(yolo.waitForExistence(timeout: 8))
        yolo.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: yolo)
        waitForExpectations(timeout: 5)
        let conversation = app.buttons["keir-route-conversation"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 5)); conversation.tap()
        find(app, "Fixture model").tap()
        if !app.navigationBars["Keir controls"].exists { app.navigationBars.buttons.firstMatch.tap() }
        XCTAssertTrue(app.navigationBars["Keir controls"].waitForExistence(timeout: 5)); capture(app, "Keir controls")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(app.buttons["keir-yolo-banner"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["keir-yolo-banner"].label.contains("Autonomy"), "the banner spells out what it allows")
        capture(app, "Keir native presence")
        app.buttons["keir-yolo-banner"].tap()
        XCTAssertTrue(app.buttons["Turn off autonomy"].waitForExistence(timeout: 5))
        app.buttons["Turn off autonomy"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["keir-yolo-banner"])
        waitForExpectations(timeout: 5)
        XCTAssertTrue(menuItemLabel(app, "add-attachment", "Model").contains("Fixture model"))
        chooseFromMenu(app, "keir-microphone", "Voice conversation", until: { app.staticTexts["Keir voice"].exists })
        XCTAssertTrue(app.staticTexts["Keir voice"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Microsoft Ava · online voice"].exists)
        capture(app, "Keir voice mode")
        app.buttons["End voice mode"].tap()
        XCTAssertTrue(app.textFields["keir-composer"].exists || app.textViews["keir-composer"].exists)
    }

    func testVoiceAcceptsLateAnswerAfterTimeout() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-late-voice"]; app.launch()
        XCTAssertTrue(app.buttons["keir-microphone"].waitForExistence(timeout: 15)); chooseFromMenu(app, "keir-microphone", "Voice conversation", until: { app.staticTexts["Keir voice"].exists })
        XCTAssertTrue(find(app, "The voice reply has not arrived", timeout: 3).exists)
        XCTAssertTrue(app.staticTexts["The late answer is now ready."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Try voice again"].exists)
        capture(app, "Late voice answer recovered")
    }

    func testWorkingNowBarAndProgressUpdates() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-dev-partner"]; app.launch()
        let bar = app.buttons["keir-working-now"]
        XCTAssertTrue(bar.waitForExistence(timeout: 15))
        XCTAssertTrue(bar.label.contains("Factory demand refund"), "the bar names the ticket Keir is on")
        XCTAssertTrue(find(app, "now tested on development").waitForExistence(timeout: 10))
        capture(app, "Keir progress update and working-now bar")
        bar.tap()
        XCTAssertTrue(find(app, "Audit CI back-merges").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["keir-working-all"].exists)
        capture(app, "Working-now threads expanded")
        app.buttons["keir-working-open-ticketjob001"].tap()
        XCTAssertTrue(find(app, "Choose payroll behavior").waitForExistence(timeout: 8), "a ticket row opens its ticket")
        capture(app, "Ticket opened from the working-now bar")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(bar.waitForExistence(timeout: 8))
        app.buttons["keir-working-all"].tap()
        XCTAssertTrue(app.tabBars.buttons["Inbox"].isSelected)
    }

    func testCompactTablesAndProviderAvailability() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-table"]; app.launch()
        XCTAssertTrue(app.otherElements["markdown-table-cards"].firstMatch.waitForExistence(timeout: 12) || find(app, "Tech tree").waitForExistence(timeout: 5))
        XCTAssertTrue(find(app, "Implementation is waiting on the assigned developer").exists)
        XCTAssertFalse(find(app, "What are we working on?").exists)
        capture(app, "Compact phone table")
        chooseFromMenu(app, "keir-tools", "Controls, providers", until: { app.navigationBars["Keir controls"].exists })
        XCTAssertTrue(app.navigationBars["Keir controls"].waitForExistence(timeout: 8))
        app.buttons["keir-route-conversation"].tap()
        XCTAssertTrue(find(app, "Opus 5.5").waitForExistence(timeout: 5))
        XCTAssertTrue(find(app, "Sonnet 5.5").exists)
        app.swipeUp()
        XCTAssertTrue(find(app, "DeepSeek V4.1 Flash").exists)
        XCTAssertTrue(find(app, "Automatic · Jev").exists)
        capture(app, "Provider choices and Jev")
    }

    func testEvidenceBackedGoalSuggestionReview() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-goal-suggestions"]; app.launch()
        go(app, "Goals")
        XCTAssertTrue(find(app, "Keep replies under five seconds").waitForExistence(timeout: 10))
        app.buttons["Review goal"].tap()
        XCTAssertTrue(app.textFields["goal-title"].exists || app.textViews["goal-title"].exists)
        capture(app, "Review suggested goal")
    }

    func testChoicesModelSwitchAndConcurrentWork() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-rich-controls", "--uitest-legacy-model-picker"]; app.launch()
        // The model lives in the composer's "+" menu with the other choices
        // that shape the next message.
        XCTAssertTrue(app.buttons["add-attachment"].waitForExistence(timeout: 15))
        chooseFromMenu(app, "add-attachment", "Model")
        let fixtureModel = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Fixture model")).firstMatch
        XCTAssertTrue(fixtureModel.waitForExistence(timeout: 8))
        for _ in 0..<10 where !fixtureModel.isHittable { usleep(200_000) }
        if fixtureModel.isHittable { fixtureModel.tap() }
        else { fixtureModel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        sleep(1)
        XCTAssertTrue(menuItemLabel(app, "add-attachment", "Model").contains("Fixture model"))
        // Running work shows as a capsule under Keir that opens the inbox.
        XCTAssertTrue(app.buttons["keir-activity-strip"].waitForExistence(timeout: 5))
        // The redesign starts chat at the top, where the needs-you stack already
        // holds the question. Wait for the model sheet to finish closing instead
        // of swiping during its transition.
        XCTAssertTrue(app.navigationBars["Conversation"].waitForNonExistence(timeout: 8))
        let choice = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Use filled jobs")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 10))
        if !choice.isHittable { app.swipeDown() }
        guard choice.isHittable else { XCTFail("the structured choice is not reachable"); return }
        choice.tap()
        let answer = app.buttons["keir-answer-choices"]
        for _ in 0..<6 where !answer.isHittable { app.swipeUp() }
        guard answer.isHittable else { XCTFail("send answers is not reachable"); return }
        answer.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "My answer: Use filled jobs")).firstMatch.waitForExistence(timeout: 10))
        capture(app, "Structured choice and parallel work")
    }

    /// Slash commands need a clean composer, so they get their own launch. The
    /// combined flow answered a question first, which left the keyboard and the
    /// chat in transition and made the composer query time out on CI.
    func testSlashCommandsOfferChart() {
        let app = launch()
        let composer = app.textFields["keir-composer"].exists ? app.textFields["keir-composer"] : app.textViews["keir-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("/chart")
        let command = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Graph data with sources")).firstMatch
        XCTAssertTrue(command.waitForExistence(timeout: 10))
        if !command.isHittable { app.swipeUp() }
        command.tap()
        XCTAssertTrue((composer.value as? String ?? "").contains("Show a chart"))
        capture(app, "Slash commands")
    }

    func testTicketExplainsBlockersAndCompletedWork() {
        let app = launch()
        go(app, "Ops"); openRow(app, "Support desk")
        let ticket = find(app, "Budget screen shows zero funding")
        XCTAssertTrue(ticket.waitForExistence(timeout: 10)); ticket.tap()
        XCTAssertTrue(find(app, "Choose payroll behavior").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Waiting for the owner decision").exists)
        XCTAssertTrue(find(app, "Filed issue #99").exists)
        capture(app, "Ticket blockers and Keir work")
    }

    /// Take, direct and hand back one ticket through the stateful supervision
    /// fixture. A half-typed direction left when the ticket is handed back must
    /// not ride along with the next take to a new worker.
    func testTicketSupervisionTakeDirectAndHandBack() {
        let app = launch()
        go(app, "Ops"); openRow(app, "Support desk")
        let ticket = find(app, "Budget screen shows zero funding")
        XCTAssertTrue(ticket.waitForExistence(timeout: 10)); ticket.tap()
        func button(_ id: String) -> XCUIElement {
            let element = app.buttons[id]
            XCTAssertTrue(element.waitForExistence(timeout: 10), "\(id) is offered")
            for _ in 0..<8 where !element.isHittable { app.swipeUp() }
            return element
        }
        func confirm(_ title: String) {
            let action = app.buttons[title]
            XCTAssertTrue(action.waitForExistence(timeout: 5), "confirmation offers \(title)")
            action.tap()
        }
        func directionField() -> XCUIElement {
            app.textFields["supervision-direction"].exists ? app.textFields["supervision-direction"] : app.textViews["supervision-direction"]
        }
        func type(_ text: String) {
            let field = directionField()
            XCTAssertTrue(field.waitForExistence(timeout: 10))
            if !field.isHittable { app.swipeUp() }
            field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() }
            field.typeText(text)
        }

        XCTAssertTrue(app.buttons["supervision-take"].exists || find(app, "Keir").waitForExistence(timeout: 10))
        button("supervision-take").tap()
        confirm("Take this ticket from the support desk")
        XCTAssertTrue(find(app, "Supervised worker").waitForExistence(timeout: 10))
        XCTAssertTrue(button("supervision-handback").exists)
        XCTAssertFalse(app.buttons["supervision-take"].exists, "one session at a time")

        type("Ask which turn the budget went to zero")
        app.buttons["Send direction"].tap()
        XCTAssertTrue(find(app, "Ask which turn the budget went to zero").waitForExistence(timeout: 10), "the direction is listed for this worker")
        XCTAssertFalse((directionField().value as? String ?? "").contains("Ask which turn"), "a sent direction leaves the box")
        capture(app, "Ticket supervised with a direction")

        // Start a direction, then hand the ticket back without sending it.
        type("Half written note")
        button("supervision-handback").tap()
        confirm("Hand this ticket back to the support desk")
        XCTAssertTrue(app.buttons["supervision-take"].exists || find(app, "Keir").waitForExistence(timeout: 10))
        XCTAssertFalse(directionField().exists, "no direction box without a worker")
        XCTAssertFalse(app.buttons["supervision-handback"].exists)
        XCTAssertTrue(find(app, "Last worker").exists, "the retired worker stays visible as history")

        // Taking it again starts a clean session: the unsent note went nowhere.
        button("supervision-take").tap()
        confirm("Take this ticket from the support desk")
        XCTAssertTrue(find(app, "Supervised worker").waitForExistence(timeout: 10))
        XCTAssertTrue(directionField().waitForExistence(timeout: 5))
        XCTAssertFalse((directionField().value as? String ?? "").contains("Half written note"), "the draft was discarded at hand back")
        XCTAssertFalse(find(app, "Half written note", timeout: 2).exists, "the unsent draft never reached the new worker")
        XCTAssertFalse(find(app, "Ask which turn the budget went to zero", timeout: 2).exists, "the earlier worker's directions are not shown as this worker's")
        capture(app, "Ticket taken again cleanly")
    }

    func testComputerInputUncertaintyInspectionAndClose() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-computer"]; app.launch()
        XCTAssertTrue(app.buttons["keir-tools"].waitForExistence(timeout: 15))
        openTool(app, "Computer history", destinationTitle: "Computer")
        let browser = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Fixture browser")).firstMatch
        XCTAssertTrue(browser.waitForExistence(timeout: 5)); browser.tap()
        let enter = app.buttons["Enter"]
        XCTAssertTrue(enter.waitForExistence(timeout: 5)); if !enter.isHittable { app.swipeUp() }; enter.tap()
        let refresh = app.buttons["Refresh browser screen"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 8)); if !refresh.isHittable { app.swipeUp() }; refresh.tap()
        let inspected = app.buttons["I inspected the result. Allow new input."]
        XCTAssertTrue(inspected.waitForExistence(timeout: 5)); inspected.tap()
        let close = app.buttons["Close browser and delete its profile"]
        XCTAssertTrue(close.waitForExistence(timeout: 5)); if !close.isHittable { app.swipeUp() }; close.tap()
        XCTAssertTrue(find(app, "Saved result").waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Enter"].exists)
    }

    func testCancelledComputerInspectionAndExplicitDiscard() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-computer", "--uitest-computer-cancelled"]; app.launch()
        XCTAssertTrue(app.buttons["keir-tools"].waitForExistence(timeout: 15))
        openTool(app, "Computer history", destinationTitle: "Computer")
        let browser = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Fixture browser")).firstMatch
        XCTAssertTrue(browser.waitForExistence(timeout: 5)); browser.tap()
        XCTAssertTrue(find(app, "Needs inspection").waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Enter"].exists)
        let discard = app.buttons["Discard retained browser"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5)); if !discard.isHittable { app.swipeUp() }; discard.tap()
        let confirm = app.buttons["Discard browser and profile"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
        XCTAssertTrue(find(app, "Saved result").waitForExistence(timeout: 5))
    }

    func testKeirUnavailableKeepsDraftAndRetriesConnection() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-keir-offline"]; app.launch()
        XCTAssertTrue(app.staticTexts["keir-connection-state"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["keir-retry-connection"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["What needs my attention right now?"].exists)
        let composer = app.textFields["keir-composer"].exists ? app.textFields["keir-composer"] : app.textViews["keir-composer"]
        composer.tap(); app.typeText("Keep this draft")
        app.buttons["keir-send"].tap()
        XCTAssertTrue((composer.value as? String ?? "").contains("Keep this draft"))
        app.buttons["keir-retry-connection"].tap()
        XCTAssertTrue((composer.value as? String ?? "").contains("Keep this draft"))
        XCTAssertTrue(app.buttons["keir-retry-connection"].waitForExistence(timeout: 5))
    }

    func testKeirDashboardMetricsAndMonitoring() {
        let app = launch()
        go(app, "Ops"); openRow(app, "Dashboard")
        XCTAssertTrue(app.navigationBars["Keir dashboard"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Activations, 46"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Median activation, 12s"].exists)
        capture(app, "Keir dashboard execution metrics")
        // LabeledContent exposes one accessible label/value pair. Match both
        // so a visible title with an incorrect or missing value cannot pass.
        for title in ["Distinct root tickets, 4", "Median time to closure, 1.0h", "Requests classified, 31", "Open findings, 3"] {
            let row = app.staticTexts[title]
            for _ in 0..<12 { if row.exists && row.isHittable { break }; app.swipeUp() }
            guard row.exists && row.isHittable else { capture(app, "Missing dashboard metric"); XCTFail("Dashboard must expose \(title)"); return }
            capture(app, title)
        }
        capture(app, "Keir dashboard monitoring")
    }

    func testKeirDashboardDoesNotInventMissingMetrics() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-metrics-partial"]; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Ops"].waitForExistence(timeout: 15))
        go(app, "Ops"); openRow(app, "Dashboard")
        XCTAssertTrue(app.staticTexts["Median activation, Not recorded"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Successful activations, No sample"].waitForExistence(timeout: 5))
        for _ in 0..<10 {
            if app.staticTexts["No shadow quality sample yet."].exists { break }
            app.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["No shadow quality sample yet."].exists)
        capture(app, "Keir dashboard missing samples")
    }

    func testNativeSignInAndCancellation() {
        let app = XCUIApplication(); app.launch()
        let signIn = app.buttons["sign-in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertEqual(app.webViews.count, 0)
        capture(app, "Sign in")
        signIn.tap()
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testActivityLoadsCanonicalDecisionsAndShowsExactScope() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-action-scope"]; app.launch()
        go(app, "Activity")
        XCTAssertTrue(app.buttons["decision-approve"].waitForExistence(timeout: 10))
        let review = app.buttons["Review full action and scope"]
        XCTAssertTrue(review.exists); review.tap()
        XCTAssertTrue(review.isHittable, "Expanding scope must stay in Activity instead of opening the task")
        let scope = app.staticTexts["decision-scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        for _ in 0..<3 where !scope.isHittable { app.swipeUp() }
        XCTAssertTrue(scope.isHittable, "The owner must be able to see the exact scope")
        XCTAssertTrue(scope.label.contains("fixture/repository"))
        XCTAssertTrue(scope.label.contains("fixture-exact-head"))
        capture(app, "Exact decision scope in Activity")
    }


    // MARK: Chat shell evidence

    private func launch(appearance: String, _ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-fixtures", "-appearance", appearance] + extra
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 20), appearance)
        return app
    }

    func testCriticScreens() {
        let app = launch(appearance: "dark", ["--uitest-eight-screens", "--uitest-reset-resume"])
        XCTAssertTrue(composer(app).waitForExistence(timeout: 12))
        XCTAssertTrue(find(app, "What needs my attention?", timeout: 5).exists)
        app.swipeDown()
        capture(app, "OLED Chat top")

        go(app, "Ops")
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 8))
        XCTAssertTrue(find(app, "Failing checks", timeout: 5).exists)
        capture(app, "OLED Ops top")

        go(app, "Activity")
        let blocked = app.buttons["work-filter-stuck"]
        XCTAssertTrue(blocked.waitForExistence(timeout: 8))
        capture(app, "OLED Inbox all top")
        blocked.tap()
        let ticket = app.buttons["work-row-1868"]
        if reveal(app, ticket, swipes: 4) {
            ticket.tap()
            XCTAssertTrue(find(app, "Massive drop in revenue", timeout: 8).exists)
            capture(app, "OLED Ticket 1868 top")
        } else { XCTFail("Ticket #1868 is missing from Blocked") }

        go(app, "Keir")
        openTool(app, "Connected games")
        let game = app.buttons["keir-game-metroforge"]
        if game.waitForExistence(timeout: 8) {
            game.tap()
            XCTAssertTrue(find(app, "Preview site", timeout: 8).exists)
            capture(app, "OLED Connected games top")
        }
    }

    func testReviewScreensInLight() { captureReviewScreens("light", "Light") }
    func testReviewScreensInOLED() { captureReviewScreens("dark", "OLED") }

    private func captureReviewScreens(_ appearance: String, _ theme: String) {
        continueAfterFailure = false
        let app = launch(appearance: appearance, ["--uitest-eight-screens", "--uitest-reset-resume"])
        func capturePage(_ title: String, scrolls: Int = 6) {
            capture(app, "\(theme) \(title) top")
            for _ in 0..<scrolls { app.swipeUp() }
            capture(app, "\(theme) \(title) bottom")
        }
        func returnToTabs() {
            app.terminate()
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 15))
        }
        let composer = composer(app)
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        for _ in 0..<5 { app.swipeDown() }
        capturePage("Chat")
        composer.tap()
        let chatKeyboard = app.keyboards.firstMatch
        XCTAssertTrue(chatKeyboard.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(composer.frame.maxY, chatKeyboard.frame.minY)
        capture(app, "\(theme) Chat keyboard")
        returnToTabs()

        go(app, "Ops")
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 10))
        capturePage("Ops")
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        capturePage("Settings")
        app.buttons["Done"].tap()

        go(app, "Activity")
        let blocked = app.buttons["work-filter-stuck"]
        XCTAssertTrue(blocked.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["work-filter-needs-you"].exists)
        capturePage("Inbox all")
        let search = app.searchFields.firstMatch
        for _ in 0..<6 where !search.isHittable { app.swipeDown() }
        XCTAssertTrue(search.isHittable)
        search.tap()
        let inboxKeyboard = app.keyboards.firstMatch
        XCTAssertTrue(inboxKeyboard.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(search.frame.maxY, inboxKeyboard.frame.minY)
        capture(app, "\(theme) Inbox all keyboard")
        returnToTabs()
        go(app, "Activity")
        XCTAssertTrue(blocked.waitForExistence(timeout: 10))
        blocked.tap()
        capturePage("Inbox blocked", scrolls: 3)
        for _ in 0..<6 { app.swipeDown() }
        openRow(app, "Massive drop in revenue turn 77-78", swipes: 6)
        XCTAssertTrue(find(app, "Massive drop in revenue turn").waitForExistence(timeout: 10))
        capturePage("Ticket 1868")

        go(app, "Ops")
        openRow(app, "Support desk")
        openRow(app, "Budget screen shows zero funding")
        XCTAssertTrue(find(app, "Budget screen shows zero funding").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Choose payroll behavior").exists)
        capture(app, "\(theme) Ticket 1001 top")
        let capacity = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "ticket-decision-1", "Capacity")).firstMatch
        XCTAssertTrue(reveal(app, capacity, swipes: 3), "The capacity choice is available inside the ticket")
        let filled = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "ticket-decision-2", "Filled jobs")).firstMatch
        XCTAssertTrue(filled.exists, "The filled-jobs choice appears next to capacity")
        for _ in 0..<6 { app.swipeUp() }
        capture(app, "\(theme) Ticket 1001 bottom")
        let take = app.buttons["supervision-take"]
        for _ in 0..<6 where !take.isHittable { app.swipeUp() }
        XCTAssertTrue(take.isHittable)
        take.tap()
        app.buttons["Take this ticket from the support desk"].tap()
        let direction = app.textFields["supervision-direction"].exists ? app.textFields["supervision-direction"] : app.textViews["supervision-direction"]
        XCTAssertTrue(direction.waitForExistence(timeout: 10))
        direction.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(direction.frame.maxY, keyboard.frame.minY)
        capture(app, "\(theme) Ticket 1001 keyboard")
        returnToTabs()

        go(app, "Keir")
        chooseFromMenu(app, "keir-tools", "Connected games", until: { app.navigationBars["Connected games"].exists })
        XCTAssertTrue(app.buttons["keir-game-metroforge"].waitForExistence(timeout: 10))
        app.buttons["keir-game-metroforge"].tap()
        XCTAssertTrue(find(app, "Preview site").waitForExistence(timeout: 10))
        capturePage("Connected games")
    }

    /// The chat on a phone in both themes: a conversation with history, the two
    /// menus, the theme setting, the empty start, the inbox and large text.
    /// Every screen is kept as a test attachment for review. "dark" is the
    /// value an earlier build saved, so this also proves it now means OLED black.
    func testChatShellInLightAndOLEDThemes() {
        for (appearance, name) in [("light", "Light"), ("dark", "OLED")] {
            var app = launch(appearance: appearance)
            XCTAssertTrue(find(app, "How did the last turn go?").waitForExistence(timeout: 10), name)
            for id in ["keir-tools", "keir-threads", "keir-microphone", "add-attachment"] {
                XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 5) && app.buttons[id].isHittable, "\(id) is reachable in \(name)")
            }
            XCTAssertTrue(app.tabBars.buttons["Inbox"].exists && app.tabBars.buttons["Ops"].exists, "the dock reaches the other places")
            XCTAssertFalse(app.buttons["Stop Keir"].exists, "stop is behind Keir's menu, not on the chat")
            XCTAssertFalse(app.buttons["keir-send-mode"].exists, "routing is behind the composer menu")
            XCTAssertFalse(app.otherElements["keir-context-bar"].exists, "no chip strip under the title")
            sleep(2) // Keir's greeting animation finishes
            capture(app, "\(name) chat")

            app.buttons["keir-tools"].tap()
            XCTAssertTrue(app.buttons["Connected games"].waitForExistence(timeout: 5), name)
            XCTAssertTrue(app.buttons["Stop Keir"].exists, "stop is one deliberate tap away")
            capture(app, "\(name) Keir menu")
            dismissMenu(app, closing: app.buttons["Stop Keir"])

            app.buttons["add-attachment"].tap()
            XCTAssertTrue(app.buttons["Photo library"].waitForExistence(timeout: 5), name)
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model")).firstMatch.exists, "model is in the composer menu")
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Send as")).firstMatch.exists, "routing is in the composer menu")
            capture(app, "\(name) composer menu")
            dismissMenu(app, closing: app.buttons["Photo library"])

            go(app, "Ops")
            app.buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 8), name)
            let expected = appearance == "dark" ? "OLED black" : "Light"
            let picker = app.buttons["settings-theme"]
            for _ in 0..<6 where !(picker.exists && picker.isHittable) { app.swipeUp() }
            let shown = picker.exists ? "\(picker.label) \(picker.value as? String ?? "")" : (find(app, expected, timeout: 2).exists ? expected : "")
            XCTAssertTrue(shown.contains(expected), "the saved theme shows as \(expected), found \(shown)")
            capture(app, "\(name) theme setting")
            app.buttons["Done"].firstMatch.tap()

            app.tabBars.buttons["Inbox"].tap()
            XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), name)
            capture(app, "\(name) inbox")
            app.terminate()

            app = launch(appearance: appearance, ["--uitest-empty-keir", "--uitest-reset-resume"])
            XCTAssertTrue(app.buttons["keir-microphone"].waitForExistence(timeout: 15), name)
            sleep(2)
            capture(app, "\(name) empty chat")
            app.terminate()

            app = launch(appearance: appearance, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
            XCTAssertTrue(find(app, "How did the last turn go?").waitForExistence(timeout: 10), name)
            for id in ["keir-tools", "keir-threads", "keir-microphone", "add-attachment"] {
                XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 5) && app.buttons[id].isHittable, "\(id) is reachable with large text in \(name)")
            }
            XCTAssertTrue(app.textFields["keir-composer"].exists || app.textViews["keir-composer"].exists)
            capture(app, "\(name) chat, large text")
            app.terminate()
        }
    }

    /// Typing turns the microphone into send, and the routing choice shows
    /// above the composer only when it is not the default.
    func testComposerSwapsMicrophoneForSendAndShowsRouting() {
        let app = launch()
        XCTAssertTrue(app.buttons["keir-microphone"].waitForExistence(timeout: 10), "an empty composer offers voice input")
        XCTAssertFalse(app.buttons["keir-send"].exists, "nothing to send yet")
        XCTAssertFalse(app.otherElements["keir-route-chip"].exists)
        let box = composer(app)
        box.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { box.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap() }
        app.typeText("Draft")
        XCTAssertTrue(app.buttons["keir-send"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["keir-microphone"].exists)
        capture(app, "Composer ready to send")
        chooseFromMenu(app, "add-attachment", "Send as")
        let followUp = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Follow up")).firstMatch
        XCTAssertTrue(followUp.waitForExistence(timeout: 5)); followUp.tap()
        let chip = app.descendants(matching: .any)["keir-route-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "a non-default route is visible before sending")
        capture(app, "Composer with follow-up routing")
        app.buttons["Send as a new task instead"].tap()
        XCTAssertTrue(chip.waitForNonExistence(timeout: 5))
        XCTAssertEqual(composer(app).value as? String, "Draft", "changing the route keeps the draft")
    }

    // MARK: Personal start and resume

    private func composer(_ app: XCUIApplication) -> XCUIElement {
        app.textFields["keir-composer"].exists ? app.textFields["keir-composer"] : app.textViews["keir-composer"]
    }
    private func waitForThreadTitle(_ app: XCUIApplication, _ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = app.buttons["keir-threads"]
        XCTAssertTrue(button.waitForExistence(timeout: 15), file: file, line: line)
        expectation(for: NSPredicate(format: "label CONTAINS %@", title), evaluatedWith: button)
        waitForExpectations(timeout: 15)
    }
    private func launchFresh(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"] + extra; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 15))
        return app
    }
    private func openBondMarket(_ app: XCUIApplication) {
        let threads = app.buttons["keir-threads"]
        XCTAssertTrue(threads.waitForExistence(timeout: 10))
        for _ in 0..<3 { if threads.isHittable { break }; sleep(1) }
        threads.tap()
        let row = find(app, "Bond market")
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        waitForThreadTitle(app, "Bond market")
    }

    func testKeirReopensTheLastPrivateConversationAfterForceQuit() {
        var app = launchFresh(["--uitest-reset-resume"])
        waitForThreadTitle(app, "Keir")
        openBondMarket(app)
        sleep(1)
        app.terminate()
        app = launchFresh(["--uitest-keep-resume"])
        waitForThreadTitle(app, "Bond market")
    }

    func testResumeForgetsAThreadThatIsNoLongerListed() {
        var app = launchFresh(["--uitest-reset-resume"])
        openBondMarket(app)
        sleep(1)
        app.terminate()
        app = launchFresh(["--uitest-resume-archived", "--uitest-keep-resume"])
        waitForThreadTitle(app, "Keir")
        XCTAssertFalse(app.buttons["keir-threads"].label.contains("Bond market"))
        sleep(1)
        app.terminate()
        // The unlisted thread was forgotten, not just hidden: it stays gone when it is listed again.
        app = launchFresh(["--uitest-keep-resume"])
        waitForThreadTitle(app, "Keir")
        XCTAssertFalse(app.buttons["keir-threads"].label.contains("Bond market"))
    }

    func testEmptyConversationOffersVoiceAndAnEditableTicketFollowUp() {
        let app = launchFresh(["--uitest-empty-keir", "--uitest-reset-resume"])
        XCTAssertTrue(app.buttons["keir-microphone"].waitForExistence(timeout: 15))
        let ticket = app.buttons["keir-start-ticket"]
        XCTAssertTrue(ticket.waitForExistence(timeout: 15), "a ticket with no recorded reply is offered")
        XCTAssertFalse(app.buttons["decision-approve"].exists, "An unrelated studio approval belongs in Inbox")
        XCTAssertTrue(ticket.label.contains("1001"))
        XCTAssertTrue(find(app, "Awaiting first reply").exists)
        capture(app, "Keir personal iPhone start")
        ticket.tap()
        let box = composer(app)
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        let draft = box.value as? String ?? ""
        XCTAssertTrue(draft.contains("Ticket #1001"), "the suggestion lands in the composer: \(draft)")
        XCTAssertTrue(draft.contains("Don't message the player"))
        XCTAssertTrue(ticket.exists, "nothing was sent")
        box.tap()
        box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count))
        chooseFromMenu(app, "keir-microphone", "Voice conversation", until: { app.staticTexts["Keir voice"].exists })
        XCTAssertTrue(app.staticTexts["Keir voice"].waitForExistence(timeout: 5), "the invitation opens the existing voice mode")
        app.buttons["End voice mode"].tap()
    }

    func testTicketSuggestionNeverReplacesATypedDraft() {
        let app = launchFresh(["--uitest-empty-keir", "--uitest-reset-resume"])
        let ticket = app.buttons["keir-start-ticket"]
        XCTAssertTrue(ticket.waitForExistence(timeout: 15))
        let box = composer(app)
        XCTAssertTrue(box.waitForExistence(timeout: 5)); box.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { box.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap() }
        app.typeText("My own words")
        XCTAssertFalse(ticket.isEnabled, "a typed draft is protected")
        XCTAssertEqual(composer(app).value as? String, "My own words")
    }

    func testTicketFollowUpStaysReachableInAConversationWithHistory() {
        let app = launchFresh()
        XCTAssertTrue(find(app, "How did the last turn go?").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["add-attachment"].waitForExistence(timeout: 15))
        capture(app, "Keir personal iPhone conversation")
        // Ticket drafts sit in the composer's "+" menu once there is history.
        // The submenu tap can be dropped while the "+" menu is still animating
        // (CI log: the entry was tapped and #1001 never appeared). Choose again
        // until the tickets are listed.
        chooseFromMenu(app, "add-attachment", "Ticket follow-ups", until: { self.find(app, "#1001", timeout: 1).exists })
        let item = find(app, "#1001")
        XCTAssertTrue(item.waitForExistence(timeout: 5)); item.tap()
        let draft = composer(app).value as? String ?? ""
        XCTAssertTrue(draft.contains("Ticket #1001"))
        XCTAssertTrue(find(app, "How did the last turn go?").exists, "nothing was sent")
    }

}
