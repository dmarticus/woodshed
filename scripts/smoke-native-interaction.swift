import AppKit
import Foundation

final class MockController: @unchecked Sendable {
    let lock = NSLock()
    var state: [String: Any] = [:]
    var failSettings = false
    var agentLoads: [Int: Int] = [:]
    var actionStarts: [(String, Date)] = []
    private let responseGate = NSCondition()
    private var allowedResponses: Set<String> = []
    func waitForResponse(_ path: String) {
        guard path.hasSuffix("/mark-ready") || path.hasSuffix("/request-approval") else { return }
        responseGate.lock(); defer { responseGate.unlock() }
        while !allowedResponses.contains(path) { responseGate.wait() }
    }
    func allowResponse(_ path: String) {
        responseGate.lock(); defer { responseGate.unlock() }
        allowedResponses.insert(path); responseGate.broadcast()
    }
    func response(_ request: URLRequest) -> (Data, Int, Double) {
        lock.withLock {
            let path = request.url!.path
            if path.hasSuffix("/agent") {
                let number = Int(path.split(separator: "/")[2])!
                agentLoads[number, default: 0] += 1
                let first = number == 106 && agentLoads[number] == 1
                return (try! JSONSerialization.data(withJSONObject: ["name": "ws-\(number)-preview", "state": "running", "message": "Working", "output": first ? "stale output" : "current output"]), 200, first ? 0.5 : 0.08)
            }
            if request.httpMethod == "POST" {
                if path.hasSuffix("/settings") {
                    if failSettings { return (Data("{\"error\":\"Couldn’t save mode. Try again.\"}".utf8), 503, 0.15) }
                    var body = request.httpBody ?? Data()
                    if body.isEmpty, let stream = request.httpBodyStream {
                        stream.open(); defer { stream.close() }
                        var buffer = [UInt8](repeating: 0, count: 1024)
                        while stream.hasBytesAvailable {
                            let count = stream.read(&buffer, maxLength: buffer.count)
                            guard count > 0 else { break }
                            body.append(buffer, count: count)
                        }
                    }
                    let input = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
                    if let mode = input["mode"] { state["mode"] = mode }
                    var settings = state["settings"] as? [String: Any] ?? [:]
                    for (key, value) in input { settings[key] = value }
                    state["settings"] = settings
                    return (Data("{\"ok\":true}".utf8), 200, 0.15)
                }
                actionStarts.append((path, Date()))
                if path == "/api/prs/105/recheck" { return (Data("{\"error\":\"This PR changed. Refresh and retry.\"}".utf8), 409, 0.08) }
                return (Data("{\"ok\":true}".utf8), 200, path.hasSuffix("mark-ready") || path.hasSuffix("request-approval") ? 0.7 : 0.18)
            }
            return (try! JSONSerialization.data(withJSONObject: state), 200, 0)
        }
    }
    func approvalRequested() {
        lock.withLock {
            var records = state["prs"] as! [[String: Any]]
            let index = records.firstIndex { ($0["snapshot"] as! [String: Any])["number"] as? Int == 104 }!
            let snapshot = records[index]["snapshot"] as! [String: Any]
            records[index]["approval"] = ["head": snapshot["head"]!, "status": "requested", "canRequest": false, "reason": "Stamphog requested for this commit"]
            records[index]["decision"] = ["kind": "approval", "reason": "Stamphog requested; waiting for approval on this commit"]
            state["prs"] = records
        }
    }
    func promote() {
        lock.withLock {
            var records = state["prs"] as! [[String: Any]]
            let index = records.firstIndex { ($0["snapshot"] as! [String: Any])["number"] as? Int == 104 }!
            var snapshot = records[index]["snapshot"] as! [String: Any]; snapshot["draft"] = false
            records[index]["snapshot"] = snapshot
            records[index]["decision"] = ["kind": "waiting", "reason": "Watching GitHub"]
            state["prs"] = records
        }
    }
}
final class DelayedController: URLProtocol, @unchecked Sendable {
    static let server = MockController()
    private let lock = NSLock()
    private var cancelled = false
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (payload, status, delay) = Self.server.response(request)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            Self.server.waitForResponse(request.url!.path)
            guard !lock.withLock({ cancelled }) else { return }
            if request.url?.path.hasSuffix("mark-ready") == true { Self.server.promote() }
            if request.url?.path.hasSuffix("request-approval") == true { Self.server.approvalRequested() }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: payload)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { lock.withLock { cancelled = true } }
}

