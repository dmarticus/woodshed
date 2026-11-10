import Foundation

enum Mode: String, Codable, CaseIterable, Identifiable, Sendable {
    case watch, auto, paused
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

enum PRListSection: CaseIterable {
    case attention, running, drafts, queued, ready, waiting, paused, unwatched
}

struct ModelPrice: Codable, Equatable, Sendable {
    var input: Double
    var cached: Double
    var output: Double
    var cacheWrite: Double
    var source: String?
}
struct ModelOption: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let isDefault: Bool
    let price: ModelPrice?
}
struct ControllerSettings: Decodable, Sendable {
    var repository: String
    var author: String
    var mode: Mode?
    var automation: Bool
    var paused: Bool
    var pollSeconds: Int
    var maxAttempts: Int
    var concurrencyMode: String?
    var cpuTargetPercent: Int?
    var memoryTargetPercent: Int?
    var maxConcurrentJobs: Int
    var defaultModel: String?
    var retryModel: String?
    var escalateOnRetry: Bool?
    var runCapUSD: Double?
    var dailyCapUSD: Double?
    var modelPrices: [String: ModelPrice]?
    var watchFilter: String?
    var watchQuery: String?
}
struct Spend: Decodable, Sendable {
    let day: String
    let spentUSD: Double
    let capUSD: Double
    let runs: Int
    let unknownRuns: Int
    let prTotals: [String: Double?]
}
struct ControllerHealth: Decodable, Sendable {
    struct Scheduler: Decodable, Sendable {
        let mode: String?
        let cpuPercent: Double?
        let memoryPercent: Double?
    }
    let scheduler: Scheduler?
    let lastPoll: String?
    let lastContact: String?
    let queueDepth: Int
    let activeRuns: Int
    let githubError: String?
    let lastSleep: String?
    let resumedAt: String?
    let sleeping: Bool
}
struct InboxState: Decodable, Sendable {
    let repository: String
    let demo: Bool
    let automation: Bool
    let mode: Mode?
    let lastSync: String?
    let syncing: Bool
    let error: String?
    let health: ControllerHealth?
    let settings: ControllerSettings?
    let prs: [PullRequestRecord]
    let events: [ActivityEvent]
    let runs: [AgentRun]?
    let spend: Spend?
    let models: [ModelOption]?
}

func parseDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
        ?? (try? Date.ISO8601FormatStyle().parse(text))
}
func currency(_ value: Double) -> String { value.formatted(.currency(code: "USD").precision(.fractionLength(2))) }
func shortAge(_ text: String?) -> String {
    guard let date = parseDate(text) else { return "" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 60 { return "just now" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
}

struct ActivityEvent: Decodable, Identifiable, Sendable {
    let id: Int
    let time: String
    let number: Int?
    let message: String
    var date: Date? { parseDate(time) }
}
struct AgentRun: Decodable, Identifiable, Sendable {
    struct Prompt: Decodable, Sendable { let id: String; let kind: String; let text: String }
    let id: String
    let number: Int
    let startedAt: String
    let endedAt: String?
    let state: String
    let model: String
    let turns: Int
    let costUSD: Double?
    let summary: String
    let prompt: Prompt?
    var live: Bool { ["preparing", "running"].contains(state) && endedAt == nil }
    var spendLabel: String { costUSD.map(currency) ?? "Usage unavailable" }
    var duration: String {
        guard let start = parseDate(startedAt) else { return "" }
        let seconds = max(0, Int((parseDate(endedAt) ?? Date()).timeIntervalSince(start)))
        return seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
    }
}

struct PullRequestRecord: Decodable, Identifiable, Sendable {
    struct ApprovalRequest: Decodable, Sendable {
        let head: String
        let status: String
        let canRequest: Bool
        let reason: String
        let requestedAt: String?
    }
    let approval: ApprovalRequest?
    struct Readiness: Decodable, Sendable {
        struct Summary: Decodable, Sendable { let passed: Int; let failed: Int; let pending: Int; let skipped: Int; let open_threads: Int; let approval: String? }
        let id: String; let head: String; let ready: Bool; let fresh: Bool; let observed_at: String?; let expires_at: String?; let reasons: [String]; let summary: Summary
    }
    let readiness: Readiness?
    struct Recovery: Decodable, Sendable { let attempts: Int; let retryAt: String?; let kind: String }
    let recovery: Recovery?
    struct Check: Decodable, Sendable {
        let name: String
        let status: String
        let conclusion: String?
        let required: Bool?
        let url: String
        var failed: Bool { !(conclusion == "CANCELLED" && required == false) && ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].contains(conclusion ?? "") }
        var pending: Bool { status != "COMPLETED" || conclusion == nil }
        var label: String {
            if failed { return "Failed" }
            if pending { return "Pending" }
            return conclusion == "SKIPPED" || conclusion == "CANCELLED" && required == false ? "Skipped" : "Passed"
        }
    }
    struct Review: Decodable, Sendable { let author: String; let state: String; let body: String; let head: String; let submittedAt: String? }
    struct Thread: Decodable, Identifiable, Sendable {
        struct Comment: Decodable, Sendable { let author: String; let body: String; let url: String }
        let id: String
        let comments: [Comment]
    }
    struct Snapshot: Decodable, Sendable {
        struct Stack: Decodable, Sendable { let position: Int; let size: Int }
        let number: Int
        let title: String
        let url: String
        let head: String
        let branch: String
        let base: String
        let state: String
        let draft: Bool
        let reviewDecision: String?
        let checks: [Check]
        let reviews: [Review]
        let threads: [Thread]
        let stack: Stack?
    }
    struct Decision: Decodable, Sendable {
        struct Action: Decodable, Sendable { let label: String; let url: String }
        struct Option: Decodable, Identifiable, Sendable { let id: String; let label: String; let value: String }
        let id: String?
        let questionKey: String?
        let response: String?
        let options: [Option]?
        let kind: String
        let reason: String
        let action: Action?
        let title: String?
        let question: String?
    }
    struct Assessment: Decodable, Sendable {
        let report: String?
        struct Result: Decodable, Sendable {
            struct Evidence: Decodable, Sendable { let url: String; let detail: String }
            let route: String
            let title: String
            let evidence: [Evidence]
        }
        let result: Result?
    }
    struct Job: Decodable, Sendable { let name: String; let kind: String?; let startedAt: String; let model: String?; let adapter: String? }
    struct QueueStatus: Decodable, Sendable { let reason: String; let message: String }
    let queue: QueueStatus?
    let assessment: Assessment?
    let snapshot: Snapshot
    let canMarkReady: Bool?
    let decision: Decision
    let paused: Bool
    let attempts: Int
    let job: Job?
    let lastError: String?
    let watching: Bool?
    let stateSince: String?
    struct PendingAnswer: Decodable, Sendable { let text: String; let questionKey: String?; let requiresConfirmation: Bool }
    let pendingAnswer: PendingAnswer?
    let sleepInterruptedAt: String?
    let resumeRequested: String?
    let pendingReply: String?
    let runRequested: Bool?
    var id: Int { snapshot.number }
    var numberLabel: String { "#" + String(snapshot.number) }
    var isWatched: Bool { watching != false }
    private static let titleExpression = try! NSRegularExpression(pattern: "^(?:feat|fix|chore|refactor|perf|test|docs|build|ci|style|revert)(?:\\(([^)]+)\\))?!?:\\s*(.*)$")
    private var titleMatch: NSTextCheckingResult? {
        Self.titleExpression.firstMatch(in: snapshot.title, range: NSRange(snapshot.title.startIndex..., in: snapshot.title))
    }
    var displayTitle: String {
        guard let match = titleMatch, let range = Range(match.range(at: 2), in: snapshot.title) else { return snapshot.title }
        let value = String(snapshot.title[range])
        return value.prefix(1).uppercased() + value.dropFirst()
    }
    var scope: String? {
        guard let match = titleMatch, let range = Range(match.range(at: 1), in: snapshot.title) else { return nil }
        return String(snapshot.title[range])
    }
    var statusLabel: String {
        if snapshot.draft { return "Draft" }
        if !isWatched { return "Not watching" }
        switch decision.kind {
        case "human": return "Needs you"
        case "ready": return readiness?.ready == false ? readiness?.reasons.first ?? "Refreshing readiness" : "Ready to merge"
        case "fix": return "Repair needed"
        case "review": return "Waiting on PostHog Review"
        case "approval": return "Waiting on approval"
        case "paused": return "Paused"
        default: return decision.reason
        }
    }
    var checksLabel: String {
        if snapshot.checks.contains(where: { $0.failed || $0.pending }) || snapshot.checks.isEmpty { return checksSummary }
        return snapshot.checks.contains(where: { $0.conclusion == "SUCCESS" }) ? "Checks passed" : "Checks complete"
    }
    var checksSummary: String {
        let failed = snapshot.checks.filter(\.failed).count
        let pending = snapshot.checks.filter(\.pending).count
        if failed > 0 { return "\(failed) failed" + (pending > 0 ? " · \(pending) pending" : "") }
        if pending > 0 { return "\(pending) pending" }
        if snapshot.checks.isEmpty { return "No checks yet" }
        let skipped = snapshot.checks.filter { $0.conclusion == "SKIPPED" || $0.conclusion == "CANCELLED" && $0.required == false }.count
        return "\(snapshot.checks.count - skipped) passed" + (skipped > 0 ? " · \(skipped) skipped" : "")
    }
}
struct AgentSnapshot: Decodable, Sendable {
    let name: String
    let state: String
    let kind: String?
    let message: String
    let output: String
    let promptId: String?
    var needsTerminal: Bool { state == "blocked" && kind != "question" }
}
struct APIAcknowledgement: Decodable, Sendable { let ok: Bool }
struct APIError: Decodable, Sendable { let error: String }
struct ServiceError: LocalizedError, Sendable { let message: String; var errorDescription: String? { message } }
