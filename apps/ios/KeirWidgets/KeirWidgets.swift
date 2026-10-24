import ActivityKit
import WidgetKit
import SwiftUI

@main struct KeirWidgets: WidgetBundle {
    var body: some Widget { KeirWorkActivity(); KeirHomeWidget(); KeirLauncher() }
}

struct KeirWorkActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: KeirActivityAttributes.self) { context in
            HStack(spacing: 14) {
                Image(systemName: context.state.stopped ? "stop.circle.fill" : "ellipsis.bubble.fill")
                    .font(.largeTitle).foregroundStyle(context.state.stopped ? .orange : .cyan)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Keir").font(.headline)
                    Text(context.isStale ? "Open Keir to refresh" : context.state.count == 0 ? "No active work" : context.state.status).font(.subheadline)
                }
                Spacer()
                if context.state.count > 0 { Text("\(context.state.count)").font(.title2.monospacedDigit()) }
            }.padding().activityBackgroundTint(.black.opacity(0.9)).activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "lakesideops://keir"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Label("Keir", systemImage: "ellipsis.bubble.fill").foregroundStyle(.cyan) }
                DynamicIslandExpandedRegion(.trailing) { Text("\(context.state.count)").monospacedDigit() }
                DynamicIslandExpandedRegion(.bottom) { Text(context.isStale ? "Open Keir to refresh" : context.state.count == 0 ? "No active work" : context.state.status).font(.callout).padding(.top, 4) }
            } compactLeading: {
                Image(systemName: context.state.stopped ? "stop.fill" : context.state.status.localizedCaseInsensitiveContains("needs") ? "hand.raised.fill" : "ellipsis").foregroundStyle(context.state.stopped ? .orange : .cyan)
            } compactTrailing: {
                Text("\(context.state.count)").monospacedDigit()
            } minimal: {
                Image(systemName: context.state.stopped ? "stop.fill" : context.state.status.localizedCaseInsensitiveContains("needs") ? "hand.raised.fill" : "ellipsis").foregroundStyle(.cyan)
            }.widgetURL(URL(string: "lakesideops://keir"))
        }
    }
}

/// The Home Screen Keir widget. WidgetKit renders snapshots, so this is the
/// static half of the Ops card: the latest line the app cached, one sprite
/// frame and the queue counts. It refreshes on a thirty-minute timeline and
/// when the app writes a changed line.
struct KeirHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KeirHome", provider: KeirHomeProvider()) { entry in
            KeirHomeView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(colors: [Color(red: 0.08, green: 0.12, blue: 0.17),
                                            Color(red: 0.04, green: 0.06, blue: 0.09)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                }
                .widgetURL(URL(string: "lakesideops://keir?view=ops"))
        }
        .configurationDisplayName("Keir")
        .description("Keir's latest line and what he is working on.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct KeirHomeEntry: TimelineEntry {
    let date: Date
    let snapshot: KeirWidgetCache.Snapshot?
}

struct KeirHomeProvider: TimelineProvider {
    func placeholder(in context: Context) -> KeirHomeEntry { KeirHomeEntry(date: .now, snapshot: nil) }
    func getSnapshot(in context: Context, completion: @escaping (KeirHomeEntry) -> Void) {
        completion(KeirHomeEntry(date: .now, snapshot: KeirWidgetCache.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<KeirHomeEntry>) -> Void) {
        let now = Date()
        completion(Timeline(entries: [KeirHomeEntry(date: now, snapshot: KeirWidgetCache.load())],
                            policy: .after(now.addingTimeInterval(30 * 60))))
    }
}

struct KeirHomeView: View {
    @Environment(\.widgetFamily) private var family
    let entry: KeirHomeEntry

    private var snapshot: KeirWidgetCache.Snapshot? { entry.snapshot }
    private var text: String {
        let value = snapshot?.text ?? ""
        return value.isEmpty ? "Open Keir for the latest line." : value
    }
    private var state: String {
        guard let snapshot else { return "idle" }
        if snapshot.waiting > 0 { return "alert" }
        if snapshot.running > 0 { return "working" }
        return "idle"
    }

    var body: some View {
        if family == .systemSmall { small } else { medium }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Text("KEIR").font(.system(size: 9, weight: .bold)).tracking(1.2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                live
            }
            KeirSpriteStill(state: state, size: .small)
                .frame(width: 46, height: 46)
            Text(text)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(3)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 0)
            if let snapshot, snapshot.waiting > 0 {
                Text("\(snapshot.waiting) waiting on you")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.orange)
            } else {
                updated
            }
        }
    }

    private var medium: some View {
        HStack(alignment: .top, spacing: 12) {
            KeirSpriteStill(state: state, size: .medium)
                .frame(width: 84, height: 84)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text("KEIR").font(.system(size: 9, weight: .bold)).tracking(1.2).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    live
                }
                Text(text)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.white)
                    .lineLimit(3)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 0)
                if snapshot != nil {
                    HStack(spacing: 12) {
                        count(snapshot?.running ?? 0, "running")
                        count(snapshot?.waiting ?? 0, "waiting")
                        count(snapshot?.queued ?? 0, "queued")
                    }
                }
                updated
            }
        }
    }

    private var live: some View {
        HStack(spacing: 4) {
            Circle().fill(.mint).frame(width: 5, height: 5)
            Text("LIVE").font(.system(size: 8, weight: .bold)).tracking(0.8).foregroundStyle(.mint)
        }
    }

    private func count(_ value: Int, _ label: String) -> some View {
        HStack(spacing: 3) {
            Text("\(value)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(value > 0 ? .white : .secondary)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var updated: some View {
        if let snapshot {
            (Text("Updated ") + Text(Date(timeIntervalSince1970: snapshot.savedAt), style: .relative))
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } else {
            Text("Open Keir to sync").font(.system(size: 9)).foregroundStyle(.secondary)
        }
    }
}

struct KeirLauncher: Widget {
    struct Entry: TimelineEntry { var date: Date }
    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry { Entry(date: .now) }
        func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now)) }
        func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) { completion(Timeline(entries: [Entry(date: .now)], policy: .never)) }
    }
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KeirLauncher", provider: Provider()) { _ in
            VStack(alignment: .leading, spacing: 10) {
                Label("Keir", systemImage: "ellipsis.bubble.fill").font(.headline).foregroundStyle(.cyan)
                Text("Your workspace,\none tap away.").font(.callout)
                HStack(spacing: 18) {
                    Link(destination: URL(string: "lakesideops://keir?view=voice")!) { Image(systemName: "mic.fill").accessibilityLabel("Talk to Keir") }
                    Link(destination: URL(string: "lakesideops://keir?view=activity")!) { Image(systemName: "list.bullet").accessibilityLabel("Open activity") }
                    Link(destination: URL(string: "lakesideops://keir?view=controls")!) { Image(systemName: "slider.horizontal.3").accessibilityLabel("Open Keir controls") }
                }
            }.containerBackground(.fill.tertiary, for: .widget).widgetURL(URL(string: "lakesideops://keir"))
        }.configurationDisplayName("Keir Shortcuts").description("Talk to Keir, check activity or open controls.").supportedFamilies([.systemSmall])
    }
}
