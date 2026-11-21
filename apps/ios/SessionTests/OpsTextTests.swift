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

    func testTicketHeldOnADecisionNeedsYouOnceAndOnlyWithoutADecisionRow() {
        let center = AttentionCenter.shared
        center.reset()
        let decision: JSONValue = .object(["id": .string("d1"), "tldr": .string("Merge #201"), "ticket": .number(1651)])
        let covered: JSONValue = .object(["number": .number(1651), "title": .string("Fund fix"), "status": .string("open"), "decisionPending": .bool(true)])
        let held: JSONValue = .object(["number": .number(1700), "title": .string("Payroll"), "status": .string("open"), "timing": .object(["state": .string("needs-you")])])
        let heldAgain: JSONValue = .object(["number": .string("1700"), "title": .string("Payroll"), "status": .string("open"), "decisionPending": .bool(true)])
        let closed: JSONValue = .object(["number": .number(1800), "title": .string("Done"), "status": .string("closed"), "decisionPending": .bool(true)])
        let running: JSONValue = .object(["number": .number(1900), "title": .string("Busy"), "status": .string("open"), "timing": .object(["state": .string("working")])])
        center.setWork(decisions: [decision], ownerWork: [], tickets: [covered, held, heldAgain, closed, running])
        XCTAssertEqual(center.items.map(\.id), ["decision:d1", "ticket:1700"])
        XCTAssertEqual(center.decisionCount, 2)
        XCTAssertEqual(center.items.last?.kind, .ticket)
        XCTAssertEqual(center.items.last?.ticketNumber, 1700)
        center.reset()
    }

    func testOpsHeartbeatOnlyCallsActivityLiveWhileItIsRecent() {
        let store = OpsStore()
        XCTAssertEqual(store.heartbeat(), .connecting)
        let now = Date()
        store.updated = now
        store.activityUpdated = now
        XCTAssertEqual(store.heartbeat(now: now), .fresh(now))
        let old = now.addingTimeInterval(-(OpsStore.staleAfter + 60))
        store.activityUpdated = old
        XCTAssertEqual(store.heartbeat(now: now), .stalled(old))
        XCTAssertTrue(store.heartbeatSentence(now: now).hasPrefix("Updates stalled."))
        store.updated = nil
        store.error = "Ops is unreachable. Pull to retry."
        XCTAssertEqual(store.heartbeat(now: now), .unreachable)
    }

    func testAttentionSearchMatchesTicketNumberAndTitle() {
        let center = AttentionCenter.shared
        center.reset()
        let held: JSONValue = .object(["number": .number(1700), "title": .string("Payroll path"), "status": .string("open"), "decisionPending": .bool(true)])
        center.setWork(decisions: [], ownerWork: [], tickets: [held])
        let item = center.items[0]
        XCTAssertTrue(item.matches(""))
        XCTAssertTrue(item.matches("#1700"))
        XCTAssertTrue(item.matches("payroll"))
        XCTAssertFalse(item.matches("ledger"))
        center.reset()
    }
}
