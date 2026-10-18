import SwiftUI
import AVFoundation
import LakesideCore

/// Settings reflect the authenticated server, including changes from other clients.
struct KeirControls: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var keir: KeirStore
    @ObservedObject var voice: KeirVoice
    @AppStorage("keir-voice-id") private var voiceID = "auto"
    @AppStorage("keir-voice-rate") private var rate = 1.0
    @AppStorage("keir-speech-provider") private var speechProvider = "microsoft"
    @AppStorage("keir-spoken-replies") private var spokenReplies = false
    @AppStorage("keir-live-activities") private var liveActivities = true
    @State private var lane = "investigation"
    private let lanes = ["conversation", "voice", "coding", "investigation", "coordination"]
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(keir.stopped ? "Keir is stopped" : "Keir is ready", systemImage: keir.stopped ? "stop.circle.fill" : "checkmark.circle")
                    Button(keir.stopped ? "Start Keir" : "Stop all work", role: keir.stopped ? nil : .destructive) {
                        voice.stop()
                        Task { await keir.control(["action": .string(keir.stopped ? "start" : "stop")], session) }
                    }.accessibilityIdentifier("keir-global-control")
                    Text("Stop cancels active work and queued sends across the installation. Start enables new work.")
                        .font(.caption).foregroundStyle(.secondary)
                } header: { Text("Runtime") }
                if keir.controls["supported"].bool {
                    Section {
                        Toggle("YOLO mode", isOn: Binding(get: { keir.yolo }, set: { enabled in
                            Task { await keir.control(["action": .string("configure"), "approvalMode": .string(enabled ? "yolo" : "ask")], session) }
                        })).tint(OpsTheme.warn).accessibilityIdentifier("keir-yolo")
                        Text("Skip approval prompts for supported owner actions in this conversation. Installation permissions still apply. Turning it off revokes its grant.")
                            .font(.caption).foregroundStyle(.secondary)
                    } header: { Text("Approvals · this conversation") }
                    Section {
                        ForEach(lanes, id: \.self) { lane in
                            NavigationLink {
                                KeirProviderPicker(lane: lane, options: keir.controls["options"][lane].array,
                                    selection: keir.controls["routes"][lane].string.nonempty ?? "auto",
                                    defaultRoute: keir.controls["defaults"][lane].string) { value in
                                        Task { await keir.control(["action": .string("configure"), "routes": .object([lane: .string(value)])], session) }
                                    }
                            } label: {
                                LabeledContent(lane.capitalized, value: KeirProviderName.label(keir.controls["routes"][lane].string.nonempty ?? "auto", options: keir.controls["options"][lane].array))
                            }.accessibilityIdentifier("keir-route-\(lane)")

                        }
                        Text("Conversation answers your messages. Coordination manages tasks; coding and investigation have their own overrides. Cursor Auto chooses its model and effort. Other routes use Jev for effort. Changes apply at the next activation.").font(.caption).foregroundStyle(.secondary)
                    } header: { Text("Providers · this conversation") }
                    Section {
                        Picker("Work type", selection: $lane) { ForEach(lanes, id: \.self) { Text($0.capitalized).tag($0) } }
                        ForEach(keir.controls["catalog"].array, id: \.["id"].string) { skill in
                            Toggle(isOn: Binding(get: { enabled(skill) }, set: { on in toggleSkill(skill, on: on) })) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(skill["id"].string.replacingOccurrences(of: "-", with: " ").capitalized)
                                    Text("\(skill["source"].string) · \(skill["license"].string)").font(.caption).foregroundStyle(.secondary)
                                }
                            }.disabled(!skill["available"].bool)
                        }
                        Button("Restore default skills") {
                            Task { await keir.control(["action": .string("configure"), "skills": .object([lane: .null])], session) }
                        }
                    } header: { Text("Skills") }
                } else if keir.controls == .null {
                    Text(keir.error ?? "Loading server controls").foregroundStyle(.secondary)
                    Button("Retry controls") { Task { await keir.loadControls(session) } }
                } else {
                    Text("This server does not support the new controls yet. Update your installation to use them.").foregroundStyle(.secondary)
                }
                Section {
                    Toggle("Speak replies", isOn: $spokenReplies)
                    Picker("Voice service", selection: $speechProvider) {
                        Text("Microsoft Ava · online").tag("microsoft")
                        Text("Apple · device voice").tag("apple")
                    }
                    if speechProvider == "apple" {
                    Picker("Voice", selection: $voiceID) {
                        Text("Best available for my language").tag("auto")
                        ForEach(KeirVoice.availableVoices, id: \.identifier) { v in
                            Text("\(v.name) · \(v.language)\(v.quality == .premium ? " · Premium" : v.quality == .enhanced ? " · Enhanced" : "")").tag(v.identifier)
                        }
                    }
                    }
                    Slider(value: $rate, in: 0.7...1.2, step: 0.02) { Text("Speaking speed") }
                    LabeledContent("Speaking speed", value: "\(Int(rate * 100))%")
                    Button(voice.speaking || voice.preparingSpeech ? "Stop preview" : "Preview voice") {
                        if voice.speaking || voice.preparingSpeech { voice.stopSpeaking() }
                        else { voice.speakReply("Hello. I'm Keir. Tell me what you're working on, and we'll take it from there.", session: session) }
                    }
                    Text("Microsoft Ava is the default for conversations and reading replies. Apple device voices are an optional alternative.").font(.caption).foregroundStyle(.secondary)
                } header: { Text("Read text replies aloud") }
                Section {
                    Toggle("Live Activities", isOn: $liveActivities)
                    Text("Show work status on your Lock Screen and Dynamic Island. Task content stays inside the app.").font(.caption).foregroundStyle(.secondary)
                    if keir.thread == "main", keir.controls["updates"] != .null {
                        Toggle("Progress updates in chat", isOn: Binding(get: { keir.controls["updates"].bool }, set: { on in
                            Task { await keir.control(["action": .string("configure"), "updates": .bool(on)], session) }
                        })).accessibilityIdentifier("keir-progress-updates")
                        Text("Keir posts a short update here when ticket and Discord work moves: a fix changes stage, a PR opens or merges, work finishes, gets stuck or needs you. Routine updates come at most every ten minutes.").font(.caption).foregroundStyle(.secondary)
                    }
                } header: { Text("At a glance") }
                if let error = keir.error { Text(error).foregroundStyle(OpsTheme.warn).accessibilityIdentifier("keir-control-error") }
            }
            .disabled(keir.controlling)
            .navigationTitle("Keir controls").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await keir.loadControls(session) }
        }
    }
    private func enabled(_ skill: JSONValue) -> Bool {
        let selection = keir.controls["skills"][lane]
        if selection != .null { return selection.array.contains(.string(skill["id"].string)) }
        let key = ["voice": "quick", "conversation": "quick", "coding": "coder", "investigation": "investigator", "coordination": "worker"][lane]!
        return skill["defaults"].array.contains(.string(key))
    }
    private func toggleSkill(_ skill: JSONValue, on: Bool) {
        var ids = keir.controls["catalog"].array.filter { enabled($0) }.map { $0["id"].string }
        ids.removeAll { $0 == skill["id"].string }; if on { ids.append(skill["id"].string) }
        Task { await keir.control(["action": .string("configure"), "skills": .object([lane: .array(ids.map(JSONValue.string))])], session) }
    }
}

