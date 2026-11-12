import { expect, test } from "bun:test";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { currentChecks, decide, fingerprint, type Config, type JobObservation, type Snapshot } from "../src/model";

const healthy = (): Snapshot => ({ number: 42, title: "Fixture repair", url: "https://github.com/example/project/pull/42", head: "head", branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], labels: [], reviews: [{ author: "posthog[bot]", head: "head", state: "COMMENTED", body: "Reviewed", submittedAt: "" }] });
const broken = (): Snapshot => ({ ...healthy(), checks: [{ name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }] });
function harness(initial = broken()) {
  const store = new Store(":memory:"); let stopped = 0; let launched = 0; let statusCalls = 0;
  let observation: JobObservation = { state: "blocked", summary: "Question about the repair", promptId: "question-1" };
  const job = { name: "fixture-job", head: initial.head, fingerprint: fingerprint(initial), startedAt: new Date().toISOString() };
  store.put({ snapshot: initial, job, humanHead: initial.head, humanReason: observation.summary, humanObservation: observation, decision: { kind: "human", reason: observation.summary }, fingerprint: fingerprint(initial), attempts: 1, paused: false });
  const config = { automation: true, maxAttempts: 3, maxConcurrentJobs: 1, reviewLabel: "review", approvalLabel: "approval" } as Config;
  const runner: any = { stop: async () => { stopped++; }, launch: async () => { launched++; }, observe: async () => observation, status: async () => { statusCalls++; return { state: "working" }; } };
  const github: any = { snapshot: async () => healthy(), label: async () => { throw new Error("Attention polling must not request reviews"); } };
  return { store, github, runner, controller: new Controller(config, store, github, runner), counts: () => ({ stopped, launched, statusCalls }), observe: (value: JobObservation) => { observation = value; } };
}

test.each(["checks", "threads", "conflict"])("a %s blocker resolved on the same head retires the stale job and decision", async kind => {
  const initial = kind === "checks" ? broken() : kind === "threads" ? { ...healthy(), threads: [{ id: "thread", comments: [] }] } : { ...healthy(), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  const h = harness(initial); await h.controller.reconcile(healthy(), true);
  const record = h.store.get(42)!;
  expect(record.decision.kind).toBe("ready"); expect(record.humanHead).toBeUndefined(); expect(record.job).toBeUndefined();
  expect(h.counts()).toEqual({ stopped: 1, launched: 0, statusCalls: 0 });
  expect(h.store.run("fixture-job")?.prompt).toBeUndefined();
});

test.each(["CLOSED", "MERGED"])("a %s PR clears its question and queued reply", async state => {
  const h = harness(); const record = h.store.get(42)!; record.pendingReply = "Old reply"; h.store.put(record);
  await h.controller.reconcile({ ...broken(), state }, true);
  expect(h.store.get(42)?.decision.kind).toBe("closed"); expect(h.store.get(42)?.pendingReply).toBeUndefined();
  expect(h.counts().stopped).toBe(1);
});

test("a new head retires a question tied to the old commit without starting work during attention polling", async () => {
  const h = harness(); await h.controller.reconcile({ ...broken(), head: "new-head" }, true);
  expect(h.store.get(42)?.job).toBeUndefined(); expect(h.store.get(42)?.decision.kind).toBe("fix");
  expect(h.counts()).toEqual({ stopped: 1, launched: 0, statusCalls: 0 });
});

test.each(["still failing", "checks missing", "explicit task"])("preserves a genuine question when %s", async situation => {
  const h = harness(situation === "explicit task" ? healthy() : broken());
  const record = h.store.get(42)!;
  if (situation === "explicit task") { record.job!.instructions = "Discuss a product choice"; h.store.put(record); }
  await h.controller.reconcile(situation === "still failing" ? broken() : situation === "checks missing" ? { ...healthy(), checks: [] } : healthy(), true);
  expect(h.store.get(42)?.decision.kind).toBe("human"); expect(h.counts().stopped).toBe(0);
});

test.each(["working", "done"] as const)("an agent that is %s after an answer elsewhere leaves Needs you", async state => {
  const h = harness(); h.observe({ state, summary: "Continued after the answer" });
  await h.controller.reconcile(broken(), true);
  expect(h.store.get(42)?.decision.kind).toBe("waiting"); expect(h.store.get(42)?.job).toBeDefined();
  expect(h.counts()).toEqual({ stopped: 0, launched: 0, statusCalls: 0 });
});

test("a completed agent behind a failed publish gate does not cause unattended publish retries", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.humanObservation = { state: "done", summary: "Agent completed" }; record.humanReason = "Publish hook failed"; h.store.put(record);
  h.observe({ state: "done", summary: "Agent completed" });
  await h.controller.reconcile(broken(), true);
  expect(h.store.get(42)?.decision.kind).toBe("human"); expect(h.counts().statusCalls).toBe(0);
});

