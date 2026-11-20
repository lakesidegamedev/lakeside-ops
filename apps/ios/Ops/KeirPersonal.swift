import SwiftUI
import CryptoKit
import LakesideCore

// MARK: Resume the last private conversation

/// Remembers which private thread the owner was last in, so a force-quit and
/// reopen lands back there. It stores one thread id and a one-way fingerprint
/// of the signed-in account and server. No transcript, draft or credential is
/// ever written, and another account's entry is never read.
struct KeirResume {
    static let defaultsKey = "keir.resume.thread"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
#if DEBUG
        let flags = ProcessInfo.processInfo.arguments
        if flags.contains("--uitest-fixtures") && !flags.contains("--uitest-keep-resume") { clear() }
#endif
    }

    /// Fingerprint of the account on this installation, or nil before the
    /// profile is known. The raw identity is never stored.
    static func scope(profile: JSONValue, server: URL) -> String? {
        let identity = profile["id"].string.nonempty ?? profile["email"].string.nonempty
        guard let identity else { return nil }
        let digest = SHA256.hash(data: Data("\(server.absoluteString)|\(identity)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Thread ids are short server-issued tokens. Anything else is ignored.
    static func valid(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    func saved(for scope: String) -> String? {
        guard let entry = defaults.dictionary(forKey: Self.defaultsKey) as? [String: String] else { return nil }
        guard entry["scope"] == scope, let thread = entry["thread"], Self.valid(thread) else { return nil }
        return thread
    }

    func save(_ thread: String, scope: String) {
        guard Self.valid(thread) else { return }
        defaults.set(["scope": scope, "thread": thread], forKey: Self.defaultsKey)
    }

    func clear() { defaults.removeObject(forKey: Self.defaultsKey) }

    /// A thread worth reopening: listed by the server right now, not archived,
    /// not the main thread (that is the default) and not the system watches feed.
    static func legitimate(_ id: String, in listing: [JSONValue]) -> Bool {
        guard id != "main", id != "watches", valid(id) else { return false }
        guard let row = listing.first(where: { $0["id"].string == id }) else { return false }
        return !row["system"].bool && !row["archived"].bool
    }
}

// MARK: Waiting tickets

/// Tickets the studio has no recorded Discord reply for. The receipt is the
/// studio's own record, so a missing one means "nothing recorded", not "the
/// player was ignored": the wording below never claims more than that.
enum KeirTicketFollowUp {
    private static let finished = ["closed", "resolved", "duplicate", "merged", "archived", "wontfix"]

    /// Oldest first, so the ticket that has waited longest leads.
    static func waiting(in hub: JSONValue) -> [JSONValue] {
        hub["tickets"].array.filter {
            $0["replyState"]["state"].string == "no_receipt" && !finished.contains($0["status"].string) && !$0["number"].string.isEmpty
        }.sorted { (OpsFormat.date($0["createdAt"]) ?? .distantFuture) < (OpsFormat.date($1["createdAt"]) ?? .distantFuture) }
    }

    static func title(_ ticket: JSONValue) -> String {
        let flat = ticket["title"].string.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return flat.count > 80 ? String(flat.prefix(79)) + "…" : flat
    }

    /// An editable draft. Nothing is sent until the owner sends it, and it asks
    /// Keir to check rather than to message the player.
    static func prompt(for ticket: JSONValue) -> String {
        let name = title(ticket)
        let subject = name.isEmpty ? "Ticket #\(ticket["number"].string)" : "Ticket #\(ticket["number"].string) (\(name))"
        return "\(subject) has no Discord reply recorded in the studio's receipts. Check whether the player has actually been answered, and if not, suggest what we should say. Don't message the player yet."
    }
}

// MARK: Start screen

/// The quiet first screen of an empty conversation. Keir is already at the top
/// of the screen, so this is only a line of welcome, an invitation to talk and
/// at most one real ticket to follow up on. It repeats none of the attention
/// counts the header already shows.
struct KeirStart: View {
    let ticket: JSONValue?
    /// The private conversation: no support tickets or studio counts here.
    var supervisor = false
    let draftEmpty: Bool
    let suggest: (JSONValue) -> Void

    var body: some View {
        VStack(spacing: 22) {
            VStack(spacing: 6) {
                Text("Hi, it's Keir.").font(.title2.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                Text(supervisor ? "Ask about a ticket, check on a game, or work on Keir together."
                                : "Ask about tickets, turns or anything in the studio.")
                    .font(.callout).foregroundStyle(OpsTheme.muted).multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
            if let ticket {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No Discord reply recorded").font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.muted).padding(.leading, 6)
                    Button { suggest(ticket) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "ticket")
                                .font(.callout).foregroundStyle(OpsTheme.warn)
                                .frame(width: 34, height: 34)
                                .background(OpsTheme.warn.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Follow up on ticket #\(ticket["number"].string)").font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                                Text(KeirTicketFollowUp.title(ticket)).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.left").font(.caption).foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
                        }
                        .keirObjectCard(padding: 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .opacity(draftEmpty ? 1 : 0.5)
                    .disabled(!draftEmpty)
                    .accessibilityHint(draftEmpty ? "Puts a draft in the message box for you to edit. Nothing is sent." : "Clear your draft first. This would replace it.")
                    .accessibilityIdentifier("keir-start-ticket")
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 72).padding(.horizontal, 8)
    }
}

/// Inside the composer's "+" menu once the conversation has history: tickets
/// with no recorded Discord reply, each an editable draft. Nothing is sent.
struct KeirTicketMenu: View {
    let tickets: [JSONValue]
    let draftEmpty: Bool
    let suggest: (JSONValue) -> Void

    var body: some View {
        if !tickets.isEmpty {
            Menu {
                Section("No Discord reply recorded") {
                    ForEach(Array(tickets.prefix(5)), id: \.["number"].string) { ticket in
                        Button { suggest(ticket) } label: { Text("#\(ticket["number"].string) \(KeirTicketFollowUp.title(ticket))") }
                            .disabled(!draftEmpty)
                    }
                }
                if !draftEmpty { Text("Clear your draft to use a suggestion.") }
            } label: { Label("Ticket follow-ups", systemImage: "ticket") }
                .accessibilityHint("Puts an editable draft in the message box. Nothing is sent.")
                .accessibilityIdentifier("keir-ticket-followup")
        }
    }
}
