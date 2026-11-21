import SwiftUI
import LakesideCore

// MARK: - Type scale

/// Every size is a Dynamic Type text style. Nothing in the app pins a point
/// size for reading text, so accessibility sizes grow instead of clipping.
extension Font {
    static let opsHero = Font.system(.largeTitle, design: .rounded).weight(.bold)
    static let opsTitle = Font.system(.title2, design: .rounded).weight(.semibold)
    static let opsHeadline = Font.headline
    static let opsBody = Font.body
    static let opsSecondary = Font.subheadline
    static let opsCaption = Font.caption
    static let opsCardTitle = opsHeadline
    static let opsSection = opsHeadline
}

// MARK: - One status vocabulary

/// The only status vocabulary the app renders: running, waiting on you,
/// blocked, done or failed. Queue position is separate from those five so a
/// queued job never reads as blocked or as the owner's turn.
enum OpsStatus: String, CaseIterable, Identifiable {
    case running, waiting, blocked, done, failed, queued, idle

    var id: String { rawValue }

    var title: String {
        switch self {
        case .running: return "Running"
        case .waiting: return "Waiting on you"
        case .blocked: return "Blocked"
        case .done: return "Done"
        case .failed: return "Failed"
        case .queued: return "Queued"
        case .idle: return "Idle"
        }
    }

    var icon: String {
        switch self {
        case .running: return "gearshape.2.fill"
        case .waiting: return OpsWorkState.needsYou.glyph
        case .blocked: return OpsWorkState.blocked.glyph
        case .done: return OpsWorkState.done.glyph
        case .failed: return OpsWorkState.failing.glyph
        case .queued: return "clock"
        case .idle: return "minus.circle"
        }
    }

    var color: Color {
        switch self {
        case .running: return OpsWorkState.running.color
        case .waiting: return OpsWorkState.needsYou.color
        case .blocked: return OpsWorkState.blocked.color
        case .done: return OpsWorkState.done.color
        case .failed: return OpsWorkState.failing.color
        case .queued: return OpsTheme.sky
        case .idle: return OpsTheme.muted
        }
    }

    /// Whether this state is waiting on the owner rather than on machinery.
    var isOwnerWork: Bool { self == .waiting || self == .blocked }
    var isFailure: Bool { self == .failed }

    /// Maps every server spelling onto the same five-state vocabulary.
    static func from(_ raw: String) -> OpsStatus {
        switch raw.lowercased().replacingOccurrences(of: "_", with: "-") {
        case "running", "working", "executing", "active", "processing", "in-progress", "inprogress", "now":
            return .running
        case "needs-you", "needs-owner", "needsowner", "attention", "decision-pending", "signoff", "approval":
            return .waiting
        case "blocked", "stuck", "stalled", "error":
            return .blocked
        case "failed", "red", "cancelled", "canceled", "dead":
            return .failed
        case "done", "finished", "merged", "closed", "complete", "completed", "succeeded":
            return .done
        case "queued", "waiting", "held", "paused", "open", "next", "unassigned", "awaiting-verification", "review":
            return .queued
        default:
            return .idle
        }
    }
}

// MARK: - Work states

/// The one status system for work. Each state has exactly one hue and one
/// glyph, and every surface (Ops tiles, Inbox chips, section headers, rows,
/// ticket pills, the chat ticket card) reads them from here, so a screen
/// cannot drift. Amber means "your move" and nothing else; orange is
/// machinery that stopped; red is a failure; violet is blocked on something
/// other than the owner.
enum OpsWorkState: String, CaseIterable {
    case needsYou, unanswered, stalled, blocked, failing, running, queued, waiting, done

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .unanswered: return "Unanswered"
        case .stalled: return "Stalled"
        case .blocked: return "Blocked"
        case .failing: return "Failing checks"
        case .running: return "Running"
        case .queued: return "Queued"
        case .waiting: return "Waiting"
        case .done: return "Done"
        }
    }

    var glyph: String {
        switch self {
        case .needsYou: return "hand.raised.fill"
        case .unanswered: return "bubble.left.and.exclamationmark.bubble.right.fill"
        case .stalled: return "pause.circle.fill"
        case .blocked: return "lock.fill"
        case .failing: return "xmark.circle.fill"
        case .running: return "gearshape.2.fill"
        case .queued: return "clock.fill"
        case .waiting: return "hourglass"
        case .done: return "checkmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .needsYou: return OpsTheme.warn
        case .unanswered: return OpsTheme.unanswered
        case .stalled: return OpsTheme.caution
        case .blocked: return OpsTheme.blocked
        case .failing: return OpsTheme.danger
        case .running: return OpsTheme.mint
        case .queued: return OpsTheme.sky
        case .waiting, .done: return OpsTheme.muted
        }
    }

    /// States that call for attention get a tinted tile and chip when non-zero;
    /// the rest stay neutral so the eye lands on problems first.
    var isProblem: Bool { [.needsYou, .unanswered, .stalled, .blocked, .failing].contains(self) }

    /// The Inbox filter key that lists this state.
    var filter: String {
        switch self {
        case .needsYou: return "needs-you"
        case .unanswered: return "unanswered"
        case .stalled: return "stalled"
        case .blocked: return "stuck"
        case .failing: return "failing"
        case .running: return "working"
        case .queued: return "waiting"
        case .waiting: return "held"
        case .done: return "finished"
        }
    }

    static func from(filter: String) -> OpsWorkState? { allCases.first { $0.filter == filter } }

    /// A ticket status label from `TicketPresentation` mapped onto the system.
    static func from(label: String) -> OpsWorkState? {
        switch label {
        case "Needs you": return .needsYou
        case "Unanswered": return .unanswered
        case "Stalled": return .stalled
        case "Blocked": return .blocked
        case "Failed", "Failing checks": return .failing
        case "Running": return .running
        case "Queued": return .queued
        case "Waiting": return .waiting
        case "Done": return .done
        default: return nil
        }
    }
}

