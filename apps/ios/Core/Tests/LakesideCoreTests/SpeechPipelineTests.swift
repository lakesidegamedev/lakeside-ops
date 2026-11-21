import XCTest
@testable import LakesideCore

/// A speech server whose every request waits until the test answers it.
@MainActor private final class FakeServer {
    struct Pending { let text: String; let continuation: CheckedContinuation<Data, Error> }
    var started: [String] = []
    var cancelled: [String] = []
    private var pending: [UUID: Pending] = [:]
    var waiting: [String] { pending.values.map(\.text).sorted() }

    func fetch(_ text: String) async throws -> Data {
        started.append(text)
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
                pending[id] = Pending(text: text, continuation: continuation)
            }
        } onCancel: {
            Task { @MainActor in
                if let entry = self.pending.removeValue(forKey: id) {
                    self.cancelled.append(entry.text); entry.continuation.resume(throwing: CancellationError())
                }
            }
        }
    }
    func answer(_ text: String) {
        guard let key = pending.first(where: { $0.value.text == text })?.key, let entry = pending.removeValue(forKey: key) else {
            XCTFail("no pending request for \(text)"); return
        }
        entry.continuation.resume(returning: Data(text.utf8))
    }
    func fail(_ text: String) {
        guard let key = pending.first(where: { $0.value.text == text })?.key, let entry = pending.removeValue(forKey: key) else {
            XCTFail("no pending request for \(text)"); return
        }
        entry.continuation.resume(throwing: URLError(.timedOut))
    }
}

@MainActor private final class FakeSink: SpeechAudioSink {
    var queued: [String] = []
    var played: [String] = []
    var stops = 0
    private var callbacks: [() -> Void] = []
    func enqueue(_ audio: Data, finished: @escaping @MainActor () -> Void) throws {
        queued.append(String(decoding: audio, as: UTF8.self)); callbacks.append(finished)
    }
    func stop() { stops += 1; callbacks.removeAll() }
    func finishCurrent() {
        guard !callbacks.isEmpty else { XCTFail("nothing is playing"); return }
        played.append(queued[played.count]); callbacks.removeFirst()()
    }
}

@MainActor final class SpeechPipelineTests: XCTestCase {
    private let pieces = ["One.", "Two.", "Three.", "Four."]

    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    private func make(_ segments: [String], first: Duration = .seconds(30), stall: Duration = .seconds(30)) -> (SpeechPipeline, FakeServer, FakeSink, () -> [SpeechPipeline.Event]) {
        let server = FakeServer(), sink = FakeSink()
        let pipeline = SpeechPipeline(segments: segments, sink: sink, firstDeadline: first, stallDeadline: stall) { try await server.fetch($0) }
        var events: [SpeechPipeline.Event] = []
        pipeline.onEvent = { events.append($0) }
        return (pipeline, server, sink, { events })
    }

    func testFirstPieceStartsBeforeLaterOnesArriveAndAtMostTwoRequestsRun() async {
        let (pipeline, server, sink, events) = make(pieces)
        pipeline.start(); await settle()
        XCTAssertEqual(server.started, ["One.", "Two."], "two requests at a time")
        server.answer("One."); await settle()
        XCTAssertEqual(sink.queued, ["One."], "plays the moment it arrives")
        XCTAssertEqual(events(), [.started])
        XCTAssertEqual(server.waiting, ["Three.", "Two."], "fetches ahead while the first plays")
        server.answer("Two."); await settle()
        XCTAssertEqual(sink.queued, ["One.", "Two."])
        XCTAssertEqual(server.started.count, 3, "look-ahead stays two pieces past the one playing")
        sink.finishCurrent(); await settle()
        XCTAssertEqual(server.started, pieces)
        server.answer("Three."); server.answer("Four."); await settle()
        sink.finishCurrent(); sink.finishCurrent(); sink.finishCurrent(); await settle()
        XCTAssertEqual(sink.played, pieces)
        XCTAssertEqual(events(), [.started, .finished])
    }

