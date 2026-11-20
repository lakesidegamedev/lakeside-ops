import SwiftUI
import LakesideCore

/// Choices stay attached to their question and task, including after a reconnect.
struct KeirQuestions: View {
    @EnvironmentObject private var session: AppSession
    let panel: JSONValue
    @State private var selected: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]
    @State private var busy = false
    @State private var submitted = false
    @State private var error: String?
    @State private var clientId = UUID().uuidString
    private var answered: Bool { submitted || panel["state"].string != "pending" }
    private var valid: Bool { panel["questions"].array.allSatisfy { !(selected[$0["id"].string] ?? []).isEmpty || !(custom[$0["id"].string] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
    var body: some View {
        Group {
        if answered {
            Label("Answer sent", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(OpsTheme.muted)
        } else {
        VStack(alignment: .leading, spacing: 16) {
            Text(panel["title"].string).font(.headline)
            ForEach(panel["questions"].array, id: \.["id"].string) { question in
                let id = question["id"].string
                VStack(alignment: .leading, spacing: 8) {
                    Text(question["prompt"].string).font(.callout.weight(.semibold))
                    ForEach(question["options"].array, id: \.["id"].string) { option in
                        let chosen = (selected[id] ?? []).contains(option["id"].string)
                        Button {
                            var choices = selected[id] ?? []
                            if chosen { choices.remove(option["id"].string) }
                            else { if !question["multiple"].bool { choices.removeAll() }; choices.insert(option["id"].string) }
                            selected[id] = choices
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: chosen ? "checkmark.circle.fill" : "circle").foregroundStyle(chosen ? OpsTheme.sky : OpsTheme.muted)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(option["label"].string).font(.callout)
                                    if !option["detail"].string.isEmpty { Text(option["detail"].string).font(.caption).foregroundStyle(OpsTheme.muted) }
                                    if option["recommended"].bool { Text("Recommended").font(.caption2).foregroundStyle(OpsTheme.mint) }
                                }
                                Spacer(minLength: 0)
                            }.padding(10).background(chosen ? OpsTheme.sky.opacity(0.14) : OpsTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }.buttonStyle(.plain).disabled(answered || busy)
                    }
                    TextField("Or write your own answer", text: Binding(get: { custom[id] ?? "" }, set: { custom[id] = $0 }), axis: .vertical)
                        .font(.callout).textFieldStyle(.roundedBorder).disabled(answered || busy)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn) }
            if answered { Label(panel["state"].string == "superseded" ? "Replaced by a newer question" : "Answered", systemImage: "checkmark").font(.caption).foregroundStyle(OpsTheme.muted) }
            else {
                Button(busy ? "Sending answers" : "Send answers") { Task { await answer() } }
                    .font(.callout.weight(.semibold)).disabled(!valid || busy).accessibilityIdentifier("keir-answer-choices")
            }
        }.padding(.vertical, 10)
            .onAppear {
                for answer in panel["answers"].array {
                    selected[answer["id"].string] = Set(answer["selected"].array.map(\.string))
                    custom[answer["id"].string] = answer["text"].string
                }
            }
        }
        }
    }
    private func answer() async {
        busy = true; defer { busy = false }
        let answers: [JSONValue] = panel["questions"].array.map { q in
            let id = q["id"].string
            return .object(["id": .string(id), "selected": .array((selected[id] ?? []).sorted().map(JSONValue.string)), "text": .string(custom[id] ?? "")])
        }
        do {
            _ = try await session.post("/api/keir/app/questions/\(panel["id"].string)", ["answers": .array(answers), "clientId": .string(clientId)])
            submitted = true; error = nil
        } catch { self.error = error.displayMessage }
    }
}

struct KeirCommand: Identifiable {
    let id: String
    let detail: String
    let prompt: String?
    static let all: [KeirCommand] = [
         .init(id: "/stop", detail: "Stop all Keir work", prompt: nil),
        .init(id: "/start", detail: "Enable new work", prompt: nil),
        .init(id: "/status", detail: "Show runtime status", prompt: nil),
        .init(id: "/model", detail: "Providers by work type", prompt: nil),
        .init(id: "/approval", detail: "Approval and YOLO settings", prompt: nil),
        .init(id: "/skills", detail: "Choose skills", prompt: nil),
        .init(id: "/ticket", detail: "Investigate a support ticket", prompt: "Investigate ticket #"),
        .init(id: "/chart", detail: "Graph data with sources", prompt: "Show a chart of "),
        .init(id: "/compare", detail: "Compare options in a table", prompt: "Compare these options in a table: "),
        .init(id: "/plan", detail: "Plan a piece of work", prompt: "Make a plan for "),
        .init(id: "/research", detail: "Research with sources", prompt: "Research this and cite your sources: "),
        .init(id: "/computer", detail: "Open Keir's computer", prompt: nil),
        .init(id: "/new", detail: "Start another conversation", prompt: nil),
        .init(id: "/tasks", detail: "Inspect ongoing work", prompt: nil)
    ]
}
