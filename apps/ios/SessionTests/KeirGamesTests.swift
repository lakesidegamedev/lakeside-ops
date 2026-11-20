import XCTest
import LakesideCore
@testable import LakesideOps

/// Scripted transport for the failure and ordering cases the fixture cannot produce.
final class GamesTransport: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var script: (String) -> (status: Int, body: String, delay: TimeInterval) = { _ in (200, "{}", 0) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let reply = Self.script(path)
        let url = request.url!
        DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay) { [self] in
            let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.body.utf8)); client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

/// Connected games: what is parsed, what is offered, and what is remembered.
/// Everything runs against the synthetic fixture transport; no game is contacted.
@MainActor final class KeirGamesTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suite = "keir-games-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }
    override func tearDown() async throws { UserDefaults().removePersistentDomain(forName: suite) }

    private func session() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return AppSession(.ops, configuration: config)
    }
    private func fixture(_ path: String, _ flags: [String] = []) throws -> JSONValue {
        let value = try XCTUnwrap(KeirGamesFixtures.value(path, method: "GET", arguments: flags))
        return try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: value))
    }
    private func game(_ id: String, _ flags: [String] = []) throws -> KeirGame {
        try XCTUnwrap(KeirGames.parseGame(try fixture("/api/keir/app/games/\(id)", flags)))
    }

    // MARK: Parsing and states

    func testListNamesEveryGameWithoutReadingAnything() throws {
        let games = KeirGames.parseList(try fixture("/api/keir/app/games"))
        XCTAssertEqual(games.map(\.id), ["ahd", "metroforge", "grand-century"])
        XCTAssertTrue(games.allSatisfy { $0.state == .available && $0.reads.isEmpty })
    }

    func testAnUnregisteredGameIsUnsupportedNotLive() throws {
        let games = KeirGames.parseList(try fixture("/api/keir/app/games", ["--uitest-games-unregistered"]))
        XCTAssertEqual(games.first { $0.id == "grand-century" }?.state, .unsupported)
        let detail = try game("grand-century", ["--uitest-games-unregistered"])
        XCTAssertEqual(detail.state, .unsupported)
        XCTAssertTrue(detail.reads.isEmpty)
        XCTAssertTrue(KeirGameDraft.topics(for: detail).isEmpty)
    }

    func testLiveReadsKeepTheirFactsAndEvidencePath() throws {
        let detail = try game("metroforge")
        XCTAssertEqual(detail.state, .live)
        let deploy = try XCTUnwrap(detail.reads.first)
        XCTAssertEqual(deploy.state, .live)
        XCTAssertEqual(deploy.source, "metroforge · mf_status")
        XCTAssertNotNil(deploy.checkedAt)
        XCTAssertEqual(deploy.facts.first?.label, "Preview site")
    }

    func testAnUnavailableReadShowsNoNumbersEvenIfTheServerSentSome() throws {
        let down = try game("metroforge", ["--uitest-games-unavailable"])
        XCTAssertEqual(down.state, .unavailable)
        XCTAssertTrue(down.reads.allSatisfy { $0.state == .unavailable && $0.facts.isEmpty })
        let row = JSONValue.object(["id": .string("deploy"), "state": .string("unavailable"), "facts": .array([.object(["label": .string("Turn"), "value": .string("999")])])])
        XCTAssertEqual(KeirGames.parseRead(row)?.facts, [])
    }

    func testAnUnknownStateWordIsNeverLive() {
        XCTAssertEqual(KeirGameState(server: "healthy"), .unavailable)
        XCTAssertEqual(KeirGameState(server: ""), .unavailable)
        XCTAssertEqual(KeirGameState(server: "live"), .live)
        let row = JSONValue.object(["id": .string("x"), "state": .string("ok"), "facts": .array([.object(["label": .string("A"), "value": .string("1")])])])
        XCTAssertEqual(KeirGames.parseRead(row)?.state, .unavailable)
    }

    func testMalformedRowsAndIdsAreDropped() {
        for id in ["", "A", "../etc", "ahd/../x", "x", "UPPER", "a b", String(repeating: "a", count: 40), "1ahd"] { XCTAssertFalse(KeirGames.validID(id), id) }
        XCTAssertTrue(KeirGames.validID("grand-century"))
        let junk: JSONValue = .object(["games": .array([.object(["id": .string("../x"), "name": .string("Bad")]), .object(["id": .string("ok-game")]), .object(["id": .string("fine"), "name": .string("Fine")])])])
        XCTAssertEqual(KeirGames.parseList(junk).map(\.id), ["fine"])
    }

    func testStatesAreWordsAndShapesNotColourAlone() {
        let all: [KeirGameState] = [.live, .partial, .unavailable, .unsupported, .available]
        XCTAssertEqual(Set(all.map(\.title)).count, all.count)
        XCTAssertEqual(Set(all.map(\.icon)).count, all.count)
        XCTAssertTrue(all.allSatisfy { !$0.title.isEmpty })
    }

    // MARK: Tickets are A House Divided only

    func testTicketsAreOfferedForAHouseDividedAndNoOtherGame() throws {
        XCTAssertTrue(try game("ahd").ticketsSupported)
        XCTAssertEqual(KeirGameDraft.topics(for: try game("ahd")), [.health, .tickets])
        for id in ["metroforge", "grand-century"] {
            let other = try game(id)
            XCTAssertFalse(other.ticketsSupported, id)
            XCTAssertEqual(other.tickets?.state, .unsupported, id)
            XCTAssertEqual(KeirGameDraft.topics(for: other), [.health], id)
            XCTAssertNil(KeirGameDraft.prompt(.tickets, game: other), id)
        }
    }

    func testTicketSupportFollowsTheServerNotTheGameName() throws {
        // A server that says tickets are unsupported wins, even for the game named ahd.
        var detail = try fixture("/api/keir/app/games/ahd").object
        detail["capabilities"] = .array([.object(["id": .string("tickets"), "state": .string("unsupported")])])
        let parsed = try XCTUnwrap(KeirGames.parseGame(.object(detail)))
        XCTAssertEqual(KeirGameDraft.topics(for: parsed), [.health])
    }

    // MARK: Drafts

    func testTheHealthDraftNamesTheGameAndItsReadToolsAndForbidsWrites() throws {
        let text = try XCTUnwrap(KeirGameDraft.prompt(.health, game: try game("metroforge")))
        XCTAssertTrue(text.hasPrefix("About MetroForge:"))
        XCTAssertTrue(text.contains("read-only checks"))
        XCTAssertFalse(text.contains("mf_status"))
        XCTAssertTrue(text.contains("Don't change anything or message anyone"))
        XCTAssertTrue(text.contains("say so plainly if a read fails"))
        XCTAssertFalse(text.contains("mf_leaderboard"))
    }

    func testTheTicketDraftNeverClaimsAPlayerWasIgnoredOrAsksToMessage() throws {
        let text = try XCTUnwrap(KeirGameDraft.prompt(.tickets, game: try game("ahd")))
        XCTAssertTrue(text.contains("no Discord reply recorded in the studio's receipts"))
        XCTAssertTrue(text.contains("Don't message any player yet"))
        XCTAssertFalse(text.lowercased().contains("ignored"))
    }

    func testDraftsContainNoDashesOrHostPaths() throws {
        for id in ["ahd", "metroforge", "grand-century"] {
            for topic in KeirGameDraft.Topic.allCases {
                guard let text = KeirGameDraft.prompt(topic, game: try game(id)) else { continue }
                XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), text)
                XCTAssertFalse(text.contains("/root") || text.contains("127.0.0.1") || text.contains("http"), text)
            }
        }
    }

    // MARK: Remembered selection

    func testOnlyACatalogueIdIsStoredAndOnlyAListedOneIsHonoured() {
        let selection = KeirGameSelection(defaults: defaults)
        selection.save("metroforge")
        XCTAssertEqual(defaults.string(forKey: KeirGames.selectionKey), "metroforge")
        XCTAssertEqual(KeirGameSelection(defaults: defaults).saved(among: ["ahd", "metroforge"]), "metroforge")
        XCTAssertNil(KeirGameSelection(defaults: defaults).saved(among: ["ahd"]), "a game the server no longer lists is forgotten")
        selection.save("../../etc/passwd")
        XCTAssertEqual(defaults.string(forKey: KeirGames.selectionKey), "metroforge")
        selection.clear()
        XCTAssertNil(selection.saved(among: ["metroforge"]))
    }

    func testChoosingReadsTheGameAndAReopenedSheetRestoresIt() async throws {
        let session = session()
        let first = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await first.load(session)
        XCTAssertEqual(first.phase, .loaded)
        XCTAssertEqual(first.games.count, 3)
        XCTAssertNil(first.selected)
        await first.choose("metroforge", session)
        XCTAssertEqual(first.selectedGame?.state, .live)
        XCTAssertEqual(first.selectedGame?.reads.count, 2)
        XCTAssertFalse(first.detailFailed)
        // A brand new model on the same defaults is what a reopened sheet is.
        let second = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await second.load(session)
        XCTAssertEqual(second.selected, "metroforge")
        XCTAssertEqual(second.selectedGame?.reads.first?.source, "metroforge · mf_status")
    }

    func testChoosingAnUnlistedGameDoesNothing() async {
        let session = session()
        let model = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await model.load(session)
        await model.choose("not-a-game", session)
        XCTAssertNil(model.selected)
        XCTAssertNil(defaults.string(forKey: KeirGames.selectionKey))
    }

    // MARK: Modes

    func testTheSheetIsStudioOnly() {
        XCTAssertFalse(KeirGames.available(profile: .object(["mode": .string("standalone")])))
        XCTAssertTrue(KeirGames.available(profile: .object(["mode": .string("studio")])))
        XCTAssertTrue(KeirGames.available(profile: .null))
    }

    // MARK: Failures and ordering

    private func scripted(_ script: @escaping (String) -> (status: Int, body: String, delay: TimeInterval)) -> AppSession {
        GamesTransport.script = script
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [GamesTransport.self]
        return AppSession(.ops, configuration: config)
    }
    private let listBody = #"{"games":[{"id":"metroforge","name":"MetroForge","state":"available"},{"id":"grand-century","name":"Grand Century","state":"available"}]}"#
    private func detailBody(_ id: String, _ name: String) -> String {
        #"{"id":"\#(id)","name":"\#(name)","state":"live","reads":[{"id":"deploy","label":"Health","source":"\#(id) · tool","state":"live","facts":[{"label":"Site","value":"Responding"}]}]}"#
    }

    func testAFailedListSaysNothingAboutTheGamesAndRetryRecovers() async {
        let session = scripted { _ in (503, #"{"error":"down"}"#, 0) }
        let model = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await model.load(session)
        XCTAssertEqual(model.phase, .failed)
        XCTAssertTrue(model.games.isEmpty)
        let body = listBody
        let healthy = scripted { _ in (200, body, 0) }
        await model.load(healthy)
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.games.count, 2)
    }

    func testAFailedReadIsReportedAsUnavailableAndKeepsTheSelection() async {
        let list = listBody
        let session = scripted { path in path == "/api/keir/app/games" ? (200, list, 0) : (502, #"{"error":"boom"}"#, 0) }
        let model = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await model.load(session)
        await model.choose("metroforge", session)
        XCTAssertEqual(model.selected, "metroforge")
        XCTAssertTrue(model.detailFailed)
        XCTAssertNil(model.detail)
        XCTAssertFalse(model.reading)
    }

    func testASlowAnswerForAnEarlierGameNeverReplacesTheLaterChoice() async {
        let list = listBody, slow = detailBody("metroforge", "MetroForge"), fast = detailBody("grand-century", "Grand Century")
        let session = scripted { path in
            switch path {
            case "/api/keir/app/games": return (200, list, 0)
            case "/api/keir/app/games/metroforge": return (200, slow, 0.4)
            default: return (200, fast, 0)
            }
        }
        let model = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await model.load(session)
        async let earlier: Void = model.choose("metroforge", session)
        try? await Task.sleep(for: .milliseconds(100))
        await model.choose("grand-century", session)
        await earlier
        XCTAssertEqual(model.selected, "grand-century")
        XCTAssertEqual(model.detail?.id, "grand-century")
        XCTAssertFalse(model.reading)
        XCTAssertEqual(defaults.string(forKey: KeirGames.selectionKey), "grand-century")
    }

    func testADetailForTheWrongGameIsRejected() async {
        let list = listBody, wrong = detailBody("grand-century", "Grand Century")
        let session = scripted { path in path == "/api/keir/app/games" ? (200, list, 0) : (200, wrong, 0) }
        let model = KeirGamesModel(selection: KeirGameSelection(defaults: defaults))
        await model.load(session)
        await model.choose("metroforge", session)
        XCTAssertTrue(model.detailFailed)
        XCTAssertNil(model.detail)
    }
}
