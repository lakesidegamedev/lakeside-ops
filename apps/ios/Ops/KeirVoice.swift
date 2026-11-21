import SwiftUI
import Speech
import AVFoundation
import LakesideCore

/// Audio belongs to the visible conversation. Starting the microphone interrupts
/// speech playback; leaving the screen releases the microphone and audio session.
@MainActor final class KeirVoice: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published private(set) var listening = false
    @Published private(set) var speaking = false
    @Published private(set) var preparingSpeech = false
    @Published private(set) var usingDeviceFallback = false
    /// The online voice spoke the start of this reply and the device voice the rest.
    @Published private(set) var fallbackPartial = false
    @Published private(set) var requesting = false
    @Published private(set) var level = 0.0
    @Published private(set) var completedTurn = 0
    @Published var transcript = ""
    @Published var error: String?
    private let engine = AVAudioEngine()
    private let speaker = AVSpeechSynthesizer()
    /// Loudness of Keir's own voice, observed only by the speaking portrait so
    /// the rest of the screen does not redraw with every sample.
    let meter: KeirVoiceMeter
    private let output: KeirSpeechOutput
    private var pipeline: SpeechPipeline?
    private var meterTask: Task<Void, Never>?
    private var wordPulse = 0.0
    private var meterID = UUID()
    private var playbackID = UUID()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var tapped = false
    private var generation = UUID()
    private var silenceTask: Task<Void, Never>?
    private var lastSpeech = Date()
    private var automaticTurn = false

    init(output: KeirSpeechOutput? = nil) {
        self.output = output ?? KeirAudioQueue(); self.meter = KeirVoiceMeter()
        super.init(); speaker.delegate = self
    }

    func start(automatic: Bool = false) async {
        stop(); error = nil
        let token = UUID(); generation = token; automaticTurn = automatic; lastSpeech = Date()
        requesting = true; defer { if generation == token { requesting = false } }
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard !Task.isCancelled, generation == token else { return }
        let microphone = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard !Task.isCancelled, generation == token else { return }
        guard speech && microphone else { error = "Allow microphone and speech recognition in Settings to talk to Keir."; return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
            error = "Speech recognition is unavailable. You can keep typing."; return
        }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            try audio.setActive(true)
            let buffer = SFSpeechAudioBufferRecognitionRequest()
            buffer.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { buffer.requiresOnDeviceRecognition = true }
            request = buffer; transcript = ""; error = nil
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 && format.channelCount > 0 else {
                throw NSError(domain: "KeirVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
            }
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] audio, _ in
                buffer.append(audio)
                guard let samples = audio.floatChannelData?[0], audio.frameLength > 0 else { return }
                var sum: Float = 0
                for i in 0..<Int(audio.frameLength) { sum += samples[i] * samples[i] }
                let energy = min(1, Double(sqrt(sum / Float(audio.frameLength))) * 12)
                Task { @MainActor in
                    guard self?.generation == token else { return }
                    self?.level = energy
                }
            }
            tapped = true
            recognition = recognizer.recognitionTask(with: buffer) { [weak self] result, failure in
                Task { @MainActor in
                    guard let self, self.generation == token else { return }
                    if let result {
                        let text = result.bestTranscription.formattedString
                        if text != self.transcript { self.lastSpeech = Date(); self.transcript = text }
                    }
                    if result?.isFinal == true || failure != nil {
                        let submit = self.automaticTurn && !self.transcript.isEmpty
                        self.stopListening()
                        if submit { self.completedTurn += 1 }
                        if failure != nil && self.transcript.isEmpty { self.error = "Could not hear that. Tap the microphone to try again." }
                    }
                }
            }
            engine.prepare(); try engine.start(); listening = true
            if automatic {
                silenceTask = Task { @MainActor [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(200))
                        guard !Task.isCancelled, let self, self.generation == token else { return }
                        if !self.transcript.isEmpty && Date().timeIntervalSince(self.lastSpeech) > 1.2 {
                            self.stopListening(); self.completedTurn += 1; return
                        }
                    }
                }
            }
        } catch { stopListening(); self.error = error.localizedDescription }
    }

    func stopListening() {
        generation = UUID(); requesting = false; silenceTask?.cancel(); silenceTask = nil
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        request?.endAudio(); recognition?.cancel(); recognition = nil; request = nil
        listening = false; level = 0
        if !speaking { releaseAudio() }
    }
    /// The device voice, for the Apple setting. Replaces anything playing.
    func speak(_ text: String) {
        stop()
        speakDevice(text)
    }
    /// Speaks with the device voice without stopping first, so a hand-over from
    /// the online voice keeps `speaking` true and listening does not restart.
    private func speakDevice(_ text: String) {
        guard !text.isEmpty else { return }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playback, mode: .spokenAudio)
            try audio.setActive(true)
            let cleaned = Self.spokenText(text)
            guard !cleaned.isEmpty else { speaking = false; if !listening { releaseAudio() }; return }
            let identifier = UserDefaults.standard.string(forKey: "keir-voice-id") ?? "auto"
            let speed = UserDefaults.standard.object(forKey: "keir-voice-rate") as? Double ?? 0.92
            let selected = identifier == "auto" ? Self.bestVoice : AVSpeechSynthesisVoice(identifier: identifier) ?? Self.bestVoice
            speaking = true; runMeter()
            // Paragraphs keep natural pauses and let playback begin immediately.
            for paragraph in cleaned.components(separatedBy: "\n\n").filter({ !$0.isEmpty }) {
                let utterance = AVSpeechUtterance(string: paragraph)
                utterance.voice = selected
                utterance.rate = AVSpeechUtteranceDefaultSpeechRate * Float(min(1.2, max(0.7, speed)))
                utterance.postUtteranceDelay = 0.15
                speaker.speak(utterance)
            }
        } catch { speaking = false; self.error = "Spoken reply could not start."; releaseAudio() }
    }
    func speakReply(_ text: String, session: AppSession) {
        usingDeviceFallback = false; fallbackPartial = false
        if UserDefaults.standard.string(forKey: "keir-speech-provider") == "apple" { speak(text) }
        else { speakMicrosoft(text, session: session) }
    }
    /// The online voice, piece by piece (see `SpeechPipeline`). The first piece
    /// has `deadline`; when it fails or is late the whole reply goes to the device
    /// voice. When a later piece fails, the pieces before it finish and the rest
    /// goes to the device voice. `deviceSpeech` replaces the device voice in tests.
    func speakMicrosoft(_ text: String, session: AppSession, deadline: Duration = .seconds(8), deviceSpeech: ((String) -> Void)? = nil) {
        stop()
        let cleaned = Self.spokenText(text)
        guard !cleaned.isEmpty else { return }
        let token = UUID(); playbackID = token; preparingSpeech = true; error = nil
        usingDeviceFallback = false; fallbackPartial = false
        let pieces = VoiceSegments.segments(cleaned)
        let useDevice: (Int) -> Void = { [weak self] from in
            guard let self, self.playbackID == token else { return }
            self.pipeline = nil
            let rest = from == 0 ? cleaned : pieces[from...].joined(separator: " ")
            self.preparingSpeech = false; self.usingDeviceFallback = true; self.fallbackPartial = from > 0
            if let deviceSpeech { self.speaking = false; deviceSpeech(rest) }
            else { self.speakDevice(rest) }
        }
        do { try output.begin() } catch { useDevice(0); return }
        // The pipeline lives only as long as this reply, so holding the session
        // here keeps no extra state alive.
        let pipeline = SpeechPipeline(segments: pieces, sink: output, firstDeadline: deadline, stallDeadline: Self.stallDeadline) { piece in
            try await session.speechAudio(piece)
        }
        pipeline.onEvent = { [weak self] event in
            guard let self, self.playbackID == token else { return }
            switch event {
            case .started:
                self.preparingSpeech = false; self.speaking = true; self.runMeter()
            case .finished:
                self.pipeline = nil; self.preparingSpeech = false; self.speaking = false
                if !self.listening { self.releaseAudio() }
            case .fallback(let from):
                useDevice(from)
            }
        }
        self.pipeline = pipeline
        pipeline.start()
    }
    /// How long playback may sit silent waiting for a later piece before the
    /// rest of the reply goes to the device voice.
    static let stallDeadline: Duration = .seconds(8)
    /// Samples the loudness of what is playing about twelve times a second while
    /// Keir speaks, for the speaking portrait. Stops by itself when speech ends.
    private func runMeter() {
        guard meterTask == nil else { return }
        let id = UUID(); meterID = id
        meterTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, self.speaking else { break }
                let online = self.usingDeviceFallback ? 0 : self.output.level
                self.meter.update(max(online, self.wordPulse))
                self.wordPulse *= 0.55
                try? await Task.sleep(for: .milliseconds(83))
            }
            guard let self, self.meterID == id else { return }
            self.meter.update(0); self.meterTask = nil
        }
    }
    static var availableVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices().sorted {
            if $0.language != $1.language { return $0.language < $1.language }
            if $0.quality != $1.quality { return $0.quality.rawValue > $1.quality.rawValue }
            return $0.name < $1.name
        }
    }
    static var bestVoice: AVSpeechSynthesisVoice? {
        let language = Locale.current.language.languageCode?.identifier ?? "en"
        let locale = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        return availableVoices.filter { $0.language.hasPrefix(language) }.sorted {
            if $0.quality != $1.quality { return $0.quality.rawValue > $1.quality.rawValue }
            return ($0.language == locale ? 1 : 0) > ($1.language == locale ? 1 : 0)
        }.first ?? AVSpeechSynthesisVoice(language: locale)
    }
    static func spokenText(_ text: String) -> String {
        text.replacingOccurrences(of: "```[\\s\\S]*?```", with: "Code is shown in the conversation.", options: .regularExpression)
            .replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "(?m)^\\s{0,3}(?:#{1,6}\\s+|[-*]\\s+|>\\s*)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[*_`]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    func stopSpeaking() {
        preparingSpeech = false; playbackID = UUID()
        pipeline?.cancel(); pipeline = nil; output.stop()
        speaker.stopSpeaking(at: .immediate); speaking = false
        meterTask?.cancel(); meterTask = nil; meterID = UUID(); wordPulse = 0; meter.update(0)
        if !listening { releaseAudio() }
    }
    func stop() { stopListening(); stopSpeaking() }
    private func releaseAudio() { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    /// Each word the device voice starts gives the portrait's mouth a beat, since
    /// the synthesizer offers no loudness reading.
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.wordPulse = 0.8 }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, !self.speaker.isSpeaking else { return }
            self.speaking = false; if !self.listening { self.releaseAudio() }
        }
    }
}
