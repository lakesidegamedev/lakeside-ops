import SwiftUI
import LakesideCore

/// The Ops widget: an animated 8-bit Keir Starmer, a fresh line from Keir every
/// thirty minutes, and a swipe to what he is working on. The portrait is drawn
/// in code, pixel by pixel, so it ships with no image assets and animates in
/// the same palette as the rest of Ops.
struct StarmerWidget: View {
    @EnvironmentObject private var session: AppSession
    @State private var line: JSONValue = .null
    @State private var showWork = false
    @State private var busy = false
    @State private var error: String?
    @State private var changedAt: Date?

    private var message: String {
        line["text"].string.nonempty ?? "Keir is settling in. The first line lands shortly."
    }
    private var working: JSONValue { line["working"] }
    private var workHeadline: String {
        working["headline"].string.nonempty ?? "Keir's queue"
    }
    private var workDetail: String {
        working["detail"].string.nonempty ?? "Nothing is running right now."
    }
    private var items: [JSONValue] { working["items"].array }
    private var waiting: Int { Int(working["waiting"].number ?? 0) }
    private var lineDate: Date? { line["at"].number.map { Date(timeIntervalSince1970: $0 / 1000) } }
    /// UI tests force one state so the four widget screenshots are stable.
    private var forcedState: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--uitest-starmer-state"), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            ZStack(alignment: .topLeading) {
                messageFace
                    .opacity(showWork ? 0 : 1)
                    .offset(x: showWork ? -26 : 0)
                    .accessibilityHidden(showWork)
                workFace
                    .opacity(showWork ? 1 : 0)
                    .offset(x: showWork ? 0 : 26)
                    .accessibilityHidden(!showWork)
            }
            .animation(.snappy(duration: 0.25), value: showWork)
            .frame(maxWidth: .infinity, minHeight: 118, alignment: .topLeading)
            footer
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(OpsTheme.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(LinearGradient(colors: [OpsTheme.sky.opacity(0.10), .clear], startPoint: .topLeading, endPoint: .bottomTrailing))
                )
        )
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(OpsTheme.hairline, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard abs(value.translation.width) > 40 else { return }
                    withAnimation(.snappy(duration: 0.25)) { showWork = value.translation.width < 0 }
                }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ops-starmer")
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(120))
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Text("KEIR").font(.system(size: 11, weight: .bold)).tracking(1.4).foregroundStyle(OpsTheme.muted)
            TimelineView(.periodic(from: .now, by: 0.8)) { timeline in
                let on = Int(timeline.date.timeIntervalSinceReferenceDate * 1.25) % 2 == 0
                HStack(spacing: 4) {
                    Circle().fill(OpsTheme.mint.opacity(on ? 1 : 0.35)).frame(width: 6, height: 6)
                    Text("LIVE").font(.system(size: 9, weight: .bold)).tracking(1).foregroundStyle(OpsTheme.mint.opacity(on ? 1 : 0.5))
                }
            }
            Spacer()
            if let error { Text(error).font(.caption2).foregroundStyle(OpsTheme.warn).lineLimit(1) }
            Button {
                Task { await refresh() }
            } label: {
                Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpsTheme.muted)
            .disabled(busy)
            .accessibilityLabel("Ask Keir for a new line")
            .accessibilityIdentifier("ops-starmer-refresh")
        }
    }

    // MARK: Message face

    private var messageFace: some View {
        HStack(alignment: .top, spacing: 14) {
            KeirPortrait(busy: busy, waiting: waiting, lineAt: lineDate, changedAt: changedAt, error: error != nil, size: .medium, forced: forcedState)
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(message)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(OpsTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(5)
                    .accessibilityIdentifier("ops-starmer-line")
                Text(sinceLine)
                    .font(.caption2)
                    .foregroundStyle(OpsTheme.muted)
            }
            Spacer(minLength: 0)
        }
    }

    private var sinceLine: String {
        guard line["at"].number != nil else { return "A new line every thirty minutes" }
        return "New line every thirty minutes · \(OpsFormat.ago(line["at"]))"
    }

    // MARK: Work face

    private var workFace: some View {
        HStack(alignment: .top, spacing: 14) {
            KeirPortrait(waiting: waiting, lineAt: lineDate, size: .small)
                .frame(width: 72, height: 72)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 7) {
                Text(workHeadline)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(OpsTheme.ink)
                    .accessibilityIdentifier("ops-starmer-working")
                Text(workDetail)
                    .font(.caption)
                    .foregroundStyle(OpsTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(3)
                HStack(spacing: 12) {
                    count("running", "running")
                    count("waiting", "waiting")
                    count("queued", "queued")
                }
                if !items.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(items.prefix(2).enumerated()), id: \.offset) { pair in
                            HStack(spacing: 6) {
                                Circle().fill(OpsStatus.from(pair.element["state"].string).color).frame(width: 5, height: 5)
                                Text(OpsText.workTitle(pair.element)).font(.caption2).foregroundStyle(OpsTheme.muted).lineLimit(1)
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func count(_ key: String, _ label: String) -> some View {
        let value = Int(working[key].number ?? 0)
        return HStack(spacing: 4) {
            Text("\(value)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(value > 0 ? OpsTheme.ink : OpsTheme.muted)
            Text(label).font(.caption2).foregroundStyle(OpsTheme.muted)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 8) {
            HStack(spacing: 5) {
                Circle().fill(showWork ? OpsTheme.muted : OpsTheme.sky).frame(width: 5, height: 5)
                Circle().fill(showWork ? OpsTheme.sky : OpsTheme.muted).frame(width: 5, height: 5)
            }
            .accessibilityHidden(true)
            Text(showWork ? "What he is working on" : "Swipe for what he is working on")
                .font(.caption2).foregroundStyle(OpsTheme.muted)
            Spacer()
            Button {
                withAnimation(.snappy(duration: 0.25)) { showWork.toggle() }
            } label: {
                Image(systemName: showWork ? "text.bubble" : "list.bullet")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OpsTheme.sky)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showWork ? "Show Keir's line" : "Show what Keir is working on")
            .accessibilityIdentifier("ops-starmer-flip")
        }
    }

    // MARK: Data

    /// The Home Screen widget cannot authenticate, so the app leaves it the
    /// latest line and queue counts in the shared App Group.
    private func cache(_ value: JSONValue) {
        KeirWidgetCache.save(
            text: value["text"].string,
            at: value["at"].number ?? 0,
            running: Int(value["working"]["running"].number ?? 0),
            waiting: Int(value["working"]["waiting"].number ?? 0),
            queued: Int(value["working"]["queued"].number ?? 0),
            headline: value["working"]["headline"].string,
            detail: value["working"]["detail"].string
        )
    }

    private func load() async {
        if let value = try? await session.get("/api/keir/app/starmer") {
            if value["text"].string != line["text"].string { changedAt = Date() }
            cache(value)
            withAnimation(.snappy(duration: 0.25)) { line = value }
            error = nil
        }
    }

    private func refresh() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await session.post("/api/keir/app/starmer/refresh", [:])
            if value["text"].string != line["text"].string { changedAt = Date() }
            cache(value)
            withAnimation(.snappy(duration: 0.25)) { line = value }
            error = nil
        } catch {
            self.error = error.displayMessage
        }
    }
}

