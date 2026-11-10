import Foundation

struct NotificationStability {
    private var candidates: [String: (version: String, since: Date)] = [:]
    mutating func retain(_ keys: Set<String>) { candidates = candidates.filter { keys.contains($0.key) } }
    mutating func ready(_ key: String, version: String, at now: Date = Date()) -> Bool {
        guard let candidate = candidates[key], candidate.version == version else {
            candidates[key] = (version, now); return false
        }
        return now.timeIntervalSince(candidate.since) >= 5
    }
}