struct KeirTaskProviders: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    let task: JSONValue
    @State private var controls: JSONValue = .null
    @State private var routes: [String: JSONValue] = [:]
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(["conversation", "coding", "investigation", "coordination"], id: \.self) { lane in
                        NavigationLink {
                            KeirProviderPicker(lane: lane, options: [.object(["id": .string("inherit"), "label": .string("Inherit conversation")])] + controls["options"][lane].array,
                                selection: routes[lane]?.string ?? "inherit", defaultRoute: controls["defaults"][lane].string) { value in
                                busy = true
                                Task {
                                    do {
                                        _ = try await session.post("/api/keir/app/controls", ["action": .string("configure"), "thread": task["thread"], "taskId": task["id"], "routes": .object([lane: .string(value)])])
                                        routes[lane] = .string(value); error = nil
                                    } catch { self.error = error.displayMessage }
                                    busy = false
                                }
                            }
                        } label: { LabeledContent(lane.capitalized, value: KeirProviderName.label(routes[lane]?.string ?? "inherit", options: controls["options"][lane].array)) }

                    }
                    Text("Overrides apply to future activations of this task and its delegated work.").font(.caption).foregroundStyle(.secondary)
                } header: { Text("Task providers") }
                if let error { Text(error).foregroundStyle(OpsTheme.warn) }
            }.disabled(busy || controls == .null).navigationTitle("Task providers").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task {
                    routes = task["overrides"]["routes"].object
                    do { controls = try await session.get("/api/keir/app/controls", query: ["thread": task["thread"].string]) }
                    catch { self.error = error.displayMessage }
                }
        }
    }
}


