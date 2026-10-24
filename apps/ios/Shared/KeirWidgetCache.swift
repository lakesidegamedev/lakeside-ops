import Foundation
import WidgetKit

/// The one piece of state the Home Screen widget can see. The app writes the
/// latest starmer payload here after every fetch; the widget reads it from the
/// shared App Group and never makes an authenticated request of its own.
enum KeirWidgetCache {
    static let appGroup = "group.net.lakesidegames.ops"
    static let key = "keir.widget.snapshot"

    struct Snapshot: Codable {
        var text: String
        var at: Double
        var running: Int
        var waiting: Int
        var queued: Int
        var headline: String
        var detail: String
        var savedAt: Double
    }

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func load() -> Snapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func save(text: String, at: Double, running: Int, waiting: Int, queued: Int, headline: String, detail: String) {
        let snapshot = Snapshot(text: text, at: at, running: running, waiting: waiting, queued: queued,
                                headline: headline, detail: detail, savedAt: Date().timeIntervalSince1970)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        let previous = load()
        defaults?.set(data, forKey: key)
        // WidgetKit budgets reloads. Only wake it when the line or the queue
        // actually changed, not on every two-minute poll.
        if previous?.text != snapshot.text || previous?.running != snapshot.running || previous?.waiting != snapshot.waiting {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
