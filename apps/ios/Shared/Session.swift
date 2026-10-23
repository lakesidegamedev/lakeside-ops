import Foundation
import Security
import SwiftUI
import LakesideCore

enum Surface {
    case ask, ops, hub
    var title: String { self == .ask ? "Lakeside Ask" : "Lakeside Ops" }
    var host: String { base.host ?? "invalid.invalid" }
    /// Endpoint.url rejects anything that is not https, so the unreachable
    /// fallback fails closed instead of crashing.
    var base: URL {
        let fallback = self == .ask ? "https://ask.lakesidegames.net" : self == .hub ? "https://hub.lakesidegames.net" : "https://ops.lakesidegames.net"
        let configured = self == .ops ? Bundle.main.object(forInfoDictionaryKey: "LakesideOpsServerURL") as? String : nil
        return (try? ServerOrigin.url(configured ?? fallback)) ?? URL(fileURLWithPath: "/")
    }
    var cookie: String { self == .ask ? "__Host-ask_session" : self == .hub ? "agency_session" : "ops_session" }
    var cookies: [String] { self == .ask ? ["__Host-lakeside_session", cookie] : [cookie] }
    var login: String { self == .ask ? "/auth/login" : self == .hub ? "/auth/game" : "/" }
    var symbol: String { self == .ask ? "bubble.left.and.text.bubble.right.fill" : "waveform.path.ecg" }
}

struct AppFailure: LocalizedError {
    let message: String
    var statusCode: Int? = nil
    var kind: FailureKind? = nil
    var errorDescription: String? { message }
}

extension Error {
    /// What went wrong, including transport failures that stay URLError so
    /// callers can keep their own retry rules.
    var failureKind: FailureKind? {
        if let failure = self as? AppFailure { return failure.kind ?? failure.statusCode.map { FailureKind.classify(status: $0, payload: .null) } }
        guard let url = self as? URLError else { return nil }
        switch url.code {
        case .cancelled: return nil
        case .badServerResponse, .cannotParseResponse, .cannotDecodeContentData, .cannotDecodeRawData: return .unexpectedResponse
        case .userAuthenticationRequired: return .signedOut
        default: return .network
        }
    }
    /// A truthful message: transport failures read as connection problems,
    /// not as a sign-in or server fault.
    var displayMessage: String {
        if let failure = self as? AppFailure { return failure.message }
        if self is DecodingError { return FailureKind.unexpectedResponse.defaultMessage }
        if let kind = failureKind { return kind.defaultMessage }
        return localizedDescription
    }
}

private struct Credential: Codable {
    let name: String?
    let value: String
    let expires: Date?
}

private enum Vault {
    static func query(_ surface: Surface) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: Bundle.main.bundleIdentifier ?? "Lakeside", kSecAttrAccount as String: surface == .hub ? "session.hub" : surface == .ops && surface.base.absoluteString != "https://ops.lakesidegames.net" ? "session.\(surface.base.absoluteString)" : "session"] }
    static func read(_ surface: Surface) -> Data? {
        var q = query(surface); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }
    static func write(_ data: Data, surface: Surface) throws {
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query(surface) as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let added = SecItemAdd(query(surface).merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw AppFailure(message: "Could not securely save your sign-in (\(added)).") }
        } else if updated != errSecSuccess { throw AppFailure(message: "Could not securely save your sign-in (\(updated)).") }
    }
    static func clear(_ surface: Surface) { SecItemDelete(query(surface) as CFDictionary) }
}

/// API calls never forward the session cookie through a redirect.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor final class AppSession: ObservableObject {
    let surface: Surface
    @Published var signedIn = false
    @Published var checking = true
    @Published var error: String?
    @Published var profile: JSONValue = .null
    private var credential: Credential?
    private var nativeExchangeAt: Date?
    private let transport: URLSession

    init(_ surface: Surface, configuration: URLSessionConfiguration? = nil) {
        self.surface = surface
        let config = configuration ?? URLSessionConfiguration.ephemeral
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--uitest-fixtures") { config.protocolClasses = [FixtureProtocol.self] }
#endif
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 90; config.timeoutIntervalForResource = 900
        transport = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--uitest-fixtures") {
            credential = Credential(name: nil, value: "ui-test-session", expires: nil)
            return
        }
