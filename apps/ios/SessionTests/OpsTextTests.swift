import XCTest
import LakesideCore
@testable import LakesideOps

final class OpsTextTests: XCTestCase {
    func testServiceUptimeIsAlreadyAPercentage() {
        XCTAssertEqual(OpsFormat.percentValue(98.1), "98.10%")
        XCTAssertEqual(OpsFormat.percentValue(100), "100.00%")
        XCTAssertEqual(OpsFormat.percentValue(nil), "-")
        XCTAssertEqual(OpsFormat.percent(0.981), "98%", "fractions still use the 0 to 1 formatter")
    }

    func testScrubRemovesEmptyTemplateArtifacts() {
        XCTAssertEqual(OpsText.scrub("It me or turn been stuck in processing: started. Was:."), "")
        XCTAssertEqual(OpsText.scrub("Ticket: started... Was:."), "")
        XCTAssertEqual(OpsText.scrub("Self-recovery: parked. Was: earlier diagnostic text"), "Self-recovery: parked.")
        XCTAssertEqual(OpsText.scrub("   "), "")
    }

    func testTicketNumberIsNotRepeated() {
        XCTAssertEqual(OpsText.deTicket("Ticket 1651: Ticket 1651 remains open", number: 1651), "remains open")
        XCTAssertEqual(OpsText.deTicket("Ticket 1651:", number: 1651), "", "an empty template is not a title")
        let template: JSONValue = .object([
            "kind": .string("started"), "ticket": .number(1651), "text": .string("Ticket 1651: .")
        ])
        XCTAssertEqual(OpsText.updateTitle(template), "#1651 Work started")
        let detail = OpsText.updateDetail(.object([
            "ticket": .number(1651),
            "text": .string("Ticket 1651, Fund fix: needs your decision.")
        ]))
        XCTAssertEqual(detail, "needs your decision.")
    }

    func testUpdateTitleUsesKindAndTicketNotProse() {
        let item: JSONValue = .object([
            "kind": .string("started"),
            "ticket": .number(1651),
            "text": .string("It me or turn been stuck in processing: started.")
        ])
        XCTAssertEqual(OpsText.updateTitle(item), "#1651 Work started")
        XCTAssertFalse(OpsText.updateTitle(item).contains("It me"))

        let update: JSONValue = .object([
            "kind": .string("needs-you"), "ticket": .number(1575),
            "text": .string("Ticket 1575, Factory demand refund: needs your decision.")
        ])
        XCTAssertEqual(OpsText.updateTitle(update), "#1575 Factory demand refund")
        XCTAssertEqual(OpsText.updateDetail(update), "needs your decision.")
    }

    func testDecisionTitleUsesOneCleanSentence() {
        let long: JSONValue = .object([
            "id": .string("d1"),
            "ticket": .number(1651),
            "question": .string(String(repeating: "Is this the right payroll behavior? ", count: 6))
        ])
        XCTAssertEqual(OpsText.decisionTitle(long), "Is this the right payroll behavior?")
    }
}

@MainActor
final class AttentionCenterTests: XCTestCase {
    func testOwnerWorkAlreadyCoveredByADecisionIsNotCountedTwice() {
        let center = AttentionCenter.shared
        center.reset()
        let decision: JSONValue = .object([
            "id": .string("d1"), "tldr": .string("Merge #201"), "ticket": .number(1651),
            "at": .number(1_792_000_000_000)
        ])
        let work: JSONValue = .object([
            "id": .string("w1"), "title": .string("Fund fix"), "ticket": .number(1651), "needs_owner": .bool(true)
        ])
        center.setWork(decisions: [decision], ownerWork: [work])
        center.setQuestions([])
        XCTAssertEqual(center.count, 1)
        XCTAssertEqual(center.items.first?.kind, .decision)
        XCTAssertEqual(center.summary, "1 thing needs you")

        let question: JSONValue = .object([
            "id": .string("q1"), "title": .string("Payroll behavior"), "state": .string("pending"),
            "questions": .array([.object(["id": .string("1"), "prompt": .string("Which payroll path?")])])
        ])
        center.setQuestions([question])
        XCTAssertEqual(center.count, 2)
        XCTAssertTrue(center.summary.contains("2"))
        center.reset()
    }
}
