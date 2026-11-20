import SwiftUI
import WebKit

struct SessionGate<Content: View>: View {
    @ObservedObject var session: AppSession
    @ViewBuilder var content: () -> Content
    @State private var login = false
    var body: some View {
        Group {
            if session.checking { ProgressView("Connecting…") }
            else if session.signedIn { content().environmentObject(session) }
            else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        BrandHero(surface: session.surface)
                        if let error = session.error { FailureBanner(message: error) }
                        Button { login = true } label: {
                            HStack { Text(session.surface == .ops ? "Sign in to Keir" : "Sign in to Lakeside").fontWeight(.semibold); Spacer(); Image(systemName: "arrow.right") }
                                .padding(18).foregroundStyle(Brand.onAccent).background(Brand.sky, in: RoundedRectangle(cornerRadius: 16))
                        }.accessibilityIdentifier("sign-in")
                        VStack(alignment: .leading, spacing: 14) {
                            Label(session.surface == .ask ? "Answers grounded in live code" : session.surface == .hub ? "One assistant, persistent memory" : "A conversation with Keir", systemImage: session.surface == .ask ? "curlybraces" : "waveform.path.ecg")
                            Label(session.surface == .ask ? "Citations you can follow" : "Tickets, decisions and work in one inbox", systemImage: session.surface == .ask ? "doc.text" : "terminal")
                            Label(session.surface == .ask ? "Your game's current state" : "Studio operations, wherever you are", systemImage: session.surface == .ask ? "bolt" : "folder")
                        }.font(.callout).foregroundStyle(.secondary)
                        Text(session.surface == .ops && session.surface.host != "ops.lakesidegames.net" ? "Use the owner account for your Keir installation." : "Use your existing Lakeside account.").font(.footnote).foregroundStyle(.secondary)
                    }.padding(28).padding(.top, 28).frame(maxWidth: 560)
                        .frame(maxWidth: .infinity)
                }.lakesideScreen()

            }
        }
        .task { await session.restore() }
        .sheet(isPresented: $login) {
            NavigationStack {
                LoginBrowser(session: session) { login = false }
                    .navigationTitle("Sign in").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { login = false } } }
            }
        }
    }
}

/// WebKit is used only for the existing first-party login, never for app content.
private struct LoginBrowser: UIViewRepresentable {
    let session: AppSession
    let done: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(session: session, done: done) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        configuration.websiteDataStore.httpCookieStore.add(context.coordinator)
        context.coordinator.store = configuration.websiteDataStore.httpCookieStore
        web.load(URLRequest(url: session.surface.base.appendingPathComponent(session.surface.login)))
        return web
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading(); coordinator.active = false; coordinator.signInTask?.cancel(); coordinator.store?.remove(coordinator)
    }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKHTTPCookieStoreObserver {
        let session: AppSession
        let done: () -> Void
        var store: WKHTTPCookieStore?
        var accepting = false
        var active = true
        var signInTask: Task<Void, Never>?
        init(session: AppSession, done: @escaping () -> Void) { self.session = session; self.done = done }
        func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
            guard active, !accepting else { return }
            cookieStore.getAllCookies { [weak self] cookies in
                guard let self, self.active, !self.accepting else { return }
                guard let cookie = self.session.surface.cookies.compactMap({ name in
                    cookies.first(where: { $0.name == name && !$0.value.isEmpty })
                }).first else { return }
                self.accepting = true
                self.signInTask = Task { @MainActor in
                    do { try await self.session.accept(cookie); if self.active { self.done() } }
                    catch { if !Task.isCancelled { self.session.error = error.localizedDescription }; self.accepting = false; if self.active { self.done() } }
                }
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { cookiesDidChange(in: webView.configuration.websiteDataStore.httpCookieStore) }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.scheme == "https" ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { session.error = error.localizedDescription; done() }
        }
    }
}
