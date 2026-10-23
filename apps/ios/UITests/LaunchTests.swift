import XCTest

/// Lakeside Ops UI tests. Every test runs against built-in fixtures and never
/// contacts a server. Rows that are buttons or navigation links expose one
/// combined label, so lookups match on label text rather than exact static text.
final class LaunchTests: XCTestCase {
    private func launch() -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        XCTAssertTrue(app.tabBars.buttons["Keir"].waitForExistence(timeout: 15))
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
    /// Opens a row in the Ops list by the start of its combined label, scrolling
    /// the list until the row is actually hittable.
    private func openRow(_ app: XCUIApplication, _ title: String, timeout: TimeInterval = 12) {
        let matches = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title))
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let row = matches.firstMatch
            if row.exists && row.isHittable { row.tap(); return }
            app.swipeUp()
        } while Date() < deadline
        let fallback = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if fallback.exists { fallback.tap(); return }
        XCTFail("Ops row \(title) is missing")
    }
    private func digits(_ text: String) -> String {
        text.filter(\.isNumber)
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }

    func testIdeasSwipeTriage() {
        let app = launch()
        app.tabBars.buttons["Ops"].tap()
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
        XCTAssertTrue(app.tabBars.buttons["Keir"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["keir-working-now"].waitForExistence(timeout: 15))
        capture(app, "After Keir")
        app.buttons["keir-tools"].tap()
        sleep(1)
        capture(app, "After Keir menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)).tap()
        sleep(1)
        app.tabBars.buttons["Feed"].tap()
        XCTAssertTrue(app.navigationBars["Feed"].waitForExistence(timeout: 10))
        sleep(1)
        capture(app, "After Feed")
        app.tabBars.buttons["Ops"].tap()
        XCTAssertTrue(app.navigationBars["Ops"].waitForExistence(timeout: 10))
        sleep(1)
        capture(app, "After Ops")
    }

    func testAccessibilityTextSizeKeepsPrimaryActionsReachable() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-fixtures", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Feed"].waitForExistence(timeout: 20))
        app.tabBars.buttons["Feed"].tap()
        let feedAction = app.buttons["feed-review-attention"]
        XCTAssertTrue(feedAction.waitForExistence(timeout: 15))
        XCTAssertTrue(feedAction.isHittable, "the primary action stays reachable at accessibility sizes")
        capture(app, "Feed at accessibility text size")
        app.tabBars.buttons["Ops"].tap()
        let opsAction = app.buttons["ops-review-attention"]
        XCTAssertTrue(opsAction.waitForExistence(timeout: 15))
        XCTAssertTrue(opsAction.isHittable)
        capture(app, "Ops at accessibility text size")
        app.tabBars.buttons["Keir"].tap()
        XCTAssertTrue(app.textFields["keir-composer"].waitForExistence(timeout: 10) || app.textViews["keir-composer"].exists)
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
        app.tabBars.buttons["Feed"].tap()
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
        app.tabBars.buttons["Goals"].tap()
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
        app.tabBars.buttons["Activity"].tap()
        XCTAssertTrue(app.buttons["work-filter-stuck"].waitForExistence(timeout: 10))
        app.buttons["work-filter-stuck"].tap()
        XCTAssertTrue(find(app, "Verify an interrupted action").waitForExistence(timeout: 10))
        XCTAssertFalse(find(app, "Bond coupon ledger", timeout: 1).exists)
        capture(app, "Ticket queue filtered to stuck work")
        app.buttons["work-filter-waiting"].tap()
        XCTAssertTrue(find(app, "Bond coupon ledger").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Read the check result").exists)
        XCTAssertTrue(find(app, "Check in").exists)
        XCTAssertTrue(find(app, "Completion time not established").exists)
        capture(app, "Ticket queue with timed wait and next milestone")
    }

    func testActivityApprovalsPlanAndLiveWork() {
        let app = launch()
        app.tabBars.buttons["Activity"].tap()
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
        app.tabBars.buttons["Ops"].tap()
        // Needs you lists only decisions and owner work; a degraded service is a
        // health fact, not an owner decision, and never appears as a separate list.
        XCTAssertTrue(find(app, "Merge #201 to development").waitForExistence(timeout: 10))
        XCTAssertFalse(find(app, "Lakeside Ask is degraded").exists)
        capture(app, "Ops briefing")
        openRow(app, "Health detail")
        XCTAssertTrue(app.navigationBars["Health"].waitForExistence(timeout: 10))
        capture(app, "Health detail")
        app.navigationBars.buttons.firstMatch.tap()
        openRow(app, "Support desk")
        XCTAssertTrue(find(app, "Budget screen shows zero funding").waitForExistence(timeout: 10))
        capture(app, "Desk")
        app.navigationBars.buttons.firstMatch.tap()
        openRow(app, "Work in progress")
        XCTAssertTrue(find(app, "Keir chat in Lakeside Ops").waitForExistence(timeout: 10))
        capture(app, "Work")
        app.navigationBars.buttons.firstMatch.tap()
        openRow(app, "Files")
        let report = find(app, "Turn time breakdown")
        XCTAssertTrue(report.waitForExistence(timeout: 10)); report.tap()
        XCTAssertTrue(find(app, "Settlement took 15.6s").waitForExistence(timeout: 10))
        capture(app, "File")
    }

    func testOpsSystemsDrillDowns() {
        let app = launch()
        app.tabBars.buttons["Ops"].tap()
        for (row, title, evidence) in [
            ("Scheduler", "Scheduler", "ios-simulator"),
            ("Security", "Security", "fail2ban recidive jail"),
            ("Pull requests", "Pull requests", "Pull requests"),
            ("Worktrees and agents", "Worktrees", "Keir mobile briefing"),
            ("World simulations", "World sims", "seed-1991"),
            ("Backups and database", "Backups", "2026-10-15"),
            ("Event recovery", "Event recovery", "Receipt store timed out")
        ] {
            openRow(app, row)
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "\(row) did not open")
            if row != "Pull requests" { XCTAssertTrue(find(app, evidence).waitForExistence(timeout: 10), "\(row) is missing \(evidence)") }
            capture(app, row)
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.tabBars.buttons["Ops"].waitForExistence(timeout: 5))
        }
    }

    func testAttentionCountsMatchAcrossScreens() {
        let app = launch()
        app.tabBars.buttons["Feed"].tap()
        let feedButton = app.buttons["feed-review-attention"]
        XCTAssertTrue(feedButton.waitForExistence(timeout: 10))
        let feedCount = digits(feedButton.label)
        XCTAssertFalse(feedCount.isEmpty)
        XCTAssertEqual(app.staticTexts["feed-attention-count"].label, feedCount)
        app.tabBars.buttons["Ops"].tap()
        let opsButton = app.buttons["ops-review-attention"]
        XCTAssertTrue(opsButton.waitForExistence(timeout: 10))
        XCTAssertEqual(digits(opsButton.label), feedCount, "Feed and Ops disagree on the count")
        XCTAssertEqual(app.staticTexts["ops-attention-count"].label, feedCount)
        app.tabBars.buttons["Keir"].tap()
        XCTAssertTrue(app.staticTexts["keir-attention-count"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["keir-attention-count"].label, feedCount, "Keir and Feed disagree on the count")
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
        app.tabBars.buttons["Ops"].tap()
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
        app.tabBars.buttons["Ops"].tap()
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
        app.tabBars.buttons["Keir"].tap()
        let threads = app.buttons["keir-threads"]
        XCTAssertTrue(threads.waitForExistence(timeout: 5))
        for _ in 0..<3 { if threads.isHittable { break }; sleep(1) }
        threads.tap()
        XCTAssertTrue(find(app, "Bond market").waitForExistence(timeout: 10))
        capture(app, "Threads")
    }

    func testNativeStopStartAndYoloControls() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        let kill = app.buttons["keir-kill-switch"]
        XCTAssertTrue(kill.waitForExistence(timeout: 15)); kill.tap()
        XCTAssertTrue(find(app, "Stopped").waitForExistence(timeout: 5))
        XCTAssertTrue(kill.label.contains("Start")); capture(app, "Keir stopped")
        kill.tap()
        XCTAssertTrue(kill.waitForExistence(timeout: 5)); XCTAssertTrue(kill.label.contains("Stop"))
        app.buttons["keir-tools"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Controls, providers")).firstMatch.tap()
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
        XCTAssertTrue(app.buttons["keir-model"].label.contains("Fixture model"))
        app.buttons["keir-microphone"].tap()
        XCTAssertTrue(app.staticTexts["Keir voice"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Microsoft Ava · online voice"].exists)
        capture(app, "Keir voice mode")
        app.buttons["End voice mode"].tap()
        XCTAssertTrue(app.textFields["keir-composer"].exists || app.textViews["keir-composer"].exists)
    }

    func testVoiceAcceptsLateAnswerAfterTimeout() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-late-voice"]; app.launch()
        XCTAssertTrue(app.buttons["keir-microphone"].waitForExistence(timeout: 15)); app.buttons["keir-microphone"].tap()
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
        XCTAssertTrue(app.tabBars.buttons["Activity"].isSelected)
    }

    func testCompactTablesAndProviderAvailability() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-table"]; app.launch()
        XCTAssertTrue(app.otherElements["markdown-table-cards"].firstMatch.waitForExistence(timeout: 12) || find(app, "Tech tree").waitForExistence(timeout: 5))
        XCTAssertTrue(find(app, "Implementation is waiting on the assigned developer").exists)
        XCTAssertFalse(find(app, "What are we working on?").exists)
        capture(app, "Compact phone table")
        app.buttons["keir-tools"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Controls, providers")).firstMatch.tap()
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
        app.tabBars.buttons["Goals"].tap()
        XCTAssertTrue(find(app, "Keep replies under five seconds").waitForExistence(timeout: 10))
        app.buttons["Review goal"].tap()
        XCTAssertTrue(app.textFields["goal-title"].exists || app.textViews["goal-title"].exists)
        capture(app, "Review suggested goal")
    }

    func testChoicesModelSwitchAndConcurrentWork() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-rich-controls", "--uitest-legacy-model-picker"]; app.launch()
        XCTAssertTrue(app.buttons["keir-model"].waitForExistence(timeout: 15))
        app.buttons["keir-model"].tap()
        let fixtureModel = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Fixture model")).firstMatch
        XCTAssertTrue(fixtureModel.waitForExistence(timeout: 8))
        for _ in 0..<10 where !fixtureModel.isHittable { usleep(200_000) }
        if fixtureModel.isHittable { fixtureModel.tap() }
        else { fixtureModel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssertTrue(app.buttons["keir-model"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["keir-model"].label.contains("Fixture model"))
        XCTAssertTrue(app.buttons["keir-activity-strip"].waitForExistence(timeout: 5))
        let choice = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Use filled jobs")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        for _ in 0..<20 { if choice.isHittable { break }; usleep(250_000) }
        if !choice.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(choice.isHittable); choice.tap()
        app.buttons["keir-answer-choices"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "My answer: Use filled jobs")).firstMatch.waitForExistence(timeout: 10))
        capture(app, "Structured choice and parallel work")
        let composer = app.textFields["keir-composer"].exists ? app.textFields["keir-composer"] : app.textViews["keir-composer"]
        composer.tap(); app.typeText("/chart")
        let command = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Graph data with sources")).firstMatch
        XCTAssertTrue(command.waitForExistence(timeout: 10))
        if !command.isHittable { app.swipeUp() }
        command.tap()
        XCTAssertTrue((composer.value as? String ?? "").contains("Show a chart"))
        capture(app, "Slash commands")
    }

    func testTicketExplainsBlockersAndCompletedWork() {
        let app = launch()
        app.tabBars.buttons["Ops"].tap(); openRow(app, "Support desk")
        let ticket = find(app, "Budget screen shows zero funding")
        XCTAssertTrue(ticket.waitForExistence(timeout: 10)); ticket.tap()
        XCTAssertTrue(find(app, "Choose payroll behavior").waitForExistence(timeout: 10))
        XCTAssertTrue(find(app, "Waiting for the owner decision").exists)
        XCTAssertTrue(find(app, "Filed issue #99").exists)
        capture(app, "Ticket blockers and Keir work")
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
        app.tabBars.buttons["Ops"].tap(); openRow(app, "Dashboard")
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
        app.tabBars.buttons["Ops"].tap(); openRow(app, "Dashboard")
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
        let signIn = app.buttons["Sign in to Lakeside"]
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
        app.tabBars.buttons["Activity"].tap()
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

}
