import { Outcomes } from "./outcomes";
import type { Record, Snapshot } from "./model";

export function demoRecords(): Record[] {
  const base: Snapshot = { number: 101, title: "Handle empty export results", url: "https://github.com/example/project/pull/101", head: "demo-commit", branch: "fix/empty-export", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Backend tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], labels: [], reviews: [] };
  return [
    { title: "Keep the toolbar usable in narrow windows", number: 104, kind: "human", reason: "Inspect visual changes: three snapshots changed after the layout fix." },
    { title: "Handle empty export results", number: 103, kind: "ready", reason: "Checks passed, review addressed, and approval recorded. Ready for your merge decision." },
    { title: "Add report delivery preferences", number: 102, kind: "waiting", reason: "Coding agent is working on two review comments" },
    { title: "Preserve filters when switching projects", number: 101, kind: "waiting", reason: "Waiting for checks to finish" },
  ].map(p => ({ snapshot: { ...base, title: p.title, number: p.number }, decision: { kind: p.kind, reason: p.reason }, paused: false, attempts: 0, fingerprint: "" }) as Record);
}

/** Invented history only: no GitHub requests or model calls. */
export function seedDemoOutcomes(store: import("./store").Store, config: import("./model").Config): void {
  const original = store.localHistory; const end = Date.now(); let clock = end - 7 * 86400000;
  const history = new Outcomes(store, config, () => "demo", () => clock); store.localHistory = history;
  try { for (const number of [201, 202, 203]) {
    const head = "a".repeat(40); const received = new Date(clock).toISOString();
    const snapshot: Snapshot = { number, title: "Handle report provider errors", url: `https://github.com/${config.repository}/pull/${number}`, head, branch: `report-${number}`, base: "main", state: "OPEN", draft: false, author: "demo", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", reviews: [{ author: "posthog[bot]", state: "COMMENTED", head, body: "Reviewed", submittedAt: received }], checks: [{ name: "Report tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }], labels: [], threads: [{ id: `demo-thread-${number}`, path: "src/api/reports.py", comments: [{ author: "posthog[bot]", authorType: "Bot", body: "Invented review", url: snapshotURL(number) }] }] };
    const handoff = { repository: config.repository, number, head, request_id: `demo/author/${number}`, summary: "Handle provider errors", intent: "Preserve delivery preferences", tradeoffs: ["Keep delivery independent from archival"], validation: ["Scoped report tests"], source_session: { kind: "codex" as const, id: `demo-session-${number}` }, id: `demo-${number}`, received_at: received };
    const record: Record = { snapshot, handoff, paused: false, watching: true, observedAt: received, attempts: 0, fingerprint: "", decision: { kind: "fix", reason: "Report tests failed" } };
    history.enroll(record, true); store.acceptHandoff(record, handoff);
    history.triage(record, { head, route: "repair", category: "review", title: "Handle provider errors", reason: "The provider exception is not handled.", evidence: [], review_threads: [{ id: `demo-thread-${number}`, status: "needs_repair", category: "error_handling", reason: "A provider exception bypasses the user-facing error state.", code_url: `https://github.com/${config.repository}/blob/${head}/src/api/reports.py` }] });
    clock += 10 * 60000;
    const job = { name: `demo-repair-${number}`, head, startedAt: new Date(clock).toISOString(), fingerprint: "", kind: "repair" as const, handoff, ciEvidence: { head, reports: [{ name: "Report tests", github_url: snapshot.url, provider_url: "", title: "Assertion failed", summary: "", text: "", annotations: [], test_failures: ["tests/report.py::test_error"] }], unavailable: [] } };
    record.job = job; store.put(record); store.saveRun({ id: job.name, number, state: "succeeded", model: "demo-model", startedAt: job.startedAt, endedAt: new Date(clock + 5 * 60000).toISOString(), turns: 3, costUSD: 0.24, costsByDay: {}, summary: "Handled provider errors" });
    history.published(record, job, { publishedHead: "b".repeat(40) }); record.job = undefined;
    clock += 10 * 60000; snapshot.head = "b".repeat(40); snapshot.checks[0]!.conclusion = "SUCCESS"; snapshot.threads = []; snapshot.reviews[0]!.head = snapshot.head; record.observedAt = new Date(clock).toISOString(); record.decision = { kind: "ready", reason: "Ready" }; store.put(record);
    clock += 5 * 60000; snapshot.state = number === 203 ? "CLOSED" : "MERGED"; record.decision = { kind: "closed", reason: snapshot.state }; store.put(record);
    clock += 86400000;
  } } finally { store.localHistory = original; }
}
function snapshotURL(number: number): string { return `https://github.com/example/project/pull/${number}#discussion`; }
