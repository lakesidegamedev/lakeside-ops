import SwiftUI
import LakesideCore
import UserNotifications

@main struct LakesideOpsApp: App {
    @UIApplicationDelegateAdaptor(OpsAppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup {
            SessionGate(session: OpsServices.shared.session) { OpsRoot() }
                .environmentObject(OpsServices.shared.ops)
                .environmentObject(OpsServices.shared.router)
                .modifier(LakesideStyle())
        }
    }
}

struct OpsRoot: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @Environment(\.scenePhase) private var scenePhase
    @State private var settings = false

    var body: some View {
        TabView(selection: $router.tab) {
            NavigationStack { KeirView(keir: OpsServices.shared.keir).toolbar { settingsButton } }
                .tabItem { Label("Keir", systemImage: "bubble.left.and.text.bubble.right") }.tag(OpsTab.keir)
            if session.profile["mode"].string != "standalone" {
            NavigationStack { FeedView().toolbar { settingsButton } }
                .tabItem { Label("Feed", systemImage: "sparkles.rectangle.stack") }.tag(OpsTab.feed)
            NavigationStack { GoalsView().toolbar { ToolbarItem(placement: .topBarLeading) { settingsButton } } }
                .tabItem { Label("Goals", systemImage: "flag") }.tag(OpsTab.goals)
            }
            NavigationStack { ActivityView().toolbar { settingsButton } }
                .tabItem { Label("Activity", systemImage: "list.bullet.rectangle") }.tag(OpsTab.activity)
                .badge(ops.attention)
            if session.profile["mode"].string != "standalone" {
            NavigationStack { OpsHub().toolbar { settingsButton } }
                .tabItem { Label("Ops", systemImage: "square.grid.2x2") }.tag(OpsTab.ops)
            }
        }
        .tint(OpsTheme.sky)
        .toolbarBackground(.bar, for: .tabBar).toolbarBackground(.visible, for: .tabBar)
        .onOpenURL { url in
            guard url.scheme == "lakesideops", url.host == "keir" else { return }
            let view = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "view" }?.value
            router.tab = view == "activity" ? .activity : .keir
            router.openKeirControls = view == "controls"
            router.openKeirVoice = view == "voice"
        }
        .sheet(isPresented: $settings) { OpsSettings() }
        .sheet(item: $router.destination) { OpsDestinationView(destination: $0) }
        .task { await OpsPushRegistration.request() }
        .task(id: scenePhase == .active) {
            if scenePhase == .active { await session.refreshProfile() }
            guard session.profile["mode"].string != "standalone" else { return }
            // Refresh while open: every 30 seconds in the foreground, never in the background.
            while scenePhase == .active && !Task.isCancelled {
                await OpsPushRegistration.update()
                await ops.refresh(session)
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
    }

    private var settingsButton: some View {
        Button { settings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
    }
}

struct OpsSettings: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearance = "dark"
    @State private var prefs = Dictionary(uniqueKeysWithValues: OpsPushPrefs.keys.map { ($0, OpsPushPrefs.value($0)) })
    @ObservedObject private var push = OpsServices.shared.push
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var delivery: JSONValue = .null
    @State private var deliveryMessage: String?
    @State private var testingDelivery = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    toggle("replies", "Keir replies", "When Keir answers you in the app.")
                    toggle("decisions", "Decisions", "Time-sensitive. Approve or reject from the notification.")
                    toggle("feed", "Morning brief and goal progress", "The daily brief, and milestones Keir finishes.")
                    toggle("incidents", "Watchkeeper incidents", "Quiet delivery. Turn failures and stalled work.")
                    LabeledContent("Delivery", value: push.message)
                    if let registered = push.lastRegistered { Text("Last registered \(registered.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(OpsTheme.muted) }
                    if let error = push.error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn) }
                    Button("Check notification registration") { Task { await OpsPushRegistration.request(); status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus } }
                    if delivery != .null {
                        LabeledContent("Push service", value: delivery["configured"].bool ? "Configured" : "Unavailable")
                        LabeledContent("Registered devices", value: delivery["registeredDevices"].string)
                    }
                    Button("Send a test notification") {
                        testingDelivery = true
                        Task {
                            do {
                                _ = try await session.post("/api/keir/app/notifications/test", [:])
                                deliveryMessage = "Apple accepted the test. Check Notification Center for delivery."
                            } catch { deliveryMessage = error.displayMessage }
                            testingDelivery = false
                        }
                    }.disabled(testingDelivery)
                    if let deliveryMessage { Text(deliveryMessage).font(.caption).foregroundStyle(OpsTheme.muted) }
                    if status == .denied {
                        Button("Turn on notifications in Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                    }
                } header: { Text("Notifications") }
                if session.profile["mode"].string != "standalone" { KeirIdentitySection() }
                Section("Appearance") {
                    Picker("Theme", selection: $appearance) { Text("Dark").tag("dark"); Text("Light").tag("light"); Text("System").tag("system") }
                }
                Section {
                    LabeledContent("Signed in as", value: session.profile["email"].string.hasPrefix("discord_") ? "Owner" : session.profile["email"].string)
                    Button("Sign out", role: .destructive) { Task { await session.signOut(); dismiss() } }
                }
            }
            .scrollContentBackground(.hidden).background(OpsTheme.background)
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .task {
                status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
                do { delivery = try await session.get("/api/keir/app/notifications") }
                catch { deliveryMessage = error.displayMessage }
            }
        }
    }

    private func toggle(_ key: String, _ title: String, _ detail: String) -> some View {
        Toggle(isOn: Binding(get: { prefs[key] ?? true }, set: { on in
            prefs[key] = on; OpsPushPrefs.set(key, on); Task { await OpsPushRegistration.update() }
        })) {
            VStack(alignment: .leading, spacing: 2) { Text(title); Text(detail).font(.caption).foregroundStyle(OpsTheme.muted) }
        }
    }
}