    func testPiecesPlayInOrderWhenTheyArriveOutOfOrder() async {
        let (pipeline, server, sink, events) = make(pieces)
        pipeline.start(); await settle()
        server.answer("Two."); await settle()
        XCTAssertEqual(sink.queued, [], "the second piece waits for the first")
        XCTAssertEqual(events(), [])
        server.answer("One."); await settle()
        XCTAssertEqual(sink.queued, ["One.", "Two."])
        sink.finishCurrent(); await settle()
        XCTAssertEqual(server.waiting, ["Four.", "Three."])
        server.answer("Four."); await settle()
        XCTAssertEqual(sink.queued, ["One.", "Two."], "the fourth piece waits for the third")
        server.answer("Three."); await settle()
        XCTAssertEqual(sink.queued, pieces)
    }

    func testAFailedLaterPieceIsRetriedOnceThenTheRestGoesToTheDeviceVoice() async {
        let (pipeline, server, sink, events) = make(pieces)
        pipeline.start(); await settle()
        server.answer("One."); await settle()
        server.fail("Two."); await settle()
        XCTAssertEqual(server.started.filter { $0 == "Two." }.count, 2, "retried once")
        server.fail("Two."); await settle()
        XCTAssertEqual(server.started.filter { $0 == "Two." }.count, 2, "not retried twice")
        XCTAssertEqual(server.waiting, [], "requests past the failure are cancelled")
        XCTAssertEqual(events(), [.started], "the first piece finishes before the device voice")
        sink.finishCurrent(); await settle()
        XCTAssertEqual(events(), [.started, .fallback(from: 1)])
        XCTAssertEqual(sink.played, ["One."])
    }

    func testARetryThatSucceedsKeepsTheOnlineVoice() async {
        let (pipeline, server, sink, events) = make(pieces)
        pipeline.start(); await settle()
        server.answer("One."); server.fail("Two."); await settle()
        server.answer("Two."); await settle()
        XCTAssertEqual(sink.queued, ["One.", "Two."])
        XCTAssertEqual(events(), [.started])
    }

    func testAFailedFirstPieceSendsTheWholeReplyToTheDeviceVoice() async {
        let (pipeline, server, sink, events) = make(pieces)
        pipeline.start(); await settle()
        server.fail("One."); await settle()
        XCTAssertEqual(events(), [.fallback(from: 0)])
        XCTAssertEqual(server.started.filter { $0 == "One." }.count, 1)
        XCTAssertEqual(sink.queued, [])
        XCTAssertEqual(server.waiting, [])
    }

    func testAMissedFirstDeadlineSendsTheWholeReplyToTheDeviceVoice() async throws {
        let (pipeline, server, _, events) = make(pieces, first: .milliseconds(50))
        pipeline.start()
        try await Task.sleep(for: .milliseconds(300)); await settle()
        XCTAssertEqual(events(), [.fallback(from: 0)])
        XCTAssertEqual(server.waiting, [])
    }

    func testAStalledLaterPieceHandsTheRestToTheDeviceVoice() async throws {
        let (pipeline, server, sink, events) = make(pieces, stall: .milliseconds(50))
        pipeline.start(); await settle()
        server.answer("One."); await settle()
        sink.finishCurrent(); await settle()
        try await Task.sleep(for: .milliseconds(300)); await settle()
        XCTAssertEqual(events(), [.started, .fallback(from: 1)])
        XCTAssertEqual(server.waiting, [])
    }

    func testCancelStopsEverythingAndNothingPlaysAfterwards() async {
        let (pipeline, server, sink, events) = make(pieces)
        pipeline.start(); await settle()
        server.answer("One."); await settle()
        pipeline.cancel(); await settle()
        XCTAssertEqual(sink.stops, 1)
        XCTAssertEqual(Set(server.cancelled), ["Two.", "Three."], "requests in flight are cancelled")
        XCTAssertEqual(server.waiting, [])
        XCTAssertEqual(sink.queued, ["One."])
        XCTAssertEqual(events(), [.started], "no event after cancel")
    }

    func testAShortReplyMakesOneRequest() async {
        let (pipeline, server, sink, events) = make(["Got it."])
        pipeline.start(); await settle()
        server.answer("Got it."); await settle()
        sink.finishCurrent(); await settle()
        XCTAssertEqual(server.started, ["Got it."])
        XCTAssertEqual(events(), [.started, .finished])
    }
}
