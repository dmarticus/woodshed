import { expect, test } from "bun:test";
import { Store } from "../src/store";
import { Outcomes } from "../src/outcomes";
import type { Config, Record as PRRecord } from "../src/model";
import type { Handoff } from "../src/handoff";

const head = "a".repeat(40);
const config = { repository: "example/project", pollSeconds: 90 } as Config;
function fixture() {
  const store = new Store(":memory:"); let now = Date.now(); const history = new Outcomes(store, config, () => "owner", () => now); store.localHistory = history;
  const enroll = (number: number, complete = true, session = `opaque-${number}`) => {
    const h: Handoff = { repository: config.repository, number, head, request_id: `session/${number}`, summary: "Fixture", intent: "Preserve behavior", tradeoffs: [], validation: [], id: `id-${number}`, received_at: new Date(now - (complete ? 0 : 86400000)).toISOString(), source_session: { kind: "codex", id: session } };
    const r: PRRecord = { snapshot: { number, title: "Fixture", url: `https://github.com/example/project/pull/${number}`, head, base: "main", branch: `feature-${number}`, state: "OPEN", draft: false, author: "owner", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }], threads: [], reviews: [{ author: "posthog[bot]", state: "COMMENTED", head, body: "Reviewed", submittedAt: new Date(now).toISOString() }], labels: [] }, handoff: h, observedAt: new Date(now).toISOString(), decision: { kind: "fix", reason: "Tests" }, attempts: 0, paused: false } as PRRecord;
    history.enroll(r, complete); store.acceptHandoff(r, h); return r;
  };
  return { store, history, enroll, advance: (ms: number) => { now += ms; }, now: () => now };
}
function findings(f: ReturnType<typeof fixture>, r: PRRecord) {
  r.snapshot.threads = ["needs", "done", "reviewer"].map(id => ({ id, path: "src/api/report.py", comments: [{ author: "posthog[bot]", authorType: "Bot", body: "RAW COMMENT MUST NOT BE COPIED", url: "https://github.com/example/project/pull/1#discussion" }] }));
  f.history.triage(r, { head, route: "repair", category: "review", title: "Repair", reason: "Evidence", evidence: [], review_threads: [
    { id: "needs", status: "needs_repair", category: "error_handling", reason: "A provider exception bypasses error handling.", code_url: `https://github.com/example/project/blob/${head}/src/api/report.py` },
    { id: "done", status: "addressed", reason: "The new guard handles it.", code_url: `https://github.com/example/project/blob/${head}/src/api/report.py` },
    { id: "reviewer", status: "awaiting_reviewer", reason: "Awaiting design review." },
  ] });
}

test("mixed triage statuses capture only verified needs_repair findings without raw comments", () => {
  const f = fixture(); const r = f.enroll(1); findings(f, r); findings(f, r);
  const rows = f.store.db.query("SELECT data FROM outcomes WHERE kind='review_finding'").all() as any[];
  expect(rows).toHaveLength(1); expect(JSON.parse(rows[0].data)).toMatchObject({ reviewer_kind: "bot", reviewer: "posthog_review", category: "error_handling", path: "src/api/report.py", reason: "A provider exception bypasses error handling." });
  expect(JSON.stringify(rows)).not.toContain("RAW COMMENT");
});

test("recurring patterns count PRs, not repeated findings, and produce deterministic bounded lessons", () => {
  const f = fixture(); findings(f, f.enroll(1)); findings(f, f.enroll(2));
  const first = f.history.digest(); const second = f.history.digest();
  expect(first.lessons).toEqual(second.lessons);
  expect(first.lessons).toContain("PostHog Review flagged error handling on 2 of 2 PRs.");
  expect(first.patterns.every((p: any) => p.count === 2 && p.examples.length <= 3)).toBe(true);
  expect(first.patterns[0].examples[0].url).toContain(`/blob/${head}/`);
  expect(first.lessons.every((l: string) => l.length <= 200)).toBe(true);
});

test("controller-only branch and migration repairs are retained separately and excluded from authoring patterns", () => {
  const f = fixture();
  for (const number of [1, 2]) {
    const r = f.enroll(number); r.job = { name: `migration-${number}`, head, kind: "branch-update", fingerprint: "", startedAt: new Date(f.now()).toISOString(), handoff: r.handoff };
    f.store.put(r); f.store.saveRun({ id: r.job.name, number, state: "succeeded", model: "No model", turns: 0, costUSD: 0, startedAt: r.job.startedAt, costsByDay: {}, summary: "Migration renumbered" });
    f.history.published(r, r.job, { publishedHead: "b".repeat(40), playbook: "django-migration-chain" });
    r.assessment = { head, key: "", report: "", attempts: 0, followups: 0, sourceJob: r.job }; findings(f, r);
  }
  const digest = f.history.digest(); expect(digest.totals.controller_repairs).toBe(2); expect(digest.totals.repair_rounds_per_pr).toBe(0); expect(digest.patterns).toEqual([]);
  expect(digest.recent[0].repairs[0]).toMatchObject({ published: true, estimated_cost_usd: null, controller_categories: ["django-migration-chain"] });
});

test("cancelled and replaced CI failures aren't recorded as causes", () => {
  const f = fixture(); const r = f.enroll(1);
  r.snapshot.checks = [
    { name: "Cancelled", status: "COMPLETED", conclusion: "CANCELLED", required: true, url: "" },
    { name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "", source: { workflow: "workflow", run: "old", createdAt: "2020" } },
    { name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "", source: { workflow: "workflow", run: "new", createdAt: "2021" } },
  ];
  r.job = { name: "repair", head, kind: "repair", startedAt: new Date(f.now()).toISOString(), fingerprint: "" }; f.store.put(r);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM outcomes WHERE kind='ci_failure'").get()).toMatchObject({ n: 0 });
});