/// An age that stays neutral grey until it passes its limit, then escalates
/// the same way everywhere: red, semibold. Nothing else changes colour for age.
struct OpsAge {
    /// Owner items escalate after two days, a player with no reply after two hours.
    static let ownerLimit: TimeInterval = 48 * 3600
    static let playerLimit: TimeInterval = 2 * 3600

    let text: String
    let escalated: Bool

    init(date: Date, now: Date = Date(), limit: TimeInterval = OpsAge.ownerLimit) {
        let seconds = now.timeIntervalSince(date)
        escalated = seconds >= limit
        text = seconds < 45 && seconds >= 0 ? "now" : OpsFormat.span(max(60, abs(seconds))) + (seconds < 0 ? "" : " ago")
    }

    var color: Color { escalated ? OpsTheme.danger : OpsTheme.muted }
    var weight: Font.Weight { escalated ? .semibold : .regular }
}

/// The state's glyph in its colour, sized for a dense row or a header.
struct OpsStateGlyph: View {
    let state: OpsWorkState
    var font: Font = .footnote
    var body: some View {
        Image(systemName: state.glyph).font(font.weight(.semibold)).foregroundStyle(state.color)
            .frame(minWidth: 18).accessibilityHidden(true)
    }
}

/// The one row anatomy for a work item in a list: state glyph, title, one
/// subtitle line ("#1503 · Blocked · next step"), age and chevron. Rows sit
/// on a shared `OpsGroup` surface; only items that need a decision get a
/// standalone card.
struct OpsWorkRow: View {
    let state: OpsWorkState
    let title: String
    var subtitle: String = ""
    var note: String = ""
    var age: OpsAge? = nil
    var stateWord: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            OpsStateGlyph(state: state)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let age {
                        Text(age.text).font(.caption.weight(age.weight)).monospacedDigit().foregroundStyle(age.color)
                            .lineLimit(1).layoutPriority(1)
                    }
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted)
                        .accessibilityHidden(true)
                }
                let word = stateWord ?? state.title
                let lead = Text(word).fontWeight(.medium).foregroundStyle(state.color)
                Text("\(lead)\(subtitle.isEmpty ? "" : " · " + subtitle)")
                    .font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
                if !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(OpsTheme.ink.opacity(0.8)).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A small header inside a grouped card or above a dense list: the state's
/// glyph, a word and a count, so headers use the same system as rows.
struct OpsMiniHeader: View {
    let text: String
    var state: OpsWorkState? = nil
    var count: Int? = nil
    var identifier: String? = nil
    var body: some View {
        HStack(spacing: 6) {
            if let state { OpsStateGlyph(state: state, font: .caption) }
            Text(text).font(.footnote.weight(.semibold)).foregroundStyle(state?.color ?? OpsTheme.muted)
            if let count {
                Text("\(count)").font(.footnote.weight(.semibold)).monospacedDigit().foregroundStyle(OpsTheme.muted)
                    .accessibilityIdentifier(identifier ?? "section-count")
            }
            Spacer(minLength: 0)
        }
        // Not combined: the count keeps its own identifier for tests.
        .accessibilityAddTraits(.isHeader)
    }
}

/// Status is always icon + word + colour, so colour is never the only signal.
struct OpsStatusBadge: View {
    let status: OpsStatus
    var label: String? = nil
    var compact = false
    var symbol: String? = nil

    /// When set, the pill takes the work state's glyph and hue, so a ticket's
    /// status pill matches the Inbox and Ops exactly.
    var state: OpsWorkState? = nil

    private var word: String { label ?? state?.title ?? status.title }
    private var tone: Color { state?.color ?? status.color }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol ?? state?.glyph ?? status.icon).font(.caption2.weight(.semibold)).accessibilityHidden(true)
            Text(word).font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold)).lineLimit(2)
        }
        .foregroundStyle(tone)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tone.opacity(0.12), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Status: \(word)")
    }
}