enum KeirProviderName {
    static func label(_ id: String, options: [JSONValue]) -> String {
        if id == "auto" { return "Automatic" }
        if id == "inherit" { return "Inherit conversation" }
        if id == "cursor:auto" { return "Cursor Auto" }
        return options.first { $0["id"].string == id }?["label"].string.nonempty ?? id.components(separatedBy: "@")[0].components(separatedBy: ":").last ?? id
    }
    static func providerManaged(_ id: String, options: [JSONValue], defaultRoute: String) -> Bool {
        let effective = id == "auto" ? defaultRoute : id
        return options.first { $0["id"].string == effective }?["effortMode"].string == "provider-managed" || effective == "cursor:auto"
    }
    static func choices(_ options: [JSONValue], selected: String) -> [JSONValue] {
        var seen = Set<String>()
        // Keep old effort-suffixed route IDs readable, but show each model once.
        let ordered = options.sorted { ($0["id"].string == selected ? 0 : 1) < ($1["id"].string == selected ? 0 : 1) }
        return ordered.filter { seen.insert($0["id"].string.components(separatedBy: "@")[0]).inserted }
    }
}

struct KeirProviderPicker: View {
    @Environment(\.dismiss) private var dismiss
    let lane: String
    let options: [JSONValue]
    let selection: String
    let defaultRoute: String
    let select: (String) -> Void
    private var choices: [JSONValue] { KeirProviderName.choices(options, selected: selection) }
    private var providers: [String] { Array(Set(choices.filter { !["auto", "inherit"].contains($0["id"].string) }.map { $0["provider"].string })).sorted() }
    var body: some View {
        List {
            Section {
                ForEach(choices.filter { ["auto", "inherit"].contains($0["id"].string) }, id: \.["id"].string) { route in option(route) }
                Text("Installation default: \(KeirProviderName.label(defaultRoute, options: options))").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(providers, id: \.self) { provider in
                Section(provider) {
                    ForEach(choices.filter { $0["provider"].string == provider }, id: \.["id"].string) { route in option(route) }
                }
            }
            Section("Reasoning effort") {
                if KeirProviderName.providerManaged(selection, options: options, defaultRoute: defaultRoute) {
                    Label("Automatic · Cursor", systemImage: "brain")
                    Text("Cursor Auto chooses the model and reasoning effort for this route.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Label("Automatic · Jev", systemImage: "brain")
                    Text("Jev chooses the effort needed for each activation. Selecting a model does not pin effort.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.navigationTitle(lane.capitalized).navigationBarTitleDisplayMode(.inline)
    }
    private func option(_ route: JSONValue) -> some View {
        Button {
            select(route["id"].string); dismiss()
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(route["id"].string == "auto" ? "Automatic" : route["label"].string).foregroundStyle(OpsTheme.ink)
                    if !route["reason"].string.isEmpty { Text(route["reason"].string).font(.caption).foregroundStyle(.secondary) }
                    if route["readiness"]["state"].string == "unverified" { Text("Configured · provider checked when work starts").font(.caption).foregroundStyle(.secondary) }
                    if !route["runner"].string.isEmpty { Text(route["id"].string).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                }
                Spacer()
                if selection == route["id"].string { Image(systemName: "checkmark").foregroundStyle(OpsTheme.sky) }
            }.padding(.vertical, 4)
        }.disabled(route["available"] == .bool(false))
    }
}
