import SwiftUI
import LakesideCore

// MARK: Connected games
//
// A compact sheet, opened from the Keir tools menu, that says plainly what
// Keir can read in each Lakeside game and lets the owner ask one grounded
// question in the ongoing conversation. It reads only the server's fixed
// read-only catalogue (`/api/keir/app/games`). It never writes to a game,
// never sends anything and never fills in a number the server did not return.

/// What a game or a single read can honestly be called. An unknown word from
/// the server is `unavailable`, never `live`.
enum KeirGameState: String, Equatable {
    case live, partial, unavailable, unsupported, available

    init(server word: String) { self = KeirGameState(rawValue: word) ?? .unavailable }

    var title: String {
        switch self {
        case .live: return "Live"
        case .partial: return "Partly live"
        case .unavailable: return "Unavailable"
        case .unsupported: return "Not supported"
        case .available: return "Not read yet"
        }
    }
    var icon: String {
        switch self {
        case .live: return "checkmark.circle.fill"
        case .partial: return "circle.lefthalf.filled"
        case .unavailable: return "exclamationmark.triangle.fill"
        case .unsupported: return "nosign"
        case .available: return "circle.dashed"
        }
    }
    var color: Color {
        switch self {
        case .live: return OpsTheme.mint
        case .partial, .unavailable: return OpsTheme.warn
        case .unsupported, .available: return OpsTheme.muted
        }
    }
}

struct KeirGameFact: Equatable, Identifiable {
    let label: String
    let value: String
    var id: String { label }
}

struct KeirGameRead: Equatable, Identifiable {
    let id: String
    let label: String
    /// "server · tool": the evidence a read came from, shown so the owner can ask Keir to repeat it.
    let source: String
    let state: KeirGameState
    let checkedAt: Date?
    let facts: [KeirGameFact]
    let note: String
}

struct KeirGame: Equatable, Identifiable {
    let id: String
    let name: String
    let scope: String
    let state: KeirGameState
    let note: String
    let withheld: [String]
    let reads: [KeirGameRead]
    /// Tickets and pings for this game: supported or not, with the reason.
    let tickets: KeirGameRead?

    /// Tickets exist for one game only. The sheet and the question topics both follow this, never the name.
    var ticketsSupported: Bool { tickets?.state == .available }
}

enum KeirGames {
    static let selectionKey = "keir.games.selected"

    /// The sheet exists in studio-signed-in mode only. Standalone installs never show it.
    static func available(profile: JSONValue) -> Bool { profile["mode"].string != "standalone" }

    static func validID(_ id: String) -> Bool {
        (2...25).contains(id.count) && id.first?.isLowercase == true && id.allSatisfy { ($0.isASCII && $0.isLowercase) || $0 == "-" }
    }

    private static func clip(_ text: String, _ limit: Int) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return flat.count > limit ? String(flat.prefix(limit - 1)) + "…" : flat
    }

    private static func date(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter(); precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter(); plain.formatOptions = [.withInternetDateTime]
        return precise.date(from: text) ?? plain.date(from: text)
    }

    static func parseRead(_ row: JSONValue) -> KeirGameRead? {
        let id = row["id"].string
        guard !id.isEmpty else { return nil }
        let state = KeirGameState(server: row["state"].string)
        // Facts only count when the read was live. An unavailable read shows no stale or partial numbers.
        let facts = state == .live ? row["facts"].array.prefix(12).compactMap { fact -> KeirGameFact? in
            let label = clip(fact["label"].string, 60), value = clip(fact["value"].string, 400)
            return label.isEmpty || value.isEmpty ? nil : KeirGameFact(label: label, value: value)
        } : []
        return KeirGameRead(id: id, label: clip(row["label"].string, 80), source: clip(row["source"].string, 80), state: state,
                            checkedAt: date(row["checkedAt"].string), facts: Array(facts), note: clip(row["note"].string, 300))
    }

    /// One row of the game list, or a full detail. Both use the same shape; a list row has no reads yet.
    static func parseGame(_ row: JSONValue) -> KeirGame? {
        let id = row["id"].string, name = clip(row["name"].string, 60)
        guard validID(id), !name.isEmpty else { return nil }
        let capability = row["capabilities"].array.first { $0["id"].string == "tickets" }.flatMap(parseRead)
        return KeirGame(id: id, name: name, scope: clip(row["scope"].string, 300), state: KeirGameState(server: row["state"].string),
                        note: clip(row["note"].string, 300), withheld: row["withheld"].array.map { clip($0.string, 120) }.filter { !$0.isEmpty },
                        reads: row["reads"].array.compactMap(parseRead), tickets: capability)
    }

    static func parseList(_ value: JSONValue) -> [KeirGame] { value["games"].array.compactMap(parseGame) }
}