@main
@MainActor
struct InteractionSmoke {
    static func until(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        preconditionFailure("Timed out waiting for interaction state")
    }
    static func checkSections(_ payload: [String: Any]) throws {
        let base = (payload["prs"] as! [[String: Any]])[0]
        func record(_ number: Int, _ kind: String, _ reason: String, paused: Bool = false, draft: Bool = false, watching: Bool = true, job: String? = nil, extra: [String: Any] = [:]) -> [String: Any] {
            var result = base
            var snapshot = base["snapshot"] as! [String: Any]
            snapshot["number"] = number; snapshot["draft"] = draft
            result["snapshot"] = snapshot; result["decision"] = ["kind": kind, "reason": reason]
            result["paused"] = paused; result["watching"] = watching
            result.removeValue(forKey: "job")
            if let job { result["job"] = ["name": job, "startedAt": "2026-01-01T00:00:00Z"] }
            result.merge(extra) { _, next in next }
            return result
        }
        let reasons = [201: "Waiting for checks to finish", 202: "Waiting for review from Team Surfaces, Team Agent Infrastructure, Team Self-Driving", 203: "Waiting for PostHog Review on this commit", 204: "Checking the result against GitHub", 205: "Paused by you", 206: "7 failing checks", 207: "Your reply is queued until a run slot is available", 208: "Skipped this run on the current commit", 216: "Waiting for a repository policy check"]
        var data = payload
        data["mode"] = "auto"
        data["prs"] = [
            record(201, "waiting", reasons[201]!), record(202, "waiting", reasons[202]!),
            record(203, "review", reasons[203]!), record(204, "waiting", reasons[204]!, job: "finished"),
            record(205, "paused", reasons[205]!, paused: true), record(206, "fix", reasons[206]!),
            record(207, "waiting", reasons[207]!, extra: ["pendingReply": "An answer"]),
            record(208, "paused", reasons[208]!), record(209, "ready", "Ready for your merge decision"),
            record(210, "paused", "Draft PR", paused: true, draft: true), record(211, "human", "Choose an approach"),
            record(212, "waiting", "Coding agent is working", job: "live"),
            record(213, "paused", "Not watching", paused: true, watching: false),
            record(214, "closed", "Merged", extra: ["snapshot": (base["snapshot"] as! [String: Any]).merging(["number": 214, "state": "MERGED", "draft": false]) { _, next in next }]),
            record(215, "ready", "Checking readiness", extra: ["readiness": ["id": "expired", "head": "preview", "ready": false, "fresh": false, "reasons": ["Readiness expired"], "summary": ["passed": 1, "failed": 0, "pending": 0, "skipped": 0, "open_threads": 0]]]),
            record(216, "waiting", reasons[216]!), record(217, "waiting", "Saved run queued to continue", extra: ["resumeRequested": "now"]),
            record(218, "waiting", "Reconnecting the saved run", extra: ["recovery": ["attempts": 1, "kind": "resume", "retryAt": "2026-01-01T00:00:00Z"]]),
            record(219, "fix", "Repair requested by you", extra: ["runRequested": true]),
            record(220, "waiting", "Coding agent is working"),
        ]
        data["runs"] = [
            ["id": "finished", "number": 204, "startedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T00:01:00Z", "state": "succeeded", "model": "test", "turns": 1, "summary": "Done"],
            ["id": "live", "number": 212, "startedAt": "2026-01-01T00:00:00Z", "state": "running", "model": "test", "turns": 1, "summary": "Working"],
        ]
        func decode() throws -> InboxState { try JSONDecoder().decode(InboxState.self, from: JSONSerialization.data(withJSONObject: data)) }
        let model = InboxModel(previewState: try decode())
        let expected: [Int: PRListSection] = [201: .waiting, 202: .waiting, 203: .waiting, 204: .waiting, 205: .paused, 206: .queued, 207: .queued, 208: .paused, 209: .ready, 210: .drafts, 211: .attention, 212: .running, 213: .unwatched, 215: .waiting, 216: .waiting, 217: .queued, 218: .queued, 219: .queued, 220: .waiting]
        let allGroups = [model.attention, model.running, model.draftPRs, model.queued, model.ready, model.waiting, model.pausedPRs, model.unwatched].flatMap { $0 }
        for row in model.state!.prs {
            precondition(model.section(for: row) == expected[row.id], "Incorrect section for \(row.id)")
            precondition(allGroups.filter { $0.id == row.id }.count == (expected[row.id] == nil ? 0 : 1), "Sections must not lose or duplicate a PR")
            if let reason = reasons[row.id], [.waiting, .paused].contains(expected[row.id]) {
                precondition(model.listStatus(row) == reason, "Keep the actual waiting reason, including reviewer names and unknown reasons")
            }
        }
        precondition(model.listStatus(model.state!.prs.first { $0.id == 215 }!) == "Readiness expired")
        precondition(model.listStatus(model.state!.prs.first { $0.id == 220 }!) == "Run status pending refresh", "A stale working reason cannot claim an active run without a job")
        model.selectedNumber = 206
        data["mode"] = "watch"; model.state = try decode()
        precondition(model.waiting.contains { $0.id == 206 } && model.queued.contains { $0.id == 219 }, "Watch mode only queues explicitly requested repairs")
        precondition(model.listStatus(model.selected!)?.contains("Watch mode") == true && model.selectedNumber == 206)
        data["mode"] = "paused"; model.state = try decode()
        precondition(model.queued.contains { $0.id == 206 } && model.running.contains { $0.id == 212 }, "Global pause keeps live work and queued work distinct from individually paused PRs")
        precondition(model.listStatus(model.selected!)?.hasPrefix("New work is paused") == true)
        var attentionData = base
        attentionData["decision"] = ["kind": "human", "reason": "Access is missing", "response": "recheck", "question": "Sign in to the CI provider and recheck"]
        attentionData["assessment"] = ["result": ["route": "ask", "title": "Connect CI", "evidence": []]]
        func attentionRecord() throws -> PullRequestRecord { try JSONDecoder().decode(PullRequestRecord.self, from: JSONSerialization.data(withJSONObject: attentionData)) }
        attentionData["snapshot"] = (base["snapshot"] as! [String: Any]).merging(["draft": false]) { _, next in next }
        attentionData["paused"] = false; attentionData.removeValue(forKey: "job")
        attentionData["queue"] = ["reason": "capacity", "message": "Waiting for a worker · 3 of 3 running"]
        attentionData["decision"] = ["kind": "fix", "reason": "1 failing check"]
        let queuedRepair = try attentionRecord()
        precondition(model.section(for: queuedRepair) == .queued && model.listStatus(queuedRepair) == "Waiting for a worker · 3 of 3 running", "Show the actual queue blocker instead of repeating failed-check counts")
        attentionData.removeValue(forKey: "queue")
        attentionData["decision"] = ["kind": "human", "reason": "Access is missing", "response": "recheck", "question": "Sign in to the CI provider and recheck"]
        let externalAction = try attentionRecord()
        precondition(!model.needsAnswer(externalAction), "An external action must not offer a question reply")
        attentionData["decision"] = ["kind": "human", "reason": "Choose an approach", "response": "reply"]
        let productChoice = try attentionRecord()
        precondition(model.needsAnswer(productChoice), "A product decision needs an answer")
        attentionData["decision"] = ["kind": "human", "reason": "Repair stopped", "response": "retry"]
        let stoppedRepair = try attentionRecord()
        precondition(!model.needsAnswer(stoppedRepair), "Retry instructions must start a repair rather than answer a question")
        report("PASS: disjoint PR sections, exact waiting reasons, paused/skipped PRs, completed runs, readiness expiry, Watch mode and paused queues")
    }
    static func checkSpendEdits(_ model: InboxModel) async throws {
        let draft = AmountSettingsDraft(maximum: 10_000, fractionDigits: 2, locale: Locale(identifier: "en_US"))
        let original: [String: Double] = ["runCapUSD": 5, "dailyCapUSD": 20]
        draft.receive(original)
        draft.edit("dailyCapUSD", text: "")
        draft.receive(original)
        precondition(draft.text["dailyCapUSD"] == "", "Live state must not replace an in-progress empty field")
        var submissions = 0
        let invalid = await draft.save { _ in submissions += 1; return nil }
        precondition(!invalid && submissions == 0, "Invalid amounts must not reach the controller")
        draft.edit("dailyCapUSD", text: "42.50")
        draft.receive(original)
        precondition(draft.text["dailyCapUSD"] == "42.50" && draft.hasChanges)
        DelayedController.server.lock.withLock { DelayedController.server.failSettings = true }
        let failed = await draft.save { values in
            await model.updateSettings(values.mapValues { $0 as Any }) ? nil : model.actionError ?? "Save failed"
        }
        precondition(!failed && draft.hasChanges && draft.error != nil && draft.text["dailyCapUSD"] == "42.50", "A rejected save must keep the draft and show failure")
        DelayedController.server.lock.withLock { DelayedController.server.failSettings = false }
        let saved = await draft.save { values in
            await model.updateSettings(values.mapValues { $0 as Any }) ? nil : model.actionError ?? "Save failed"
        }
        precondition(saved && draft.saved && !draft.hasChanges && model.state?.settings?.dailyCapUSD == 42.5, "A successful save must be confirmed by the controller")
        draft.edit("dailyCapUSD", text: "50")
        let pending = Task { await draft.save { values in
            try? await Task.sleep(for: .milliseconds(100))
            submissions += 1
            precondition(values["dailyCapUSD"] == 50, "The request uses the submitted snapshot")
            return nil
        } }
        try await until { draft.saving }
        draft.edit("dailyCapUSD", text: "60")
        draft.receive(original)
        _ = await pending.value
        precondition(draft.text["dailyCapUSD"] == "60" && draft.hasChanges && !draft.saved, "An acknowledgement cannot erase newer edits")
        for value in ["-1", "10001", "1.234", "12oops", "NaN"] {
            draft.edit("dailyCapUSD", text: value)
            precondition(draft.validationError != nil, "Reject invalid limits: \(value)")
        }
        let localized = AmountSettingsDraft(maximum: 10_000, fractionDigits: 2, locale: Locale(identifier: "de_DE"))
        localized.receive(["dailyCapUSD": 20]); localized.edit("dailyCapUSD", text: "12,50")
        let localizedSaved = await localized.save { values in precondition(values["dailyCapUSD"] == 12.5); return nil }
        precondition(localizedSaved && localized.saved, "Respect the locale's decimal separator")
        let rates = AmountSettingsDraft(maximum: 100_000, fractionDigits: 4, locale: Locale(identifier: "en_US"))
        rates.receive(["cached": 0.05]); rates.edit("cached", text: "0.0001")
        precondition(rates.validationError == nil)
        let rateSaved = await rates.save { values in precondition(values["cached"] == 0.0001); return nil }
        precondition(rateSaved)
        report("PASS: spend drafts survive refresh, validation, rejected saves and late acknowledgements; explicit saves persist; localized amounts and token-rate precision work")
    }
    static func checkMergeQueue(_ payload: [String: Any]) throws {
        var data = payload
        var records = data["prs"] as! [[String: Any]]
        var record = records[0]
        let number = (record["snapshot"] as! [String: Any])["number"] as! Int
        var snapshot = record["snapshot"] as! [String: Any]; snapshot["draft"] = false
        record["snapshot"] = snapshot; record.removeValue(forKey: "job")
        record["decision"] = ["kind": "waiting", "reason": "Trunk is testing this PR"]
        var queue: [String: Any] = ["state": "testing", "active": true, "url": "https://app.trunk.io/example/merge-queue/queue/104"]
        record["mergeQueue"] = queue; records[0] = record; data["prs"] = records
        func decoded() throws -> InboxState { try JSONDecoder().decode(InboxState.self, from: JSONSerialization.data(withJSONObject: data)) }
        let model = InboxModel(previewState: try decoded())
        precondition(model.section(for: model.state!.prs[0]) == .mergeQueue)
        precondition(model.mergeQueuePRs.contains { $0.id == number })
        queue["active"] = false; queue["state"] = "failed"
        queue["terminal"] = ["id": "attempt-1", "reason": "Tests failed", "acknowledged": false]
        record["mergeQueue"] = queue; record["decision"] = ["kind": "human", "reason": "Queue tests failed", "id": "old-decision"]
        records[0] = record; data["prs"] = records; model.state = try decoded()
        let first = model.state!.prs[0]
        precondition(model.section(for: first) == .attention)
        snapshot["head"] = "changed-head"; record["snapshot"] = snapshot
        record["decision"] = ["kind": "human", "reason": "Queue tests failed", "id": "new-decision"]
        records[0] = record; data["prs"] = records; model.state = try decoded()
        precondition(model.notificationVersion(first) == model.notificationVersion(model.state!.prs[0]))
        queue["terminal"] = ["id": "attempt-2", "reason": "Tests failed"]
        record["mergeQueue"] = queue; records[0] = record; data["prs"] = records; model.state = try decoded()
        precondition(model.notificationVersion(first) != model.notificationVersion(model.state!.prs[0]))
        report("PASS: Trunk queue progress has its own section; terminal events need attention and notify once per attempt across head changes")
    }
    static func report(_ message: String) { print(message); fflush(nil) }
    static func main() async throws {
        _ = NSApplication.shared
        let args = CommandLine.arguments
        guard args.count == 2 else { fatalError("Expected the synthetic draft fixture") }
        var payload = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [String: Any]
        payload["demo"] = false
        var gate = NotificationStability()
        let start = Date(timeIntervalSince1970: 100)
        precondition(!gate.ready("42", version: "question", at: start))
        precondition(!gate.ready("42", version: "question", at: start.addingTimeInterval(4)))
        precondition(gate.ready("42", version: "question", at: start.addingTimeInterval(5)))
        precondition(!gate.ready("42", version: "new question", at: start.addingTimeInterval(6)))
        gate.retain([])
        precondition(!gate.ready("42", version: "new question", at: start.addingTimeInterval(20)))
        report("PASS: notifications wait for a stable decision and reset when attention changes or disappears")
        try checkMergeQueue(payload)
        try checkSections(payload)
        DelayedController.server.state = payload
        URLProtocol.registerClass(DelayedController.self)
        let token = FileManager.default.temporaryDirectory.appendingPathComponent("woodshed-smoke-\(UUID().uuidString)")
        try String(repeating: "x", count: 64).write(to: token, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: token); UserDefaults.standard.removeObject(forKey: "replyDrafts") }
        setenv("WOODSHED_TOKEN_PATH", token.path, 1)
        let model = InboxModel()
        model.state = try JSONDecoder().decode(InboxState.self, from: JSONSerialization.data(withJSONObject: payload))
        model.connected = true; model.selectedNumber = 104
        let draft = model.selected!
        model.selectingDrafts = true; model.selectDraft(104, selected: true)
        model.selectedNumber = 105
        precondition(model.selectedDrafts == [104] && model.selected?.id == 105, "Bulk selection and navigation must be independent")
        model.finishDraftSelection()
        precondition(model.selected?.id == 105 && model.selectedDrafts.isEmpty)
        model.selectedNumber = 104
        model.showMain(104)
        let window = NSApp.windows.first { $0.identifier?.rawValue == "woodshed-main" }!
        let toolbar = window.toolbar!
        for number in [105, 106, 107, 104, nil, 104, 105, 104] as [Int?] {
            model.selectedNumber = number
            await Task.yield()
            precondition(window.title == "Woodshed" && window.titleVisibility == .visible && window.toolbar === toolbar, "Navigation must not replace or hide window chrome")
        }
        let action = Task { await model.act("mark-ready", on: draft) }
        try await until { model.executingAction == 104 }
        precondition(model.pendingActions[104] == "mark-ready", "Actions need immediate feedback")
        model.selectedNumber = 105
        let other = model.selected!
        precondition(model.canAct(on: other), "Other PR controls must remain actionable")
        let queued = Task { await model.act("recheck", on: other) }
        try await until { model.pendingActions[105] != nil }
        precondition(model.progressLabel(105)?.hasPrefix("Queued") == true, "Queued actions must not claim to have reached GitHub")
        model.selectedNumber = 104
        // Hold the HTTP response until navigation and queued actions have been
        // exercised. Shared CI runner speed must not decide whether I/O finished.
        for _ in 0..<20 { try await Task.sleep(for: .milliseconds(10)) }
        precondition(model.pendingActions[104] != nil && model.selectedNumber == 104, "Navigation and progress must work before the HTTP response arrives")
        DelayedController.server.allowResponse("/api/prs/104/mark-ready")
        let success = await action.value
        precondition(success && model.selectedNumber == 104 && model.selected?.snapshot.draft == false, "Moving sections must preserve the selected PR")
        model.selectedNumber = 106
        let failed = await queued.value
        precondition(!failed && model.prActionErrors[105] != nil && model.error(for: model.selected!) == nil, "Failures belong to the originating PR even after navigation")
        model.selectedNumber = 105
        precondition(model.error(for: model.selected!)?.contains("changed") == true)
        precondition(model.pendingActions.isEmpty && model.executingAction == nil)
        report("PASS: stable title, independent checkboxes, section changes, queued actions, navigation and scoped failures")

