import SwiftUI
import UserNotifications
import AppKit

@MainActor
final class InboxModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate, NSToolbarDelegate {
    @Published var state: InboxState? { didSet { updateMainToolbar() } }
    @Published var connected = false { didSet { updateMainToolbar() } }
    @Published var lastReceivedAt: Date?
    @Published var refreshing = false { didSet { updateMainToolbar() } }
    @Published var pendingActions: [Int: String] = [:]
    @Published var serviceActionPending = false { didSet { updateMainToolbar() } }
    @Published var pendingMode: Mode? { didSet { updateMainToolbar() } }
    @Published private(set) var executingAction: Int?
    @Published private(set) var prActionErrors: [Int: String] = [:]
    @Published var agentOutputVisible = false
    @Published var selectingDrafts = false
    @Published private(set) var selectedDrafts = Set<Int>()
    @Published private(set) var promotingDrafts = false
    @Published var actionError: String?
    @Published var connectionError: String?
    @Published var selectedNumber: Int? { didSet { if oldValue != selectedNumber { selectionChanged() } } }
    @Published var startTaskNumber: Int?
    @Published var agent: AgentSnapshot?
    @Published var agentError: String?
    @Published var readingAgent = false
    @Published var notificationsEnabled = false
    @Published var notificationPermission = "unknown"
    @Published var settingsTab = "general"
    @Published var drafts: [Int: String] = [:] {
        didSet { if !preview { UserDefaults.standard.set(Dictionary(uniqueKeysWithValues: drafts.map { (String($0.key), $0.value) }), forKey: "replyDrafts") } }
    }
    @Published var notifyNeeds: Bool { didSet { UserDefaults.standard.set(notifyNeeds, forKey: "notifyNeeds") } }
    @Published var notifyReady: Bool { didSet { UserDefaults.standard.set(notifyReady, forKey: "notifyReady") } }
    @Published var notifyFinished: Bool { didSet { UserDefaults.standard.set(notifyFinished, forKey: "notifyFinished") } }
    private var seen = UserDefaults.standard.dictionary(forKey: "notificationStates") as? [String: String] ?? [:]
    private var seenFinished = Set(UserDefaults.standard.stringArray(forKey: "finishedRuns") ?? [])
    private var windows: [String: NSWindow] = [:]
    private var mainModeControl: NSSegmentedControl?
    private var mainStatusField: NSTextField?
    private var mainRefreshItem: NSToolbarItem?
    private var settingsTail: Task<Bool, Never>?
    private var settingsTaskID: UUID?
    private var actionTail: Task<Bool, Never>?
    private var actionTaskID: UUID?
    private var agentRequestID: UUID?
    private var agentRequestJob: String?
    private var lastAgentFetch = Date.distantPast
    private var lastNotificationCheck = Date.distantPast
    private var appOpenTracked = false
    private var streamGeneration = 0
    private var updatingNotifications = false
    let baseURL: URL
    let preview: Bool
    let remoteMachine: String?
    private let tokenURL: URL
    private let connectionConfigError: String?

