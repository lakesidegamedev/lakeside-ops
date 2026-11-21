import XCTest
import LakesideCore
@testable import LakesideOps

private class SpeechTransport: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.path == "/api/keir/app/voice/speech" else { return }
        XCTAssertEqual(request.timeoutInterval, 20)
        // Deliberately leave the request pending until the voice deadline.
    }
    override func stopLoading() {}
}

private final class FailedSpeechTransport: SpeechTransport, @unchecked Sendable {
    override func startLoading() {
        XCTAssertEqual(request.timeoutInterval, 20)
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
}

/// What the staged speech server was asked, and how it should answer each piece.
private final class SpeechLog: @unchecked Sendable {
    static let shared = SpeechLog()
    private let lock = NSLock()
    private var plans: [String: (delay: TimeInterval, failures: Int)] = [:]
    private var defaultDelay: TimeInterval = 0.05
    private var startedTexts: [String] = []
    private var completedTexts: [String] = []
    private var cancelledTexts: [String] = []

    func reset(defaultDelay: TimeInterval = 0.05, _ plans: [String: (delay: TimeInterval, failures: Int)] = [:]) {
        lock.lock(); defer { lock.unlock() }
        self.plans = plans; self.defaultDelay = defaultDelay
        startedTexts = []; completedTexts = []; cancelledTexts = []
    }
    /// Records a request and says how long it takes and whether it fails.
    func begin(_ text: String) -> (delay: TimeInterval, fail: Bool) {
        lock.lock(); defer { lock.unlock() }
        startedTexts.append(text)
        var plan = plans[text] ?? (defaultDelay, 0)
        let fail = plan.failures > 0
        if fail { plan.failures -= 1; plans[text] = plan }
        return (plan.delay, fail)
    }
    func completed(_ text: String) { lock.lock(); completedTexts.append(text); lock.unlock() }
    func cancelled(_ text: String) { lock.lock(); cancelledTexts.append(text); lock.unlock() }
    var started: [String] { lock.lock(); defer { lock.unlock() }; return startedTexts }
    var completed: [String] { lock.lock(); defer { lock.unlock() }; return completedTexts }
    var cancelled: [String] { lock.lock(); defer { lock.unlock() }; return cancelledTexts }
}

/// A speech endpoint whose answer time and failures are set per piece. The
/// audio it returns is the piece's own text, so the order of play is visible.
private final class StagedSpeechTransport: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    private var work: DispatchWorkItem?
    private var text = ""

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private func settle() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if settled { return false }
        settled = true; return true
    }

    override func startLoading() {
        text = Self.bodyText(request)
        let plan = SpeechLog.shared.begin(text)
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.settle() else { return }
            if plan.fail {
                self.client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return
            }
            SpeechLog.shared.completed(self.text)
            let response = HTTPURLResponse(url: self.request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "audio/mpeg"])!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Data(self.text.utf8))
            self.client?.urlProtocolDidFinishLoading(self)
        }
        work = item
        DispatchQueue.global().asyncAfter(deadline: .now() + plan.delay, execute: item)
    }

    override func stopLoading() {
        work?.cancel()
        if settle() { SpeechLog.shared.cancelled(text) }
    }

    static func bodyText(_ request: URLRequest) -> String {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
        }
        return (try? JSONDecoder().decode(JSONValue.self, from: data))?["text"].string ?? ""
    }
}

/// Stands in for the audio player: records what was queued, and plays a piece
/// only when the test says it finished.
@MainActor private final class RecordingOutput: KeirSpeechOutput {
    var queued: [String] = []
    var stops = 0
    var begins = 0
    private var callbacks: [@MainActor () -> Void] = []
    var level: Double { callbacks.isEmpty ? 0 : 0.6 }
    func begin() throws { begins += 1 }
    func enqueue(_ audio: Data, finished: @escaping @MainActor () -> Void) throws {
        queued.append(String(decoding: audio, as: UTF8.self)); callbacks.append(finished)
    }
    func stop() { stops += 1; callbacks.removeAll() }
    func finishCurrent() {
        guard !callbacks.isEmpty else { XCTFail("nothing is playing"); return }
        callbacks.removeFirst()()
    }
}

@MainActor final class VoicePlaybackTests: XCTestCase {
    override func setUp() { super.setUp(); SpeechLog.shared.reset() }