// MARK: - Surfaces

struct OpsGlyph: View {
    let icon: String
    var tone: Color = OpsTheme.accent
    var size: CGFloat = 34

    var body: some View {
        Image(systemName: icon)
            .font(.callout.weight(.semibold))
            .foregroundStyle(tone)
            .frame(width: size, height: size)
            .background(tone.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
    }
}

struct OpsCard<Content: View>: View {
    var padding: CGFloat = 16
    var spacing: CGFloat = 12
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) { content() }
            .padding(padding)
            .opsSurface()
    }
}

/// A run of rows on one raised surface, separated by inset hairlines: the
/// grouped list every Ops section, ticket section and settings block uses, so
/// lists read as one object with depth instead of loose text on the canvas.
struct OpsGroup<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 14)
            .opsSurface()
    }
}

/// A single list item on its own raised surface with a status stripe down the
/// leading edge, so state colour reads before any text does. Inbox rows use it.
struct OpsStripeCard: ViewModifier {
    let color: Color
    func body(content: Content) -> some View {
        content
            .padding(.leading, 16).padding(.trailing, 14).padding(.vertical, 12)
            .opsSurface(radius: 16)
            .overlay {
                HStack(spacing: 0) {
                    Rectangle().fill(color).frame(width: 4)
                    Spacer(minLength: 0)
                }
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
    }
}

extension View {
    func opsStripeCard(_ color: Color) -> some View { modifier(OpsStripeCard(color: color)) }

    /// A status stripe down the leading edge of a card that already has its
    /// own surface. Only cards that need a decision from the owner carry one.
    func opsLeadingStripe(_ color: Color, radius: CGFloat = 20) -> some View {
        overlay {
            HStack(spacing: 0) {
                Rectangle().fill(color).frame(width: 4)
                Spacer(minLength: 0)
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// An icon and a line of text with a tight, fixed gap. A `Label` inside a
/// List row takes the row's wide icon column, which pushes short captions
/// far from their icon; this keeps them together everywhere.
struct OpsIconLine: View {
    let text: String
    let icon: String
    var color: Color = OpsTheme.muted
    var font: Font = .opsCaption

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).accessibilityHidden(true)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(font)
        .foregroundStyle(color)
        .accessibilityElement(children: .combine)
    }
}

/// An inset divider inside an `OpsGroup`, starting where row text starts.
struct OpsGroupDivider: View {
    var inset: CGFloat = 42
    var body: some View { Rectangle().fill(OpsTheme.hairline).frame(height: 1).padding(.leading, inset) }
}

extension View {
    /// The one raised surface: same radius, border and soft light-mode shadow
    /// everywhere. On OLED black the shadow disappears and the border carries
    /// the edge.
    func opsSurface(radius: CGFloat = 20) -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(OpsTheme.hairline))
            .shadow(color: OpsTheme.shadow, radius: 8, y: 2)
    }
}

/// One clear primary action per screen. Secondary actions use `.bordered` or
/// plain text so the eye lands on the primary button first.
struct OpsPrimaryButton: View {
    let title: String
    var icon: String? = nil
    var busy = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    ProgressView().tint(OpsTheme.onAccent).accessibilityHidden(true)
                } else if let icon {
                    Image(systemName: icon).accessibilityHidden(true)
                }
                Text(title).lineLimit(2).multilineTextAlignment(.center)
            }
            .font(.callout.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 14)
            .background(enabled ? OpsTheme.sky : OpsTheme.raised, in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(enabled ? OpsTheme.onAccent : OpsTheme.muted)
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
    }
}

struct OpsSecondaryButton: View {
    let title: String
    var icon: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).accessibilityHidden(true) }
                Text(title).lineLimit(1)
            }
            .font(.callout.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 42)
            .padding(.horizontal, 12)
            .background(OpsTheme.raised, in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(OpsTheme.ink)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Scrolling and chrome

extension View {
    /// Lazy stacks and lists extend under the tab bar by default. A matching
    /// content margin keeps the last row clear of the bar and its blur at every
    /// Dynamic Type size.
    func opsScrollable(bottom: CGFloat = 88) -> some View {
        contentMargins(.bottom, bottom, for: .scrollContent)
    }

    /// A muted section title that still scales with Dynamic Type.
    func opsSectionHeader() -> some View {
        font(.opsSection)
            .textCase(nil)
            .foregroundStyle(OpsTheme.ink)
    }
}

/// The app's one-line answer to "is anything broken?".
struct OpsHealthLine: View {
    let status: OpsStatus
    let headline: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: status.icon)
                .font(.callout.weight(.semibold))
                .foregroundStyle(status.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(headline).font(.callout.weight(.semibold)).foregroundStyle(OpsTheme.ink)
                if !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
