import SwiftUI
import AVFoundation
import LakesideCore

/// Where Keir's online voice plays. `begin` sets up the audio session once per
/// reply (never per piece); `level` is the loudness of what is audible now,
/// from 0 to 1.
@MainActor protocol KeirSpeechOutput: SpeechAudioSink {
    func begin() throws
    var level: Double { get }
}

/// Plays decoded pieces back to back. Each piece is scheduled on the audio
/// device clock to start exactly when the previous one ends, so there is no gap
/// and no overlap between pieces. Metering is read only when asked, by the
/// voice's low-rate meter, never per render.
@MainActor final class KeirAudioQueue: NSObject, KeirSpeechOutput, AVAudioPlayerDelegate {
    private struct Item {
        let player: AVAudioPlayer
        let finished: @MainActor () -> Void
    }
    private var items: [Item] = []
    /// Device-clock time at which the last queued piece ends.
    private var queueEnd: TimeInterval = 0
    private var rate: Float = 1

    func begin() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .spokenAudio)
        try audio.setActive(true)
        let stored = UserDefaults.standard.object(forKey: "keir-voice-rate") as? Double ?? 1.0
        rate = Float(min(2, max(0.5, stored)))
    }

    func enqueue(_ audio: Data, finished: @escaping @MainActor () -> Void) throws {
        let player = try AVAudioPlayer(data: audio)
        player.delegate = self
        player.isMeteringEnabled = true
        player.enableRate = true
        player.rate = rate
        guard player.prepareToPlay() else { throw URLError(.cannotDecodeContentData) }
        let now = player.deviceCurrentTime
        let length = player.duration / Double(max(0.5, rate))
        let playing: Bool
        if items.isEmpty || queueEnd <= now + 0.01 {
            playing = player.play()
            queueEnd = now + length
        } else {
            playing = player.play(atTime: queueEnd)
            queueEnd += length
        }
        guard playing else { throw URLError(.cannotDecodeContentData) }
        items.append(Item(player: player, finished: finished))
    }

    func stop() {
        let old = items
        items = []; queueEnd = 0
        for item in old { item.player.delegate = nil; item.player.stop() }
    }

    var level: Double {
        guard let player = items.first?.player, player.isPlaying else { return 0 }
        player.updateMeters()
        let power = Double(player.averagePower(forChannel: 0))
        return min(1, max(0, (power + 45) / 35))
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor [weak self] in self?.finish(id) }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let id = ObjectIdentifier(player)
        Task { @MainActor [weak self] in self?.finish(id) }
    }
    private func finish(_ id: ObjectIdentifier) {
        guard let index = items.firstIndex(where: { ObjectIdentifier($0.player) == id }) else { return }
        let item = items.remove(at: index)
        item.finished()
    }
}

/// The loudness Keir's portrait follows while he speaks. Values are rounded so
/// small changes do not redraw; `tick` advances with every sample so the mouth
/// can alternate between the open frames.
@MainActor final class KeirVoiceMeter: ObservableObject {
    @Published private(set) var level = 0.0
    @Published private(set) var tick = 0

    func update(_ value: Double) {
        let rounded = (min(1, max(0, value)) * 10).rounded() / 10
        if rounded == 0 && level == 0 { return }
        level = rounded
        tick &+= 1
    }
}
