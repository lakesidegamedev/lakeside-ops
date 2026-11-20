import SwiftUI
import LakesideCore

// The iPhone chat shell: a low-noise canvas, Keir centred at the top, quiet
// left and right bubbles, one pill composer at the bottom and the native tab
// bar as the dock. Everything that is not the conversation (settings, stop,
// model, routing, the desk) sits behind the two menus instead of on screen.

// MARK: - Theme

/// Chat colours on top of the app palette. Dark is true black for OLED; the
/// light canvas is near white with grey Keir bubbles and soft blue owner
/// bubbles. Text on every bubble keeps at least 7:1 contrast.
enum KeirChatTheme {
    static let canvas = OpsTheme.background
    static let keirBubble = Brand.adaptive(0x1c1c1e, 0xeceef2)
    static let ownerBubble = Brand.adaptive(0x15395e, 0xd7e8fd)
    static let ownerInk = Brand.adaptive(0xf2f6fa, 0x0c1d33)
    static let pill = Brand.adaptive(0x161618, 0xffffff)
    static let chrome = Brand.adaptive(0x1c1c1e, 0xffffff)
    static let object = Brand.adaptive(0x111113, 0xffffff)
    static let stroke = Brand.adaptive(0x2a2a2d, 0xe4e7ec)
    static let avatar = Brand.adaptive(0x1c1c1e, 0xe7edf5)
    static let shadow = Brand.lightOnly(0x1b2a3c, alpha: 0.10)
}

extension View {
    /// An inline object in the timeline (work, a decision, a question): a
    /// rounded card that sits on the canvas the way a bubble does.
    func keirObjectCard(padding: CGFloat = 14) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(KeirChatTheme.object, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(KeirChatTheme.stroke))
            .shadow(color: KeirChatTheme.shadow, radius: 10, y: 3)
    }
}

/// A round chrome button: the menu at the top left, voice at the top right.
struct KeirCircleIcon: View {
    let system: String
    var body: some View {
        Image(systemName: system)
            .font(.body.weight(.medium))
            .foregroundStyle(OpsTheme.ink)
            .frame(width: 40, height: 40)
            .background(KeirChatTheme.chrome, in: Circle())
            .overlay(Circle().strokeBorder(KeirChatTheme.stroke))
            .shadow(color: KeirChatTheme.shadow, radius: 8, y: 2)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
    }
}

// MARK: - Keir at the top

/// The animated Keir sprite in a round frame. A named state (listening,
/// talking, thinking, working, sleeping) shows what Keir is doing; with none,
/// he greets once and then idles with blinks and small quirks.
struct KeirAvatar: View {
    let sprite: String?
    var body: some View {
        ZStack(alignment: .bottom) {
            Circle().fill(KeirChatTheme.avatar)
            Group {
                if let sprite { KeirSprite(state: sprite, size: .large) }
                else { KeirPortrait(lineAt: .distantPast, size: .large) }
            }
            .padding(.top, 5)
        }
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(KeirChatTheme.stroke))
        .shadow(color: KeirChatTheme.shadow, radius: 10, y: 3)
        .accessibilityHidden(true)
    }
}

/// One quiet status capsule under Keir's name.
struct KeirStatusPill<Leading: View>: View {
    let text: String
    var tone: Color = OpsTheme.muted
    var shimmer = false
    @ViewBuilder var leading: () -> Leading
    var body: some View {
        HStack(spacing: 5) {
            leading()
            if shimmer { LoadingShimmer(text: text) } else { Text(text).foregroundStyle(tone) }
        }
        .font(.caption.weight(.medium))
        .lineLimit(1)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(KeirChatTheme.chrome, in: Capsule())
        .overlay(Capsule().strokeBorder(KeirChatTheme.stroke))
    }
}

extension KeirStatusPill where Leading == EmptyView {
    init(text: String, tone: Color = OpsTheme.muted, shimmer: Bool = false) {
        self.init(text: text, tone: tone, shimmer: shimmer) { EmptyView() }
    }
}

/// The top of the chat. Left: Keir's menu. Centre: Keir, the conversation
/// name (tap for conversations) and at most a few status capsules. Right:
/// voice. Nothing else lives here.
struct KeirHeader<Tools: View>: View {
    let title: String
    let presence: KeirPresence.State
    let level: Double
    let sprite: String?
    let attention: Int
    let workCount: Int
    let yolo: Bool
    let disabled: Bool
    let openThreads: () -> Void
    let openInbox: () -> Void
    let startVoice: () -> Void
    let reviewAutonomy: () -> Void
    @ViewBuilder let tools: () -> Tools

