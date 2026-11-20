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

    private var standalone: Bool { session.profile["mode"].string == "standalone" }

    /// Conversation is the landing place. The inbox holds tickets, decisions and
    /// work that needs a person. Ops holds the studio's systems, the briefing and
    /// goals. On iPad (iOS 18 and later) the same three become a sidebar.
    private var tabs: some View {
        TabView(selection: $router.tab) {
            NavigationStack { KeirView(keir: OpsServices.shared.keir).toolbar { settingsButton } }
                .tabItem { Label("Conversation", systemImage: "bubble.left.and.text.bubble.right") }.tag(OpsTab.keir)
            NavigationStack { ActivityView().toolbar { settingsButton } }
                .tabItem { Label("Inbox", systemImage: "tray.full") }.tag(OpsTab.activity)
                .badge(ops.attention)
            if !standalone {
                NavigationStack(path: $router.studioPath) {
                    OpsHub().toolbar { settingsButton }
                        .navigationDestination(for: StudioRoute.self) { route in
                            switch route {
                            case .feed: FeedView()
                            case .goals: GoalsView()
                            }
                        }
                }
                .tabItem { Label("Ops", systemImage: "square.grid.2x2") }.tag(OpsTab.ops)
            }
        }
    }

    @ViewBuilder private var adaptiveTabs: some View {
        if #available(iOS 18.0, *) { tabs.tabViewStyle(.sidebarAdaptable) } else { tabs }
    }

    var body: some View {
        adaptiveTabs
        .tint(OpsTheme.sky)
        .toolbarBackground(.bar, for: .tabBar).toolbarBackground(.visible, for: .tabBar)
        .onOpenURL { url in
            guard url.scheme == "lakesideops", url.host == "keir" else { return }
            let view = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "view" }?.value
            switch view {
            case "activity", "inbox": router.tab = .activity
            case "ops": router.tab = .ops
            case "feed": router.open(.feed)
            case "goals": router.open(.goals)
            default: router.tab = .keir
            }
            router.openKeirControls = view == "controls"
            router.openKeirVoice = view == "voice"
        }
        .sheet(isPresented: $settings) { OpsSettings() }
        .sheet(item: $router.destination) { OpsDestinationView(destination: $0) }
        .task { await OpsPushRegistration.request() }
        // Reopen the last private conversation once the account is known, and
        // retry on foreground if the first thread read failed.
        .task(id: "\(KeirResume.scope(profile: session.profile, server: Surface.ops.base) ?? "")|\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            let keir = OpsServices.shared.keir
            keir.bindAccount(KeirResume.scope(profile: session.profile, server: Surface.ops.base))
            await keir.resumeLastThread(session)
        }
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
    @AppStorage("appearance") private var appearance = "system"
    @State private var prefs = Dictionary(uniqueKeysWithValues: OpsPushPrefs.keys.map { ($0, OpsPushPrefs.value($0)) })
    @ObservedObject private var push = OpsServices.shared.push
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var delivery: JSONValue = .null
    @State private var deliveryMessage: String?
    @State private var testingDelivery = false
    @State private var quiet = QuietHours.load()

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
                quietSection
                if session.profile["mode"].string != "standalone" { KeirIdentitySection() }
                Section("Appearance") {
                    Picker("Theme", selection: $appearance) { Text("Dark").tag("dark"); Text("Light").tag("light"); Text("System").tag("system") }
                }
                Section("About") {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                    Text("Keir portrait art derived from an official Prime Minister's Office photograph, licensed under the Open Government Licence v3.0.")
                        .font(.caption).foregroundStyle(OpsTheme.muted)
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

    private var quietSection: some View {
        Section {
            Toggle("Quiet hours on this iPhone", isOn: Binding(get: { quiet.enabled }, set: { quiet.enabled = $0; saveQuiet() }))
            if quiet.enabled {
                DatePicker("From", selection: timeBinding(\.startMinutes), displayedComponents: .hourAndMinute)
                DatePicker("Until", selection: timeBinding(\.endMinutes), displayedComponents: .hourAndMinute)
                Picker("Time zone", selection: Binding(get: { quiet.timeZone }, set: { quiet.timeZone = $0; saveQuiet() })) {
                    ForEach(Array(Set(TimeZone.knownTimeZoneIdentifiers + [quiet.timeZone])).sorted(), id: \.self) { Text($0).tag($0) }
                }
            }
            Text(quiet.summary).font(.caption).foregroundStyle(OpsTheme.muted)
        } header: { Text("Quiet hours") } footer: { Text("Applies to this iPhone only. Your other devices are not affected.") }
    }

    private func timeBinding(_ field: WritableKeyPath<QuietHours, Int>) -> Binding<Date> {
        Binding(get: { Calendar.current.date(bySettingHour: quiet[keyPath: field] / 60, minute: quiet[keyPath: field] % 60, second: 0, of: Date()) ?? Date() },
                set: { date in
                    let c = Calendar.current.dateComponents([.hour, .minute], from: date)
                    quiet[keyPath: field] = (c.hour ?? 0) * 60 + (c.minute ?? 0); saveQuiet()
                })
    }

    private func saveQuiet() { quiet.save(); Task { await OpsPushRegistration.update() } }

    private func toggle(_ key: String, _ title: String, _ detail: String) -> some View {
        Toggle(isOn: Binding(get: { prefs[key] ?? true }, set: { on in
            prefs[key] = on; OpsPushPrefs.set(key, on); Task { await OpsPushRegistration.update() }
        })) {
            VStack(alignment: .leading, spacing: 2) { Text(title); Text(detail).font(.caption).foregroundStyle(OpsTheme.muted) }
        }
    }
}
