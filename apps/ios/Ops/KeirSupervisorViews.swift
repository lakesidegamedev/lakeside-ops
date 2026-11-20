import SwiftUI
import LakesideCore

// What the private supervisor adds to the shared chat timeline. The chat
// itself (bubbles, composer, theme) is the normal Keir shell; these are the
// inline objects that only exist here: a publish proposal to decide on, the
// job that is running, and a plain state when the server has no supervisor.

/// Everything inline that belongs to the private conversation, after the messages.
struct KeirSupervisorTimeline: View {
    @EnvironmentObject private var session: AppSession
    @ObservedObject var keir: KeirStore

    var body: some View {
        if let setup = keir.supervisor.setup {
            KeirSupervisorNotice(setup: setup) { keir.select("main") }
        }
        ForEach(keir.supervisor.pending) { proposal in
            KeirProposalCard(proposal: proposal,
                             deciding: keir.supervisor.deciding == proposal.id,
                             locked: keir.supervisor.deciding != nil,
                             note: keir.supervisor.decisionNotes[proposal.id]) { approve in
                Task { await keir.decide(proposal, approve: approve, session) }
            }
        }
        ForEach(keir.supervisor.decided) { KeirProposalResult(proposal: $0) }
        ForEach(keir.live, id: \.["id"].string) { job in
            KeirSupervisorJobCard(job: job, stopping: keir.supervisor.stopping) {
                Task { await keir.cancelSupervisorJob(job["id"].string, session) }
            }
        }
    }
}

/// A publish request frozen to one exact patch. Approve and Decline are the
/// only ways to answer: typing "yes" in the chat never approves anything. The
/// digest shown is the one sent back, so the tap is bound to this patch.
struct KeirProposalCard: View {
    let proposal: KeirProposal
    let deciding: Bool
    let locked: Bool
    let note: String?
    let decide: (Bool) -> Void

    private var shownFiles: [String] { Array(proposal.files.prefix(6)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                OpsStatusBadge(status: .waiting, label: "Publish approval")
                Spacer()
                Text(OpsFormat.ago(proposal.createdAt)).font(.caption).foregroundStyle(OpsTheme.muted)
            }
            Text(proposal.title.isEmpty ? "Publish these changes" : proposal.title)
                .font(.headline).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                Text(proposal.summary).font(.callout.weight(.semibold))
                ForEach(shownFiles, id: \.self) { file in
                    Text(file).font(.caption.monospaced()).foregroundStyle(OpsTheme.muted).lineLimit(1).truncationMode(.middle)
                }
                if proposal.files.count > shownFiles.count {
                    Text("and \(proposal.files.count - shownFiles.count) more").font(.caption).foregroundStyle(OpsTheme.muted)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("supervisor-proposal-files")
            if !proposal.tests.isEmpty {
                Label(proposal.tests, systemImage: "checkmark.seal").font(.caption).foregroundStyle(OpsTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Text("Exact patch").font(.caption).foregroundStyle(OpsTheme.muted)
                Text(proposal.digestPrefix).font(.caption.monospaced()).textSelection(.enabled)
                    .accessibilityIdentifier("supervisor-proposal-digest")
            }
            Text("Approving publishes exactly this patch as a pull request. Replying in the chat does not approve it.")
                .font(.caption).foregroundStyle(OpsTheme.muted).fixedSize(horizontal: false, vertical: true)
            if let note { Text(note).font(.caption).foregroundStyle(OpsTheme.warn).fixedSize(horizontal: false, vertical: true) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
            }
            .buttonStyle(.plain)
            .disabled(locked || !proposal.canDecide)
        }
        .keirObjectCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("supervisor-proposal")
    }

    @ViewBuilder private var buttons: some View {
        Button { decide(false) } label: {
            Text("Decline").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                .background(OpsTheme.raised, in: Capsule())
        }
        .accessibilityIdentifier("supervisor-proposal-reject")
        Button { decide(true) } label: {
            HStack(spacing: 6) {
                if deciding { ProgressView().controlSize(.small) }
                Text("Approve and publish").fontWeight(.semibold).lineLimit(2).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 8)
            .background(proposal.canDecide ? OpsTheme.sky : OpsTheme.raised, in: Capsule())
            .foregroundStyle(proposal.canDecide ? OpsTheme.onAccent : OpsTheme.muted)
        }
        .accessibilityIdentifier("supervisor-proposal-approve")
        .accessibilityHint("Publishes the patch with digest starting \(proposal.digestPrefix)")
    }
}

/// A decided proposal, kept quiet: where it went, or that it was declined.
struct KeirProposalResult: View {
    let proposal: KeirProposal
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: proposal.state == "published" ? "arrow.triangle.pull" : "xmark.circle").foregroundStyle(OpsTheme.muted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(proposal.state == "published" ? "Published: \(proposal.title)" : "Declined: \(proposal.title)")
                    .font(.caption.weight(.semibold)).foregroundStyle(OpsTheme.ink).lineLimit(2)
                if proposal.state == "published", let link = proposal.prURL {
                    Link("Open the pull request", destination: link).font(.caption)
                } else if proposal.state == "published", !proposal.branch.isEmpty {
                    Text("Branch \(proposal.branch)").font(.caption.monospaced()).foregroundStyle(OpsTheme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("supervisor-proposal-result")
    }
}

/// The job that is queued or running, with the one thing the owner can do to it.
struct KeirSupervisorJobCard: View {
    let job: JSONValue
    let stopping: Bool
    let stop: () -> Void
    private var queued: Bool { job["state"].string == "queued" }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "gearshape.2")
                .font(.callout).foregroundStyle(OpsTheme.mint)
                .frame(width: 34, height: 34)
                .background(OpsTheme.mint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(job["title"].string.nonempty ?? "Working on your request").font(.callout.weight(.semibold)).lineLimit(2)
                if queued { Text("Waiting to start").font(.caption).foregroundStyle(OpsTheme.muted) }
                else { LoadingShimmer(text: (job["attempts"].number ?? 1) > 1 ? "Working, attempt \(Int(job["attempts"].number ?? 1))" : "Working").font(.caption) }
            }
            Spacer(minLength: 8)
            Button(action: stop) {
                Text("Stop").font(.callout.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: 44)
                    .background(OpsTheme.raised, in: Capsule())
            }
            .buttonStyle(.plain).disabled(stopping)
            .accessibilityHint("Stops this job. The workspace and its changes are kept.")
            .accessibilityIdentifier("supervisor-stop-job")
        }
        .keirObjectCard(padding: 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("supervisor-job")
    }
}

