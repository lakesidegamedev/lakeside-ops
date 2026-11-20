import XCTest
import LakesideCore
@testable import LakesideOps

/// Reopening the last private conversation, and the ticket follow-up wording.
/// A "reopen" here is a brand new KeirStore reading the same UserDefaults,
/// which is all that survives a force-quit.
@MainActor final class KeirResumeTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!
    private let server = URL(string: "https://ops.lakesidegames.net")!
    private var owner: String { KeirResume.scope(profile: .object(["email": .string("owner@example.test")]), server: server)! }
    private var other: String { KeirResume.scope(profile: .object(["email": .string("someone@example.test")]), server: server)! }

    override func setUp() {
        suite = "keir-resume-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }
    override func tearDown() { UserDefaults().removePersistentDomain(forName: suite) }

    private func session() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return AppSession(.ops, configuration: config)
    }
    private func store(_ scope: String?) -> KeirStore {
        let store = KeirStore(resume: KeirResume(defaults: defaults))
        store.bindAccount(scope)
        return store
    }
    private func row(_ id: String, system: Bool = false, archived: Bool = false) -> JSONValue {
        .object(["id": .string(id), "title": .string(id), "system": .bool(system), "archived": .bool(archived)])
    }

    // MARK: What is stored

    func testScopeIsAFingerprintOfAccountAndServerNotTheIdentity() {
        XCTAssertFalse(owner.contains("owner@example"))
        XCTAssertNotEqual(owner, other)
        XCTAssertNotEqual(owner, KeirResume.scope(profile: .object(["email": .string("owner@example.test")]), server: URL(string: "https://staging.example.test")!))
        XCTAssertNil(KeirResume.scope(profile: .null, server: server))
    }

    func testOnlyTheThreadIdAndFingerprintAreWritten() {
        let keir = store(owner)
        keir.select("c0ffee00")
        let saved = defaults.dictionary(forKey: KeirResume.defaultsKey) as? [String: String]
        XCTAssertEqual(saved, ["scope": owner, "thread": "c0ffee00"])
    }

    func testNothingIsSavedBeforeTheAccountIsKnown() {
        let keir = store(nil)
        keir.select("c0ffee00")
        XCTAssertNil(defaults.dictionary(forKey: KeirResume.defaultsKey))
        // A thread opened from a push before sign-in finished is saved once the account binds.
        keir.bindAccount(owner)
        XCTAssertEqual(keir.resume.saved(for: owner), "c0ffee00")
    }

    func testMalformedThreadIdsAreNeverSavedOrRestored() {
        let keir = store(owner)
        keir.select("../../etc/passwd")
        XCTAssertNil(keir.resume.saved(for: owner))
        defaults.set(["scope": owner, "thread": "has space"], forKey: KeirResume.defaultsKey)
        XCTAssertNil(keir.resume.saved(for: owner))
    }

    // MARK: Close and reopen

    func testReopeningAfterForceQuitLandsOnTheSavedThreadFromTheLiveListing() async {
        let first = store(owner)
        first.select("c0ffee00")                   // the owner opens "Bond market", then the app is killed
        let reopened = store(owner)                // a new process: nothing but UserDefaults survives
        XCTAssertEqual(reopened.thread, "main")
        await reopened.resumeLastThread(session()) // the fixture lists c0ffee00
        XCTAssertEqual(reopened.thread, "c0ffee00")
        XCTAssertEqual(reopened.threadTitle, "Bond market")
        XCTAssertTrue(reopened.messages.isEmpty, "no transcript is restored; the thread reloads from the server")
    }

    func testReopeningWithNothingSavedStaysOnMain() async {
        let keir = store(owner)
        await keir.resumeLastThread(session())
        XCTAssertEqual(keir.thread, "main")
    }

    func testReturningToMainMeansMainOnTheNextLaunch() async {
        let first = store(owner)
        first.select("c0ffee00"); first.select("main")
        let reopened = store(owner)
        await reopened.resumeLastThread(session())
        XCTAssertEqual(reopened.thread, "main")
    }

    func testAnotherAccountNeverResumesTheFirstAccountsThread() async {
        store(owner).select("c0ffee00")
        let second = store(other)
        await second.resumeLastThread(session())
        XCTAssertEqual(second.thread, "main")
        XCTAssertNil(second.resume.saved(for: owner), "the stale entry is not kept for a different account")
    }

    // MARK: Opened or changed while the read is in flight

    func testAThreadOpenedFromAPushBeatsTheSavedOne() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        reopened.select("feedface")                // the notification the owner tapped
        await reopened.resumeLastThread(session())
        XCTAssertEqual(reopened.thread, "feedface")
        XCTAssertEqual(reopened.resume.saved(for: owner), "feedface")
    }

    func testAPushForMainBeatsTheSavedThreadToo() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        reopened.select("main")
        await reopened.resumeLastThread(session())
        XCTAssertEqual(reopened.thread, "main")
    }

    func testSwitchingThreadsWhileTheListingLoadsWins() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { [weak reopened] in
            reopened?.select("beadfeed")           // the owner picks a thread mid-read
            return [self.row("main"), self.row("c0ffee00"), self.row("beadfeed")]
        }
        XCTAssertEqual(reopened.thread, "beadfeed")
        XCTAssertEqual(reopened.resume.saved(for: owner), "beadfeed")
    }

    func testTypingOnMainDuringTheReadKeepsTheOwnerWhereTheyAre() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { [weak reopened] in
            reopened?.holdRestore()
            return [self.row("main"), self.row("c0ffee00")]
        }
        XCTAssertEqual(reopened.thread, "main")
        XCTAssertEqual(reopened.resume.saved(for: owner), "c0ffee00", "not lost, just not applied over a draft")
    }

    func testSigningOutDuringTheReadRestoresNothingAndForgetsTheThread() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { [weak reopened] in
            reopened?.reset()                      // sign out while the listing is loading
            return [self.row("main"), self.row("c0ffee00")]
        }
        XCTAssertEqual(reopened.thread, "main")
        XCTAssertNil(defaults.dictionary(forKey: KeirResume.defaultsKey))
    }

    func testSigningOutForgetsTheThreadAndTheAccount() {
        let keir = store(owner)
        keir.select("c0ffee00")
        keir.reset()
        XCTAssertNil(defaults.dictionary(forKey: KeirResume.defaultsKey))
        XCTAssertNil(keir.resumeScope)
        XCTAssertEqual(keir.thread, "main")
    }

    func testTheAccountChangingDuringTheReadRestoresNothing() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { [weak reopened] in
            reopened?.bindAccount(self.other)
            return [self.row("main"), self.row("c0ffee00")]
        }
        XCTAssertEqual(reopened.thread, "main")
    }

    // MARK: Not legitimate

    func testAnUnlistedThreadIsForgotten() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { return [self.row("main")] }
        XCTAssertEqual(reopened.thread, "main")
        XCTAssertNil(reopened.resume.saved(for: owner))
    }

    func testAnArchivedThreadIsForgotten() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { return [self.row("main"), self.row("c0ffee00", archived: true)] }
        XCTAssertEqual(reopened.thread, "main")
        XCTAssertNil(reopened.resume.saved(for: owner))
    }

    func testTheSystemWatchesFeedIsNeverRestored() async {
        defaults.set(["scope": owner, "thread": "watches"], forKey: KeirResume.defaultsKey)
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { return [self.row("main"), self.row("watches", system: true)] }
        XCTAssertEqual(reopened.thread, "main")
    }

    func testAFailedListingKeepsTheSavedThreadAndTriesAgain() async {
        store(owner).select("c0ffee00")
        let reopened = store(owner)
        await reopened.resumeLastThread(session()) { nil }
        XCTAssertEqual(reopened.thread, "main")
        XCTAssertEqual(reopened.resume.saved(for: owner), "c0ffee00")
        await reopened.resumeLastThread(session()) { return [self.row("main"), self.row("c0ffee00")] }
        XCTAssertEqual(reopened.thread, "c0ffee00")
    }

    // MARK: Ticket follow-up

    private func ticket(_ number: Int, status: String = "open", reply: String = "no_receipt", created: Double = 1, title: String = "Budget") -> JSONValue {
        .object(["number": .number(Double(number)), "title": .string(title), "status": .string(status), "createdAt": .number(created), "replyState": .object(["state": .string(reply)])])
    }

    func testOnlyOpenTicketsWithNoRecordedReplyAreOfferedOldestFirst() {
        let hub: JSONValue = .object(["tickets": .array([
            ticket(3, created: 30), ticket(1, created: 10), ticket(2, reply: "delivered"), ticket(4, status: "resolved"), ticket(5, status: "closed", created: 5)])])
        XCTAssertEqual(KeirTicketFollowUp.waiting(in: hub).map { $0["number"].string }, ["1", "3"])
        XCTAssertTrue(KeirTicketFollowUp.waiting(in: .null).isEmpty)
    }

    func testFollowUpWordingClaimsOnlyWhatTheReceiptsShow() {
        let text = KeirTicketFollowUp.prompt(for: ticket(1001, title: "Budget screen shows zero funding"))
        XCTAssertTrue(text.contains("Ticket #1001 (Budget screen shows zero funding)"))
        XCTAssertTrue(text.contains("no Discord reply recorded in the studio's receipts"))
        XCTAssertTrue(text.contains("Don't message the player yet"))
        for overclaim in ["never replied", "ignored", "unanswered", "was not answered"] { XCTAssertFalse(text.localizedCaseInsensitiveContains(overclaim)) }
    }

    func testFollowUpTitleIsFlattenedAndShortened() {
        XCTAssertEqual(KeirTicketFollowUp.title(ticket(1, title: "Line one\n\nline   two")), "Line one line two")
        XCTAssertLessThanOrEqual(KeirTicketFollowUp.title(ticket(1, title: String(repeating: "x", count: 200))).count, 80)
        XCTAssertFalse(KeirTicketFollowUp.prompt(for: ticket(7, title: "")).contains("()"))
    }
}
