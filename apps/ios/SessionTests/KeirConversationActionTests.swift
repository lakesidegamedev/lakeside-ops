import XCTest
import LakesideCore
@testable import LakesideOps

/// The conversation bridge through the real session transport, against an
/// in-test stand-in for the server. The stand-in lives only in this test target.
private final class ActionStub: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var replies: [String: (Int, String, String)] = [:]
    private static var bodies: [String: [String: Any]] = [:]
    static func reset() { lock.lock(); replies = [:]; bodies = [:]; lock.unlock() }
    static func respond(_ route: String, _ status: Int, _ body: String, type: String = "application/json") { lock.lock(); replies[route] = (status, type, body); lock.unlock() }
    static func body(_ route: String) -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return bodies[route] }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        let route = "\(request.httpMethod ?? "GET") \(url.path)"
        var payload = request.httpBody
        if payload == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            payload = data
        }
        Self.lock.lock()
        if let payload, let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] { Self.bodies[route] = object }
        let reply = Self.replies[route] ?? (404, "application/json", #"{"error":"Not found"}"#)
        Self.lock.unlock()
        let response = HTTPURLResponse(url: url, statusCode: reply.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": reply.1])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.2.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor final class KeirConversationActionTests: XCTestCase {
    private var suite = ""
    private let path = "/api/keir/app/tickets/123/supervision"

    override func setUp() async throws {
        suite = "keir-actions-\(UUID().uuidString)"
        ActionStub.reset()
    }
    override func tearDown() async throws { UserDefaults().removePersistentDomain(forName: suite) }

    private func session() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ActionStub.self]
        return AppSession(.ops, configuration: config)
    }
    private func takeReply(_ id: String) -> String {
        #"{"ok":true,"op":"take","requestId":"\#(id)","duplicate":false,"receipt":{"takeoverId":"t1","ticket":123,"workerId":"0123456789ab","generation":1,"suppressedOutbox":0,"transferred":{"nextAction":"Reply","evidence":3,"uncertainEffects":0,"pendingApprovals":0}},"supervision":{"ticket":123,"state":"supervised","worker":{"id":"0123456789ab","identity":"keir-worker:0123456789ab"}}}"#
    }

    func testTakeOverSendsTheRevisionAndRequestIDItWasShown() async throws {
        ActionStub.respond("GET " + path, 200, #"{"ticket":123,"revision":"abc123def456","state":"support","canTake":true,"takeBlockers":[],"worker":null}"#)
        let api = session()
        let view = try await api.get(ConversationActionBuilder.supervisionPath(123))
        XCTAssertEqual(ConversationActionPlan.evaluate(op: .take, view: view, ticket: 123), .ready(workerId: ""))
        let request = try ConversationActionBuilder.request(op: .take, ticket: 123, requestId: "ka-wire-0001", revision: view["revision"].string, text: "Check the ledger", workerId: "")
        ActionStub.respond("POST " + path, 200, takeReply("ka-wire-0001"))
        let reply = try await api.post(request.path, request.body)
        let sent = try XCTUnwrap(ActionStub.body("POST " + path))
        XCTAssertEqual(sent["op"] as? String, "take")
        XCTAssertEqual(sent["revision"] as? String, "abc123def456")
        XCTAssertEqual(sent["requestId"] as? String, "ka-wire-0001")
        XCTAssertEqual(sent["text"] as? String, "Check the ledger")
        let outcome = try XCTUnwrap(ConversationActionOutcome.interpret(op: .take, ticket: 123, requestId: "ka-wire-0001", response: reply))
        XCTAssertEqual(outcome.workerIdentity, "keir-worker:0123456789ab")
    }

    func testStaleRevisionIsRefusedAndSaysNothingChanged() async {
        ActionStub.respond("POST " + path, 409, #"{"error":"This ticket changed since you looked at it.","code":"stale-revision"}"#)
        do {
            _ = try await session().post(path, ["op": .string("take"), "requestId": .string("ka-wire-0002"), "revision": .string("old")])
            XCTFail("a refused action must throw")
        } catch {
            let failure = error as? AppFailure
            XCTAssertEqual(failure?.statusCode, 409)
            let kind = ConversationActionFailure.classify(op: .take, statusCode: failure?.statusCode)
            XCTAssertEqual(kind, .refused)
            XCTAssertEqual(kind.explain(serverMessage: failure?.message ?? ""), "This ticket changed since you looked at it. Nothing was changed.")
        }
    }

    func testServerWithoutTheRouteReadsAsNoRecord() async {
        do {
            _ = try await session().get(ConversationActionBuilder.supervisionPath(123))
            XCTFail("an old server has no supervision route")
        } catch { XCTAssertEqual((error as? AppFailure)?.statusCode, 404) }
    }

    func testTakeFailsClosedWhenTheTicketCannotBeVerified() async {
        ActionStub.respond("POST " + path, 503, #"{"error":"Discord is unavailable"}"#)
        do {
            _ = try await session().post(path, ["op": .string("take")])
            XCTFail("503 must throw")
        } catch {
            XCTAssertEqual(ConversationActionFailure.classify(op: .take, statusCode: (error as? AppFailure)?.statusCode), .couldNotVerify)
        }
    }

    func testAWebPageInsteadOfAReceiptIsNeverSuccess() async {
        ActionStub.respond("POST " + path, 200, "<html>Sign in</html>", type: "text/html")
        do {
            _ = try await session().post(path, ["op": .string("take")])
            XCTFail("HTML is not a receipt")
        } catch {
            XCTAssertNil((error as? AppFailure)?.statusCode)
            XCTAssertEqual(ConversationActionFailure.classify(op: .take, statusCode: (error as? AppFailure)?.statusCode), .unknown)
        }
    }

    func testAReplyForAnotherRequestDoesNotConfirmThisOne() async throws {
        ActionStub.respond("POST " + path, 200, takeReply("ka-someone-else"))
        let reply = try await session().post(path, ["op": .string("take"), "requestId": .string("ka-wire-0003")])
        XCTAssertNil(ConversationActionOutcome.interpret(op: .take, ticket: 123, requestId: "ka-wire-0003", response: reply))
    }

    func testHistoryKeepsTheRequestIDAndTheResultAcrossARelaunch() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let key = ConversationActionLedger.key(scope: "owner", messageID: "m_1", op: .take, ticket: 123)
        let first = ConversationActionHistory(defaults: defaults)
        let id = try XCTUnwrap(first.requestID(for: key, op: .take, ticket: 123, text: ""))
        let reopened = ConversationActionHistory(defaults: defaults)
        XCTAssertEqual(reopened.requestID(for: key, op: .take, ticket: 123, text: ""), id, "a retry after a relaunch reuses the id")
        let outcome = try XCTUnwrap(ConversationActionOutcome.interpret(op: .take, ticket: 123, requestId: "ka-wire-0004", response: JSONValue.parse(takeReply("ka-wire-0004"))))
        reopened.complete(key, outcome: outcome)
        let again = ConversationActionHistory(defaults: defaults)
        XCTAssertTrue(again.ledger.isDone(key))
        XCTAssertNil(again.requestID(for: key, op: .take, ticket: 123, text: ""), "a finished message never acts twice")
    }
}