    private func session(failing: Bool = false) -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = failing ? [FailedSpeechTransport.self] : [SpeechTransport.self]
        return AppSession(.ops, configuration: config)
    }
    private func stagedSession() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StagedSpeechTransport.self]
        return AppSession(.ops, configuration: config)
    }
    private func waitUntil(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }
    /// A reply long enough for at least three pieces.
    private let longReply = (1...16).map { "Province \($0) paid every worker in full this turn, and its budget screen now matches the treasury." }.joined(separator: " ")
    private var pieces: [String] { VoiceSegments.segments(KeirVoice.spokenText(longReply)) }

    func testUnavailableOnlineSpeechFallsBackToDeviceVoice() async {
        let voice = KeirVoice(output: RecordingOutput()), usedDevice = expectation(description: "Device voice receives reply")
        voice.speakMicrosoft("Unavailable", session: session(failing: true), deadline: .seconds(5)) { text in
            XCTAssertEqual(text, "Unavailable"); usedDevice.fulfill()
        }
        await fulfillment(of: [usedDevice], timeout: 2)
        XCTAssertFalse(voice.preparingSpeech); XCTAssertNil(voice.error); XCTAssertTrue(voice.usingDeviceFallback)
        XCTAssertFalse(voice.fallbackPartial)
        voice.stop()
    }
    func testHungOnlineSpeechFallsBackAfterDeadline() async {
        let voice = KeirVoice(output: RecordingOutput()), usedDevice = expectation(description: "Hung speech recovers")
        voice.speakMicrosoft("A delayed reply", session: session(), deadline: .milliseconds(50)) { text in
            XCTAssertEqual(text, "A delayed reply"); usedDevice.fulfill()
        }
        XCTAssertTrue(voice.preparingSpeech)
        await fulfillment(of: [usedDevice], timeout: 2)
        XCTAssertFalse(voice.preparingSpeech); XCTAssertNil(voice.error); XCTAssertTrue(voice.usingDeviceFallback)
        voice.stop()
    }
    func testEndingVoiceCancelsPendingDeviceFallback() async {
        let voice = KeirVoice(output: RecordingOutput()), usedDevice = expectation(description: "Stopped voice stays silent")
        usedDevice.isInverted = true
        voice.speakMicrosoft("A delayed reply", session: session(), deadline: .milliseconds(50)) { _ in usedDevice.fulfill() }
        voice.stop()
        await fulfillment(of: [usedDevice], timeout: 0.2)
        XCTAssertFalse(voice.preparingSpeech); XCTAssertFalse(voice.speaking)
    }

    func testFirstAudioStartsBeforeLaterPiecesReturn() async {
        let pieces = self.pieces
        XCTAssertGreaterThanOrEqual(pieces.count, 3)
        SpeechLog.shared.reset(defaultDelay: 1.5, [pieces[0]: (0.05, 0)])
        let output = RecordingOutput(), voice = KeirVoice(output: output)
        voice.speakMicrosoft(longReply, session: stagedSession()) { _ in XCTFail("no fallback") }
        XCTAssertTrue(voice.preparingSpeech)
        let playing = await waitUntil { output.queued == [pieces[0]] }
        XCTAssertTrue(playing, "the first piece plays as soon as it arrives")
        XCTAssertTrue(voice.speaking); XCTAssertFalse(voice.preparingSpeech)
        XCTAssertEqual(output.begins, 1, "one audio session for the reply")
        XCTAssertFalse(SpeechLog.shared.completed.contains(pieces[1]), "before the second piece has returned")
        XCTAssertTrue(SpeechLog.shared.started.contains(pieces[1]), "the next piece is already being fetched")
        XCTAssertLessThanOrEqual(SpeechLog.shared.started.count, 3, "never more than two requests at a time")
        voice.stop()
    }

    func testPiecesPlayInOrderWhenTheyReturnOutOfOrder() async {
        let pieces = self.pieces
        SpeechLog.shared.reset(defaultDelay: 0.05, [pieces[0]: (0.6, 0)])
        let output = RecordingOutput(), voice = KeirVoice(output: output)
        voice.speakMicrosoft(longReply, session: stagedSession()) { _ in XCTFail("no fallback") }
        let secondBack = await waitUntil { SpeechLog.shared.completed.contains(pieces[1]) }
        XCTAssertTrue(secondBack)
        XCTAssertEqual(output.queued, [], "the second piece waits for the first")
        let both = await waitUntil { output.queued.count >= 2 }
        XCTAssertTrue(both)
        XCTAssertEqual(Array(output.queued.prefix(2)), [pieces[0], pieces[1]])
        output.finishCurrent()
        let third = await waitUntil { output.queued.count >= 3 }
        XCTAssertTrue(third)
        XCTAssertEqual(Array(output.queued.prefix(3)), Array(pieces.prefix(3)))
        voice.stop()
    }

    func testFailedLaterPieceRetriesOnceThenTheDeviceVoiceFinishesTheRest() async {
        let pieces = self.pieces
        SpeechLog.shared.reset(defaultDelay: 0.05, [pieces[1]: (0.05, 2)])
        let output = RecordingOutput(), voice = KeirVoice(output: output)
        var device: String?
        voice.speakMicrosoft(longReply, session: stagedSession()) { device = $0 }
        let retried = await waitUntil { SpeechLog.shared.started.filter { $0 == pieces[1] }.count == 2 && output.queued == [pieces[0]] }
        XCTAssertTrue(retried, "the failed piece is asked for once more")
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(SpeechLog.shared.started.filter { $0 == pieces[1] }.count, 2, "and only once")
        XCTAssertNil(device, "the first piece finishes in the online voice first")
        output.finishCurrent()
        let handedOver = await waitUntil { device != nil }
        XCTAssertTrue(handedOver)
        XCTAssertEqual(device, pieces[1...].joined(separator: " "), "the device voice continues from the failed piece, not from the start")
        XCTAssertTrue(voice.usingDeviceFallback); XCTAssertTrue(voice.fallbackPartial)
        XCTAssertEqual(output.queued, [pieces[0]])
        voice.stop()
    }

    func testInterruptCancelsQueuedAndInFlightWork() async {
        let pieces = self.pieces
        SpeechLog.shared.reset(defaultDelay: 2, [pieces[0]: (0.05, 0)])
        let output = RecordingOutput(), voice = KeirVoice(output: output)
        var device: String?
        voice.speakMicrosoft(longReply, session: stagedSession()) { device = $0 }
        let playing = await waitUntil { output.queued.count == 1 }
        XCTAssertTrue(playing)
        let stopsBefore = output.stops
        voice.stop()
        XCTAssertGreaterThan(output.stops, stopsBefore, "playback stops at once")
        XCTAssertFalse(voice.speaking); XCTAssertFalse(voice.preparingSpeech)
        let cancelled = await waitUntil { SpeechLog.shared.cancelled.contains(pieces[1]) }
        XCTAssertTrue(cancelled, "the request in flight is cancelled")
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(output.queued, [pieces[0]], "nothing plays afterwards")
        XCTAssertNil(device)
    }

    func testASecondReplyReplacesTheFirstCleanly() async {
        let pieces = self.pieces
        SpeechLog.shared.reset(defaultDelay: 0.4, ["Second reply.": (0.05, 0)])
        let output = RecordingOutput(), voice = KeirVoice(output: output)
        let session = stagedSession()
        voice.speakMicrosoft(longReply, session: session) { _ in XCTFail("no fallback") }
        voice.speakMicrosoft("Second reply.", session: session) { _ in XCTFail("no fallback") }
        let second = await waitUntil { output.queued.contains("Second reply.") }
        XCTAssertTrue(second)
        try? await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(output.queued, ["Second reply."], "no leftover audio from the first reply")
        XCTAssertFalse(output.queued.contains(pieces[0]))
        output.finishCurrent()
        let done = await waitUntil { !voice.speaking }
        XCTAssertTrue(done)
    }

    func testAShortReplyMakesExactlyOneRequest() async {
        let output = RecordingOutput(), voice = KeirVoice(output: output)
        voice.speakMicrosoft("Got it.", session: stagedSession()) { _ in XCTFail("no fallback") }
        let playing = await waitUntil { output.queued == ["Got it."] }
        XCTAssertTrue(playing)
        output.finishCurrent()
        let done = await waitUntil { !voice.speaking }
        XCTAssertTrue(done)
        XCTAssertEqual(SpeechLog.shared.started, ["Got it."])
        XCTAssertFalse(voice.usingDeviceFallback)
    }
}
