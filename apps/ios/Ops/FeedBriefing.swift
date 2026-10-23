import SwiftUI
import LakesideCore

/// Feed is the live briefing: one hero answer, the work waiting on you with
/// inline actions, what Keir did, what comes next, and ideas worth triaging.
struct FeedView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var ops: OpsStore
    @EnvironmentObject private var router: OpsRouter
    @ObservedObject private var attention = AttentionCenter.shared
    @State private var feed: [JSONValue] = []
    @State private var ideas: [JSONValue] = []
    @State private var upcoming: [JSONValue] = []
    @State private var briefing = false
    @State private var error: String?

    private var running: Int { Int(ops.kpis["running"].number ?? 0) }
    private var queued: Int { Int(ops.kpis["queued"].number ?? 0) }
    private var broken: Int { ops.servicesDown.count + ops.redPRs }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                hero
                needsYou
                whatKeirDid
                whatsNext
                ideasSection
            }
            .padding(16)
        }
        .opsScrollable()
        .refreshable { await load(); await ops.refresh(session) }
        .opsScreen().navigationTitle("Feed").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { brief() } label: { Label("Brief me", systemImage: "sun.max").labelStyle(.titleAndIcon) }
                    .disabled(briefing).accessibilityIdentifier("brief-now")
            }
        }
        .task { while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(45)) } }
    }

    // MARK: Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(greeting).font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.muted)
            Text(attention.count == 0 ? "You're clear." : attention.summary + ".")
                .font(.opsHero)
                .foregroundStyle(OpsTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(heroDetail).font(.callout).foregroundStyle(OpsTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).font(.caption).foregroundStyle(OpsTheme.warn) }
            if attention.count > 0 {
                OpsPrimaryButton(title: "Review \(attention.count) waiting", icon: "hand.raised.fill") {
                    router.activityFilter = "all"; router.tab = .activity
                }
                .accessibilityIdentifier("feed-review-attention")
            } else {
                OpsPrimaryButton(title: "Ask Keir what is next", icon: "arrow.up.right") {
                    router.tab = .keir
                }
                .accessibilityIdentifier("feed-ask-keir")
            }
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
    }

    private var heroDetail: String {
        var parts: [String] = []
        parts.append(running > 0 ? "Keir is working on \(running) task\(running == 1 ? "" : "s")" : "Keir is idle")
        if queued > 0 { parts.append("\(queued) queued") }
        parts.append(broken == 0 ? "nothing broken" : "\(broken) failing")
        return parts.joined(separator: " · ") + "."
    }

    // MARK: Needs you

    @ViewBuilder private var needsYou: some View {
        if attention.count > 0 {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: AttentionCenter.label, count: attention.count)
                AttentionStack(limit: 3)
                if attention.count > 3 {
                    Button("See all \(attention.count)") { router.activityFilter = "all"; router.tab = .activity }
                        .font(.callout.weight(.semibold))
                        .accessibilityIdentifier("feed-attention-all")
                }
            }
        }
    }

    // MARK: What Keir did

    private var whatKeirDid: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "What Keir did", count: feed.isEmpty ? nil : feed.count)
            if feed.isEmpty {
                Text("Keir writes the morning brief, wins and warnings here.")
                    .font(.callout).foregroundStyle(OpsTheme.muted).padding(.vertical, 6)
            }
            ForEach(feed.prefix(6), id: \.["id"].string) { entry in
                FeedEntry(entry: entry)
                Hairline()
            }
            FeedActivityChart(hub: ops.hub)
        }
    }

    // MARK: What is next

    @ViewBuilder private var whatsNext: some View {
        if !upcoming.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    SectionLabel(text: "What is next")
                    NavigationLink("All") { UpcomingView() }.font(.caption.weight(.semibold))
                }
                ForEach(Array(upcoming.prefix(4).enumerated()), id: \.offset) { _, item in
                    UpcomingRow(item: item)
                    Hairline()
                }
            }
        }
    }

    // MARK: Ideas

    @ViewBuilder private var ideasSection: some View {
        if !ideas.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Ideas for you", count: ideas.count)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(ideas.prefix(8), id: \.["id"].string) { idea in
                            IdeaCard(idea: idea) { await load() }
                        }
                    }
                    .padding(.vertical, 2)
                }
                NavigationLink("All ideas") { IdeasView() }.font(.caption.weight(.semibold))
            }
        }
    }

    private func load() async {
        async let f = try? session.get("/api/keir/app/feed")
        async let i = try? session.get("/api/keir/app/ideas")
        async let u = try? session.get("/api/keir/app/upcoming")
        let (fv, iv, uv) = await (f, i, u)
        if let fv { feed = fv["feed"].array.filter { $0["kind"].string != "suppressed" } }
        if let iv { ideas = iv["ideas"].array.filter { !$0["accepted"].bool } }
        if let uv { upcoming = uv["upcoming"].array }
        error = fv == nil ? "The briefing could not refresh." : nil
    }

    private func brief() {
        briefing = true
        Task {
            do {
                _ = try await session.post("/api/keir/app/feed/brief", [:])
                error = "Keir is checking trends and preparing your next steps. The brief will appear here."
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch { self.error = error.displayMessage }
            briefing = false
        }
    }
}