/// The one thing remembered between openings: which game the owner last chose.
/// It is a short catalogue id, not an account, a thread or any game data.
struct KeirGameSelection {
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
#if DEBUG
        let flags = ProcessInfo.processInfo.arguments
        if flags.contains("--uitest-fixtures") && !flags.contains("--uitest-keep-games") { clear() }
#endif
    }
    /// Only an id the server still lists is honoured.
    func saved(among ids: [String]) -> String? {
        guard let id = defaults.string(forKey: KeirGames.selectionKey), ids.contains(id), KeirGames.validID(id) else { return nil }
        return id
    }
    func save(_ id: String) { if KeirGames.validID(id) { defaults.set(id, forKey: KeirGames.selectionKey) } }
    func clear() { defaults.removeObject(forKey: KeirGames.selectionKey) }
}

// MARK: Questions

/// Editable drafts for the composer. They name the game, ask Keir to say what it checked and when, and forbid writes and posts.
/// Nothing is sent from here.
enum KeirGameDraft {
    enum Topic: String, CaseIterable, Identifiable {
        case health, tickets
        var id: String { rawValue }
        var title: String { self == .health ? "Is it healthy right now?" : "Tickets with no recorded Discord reply" }
        var icon: String { self == .health ? "waveform.path.ecg" : "ticket" }
    }

    /// Topics this game can really answer. Tickets are offered where tickets exist, and never on name alone.
    static func topics(for game: KeirGame) -> [Topic] {
        guard game.state != .unsupported else { return [] }
        return game.ticketsSupported ? [.health, .tickets] : [.health]
    }

    static func prompt(_ topic: Topic, game: KeirGame) -> String? {
        guard topics(for: game).contains(topic) else { return nil }
        switch topic {
        case .health:
            return "About \(game.name): is it healthy right now, and what is currently live? Use the connected game's read-only checks. Tell me what you checked and when, and say so plainly if a read fails instead of guessing. Don't change anything or message anyone."
        case .tickets:
            return "About \(game.name): which tickets have no Discord reply recorded in the studio's receipts? Check the receipts and tell me what you found and when. Don't message any player yet."
        }
    }
}

// MARK: State

@MainActor final class KeirGamesModel: ObservableObject {
    enum Phase: Equatable { case idle, loading, loaded, failed }

    @Published private(set) var games: [KeirGame] = []
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var detail: KeirGame?
    @Published private(set) var reading = false
    @Published private(set) var detailFailed = false
    @Published private(set) var selected: String?
    private let selection: KeirGameSelection
    private var token = 0

    init(selection: KeirGameSelection = KeirGameSelection()) { self.selection = selection }

    var selectedGame: KeirGame? { detail?.id == selected ? detail : games.first { $0.id == selected } }

    func load(_ session: AppSession) async {
        phase = .loading
        do {
            games = KeirGames.parseList(try await session.get("/api/keir/app/games"))
            phase = .loaded
        } catch { phase = .failed; return }
        if selected == nil, let remembered = selection.saved(among: games.map(\.id)) { await choose(remembered, session) }
    }

    /// A newer choice wins: a slow answer for an earlier game never replaces it.
    func choose(_ id: String, _ session: AppSession) async {
        guard KeirGames.validID(id), games.contains(where: { $0.id == id }) else { return }
        selected = id; selection.save(id)
        token += 1; let mine = token
        detail = nil; detailFailed = false; reading = true
        defer { if mine == token { reading = false } }
        do {
            let value = try await session.get("/api/keir/app/games/\(id)")
            guard mine == token else { return }
            if let game = KeirGames.parseGame(value), game.id == id { detail = game } else { detailFailed = true }
        } catch { if mine == token { detailFailed = true } }
    }
}

