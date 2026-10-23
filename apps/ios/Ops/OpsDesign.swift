import SwiftUI
import LakesideCore

// MARK: - Type scale

/// Every size is a Dynamic Type text style. Nothing in the app pins a point
/// size for reading text, so accessibility sizes grow instead of clipping.
extension Font {
    static let opsHero = Font.system(.largeTitle, design: .rounded).weight(.bold)
    static let opsTitle = Font.system(.title2, design: .rounded).weight(.semibold)
    static let opsCardTitle = Font.system(.headline, design: .default).weight(.semibold)
    static let opsSection = Font.system(.footnote, design: .default).weight(.semibold)
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
        case .waiting: return "hand.raised.fill"
        case .blocked: return "exclamationmark.triangle.fill"
        case .done: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .queued: return "clock"
        case .idle: return "minus.circle"
        }
    }

    var color: Color {
        switch self {
        case .running: return OpsTheme.mint
        case .waiting: return OpsTheme.warn
        case .blocked: return OpsTheme.warn
        case .done: return OpsTheme.muted
        case .failed: return OpsTheme.danger
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

/// Status is always icon + word + colour, so colour is never the only signal.
struct OpsStatusBadge: View {
    let status: OpsStatus
    var label: String? = nil
    var compact = false

    private var word: String { label ?? status.title }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: status.icon).font(.caption2.weight(.semibold)).accessibilityHidden(true)
            Text(word).font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold)).lineLimit(2)
        }
        .foregroundStyle(status.color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(status.color.opacity(0.12), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Status: \(word)")
    }
}

// MARK: - Surfaces

struct OpsCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(OpsTheme.hairline))
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
    func opsScrollable(bottom: CGFloat = 32) -> some View {
        contentMargins(.bottom, bottom, for: .scrollContent)
    }

    /// A muted section title that still scales with Dynamic Type.
    func opsSectionHeader() -> some View {
        font(.opsSection)
            .textCase(.uppercase)
            .tracking(0.6)
            .foregroundStyle(OpsTheme.muted)
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