test("partial history and missing telemetry remain unknown, not zero", () => {
  const f = fixture(); const r = f.enroll(1, false); r.job = { name: "unknown", head, kind: "repair", startedAt: new Date(f.now()).toISOString(), fingerprint: "" }; f.store.put(r);
  const d = f.history.digest(); expect(d.totals.repair_rounds_per_pr).toBeNull(); expect(d.totals.prs_needing_human).toBeNull(); expect(d.recent[0].readiness_elapsed_ms).toBeNull(); expect(d.recent[0].repairs[0].published).toBeNull(); expect(d.recent[0].repairs[0].estimated_cost_usd).toBeNull();
});

test("readiness timing, owner decisions, resumed rounds and publication are factual and survive restart", () => {
  const f = fixture(); const r = f.enroll(1); r.job = { name: "repair", head, kind: "repair", fingerprint: "", startedAt: new Date(f.now()).toISOString(), handoff: r.handoff }; f.store.put(r);
  f.history.repairRound(r, r.job, "followup:1"); f.history.repairRound(r, r.job, "followup:1");
  f.store.saveRun({ id: "repair", number: 1, state: "succeeded", model: "fixture", turns: 2, costUSD: null, startedAt: r.job.startedAt, costsByDay: {}, summary: "Complete" });
  f.history.notPublished(r.job); r.job = undefined; f.advance(120000); r.snapshot.checks[0]!.conclusion = "SUCCESS"; r.observedAt = new Date(f.now()).toISOString(); r.decision = { kind: "ready", reason: "Ready" }; f.store.put(r);
  r.snapshot.state = "MERGED"; f.store.put(r);
  const restarted = new Outcomes(f.store, config, () => "owner", f.now); const d = restarted.digest();
  expect(d.totals).toMatchObject({ prs_handed_off: 1, merged: 1, repair_rounds_per_pr: 2, prs_needing_human: 0, prs_ready_without_owner_decision: 1 });
  expect(d.recent[0]).toMatchObject({ source_session: { kind: "codex", id: "opaque-1" }, state: "merged", readiness_elapsed_ms: 120000 }); expect(d.recent[0].repairs[0].published).toBe(false);
});

test("repo and signed-in author scope do not leak another account's history", () => {
  const f = fixture(); findings(f, f.enroll(1)); findings(f, f.enroll(2));
  expect(new Outcomes(f.store, config, () => "other").digest().totals.prs_handed_off).toBe(0);
  expect(new Outcomes(f.store, { ...config, repository: "other/project" }, () => "owner").digest().patterns).toEqual([]);
  expect(new Outcomes(f.store, config, () => undefined).digest().totals.prs_handed_off).toBeNull();
});

test("UTF-8 response stays below 16 KB while retained lessons still have pattern counts", () => {
  const f = fixture();
  for (let n = 1; n <= 100; n++) { const r = f.enroll(n, true, "界".repeat(200)); findings(f, r); }
  const d = f.history.digest("14d", 100); expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(16384); expect(d.totals.prs_handed_off).toBe(100); expect(d.lessons.length).toBeLessThanOrEqual(8); expect(d.patterns.every((p: any) => p.count === 100)).toBe(true);
});

test("a same-head rerun retracts superseded CI from patterns without erasing the observed repair round", () => {
  const f = fixture();
  for (const n of [1, 2]) {
    const r = f.enroll(n); r.snapshot.checks[0]!.source = { workflow: "tests", run: "old", createdAt: "2020" };
    r.job = { name: `repair-${n}`, head, kind: "repair", fingerprint: "", startedAt: new Date(f.now()).toISOString(), ciEvidence: { head, reports: [{ name: "Tests", provider_url: "", github_url: "", title: "Assertion", summary: "", text: "", annotations: [], test_failures: ["test.py::test_error"] }], unavailable: [] } };
    f.store.put(r); f.store.saveRun({ id: r.job.name, number: n, state: "running", model: "fixture", turns: 1, costUSD: 0.1, startedAt: r.job.startedAt, costsByDay: {}, summary: "Investigating" });
  }
  expect(f.history.digest().patterns.some((p: any) => p.kind === "ci")).toBe(true);
  for (const n of [1, 2]) { const r = f.store.get(n)!; r.snapshot.checks[0]!.source = { workflow: "tests", run: "new", createdAt: "2021" }; r.snapshot.checks[0]!.conclusion = "SUCCESS"; f.store.put(r); }
  expect(f.history.digest().patterns.some((p: any) => p.kind === "ci")).toBe(false); expect(f.history.digest().totals.repair_rounds_per_pr).toBe(1);
});

test("actual Needs you transitions record categories and prevent clean-readiness credit", () => {
  const f = fixture(); const r = f.enroll(1); r.decision = { kind: "human", title: "Review spend", reason: "A limit was reached" }; r.budgetDay = "2026-11-10"; f.store.put(r); f.store.put(r);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM outcomes WHERE kind='owner_decision'").get()).toMatchObject({ n: 1 });
  const row = f.store.db.query("SELECT data FROM outcomes WHERE kind='owner_decision'").get() as any; expect(JSON.parse(row.data).category).toBe("budget");
  f.advance(1000); r.decision = { kind: "ready", reason: "Ready" }; r.budgetDay = undefined; r.snapshot.checks[0]!.conclusion = "SUCCESS"; r.observedAt = new Date(f.now()).toISOString(); f.store.put(r);
  expect(f.history.digest().totals).toMatchObject({ prs_needing_human: 1, prs_ready_without_owner_decision: 0 });
});