        DelayedController.server.lock.withLock { DelayedController.server.failSettings = true }
        model.setMode(.watch)
        precondition(model.pendingMode == .watch && model.mode == .auto, "Mode controls need immediate, honest pending feedback")
        try await until { model.pendingMode == nil }
        precondition(model.mode == .auto && model.actionError != nil, "A failed mode save must restore the confirmed mode")
        DelayedController.server.lock.withLock { DelayedController.server.failSettings = false }
        model.setMode(.watch)
        try await until { model.pendingMode == nil }
        precondition(model.mode == .watch, "Successful saves must confirm the requested mode")
        report("PASS: immediate mode feedback, failure rollback and successful confirmation")
        try await checkSpendEdits(model)

        window.contentView = nil
        model.selectedNumber = nil
        DelayedController.server.lock.withLock { DelayedController.server.agentLoads = [:] }
        model.selectedNumber = 106
        let oldOutput = Task { await model.loadAgent() }
        try await until { model.readingAgent }
        model.selectedNumber = 107
        await model.loadAgent()
        precondition(model.agent?.name == "ws-107-preview")
        model.selectedNumber = 106
        await model.loadAgent()
        await oldOutput.value
        precondition(model.agent?.name == "ws-106-preview" && model.agent?.output == "current output", "A late response must not overwrite the current output after navigating away and back")
        report("PASS: stale agent responses cannot overwrite newer output")

