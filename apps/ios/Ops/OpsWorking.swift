import SwiftUI
import UIKit

// The app's one way of saying "working": a small 12-bar spinner beside a line
// of text whose glyphs carry a light band sweeping left to right. Both match
// the Ask website's status line (the "classic" spinner and `.shimmer`). They
// are only ever shown while something is really in progress; idle, done,
// stalled and blocked states use the static glyphs from `OpsWorkState`.
//
// Rule for spinner versus static glyph: a spinner means "this is happening
// right now" (Keir is working, a task row that is running, the button the
// owner just tapped). Counts, chips, tiles and section headers are category
// labels and use the static Running glyph, `progress.indicator`, which is a
// still picture of the same spinner.

/// Shared clock rules for every animated indicator.
enum OpsMotion {
    /// UI tests capture stills. Motion is frozen at one fixed phase there so
    /// screenshots are stable and comparable between runs.
    static let frozen = ProcessInfo.processInfo.arguments.contains("--uitest-fixtures")
    static let frozenPhase: Double = 0.35

    /// Where a repeating animation of `period` seconds is at `date`, from 0 to 1.
    /// Derived from the clock, not from view state, so a re-render never
    /// restarts the sweep.
    static func phase(_ date: Date, period: Double) -> Double {
        if frozen { return frozenPhase }
        return (date.timeIntervalSinceReferenceDate / period).truncatingRemainder(dividingBy: 1)
    }
}

/// Text with the Ask site's shimmer: a gradient from the dim text colour to
/// the full text colour and back, clipped to the glyphs, sweeping left to
/// right every 2.2 seconds, linear. The gradient repeats every 220 points
/// whatever the text's length, so a changing status line does not rescale or
/// restart it. With Reduce Motion, or when `active` is false, it is plain
/// secondary text. The clock pauses when the view is off screen or the app is
/// in the background.
struct OpsShimmerText: View {
    let text: String
    var active = true
    @State private var width: CGFloat = 0
    @State private var onScreen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    static let period: CGFloat = 220
    static let duration: Double = 2.2

    var body: some View {
        if !active || reduceMotion {
            Text(text).foregroundStyle(OpsTheme.muted)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: OpsMotion.frozen || !onScreen || scenePhase != .active)) { context in
                Text(text).foregroundStyle(style(OpsMotion.phase(context.date, period: Self.duration)))
            }
            .background {
                GeometryReader { geometry in
                    Color.clear
                        .onAppear { width = geometry.size.width }
                        .onChange(of: geometry.size.width) { _, next in width = next }
                }
            }
            .onAppear { onScreen = true }
            .onDisappear { onScreen = false }
        }
    }

    private func style(_ phase: Double) -> AnyShapeStyle {
        guard width >= 1 else { return AnyShapeStyle(OpsTheme.muted) }
        return AnyShapeStyle(Self.gradient(phase: phase, width: width))
    }

    /// A periodic gradient laid across `width` points: dim at each multiple of
    /// the period, full at each half period, shifted right by `phase` periods.
    static func gradient(phase: Double, width: CGFloat) -> LinearGradient {
        let dim = OpsTheme.muted, full = OpsTheme.ink
        let start = CGFloat(phase) * period - period
        let tiles = max(1, Int(((width - start) / period).rounded(.up)))
        let span = CGFloat(tiles) * period
        var stops: [Gradient.Stop] = []
        for index in 0..<tiles {
            let base = CGFloat(index) / CGFloat(tiles)
            stops.append(Gradient.Stop(color: dim, location: base))
            stops.append(Gradient.Stop(color: full, location: base + 0.5 / CGFloat(tiles)))
        }
        stops.append(Gradient.Stop(color: dim, location: 1))
        return LinearGradient(stops: stops,
                              startPoint: UnitPoint(x: start / width, y: 0.5),
                              endPoint: UnitPoint(x: (start + span) / width, y: 0.5))
    }
}

/// The Ask site's "classic" spinner: twelve short rounded bars in a ring, each
/// fading from full to 15 percent over 1.2 seconds, staggered by a twelfth so
/// the lit bar chases clockwise. Reduce Motion shows the ring still at 55
/// percent. Drawn in one Canvas, paused off screen.
struct OpsSpinner: View {
    var tint: Color = OpsWorkState.running.color
    var size: CGFloat = 14
    @State private var onScreen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    static let duration: Double = 1.2

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || OpsMotion.frozen || !onScreen || scenePhase != .active)) { context in
            let phase = OpsMotion.phase(context.date, period: Self.duration)
            Canvas { canvas, area in
                let side = min(area.width, area.height)
                let center = CGPoint(x: area.width / 2, y: area.height / 2)
                let length = side * 0.25
                let thickness = max(1.4, side * 0.09)
                let radius = side * 0.34
                for index in 0..<12 {
                    let opacity: Double
                    if reduceMotion { opacity = 0.55 } else {
                        var progress = phase - Double(index) / 12
                        progress -= progress.rounded(.down)
                        opacity = 1 - 0.85 * progress
                    }
                    let angle = Double(index) * .pi / 6
                    var bar = canvas
                    bar.translateBy(x: center.x, y: center.y)
                    bar.rotate(by: .radians(angle))
                    let rect = CGRect(x: radius - length / 2, y: -thickness / 2, width: length, height: thickness)
                    bar.fill(Path(roundedRect: rect, cornerRadius: thickness / 2), with: .color(tint.opacity(opacity)))
                }
            }
        }
        .frame(width: size, height: size)
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .accessibilityHidden(true)
    }
}

/// Spinner plus shimmering text: "Keir is working", a task's activity, a
/// button's "Approving". VoiceOver reads the words only, never the animation.
struct OpsWorkingLabel: View {
    let text: String
    var tint: Color = OpsWorkState.running.color
    var accessibilityText: String? = nil
    @ScaledMetric(relativeTo: .caption) private var spinnerSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 6) {
            OpsSpinner(tint: tint, size: spinnerSize)
            OpsShimmerText(text: text)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText ?? text)
    }
}

/// Haptics fired at the moment of the tap, before any network work, so the
/// phone answers the finger even when the server is slow.
@MainActor enum OpsTap {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    static func tap() { light.impactOccurred() }
    static func commit() { medium.impactOccurred() }
}