// MARK: Sheet

struct KeirGamesSheet: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = KeirGamesModel()
    /// False when the composer already holds text; a question would replace it.
    let draftEmpty: Bool
    /// Receives an editable draft. The caller puts it in the composer. Nothing is sent.
    let ask: (String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                gamesSection
                if let game = model.selectedGame { detailSections(game) }
            }
            .scrollContentBackground(.hidden).background(OpsTheme.background)
            .toolbarBackground(OpsTheme.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("Connected games").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await model.load(session) }
        }
        // Contain, so the sheet's id does not replace the ids of the game rows,
        // reads and questions inside it.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keir-games-sheet")
    }

    private func gameIcon(_ game: KeirGame) -> String {
        switch game.id {
        case "ahd": return "building.columns.fill"
        case "metroforge": return "tram.fill"
        case "grand-century": return "globe.europe.africa.fill"
        default: return "gamecontroller.fill"
        }
    }

    @ViewBuilder private var gamesSection: some View {
        Section {
            if model.phase == .failed {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Keir could not load the game list. That says nothing about the games.").font(.callout)
                    Button("Try again") { Task { await model.load(session) } }.accessibilityIdentifier("keir-games-retry")
                }
            } else if model.games.isEmpty {
                if model.phase == .loaded { Text("No games are connected to Keir on this studio.").font(.callout) }
                else { HStack(spacing: 8) { ProgressView(); Text("Checking which games are connected…") } }
            } else {
                ForEach(model.games) { game in
                    Button { Task { await model.choose(game.id, session) } } label: {
                        HStack(spacing: 12) {
                            OpsGlyph(icon: gameIcon(game), tone: game.state == .unsupported ? OpsTheme.neutral : OpsTheme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(game.name).font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                                Text(gameSummary(game)).font(.opsCaption).foregroundStyle(OpsTheme.muted).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(OpsTheme.neutral)
                                .accessibilityHidden(true)
                        }.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityValue(model.selected == game.id ? "Viewing" : "")
                    .accessibilityHint("Shows what Keir can read in \(game.name)")
                    .accessibilityIdentifier("keir-game-\(game.id)")
                }
            }
        } header: { SectionLabel(text: "Games") }
    }

    private func gameSummary(_ game: KeirGame) -> String {
        if game.state == .unsupported { return game.note }
        switch game.id {
        case "ahd": return "Turns and engine health"
        case "metroforge": return "Services, releases and city bundles"
        default: return "Services and releases"
        }
    }

    @ViewBuilder private func detailSections(_ game: KeirGame) -> some View {
        Section {
            if model.reading { HStack(spacing: 8) { ProgressView(); Text("Reading \(game.name)…") }.accessibilityIdentifier("keir-game-reading") }
            else if model.detailFailed {
                VStack(alignment: .leading, spacing: 8) {
                    KeirGameStateDot(state: .unavailable)
                    Text("Keir could not read \(game.name) just now. That says nothing about the game itself.").font(.callout)
                    Button("Read again") { Task { await model.choose(game.id, session) } }.accessibilityIdentifier("keir-game-reread")
                }
            } else if game.state == .unsupported {
                KeirGameStateDot(state: .unsupported)
                Text(game.note.isEmpty ? "Keir has no read connection for this game." : game.note).font(.callout)
            } else {
                ForEach(game.reads) { read in KeirGameReadRow(read: read).listRowSeparator(.hidden) }
            }
            if !model.reading, !model.detailFailed, game.state != .unsupported, let checked = game.reads.compactMap(\.checkedAt).max() {
                Text("Checked \(OpsFormat.contextual(checked))").font(.caption).foregroundStyle(OpsTheme.muted)
                    .accessibilityIdentifier("keir-game-checked")
            }
        } header: { SectionLabel(text: game.name) }
        if let tickets = game.tickets {
            Section {
                HStack(spacing: 8) {
                    KeirGameStateDot(state: tickets.state, label: tickets.state == .available ? "Through the Inbox" : nil)
                    Text(tickets.state == .available ? "Through the Inbox" : tickets.state.title).font(.callout)
                }
            } header: { SectionLabel(text: "Tickets and pings") } footer: {
                Text(tickets.note).font(.opsCaption).foregroundStyle(OpsTheme.muted)
            }
        }
        let topics = KeirGameDraft.topics(for: game)
        if !topics.isEmpty, !model.reading {
            Section {
                ForEach(topics) { topic in
                    Button {
                        if let text = KeirGameDraft.prompt(topic, game: game) { ask(text) }
                    } label: {
                        HStack {
                            Label(topic.title, systemImage: topic.icon)
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.sky).accessibilityHidden(true)
                        }
                    }
                    .disabled(!draftEmpty)
                    .accessibilityHint(draftEmpty ? "Puts an editable question in the message box. Nothing is sent." : "Clear your draft first. This would replace it.")
                    .accessibilityIdentifier("keir-game-ask-\(topic.rawValue)")
                }
            } header: {
                if topics.count > 1 { SectionLabel(text: "Ask Keir about \(game.name)") }
            }
        }
        if !model.reading, !model.detailFailed, !game.withheld.isEmpty {
            Section {
                ForEach(game.withheld, id: \.self) { limit in
                    Label(limit, systemImage: "lock").font(.opsCaption).foregroundStyle(OpsTheme.muted)
                        .listRowSeparator(.hidden)
                }
            } header: { SectionLabel(text: "Not read by Keir") }
        }
    }
}

