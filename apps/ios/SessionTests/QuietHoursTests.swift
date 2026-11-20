import XCTest
import LakesideCore
@testable import LakesideOps

final class QuietHoursTests: XCTestCase {
    private func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }
    private let night = QuietHours(enabled: true, startMinutes: 22 * 60, endMinutes: 7 * 60, timeZone: "America/New_York")

    func testOffByDefaultAndSendsAsOff() {
        let quiet = QuietHours()
        XCTAssertFalse(quiet.enabled)
        XCTAssertFalse(quiet.isQuiet(at: date("2026-10-15T03:00:00Z")))
        XCTAssertEqual(quiet.payload, .object(["enabled": .bool(false)]))
    }

    func testOvernightWindowInTheChosenZone() {
        XCTAssertTrue(night.isQuiet(at: date("2026-10-15T02:30:00Z")))   // 22:30 EDT
        XCTAssertFalse(night.isQuiet(at: date("2026-10-15T14:00:00Z")))  // 10:00 EDT
        XCTAssertTrue(night.isQuiet(at: date("2026-10-15T10:59:00Z")))   // 06:59 EDT
        XCTAssertFalse(night.isQuiet(at: date("2026-10-15T11:00:00Z")))  // 07:00 EDT, end is exclusive
    }

    func testDaylightSavingFollowsTheWallClock() {
        XCTAssertTrue(night.isQuiet(at: date("2026-11-01T11:30:00Z")))   // 06:30 EST, after fall back
        XCTAssertFalse(night.isQuiet(at: date("2026-11-01T12:00:00Z")))  // 07:00 EST
        XCTAssertTrue(night.isQuiet(at: date("2026-03-08T10:30:00Z")))   // 06:30 EDT, after spring forward
        XCTAssertFalse(night.isQuiet(at: date("2026-03-08T11:00:00Z")))  // 07:00 EDT
    }

    func testPayloadMatchesTheServerShapeAndRejectsUnusableWindows() {
        XCTAssertEqual(night.payload, .object(["enabled": .bool(true), "start": .string("22:00"), "end": .string("07:00"), "tz": .string("America/New_York")]))
        var same = night; same.endMinutes = same.startMinutes
        XCTAssertEqual(same.payload, .object(["enabled": .bool(false)]))
        var zone = night; zone.timeZone = "Mars/Base"
        XCTAssertEqual(zone.payload, .object(["enabled": .bool(false)]))
        XCTAssertFalse(zone.isQuiet(at: date("2026-10-15T03:00:00Z")))
    }

    func testSettingsWordingNeverPromisesAnApprovalBypass() {
        XCTAssertTrue(night.summary.contains("including approvals"))
        XCTAssertTrue(night.summary.contains("Open approvals are sent when it ends"))
    }

    func testChoiceIsStoredPerDevice() {
        let defaults = UserDefaults(suiteName: "quiet-hours-test")!
        defaults.removePersistentDomain(forName: "quiet-hours-test")
        XCTAssertEqual(QuietHours.load(defaults).enabled, false)
        night.save(defaults)
        XCTAssertEqual(QuietHours.load(defaults), night)
    }
}
