#if DEBUG
import Foundation

/// Synthetic answers for the connected-games routes, used only by UI and session
/// tests through FixtureProtocol. Absent from Release builds. Every value is a
/// plain test value; none of it describes a real game.
enum KeirGamesFixtures {
    /// Test switches: `--uitest-games-unavailable` makes MetroForge's reads fail, `--uitest-games-unregistered` removes Grand Century's connection.
    static func value(_ path: String, method: String, arguments: [String] = ProcessInfo.processInfo.arguments) -> Any? {
        guard method == "GET", path == "/api/keir/app/games" || path.hasPrefix("/api/keir/app/games/") else { return nil }
        let unavailable = arguments.contains("--uitest-games-unavailable")
        let unregistered = arguments.contains("--uitest-games-unregistered")
        let now = ISO8601DateFormatter().string(from: Date())
        let withheld: [String: [String]] = ["ahd": ["Player accounts, holdings and private data"], "metroforge": ["Leaderboard (lists player names)", "Simulation runs (they execute code)"], "grand-century": ["World simulation runs (they execute code)"]]
        let scope: [String: String] = ["ahd": "Live turn and engine health. Player tickets and Discord pings are read through the Inbox, not here.", "metroforge": "Service and release health, and which city bundles ship.", "grand-century": "Live site and release health."]
        let names: [String: String] = ["ahd": "A House Divided", "metroforge": "MetroForge", "grand-century": "Grand Century"]
        func state(_ id: String) -> String { id == "grand-century" && unregistered ? "unsupported" : "available" }
        func row(_ id: String) -> [String: Any] {
            var out: [String: Any] = ["id": id, "name": names[id] ?? id, "scope": scope[id] ?? "", "withheld": withheld[id] ?? [], "state": state(id)]
            if state(id) == "unsupported" { out["note"] = "No read connection is registered for this game on the studio host." }
            return out
        }
        if path == "/api/keir/app/games" { return ["games": ["ahd", "metroforge", "grand-century"].map(row)] }
        let id = String(path.dropFirst("/api/keir/app/games/".count))
        guard let name = names[id] else { return ["error": "unknown game"] }
        let tickets: [String: Any] = id == "ahd"
            ? ["id": "tickets", "label": "Tickets and pings", "state": "available", "note": "Open the Inbox. Keir reads tickets there; they are not re-read in this sheet."]
            : ["id": "tickets", "label": "Tickets and pings", "state": "unsupported", "note": "Support tickets come from the A House Divided desk only. Nothing here connects them to this game."]
        var detail = row(id); detail["name"] = name; detail["capabilities"] = [tickets]
        if state(id) == "unsupported" { detail["reads"] = [] as [Any]; return detail }
        func live(_ readID: String, _ label: String, _ source: String, _ facts: [[String: String]], note: String? = nil) -> [String: Any] {
            var read: [String: Any] = ["id": readID, "label": label, "source": source, "state": "live", "checkedAt": now, "facts": facts]
            if let note { read["note"] = note }
            return read
        }
        func down(_ readID: String, _ label: String, _ source: String) -> [String: Any] {
            ["id": readID, "label": label, "source": source, "state": "unavailable", "checkedAt": now, "facts": [] as [Any], "note": "Keir could not read this just now. That says nothing about the game itself."]
        }
        func fact(_ label: String, _ value: String) -> [String: String] { ["label": label, "value": value] }
        switch id {
        case "ahd":
            detail["reads"] = [live("turns", "Turns and engine health", "engine · engine_health", [fact("Turn", "7"), fact("Game", "Running"), fact("Latest turn", "Succeeded in 120 s")])]
            detail["state"] = "live"
        case "metroforge":
            if unavailable {
                detail["reads"] = [down("deploy", "Service and release health", "metroforge · mf_status"), down("cities", "City bundles", "metroforge · mf_cities")]
                detail["state"] = "unavailable"
            } else {
                detail["reads"] = [live("deploy", "Service and release health", "metroforge · mf_status", [fact("Preview site", "Responding"), fact("API", "Responding")], note: "Deploy and service health only. This does not read players, scores or gameplay."),
                                   live("cities", "City bundles", "metroforge · mf_cities", [fact("Bundles", "2"), fact("Names", "Testville, Sampleport")])]
                detail["state"] = "live"
            }
        default:
            detail["reads"] = [live("deploy", "Live site and release health", "grand-century · gc_status", [fact("Live site", "Responding"), fact("Latest release", "None published")], note: "Reports the live site and the latest commit separately. It does not show that the live site was built from that commit, and it does not read players or gameplay.")]
            detail["state"] = "live"
        }
        return detail
    }
}
#endif
