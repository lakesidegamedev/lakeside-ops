#if DEBUG
import Foundation

/// Isolated UI-test transport. It never contacts a server and is absent in Release.
final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    private final class RoutingState: @unchecked Sendable {
        let lock = NSLock()
        var selection: [String: Any] = ["provider": "auto", "model": NSNull(), "effort": "auto", "allowFallback": true]
        func access(_ update: [String: Any]? = nil) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            if let update { selection = update }
            return selection
        }
    }
    private static let routing = RoutingState()
    private final class CompanyState: @unchecked Sendable {
        let lock = NSLock()
        var jobs: [[String: Any]] = [["id": "job-1", "title": "Fix export failures", "objective": "Make exports reliable for every project.", "status": "detected", "column": "todo", "board_rank": 100, "entity_id": "project-1", "staff_id": "staff-1", "version": 1, "task_type": "bugfix", "artifact": "fixture-commit-abc", "acceptance": ["Empty exports complete successfully"], "contract": ["investigate": true, "draft": true, "change": false, "merge": false, "deploy": false, "communicate": false], "conversation_id": 1]]
        var checks: [[String: Any]] = []
        var requests: Set<String> = []
        func route(_ path: String, method: String, body: [String: Any]) -> (Any, Int) {
            lock.lock(); defer { lock.unlock() }
            let project: [String: Any] = ["id": "project-1", "kind": "product", "title": "Studio hub", "summary": "Studio tools", "source": "UI fixture"]
            if path == "/api/ops/company" { return (["missions": jobs, "boardColumns": [["id": "todo", "title": "To do"], ["id": "doing", "title": "In progress"], ["id": "review", "title": "Needs review"], ["id": "ready", "title": "Ready to ship"], ["id": "watching", "title": "Watching"], ["id": "done", "title": "Done"]], "entities": [project], "links": [], "counts": ["active": jobs.count, "needsOwner": 1, "monitoring": 0, "verified": 0], "automation": ["enabled": false, "description": "External sources are not connected."]], 200) }
            if path == "/api/ops/company/sync" { return (["imported": 1], 200) }
            if path == "/api/ops/company/signals" {
                guard let key = body["requestId"] as? String, let title = body["title"] as? String else { return (["error": "Missing work request"], 400) }
                if requests.contains(key) { return (["mission": jobs.last ?? [:], "duplicate": true], 200) }
                var job = jobs[0]; job["id"] = "job-\(jobs.count + 1)"; job["title"] = title; job["objective"] = body["objective"]; job["acceptance"] = body["acceptance"]; job["status"] = "detected"; job["version"] = 1
                jobs.append(job); requests.insert(key)
                return (["mission": job, "duplicate": false], 200)
            }
            let pieces = path.split(separator: "/").map(String.init)
            guard pieces.count >= 5, let index = jobs.firstIndex(where: { $0["id"] as? String == pieces[4] }) else { return (["error": "Work not found"], 404) }
            if method == "GET" {
                return (["mission": jobs[index], "events": [["id": "event-1", "type": "detected", "detail": "Export failures reported by support.", "created_at": "2026-09-09T12:00:00Z"]], "evidence": checks, "assignments": [], "signal": ["summary": "Several projects could not export their files.", "source": "support", "observed_at": "2026-09-09T12:00:00Z"]], 200)
            }
            guard pieces.count == 6, body["version"] as? Int == jobs[index]["version"] as? Int else { return (["error": "This work changed. Reload before saving."], 409) }
            switch pieces[5] {
            case "move":
                guard let target = body["column"] as? String, ["todo", "doing", "review"].contains(target) else { return (["error": "Complete the required checks before moving here."], 409) }
                jobs[index]["column"] = target
                jobs[index]["status"] = target == "doing" ? "working" : target == "review" ? "awaiting_verification" : "detected"
            case "evidence":
                var check = body; check["id"] = "check-\(checks.count + 1)"; checks.append(check)
            case "verify": checks.append(["id": "github-check-1", "kind": "test", "summary": "GitHub checks passed for the recorded version.", "artifact": body["artifact"] ?? "", "passed": true, "source": "github"])
            case "contract": jobs[index]["contract"] = body["contract"]
            case "artifact": jobs[index]["artifact"] = body["artifact"]
            case "assign": jobs[index]["status"] = "investigating"
            case "approve": jobs[index]["status"] = "approved"
            case "monitor": jobs[index]["status"] = "monitoring"
            case "finish": jobs[index]["status"] = "verified"; jobs[index]["completion_mode"] = "reviewed"
            case "reopen": jobs[index]["status"] = "investigating"
            case "cancel": jobs[index]["status"] = "cancelled"
            default: return (["error": "Unknown action"], 404)
            }
            jobs[index]["version"] = (jobs[index]["version"] as? Int ?? 0) + 1
            return (["mission": jobs[index]], 200)
        }
    }
    private static let company = CompanyState()
    private final class WatchState: @unchecked Sendable {
        let lock = NSLock()
        var watches: [[String: Any]] = [
            ["id": 7, "kind": "fx", "label": "USD/GBP crosses above 1.30", "createdAt": 1788825600000, "lastFiredAt": NSNull()],
            ["id": 8, "kind": "war", "label": "new war activity involving FR", "createdAt": 1788825600000, "lastFiredAt": 1788912000000],
        ]
        func list() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return ["watches": watches, "limit": 5] }
        func delete(_ id: Any?) -> Bool {
            lock.lock(); defer { lock.unlock() }
            func normalized(_ value: Any?) -> String {
                if let number = value as? NSNumber { return String(number.int64Value) }
                return value.map { "\($0)" } ?? ""
            }
            let key = normalized(id)
            let before = watches.count
            watches.removeAll { normalized($0["id"]) == key }
            return watches.count < before
        }
    }
    private static let watchState = WatchState()
    private static let work = WorkFixture()
    private final class KeirState: @unchecked Sendable {
        let lock = NSLock()
        var messages: [[String: Any]] = [
            ["seq": 1, "id": "app-1", "role": "owner", "text": "How did the last turn go?", "at": 1792020000000],
            ["seq": 2, "id": "app-2", "role": "keir", "text": "Turn 202 ran clean in 41s. One warning: index fund settlement for one corporation, already tracked in an issue.", "at": 1792020060000]]
        var choiceState = "pending"
        var modelSelection = "auto"
        var stopped = false
        var yolo = false
        var updates = true
        var routes: [String: String] = [:]
        var controlValue: [String: Any] {
            let options: [[String: Any]] = [["id": "auto", "label": "Auto", "provider": "Keir routing"], ["id": "codex:fixture", "label": "Fixture model", "provider": "Codex", "effort": "low"], ["id": "claude:claude-opus-5-5", "label": "Opus 5.5", "provider": "Claude", "available": true], ["id": "claude:claude-sonnet-5-5", "label": "Sonnet 5.5", "provider": "Claude", "available": true], ["id": "ollama:deepseek-v4.1-flash", "label": "DeepSeek V4.1 Flash", "provider": "Ollama", "available": true]]
            return ["supported": !ProcessInfo.processInfo.arguments.contains("--uitest-legacy-model-picker"), "stopped": stopped, "updates": updates, "approvalMode": yolo ? "yolo" : "ask", "routes": routes, "skills": [:], "catalog": [["id": "systematic-debugging", "source": "fixture", "license": "MIT", "available": true, "defaults": ["worker", "investigator"]]], "options": Dictionary(uniqueKeysWithValues: ["conversation", "voice", "coding", "investigation", "coordination"].map { lane in (lane, options.map { route in
                var item = route
                if !["conversation", "voice"].contains(lane), item["provider"] as? String == "Ollama" { item["available"] = false; item["reason"] = "Unavailable for this role; use DeepSeek for conversation." }
                return item
            }) }), "defaults": ["conversation": "claude:fixture", "coding": "codex:fixture", "investigation": "codex:fixture", "coordination": "claude:fixture"]]
        }
        func controls(_ body: [String: Any]?) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            if let action = body?["action"] as? String {
                if action == "stop" { stopped = true }
                if action == "start" { stopped = false }
                if let mode = body?["approvalMode"] as? String { yolo = mode == "yolo" }
                if let on = body?["updates"] as? Bool { updates = on }
                if let selected = body?["routes"] as? [String: String] { routes.merge(selected) { _, new in new } }
            }
            return controlValue
        }
        var decisions: [[String: Any]] = [["id": "abcdefabcdef", "question": "Merge PR #201 into development? Checks are green.", "tldr": "Merge #201 to development", "at": 1792020000000, "ticket": NSNull(), "signoff": false]]
        func thread(after: Int) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            var view: [String: Any] = ["cursor": messages.count, "version": "v\(messages.count)-\(choiceState)", "messages": messages.filter { ($0["seq"] as? Int ?? 0) > after }, "tasks": [] as [Any], "working": false]
            if ProcessInfo.processInfo.arguments.contains("--uitest-rich-controls") {
                view["tasks"] = [["id": "abcdef012345", "title": "Investigate payroll", "state": "running"], ["id": "abcdef012346", "title": "Check technology upgrades", "state": "running"]]
                view["working"] = true
                view["questions"] = [["id": "123456abcdef", "title": "Payroll decision", "state": choiceState, "questions": [["id": "1", "prompt": "How should payroll work?", "options": [["id": "1", "label": "Use active capacity", "recommended": true], ["id": "2", "label": "Use filled jobs"]]]]]]
            }
            if ProcessInfo.processInfo.arguments.contains("--uitest-table") {
                view["messages"] = [["seq": 100, "id": "table-fixture", "role": "keir", "text": "| Ticket | Current position |\n| --- | --- |\n| Tech tree | Implementation is waiting on the assigned developer and needs a verified handoff before proceeding. |\n| Hardware profits | Verification is waiting for the next completed turn. |", "at": 1792020120000]]
            }
            if ProcessInfo.processInfo.arguments.contains("--uitest-dev-partner") {
                view["team"] = ["open": 4, "working": 2, "needsYou": 1, "stuck": 0, "waiting": 1, "held": 0, "items": [
                    ["id": "ticketjob001", "ticket": 1575, "link": "ticket", "title": "Factory demand refund", "state": "needs-you", "reason": "Refund the historical undercount?"],
                    ["id": "ticketjob002", "ticket": 1574, "link": "ticket", "title": "California steel sales", "state": "working", "reason": "Checking recovery after turn 230."],
                    ["id": "abcdef012345", "ticket": NSNull(), "link": "task", "title": "Audit CI back-merges", "state": "working", "reason": "Comparing zero-change runs."],
                    ["id": "finding00001", "ticket": NSNull(), "link": "activity", "title": "Turn warning: fund settlement", "state": "waiting", "reason": "Waiting for repository checks."]]]
                let update: [String: Any] = ["seq": 3, "id": "app-update-3", "role": "keir", "update": true, "thread": "main", "at": 1792020090000,
                    "text": "- Ticket 1575, Factory demand refund: needs your decision. Refund the historical undercount?\n- Ticket 1574, California steel sales: now tested on development.\n- Ticket 1564: opened PR #4299 in lakesidegamedev/AHDGame.",
                    "items": [["kind": "needs-you", "ticket": 1575, "link": "ticket", "text": "Ticket 1575, Factory demand refund: needs your decision. Refund the historical undercount?"],
                              ["kind": "stage", "ticket": 1574, "link": "ticket", "text": "Ticket 1574, California steel sales: now tested on development."],
                              ["kind": "pr", "ticket": 1564, "link": "ticket", "text": "Ticket 1564: opened PR #4299 in lakesidegamedev/AHDGame."]],
                    "cards": [["type": "pr", "repository": "lakesidegamedev/AHDGame", "number": 4299, "url": "https://github.com/lakesidegamedev/AHDGame/pull/4299"]]]
                if after < 3 { view["messages"] = (view["messages"] as? [[String: Any]] ?? []) + [update] }
                view["cursor"] = max(messages.count, 3)
            }
            if ProcessInfo.processInfo.arguments.contains("--uitest-broken-status") {
                view["team"] = ["open": 1, "working": 1, "needsYou": 0, "stuck": 0, "waiting": 0, "held": 0, "items": [
                    ["id": "brokenjob001", "ticket": 1651, "link": "ticket", "title": "", "state": "working", "reason": "It me or turn been stuck in processing: started."]]]
                let broken: [String: Any] = ["seq": 900, "id": "broken-update", "role": "keir", "update": true, "thread": "main", "at": 1792020090000,
                    "text": "It me or turn been stuck in processing: started.",
                    "items": [["kind": "started", "ticket": 1651, "link": "ticket", "text": "It me or turn been stuck in processing: started. Was:."]]]
                view["messages"] = [broken]
                view["cursor"] = 900
            }
            view["controls"] = controlValue
            return view
        }
        func post(_ text: String, attachments: [[String: Any]] = []) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            let owner: [String: Any] = ["seq": messages.count + 1, "id": "app-\(messages.count + 1)", "role": "owner", "text": text, "attachments": attachments, "at": 1792020100000]
            messages.append(owner)
            messages.append(["seq": messages.count + 1, "id": "app-\(messages.count + 1)", "role": "keir", "text": "Two PRs are waiting on you: #201 and #202.", "at": 1792020110000])
            return ["message": owner, "jobId": "job-1"]
        }
        func answerChoices() -> [String: Any] {
            lock.lock(); defer { lock.unlock() }; choiceState = "answered"
            messages.append(["seq": messages.count + 1, "id": "app-answer", "role": "owner", "text": "My answer: Use filled jobs", "at": 1792020120000])
            return ["answered": true]
        }
        func models(_ selected: String?) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            if let selected { modelSelection = selected }
            return ["selection": modelSelection, "models": [["id": "auto", "label": "Auto", "provider": "Keir routing"], ["id": "codex:fixture", "label": "Fixture model", "provider": "Codex"]]]
        }
        func answer(_ id: String) -> [String: Any] { lock.lock(); defer { lock.unlock() }; decisions.removeAll { $0["id"] as? String == id }; return ["id": id, "state": "approve"] }
        func open() -> [[String: Any]] {
            lock.lock(); defer { lock.unlock() }
            guard ProcessInfo.processInfo.arguments.contains("--uitest-action-scope") else { return decisions }
            return decisions.map { decision in
                var item = decision
                item["kind"] = "github"; item["jobId"] = "abcdef012345"
                item["scope"] = ["repository": "fixture/repository", "to": "development", "head": "fixture-exact-head"]
                item["args"] = ["number": 201, "action": "merge"]
                return item
            }
        }
    }
    private static let keir = KeirState()
    private final class ComputerState: @unchecked Sendable {
        let lock = NSLock()
        var uncertain = ProcessInfo.processInfo.arguments.contains("--uitest-computer-cancelled")
        let cancelled = ProcessInfo.processInfo.arguments.contains("--uitest-computer-cancelled")
        var refreshed = false
        var closed = false
        var inputs = 0
        var screen: String { refreshed ? "computer-fixture-after.png" : "computer-fixture-before.png" }
        func route(_ method: String, _ body: [String: Any]) -> (Any, Int) {
            lock.lock(); defer { lock.unlock() }
            if method == "POST" {
                guard let id = body["clientId"] as? String, UUID(uuidString: id) != nil, body["screen"] as? String == screen else { return (["error": "Browser input needs its client ID and current screen"], 400) }
                switch body["action"] as? String {
                case "key":
                    guard !uncertain else { return (["error": "Input outcome is uncertain"], 409) }
                    inputs += 1; uncertain = true
                    return (["error": "Screen capture failed after input. Inspect the result."], 503)
                case "look": refreshed = true
                case "acknowledge":
                    guard refreshed else { return (["error": "Inspect a fresh screen first"], 409) }
                    uncertain = false
                    if cancelled { closed = true }
                case "close":
                    guard !uncertain else { return (["error": "Input outcome is uncertain"], 409) }
                    closed = true
                case "discard":
                    guard cancelled, body["confirmDiscard"] as? Bool == true else { return (["error": "Confirm discarding the cancelled browser"], 409) }
                    closed = true
                default: return (["error": "Unexpected browser input"], 400)
                }
            }
            return (["taskId": "abcdef012345", "title": "Fixture browser", "file": screen, "width": 1280, "height": 800, "state": cancelled ? "cancelled" : "paused", "closed": closed, "retainedForInspection": cancelled && uncertain && !closed, "text": "Inputs sent: \(inputs)", "uncertainInputs": uncertain ? [["id": "computer-owner:fixture", "screen": "computer-fixture-before.png"]] : []], 200)
        }
    }
    private static let computer = ComputerState()

    private func bodyObject() -> [String: Any]? {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        if ProcessInfo.processInfo.arguments.contains("--uitest-keir-offline"), ["/api/keir/app/thread", "/api/keir/app/messages"].contains(url.path) {
            deliver(Data(#"{"error":"Keir backend is unavailable"}"#.utf8), url: url, status: 502, type: "application/json"); return
        }
        if ProcessInfo.processInfo.arguments.contains("--uitest-metrics-partial"), url.path == "/api/keir/hub" {
            deliver(Data(#"{"at":1792020000000,"kpis":{"activations24h":0}}"#.utf8), url: url, status: 200, type: "application/json"); return
        }
        if url.path == "/api/keir/app/uploads" {
            let value: [String: Any] = ["id": "012345678901234567890123456789ab", "name": request.value(forHTTPHeaderField: "X-Filename") ?? "notes.txt", "type": "text/plain", "size": 8, "sha256": "fixture-digest", "url": "/api/keir/app/uploads/012345678901234567890123456789ab"]
            deliver(try! JSONSerialization.data(withJSONObject: value), url: url, status: 201, type: "application/json"); return
        }
        if url.path.hasPrefix("/api/keir/app/uploads/") {
            if request.httpMethod == "DELETE" { deliver(Data("{}".utf8), url: url, status: 200, type: "application/json") }
            else { deliver(Data("evidence".utf8), url: url, status: 200, type: "text/plain") }
            return
        }
        if ProcessInfo.processInfo.arguments.contains("--uitest-computer") {
            if url.path.hasPrefix("/api/keir/app/artifacts/computer-fixture-") {
                let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLAAAAE0lEQVR4nGMQUTYgCTGMahiaGgCP3UBhi5xMcQAAAABJRU5ErkJggg==")!
                deliver(png, url: url, status: 200, type: "image/png"); return
            }
            if url.path == "/api/keir/app/computer" {
                let value: [String: Any] = ["computers": [["taskId": "abcdef012345", "title": "Fixture browser", "state": "paused"]]]
                deliver(try! JSONSerialization.data(withJSONObject: value), url: url, status: 200, type: "application/json"); return
            }
            if url.path == "/api/keir/app/computer/abcdef012345" {
                let (value, status) = Self.computer.route(request.httpMethod ?? "GET", bodyObject() ?? [:])
                deliver(try! JSONSerialization.data(withJSONObject: value), url: url, status: status, type: "application/json"); return
            }
        }
        if ["/api/ops/boards", "/api/ops/cards", "/api/ops/commands", "/api/ops/runners", "/api/ops/runs"].contains(where: { url.path.hasPrefix($0) }) {
            let (value, status) = Self.work.route(url, method: request.httpMethod ?? "GET", body: bodyObject() ?? [:])
            deliver((try? JSONSerialization.data(withJSONObject: value)) ?? Data(), url: url, status: status, type: "application/json")
            return
        }
        if url.path.hasPrefix("/api/ops/company") {
            let (value, status) = Self.company.route(url.path, method: request.httpMethod ?? "GET", body: bodyObject() ?? [:])
            deliver((try? JSONSerialization.data(withJSONObject: value)) ?? Data(), url: url, status: status, type: "application/json")
            return
        }
        if let value = MuseFixtures.value(url.path, method: request.httpMethod ?? "GET", body: bodyObject() ?? [:]) {
            deliver((try? JSONSerialization.data(withJSONObject: value)) ?? Data(), url: url, status: 200, type: "application/json")
            return
        }
        let isAsk = url.host?.hasPrefix("ask.") == true
        var value: Any = ["error": "No test fixture for this endpoint"]
        var status = 200
        switch url.path {
        case "/api/me":
            let expectedNames = isAsk ? ["__Host-lakeside_session", "__Host-ask_session"] : [url.host?.hasPrefix("hub.") == true ? "agency_session" : "ops_session"]
            let cookie = request.value(forHTTPHeaderField: "Cookie") ?? ""
            guard expectedNames.contains(where: { name in
                ["ui-test-session", "fixture-login"].contains(where: { cookie == name + "=" + $0 })
            }) else {
                deliver(Data("{\"error\":\"Fixture requires session cookie\"}".utf8), url: url, status: 401, type: "application/json"); return
            }
            if isAsk {
                let usage: [String: Any] = ["used": 46.5, "limit": 200, "remaining": 153.5, "mcpLimit": 40, "mcpRemaining": 12, "vizLimit": 10, "vizRemaining": 8, "resetAt": 1788912000000, "tier": "Staff"]
                let providers: [[String: Any]] = [
                    ["id": "google", "name": "Google", "detail": "Gemini models"],
                    ["id": "deepseek", "name": "DeepSeek", "detail": "DeepSeek models, operated from China"],
                ]
                let profile: [String: Any] = ["identity": ["username": "Test operator"], "entitlement": ["allowed": true, "label": "Staff"], "usage": usage, "aiProviders": providers]
                value = profile
            } else {
                value = ["email": "operator@example.test", "role": "admin"]
            }
        case "/api/auth/native-session": value = ["token": String(repeating: "a", count: 64), "expiresAt": Date().addingTimeInterval(30 * 86400).timeIntervalSince1970 * 1000]
        case "/api/keir/app/questions/123456abcdef": value = Self.keir.answerChoices()
        case "/api/keir/app/tickets/1564", "/api/keir/app/tickets/1001", "/api/keir/app/tickets/1575", "/api/keir/app/tickets/1651": value = ["current": ["id": "ticket-task", "state": "blocked", "summary": "Payroll code read; no duplicate charge found", "status": "Ticket 1001: Ticket 1001 remains open. Waiting for the owner decision. Was: Ticket 1001 remains open."], "blockers": [["kind": "decision", "title": "Choose payroll behavior", "detail": "Capacity or filled jobs?"]], "history": [["id": "history-1", "kind": "checkpoint", "text": "Read the payroll allocation code"]], "receipts": [["key": "issue:1", "label": "Filed issue #99", "state": "done"]]]
        case "/api/keir/app/controls": value = Self.keir.controls(bodyObject())
        case "/api/keir/app/models": value = Self.keir.models(bodyObject()?["selection"] as? String)
        case "/api/keir/app/computer": value = ["computers": [] as [Any]]
        case "/api/keir/app/thread": value = Self.keir.thread(after: Int(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value ?? "0") ?? 0)
        case "/api/keir/app/messages": value = Self.keir.post(bodyObject()?["text"] as? String ?? "", attachments: bodyObject()?["attachments"] as? [[String: Any]] ?? []); status = 201
        case "/api/keir/app/decisions": value = ["decisions": Self.keir.open()]
        case "/api/keir/app/approvals": value = ["approvals": Self.keir.open()]
        case "/api/keir/app/decisions/abcdefabcdef": value = Self.keir.answer("abcdefabcdef")
        case "/api/keir/app/alerts": value = ["alerts": [["key": "error:watch-recurring:turn", "kind": "incident", "text": "Turn warning repeated after the fix: index fund settlement for one corporation.", "at": 1792019000000]]]
        case "/api/keir/app/starmer", "/api/keir/app/starmer/refresh": value = OpsFixtures.starmer()
        case "/api/keir/app/recap": value = OpsFixtures.recap()
        case "/api/keir/app/recap/ack": value = ["acknowledgedAt": 1792020000000.0]
        case "/api/keir/app/devices": value = ["registered": true]
        case "/api/keir/app/ideas/301": value = KeirAgentFixtures.dismiss("301")
        case "/api/keir/app/work", "/api/keir/app/threads", "/api/keir/app/tasks", "/api/keir/app/tasks/abcdef012345", "/api/keir/app/ideas", "/api/keir/app/watches", "/api/keir/app/memory":
            value = KeirAgentFixtures.value(url.path, method: request.httpMethod ?? "GET", body: bodyObject() ?? [:])
        case "/api/keir/app/cancel": value = ["state": "cancelled"]
        case "/api/security": value = OpsFixtures.security()
        case "/api/backups": value = ["backups": [["date": "2026-10-15", "collections": 42, "totalBytes": 73400320], ["date": "2026-10-14", "collections": 42, "totalBytes": 73390000]], "total": 2]
        case "/api/db/stats": value = ["collections": 42, "totalDocuments": 128400, "dataSize": 52428800, "indexSize": 8388608]
        case "/api/events/dead-letters": value = ["events": [["streamId": "1-0", "type": "turn:failed", "source": "worker", "occurredAt": "2026-10-15T02:00:00Z", "error": "Receipt store timed out."]]]
        case "/api/code/sessions": value = ["sessions": [
            ["id": "s1", "title": "Keir mobile briefing", "kind": "codex", "activity": "working", "needsInput": false, "statusLine": "Running the iOS simulator suite", "worktreePath": "/root/projects/lakeside-ops/worktrees/keir-mobile-briefing"],
            ["id": "s2", "title": "Audit CI back-merges", "kind": "claude", "activity": "ready", "needsInput": true, "statusLine": "Waiting for review", "worktreePath": "/root/projects/lakeside-ops/worktrees/keir-ci-audit"]
        ]]
        case "/api/status", "/api/keir/hub", "/api/kanban/brief", "/api/scheduler": value = OpsFixtures.value(url.path)
        case "/api/ops/bootstrap": value = ["cursor": 0, "conversation": ["id": 1], "conversations": [["id": 1, "title": "Build the studio hub"]], "staff": [["id": "staff-1", "name": "Release engineer", "role": "Maintain release quality", "provider": "auto"]], "workers": [["id": "worker-1", "name": "Export repair", "brief": "Repair and verify the export flow.", "job_status": "completed", "runtime_provider": "codex", "permissions": [], "result": "Export fixed. All checks passed."]]]
        case "/api/chat/turns": value = ["turns": [["id": 1, "role": "owner", "body": "Help me build the studio hub.", "status": "done"], ["id": 2, "role": "assistant", "body": "The export worker has finished. I am checking the changes before accepting them.", "status": "done", "route": ["label": "Muse"], "actions": [["name": "bash", "label": "Run export checks", "command": "npm test", "output": "All 12 checks passed", "state": "completed", "exitCode": 0]]]]]
            if ProcessInfo.processInfo.arguments.contains("--uitest-live-activity") {
                value = ["turns": [["id": 1, "role": "owner", "body": "Check the export flow.", "status": "done"], ["id": 2, "role": "assistant", "body": "", "status": "running", "route": ["label": "Codex"], "actions": []]]]
            }
        case "/api/chat/stream/2":
            guard ProcessInfo.processInfo.arguments.contains("--uitest-live-activity") else { status = 404; break }
            let live = "event: action\ndata: {\"id\":\"live-tool\",\"name\":\"bash\",\"label\":\"Running export checks\",\"command\":\"npm test\",\"state\":\"running\"}\n\nevent: status\ndata: {\"label\":\"Running export checks\"}\n\nevent: delta\ndata: {\"text\":\"Checking the export flow.\"}\n\n"
            deliver(Data(live.utf8), url: url, status: 200, type: "text/event-stream", finish: false); return
        case "/api/ops/events":
            deliver(Data(": connected\n\n".utf8), url: url, status: 200, type: "text/event-stream", finish: false); return
        case "/api/ops/staff": value = ["staff": [["id": "staff-1", "name": "Release engineer", "role": "Maintain release quality", "provider": "auto"]]]
        case "/api/ops/staff/staff-1": value = ["staff": ["id": "staff-1", "name": "Release engineer", "role": "Maintain release quality", "memory": "Verify exports before release.", "provider": "auto", "version": 1], "runs": [["id": "worker-1", "name": "Export repair", "brief": "Repair exports", "job_status": "completed", "created_at": "2026-09-08T12:00:00.000Z"]]]
        case "/api/ops/projects": value = ["projects": [["name": "Studio hub", "path": "/fixture/studio"]]]
        case "/api/ops/workers/worker-1/messages": value = ["messages": []]
        case "/api/ops/workers/worker-1": value = ["worker": ["brief": "Repair and verify the export flow.", "result": "Export fixed. All checks passed."]]
        case "/api/ops/conversations/1/routing":
            if request.httpMethod == "POST" {
                if let body = bodyObject(), body["provider"] is String, body["effort"] is String, body["allowFallback"] is Bool {
                    value = Self.routing.access(body)
                } else { status = 400; value = ["error": "Routing request body missing"] }
            } else { value = Self.routing.access() }
        case "/api/ops/providers":
            let stamp = Date().timeIntervalSince1970 * 1000
            let definitions: [(String, String)] = [("codex", "Codex"), ("muse", "Muse"), ("grok", "Grok"), ("freerouter", "Free Router")]
            value = ["providers": definitions.map { id, label -> [String: Any] in
                var capacity: [String: Any] = ["status": "available", "source": "UI fixture", "observedAt": stamp, "stale": false, "message": "Quota reported", "windows": [], "balances": []]
                if id == "codex" || id == "grok" {
                    capacity["windows"] = [["id": "quota", "label": id == "codex" ? "5-hour allowance" : "Weekly allowance", "remainingPercent": id == "codex" ? 65 : 18, "resetsAt": stamp + 3600000, "observedAt": stamp]]
                } else if id == "muse" {
                    capacity["status"] = "unavailable"; capacity["message"] = "Account quota not reported"
                } else {
                    capacity["message"] = "Routes ready"; capacity["readiness"] = ["ready": 7, "total": 9, "coolingDown": 2]
                }
                return ["id": id, "label": label, "enabled": true, "status": "available", "billing": id == "freerouter" ? "free" : "subscription", "capabilities": id == "freerouter" ? ["text"] : ["tools"], "models": [["id": "fixture-model", "label": "Fixture model", "isDefault": true, "thinkingOptions": id == "freerouter" ? [] : [["id": "low"], ["id": "medium"], ["id": "high"]]]], "capacity": capacity]
            }]

        case "/api/ops/benchmarks": value = ["scores": [["provider": "codex", "model": "fixture-model", "suite": "coding", "effort": "medium", "passed": 4, "checks": 4, "samples": 1, "latency_ms": 2500]], "runs": []]
        case "/api/ops/usage": value = ["providers": [["provider": "codex", "attempts": 3, "input_tokens": 12000, "output_tokens": 3000, "unmeasured_token_attempts": 1]]]
        case "/api/ops/memory": value = ["body": "Keep each implementation worker in a separate worktree. Verify results before accepting them.", "version": "fixture-version"]
        case "/api/nextcost": value = ["cost": 0.5, "followup": 1, "followupsLeft": 2]
        case "/api/conversation/share": value = ["ok": true, "url": "https://example.test/shared-conversation"]
        case "/api/conversations":
            if isAsk {
                let rows: [[String: Any]] = [["id": "fixture-conversation", "title": "How does inflation work?", "updated": 1788825600000, "pinned": false]]
                if let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "q" })?.value {
                    value = ["conversations": rows.filter { ($0["title"] as? String ?? "").localizedCaseInsensitiveContains(query) || query.localizedCaseInsensitiveContains("prices") }, "query": query]
                } else { value = ["conversations": rows] }
            }
            else { value = ["conversations": [["id": 1, "title": "Build the studio hub"]], "conversation": ["id": 1]] }
        case "/api/ops/workspaces": value = ["workspaces": [["workspaceId": "w1", "title": "Studio hub", "isolation": "worktree"]]]
        case "/api/ops/files": value = ["entries": [["name": "app.swift", "path": "app.swift", "directory": false]]]
        case "/api/ops/files/changes": value = ["entries": [["name": "app.swift", "path": "app.swift", "status": " M", "deleted": false, "untracked": false]]]
        case "/api/ops/files/read": value = ["content": "// Studio hub\nlet version = \"1.3.0\"", "size": 40]
        case "/api/ops/files/diff": value = ["content": "-let version = 1.2\n+let version = 1.3"]
        case "/api/ops/workers/worker-1/activity":
            value = ["content": "Ran export checks. All 12 checks passed.", "entries": [
                ["id": "message-1", "kind": "message", "role": "assistant", "title": "Assistant", "body": "Checking the export implementation."],
                ["id": "tool-1", "kind": "tool", "title": "Run export checks", "body": "npm test\nAll 12 checks passed", "state": "completed"]
            ], "updateCount": 2, "revision": "fixture-worker-v1", "saved": true, "stale": false, "truncated": false, "observedAt": Date().timeIntervalSince1970 * 1000]
        case "/api/ops/workers/worker-1/subagents":
            value = ["subagents": [["id": "child-1", "parentAgentId": "fixture-runtime", "provider": "codex", "title": "Export reviewer", "description": "Review edge cases before accepting the repair.", "status": "completed"]], "saved": true, "stale": false]
        case "/api/ops/workers/worker-1/subagents/child-1/activity":
            value = ["entries": [["id": "child-message-1", "kind": "message", "role": "assistant", "title": "Assistant", "body": "Reviewed empty exports and unicode filenames."]], "content": "Reviewed empty exports and unicode filenames.", "revision": "fixture-child-v1", "updateCount": 1, "saved": true, "stale": false, "truncated": false]

        case "/api/schedules": value = ["schedules": [["id": 1, "title": "Morning review", "brief": "Review overnight activity", "cadence": "daily", "enabled": 1]]]
        case "/api/tasks": value = ["tasks": [["id": 1, "title": "Review deployment", "status": "completed", "brief": "Check the release"]]]
        case "/api/tasks/1": value = ["task": ["id": 1, "status": "completed", "result": "Release verified."]]

        case "/api/games": value = ["games": [["id": "ahd", "name": "A House Divided"]]]
        case "/api/ask/context": value = ["game": ["id": "ahd", "name": "A House Divided", "subject": "a political strategy game"], "context": "SOURCE CODE: inflation is calculated from the price index.", "files": [], "available": true]
        case "/api/map/render":
            let svg = ##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760"><rect width="1200" height="760" fill="#111827"/><path d="M100 160 L480 100 L540 500 L180 550 Z" fill="#38bdf8"/><path d="M560 180 L990 130 L1060 580 L600 500 Z" fill="#21c8a0"/><text x="80" y="70" fill="#ffffff" font-size="32">Fixture regions</text></svg>"##
            deliver(Data(svg.utf8), url: url, status: 200, type: "image/svg+xml"); return
        case "/api/conversation": value = ["turns": [["id": 42, "question": "How does inflation work?", "answer": "## Inflation\n\nPrices respond to supply and demand.", "citations": [["label": "Economy reference", "url": "https://example.test/economy"]]]]]
            if ProcessInfo.processInfo.arguments.contains("--uitest-visuals") {
                let answer = #"""
```mermaid
xychart-beta
 title "GDP growth"
 x-axis ["US", "UK", "France"]
 y-axis "Percent" -2 --> 5
 bar [-1.5, 4, 2.2]
```

```ahd-map
{"title":"Fixture regions","scope":"world","metric":"Growth","unit":"%","regions":[{"id":"US","label":"United States","value":2},{"id":"GB","label":"United Kingdom","value":4}]}
```
"""#
                value = ["turns": [["id": 42, "question": "Show the economy", "answer": answer]]]
            }
        case "/api/watches" where isAsk: value = Self.watchState.list()
        case "/api/watches/delete" where isAsk:
            value = ["ok": Self.watchState.delete(bodyObject()?["id"])]
        case "/api/reports" where isAsk:
            value = ["reports": [["token": "fixture-report", "title": "Fixture economy report", "createdAt": 1788825600000, "url": "/r/fixture-report"]]]
        case "/api/ask/stop":
            let body = bodyObject() ?? [:]
            value = ["ok": (body["reqId"] as? String)?.isEmpty == false]
        case "/api/ask" where ProcessInfo.processInfo.arguments.contains("--uitest-quota"):
            status = 429
            value = ["error": "You've used all 200 questions for today.", "quota": true, "usage": ["used": 200, "limit": 200, "remaining": 0]]
        case "/api/ask" where ProcessInfo.processInfo.arguments.contains("--uitest-slow-stream"):
            let partial = "event: meta\ndata: {\"convId\":\"fixture-conversation\",\"reqId\":\"fixture-request\",\"status\":\"Reading sources\"}\n\nevent: delta\ndata: \"A partial draft\"\n\n"
            deliver(Data(partial.utf8), url: url, status: 200, type: "text/event-stream", finish: false); return
        case "/api/ask":
            let body = #"""
event: meta
data: {"convId":"fixture-conversation","reqId":"fixture-request","status":"Reading sources"}

event: delta
data: "A partial draft"

event: done
data: {"convId":"fixture-conversation","answerId":43,"answer":"Verified final answer from the server.","usage":{"used":47,"limit":200,"remaining":153,"mcpLimit":40,"mcpRemaining":11,"vizLimit":10,"vizRemaining":8},"citations":[{"label":"Verified source","url":"https://example.test/source"}]}

"""# + "\n"
            deliver(Data(body.utf8), url: url, status: 200, type: "text/event-stream"); return
        case "/api/status": value = ["services": [["id": "game", "name": "Game server", "current": "operational", "latencyMs": 42, "uptime24h": 99.9, "history": [["date": "2026-09-07", "pct": 99.9]]]]]
        case "/api/game/summary": value = ["turn": 123, "year": 1960, "activePlayers": 42]
        case "/api/code/sessions": value = ["sessions": [["sessionId": "tmux:test-agent", "tmuxName": "test-agent", "title": "Test agent", "statusLine": "Waiting for input", "needsInput": true, "provider": "codex", "usage": ["percent": 72, "direction": "remaining", "detail": "Weekly plan"]]]]
        case "/api/code/tmux/test-agent/capture": value = ["transcript": ["turns": [["user": "Check the deployment", "blocks": [["type": "text", "text": "Deployment checks passed."]]]]]]
        case "/api/code/tmux/test-agent/message": value = ["ok": true, "queued": true]
        case "/api/tickets": value = ["items": [["_id": "ticket-1", "ticketNumber": 123, "title": "Example ticket", "description": "A reproducible issue", "status": "open"]], "page": 1, "totalPages": 1]
        case "/api/logout", "/auth/logout", "/api/answer/feedback": value = ["ok": true]
        default: status = 404
        }
        deliver((try? JSONSerialization.data(withJSONObject: value)) ?? Data(), url: url, status: status, type: "application/json")
    }
    private func deliver(_ data: Data, url: URL, status: Int, type: String, finish: Bool = true) {
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); if finish { client?.urlProtocolDidFinishLoading(self) }
    }
    override func stopLoading() {}
}

/// Ops 2.1 fixtures: feed, goals, approvals, upcoming, files and identity.
enum MuseFixtures {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var goals: [[String: Any]] = [MuseFixtures.goal("g00000000001", "Median turn time under 60 seconds", progress: 0.5, working: true)]
        func add(_ title: String) -> [String: Any] { lock.lock(); defer { lock.unlock() }; let g = MuseFixtures.goal("g00000000002", title, progress: 0, working: true); goals.insert(g, at: 0); return g }
        func list() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return goals }
    }
    private static let state = State()
    static func goal(_ id: String, _ title: String, progress: Double, working: Bool) -> [String: Any] {
        let m1: [String: Any] = ["id": "m1", "title": "Capture phase timings for 20 turns", "done": progress > 0, "evidence": "Turns 184 to 203 captured; settlement is 38% of wall time."]
        let m2: [String: Any] = ["id": "m2", "title": "Add the missing metricHistory indexes", "done": false]
        let note: [String: Any] = ["at": 1792020000000.0, "text": "Settlement dominates; indexing metricHistory is next."]
        return ["id": id, "title": title, "description": "Players wait less between turns.", "category": "A House Divided", "cadence": "daily", "status": "active",
            "milestones": progress > 0 ? [m1, m2] : [Any](), "notes": [note], "progress": progress, "working": working, "at": 1792010000000.0]
    }
    static func value(_ path: String, method: String, body: [String: Any]) -> [String: Any]? {
        guard path.hasPrefix("/api/keir/app/") else { return nil }
        let p = String(path.dropFirst("/api/keir/app".count))
        let empty: [Any] = []
        switch p {
        case "/feed":
            let brief: [String: Any] = ["id": "f1", "kind": "brief", "title": "Morning brief", "body": "- Turn 203 ran in 41s, no failures\n- 3 tickets open, 2 resolved overnight\n- PR #201 is green and waiting on you", "links": empty, "at": 1792040000000.0]
            let win: [String: Any] = ["id": "f2", "kind": "win", "title": "Milestone done: Capture phase timings for 20 turns", "body": "Settlement is 38% of wall time.", "links": empty, "at": 1792030000000.0]
            return ["feed": [brief, win]]
        case "/feed/brief": return ["taskId": "abcdef012345"]
        case "/goals":
            if method == "POST" { return state.add(body["title"] as? String ?? "Goal") }
            return ["goals": state.list(), "cadences": ["6h", "daily", "3d", "weekly"]]
        case "/goals/g00000000001": return goal("g00000000001", "Median turn time under 60 seconds", progress: 0.5, working: true)
        case "/goals/g00000000002": return goal("g00000000002", "Every bug ticket answered within 2 hours", progress: 0, working: true)
        case "/approvals":
            let a: [String: Any] = ["id": "abcdefabcdef", "question": "Merge PR #201 into development? Checks are green.", "tldr": "Merge #201 to development", "at": 1792020000000.0, "signoff": false,
                "taskTitle": "Promote development to production", "action": ["kind": "github", "summary": "merge #201"]]
            return ["approvals": [a]]
        case "/upcoming":
            let brief: [String: Any] = ["kind": "brief", "at": 1792058400000.0, "title": "Morning brief"]
            let goal: [String: Any] = ["kind": "goal", "at": 1792070000000.0, "title": "Advance: Median turn time under 60 seconds"]
            let watch: [String: Any] = ["kind": "watch", "at": 1792045000000.0, "title": "PR 201 is merged"]
            return ["upcoming": [watch, brief, goal]]
        case "/files":
            let report: [String: Any] = ["id": "a00000000001", "kind": "report", "title": "Turn time breakdown", "summary": "Where turn 203 spent its 41 seconds", "at": 1792030000000.0]
            return ["files": [report]]
        case "/files/a00000000001":
            return ["id": "a00000000001", "kind": "report", "title": "Turn time breakdown", "markdown": "# Turn 203\n\nSettlement took 15.6s of 41s.\n\n| Phase | Seconds |\n|---|---|\n| Settlement | 15.6 |\n| Elections | 6.2 |", "at": 1792030000000.0]
        case "/identity":
            return ["tone": body["tone"] as? String ?? "concise", "showUpdates": true, "briefOn": true, "briefHour": 8]
        default:
            if p.hasPrefix("/goals/") { return ["taskId": "abcdef012345"] }
            if p.hasPrefix("/ideas/s-") { return ["taskId": "abcdef012345"] }
            return nil
        }
    }
}

/// Keir agent fixtures: threads, activity, ideas, watches and memory.
enum KeirAgentFixtures {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var watches: [[String: Any]] = [["id": "aaaaaaaaaaaa", "condition": "PR 201 is merged", "every": "hourly", "once": true, "active": true, "runs": 2, "hits": 0, "lastResult": "no change", "running": false]]
        var dismissedIdeas = Set<String>()
        func dismissIdea(_ id: String) {
            lock.lock(); defer { lock.unlock() }
            dismissedIdeas.insert(id)
        }
        func listIdeas(_ ideas: [[String: Any]]) -> [[String: Any]] {
            lock.lock(); defer { lock.unlock() }
            return ideas.filter { !dismissedIdeas.contains($0["id"] as? String ?? "") }
        }
        func addWatch(_ body: [String: Any]) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            let w: [String: Any] = ["id": "bbbbbbbbbbbb", "condition": body["condition"] as? String ?? "", "every": body["every"] as? String ?? "hourly", "once": true, "active": true, "runs": 0, "hits": 0, "running": false]
            watches.insert(w, at: 0); return w
        }
        func list() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return watches }
    }
    private static let state = State()
    static func dismiss(_ id: String) -> [String: Any] { state.dismissIdea(id); return ["ok": true] }
    static func value(_ path: String, method: String, body: [String: Any]) -> [String: Any] {
        switch path {
        case "/api/keir/app/threads":
            let main: [String: Any] = ["id": "main", "title": "Keir", "system": false, "at": 1792020110000.0, "preview": "Two PRs are waiting on you: #201 and #202.", "working": false]
            let watches: [String: Any] = ["id": "watches", "title": "Watches", "system": true, "at": 0, "working": false]
            let side: [String: Any] = ["id": "c0ffee00", "title": "Bond market", "system": false, "at": 1792010000000.0, "preview": "Spread is back inside the band.", "working": false]
            return ["threads": [main, side, watches]]
        case "/api/keir/app/work":
            let now = Date().timeIntervalSince1970 * 1000
            let timing: [String: Any] = ["state": "waiting", "reason": "Waiting for the staging checks.", "next": "Read the check result and promote the tested head.", "milestone": "Staging checks pass", "nextCheckAt": now + 120000, "reviewAt": now + 600000, "since": now - 300000, "overdue": false, "etaLabel": "Completion time not established"]
            let stuck: [String: Any] = ["state": "stuck", "reason": "A completed action needs its receipt verified.", "next": "Inspect the saved result before retrying.", "since": now - 7200000, "reviewAt": now - 3600000, "overdue": true, "etaLabel": "Completion time not established"]
            return ["at": now, "source": ["enabled": true, "at": now, "complete": true], "tickets": [["number": 1501, "title": "Bond coupon ledger", "status": "open", "category": "bug", "timing": timing], ["number": 1502, "title": "Verify an interrupted action", "status": "open", "category": "bug", "timing": stuck]]]
        case "/api/keir/app/tasks":
            let running: [String: Any] = ["id": "abcdef012345", "kind": "command", "state": "running", "title": "Promote development to production", "surface": "app", "receipts": 2, "decisionPending": false, "updatedAt": 1792020000000.0, "at": 1792019000000.0]
            let done: [String: Any] = ["id": "fedcba543210", "kind": "conversation", "state": "done", "title": "How did the last turn go?", "surface": "app", "receipts": 0, "decisionPending": false, "updatedAt": 1792018000000.0, "at": 1792018000000.0]
            return ["tasks": [running, done]]
        case "/api/keir/app/tasks/abcdef012345":
            let step: [String: Any] = ["at": "2026-10-15T03:00:00Z", "kind": "progress", "state": "running", "summary": "Development to staging merged; staging deploy is green."]
            let receipt: [String: Any] = ["label": "Merged PR #210", "state": "done", "at": 1792019500000.0, "kind": "merge"]
            let card: [String: Any] = ["type": "pr", "repository": "Egg3901/AHDGame", "number": 211, "url": "https://github.com/Egg3901/AHDGame/pull/211"]
            let plan: [[String: Any]] = [["title": "Merge development into staging", "status": "done"], ["title": "Verify the staging deploy", "status": "done"], ["title": "Promote staging to main", "status": "running"], ["title": "Confirm the turn worker picked it up", "status": "pending"]]
            let live: [[String: Any]] = [["at": 1792019900000.0, "tool": "github", "what": "promote #211", "ok": true, "ms": 900], ["at": 1792019800000.0, "tool": "read_tool", "what": "railway.railway_status", "ok": true, "ms": 400]]
            let empty: [Any] = []
            return ["id": "abcdef012345", "kind": "command", "state": "running", "request": "Promote development to production", "summary": "Staging is green; opening the staging to main promotion.", "surface": "app", "model": "claude:claude-opus-5-5",
                "at": 1792019000000.0, "status": "Waiting for the main deploy", "steps": [step], "receipts": [receipt], "decisions": empty, "cards": [card], "canRetry": false, "canStop": true,
                "plan": plan, "live": live]
        case "/api/keir/app/ideas":
            let idea: [String: Any] = ["id": "301", "kind": "issue", "title": "CI runs the full matrix for verified empty back-merges", "url": "https://github.com/Egg3901/AHDGame/issues/301", "reason": "Every back-merge with no content change re-ran the 24 minute verify job.", "evidence": "Every back-merge with no content change re-ran the 24 minute verify job. The verify lane is the slowest in the matrix.", "accepted": false]
            if ProcessInfo.processInfo.arguments.contains("--uitest-goal-suggestions") {
                return ["ideas": [["id": "s-123456abcdef", "kind": "suggestion", "title": "Keep replies under five seconds", "evidence": "Recent response times are too high.", "prompt": "Measure end-to-end reply latency and keep the median below five seconds.", "accepted": false]]]
            }
            let visible = state.listIdeas([idea])
            return ["ideas": visible]
        case "/api/keir/app/watches":
            if method == "POST" { return state.addWatch(body) }
            return ["watches": state.list(), "intervals": ["15m", "hourly", "6h", "daily"]]
        default:
            if path.hasPrefix("/api/keir/app/ideas/") {
                state.dismissIdea(path.split(separator: "/").last.map(String.init) ?? "")
                return ["ok": true]
            }
            let lesson: [String: Any] = ["id": "n1", "kind": "lesson", "text": "Never promote economy changes while a turn is running.", "owner": true, "at": 1792010000000.0]
            let mechanic: [String: Any] = ["id": "n2", "kind": "mechanic", "text": "A department's funding is the yearly cost of the enacted laws in its policy areas.", "owner": false, "at": 1792000000000.0]
            return ["total": 2, "notes": [lesson, mechanic]]
        }
    }
}

/// Ops 2.0 fixtures, typed explicitly so the compiler never has to infer them.
enum OpsFixtures {
    static func value(_ path: String) -> [String: Any] {
        switch path {
        case "/api/status": return ["updated": "2026-10-15T02:43:31Z", "services": [service("production", "A House Divided", "operational", 167, 99.85, dip: 21), service("ask", "Lakeside Ask", "degraded", 912, 98.1, dip: 28)]]
        case "/api/keir/hub": return hub()
        case "/api/kanban/brief": return kanban()
        case "/api/scheduler": return scheduler()
        default: return ["host": host()]
        }
    }
    static func service(_ id: String, _ name: String, _ current: String, _ latency: Int, _ uptime: Double, dip: Int) -> [String: Any] {
        var history: [[String: Any]] = []
        for day in 0..<30 { history.append(["date": "d\(day)", "pct": day == dip ? 96.2 : 100.0]) }
        return ["id": id, "name": name, "current": current, "latencyMs": latency, "uptime7d": uptime, "lastChecked": "2026-10-15T02:43:31Z", "history": history]
    }
    static func starmer() -> [String: Any] {
        let items: [[String: Any]] = [
            ["id": "abcdef012345", "title": "Choose payroll behavior", "state": "running", "ticket": 1575, "since": 1792019000000.0],
            ["id": "fedcba543210", "title": "Verify the funding fix on main", "state": "waiting", "ticket": 1001, "since": 1792018000000.0],
        ]
        return ["at": 1792020000000.0,
                "text": "Two turns ran clean and the queue is one ticket shorter than yesterday.",
                "nextAt": 1792021800000.0,
                "working": ["headline": "On the move", "detail": "#1575 Choose payroll behavior", "running": 1, "waiting": 1, "queued": 0, "items": items]]
    }
    static func recap() -> [String: Any] {
        let items: [[String: Any]] = [
            ["id": "r1", "kind": "win", "title": "Merged PR #210", "detail": "The mobile redesign reached main.", "at": 1792019000000.0, "source": "event", "task": NSNull(), "goal": NSNull()],
            ["id": "r2", "kind": "decision", "title": "Merge #201 to development", "detail": "approve by the owner", "at": 1792017000000.0, "source": "owner", "task": NSNull(), "goal": NSNull()],
        ]
        return ["since": 1791950000000.0, "total": items.count, "items": items]
    }
    static func hub() -> [String: Any] {
        var activity: [[String: Any]] = []
        for hour in 0..<24 {
            let at: Double = 1791946800000 + Double(hour) * 3600000
            activity.append(["at": at, "claude": hour % 3, "codex": 1, "muse": hour % 5, "agy": 0, "other": 0, "failed": hour % 5 == 0 ? 1 : 0, "ms": (hour % 3 + 1 + hour % 5) * 12000])
        }
        let kpis: [String: Any] = ["live": 6, "running": 2, "queued": 1, "waiting": 2, "blocked": 1, "decisionsPending": 1, "openTickets": 3, "prsOpen": 2, "prsRed": 1, "successRate24h": 0.87, "activations24h": 46, "medianActivationMs": 12000, "p90ActivationMs": 95000]
        let worker: [String: Any] = ["id": "w1", "kind": "ticket", "role": "support", "state": "running", "ticket": 1001, "runner": "claude", "model": "claude-opus-5-5",
            "effort": "medium", "rounds": 14, "via": "rust", "updatedAt": 1792020000000.0, "summary": "Verifying the funding fix on main before answering the player."]
        let item: [String: Any] = ["name": "Funding display fix", "stage": "main", "blocked": false, "note": "Live on the main server."]
        let card: [String: Any] = ["status": "Department funding at 0 is intended when its laws cost nothing.", "items": [item]]
        let ticket: [String: Any] = ["number": 1001, "title": "Budget screen shows zero funding", "status": "open", "category": "bug", "createdAt": 1792010000000.0,
            "prs": [101], "decisionPending": false, "active": ["state": "running"], "card": card]
        let empty: [Any] = []
        let counts: [String: Any] = ["ticketRoots": 4, "actionableTicketRoots": 3, "monitoringTicketRoots": 1, "rootJobs": 4, "childJobs": 2, "executing": 2, "queued": 1, "dependency": 1, "ci": 1, "owner": 1, "turn": 0, "schedule": 0, "other": 0]
        let cost: [String: Any] = ["modelMs": 5400000, "activations": 23, "exhausted": 2, "repeatedRoots": 1, "timedOut": 1]
        let throughput: [String: Any] = ["windowMs": 21600000, "counts": counts, "cost": cost, "work": empty, "hiddenWork": 0, "supportSample": ["available": true, "count": 12, "limit": 60], "note": "Model time is summed completed activation duration, not elapsed wait or measured waste."]
        let quality: [String: Any] = ["tickets": 18, "closed": 12, "decisions_unanswered": 2, "time_to_closure": ["median_ms": 3600000, "p90_ms": 86400000], "decision_latency": ["median_ms": 1200000, "p90_ms": 7200000], "oldest_open_age_ms": 172800000, "labels": ["closed_observing": 10, "reopened": 2, "open": 6]]
        let jev: [String: Any] = ["tagged": 31, "injections": 1, "screened": 26, "refused": 2, "tags": ["kind": ["bug": 23, "question": 8], "mood": ["calm": 22, "frustrated": 9]], "labels": ["certaintyWithoutReceipt": 2]]
        let watch: [String: Any] = ["status": "active", "mode": "enforce", "paused": false, "openFindings": 3, "budget": ["hourUsed": 1, "perHour": 3, "dayUsed": 4, "perDay": 8], "score": ["caughtFirst": 7, "playerFirst": 3, "share": 70], "sensors": [["id": "operator", "label": "Operator health", "status": "healthy", "lastSuccessAt": 1792020000000.0]], "capabilities": ["authorityCarried": 4, "issuesClosedLive": 2, "sentryResolved": 1, "heldPromotions": 1, "sensorFailures": 0, "skillFailures": 0, "scope": "Retained ledger audit events"]]
        let prs: [[String: Any]] = [
            ["number": 211, "title": "Voice turns: fast first answer", "state": "OPEN", "ci": "red", "url": "https://github.com/lakesidegamedev/lakeside-ops/pull/211"],
            ["number": 210, "title": "Keir mobile briefing redesign", "state": "OPEN", "ci": "green", "url": "https://github.com/lakesidegamedev/lakeside-ops/pull/210"],
            ["number": 209, "title": "Promote development to production", "state": "MERGED", "ci": "green", "url": "https://github.com/lakesidegamedev/lakeside-ops/pull/209"],
        ]
        return ["at": 1792020000000.0, "release": ["version": "5.4.0"], "routing": ["quick": "codex:gpt-6.1-sol@medium", "coding": "codex:gpt-6.1-sol@medium"], "paused": false, "kpis": kpis, "activity": activity, "workers": [worker], "recent": empty, "tickets": [ticket], "prs": prs, "throughput": throughput, "quality": quality, "jev": jev, "watch": watch, "sources": ["support": "ok", "prs": "ok"], "sourceFreshness": ["support": ["at": 1792020000000.0, "refreshing": false]]]
    }
    static func kanban() -> [String: Any] {
        let needs: [String: Any] = ["id": 1, "title": "Pick the 1991 seed sector mix", "product": "a-house-divided", "lane": "next", "needs_owner": true, "assigned_to": "", "impact": "high", "updated_at": "2026-10-14T20:00:00Z"]
        let now: [String: Any] = ["id": 2, "title": "Keir chat in Lakeside Ops", "product": "a-house-divided", "lane": "now", "assigned_to": "claude", "impact": "medium",
            "progress_summary": "Operator app channel and push are built.", "last_progress_at": "2026-10-15T02:40:00Z"]
        let blocked: [String: Any] = ["id": 3, "title": "Turn worker release gate", "product": "a-house-divided", "lane": "blocked", "assigned_to": "codex", "impact": "high", "updated_at": "2026-10-14T18:00:00Z"]
        let counts: [String: Any] = ["needs_owner": 1, "now": 1, "blocked": 1, "next": 0]
        let empty: [Any] = []
        return ["counts": counts, "needs_owner": [needs], "now": [now], "blocked": [blocked], "next": empty]
    }
    static func host() -> [String: Any] {
        let memory: [String: Any] = ["usedPct": 32], disk: [String: Any] = ["usedPct": 36], checks: [String: Any] = ["running": 0, "queued": 1]
        return ["cpuUsedPct": 21, "load": [4.7, 5.4, 3.7], "memory": memory, "disk": disk, "checks": checks]
    }
    static func scheduler() -> [String: Any] {
        let checks: [[String: Any]] = [
            ["id": "check-1", "state": "running", "label": "ios-simulator", "preset": "verify", "workdir": "/root/projects/lakeside-ops/worktrees/keir-mobile-briefing/apps/ios", "priority": "normal", "requested_at": 1792019000000.0],
            ["id": "check-2", "state": "queued", "label": "web-verify", "preset": "verify", "workdir": "/root/projects/lakeside-ops/apps/web", "priority": "low", "requested_at": 1792018000000.0]
        ]
        let sims: [[String: Any]] = [
            ["runId": "sim-1", "preset": "singleplayer", "turns": 64, "seed": "seed-1991", "status": "running", "currentTurn": 18, "autonomyLevel": "v4", "marketSystemMode": "clearing", "createdAt": 1792010000000.0, "updatedAt": 1792020000000.0],
            ["runId": "sim-2", "preset": "multiplayer", "turns": 32, "seed": "seed-1992", "status": "queued", "currentTurn": 0, "autonomyLevel": "v3", "marketSystemMode": "off", "createdAt": 1792015000000.0, "updatedAt": 1792015000000.0]
        ]
        return ["host": host(), "checks": checks, "worldSims": sims, "presets": ["verify", "test", "build"]]
    }
    static func security() -> [String: Any] {
        let hosts: [[String: Any]] = [
            ["id": "contabo-vps18", "label": "EU console", "name": "contabo-vps18", "ok": true, "collectedAt": "2026-10-15T02:30:00Z", "ageMs": 600000, "stale": false],
            ["id": "contabo-vps12-us", "label": "US host", "name": "contabo-vps12-us", "ok": true, "collectedAt": "2026-10-15T02:31:00Z", "ageMs": 540000, "stale": false]
        ]
        let findings: [[String: Any]] = [
            ["id": "us:ssh-agent", "rule": "ssh-agent-forwarding", "host": "contabo-vps12-us", "hostLabel": "US host", "severity": "medium", "title": "SSH agent forwarding is enabled", "detail": "The forwarded agent could be used by a process on the host.", "remedy": "Set AllowAgentForwarding no and reload sshd."],
            ["id": "eu:fail2ban", "rule": "fail2ban-recividive", "host": "contabo-vps18", "hostLabel": "EU console", "severity": "high", "title": "fail2ban recidive jail is not active", "detail": "Repeat offenders are not being banned.", "remedy": "Enable the recidive jail and restart fail2ban."]
        ]
        return ["generatedAt": "2026-10-15T02:43:31Z", "schema": 1,
                "summary": ["score": 82, "posture": "degraded", "counts": ["critical": 0, "high": 1, "medium": 1, "low": 2, "info": 0], "hostsReachable": 2, "hostsTotal": 2],
                "hosts": hosts, "findings": findings,
                "monitoring": ["expectedIntervalMinutes": 15, "staleAfterMinutes": 45, "hostsReporting": 2, "hostsTotal": 2]]
    }
}
#endif