        model.selectedNumber = 105
        model.drafts[105] = "First answer"
        let send = Task { await model.sendDraft(other, isReply: true) }
        try await until { model.pendingActions[105] != nil }
        model.drafts[105] = "New text typed while sending"
        model.selectedNumber = 104
        let sent = await send.value
        precondition(sent && model.drafts[105] == "New text typed while sending", "Acknowledgements must not erase newer text")
        let restored = InboxModel()
        precondition(restored.drafts[105] == model.drafts[105], "Unsent drafts must survive relaunch")
        let sentAgain = await model.sendDraft(other, isReply: true)
        precondition(sentAgain && model.drafts[105] == nil, "Clear only the exact draft acknowledged by the controller")
        report("PASS: reply drafts survive navigation and relaunch; late acknowledgements preserve edits")
        DelayedController.server.lock.withLock {
            var records = DelayedController.server.state["prs"] as! [[String: Any]]
            let index = records.firstIndex { ($0["snapshot"] as! [String: Any])["number"] as? Int == 104 }!
            let snapshot = records[index]["snapshot"] as! [String: Any]
            records[index]["approval"] = ["head": snapshot["head"]!, "status": "available", "canRequest": true, "reason": "Ready to request Stamphog approval"]
            DelayedController.server.state["prs"] = records
        }
        await model.refresh(); model.selectedNumber = 104
        precondition(model.canRequestApproval(model.selected!), "The manual approval control must be available for an eligible commit")
        let approvalRecord = model.selected!
        let approval = Task { await model.act("request-approval", on: approvalRecord) }
        try await until { model.executingAction == 104 }
        precondition(model.progressLabel(104) == "Requesting Stamphog approval…")
        precondition(!model.canRequestApproval(approvalRecord), "Prevent duplicate requests while the first is pending")
        model.selectedNumber = 105
        precondition(model.canAct(on: model.selected!), "Other PRs remain actionable during an approval request")
        try await Task.sleep(for: .milliseconds(100))
        precondition(model.pendingActions[104] == "request-approval")
        DelayedController.server.allowResponse("/api/prs/104/request-approval")
        let approvalSent = await approval.value
        model.selectedNumber = 104
        precondition(approvalSent && model.selected?.approval?.status == "requested")
        precondition(!model.canRequestApproval(model.selected!), "Requested must stay distinct from approval and prevent duplicate submissions")
        report("PASS: Stamphog requests show local progress, preserve navigation, and become requested after acknowledgement")
        window.close()