#endif
        if let data = Vault.read(surface), let saved = try? JSONDecoder().decode(Credential.self, from: data),
           saved.expires.map({ $0 > Date() }) ?? true { credential = saved }
    }
    func restore() async {
        defer { checking = false }
        guard credential != nil else { return }
        do { profile = try await get("/api/me"); signedIn = true }
        catch {
            // A saved session remains usable while the network is down. Only
            // the canonical identity endpoint can confirm that it was revoked.
            if error.failureKind != .signedOut && credential != nil { signedIn = true }
            self.error = error.displayMessage
        }
    }
    func accept(_ cookie: HTTPCookie) async throws {
        // Ops currently omits the Secure attribute. Its cookie is still sent only
        // to the pinned HTTPS API origin; redirects never forward credentials.
        guard surface.cookies.contains(cookie.name), !cookie.value.isEmpty, (surface == .ops || cookie.isSecure),
              cookie.expiresDate.map({ $0 > Date() }) ?? true else { throw AppFailure(message: "Sign-in did not return a valid session.") }
        let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
        guard domain == surface.host || (domain == "lakesidegames.net" && surface.host.hasSuffix(".lakesidegames.net")) else { throw AppFailure(message: "Unexpected sign-in domain.") }
        credential = Credential(name: cookie.name, value: cookie.value, expires: cookie.expiresDate)
        do {
            let me = try await get("/api/me")
            try Task.checkCancellation()
            guard let credential else { throw AppFailure(message: "Sign-in did not return a valid session.", kind: .signedOut) }
            try Vault.write(JSONEncoder().encode(credential), surface: surface)
            if surface == .ops { await upgradeNativeSession() }
            if surface == .ops { OpsServices.shared.reset() }
            profile = me; error = nil; signedIn = true
        } catch { credential = nil; throw error }
    }
    func updateUsage(_ usage: JSONValue) {
        guard !usage.object.isEmpty else { return }
        var fields = profile.object; fields["usage"] = usage; profile = .object(fields)
    }
    func refreshProfile() async {
        do { profile = try await get("/api/me"); error = nil; if surface == .ops { await upgradeNativeSession() } }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func upgradeNativeSession() async {
        guard surface == .ops, let saved = credential,
              saved.expires.map({ $0.timeIntervalSinceNow < 2 * 86400 }) ?? true,
              nativeExchangeAt.map({ Date().timeIntervalSince($0) > 1800 }) ?? true else { return }
        nativeExchangeAt = Date()
        do {
            let response = try await post("/api/auth/native-session", [:])
            let token = response["token"].string
            guard token.count == 64, token.allSatisfy({ $0.isHexDigit }),
                  let expires = response["expiresAt"].number,
                  expires / 1000 > Date().timeIntervalSince1970 else { return }
            let replacement = Credential(name: surface.cookie, value: token, expires: Date(timeIntervalSince1970: expires / 1000))
            try Vault.write(JSONEncoder().encode(replacement), surface: surface)
            credential = replacement
        } catch {
            // Older servers do not have the exchange. Keep the valid web login
            // and try again later; service errors must not discard credentials.
        }
    }
    func signOut() async {
        if surface == .ops { await KeirLiveActivity.shared.endAll(session: self) }
        if surface == .hub { _ = try? await post("/logout", [:]) }
        else if surface == .ops { _ = try? await post("/api/logout", [:]) }
        else { _ = try? await post("/auth/logout", [:]) }
        credential = nil; Vault.clear(surface); profile = .null; signedIn = false; error = nil
        if surface == .ops { OpsServices.shared.reset() }
    }
    private func request(_ path: String, query: [String: String] = [:], body: [String: JSONValue]? = nil) throws -> URLRequest {
        var r = URLRequest(url: try Endpoint.url(base: surface.base, path: path, query: query))
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if path.hasPrefix("/api/kanban/") || path.hasPrefix("/api/events/dead-letters/") { r.setValue("ops-dashboard", forHTTPHeaderField: "X-Requested-With") }
        if surface == .ops { r.setValue("ios", forHTTPHeaderField: "X-Lakeside-Client") }
        r.setValue(surface.base.absoluteString, forHTTPHeaderField: "Origin")
        r.setValue(surface.base.absoluteString + "/", forHTTPHeaderField: "Referer")
        if let credential {
            guard !credential.value.contains("\r"), !credential.value.contains("\n"), !credential.value.contains(";") else { throw URLError(.userAuthenticationRequired) }
            let cookieName = credential.name ?? surface.cookie
            guard surface.cookies.contains(cookieName) else { throw URLError(.userAuthenticationRequired) }
            r.setValue("\(cookieName)=\(credential.value)", forHTTPHeaderField: "Cookie")
        }
        if let body { r.httpMethod = "POST"; r.httpBody = try JSONEncoder().encode(JSONValue.object(body)); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return r
    }
    private func validate(_ response: URLResponse, data: Data? = nil) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 {
            guard http.url?.path == "/api/me" else {
                throw AppFailure(message: "This service could not verify your session. Retrying the connection.", statusCode: 503, kind: .network)
            }
            credential = nil; Vault.clear(surface); signedIn = false; profile = .null
            if surface == .ops { OpsServices.shared.reset() }
            throw AppFailure(message: FailureKind.signedOut.defaultMessage, statusCode: 401, kind: .signedOut)
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
            updateUsage(payload["usage"])
            let kind = FailureKind.classify(status: http.statusCode, payload: payload)
            let message = payload["error"].string.trimmingCharacters(in: .whitespacesAndNewlines)
            throw AppFailure(message: message.isEmpty ? kind.defaultMessage : message, statusCode: http.statusCode, kind: kind)
        }
    }
    func get(_ path: String, query: [String: String] = [:]) async throws -> JSONValue {
        try await json(request(path, query: query))
    }
    func post(_ path: String, _ body: [String: JSONValue]) async throws -> JSONValue { try await json(request(path, body: body)) }
    func speechAudio(_ text: String) async throws -> Data {
        var r = try request("/api/keir/app/voice/speech", body: ["text": .string(text)])
        r.timeoutInterval = 20
        let owner = credential?.value
        let (data, response) = try await transport.data(for: r)
        guard credential?.value == owner else { throw CancellationError() }
        try validate(response, data: data)
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("audio/") == true else { throw URLError(.cannotDecodeContentData) }
        return data
    }
    func discardUpload(_ url: JSONValue, keir: Bool = false) async throws {
        if keir {
            guard url.string.hasPrefix("/api/keir/app/uploads/"), !url.string.contains("..") else { throw URLError(.badURL) }
            var r = try request(url.string); r.httpMethod = "DELETE"; _ = try await json(r); return
        }
        var r = try request(surface == .ask ? "/api/upload" : "/api/chat/upload", body: ["url": url])
        r.httpMethod = "DELETE"
        _ = try await json(r)
    }
    func upload(_ data: Data, name: String, mime: String, keirThread: String? = nil) async throws -> JSONValue {
        var r = try request(keirThread != nil ? "/api/keir/app/uploads" : surface == .ask ? "/api/upload" : "/api/chat/upload")
        if let keirThread { r.setValue(keirThread, forHTTPHeaderField: "X-Keir-Thread") }
        r.httpMethod = "POST"; r.httpBody = data
        r.setValue(mime, forHTTPHeaderField: "Content-Type")
        r.setValue(name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed), forHTTPHeaderField: "X-Filename")
        return try await json(r)
    }
    private func json(_ request: URLRequest) async throws -> JSONValue {
        let owner = credential?.value
        let (data, response) = try await transport.data(for: request)
        guard credential?.value == owner else { throw CancellationError() }
        try validate(response, data: data)
        return try decodeJSON(data, response: response)
    }
    private func decodeJSON(_ data: Data, response: URLResponse) throws -> JSONValue {
        let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? response.mimeType
        guard MediaType.isJSON(type) || MediaType.isJSON(response.mimeType) else {
            let message = MediaType.isHTML(type)
                ? "The server returned a web page instead of data. Try again; if it continues, sign out and sign in again."
                : FailureKind.unexpectedResponse.defaultMessage
            throw AppFailure(message: message, kind: .unexpectedResponse)
        }
        do { return try JSONDecoder().decode(JSONValue.self, from: data) }
        catch { throw AppFailure(message: FailureKind.unexpectedResponse.defaultMessage, kind: .unexpectedResponse) }
    }
    /// Raw bytes from the pinned origin, for images such as Keir's charts.
    func data(_ path: String, accept: String = "image/png", limit: Int = 8_000_000) async throws -> Data {
        var r = try request(path); r.setValue(accept, forHTTPHeaderField: "Accept")
        let owner = credential?.value
        let (data, response) = try await transport.data(for: r)
        guard credential?.value == owner else { throw CancellationError() }
        try validate(response, data: data)
        guard response.mimeType == accept, data.count <= limit else { throw AppFailure(message: "The image could not be loaded.") }
        return data
    }
    func renderMap(_ specification: JSONValue) async throws -> Data {
        var r = try request("/api/map/render", body: specification.object)
        r.setValue("image/svg+xml", forHTTPHeaderField: "Accept")
        let owner = credential?.value
        let (data, response) = try await transport.data(for: r)
        guard credential?.value == owner else { throw CancellationError() }
        try validate(response, data: data)
        guard response.mimeType == "image/svg+xml", data.count <= 5_000_000 else { throw AppFailure(message: "The map could not be loaded.") }
        return data
    }
    func events(_ path: String, query: [String: String] = [:], onEvent: (SSEEvent) async throws -> Void) async throws {
        var r = try request(path, query: query)
        r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let owner = credential?.value
        let (bytes, response) = try await transport.bytes(for: r)
        defer { bytes.task.cancel() }
        guard credential?.value == owner else { throw CancellationError() }
        try validate(response)
        guard response.mimeType == "text/event-stream" else { throw AppFailure(message: "Live updates are unavailable.") }
        var parser = SSEParser()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard credential?.value == owner else { throw CancellationError() }
            if let event = try parser.feed(byte) {
                try await onEvent(event)
                if event.name == "final" || event.name == "resync" { return }
            }
        }
    }
    func stream(_ body: [String: JSONValue], onEvent: (SSEEvent) throws -> Void) async throws {
        var r = try request("/api/ask", body: body); r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let owner = credential?.value
        let (bytes, response) = try await transport.bytes(for: r)
        defer { bytes.task.cancel() }
        let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? response.mimeType
        if (response as? HTTPURLResponse)?.statusCode != 200 || !MediaType.isEventStream(type) {
            var data = Data()
            for try await byte in bytes { data.append(byte); if data.count > 4 * 1024 * 1024 { break } }
            guard credential?.value == owner else { throw CancellationError() }
            try validate(response, data: data)
            // Cached answers arrive as one JSON object with the `done` fields. A
            // Stop that reached the server before generation began returns
            // `{ "stopped": true }`.
            let answer = try decodeJSON(data, response: response)
            let text = String(decoding: data, as: UTF8.self)
            if answer["stopped"].bool { try onEvent(SSEEvent(name: "stopped", data: text)); return }
            guard !answer["answer"].string.isEmpty else { throw AppFailure(message: "The server did not start an answer.", kind: .unexpectedResponse) }
            try onEvent(SSEEvent(name: "done", data: text))
            return
        }
        var parser = SSEParser()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard credential?.value == owner else { throw CancellationError() }
            if let event = try parser.feed(byte) {
                try onEvent(event)
                if event.name == "done" { return }
            }
        }
        throw AppFailure(message: "The connection ended before the answer finished. Reload the conversation to check whether it was saved.", kind: .network)
    }
}
