import SwiftUI
import LakesideCore

/// What happened while the owner was away. Feed asks the server for the visit's
/// recap once, shows it, and acknowledges the visit immediately so the same day
/// is never briefed twice. Dismissing the card only hides it for this visit.
struct AwayRecap: View {
    @EnvironmentObject private var session: AppSession
    /// The recap rides in the feed payload, so it is present on the same render
    /// as the briefing and needs no second request.
    let recap: JSONValue
    @State private var hidden = false
    @State private var acknowledged = false

    private var items: [JSONValue] { recap["items"].array }

    var body: some View {
        if !hidden && !items.isEmpty {
            card.task { await acknowledge() }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                SectionLabel(text: "While you were away", count: items.count)
                Button {
                    withAnimation(.snappy(duration: 0.2)) { hidden = true }
                } label: {
                    Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(OpsTheme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss the recap")
                .accessibilityIdentifier("recap-dismiss")
            }
            VStack(spacing: 0) {
                ForEach(Array(items.prefix(4).enumerated()), id: \.offset) { pair in
                    if pair.offset > 0 { Hairline() }
                    row(pair.element)
                }
            }
            .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(OpsTheme.hairline, lineWidth: 1))
        }
        .accessibilityIdentifier("away-recap")
    }

    private func row(_ item: JSONValue) -> some View {
        let kind = item["kind"].string
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon(kind))
                .font(.caption.weight(.semibold))
                .foregroundStyle(color(kind))
                .frame(width: 20)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item["title"].string.nonempty ?? "Keir finished something")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(OpsTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(2)
                if let detail = item["detail"].string.nonempty, detail != item["title"].string {
                    Text(detail).font(.caption).foregroundStyle(OpsTheme.muted).lineLimit(2)
                }
            }
            Spacer(minLength: 6)
            Text(OpsFormat.ago(item["at"]))
                .font(.caption2).foregroundStyle(OpsTheme.muted).monospacedDigit()
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item["title"].string). \(item["detail"].string)")
    }

    private func icon(_ kind: String?) -> String {
        switch kind {
        case "win": return "checkmark.seal.fill"
        case "warning": return "exclamationmark.triangle.fill"
        case "decision": return "hand.raised.fill"
        case "brief": return "sun.max.fill"
        case "goal": return "flag.fill"
        case "insight": return "lightbulb.fill"
        case "task": return "checkmark.circle.fill"
        default: return "circle.fill"
        }
    }

    private func color(_ kind: String?) -> Color {
        switch kind {
        case "win", "task": return OpsTheme.mint
        case "warning", "decision": return OpsTheme.warn
        case "brief", "insight", "goal": return OpsTheme.sky
        default: return OpsTheme.muted
        }
    }

    /// One acknowledgement per visit. The card stays on screen for this render;
    /// the next launch starts from this point.
    private func acknowledge() async {
        guard !acknowledged else { return }
        acknowledged = true
        _ = try? await session.post("/api/keir/app/recap/ack", [:])
    }
}
