import SwiftUI
import LakesideCore

/// The Ops widget: an animated 8-bit Keir Starmer, a fresh line from Keir every
/// thirty minutes, and a second face with what he is working on (one button or
/// a horizontal swipe flips it). The portrait is drawn
/// in code, pixel by pixel, so it ships with no image assets and animates in
/// the same palette as the rest of Ops.
struct StarmerWidget: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @State private var line: JSONValue = .null
    @State private var showWork = false
    @State private var busy = false
    @State private var error: String?
    @State private var changedAt: Date?
    /// The last periodic read failed; the line on screen is older than it looks.
    @State private var readFailed = false

    private var message: String {
        line["text"].string.replacingOccurrences(of: #"\s+on \d+\.\d+\.\d+(?=:|\b)"#, with: "", options: .regularExpression).nonempty ?? "Keir is settling in. The first line lands shortly."
    }
    private var workHeadline: String { "Keir's queue" }
    private var workDetail: String { "Open Inbox to view tickets and tasks." }
    private var waiting: Int { ops.openTickets.filter { WorkQueuePresentation.bucket($0) == "waiting" }.count }
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
            .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
            footer
            Button("Chat with Keir") { router.tab = .keir }
                .font(.opsSecondary)
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
        // Simultaneous, so a vertical drag that starts on the card still scrolls
        // Ops. An exclusive drag swallowed it, and at accessibility text sizes
        // the card fills most of the screen, which left the rows below it
        // (Feed, Goals) out of reach. Only a mostly horizontal swipe flips it.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard abs(value.translation.width) > 40,
                          abs(value.translation.width) > abs(value.translation.height) else { return }
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

    /// The line is periodic, not live: no pulsing live badge. Its age is stated
    /// in a sentence under the line instead.
    private var header: some View {
        HStack(spacing: 8) {
            Text("Keir").opsSectionHeader()
            Spacer()
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
            KeirPortrait(busy: busy, waiting: waiting, lineAt: lineDate, changedAt: changedAt, error: false, size: .medium, forced: forcedState)
                .frame(width: 72, height: 72)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(message)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(OpsTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("ops-starmer-line")
                // Re-read each minute so the stated age never freezes.
                TimelineView(.periodic(from: .now, by: 60)) { _ in Text(sinceLine) }
                    .font(.caption2)
                    .foregroundStyle(readFailed || error != nil ? OpsTheme.warn : OpsTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("ops-starmer-age")
            }
            Spacer(minLength: 0)
        }
    }

    private var sinceLine: String {
        if error != nil { return "A new line could not be fetched. The line above is unchanged." }
        guard line["at"].number != nil else {
            return readFailed ? "Keir's line could not load. The app tries again every two minutes." : "Keir writes a new line every thirty minutes."
        }
        let age = OpsFormat.ago(line["at"])
        let when = age == "now" ? "just now" : age
        if readFailed { return "Could not check for a newer line. This one was written \(when)." }
        return "Updated \(when)"
    }

    // MARK: Work face

    private var workFace: some View {
        HStack(alignment: .top, spacing: 14) {
            KeirPortrait(waiting: waiting, lineAt: lineDate, size: .small)
                .frame(width: 54, height: 54)
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
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: Footer

    /// One control flips the card. The swipe still works but is not taught on
    /// screen.
    private var footer: some View {
        Button {
            withAnimation(.snappy(duration: 0.25)) { showWork.toggle() }
        } label: {
            HStack(spacing: 6) {
                Text(showWork ? "Back to Keir's line" : "What Keir is working on")
                Image(systemName: "chevron.right").accessibilityHidden(true)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(OpsTheme.sky)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(showWork ? "Show Keir's line" : "Show what Keir is working on")
        .accessibilityIdentifier("ops-starmer-flip")
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
        guard let value = try? await session.get("/api/keir/app/starmer") else {
            if !Task.isCancelled { readFailed = true }
            return
        }
        if value["text"].string != line["text"].string { changedAt = Date() }
        cache(value)
        withAnimation(.snappy(duration: 0.25)) { line = value }
        error = nil; readFailed = false
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
            error = nil; readFailed = false
        } catch {
            self.error = error.displayMessage
        }
    }
}

