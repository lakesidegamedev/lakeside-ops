import SwiftUI
import UserNotifications
import LakesideCore

/// One owner session for the whole app, shared with notification actions that
/// run while the app is in the background.
@MainActor final class OpsServices {
    static let shared = OpsServices()
    let session = AppSession(.ops)
    let ops = OpsStore()
    let keir = KeirStore()
    let router = OpsRouter()
    let push = OpsPushStatus()
    func reset() { keir.reset(); ops.reset(); router.reset(); push.error = nil; push.lastRegistered = nil; push.message = "Not registered yet" }
}

@MainActor final class OpsRouter: ObservableObject {
    @Published var tab: OpsTab = .keir
    @Published var openKeirControls = false
    @Published var openKeirVoice = false
    @Published var destination: OpsDestination?
    @Published var activityFilter = "all"
    /// Pushed screens inside the Ops tab. Feed and Goals used to be tabs of their
    /// own; they now live under Ops, and notifications reach them through here.
    @Published var studioPath: [StudioRoute] = []
    func open(_ route: StudioRoute) { tab = .ops; studioPath = [route] }
    func openTask(_ id: String) { tab = .activity; destination = .task(id) }
    func openDecision(_ id: String) { activityFilter = "all"; tab = .activity; destination = .decision(id) }
    func openDecisionTask(_ decision: JSONValue) {
        if decision["canOpenTask"] == .bool(false), decision["ticket"] != .null { tab = .activity; destination = .ticket(.object(["number": decision["ticket"]])) }
        else { openTask(decision["jobId"].string) }
    }
    func reset() { tab = .keir; openKeirControls = false; openKeirVoice = false; destination = nil; activityFilter = "all"; studioPath = [] }
}

enum OpsDestination: Identifiable, Equatable {
    case task(String), decision(String), ticket(JSONValue), alerts
    var id: String { switch self { case .task(let id): return "task-" + id; case .decision(let id): return "decision-" + id; case .ticket(let ticket): return "ticket-" + ticket["number"].string; case .alerts: return "alerts" } }
}

/// The three places the app lives: the conversation, the inbox (tickets,
/// decisions, work) and the studio's operations. `activity` is the inbox; the
/// case keeps its name so links and notifications written for earlier builds
/// still resolve.
enum OpsTab: Hashable { case keir, activity, ops }

/// Screens reachable from Ops that earlier builds exposed as tabs.
enum StudioRoute: Hashable { case feed, goals }

@MainActor final class OpsPushStatus: ObservableObject {
    @Published var message = "Not registered yet"
    @Published var lastRegistered: Date?
    @Published var error: String?
}

enum OpsPushPrefs {
    static let keys = ["replies", "decisions", "incidents", "feed"]
    static func value(_ key: String) -> Bool { UserDefaults.standard.object(forKey: "push.\(key)") as? Bool ?? true }
    static func set(_ key: String, _ on: Bool) { UserDefaults.standard.set(on, forKey: "push.\(key)") }
    static var payload: JSONValue { .object(Dictionary(uniqueKeysWithValues: keys.map { ($0, JSONValue.bool(value($0))) })) }
}

final class OpsAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let decisionCategory = "KEIR_DECISION"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Approve needs Face ID: it carries the owner's authority.
        let approve = UNNotificationAction(identifier: "approve", title: "Approve", options: [.authenticationRequired])
        let reject = UNNotificationAction(identifier: "reject", title: "Reject", options: [.authenticationRequired, .destructive])
        let reply = UNTextInputNotificationAction(identifier: "explain", title: "Reply", options: [.authenticationRequired], textInputButtonTitle: "Send", textInputPlaceholder: "Ask Keir why, or what to change")
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.decisionCategory, actions: [approve, reject, reply], intentIdentifiers: [], options: [])])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await OpsPushRegistration.send(token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in OpsServices.shared.push.error = "Apple device registration failed: \(error.localizedDescription)" }
    }

    // Use explicit Objective-C completion handlers. The async delegate bridge
    // can invoke UIKit's snapshot completion on a cooperative background thread.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            let info = notification.request.content.userInfo
            let thread = info["thread"] as? String ?? "main"
            let services = OpsServices.shared
            let onThread = services.router.tab == .keir && services.keir.thread == thread && UIApplication.shared.applicationState == .active
            completionHandler(info["route"] as? String == "keir" && onThread ? [] : [.banner, .list, .sound])
            await OpsPushRegistration.refresh()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        OpsNotificationDelivery.handle(route: info["route"] as? String, thread: info["thread"] as? String,
                                       decision: info["decision"] as? String, action: response.actionIdentifier,
                                       text: (response as? UNTextInputNotificationResponse)?.userText ?? "", completion: completionHandler)
    }
}

enum OpsNotificationDelivery {
    nonisolated static func handle(route: String?, thread: String?, decision: String?, action: String, text: String,
                                    completion: @escaping () -> Void) {
        Task { @MainActor in
            defer { completion() }
            let services = OpsServices.shared
            switch route {
            case "keir": services.keir.select(thread ?? "main"); services.router.tab = .keir
            case "decision": if let decision { services.router.openDecision(decision) } else { services.router.tab = .activity }
            case "alerts": services.router.tab = .ops; services.router.destination = .alerts
            case "feed": services.router.open(.feed)
            default: break
            }
            if let decision, ["approve", "reject", "explain"].contains(action) {
                await OpsPushRegistration.answer(decision, verdict: action, text: text)
            }
        }
    }
}

@MainActor enum OpsPushRegistration {
    static func request() async {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--uitest-fixtures") { return }
#endif
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        OpsServices.shared.push.message = granted ? "Registering with Apple" : "Notifications are off in iOS Settings"
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        await update()
    }
    static func answer(_ decision: String, verdict: String, text: String) async {
        let services = OpsServices.shared
        if !services.session.signedIn { await services.session.restore() }
        _ = await services.ops.answer(decision, verdict: verdict, text: text, services.session)
    }
    static func refresh() async { await OpsServices.shared.ops.refresh(OpsServices.shared.session) }
    static func send(_ token: String, session: AppSession? = nil) async {
        // APNs can return before sign-in restoration. Retain the token first.
        UserDefaults.standard.set(token, forKey: "push.token")
        let appSession = session ?? OpsServices.shared.session
        guard appSession.signedIn else { return }
        let status = OpsServices.shared.push
        do {
            _ = try await appSession.post("/api/keir/app/devices", ["token": .string(token), "prefs": OpsPushPrefs.payload, "quiet": QuietHours.load().payload])
            status.lastRegistered = Date(); status.message = "Registered with Keir"; status.error = nil
        } catch { status.error = "Device registration will retry: \(error.displayMessage)" }
    }
    /// Re-sends the saved token with the current preferences.
    static func update() async {
        guard let token = UserDefaults.standard.string(forKey: "push.token") else { return }
        await send(token)
    }
}
