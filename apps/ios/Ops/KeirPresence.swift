import SwiftUI

struct KeirPresence: View {
    enum State: String { case ready = "Ready", listening = "Listening", thinking = "Thinking", working = "Working", approval = "Your turn", speaking = "Speaking", stopped = "Stopped", offline = "Reconnecting" }
    let state: State
    let level: Double
    @Environment(\.accessibilityReduceMotion) private var reduced
    var body: some View {
        HStack(spacing: 8) {
            if state == .listening { KeirAudioWaveform(level: level).frame(width: 28, height: 18) }
            else if state == .speaking { Image(systemName: "speaker.wave.2.fill").foregroundStyle(OpsTheme.sky).symbolEffect(.variableColor.iterative, options: .repeating, isActive: !reduced) }
            else if state == .approval { Image(systemName: "hand.raised").foregroundStyle(OpsTheme.warn) }
            if state == .thinking || state == .working { LoadingShimmer(text: state.rawValue) }
            else { Text(state.rawValue).foregroundStyle(state == .stopped || state == .approval ? OpsTheme.warn : OpsTheme.muted) }
        }.font(.callout).accessibilityElement(children: .combine).accessibilityIdentifier("keir-presence")
    }
}

/// Microphone energy, never a simulated activity waveform.
struct KeirAudioWaveform: View {
    let level: Double
    @Environment(\.accessibilityReduceMotion) private var reduced
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<7) { index in
                Capsule().fill(OpsTheme.sky).frame(width: 3, height: 3 + max(0, min(1, level)) * Double(15 - abs(index - 3) * 3))
            }
        }.animation(reduced ? nil : .linear(duration: 0.08), value: level).accessibilityHidden(true)
    }
}
