import SwiftUI
import LakesideCore

/// Ask's color, Linear's density, Things' type. One accent: sky is action,
/// mint is healthy or live, warn is blocked or needs you.
enum OpsTheme {
    static let background = Brand.background
    static let surface = Brand.surface
    static let raised = Brand.raised
    static let hairline = Brand.adaptive(0x262628, 0xe1e4e9)
    static let ink = Brand.ink
    // 6.7:1 on true black and 5.4:1 on the light canvas.
    static let muted = Brand.adaptive(0x8e8e93, 0x5b6470)
    static let accent = Brand.sky
    static let success = Brand.mint
    static let sky = accent
    static let mint = success
    static let warn = Brand.adaptive(0xe3ba88, 0xb26a12)
    static let danger = Brand.adaptive(0xf08a8a, 0xc0392b)
    /// Blocked by something other than the owner: a dependency, a missing
    /// receipt. Kept apart from amber, which means "waiting on you".
    static let blocked = Brand.adaptive(0xb7a2ff, 0x6d4fd8)
    static let onAccent = Brand.onAccent
    static let neutral = muted
    /// Soft depth under raised surfaces in Light; nothing on OLED black.
    static let shadow = Brand.lightOnly(0x1b2a3c, alpha: 0.07)
    static let warning = warn
}

extension View {
    func opsScreen() -> some View {
        scrollContentBackground(.hidden)
            .background(OpsTheme.background)
            .safeAreaPadding(.bottom, 16)
            .clipped()
            .toolbarBackground(OpsTheme.background, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .toolbarBackground(OpsTheme.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// 11pt-equivalent semibold muted caps: the only section label style. It
/// scales with Dynamic Type instead of pinning a point size.
struct SectionLabel: View {
    let text: String
    var count: Int? = nil
    var identifier: String? = nil
    var body: some View {
        HStack(spacing: 6) {
            Text(text).opsSectionHeader()
            if let count {
                Text("\(count)").font(.opsSection).monospacedDigit().foregroundStyle(OpsTheme.muted)
                    .accessibilityIdentifier(identifier ?? "section-count")
            }
            Spacer()
        }.accessibilityAddTraits(.isHeader)
    }
}

/// A line of work at rest: optional 2pt state bar, title, one meta line.
struct WorkRow<Trailing: View>: View {
    let title: String
    let meta: String
    var bar: Color? = nil
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1).fill(bar ?? .clear).frame(width: 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.callout.weight(.semibold)).tracking(-0.2).lineLimit(2).foregroundStyle(OpsTheme.ink)
                if !meta.isEmpty { Text(meta).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2).monospacedDigit() }
            }
            Spacer(minLength: 8)
            trailing()
        }.padding(.vertical, 10).padding(.trailing, 4).contentShape(Rectangle())
    }
}
extension WorkRow where Trailing == EmptyView {
    init(title: String, meta: String, bar: Color? = nil) { self.init(title: title, meta: meta, bar: bar) { EmptyView() } }
}

struct StateWord: View {
    let text: String
    let color: Color
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption.weight(.medium))
        }.foregroundStyle(color)
    }
}

/// A big number only when it means something.
struct Figure: View {
    let value: String
    let label: String
    var tone: Color = OpsTheme.ink
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit().foregroundStyle(tone).contentTransition(.numericText())
            Text(label).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
    }
}

struct Hairline: View { var body: some View { Rectangle().fill(OpsTheme.hairline).frame(height: 1) } }

enum OpsFormat {
    static func ago(_ value: JSONValue) -> String {
        if let ms = value.number, ms > 1_000_000_000_000 { return ago(Date(timeIntervalSince1970: ms / 1000)) }
        if let ms = value.number, ms > 1_000_000_000 { return ago(Date(timeIntervalSince1970: ms)) }
        let text = value.string
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: text) ?? ISO8601DateFormatter().date(from: text) { return ago(d) }
        return ""
    }
    static func ago(_ date: Date) -> String {
        let s = Date().timeIntervalSince(date)
        if s < 0 { return "in " + span(-s) }
        if s < 45 { return "now" }
        return span(s) + " ago"
    }
    /// How long something has waited on the owner. Grey while recent; past a
    /// week it says "Waiting" and turns amber, so the colour has a stated reason.
    static func waiting(_ date: Date, now: Date = Date()) -> (text: String, color: Color) {
        let age = now.timeIntervalSince(date)
        if age >= 7 * 86_400 { return ("Waiting " + span(age), OpsTheme.warning) }
        return (ago(date), OpsTheme.muted)
    }
    static func span(_ s: Double) -> String {
        if s < 3600 { return "\(max(1, Int(s / 60)))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86400))d"
    }
    static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("hma")
        return formatter.string(from: date)
    }
    static func contextual(_ date: Date) -> String {
        let calendar = Calendar.autoupdatingCurrent
        if calendar.isDateInToday(date) { return clock(date) }
        if calendar.isDateInYesterday(date) { return "Yesterday " + clock(date) }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
    static func date(_ value: JSONValue) -> Date? {
        if let timestamp = value.number, timestamp > 1_000_000_000 {
            return Date(timeIntervalSince1970: timestamp > 1_000_000_000_000 ? timestamp / 1000 : timestamp)
        }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso.date(from: value.string) ?? ISO8601DateFormatter().date(from: value.string)
    }
    static func percent(_ value: Double?) -> String { value.map { "\(Int(($0 * 100).rounded()))%" } ?? "-" }
    /// A percentage that already arrives as 0 to 100 (service uptime), not a
    /// 0 to 1 fraction, so it is never multiplied a second time.
    static func percentValue(_ value: Double?) -> String { value.map { String(format: "%.2f%%", $0) } ?? "-" }
}

/// Keir's job and ticket states as one vocabulary, backed by `OpsStatus` so an
/// icon or colour never says something different from its word.
enum OpsState {
    static func status(_ state: String) -> OpsStatus { OpsStatus.from(state) }
    static func color(_ state: String) -> Color { status(state).color }
    static func icon(_ state: String) -> String { status(state).icon }
    static func word(_ state: String) -> String { OpsText.stateWord(state) }
}
