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
            StarmerPortrait()
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
            StarmerPortrait()
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

    private func load() async {
        if let value = try? await session.get("/api/keir/app/starmer") {
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
            withAnimation(.snappy(duration: 0.25)) { line = value }
            error = nil
        } catch {
            self.error = error.displayMessage
        }
    }
}

/// The portrait itself. Every pixel is a character in a 24 by 24 map, drawn on
/// a Canvas so it stays crisp at any size. Blink, bob and tie sway are the only
/// animation: no repeatForever loops, which would stop UI tests reaching idle.
struct StarmerPortrait: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { timeline in
            Canvas { context, size in
                let columns = StarmerArt.columns
                let rows = StarmerArt.rows.count
                let pixel = min(size.width / CGFloat(columns), size.height / CGFloat(rows))
                let ox = (size.width - pixel * CGFloat(columns)) / 2
                let oy = (size.height - pixel * CGFloat(rows)) / 2
                let seconds = timeline.date.timeIntervalSinceReferenceDate
                let blinking = seconds.truncatingRemainder(dividingBy: 4.4) < 0.18
                let bob: CGFloat = Int(seconds * 2) % 2 == 0 ? 0 : pixel * 0.5
                let sway = Int(seconds / 0.9) % 2 == 0 ? 0 : 1
                for (r, row) in StarmerArt.rows.enumerated() {
                    for (c, character) in row.enumerated() {
                        var color = StarmerArt.palette[character]
                        if character == "E" && blinking { color = StarmerArt.palette["S"] }
                        guard let color else { continue }
                        let x = CGFloat(c) + (character == "T" ? CGFloat(sway) : 0)
                        let rect = CGRect(
                            x: ox + x * pixel,
                            y: oy + CGFloat(r) * pixel + bob,
                            width: pixel + 0.6,
                            height: pixel + 0.6
                        )
                        context.fill(Path(rect), with: .color(color))
                    }
                }
            }
            .background(
                LinearGradient(colors: [OpsTheme.raised, OpsTheme.background], startPoint: .top, endPoint: .bottom)
            )
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(OpsTheme.hairline, lineWidth: 1))
    }
}

/// The 8-bit design: side-parted dark hair, glasses, a white shirt and a red
/// tie, in the suit the owner sees at the dispatch box and in the studio.
enum StarmerArt {
    static let columns = 24

    static let rows: [String] = [
        "........................",
        "........................",
        "........HHHHHHHH........",
        ".......HHHHHHHHHH.......",
        "......HHHHHhHHHHHH......",
        ".....HHHHHhHHHHHHHH.....",
        ".....HHSSSSSSSSSSHH.....",
        ".....HHSSSSSSSSSSHH.....",
        ".....HSSSSSSSSSSSSH.....",
        ".....HSGGGSSGGGSSSH.....",
        ".....HSGEGSSGEGSSSH.....",
        ".....HSGGGSSGGGSSSH.....",
        ".....sSSSSSsSSSSSSs.....",
        ".....sSSSSSsSSSSSSs.....",
        "......sSSSMMMSSSSs......",
        "......ssSSSSSSSSss......",
        ".....uUUUSSWWSSUUUu.....",
        "....UUUUWWWWWWWWUUUu....",
        "...UUUUUWWWTTWWWUUUUu...",
        "...UUUUUWWWTTWWWUUUUu...",
        "..UUUUUUWWWTTWWWUUUUu...",
        "..UUUUUUWWWTTWWWUUUUu...",
        "..UUUUUUWWWTTWWWUUUUu...",
        "..UUUUUUWWWTTWWWUUUUu...",
    ]

    static let palette: [Character: Color] = [
        "H": Color(red: 0.18, green: 0.20, blue: 0.25),
        "h": Color(red: 0.30, green: 0.34, blue: 0.42),
        "S": Color(red: 0.91, green: 0.73, blue: 0.56),
        "s": Color(red: 0.82, green: 0.60, blue: 0.45),
        "G": Color(red: 0.11, green: 0.12, blue: 0.15),
        "E": Color(red: 0.07, green: 0.08, blue: 0.10),
        "W": Color(red: 0.95, green: 0.94, blue: 0.91),
        "T": Color(red: 0.75, green: 0.22, blue: 0.17),
        "U": Color(red: 0.14, green: 0.16, blue: 0.21),
        "u": Color(red: 0.18, green: 0.22, blue: 0.27),
        "M": Color(red: 0.61, green: 0.36, blue: 0.27),
    ]
}