        let dockModel = InboxModel(previewState: model.state!)
        let delegate = WoodshedApplicationDelegate(model: dockModel)
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        precondition(NSApp.activationPolicy() == .regular, "Woodshed must participate in the Dock and app switcher")
        let mainWindow = NSApp.windows.first { $0.identifier?.rawValue == "woodshed-main" && $0.isVisible }!
        dockModel.selectedNumber = 106
        dockModel.drafts[106] = "Preserve this unsent reply"
        mainWindow.close()
        precondition(!delegate.applicationShouldTerminateAfterLastWindowClosed(NSApp), "Closing the main window must leave the app running")
        precondition(!delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false))
        precondition(mainWindow.isVisible && mainWindow.title == "Woodshed", "A Dock reopen must restore the same main window")
        precondition(dockModel.selectedNumber == 106 && dockModel.drafts[106] == "Preserve this unsent reply", "Dock reopening must retain navigation and drafts")
        mainWindow.miniaturize(nil)
        try await until { mainWindow.isMiniaturized }
        _ = delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: true)
        try await until { !mainWindow.isMiniaturized }
        precondition(mainWindow.isVisible && dockModel.selectedNumber == 106, "Clicking the Dock must restore a minimized window")
        _ = delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: true)
        precondition(NSApp.windows.filter { $0.identifier?.rawValue == "woodshed-main" && $0.isVisible }.count == 1, "Repeated Dock clicks must not duplicate the window")
        delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
        mainWindow.close()
        report("PASS: Dock launch, reopen after close, minimized-window restoration and single-window state preservation")
    }
}
