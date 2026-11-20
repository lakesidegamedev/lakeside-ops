import Foundation
import LakesideCore

/// Per-device quiet hours, chosen by the owner. Off by default. The window is
/// wall-clock time in the chosen zone, so daylight saving moves it with the
/// clock, and a start after the end crosses midnight. There is no urgent
/// bypass: while it applies, Keir holds everything for this phone (approvals
/// included) and sends what is still open afterwards. The server applies the
/// same rule; this copy only explains it and drives the settings screen.
struct QuietHours: Equatable {
    var enabled = false
    var startMinutes = 22 * 60
    var endMinutes = 7 * 60
    var timeZone = TimeZone.current.identifier

    var isUsable: Bool { startMinutes != endMinutes && TimeZone(identifier: timeZone) != nil }

    static func text(_ minutes: Int) -> String { String(format: "%02d:%02d", minutes / 60, minutes % 60) }

    /// The exact shape the server stores. A window that would be unusable is sent as off.
    var payload: JSONValue {
        guard enabled, isUsable else { return .object(["enabled": .bool(false)]) }
        return .object(["enabled": .bool(true), "start": .string(Self.text(startMinutes)), "end": .string(Self.text(endMinutes)), "tz": .string(timeZone)])
    }

    func isQuiet(at date: Date) -> Bool {
        guard enabled, isUsable, let zone = TimeZone(identifier: timeZone) else { return false }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        return startMinutes < endMinutes ? now >= startMinutes && now < endMinutes : now >= startMinutes || now < endMinutes
    }

    /// Plain wording for the settings screen.
    var summary: String {
        guard enabled else { return "Off. Notifications arrive any time." }
        guard isUsable else { return "Choose different start and end times." }
        return "Quiet from \(Self.text(startMinutes)) to \(Self.text(endMinutes)) in \(timeZone). Nothing is delivered then, including approvals. Open approvals are sent when it ends."
    }

    private static let key = "push.quiet"
    static func load(_ defaults: UserDefaults = .standard) -> QuietHours {
        guard let raw = defaults.dictionary(forKey: key) else { return QuietHours() }
        return QuietHours(enabled: raw["enabled"] as? Bool ?? false, startMinutes: raw["start"] as? Int ?? 22 * 60, endMinutes: raw["end"] as? Int ?? 7 * 60,
                          timeZone: raw["tz"] as? String ?? TimeZone.current.identifier)
    }
    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(["enabled": enabled, "start": startMinutes, "end": endMinutes, "tz": timeZone], forKey: Self.key)
    }
}