    var body: some View {
        VStack(spacing: 6) {
            ZStack(alignment: .top) {
                HStack(alignment: .top) {
                    Menu { tools() } label: { KeirCircleIcon(system: "line.3.horizontal") }
                        .accessibilityLabel("Keir tools").accessibilityIdentifier("keir-tools").disabled(disabled)
                    Spacer(minLength: 0)
                    Button(action: startVoice) { KeirCircleIcon(system: "waveform") }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Start voice conversation").accessibilityIdentifier("keir-microphone")
                }
                Button(action: openThreads) {
                    VStack(spacing: 4) {
                        KeirAvatar(sprite: sprite).frame(width: 56, height: 56)
                        HStack(spacing: 3) {
                            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(OpsTheme.ink).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(OpsTheme.muted)
                        }
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 52)
                .accessibilityLabel("Conversations, " + title)
                .accessibilityIdentifier("keir-threads")
                .disabled(disabled)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { pills }
                VStack(spacing: 6) { pills }
            }
        }
        .padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 10)
        .frame(maxWidth: .infinity)
        .background {
            LinearGradient(stops: [.init(color: KeirChatTheme.canvas, location: 0), .init(color: KeirChatTheme.canvas, location: 0.75), .init(color: KeirChatTheme.canvas.opacity(0), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    /// What Keir is doing, what is running and what needs the owner. Each is
    /// shown only when true, so a quiet Keir shows nothing at all.
    @ViewBuilder private var pills: some View {
        switch presence {
        case .stopped:
            KeirStatusPill(text: "Stopped", tone: OpsTheme.warn) { Image(systemName: "pause.circle.fill").foregroundStyle(OpsTheme.warn) }
                .accessibilityElement(children: .combine).accessibilityIdentifier("keir-presence")
        case .offline:
            KeirStatusPill(text: "Reconnecting") { Image(systemName: "wifi.exclamationmark").foregroundStyle(OpsTheme.muted) }
                .accessibilityElement(children: .combine).accessibilityIdentifier("keir-presence")
        case .listening:
            KeirStatusPill(text: "Listening") { KeirAudioWaveform(level: level).frame(width: 24, height: 14) }
                .accessibilityElement(children: .combine).accessibilityIdentifier("keir-presence")
        case .speaking:
            KeirStatusPill(text: "Speaking") { Image(systemName: "speaker.wave.2.fill").foregroundStyle(OpsTheme.sky) }
                .accessibilityElement(children: .combine).accessibilityIdentifier("keir-presence")
        case .thinking:
            KeirStatusPill(text: "Thinking", shimmer: true).accessibilityIdentifier("keir-presence")
        default:
            EmptyView()
        }
        if workCount > 0 {
            Button(action: openInbox) {
                KeirStatusPill(text: workCount == 1 ? "Working" : "\(workCount) tasks", shimmer: true) {
                    Circle().fill(OpsTheme.mint).frame(width: 6, height: 6)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(workCount == 1 ? "Keir is working. Open inbox" : "Keir has \(workCount) tasks running. Open inbox")
            .accessibilityIdentifier("keir-activity-strip")
        }
        if attention > 0 {
            let text = attention == 1 ? "1 needs you" : "\(attention) need you"
            Button(action: openInbox) {
                KeirStatusPill(text: text, tone: OpsTheme.warn) { Image(systemName: "hand.raised.fill").foregroundStyle(OpsTheme.warn) }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(text). Open inbox")
            .accessibilityIdentifier("keir-chip-attention")
        }
        if yolo {
            Button(action: reviewAutonomy) {
                KeirStatusPill(text: "Autonomy on", tone: OpsTheme.warn) { Image(systemName: "bolt.fill").foregroundStyle(OpsTheme.warn) }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Autonomy mode is on. Keir can act without asking for supported owner actions. Double tap to turn it off.")
            .accessibilityIdentifier("keir-yolo-banner")
        }
    }
}

// MARK: - Timeline pieces

/// A quiet centred time line between messages that are far apart.
struct KeirTimeMark: View {
    let date: Date
    var body: some View {
        Text(label)
            .font(.caption2.weight(.medium)).foregroundStyle(OpsTheme.muted)
            .frame(maxWidth: .infinity).padding(.top, 4)
            .accessibilityAddTraits(.isHeader)
    }
    private var label: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(date) { return "Yesterday " + date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
    }

    /// Milliseconds since 1970 on the message, or nil when the server sent none.
    static func timestamp(_ message: JSONValue) -> Date? {
        guard let ms = message["at"].number, ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    /// The first message, and any message more than 45 minutes after the one
    /// before it, gets a time line.
    static func shows(_ message: JSONValue, after previous: JSONValue?) -> Bool {
        guard let when = timestamp(message) else { return false }
        guard let previous, let before = timestamp(previous) else { return true }
        return when.timeIntervalSince(before) > 45 * 60
    }
}

/// Live work Keir is doing in this conversation, as an inline object.
struct KeirLiveWorkCard: View {
    let task: JSONValue
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "gearshape.2")
                    .font(.callout).foregroundStyle(OpsTheme.mint)
                    .frame(width: 34, height: 34)
                    .background(OpsTheme.mint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(task["title"].string.nonempty ?? "Keir's work").font(.callout.weight(.semibold)).lineLimit(2)
                    LoadingShimmer(text: task["steering"].bool ? "Updating direction" : "Working").font(.caption)
                }
                Spacer(minLength: 0)
            }
            if !task["live"].array.isEmpty { KeirToolCalls(calls: task["live"].array) }
        }
        .keirObjectCard(padding: 12)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Composer

/// The pill composer: "+" for everything that shapes a message, the text
/// field, and one trailing control that is the microphone when empty and send
/// once there is something to send.
struct KeirComposerPill<Plus: View, Field: View, Trailing: View>: View {
    @ViewBuilder let plus: () -> Plus
    @ViewBuilder let field: () -> Field
    @ViewBuilder let trailing: () -> Trailing
    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            plus()
            field().padding(.vertical, 11)
            trailing()
        }
        .padding(.horizontal, 4)
        .frame(minHeight: 48)
        .background(KeirChatTheme.pill, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(KeirChatTheme.stroke))
        .shadow(color: KeirChatTheme.shadow, radius: 12, y: 3)
    }
}

/// The trailing composer control. Send is a filled circle so it is the one
/// obvious action once there is text.
struct KeirComposerIcon: View {
    let system: String
    var filled = false
    var body: some View {
        Image(systemName: system)
            .font(.body.weight(filled ? .bold : .regular))
            .foregroundStyle(filled ? OpsTheme.onAccent : OpsTheme.muted)
            .frame(width: 32, height: 32)
            .background(filled ? OpsTheme.sky : Color.clear, in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}
