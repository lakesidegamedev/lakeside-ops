import XCTest
import LakesideCore
@testable import LakesideOps

@MainActor final class KeirControlTests: XCTestCase {
    func testSpokenRepliesReadProseWithoutMarkdownOrCode() {
        let input = "## Update\n**Done**: [review the change](https://example.com/private).\n\n```swift\nlet secret = 1\n```"
        let spoken = KeirVoice.spokenText(input)
        XCTAssertTrue(spoken.contains("Done: review the change."))
        XCTAssertTrue(spoken.contains("Code is shown in the conversation."))
        XCTAssertFalse(spoken.contains("https://"))
        XCTAssertFalse(spoken.contains("secret"))
        XCTAssertFalse(spoken.contains("**"))
    }
    func testEmptySpokenReplyAndControlDefaults() {
        XCTAssertEqual(KeirVoice.spokenText("   \n"), "")
        let voice = KeirVoice(); XCTAssertFalse(voice.preparingSpeech); XCTAssertFalse(voice.speaking)
        let store = KeirStore()
        XCTAssertFalse(store.stopped); XCTAssertFalse(store.yolo)
        XCTAssertEqual(store.controls, .null)
        XCTAssertTrue(KeirCommand.all.contains { $0.id == "/stop" })
        XCTAssertTrue(KeirCommand.all.contains { $0.id == "/skills" })
    }
    func testPhoneTableKeepsEmptyColumnsAndLongText() {
        let rows = MarkdownTable.rows("| Ticket | Status | Owner |\n| --- | --- | --- |\n| 1560 | Waiting for a verified coordinator handoff | |")
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[1], ["1560", "Waiting for a verified coordinator handoff", ""])
    }
    func testProviderChoicesCollapseEffortVariantsAndKeepSelectedRoute() {
        let options: [JSONValue] = [.object(["id": .string("codex:model@low")]), .object(["id": .string("codex:model@high")]), .object(["id": .string("claude:sonnet")])]
        let choices = KeirProviderName.choices(options, selected: "codex:model@high")
        XCTAssertEqual(choices.count, 2)
        XCTAssertTrue(choices.contains { $0["id"].string == "codex:model@high" })
        XCTAssertFalse(choices.contains { $0["id"].string == "codex:model@low" })
    }

    func testCursorAutoLabelAndProviderManagedEffortFollowInstallationDefault() {
        let options: [JSONValue] = [.object(["id": .string("cursor:auto"), "label": .string("Cursor Auto"), "effortMode": .string("provider-managed")])]
        XCTAssertEqual(KeirProviderName.label("cursor:auto", options: []), "Cursor Auto")
        XCTAssertTrue(KeirProviderName.providerManaged("cursor:auto", options: options, defaultRoute: "claude:sonnet"))
        XCTAssertTrue(KeirProviderName.providerManaged("auto", options: options, defaultRoute: "cursor:auto"))
        XCTAssertFalse(KeirProviderName.providerManaged("claude:sonnet", options: options, defaultRoute: "cursor:auto"))
    }

}