    init(previewState: InboxState? = nil) {
        preview = previewState != nil; state = previewState; connected = previewState != nil
        notifyNeeds = UserDefaults.standard.object(forKey: "notifyNeeds") as? Bool ?? true
        notifyReady = UserDefaults.standard.object(forKey: "notifyReady") as? Bool ?? true
        notifyFinished = UserDefaults.standard.object(forKey: "notifyFinished") as? Bool ?? true
        let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Woodshed")
        let connectionFile = support.appendingPathComponent("controller.json")
        var configuration: [String: String] = [:]
        var configurationError: String?
        if previewState == nil && FileManager.default.fileExists(atPath: connectionFile.path) {
            do {
                let attributes = try FileManager.default.attributesOfItem(atPath: connectionFile.path)
                guard attributes[.type] as? FileAttributeType == .typeRegular,
                      (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                      ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o022 == 0,
                      (attributes[.size] as? NSNumber)?.intValue ?? 4097 <= 4096 else { throw ServiceError(message: "Secure the controller connection file before reconnecting.") }
                configuration = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: connectionFile))
                guard let raw = configuration["url"], let url = URLComponents(string: raw), url.scheme == "http", url.host == "127.0.0.1", url.user == nil, url.password == nil,
                      url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
                      let token = configuration["token_path"], token.hasPrefix("/"), !token.contains("\n"),
                      let machine = configuration["machine"], machine.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$", options: .regularExpression) != nil else { throw ServiceError(message: "The controller connection file is invalid.") }
            } catch { configurationError = error.localizedDescription }
        }
        baseURL = URL(string: ProcessInfo.processInfo.environment["WOODSHED_URL"] ?? configuration["url"] ?? "http://127.0.0.1:7341") ?? URL(string: "http://127.0.0.1:7341")!
        remoteMachine = configuration["machine"]
        tokenURL = ProcessInfo.processInfo.environment["WOODSHED_TOKEN_PATH"].map { URL(fileURLWithPath: $0) } ?? configuration["token_path"].map { URL(fileURLWithPath: $0) } ?? support.appendingPathComponent("api-token")
        connectionConfigError = configurationError
        super.init()
        if !preview, let saved = UserDefaults.standard.dictionary(forKey: "replyDrafts") as? [String: String] {
            drafts = Dictionary(uniqueKeysWithValues: saved.compactMap { key, value in Int(key).map { ($0, value) } })
        }
        UNUserNotificationCenter.current().delegate = self
        registerNotificationActions()
        if !preview {
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(willSleep), name: NSWorkspace.willSleepNotification, object: nil)
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)
        }
    }
    var mode: Mode { state?.mode ?? state?.settings?.mode ?? (state?.settings?.paused == true ? .paused : state?.automation == true ? .auto : .watch) }
    var active: [PullRequestRecord] { state?.prs.filter { $0.snapshot.state == "OPEN" && $0.isWatched } ?? [] }
    // Every open PR has one section; menus and the main list share this classification.
    func section(for record: PullRequestRecord) -> PRListSection? {
        guard record.snapshot.state == "OPEN" else { return nil }
        if record.snapshot.draft { return .drafts }
        if !record.isWatched { return .unwatched }
        if record.paused || record.decision.kind == "paused" { return .paused }
        if record.decision.kind == "human" { return .attention }
        if record.job != nil, record.pendingReply == nil, lastRun(record)?.live ?? true { return .running }
        if record.decision.kind == "ready", record.readiness?.ready != false { return .ready }
        if record.pendingReply != nil || record.resumeRequested != nil || record.recovery?.retryAt != nil { return .queued }
        if record.decision.kind == "fix", mode != .watch || record.runRequested == true { return .queued }
        return .waiting
    }
    private func records(in section: PRListSection) -> [PullRequestRecord] { state?.prs.filter { self.section(for: $0) == section } ?? [] }
    var draftPRs: [PullRequestRecord] { records(in: .drafts) }
    var attention: [PullRequestRecord] { records(in: .attention) }
    var ready: [PullRequestRecord] { records(in: .ready) }
    var running: [PullRequestRecord] { records(in: .running) }
    var queued: [PullRequestRecord] { records(in: .queued) }
    var waiting: [PullRequestRecord] { records(in: .waiting) }
    var pausedPRs: [PullRequestRecord] { records(in: .paused) }
    var unwatched: [PullRequestRecord] { records(in: .unwatched) }
    func listStatus(_ record: PullRequestRecord) -> String? {
        switch section(for: record) {
        case .waiting:
            if record.job == nil, record.decision.reason == "Coding agent is working" { return "Run status pending refresh" }
            if record.decision.kind == "ready" { return record.statusLabel }
            if record.decision.kind == "fix" { return "Repair needed in Watch mode · " + record.decision.reason }
            return record.decision.reason
        case .queued:
            let reason = record.decision.reason
            let description = record.decision.kind == "fix" && !reason.hasPrefix("Queued") ? "Queued for repair · " + reason : reason
            return mode == .paused ? "New work is paused · " + description : description
        case .paused:
            return record.paused && record.decision.kind != "paused" ? "Paused by you" : record.decision.reason
        default: return nil
        }
    }
    var selected: PullRequestRecord? { state?.prs.first { $0.id == selectedNumber } }
    var actionPending: Bool { selectedNumber.map { pendingActions[$0] != nil } ?? serviceActionPending }
    var refreshingPR: Bool { selectedNumber.map { pendingActions[$0] == "recheck" } ?? false }
    var canAct: Bool { connected && (preview || state?.demo != true) && !actionPending }
    func canAct(on record: PullRequestRecord) -> Bool { connected && (preview || state?.demo != true) && pendingActions[record.id] == nil }
    func canRequestApproval(_ record: PullRequestRecord) -> Bool {
        canAct(on: record) && record.approval?.head == record.snapshot.head && record.approval?.canRequest == true
    }
    var canSaveSettings: Bool { connected && (preview || state?.demo != true) && !serviceActionPending }
    func progressLabel(_ number: Int) -> String? {
        guard let action = pendingActions[number] else { return nil }
        if executingAction != number { return "Queued · waiting for the previous action…" }
        switch action {
        case "request-approval": return "Requesting Stamphog approval…"
        case "mark-ready": return "Marking ready on GitHub…"
        case "mark-draft": return "Converting to draft…"
        case "recheck": return "Checking GitHub…"
        case "reply", "confirm-reply": return "Sending your reply…"
        case "retry": return "Queuing your run…"
        default: return "Updating this PR…"
        }
    }
    var githubConnectionIssue: String? {
        if let message = state?.health?.githubError { return message }
        if attention.contains(where: { record in
            let text = record.decision.reason + " " + (lastRun(record)?.prompt?.text ?? "")
            return text.localizedCaseInsensitiveContains("github") && (text.localizedCaseInsensitiveContains("authentication") || text.localizedCaseInsensitiveContains("credential") || text.localizedCaseInsensitiveContains("access"))
        }) { return "Reconnect GitHub to continue monitoring and repairs." }
        return nil
    }
    func needsAnswer(_ record: PullRequestRecord) -> Bool {
        if let response = record.decision.response { return response == "reply" }
        return record.assessment?.result?.route == "ask" || record.job != nil && lastRun(record)?.prompt?.kind == "question"
    }
    var notificationBroken: Bool { notificationPermission == "denied" && (notifyNeeds || notifyReady || notifyFinished) }
    var attentionCount: Int { attention.count + (notificationBroken ? 1 : 0) }
    var status: String {
        if !connected { return state == nil ? "Connecting…" : "Controller unavailable" }
        if preview || state?.demo == true { return "Preview" }
        return mode.label
    }
    var allRuns: [AgentRun] { state?.runs ?? [] }
    func runs(_ record: PullRequestRecord) -> [AgentRun] { allRuns.filter { $0.number == record.id } }
    func lastRun(_ record: PullRequestRecord) -> AgentRun? {
        if let job = record.job, let run = allRuns.first(where: { $0.id == job.name }) { return run }
        if record.decision.kind == "ready", let completed = runs(record).filter({ $0.state == "succeeded" && !$0.id.hasPrefix("ws-triage-") && !$0.id.hasPrefix("jev-") }).sorted(by: { (parseDate($0.endedAt ?? $0.startedAt) ?? .distantPast) > (parseDate($1.endedAt ?? $1.startedAt) ?? .distantPast) }).first { return completed }
        return runs(record).first
    }
    func modelName(_ id: String) -> String { state?.models?.first { $0.id == id }?.name ?? id }
    func prSpend(_ record: PullRequestRecord) -> String {
        if let entry = state?.spend?.prTotals[String(record.id)] { return entry.map(currency) ?? "Unavailable" }
        return lastRun(record)?.costUSD.map(currency) ?? "Measuring…"
    }
    var defaultModelName: String {
        if let id = state?.settings?.defaultModel, !id.isEmpty { return modelName(id) }
        return state?.models?.first { $0.isDefault }?.name ?? "Codex default"
    }
    var spendFooter: String {
        guard let spend = state?.spend else { return "Estimated usage appears after the first run" }
        if spend.unknownRuns > 0 { return "Usage unavailable for \(spend.unknownRuns) run(s)" }
        return "Est. today \(currency(spend.spentUSD)) of \(currency(spend.capUSD)) · \(spend.runs) runs"
    }

    private func authenticatedRequest(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        if let connectionConfigError { throw ServiceError(message: connectionConfigError) }
        guard baseURL.scheme == "http", baseURL.host == "127.0.0.1" else { throw ServiceError(message: "Woodshed requires a local controller") }
        let token = try String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count == 64 else { throw ServiceError(message: "The controller credential is unavailable. Restart Woodshed’s controller.") }
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method; request.timeoutInterval = 30; request.cachePolicy = .reloadIgnoringLocalCacheData; request.httpShouldHandleCookies = false
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }
    private func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        let request = try authenticatedRequest(path, method: method, body: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ServiceError(message: (try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "The controller couldn’t complete this request.")
        }
        return try await Task.detached(priority: .userInitiated) { try JSONDecoder().decode(T.self, from: data) }.value
    }
    func run() async {
        await refresh()
        if !preview && state?.demo != true {
            let authorization = await notificationAuthorization()
            if authorization.notDetermined { await enableNotifications() }
        }
        var retry = 1
        while !Task.isCancelled && !preview {
            do {
                var request = try authenticatedRequest("api/events"); request.timeoutInterval = 86400
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ServiceError(message: "The controller rejected the connection. Reconnect to try again.") }
                for try await line in bytes.lines {
                    if Task.isCancelled { return }
                    lastReceivedAt = Date()
                    if line.hasPrefix("data: "), let data = String(line.dropFirst(6)).data(using: .utf8) {
                        let next = try await Task.detached(priority: .userInitiated) { try JSONDecoder().decode(InboxState.self, from: data) }.value
                        streamGeneration += 1
                        await accept(next); retry = 1
                    }
                }
                throw ServiceError(message: "The controller connection closed.")
            } catch {
                connected = false; connectionError = error.localizedDescription
                do { try await Task.sleep(for: .seconds(retry)) } catch { return }
                retry = min(retry * 2, 30)
            }
        }
    }
    private func accept(_ next: InboxState) async {
        let previousJob = selected?.job?.name
        state = next; lastReceivedAt = Date()
        selectedDrafts.formIntersection(Set(draftPRs.map(\.id)))
        if previousJob != selected?.job?.name { resetAgent() }
        connected = true; connectionError = nil
        if !appOpenTracked && !preview && !next.demo { appOpenTracked = true; track("app", event: "ui") }
        Task { await updateNotifications() }
        if windows["main"]?.isVisible == true, selected?.job != nil, agentOutputVisible || previousJob != selected?.job?.name { Task { await loadAgent() } }
    }
    func refresh() async {
        guard !refreshing, !preview else { return }
        refreshing = true; defer { refreshing = false }
        let generation = streamGeneration
        do {
            let next: InboxState = try await request("api/state")
            if generation == streamGeneration { await accept(next) }
        }
        catch { connected = false; connectionError = error.localizedDescription }
    }
    func recheck(_ record: PullRequestRecord) async {
        guard pendingActions[record.id] == nil else { return }
        _ = await act("recheck", on: record)
    }
    func track(_ action: String, number: Int? = nil, event: String = "action") {
        guard !preview else { return }
        var body: [String: Any] = ["action": action, "event": event]
        if let number { body["number"] = number }
        Task { let _: APIAcknowledgement? = try? await request("api/analytics", method: "POST", body: body) }
    }
    var connectionSummary: String {
        let age = lastReceivedAt.map { shortAge(ISO8601DateFormatter().string(from: $0)) } ?? shortAge(state?.lastSync)
        return "Controller isn’t responding" + (age.isEmpty ? "" : " · last update " + age + " ago")
    }
    @objc private func willSleep() {
        guard remoteMachine == nil else { return }
        Task { let _: APIAcknowledgement? = try? await request("api/power", method: "POST", body: ["event": "sleep"]) }
    }
    @objc private func didWake() {
        Task {
            if remoteMachine == nil { let _: APIAcknowledgement? = try? await request("api/power", method: "POST", body: ["event": "wake"]) }
            await refresh()
        }
    }
    @discardableResult
    func perform(_ path: String, body: [String: Any] = [:]) async -> Bool {
        guard !serviceActionPending, !preview else { return false }
        serviceActionPending = true; actionError = nil; defer { serviceActionPending = false }
        do {
            let _: APIAcknowledgement = try await request(path, method: "POST", body: body)
            await refresh(); return true
        } catch { actionError = error.localizedDescription; return false }
    }
    @discardableResult
    func act(_ action: String, on record: PullRequestRecord, message: String? = nil, reviewer: String? = nil, model: String? = nil, promptId: String? = nil, amount: Double? = nil, decisionId: String? = nil, questionKey: String? = nil, headOverride: String? = nil, source: String = "native_app") async -> Bool {
        guard !preview, canAct(on: record) else { return false }
        pendingActions[record.id] = action
        defer { pendingActions.removeValue(forKey: record.id) }
        prActionErrors.removeValue(forKey: record.id)
        var body: [String: Any] = ["head": headOverride ?? record.snapshot.head, "source": source]
        if let decisionId = decisionId ?? record.decision.id { body["decisionId"] = decisionId }
        if let questionKey = questionKey ?? record.decision.questionKey { body["questionKey"] = questionKey }
        if let runId = record.job?.name { body["runId"] = runId }
        if let amount { body["amount"] = amount }
        if let message { body["message"] = message }
        if let reviewer { body["reviewer"] = reviewer }
        if let model { body["model"] = model }
        if let prompt = promptId ?? (agent?.name == record.job?.name ? agent?.promptId : nil) ?? lastRun(record)?.prompt?.id { body["promptId"] = prompt }
        let previous = actionTail
        let taskID = UUID(); actionTaskID = taskID
        let task = Task { @MainActor in
            _ = await previous?.value
            self.executingAction = record.id
            defer { if self.executingAction == record.id { self.executingAction = nil } }
            do {
                let _: APIAcknowledgement = try await self.request("api/prs/\(record.id)/\(action)", method: "POST", body: body)
                await self.refresh()
                return true
            } catch {
                self.prActionErrors[record.id] = error.localizedDescription
                await self.refresh()
                return false
            }
        }
        actionTail = task
        let success = await task.value
        if actionTaskID == taskID { actionTail = nil; actionTaskID = nil }
        return success
    }

    @discardableResult
    func updateSettings(_ values: [String: Any]) async -> Bool {
        let previous = settingsTail
        let taskID = UUID(); settingsTaskID = taskID
        let task = Task { @MainActor in
            _ = await previous?.value
            let deadline = Date().addingTimeInterval(10)
            while self.serviceActionPending && Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
            return await self.perform("api/settings", body: values)
        }
        settingsTail = task
        let success = await task.value
        if settingsTaskID == taskID { settingsTail = nil; settingsTaskID = nil }
        return success
    }
    func selectDraft(_ number: Int, selected: Bool) {
        guard !promotingDrafts else { return }
        if selected { selectedDrafts.insert(number) } else { selectedDrafts.remove(number) }
    }
    func finishDraftSelection() { guard !promotingDrafts else { return }; selectedDrafts = []; selectingDrafts = false }
    var eligibleDrafts: [PullRequestRecord] { draftPRs.filter { selectedDrafts.contains($0.id) && $0.canMarkReady == true && canAct(on: $0) } }
    func promoteSelectedDrafts() {
        let records = eligibleDrafts
        guard !records.isEmpty, !promotingDrafts else { return }
        promotingDrafts = true
        Task {
            // Register every operation immediately; the action queue preserves controller ordering.
            let tasks = records.map { record in Task { await self.act("mark-ready", on: record) } }
            for (record, task) in zip(records, tasks) {
                if await task.value { selectedDrafts.remove(record.id) }
            }
            promotingDrafts = false
            if selectedDrafts.isEmpty { selectingDrafts = false }
        }
    }
    func setMode(_ value: Mode) {
        guard pendingMode == nil, canSaveSettings, value != mode else { return }
        pendingMode = value
        Task {
            _ = await updateSettings(["mode": value.rawValue])
            pendingMode = nil
        }
    }
    @discardableResult
    func sendDraft(_ record: PullRequestRecord, isReply: Bool, model: String? = nil) async -> Bool {
        let text = drafts[record.id] ?? ""
        let success = await act(isReply ? "reply" : "retry", on: record, message: text, model: isReply ? nil : model)
        if success, drafts[record.id] == text, state?.prs.first(where: { $0.id == record.id })?.pendingAnswer == nil {
            drafts.removeValue(forKey: record.id)
        }
        return success
    }
    func error(for record: PullRequestRecord) -> String? { prActionErrors[record.id] ?? actionError ?? connectionError ?? record.lastError }
    func loadAgent(force: Bool = false) async {
        guard let record = selected, let job = record.job else { return }
        if agentRequestJob == job.name && (readingAgent || !force && Date().timeIntervalSince(lastAgentFetch) < 5) { return }
        if preview {
            agent = AgentSnapshot(name: record.job!.name, state: "blocked", kind: "question", message: lastRun(record)?.prompt?.text ?? "Should paused reports stay visible?", output: "Read the review feedback and compared both implementations.\nWaiting for your answer before changing the filter.", promptId: "preview-question")
            return
        }
        let requestID = UUID(); agentRequestID = requestID; agentRequestJob = job.name
        readingAgent = true; agentError = nil
        defer { if agentRequestID == requestID { readingAgent = false; lastAgentFetch = Date() } }
        do {
            let next: AgentSnapshot = try await request("api/prs/\(record.id)/agent")
            if agentRequestID == requestID && selectedNumber == record.id && selected?.job?.name == job.name { agent = next }
        } catch { if agentRequestID == requestID && selectedNumber == record.id { agentError = error.localizedDescription } }
    }
    private func resetAgent() {
        agentRequestID = nil; agentRequestJob = nil; readingAgent = false
        agent = nil; agentError = nil; lastAgentFetch = .distantPast
    }
    private func selectionChanged() { resetAgent(); agentOutputVisible = false }
    func showMain(_ number: Int? = nil) {
        track("main", event: "ui")
        if let number { selectedNumber = number }
        else if selectedNumber == nil { selectedNumber = attention.first?.id ?? running.first?.id ?? active.first?.id }
        showWindow("main", title: "Woodshed", size: NSSize(width: 950, height: 650), content: AnyView(MainView(model: self)))
    }
    func startTask(_ record: PullRequestRecord) {
        guard !record.snapshot.draft else { return }
        startTaskNumber = record.id
        showMain(record.id)
    }
    func showDetails(_ number: Int) { showMain(number) }
    func showActivity() { selectedNumber = nil; showWindow("main", title: "Woodshed", size: NSSize(width: 950, height: 650), content: AnyView(MainView(model: self))) }
    func showSettings(_ tab: String? = nil) {
        track("settings", event: "ui")
        if let tab { settingsTab = tab }
        let window = showWindow("settings", title: "Woodshed Settings", size: NSSize(width: 560, height: 560), content: AnyView(SettingsView(model: self)))
        configureSettingsToolbar(window)
    }
    func configureSettingsToolbar(_ window: NSWindow) {
        let toolbar = NSToolbar(identifier: "woodshed-settings")
        toolbar.delegate = self; toolbar.displayMode = .iconAndLabel; toolbar.allowsUserCustomization = false
        toolbar.selectedItemIdentifier = NSToolbarItem.Identifier(settingsTab)
        window.toolbar = toolbar; window.toolbarStyle = .preference
    }
    func configureMainToolbar(_ window: NSWindow) {
        let toolbar = NSToolbar(identifier: "woodshed-main")
        toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
        window.toolbar = toolbar; window.toolbarStyle = .unifiedCompact
        window.title = "Woodshed"; window.subtitle = ""; window.titleVisibility = .visible
        window.titlebarSeparatorStyle = .line
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        if toolbar.identifier == "woodshed-main" { return [.flexibleSpace, .init("connection"), .init("mode"), .init("refresh")] }
        return ["general", "automation", "notifications", "spend"].map { NSToolbarItem.Identifier($0) }
    }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarAllowedItemIdentifiers(toolbar) }
    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbar.identifier == "woodshed-main" ? [] : toolbarAllowedItemIdentifiers(toolbar) }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        if toolbar.identifier == "woodshed-main" {
            item.isBordered = false
            switch id.rawValue {
            case "mode":
                let control = NSSegmentedControl(labels: Mode.allCases.map(\.label), trackingMode: .selectOne, target: self, action: #selector(changeMainMode(_:)))
                control.controlSize = .small
                control.setAccessibilityLabel("Maintenance mode")
                mainModeControl = control; item.view = control
            case "connection":
                let field = NSTextField(labelWithString: "")
                field.font = .systemFont(ofSize: NSFont.smallSystemFontSize); field.textColor = .secondaryLabelColor
                field.frame = NSRect(x: 0, y: 0, width: 66, height: 17)
                mainStatusField = field; item.view = field
            case "refresh":
                item.label = "Refresh all PRs"; item.toolTip = "Refresh all PRs"; item.autovalidates = false
                item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: item.label)
                item.target = self; item.action = #selector(refreshAllPRs)
                mainRefreshItem = item
            default: return nil
            }
            updateMainToolbar()
            return item
        }
        let icons = ["general": "gearshape", "automation": "hammer", "notifications": "bell", "spend": "dollarsign.circle"]
        item.label = id.rawValue.capitalized; item.image = NSImage(systemSymbolName: icons[id.rawValue] ?? "gearshape", accessibilityDescription: item.label)
        item.target = self; item.action = #selector(selectSettingsTab(_:)); return item
    }
    private func updateMainToolbar() {
        mainModeControl?.selectedSegment = Mode.allCases.firstIndex(of: pendingMode ?? mode) ?? 0
        mainModeControl?.isEnabled = canSaveSettings && pendingMode == nil
        mainModeControl?.toolTip = pendingMode != nil ? "Saving mode…" : "Watch monitors PRs. Auto also queues repairs. Paused stops new work."
        mainStatusField?.stringValue = pendingMode != nil ? "Saving…" : !connected ? "Offline" : state?.syncing == true || refreshing ? "Syncing…" : ""
        mainRefreshItem?.isEnabled = canSaveSettings
    }
    @objc private func changeMainMode(_ sender: NSSegmentedControl) {
        guard Mode.allCases.indices.contains(sender.selectedSegment) else { return }
        setMode(Mode.allCases[sender.selectedSegment])
    }
    @objc private func refreshAllPRs() { Task { await perform("api/refresh") } }
    @objc private func selectSettingsTab(_ sender: NSToolbarItem) { settingsTab = sender.itemIdentifier.rawValue }
    func reconnectGitHub() {
        guard !preview else { return }
        if let remoteMachine { actionError = "Run gh auth login on \(remoteMachine), then recheck GitHub."; return }
        let command = FileManager.default.temporaryDirectory.appendingPathComponent("woodshed-github-\(UUID().uuidString).command")
        do {
            try Data("#!/bin/sh\nexec /opt/homebrew/bin/gh auth login --hostname github.com --git-protocol https --web\n".utf8).write(to: command, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: command.path)
            NSWorkspace.shared.open(command)
        } catch { actionError = error.localizedDescription }
    }
    @discardableResult
    func showWindow(_ key: String, title: String, size: NSSize, content: AnyView) -> NSWindow {
        if let window = windows[key] {
            if key != "main" { window.title = title }
            if key != "main" { window.contentView = NSHostingView(rootView: content) }
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return window
        }
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title; window.identifier = NSUserInterfaceItemIdentifier("woodshed-\(key)"); window.isReleasedWhenClosed = false
        window.minSize = key == "main" ? NSSize(width: 760, height: 530) : NSSize(width: 490, height: 440)
        window.contentView = NSHostingView(rootView: content)
        if key == "main" { configureMainToolbar(window) }
        window.center(); windows[key] = window
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return window
    }
    func openGitHub(_ raw: String) { guard URL(string: raw)?.host == "github.com" else { return }; openExternal(raw) }
    func openExternal(_ raw: String) {
        guard let url = URL(string: raw), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return }
        NSWorkspace.shared.open(url)
    }
    func copy(_ value: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }
    func openAgent(_ name: String) {
        guard name.range(of: "^[a-z0-9_-]{1,32}$", options: .regularExpression) != nil else { return }
        track("open_session", number: selectedNumber)
        let executable = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/hc").path
        let quoted = "'" + executable.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("woodshed-\(UUID().uuidString).command")
        do {
            let target = remoteMachine.map { "\($0)/\(name)" } ?? name
            try Data("#!/bin/sh\nexec \(quoted) attach '\(target)'\n".utf8).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            NSWorkspace.shared.open(file)
        } catch { actionError = error.localizedDescription }
    }
    private func registerNotificationActions() {
        let reply = UNTextInputNotificationAction(identifier: "reply", title: "Reply", options: [], textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
        let retry = UNNotificationAction(identifier: "retry", title: "Retry", options: [])
        let skip = UNNotificationAction(identifier: "skip", title: "Skip run", options: [])
        let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])
        let settings = UNNotificationAction(identifier: "spend", title: "Spend settings", options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "question", actions: [reply, retry, skip, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "attention", actions: [retry, skip, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "budget", actions: [settings, skip, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "ready", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "finished", actions: [open], intentIdentifiers: [])
        ])
    }
    // Older Apple SDKs do not mark UNNotificationSettings as Sendable. Extract
    // plain values in its callback instead of moving the object onto MainActor.
    private func notificationAuthorization() async -> (notDetermined: Bool, denied: Bool, authorized: Bool) {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { @Sendable settings in
                continuation.resume(returning: (
                    settings.authorizationStatus == .notDetermined,
                    settings.authorizationStatus == .denied,
                    settings.authorizationStatus == .authorized
                ))
            }
        }
    }
    func enableNotifications() async {
        guard !preview else { return }
        do {
            let authorization = await notificationAuthorization()
            if authorization.denied {
                if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
                return
            }
            notificationsEnabled = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            lastNotificationCheck = .distantPast
            track(notificationsEnabled ? "permission_granted" : "permission_denied", event: "notification")
            await updateNotifications()
        } catch { actionError = error.localizedDescription }
    }
    private func deliver(_ record: PullRequestRecord, title: String, text: String, category: String, identifier: String) async {
        let content = UNMutableNotificationContent()
        content.title = title; content.subtitle = "\(record.numberLabel) · \(record.displayTitle)"; content.body = text; content.sound = .default; content.categoryIdentifier = category
        var info: [String: Any] = ["number": record.id, "head": record.snapshot.head]
        if let prompt = lastRun(record)?.prompt { info["promptId"] = prompt.id }
        if let id = record.decision.id { info["decisionId"] = id }
        if let key = record.decision.questionKey { info["questionKey"] = key }
        content.userInfo = info
        do { try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)); track("scheduled", number: record.id, event: "notification") }
        catch { track("failed", number: record.id, event: "notification"); actionError = "Couldn’t deliver a notification: \(error.localizedDescription)" }
    }
    private func updateNotifications() async {
        guard !updatingNotifications else { return }
        updatingNotifications = true; defer { updatingNotifications = false }
        let center = UNUserNotificationCenter.current()
        if Date().timeIntervalSince(lastNotificationCheck) > 30 {
            lastNotificationCheck = Date()
            let authorization = await notificationAuthorization()
            notificationsEnabled = authorization.authorized
            notificationPermission = authorization.denied ? "denied" : authorization.authorized ? "authorized" : "unknown"
        }
        guard connected, state?.demo != true, !preview, notificationsEnabled else { return }
        let records = (notifyNeeds ? attention : []) + (notifyReady ? ready : [])
        let activeKeys = Set(records.map { String($0.id) })
        let outdated = seen.keys.filter { !activeKeys.contains($0) }
        center.removeDeliveredNotifications(withIdentifiers: outdated.map { "pr-\($0)" })
        for key in outdated { seen.removeValue(forKey: key) }
        for record in records {
            let run = lastRun(record)
            let version = "\(record.snapshot.head):\(record.decision.kind):\(record.decision.id ?? record.decision.reason)"
            let key = String(record.id)
            guard seen[key] != version else { continue }
            let category = record.decision.kind == "ready" ? "ready" : run?.state == "budget" || record.decision.reason.lowercased().contains("spend") ? "budget" : (record.decision.response == "reply" || record.decision.response == nil && record.decision.question != nil || run?.prompt?.kind == "question") ? "question" : "attention"
            await deliver(record, title: record.decision.kind == "ready" ? "Ready to merge" : record.decision.title ?? "Woodshed needs you", text: record.decision.question ?? record.decision.reason, category: category, identifier: "pr-\(key)")
            seen[key] = version
        }
        let completed = allRuns.filter { $0.endedAt != nil }
        if !UserDefaults.standard.bool(forKey: "finishedRunsInitialized") {
            seenFinished.formUnion(completed.map(\.id)); UserDefaults.standard.set(true, forKey: "finishedRunsInitialized")
        }
        for run in completed where !seenFinished.contains(run.id) {
            seenFinished.insert(run.id)
            if notifyFinished && run.state == "succeeded" && !run.id.hasPrefix("ws-triage-") && !run.id.hasPrefix("jev-"), let record = state?.prs.first(where: { $0.id == run.number }), !records.contains(where: { $0.id == run.number }) {
                await deliver(record, title: "Run finished", text: run.summary, category: "finished", identifier: "run-\(run.id)")
            }
        }
        UserDefaults.standard.set(Array(seenFinished.suffix(1000)), forKey: "finishedRuns")
        UserDefaults.standard.set(seen, forKey: "notificationStates")
    }
    private func notificationAction(_ action: String, number: Int?, head: String?, promptId: String?, text: String?, decisionId: String?, questionKey: String?) async {
        guard let number else { return }
        await refresh()
        guard let record = state?.prs.first(where: { $0.id == number }) else { showMain(number); return }
        if action == "open" || action == UNNotificationDefaultActionIdentifier { track("opened", number: number, event: "notification"); showMain(number); return }
        if action == "spend" { track("spend_settings", number: number, event: "notification"); showSettings("spend"); return }
        if head != record.snapshot.head && action != "reply" { actionError = "This PR changed since the notification. Review its current state before acting."; showMain(number); return }
        if action == "reply" && decisionId == nil { drafts[number] = text ?? ""; actionError = "Your answer is preserved. Check the current question before sending."; showMain(number); return }
        if action == "reply", let text { drafts[number] = text }
        let success = await act(action, on: record, message: text, promptId: promptId, decisionId: decisionId, questionKey: questionKey, headOverride: head, source: "notification")
        if success && state?.prs.first(where: { $0.id == number })?.pendingAnswer == nil { drafts[number] = "" } else { showMain(number) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let number = info["number"] as? Int; let head = info["head"] as? String; let promptId = info["promptId"] as? String
        let decisionId = info["decisionId"] as? String; let questionKey = info["questionKey"] as? String
        let action = response.actionIdentifier; let text = (response as? UNTextInputNotificationResponse)?.userText
        if action != UNNotificationDismissActionIdentifier { Task { @MainActor in await self.notificationAction(action, number: number, head: head, promptId: promptId, text: text, decisionId: decisionId, questionKey: questionKey) } }
        completionHandler()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound]) }
}
