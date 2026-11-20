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
    @ObservedObject private var attention = AttentionCenter.shared
    @Environment(\.scenePhase) private var scenePhase

    private var standalone: Bool { session.profile["mode"].string == "standalone" }

    /// Chat is the landing place: Keir, the timeline and one composer, with
    /// settings, stop and model choice behind its menus instead of on screen.
    /// The inbox holds tickets, decisions and work that needs a person. Ops holds
    /// the studio's systems, the briefing and goals. The dock is the native tab
    /// bar so it stays quiet, readable and reachable by VoiceOver; on iPad
    /// (iOS 18 and later) the same places become a sidebar.
    private var tabs: some View {
        TabView(selection: $router.tab) {
            NavigationStack { KeirView(keir: OpsServices.shared.keir) }
                .tabItem { Label("Chat", systemImage: "bubble.left") }.tag(OpsTab.keir)
            NavigationStack {
                ActivityView().toolbar { if standalone { settingsButton } }
            }
                .tabItem { Label("Inbox", systemImage: "tray") }.tag(OpsTab.activity)
                .badge(attention.count)
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
        .tint(OpsTheme.accent)
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
        .sheet(isPresented: $router.showSettings) { OpsSettings() }
        .sheet(item: $router.destination) { OpsDestinationView(destination: $0) }
        .task { await OpsPushRegistration.request() }
        // Reopen the last private conversation once the account is known. A
        // failed thread read is retried briefly, then again on foreground.
        .task(id: "\(KeirResume.scope(profile: session.profile, server: Surface.ops.base) ?? "")|\(session.profile["ownerSupervisor"].bool)|\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            let keir = OpsServices.shared.keir
            keir.bindAccount(KeirResume.scope(profile: session.profile, server: Surface.ops.base))
            // Decide the home conversation from the profile before anything
            // is resumed, sent or read from Support Keir.
            await keir.ensureHome(session)
            await keir.resumeLastThreadWhileOpen(session)
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
        Button { router.showSettings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
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
    @State private var confirmSignOut = false

    private var pushAvailable: Bool {
        (status == .authorized || status == .provisional || status == .ephemeral)
            && (push.lastRegistered != nil || (delivery["registeredDevices"].number ?? 0) > 0)
    }

    private func refreshNotificationRegistration() {
        Task {
            await OpsPushRegistration.request()
            status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if !pushAvailable {
                        Label("Push notifications are inactive", systemImage: "bell.slash").foregroundStyle(OpsTheme.warning)
                        Button(status == .denied ? "Open iPhone Settings" : "Enable notifications") {
                            if status == .denied {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            } else { refreshNotificationRegistration() }
                        }
                    }
                    Group {
                        toggle("replies", "Keir replies", "When Keir answers you in the app.")
                        toggle("decisions", "Decisions", "Time-sensitive approvals and decisions.")
                        toggle("incidents", "Incident alerts", "Turn failures and stalled work.")
                    }.disabled(!pushAvailable)
                } header: { SectionLabel(text: "Notifications") }
                quietSection
                if session.profile["mode"].string != "standalone" { KeirIdentitySection() }
                Section {
                    Picker("Theme", selection: $appearance) {
                        ForEach(KeirAppearance.allCases) { Text($0.title).tag($0.rawValue) }
                    }.accessibilityIdentifier("settings-theme")
                } header: { SectionLabel(text: "Appearance") } footer: {
                    Text(KeirAppearance.allCases.map(\.title).joined(separator: ", ") + ". System follows your iPhone. OLED black turns background pixels off on OLED screens.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                } header: { SectionLabel(text: "About") } footer: {
                    Text("Keir portrait art derived from an official Prime Minister's Office photograph, licensed under the Open Government Licence v3.0.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    DisclosureGroup("Push diagnostics") {
                        LabeledContent("Delivery", value: push.message)
                        if let registered = push.lastRegistered {
                            LabeledContent("Registered", value: OpsFormat.contextual(registered))
                        }
                        if delivery != .null {
                            LabeledContent("Push service", value: delivery["configured"].bool ? "Configured" : "Unavailable")
                        }
                        Button("Check notification registration", action: refreshNotificationRegistration)
                        Button("Send a test notification") {
                            testingDelivery = true
                            Task {
                                do {
                                    _ = try await session.post("/api/keir/app/notifications/test", [:])
                                    deliveryMessage = "Test sent. Check Notification Center."
                                } catch { deliveryMessage = "Could not send the test notification." }
                                testingDelivery = false
                            }
                        }.disabled(testingDelivery || !pushAvailable)
                        if let deliveryMessage { Text(deliveryMessage).font(.opsCaption).foregroundStyle(OpsTheme.muted) }
                    }
                } header: { SectionLabel(text: "Developer") }
                Section {
                    LabeledContent("Signed in as", value: session.profile["email"].string.hasPrefix("discord_") ? "Owner" : session.profile["email"].string)
                    Button(role: .destructive) { confirmSignOut = true } label: {
                        Text("Sign out").foregroundStyle(OpsTheme.danger)
                    }
                } header: { SectionLabel(text: "Account") }
            }
            .scrollContentBackground(.hidden).background(OpsTheme.background)
            .toolbarBackground(OpsTheme.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .alert("Sign out of Keir on this iPhone?", isPresented: $confirmSignOut) {
                Button("Sign out", role: .destructive) { Task { await session.signOut(); dismiss() } }
                Button("Cancel", role: .cancel) {}
            }
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
        } header: { SectionLabel(text: "Quiet hours") } footer: { Text("Applies to this iPhone only. Your other devices are not affected.") }
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
