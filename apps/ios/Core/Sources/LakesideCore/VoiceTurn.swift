import Foundation

/// A voice turn follows its accepted job, independently of unrelated chat updates.
public enum VoiceTurn {
    public static func reply(in messages: [JSONValue], jobID: String) -> JSONValue? {
        messages.last { $0["role"].string == "keir" && $0["jobId"].string == jobID && !$0["text"].string.isEmpty }
    }
    public static func blocker(in tasks: [JSONValue], jobID: String) -> String? {
        guard let task = tasks.first(where: { $0["id"].string == jobID }) else { return nil }
        if !task["approvals"].array.isEmpty { return "Keir needs your decision. Open the task to review it." }
        if ["blocked", "cancelled", "dismissed", "paused"].contains(task["state"].string) {
            return task["blocker"]["message"].string.nonempty ?? task["summary"].string.nonempty ?? "This voice task needs attention. Open the task to continue."
        }
        return nil
    }
}

private extension String { var nonempty: String? { isEmpty ? nil : self } }