/// A small semantic dot and the state word, on one line.
struct KeirGameStateDot: View {
    let state: KeirGameState
    var label: String? = nil
    private var word: String { label ?? state.title }
    var body: some View {
        Circle().fill(state.color).frame(width: 8, height: 8)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Status: \(word)")
            .accessibilityIdentifier("keir-game-state")
    }
}

struct KeirGameReadRow: View {
    let read: KeirGameRead
    /// The count is redundant when the names are listed beside it.
    private var facts: [KeirGameFact] {
        read.facts.filter { $0.label != "Bundles" }
    }
    private var stale: Bool { read.checkedAt.map { Date().timeIntervalSince($0) >= 86_400 } ?? false }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(read.label).font(.opsHeadline)
                Spacer(minLength: 8)
                let tone = stale ? OpsTheme.neutral : read.state.color
                HStack(spacing: 4) {
                    Image(systemName: stale ? "clock" : read.state.icon)
                    Text(stale ? "Stale" : read.state.title)
                }.fixedSize()
                    .font(.opsCaption.weight(.semibold)).foregroundStyle(tone)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(tone.opacity(0.12), in: Capsule())
                    .accessibilityIdentifier("keir-game-state")
            }
            ForEach(facts) { fact in
                LabeledContent {
                    HStack(spacing: 6) {
                        Text(fact.value).font(.callout).foregroundStyle(stale ? OpsTheme.muted : OpsTheme.ink)
                        if !stale, fact.value == "Responding" { KeirGameStateDot(state: .live) }
                    }
                } label: {
                    Text(fact.label).font(.callout).foregroundStyle(OpsTheme.muted)
                }
                .accessibilityElement(children: .combine)
            }
            if stale, let checked = read.checkedAt {
                Text("Checked \(OpsFormat.contextual(checked))").font(.opsCaption).foregroundStyle(OpsTheme.muted)
            } else if read.state != .live && !read.note.isEmpty {
                Text(read.note).font(.opsCaption).foregroundStyle(OpsTheme.muted)
            }
            // Technical evidence stays available, folded away: which tool answered.
            DisclosureGroup {
                Text("Read from \(read.source)").font(.caption).foregroundStyle(OpsTheme.muted)
                    .accessibilityIdentifier("keir-game-source-\(read.id)")
            } label: {
                Text("Details").font(.caption).foregroundStyle(OpsTheme.muted)
            }
        }
        .padding(.vertical, 2)
    }
}