/// The server has no usable supervisor for this account. A state, not an
/// outage: the server is reachable and the support desk is one tap away.
struct KeirSupervisorNotice: View {
    let setup: KeirSupervisor.Setup
    let openSupport: () -> Void
    var body: some View {
        VStack(spacing: 12) {
            Text(setup.message).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                .accessibilityIdentifier("supervisor-setup-state")
            Text("Nothing you type here is sent anywhere. You can still talk to the support desk.")
                .font(.callout).foregroundStyle(OpsTheme.muted).multilineTextAlignment(.center)
            Button(action: openSupport) {
                Text("Open support desk").font(.callout.weight(.semibold)).padding(.horizontal, 18).frame(minHeight: 44)
                    .background(KeirChatTheme.chrome, in: Capsule())
                    .overlay(Capsule().strokeBorder(KeirChatTheme.stroke))
            }
            .buttonStyle(.plain).foregroundStyle(OpsTheme.ink)
            .accessibilityIdentifier("supervisor-open-support")
        }
        .frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.top, 48)
    }
}

/// The composer's "+" in the private conversation. The support menu offers
/// attachments, ticket drafts, routing and a model picker, none of which the
/// supervisor accepts. What is relevant here is stopping the running job and
/// getting to the support desk on purpose.
struct KeirSupervisorPlusMenu: View {
    @ObservedObject var keir: KeirStore
    let stop: () -> Void

    var body: some View {
        Menu {
            if keir.supervisorLiveJob != nil {
                Section {
                    Button(role: .destructive, action: stop) { Label("Stop current job", systemImage: "stop.circle") }
                        .disabled(keir.supervisor.stopping)
                }
            }
            Section {
                Button { keir.select("main") } label: { Label("Open support desk", systemImage: "lifepreserver") }
            }
        } label: { KeirComposerIcon(system: "plus") }
            .accessibilityLabel("More for your private conversation")
            .accessibilityHint("Stop the running job or open the support desk")
            .accessibilityIdentifier("supervisor-plus")
    }
}

/// A notification can outlive its proposal. Always fetch the exact record
/// before displaying the authenticated decision controls.
struct KeirNotifiedProposal: View {
    let id: String
    @ObservedObject var keir: KeirStore
    @EnvironmentObject private var session: AppSession
    @State private var selected: KeirProposal?
    @State private var issue: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let selected {
                    if selected.isPending {
                        KeirProposalCard(proposal: selected, deciding: keir.supervisor.deciding == id,
                                         locked: keir.supervisor.deciding != nil, note: keir.supervisor.decisionNotes[id]) { approve in
                            Task {
                                await keir.decide(selected, approve: approve, session)
                                await load()
                            }
                        }
                    } else {
                        KeirProposalResult(proposal: selected)
                    }
                } else if let issue {
                    Text(issue)
                    Button("Check again") { Task { await load() } }
                } else { ProgressView() }
            }.padding()
        }.navigationTitle("Keir approval")
        .task(id: id) { await load() }
    }

    private func load() async {
        do {
            let result = try await session.get("/api/keir/supervisor/proposals")
            guard !Task.isCancelled else { return }
            selected = result["proposals"].array.compactMap(KeirProposal.init).first { $0.id == id }
            if let selected, keir.isSupervisor { keir.supervisor.replace(selected) }
            issue = selected == nil ? "This approval is no longer available." : nil
        } catch {
            guard !Task.isCancelled else { return }
            selected = nil
            issue = error.displayMessage
        }
    }
}
