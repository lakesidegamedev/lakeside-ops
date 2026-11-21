import XCTest
import LakesideCore
@testable import LakesideOps

@MainActor final class KeirAttachmentTests: XCTestCase {
    private func session() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return AppSession(.ops, configuration: config)
    }
    func testThreadDraftsAndAttachmentOnlySend() async throws {
        let session = session(), files = ChatAttachments(keir: true), store = KeirStore()
        // An ordinary legacy support thread: the account is known to have no private supervisor.
        session.profile = .object(["email": .string("agent@example.test"), "ownerSupervisor": .bool(false)])
        await store.ensureHome(session)
        XCTAssertTrue(store.homeResolved)
        await files.add(Data("evidence".utf8), name: "notes.txt", mime: "text/plain", session: session)
        XCTAssertEqual(files.items.count, 1)
        let payload = files.payload
        files.scope = "other"
        XCTAssertTrue(files.items.isEmpty)
        files.scope = "main"
        XCTAssertEqual(files.items.count, 1)
        let sent = await store.send("", session, attachments: payload)
        XCTAssertTrue(sent)
        XCTAssertEqual(store.messages.last?["attachments"], payload)
        files.scope = "other"
        files.sent(payload, in: "main")
        files.scope = "main"
        XCTAssertTrue(files.items.isEmpty)
    }
    func testUploadCapturedForOldThreadCannotLeakIntoNewDraft() async {
        let session = session(), files = ChatAttachments(keir: true)
        files.scope = "new"
        await files.add(Data("evidence".utf8), name: "notes.txt", mime: "text/plain", session: session, in: "old")
        XCTAssertTrue(files.items.isEmpty)
        files.scope = "old"
        XCTAssertEqual(files.items.count, 1)
        await files.remove(files.items[0], session: session)
        XCTAssertTrue(files.items.isEmpty)
    }
}
