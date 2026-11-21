import Foundation

/// Where synthesized pieces are played. Audio handed over is played after
/// everything already queued, with no gap and no overlap; `finished` runs once
/// that piece has played. `stop` drops everything queued at once.
@MainActor public protocol SpeechAudioSink: AnyObject {
    func enqueue(_ audio: Data, finished: @escaping @MainActor () -> Void) throws
    func stop()
}

/// Speaks a reply piece by piece through the online voice. The first piece is
/// requested at once and plays the moment it arrives; while a piece plays, up to
/// two more are fetched ahead (never more than two requests at a time, the
/// server's limit). Pieces always play in order.
///
/// - The first piece has a deadline. If it fails or misses it, the whole reply
///   goes to the device voice (`fallback(from: 0)`).
/// - A later piece that fails is retried once. If it fails again, or playback
///   waits on it past the stall deadline, the pieces before it finish and the
///   rest goes to the device voice (`fallback(from: index)`).
/// - `cancel` stops playback, queued pieces and requests in flight; nothing is
///   reported after it.
@MainActor public final class SpeechPipeline {
    public enum Event: Equatable { case started, finished, fallback(from: Int) }

    public let segments: [String]
    public var onEvent: (Event) -> Void = { _ in }
    public static let maxInFlight = 2
    public static let lookAhead = 2

    private let fetch: @MainActor (String) async throws -> Data
    private let sink: SpeechAudioSink
    private let firstDeadline: Duration
    private let stallDeadline: Duration
    private var active = false
    private var started = false
    private var ready: [Int: Data] = [:]
    private var attempts: [Int: Int] = [:]
    private var inFlight: [Int: (id: UUID, task: Task<Void, Never>)] = [:]
    private var nextFetch = 0
    private var nextEnqueue = 0
    private var played = 0
    private var failedAt: Int?
    private var retries: [Int] = []
    private var deadline: Task<Void, Never>?
    private var stall: (index: Int, task: Task<Void, Never>)?

    public init(segments: [String], sink: SpeechAudioSink, firstDeadline: Duration, stallDeadline: Duration,
                fetch: @escaping @MainActor (String) async throws -> Data) {
        self.segments = segments; self.sink = sink; self.fetch = fetch
        self.firstDeadline = firstDeadline; self.stallDeadline = stallDeadline
    }

    public func start() {
        guard !active, !segments.isEmpty else { if segments.isEmpty { onEvent(.finished) }; return }
        active = true
        let limit = firstDeadline
        deadline = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: limit) } catch { return }
            guard let self, self.active, !self.started else { return }
            self.fallback(from: 0)
        }
        pump()
    }

    /// Stops everything at once. No event follows.
    public func cancel() {
        guard active else { return }
        teardown()
        sink.stop()
    }

    /// Number of fetch requests in flight, for tests.
    public var requestsInFlight: Int { inFlight.count }

    private func pump() {
        guard active else { return }
        // Hand over every piece that is next in line and ready.
        while let data = ready.removeValue(forKey: nextEnqueue) {
            let index = nextEnqueue
            do {
                try sink.enqueue(data) { [weak self] in self?.pieceFinished() }
            } catch {
                failed(index); return
            }
            nextEnqueue += 1
            if stall?.index == index { stall?.task.cancel(); stall = nil }
            if index == 0 {
                started = true; deadline?.cancel(); deadline = nil
                onEvent(.started)
                guard active else { return }
            }
        }
        // Fetch ahead, within the server's limit and a short look-ahead.
        let stop = failedAt ?? segments.count
        while inFlight.count < Self.maxInFlight, !retries.isEmpty { request(retries.removeFirst()) }
        while inFlight.count < Self.maxInFlight, nextFetch < stop, nextFetch <= played + Self.lookAhead {
            request(nextFetch); nextFetch += 1
        }
        if played >= segments.count { finish(); return }
        if let failedAt, played >= failedAt { fallback(from: failedAt); return }
        armStallIfWaiting()
    }

    private func request(_ index: Int) {
        let id = UUID(), text = segments[index]
        let task = Task { @MainActor [weak self] in
            let result: Result<Data, Error>
            do { result = .success(try await self?.fetch(text) ?? Data()) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled, self.active, self.inFlight[index]?.id == id else { return }
            self.inFlight.removeValue(forKey: index)
            switch result {
            case .success(let data):
                if index < (self.failedAt ?? Int.max) { self.ready[index] = data }
                self.pump()
            case .failure:
                self.failed(index)
            }
        }
        inFlight[index] = (id, task)
    }

    private func failed(_ index: Int) {
        guard active else { return }
        if index == 0 { fallback(from: 0); return }
        let count = (attempts[index] ?? 0) + 1
        attempts[index] = count
        if count < 2 {
            // One retry, ahead of the look-ahead queue and within the same limit.
            if let entry = inFlight.removeValue(forKey: index) { entry.task.cancel() }
            retries.append(index)
            pump(); return
        }
        giveUp(at: index)
    }

    private func giveUp(at index: Int) {
        let cut = min(failedAt ?? index, index)
        failedAt = cut
        for (key, entry) in inFlight where key >= cut { entry.task.cancel(); inFlight.removeValue(forKey: key) }
        for key in ready.keys where key >= cut { ready.removeValue(forKey: key) }
        retries.removeAll { $0 >= cut }
        stall?.task.cancel(); stall = nil
        pump()
    }

    private func pieceFinished() {
        guard active else { return }
        played += 1
        pump()
    }

    /// Playback is idle and waiting on the next piece: if it does not arrive in
    /// time, the rest goes to the device voice instead of a long silence.
    private func armStallIfWaiting() {
        guard started, failedAt == nil, nextEnqueue == played, nextEnqueue < segments.count else { return }
        let index = nextEnqueue
        if stall?.index == index { return }
        stall?.task.cancel()
        let limit = stallDeadline
        stall = (index, Task { @MainActor [weak self] in
            do { try await Task.sleep(for: limit) } catch { return }
            guard let self, self.active, self.stall?.index == index, self.nextEnqueue == index else { return }
            self.stall = nil
            self.giveUp(at: index)
        })
    }

    private func finish() {
        teardown()
        onEvent(.finished)
    }

    private func fallback(from index: Int) {
        teardown()
        sink.stop()
        onEvent(.fallback(from: index))
    }

    private func teardown() {
        active = false
        deadline?.cancel(); deadline = nil
        stall?.task.cancel(); stall = nil
        for entry in inFlight.values { entry.task.cancel() }
        inFlight.removeAll(); ready.removeAll(); retries.removeAll()
    }
}