test("attention refresh runs during the main poll and preserves alerts when GitHub fails", async () => {
  const h = harness(); h.controller.syncing = true;
  h.github.snapshot = async () => { throw new Error("GitHub unavailable"); };
  await h.controller.refreshAttention();
  expect(h.store.get(42)?.decision.kind).toBe("human"); expect(h.store.get(42)?.lastError).toBe("GitHub unavailable");
  h.github.snapshot = async () => healthy();
  await h.controller.refreshAttention();
  expect(h.store.get(42)?.decision.kind).toBe("ready"); expect(h.counts().launched).toBe(0);
});

test("approval elsewhere supersedes an earlier Stamphog refusal on the same head", () => {
  const pr = healthy(); pr.reviews = [{ author: "stamphog", head: pr.head, state: "COMMENTED", body: "REFUSED: needs a person", submittedAt: "" }, ...pr.reviews];
  expect(decide(pr).kind).toBe("ready");
  pr.reviewDecision = "REVIEW_REQUIRED";
  expect(decide(pr).kind).toBe("human");
});

test("approval on the current commit satisfies review without requesting another review", () => {
  const pr = healthy(); pr.reviews = [{ author: "stamphog", head: pr.head, state: "APPROVED", body: "Approved", submittedAt: "" }];
  expect(decide(pr).kind).toBe("ready");
  pr.head = "new-head";
  expect(decide(pr).kind).toBe("review");
});

test("newer workflow runs replace cancelled matrix placeholders and earlier failed attempts", () => {
  const source = (workflow: string, run: string, createdAt: string) => ({ workflow, run, createdAt });
  const check = (name: string, conclusion: string, workflow: string, run: string, createdAt: string) => ({ name, conclusion, status: "COMPLETED", url: "", source: source(workflow, run, createdAt) });
  const current = currentChecks([
    check("Test (${{ matrix.shard }})", "CANCELLED", "tests", "old", "2026-01-01T00:00:00Z"),
    check("Tests pass", "FAILURE", "tests", "old", "2026-01-01T00:00:00Z"),
    check("Test (1)", "SUCCESS", "tests", "new", "2026-01-01T00:01:00Z"),
    check("Tests pass", "SUCCESS", "tests", "new", "2026-01-01T00:01:00Z"),
    check("Tests pass", "FAILURE", "another-workflow", "other", "2026-01-01T00:00:00Z"),
    check("Only cancelled run", "CANCELLED", "unreplaced", "cancelled", "2026-01-01T00:00:00Z"),
  ]);
  expect(current.map(c => [c.name, c.conclusion])).toEqual([["Test (1)", "SUCCESS"], ["Tests pass", "SUCCESS"], ["Tests pass", "FAILURE"], ["Only cancelled run", "CANCELLED"]]);
});

test.each([true, false, undefined])("cancelled checks only stop blocking when GitHub explicitly says required=%s", required => {
  const snapshot = { ...healthy(), checks: [{ name: "Optional lint", status: "COMPLETED", conclusion: "CANCELLED", required, url: "" }] };
  expect(decide(snapshot).kind).toBe(required === false ? "ready" : "fix");
});

test("a question from a run that never started its terminal stays put without a herdr error", async () => {
  const h = harness(); h.runner.observe = async () => { throw new Error('hc exited 3: {"error":{"kind":"not_found","message":"no terminal \\"fixture-job\\""}}'); };
  await h.controller.reconcile(broken(), true);
  const record = h.store.get(42)!;
  expect(record.decision.kind).toBe("human"); expect(record.humanHead).toBe("head"); expect(record.lastError).toBeUndefined();
  h.runner.observe = async () => { throw new Error("hc exited 1: registry writer stopped"); };
  await expect(h.controller.reconcile(broken(), true)).rejects.toThrow("registry writer");
});