private struct FeedEntry: View {
    let entry: JSONValue
    private var icon: (String, Color) {
        switch entry["kind"].string {
        case "brief": return ("sun.max.fill", OpsTheme.sky)
        case "win": return ("checkmark.seal.fill", OpsTheme.mint)
        case "warning": return ("exclamationmark.triangle.fill", OpsTheme.warn)
        case "goal": return ("flag.fill", OpsTheme.sky)
        case "insight": return ("lightbulb.fill", OpsTheme.sky)
        default: return ("circle.fill", OpsTheme.muted)
        }
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon.0).font(.callout).foregroundStyle(icon.1).frame(width: 22).padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(OpsText.scrub(entry["title"].string)).font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if !entry["body"].string.isEmpty {
                    NativeMarkdown(text: entry["body"].string).font(.callout)
                        .foregroundStyle(entry["kind"].string == "brief" ? OpsTheme.ink : OpsTheme.muted)
                }
                ForEach(Array(entry["links"].array.enumerated()), id: \.offset) { _, link in
                    if let url = URL(string: link["url"].string) {
                        Link(link["title"].string.nonempty ?? link["url"].string, destination: url).font(.caption.weight(.semibold))
                    }
                }
                Text(OpsFormat.ago(entry["at"])).font(.caption).foregroundStyle(OpsTheme.muted)
            }
        }.padding(.vertical, 10).accessibilityElement(children: .combine)
    }
}

/// A card sized by its content, not clipped to a fixed height. The reason line
/// is the first sentence so a long evidence paragraph never becomes a stub.
struct IdeaCard: View {
    @EnvironmentObject private var session: AppSession
    let idea: JSONValue
    let changed: () async -> Void
    @State private var busy = false
    @State private var outcome: String?

    private var reason: String {
        OpsText.firstSentence(idea["reason"].string.nonempty ?? idea["evidence"].string)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: idea["kind"].string == "issue" ? "exclamationmark.circle" : "lightbulb")
                    .foregroundStyle(OpsTheme.sky)
                Text(idea["kind"].string == "issue" ? "Problem" : "Idea")
                    .font(.caption2.weight(.semibold)).foregroundStyle(OpsTheme.muted)
            }
            Text(OpsText.scrub(idea["title"].string)).font(.callout.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if !reason.isEmpty {
                Label(reason, systemImage: "info.circle")
                    .font(.caption).foregroundStyle(OpsTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            if let outcome {
                Text(outcome).font(.caption).foregroundStyle(OpsTheme.muted)
            } else {
                HStack(spacing: 12) {
                    Button("Start") { decide("accept") }
                        .fontWeight(.semibold).foregroundStyle(OpsTheme.sky)
                    Button("Dismiss") { decide("dismiss") }
                        .foregroundStyle(OpsTheme.muted)
                    Spacer()
                }
                .buttonStyle(.plain).disabled(busy)
            }
        }
        .padding(14)
        .frame(width: 260, alignment: .topLeading)
        .background(OpsTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(OpsTheme.hairline))
        .accessibilityElement(children: .contain)
    }

    private func decide(_ verdict: String) {
        busy = true
        Task {
            _ = try? await session.post("/api/keir/app/ideas/\(idea["id"].string)", ["verdict": .string(verdict)])
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            outcome = verdict == "accept" ? "Keir is on it" : "Dismissed"
            await changed(); busy = false
        }
    }
}
