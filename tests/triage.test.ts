import { expect, test } from "bun:test";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { decide, fingerprint, type AssessmentResult, type Config, type Snapshot } from "../src/model";
import { assessmentKey, parseAssessment } from "../src/triage";
import { routeWithCIEvidence } from "../src/check-evidence";
import { localDay } from "../src/usage";
import { checkWithJev } from "../src/jev";

const pr = (): Snapshot => ({ number: 42, title: "Fix export", url: "https://github.com/example/project/pull/42", head: "abc", branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], labels: [], reviews: [{ author: "reviewer", state: "APPROVED", body: "Reviewed", head: "abc", submittedAt: "" }] });
const answer = (route: AssessmentResult["route"] = "ask"): AssessmentResult => ({ head: "abc", route, category: "operations", title: "Confirm the prerequisite", reason: "This change depends on an operational step.", question: "Confirm the prerequisite was completed in both regions.", instructions: "Verify the intended repair and declare its changed files.", evidence: [{ url: "https://github.com/example/project/issues/40", detail: "The issue requires the step before deployment." }] });
function harness() {
  const store = new Store(":memory:"); const snapshot = pr();
  store.put({ snapshot, fingerprint: fingerprint(snapshot), paused: false, attempts: 1, decision: { kind: "human", reason: "Long unverified implementation report" }, humanHead: snapshot.head, humanReason: "Long unverified implementation report" });
  let outcome: any = { state: "working" }; let launches = 0;
  const runner: any = { launchTriage: async () => { launches++; }, stop: async () => {}, status: async () => outcome, telemetry: async (job: any) => { const run = store.run(job.name); return run ? { ...run, turns: 1, costUSD: 0.1 } : undefined; } };
  const config = { mode: "auto", automation: true, workerProtocol: "app-server", maxConcurrentJobs: 1, maxAttempts: 3, runCapUSD: 5, dailyCapUSD: 20 } as Config;
  const github: any = { snapshot: async () => store.get(42)!.snapshot, canMaintain: async () => true, label: async () => {}, requestApproval: async () => {} };
  return { store, snapshot, runner, controller: new Controller(config, store, github, runner), outcome: (value: any) => { outcome = value; }, launches: () => launches };
}

test("raw escalation is investigated before attention, and a real operations question survives green CI", async () => {
  const h = harness(); await h.controller.prepareAttention();
  expect(h.store.get(42)?.decision.kind).toBe("waiting"); expect(h.launches()).toBe(0);
  await h.controller.reconcile(h.snapshot);
  expect(h.store.get(42)?.decision.kind).toBe("waiting"); expect(h.store.get(42)?.job?.kind).toBe("triage");
  h.outcome({ state: "triaged", assessment: answer() }); await h.controller.reconcile(h.snapshot);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", title: "Confirm the prerequisite", question: answer().question });
  await h.controller.reconcile(h.snapshot, true);
  expect(h.store.get(42)?.decision.kind).toBe("human"); expect(h.launches()).toBe(1);
  await h.controller.action(42, "reply", { head: "abc", message: "Completed in both regions" });
  expect(h.store.get(42)?.decision.kind).toBe("waiting");
  await h.controller.reconcile(h.snapshot); expect(h.launches()).toBe(2);
  h.outcome({ state: "triaged", assessment: { ...answer("ready"), category: "operations" } }); await h.controller.reconcile(h.snapshot);
  expect(h.store.get(42)?.decision.kind).toBe("ready");
});

test("requested reviews wait quietly and an approval invalidates cached waiting evidence", async () => {
  const h = harness(); const waiting = { ...h.snapshot, reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["Team Review"], reviews: [{ ...h.snapshot.reviews[0], state: "COMMENTED", author: "reviewer", body: "Review requested" }] };
  expect(decide(waiting)).toMatchObject({ kind: "waiting", reason: "Waiting for review from Team Review" });
  await h.controller.reconcile(waiting); h.outcome({ state: "triaged", assessment: { ...answer("wait"), category: "review" } }); await h.controller.reconcile(waiting);
  expect(h.store.get(42)?.decision.kind).toBe("waiting");
  await h.controller.reconcile(h.snapshot); expect(h.launches()).toBe(1);
  expect(h.store.get(42)?.decision.kind).toBe("ready");
});

test("verified bot cleanup ends the review retry loop even after two follow-ups", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.reviewDecision = "REVIEW_REQUIRED"; record.snapshot.reviewRequests = ["Team Review"];
  record.snapshot.reviews = [];
  record.snapshot.threads = [{ id: "bot-thread", comments: [{ author: "posthog", authorType: "Bot", body: "Missing fallback <!-- reviewhog:finding -->", url: "https://github.com/example/project/pull/42#discussion_r1" }] }];
  const result = { ...answer("wait"), category: "review" as const, title: "Wait for requested review", reason: "The fallback is fixed; the team review is already requested.", review_threads: [{ id: "bot-thread", status: "addressed" as const, reason: "The current commit handles the missing value.", code_url: "https://github.com/example/project/blob/abc/src/export.ts#L12" }] };
  record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "No edits needed", attempts: 1, followups: 2, result };
  h.store.put(record);
  let cleanups = 0; let resumes = 0;
  (h.controller.github as any).resolveAddressedThreads = async (snapshot: Snapshot) => { cleanups++; return { snapshot: { ...snapshot, threads: [] }, resolved: ["bot-thread"] }; };
  h.runner.resume = async () => { resumes++; };
  for (let i = 0; i < 3; i++) await h.controller.reconcile(h.store.get(42)!.snapshot);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "waiting", title: result.title });
  expect(h.store.get(42)?.decision.reason).toBe("Waiting for review from Team Review");
  expect(h.store.get(42)?.snapshot.threads).toEqual([]);
  expect(h.store.get(42)?.assessment?.result?.route).toBe("wait");
  expect(h.store.get(42)?.assessment?.followups).toBe(2);
  expect(cleanups).toBe(1); expect(resumes).toBe(0); expect(h.launches()).toBe(0);
});

test("a persisted review wait overwritten by the old controller is reinvestigated without resetting follow-ups", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.reviewDecision = "REVIEW_REQUIRED"; record.snapshot.reviewRequests = ["Team Review"];
  record.snapshot.threads = [{ id: "thread", comments: [{ author: "posthog", body: "Already handled", url: "https://github.com/example/project/pull/42#discussion_r1" }] }];
  record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "The finding is already addressed", attempts: 1, followups: 2, result: { ...answer("repair"), category: "review", instructions: "Continue the original maintenance task in its saved checkout. GitHub still reports: 1 open review threads." } };
  h.store.put(record);
  await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.decision.kind).toBe("waiting");
  expect(h.store.get(42)?.job?.kind).toBe("triage");
  expect(h.store.get(42)?.assessment?.followups).toBe(2);
  expect(h.launches()).toBe(1);
});

test("a verified reviewer-owned discussion waits without repair retries and new feedback is investigated", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.reviewDecision = "REVIEW_REQUIRED"; record.snapshot.reviewRequests = ["Team Review"]; record.snapshot.reviews = [];
  record.snapshot.threads = [{ id: "discussion", comments: [{ author: "reviewer", authorType: "User", body: "I'll verify the design", url: "https://github.com/example/project/pull/42#discussion_r1" }] }];
  record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Waiting for the reviewer", attempts: 1, followups: 2, result: { ...answer("wait"), category: "review", review_threads: [{ id: "discussion", status: "awaiting_reviewer", reason: "The reviewer is checking the current behavior." }] } };
  h.store.put(record);
  await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.decision.kind).toBe("waiting"); expect(h.launches()).toBe(0);
  const changed = structuredClone(record.snapshot); changed.threads[0].comments[0].body = "The fallback still fails for an empty value";
  await h.controller.reconcile(changed);
  expect(h.store.get(42)?.job?.kind).toBe("triage"); expect(h.launches()).toBe(1);
});

test("new discussion during bot cleanup invalidates the earlier review wait", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.threads = ["handled", "discussion"].map(id => ({ id, comments: [{ author: "reviewer", body: "Old discussion", url: `https://github.com/example/project/pull/42#${id}` }] }));
  record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Handled", attempts: 1, followups: 2, result: { ...answer("wait"), category: "review", review_threads: [{ id: "handled", status: "addressed", reason: "Fixed", code_url: "https://github.com/example/project/blob/abc/file.ts" }, { id: "discussion", status: "awaiting_reviewer", reason: "Reviewer is checking" }] } };
  h.store.put(record);
  (h.controller.github as any).resolveAddressedThreads = async (snapshot: Snapshot) => ({ snapshot: { ...snapshot, threads: [{ ...snapshot.threads[1], comments: [{ ...snapshot.threads[1].comments[0], body: "New defect found" }] }] }, resolved: ["handled"] });
  await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.job?.kind).toBe("triage"); expect(h.launches()).toBe(1);
  expect(h.store.get(42)?.assessment?.result).toBeUndefined();
});

test.each(["watch", "paused", "observe"])("verified thread cleanup respects the %s guard", async guard => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.threads = [{ id: "thread", comments: [] }]; record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Handled", attempts: 1, followups: 0, result: { ...answer("wait"), category: "review", review_threads: [{ id: "thread", status: "addressed", reason: "Fixed on the current head", code_url: "https://github.com/example/project/blob/abc/file.ts" }] } };
  h.store.put(record);
  let cleanups = 0; (h.controller.github as any).resolveAddressedThreads = async () => { cleanups++; throw Error("Must not mutate GitHub"); };
  if (guard !== "observe") h.controller.config.mode = guard as "watch" | "paused";
  await h.controller.reconcile(record.snapshot, guard === "observe");
  expect(cleanups).toBe(0); expect(h.store.get(42)?.decision.kind).toBe("waiting");
});

test("an exhausted substantive repair names the remaining finding without overwriting the investigation", async () => {
  const h = harness(); const record = h.store.get(42)!;
  const link = "https://github.com/example/project/pull/42#discussion_r1";
  record.snapshot.threads = [{ id: "thread", comments: [{ author: "reviewer", body: "Handle the missing value", url: link }] }]; record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Repair remains", attempts: 1, followups: 2, result: { ...answer("wait"), category: "review", review_threads: [{ id: "thread", status: "needs_repair", reason: "The empty-value fallback still returns an invalid URL." }] } };
  h.store.put(record); await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", title: "Review feedback still needs a fix", response: "retry", action: { url: link } });
  expect(h.store.get(42)?.decision.reason).toContain("empty-value fallback");
  expect(h.store.get(42)?.assessment?.result?.route).toBe("wait");
});

test("review wait validation requires complete findings and addressed findings require current-commit code evidence", () => {
  const thread = { id: "thread", comments: [] };
  const result = { ...answer("wait"), category: "review" as const };
  expect(() => parseAssessment(result, "abc", [thread])).toThrow("every unresolved thread");
  for (const code_url of ["https://github.com/example/project/blob/old/file.ts", "https://example.com/example/project/blob/abc/file.ts"]) {
    expect(() => parseAssessment({ ...result, review_threads: [{ id: "thread", status: "addressed", reason: "Fixed", code_url }] }, "abc", [thread])).toThrow();
  }
  expect(() => parseAssessment({ ...result, review_threads: [{ id: "thread", status: "addressed", reason: "Fixed", code_url: "https://github.com/other/project/blob/abc/file.ts" }] }, "abc", [thread], "example/project")).toThrow("this repository");
  expect(parseAssessment({ ...result, review_threads: [{ id: "thread", status: "awaiting_reviewer", reason: "The reviewer is verifying behavior" }] }, "abc", [thread]).route).toBe("wait");
});

test("triage cannot mark failed CI ready, and malformed investigations stop after two bounded attempts", async () => {
  const h = harness(); const failing = { ...h.snapshot, checks: [{ ...h.snapshot.checks[0], conclusion: "FAILURE" }] };
  await h.controller.reconcile(failing); h.outcome({ state: "triaged", assessment: answer("ready") }); await h.controller.reconcile(failing);
  expect(h.store.get(42)?.decision.kind).toBe("waiting"); expect(h.launches()).toBe(2);
  h.outcome({ state: "human", reason: "Malformed result" }); await h.controller.reconcile(failing);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", title: "Recheck this PR" });
  await h.controller.reconcile(failing); expect(h.launches()).toBe(2);
});

test.each(["repair", "conflict", "behind", "CI", "threads"])("routine follow-ups resume the saved checkout and preserve spend when routing %s", async kind => {
  const h = harness(); let resumed = ""; let resumes = 0;
  h.runner.resume = async (job: any) => { resumed = job.name; resumes++; };
  const record = h.store.get(42)!;
  if (kind !== "repair") { record.snapshot.reviewDecision = "REVIEW_REQUIRED"; record.snapshot.reviewRequests = ["Team Review"]; }
  if (kind === "conflict") { record.snapshot.mergeable = "CONFLICTING"; record.snapshot.mergeStateStatus = "DIRTY"; }
  if (kind === "behind") record.snapshot.mergeStateStatus = "BEHIND";
  if (kind === "CI") record.snapshot.checks[0].conclusion = "FAILURE";
  if (kind === "threads") record.snapshot.threads = [{ id: "thread", comments: [{ author: "reviewer", body: "Handle the missing value", url: "https://github.com/example/project/pull/42#discussion_r1" }] }];
  const source = { name: "saved-repair", head: "abc", fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" as const, budgetUSD: 5, kind: ["conflict", "behind"].includes(kind) ? "branch-update" as const : "repair" as const };
  h.store.saveRun({ id: source.name, number: 42, startedAt: source.startedAt, endedAt: source.startedAt, state: "stopped", model: "fixture", turns: 1, costUSD: 0.2, costsByDay: {}, summary: "Saved repair" });
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Original run needs a follow-up", sourceJob: source, attempts: 1, followups: 0, result: { ...answer(kind === "repair" ? "repair" : "wait"), category: kind === "repair" ? "internal" : "review" } };
  record.humanHead = undefined; h.store.put(record);
  await h.controller.reconcile(record.snapshot);
  expect(resumed).toBe("saved-repair"); expect(h.store.get(42)?.job?.name).toBe("saved-repair");
  expect(h.store.run(source.name)).toMatchObject({ state: "running", costUSD: 0.2 });
  expect(h.store.get(42)?.assessment?.followups).toBe(1);
  await h.controller.reconcile(record.snapshot); expect(resumes).toBe(1);
});

test.each(["paused", "watch", "observe", "exhausted", "budget", "operations"])("review waits with conflicts preserve the %s guard", async guard => {
  const h = harness(); let resumes = 0; h.runner.resume = async () => { resumes++; };
  const record = h.store.get(42)!; record.snapshot.mergeable = "CONFLICTING"; record.snapshot.mergeStateStatus = "DIRTY";
  const source = { name: "saved-repair", head: "abc", fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" as const, budgetUSD: 5 };
  h.store.saveRun({ id: source.name, number: 42, startedAt: source.startedAt, endedAt: source.startedAt, state: "stopped", model: "fixture", turns: 1, costUSD: guard === "budget" ? null : 0.2, costsByDay: {}, summary: "Saved repair" });
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Original conflict report", sourceJob: source, attempts: 1, followups: guard === "exhausted" ? 2 : 0, result: { ...answer(guard === "operations" ? "ask" : "wait"), category: guard === "operations" ? "operations" : "review" } };
  record.humanHead = undefined; h.store.put(record);
  if (["paused", "watch"].includes(guard)) h.controller.config.mode = guard === "paused" ? "paused" : "watch";
  await h.controller.reconcile(record.snapshot, guard === "observe");
  expect(resumes).toBe(0); expect(h.store.get(42)?.job).toBeUndefined();
  if (["exhausted", "budget", "operations"].includes(guard)) expect(h.store.get(42)?.decision.kind).toBe("human");
});

test.each([true, false])("a completed scope-blocked resolution gets one validated recovery without resetting follow-ups (eligible: %s)", async eligible => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.mergeable = "CONFLICTING"; record.snapshot.mergeStateStatus = "DIRTY";
  const source = { name: "saved-resolution", kind: "branch-update" as const, head: "abc", fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" as const, budgetUSD: 5 };
  h.store.saveRun({ id: source.name, number: 42, startedAt: source.startedAt, endedAt: source.startedAt, state: "stopped", model: "fixture", turns: 8, costUSD: 0.4, costsByDay: {}, summary: "Prepared resolution" });
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Could not safely complete the branch update: Resolution edited files outside the conflict set: feature.ts", sourceJob: source, attempts: 1, followups: 2, result: { ...answer("repair"), category: "internal" } };
  record.humanHead = undefined; h.store.put(record);
  let resumes = 0; h.runner.resume = async () => { resumes++; }; h.runner.recoverPreparedUpdate = async () => eligible;
  await h.controller.reconcile(record.snapshot);
  expect(resumes).toBe(0); expect(h.store.run(source.name)?.costUSD).toBe(0.4);
  if (eligible) { expect(h.store.get(42)?.job?.name).toBe(source.name); expect(h.store.get(42)?.assessment?.followups).toBe(2); expect(h.store.get(42)?.assessment?.result).toBeUndefined(); }
  else { expect(h.store.get(42)?.job).toBeUndefined(); expect(h.store.get(42)?.assessment?.followups).toBe(2); expect(h.store.get(42)?.decision.kind).toBe("human"); }
});

test.each(["wrong head", "unactionable question", "unsafe link", "oversized report"])("rejects %s before displaying triage", kind => {
  const result = answer();
  if (kind === "wrong head") result.head = "old";
  if (kind === "unactionable question") result.question = "";
  if (kind === "unsafe link") result.action = { label: "Open", url: "file:///etc/passwd" };
  if (kind === "oversized report") result.reason = "x".repeat(501);
  expect(() => parseAssessment(result, "abc")).toThrow();
});

test("optional Jev routing uses typed choices, validates responses, and makes no request without a key", async () => {
  let requests = 0;
  const request: any = async (_url: string, init: RequestInit) => {
    requests++; const body = JSON.parse(init.body as string);
    expect(body.questions.route.type).toBe("choice"); expect(Object.keys(body.questions.route.criteria).sort()).toEqual(["ask", "ready", "repair", "wait"]);
    return Response.json({ model: "jev-1.14.0", answers: { route: { type: "choice", choice: "ask", confidence: 0.95 } }, usage: { input_tokens: 500 } });
  };
  expect(await checkWithJev(pr(), answer(), "", request)).toBeUndefined(); expect(requests).toBe(0);
  expect(await checkWithJev(pr(), answer(), "fixture-key", request)).toMatchObject({ choice: "ask", inputTokens: 500 });
  await expect(checkWithJev(pr(), answer(), "fixture-key", (async () => Response.json({ answers: { route: { choice: "invented" } } })) as any)).rejects.toThrow("Invalid TypeSafe");
});


test("a requested reviewer cannot hide failing CI in a review-wait result", () => {
  const checks = [{ ...pr().checks[0], conclusion: "FAILURE" }];
  const result = { ...answer("wait"), category: "review" as const };
  expect(() => parseAssessment(result, "abc", [], "example/project", checks)).toThrow("does not explain failing CI");
  expect(parseAssessment({ ...result, category: "checks" }, "abc", [], "example/project", checks).route).toBe("wait");
});

test("missing CI-provider access remains an explicit owner action despite requested reviews", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.reviewRequests = ["Team Review"]; record.snapshot.checks[0].conclusion = "FAILURE";
  record.humanHead = undefined;
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "CI provider access is missing", attempts: 1, followups: 2, result: { ...answer(), category: "operations", response: "recheck", title: "Connect Depot on the maintenance server", reason: "Woodshed cannot retry the failed checks without Depot access.", question: "Sign in to Depot on the server, or retry the failed jobs in Depot. Then recheck this PR.", action: { label: "Open failed job", url: "https://depot.dev/job/example" } } };
  h.store.put(record); await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", response: "recheck", title: "Connect Depot on the maintenance server", action: { url: "https://depot.dev/job/example" } });
  expect(h.store.get(42)?.decision.question).not.toContain("Team Review");
  expect(h.launches()).toBe(0); expect(h.store.get(42)?.assessment?.followups).toBe(2);
});

test("legacy mixed review/CI escalation gets one bounded investigation without restarting repair or resetting spend", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.snapshot.checks[0].conclusion = "FAILURE"; record.humanHead = undefined;
  h.store.saveRun({ id: "previous-repair", number: 42, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), state: "stopped", model: "fixture", turns: 2, costUSD: 0.4, costsByDay: { [localDay()]: 0.4 }, summary: "Saved repair" });
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Depot token missing; cannot retry", attempts: 1, followups: 2, result: { ...answer("wait"), category: "review" } };
  h.store.put(record);
  await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.assessment).toMatchObject({ followups: 2, attentionVersion: 1 });
  expect(h.launches()).toBe(1);
  h.outcome({ state: "triaged", assessment: { ...answer("wait"), category: "review" } });
  await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", title: "CI still needs a fix", response: "retry" });
  expect(h.launches()).toBe(1); expect(h.store.spend(20).spentUSD).toBeGreaterThanOrEqual(0.4);
  await h.controller.reconcile(record.snapshot); expect(h.launches()).toBe(1);
});

test("owner response is validated and preserved for an external prerequisite", () => {
  expect(parseAssessment({ ...answer(), response: "recheck" }, "abc").response).toBe("recheck");
  expect(() => parseAssessment({ ...answer(), response: "retry" }, "abc")).toThrow("response type");
});


test("legacy provider-login asks refresh once with GitHub test diagnostics attached and keep the repair bound", async () => {
  const h = harness(); const record = h.store.get(42)!;
  record.humanHead = undefined; record.snapshot.checks[0].conclusion = "FAILURE";
  const evidence = { head: "abc", reports: [{ name: "Tests", github_url: "https://github.com/example/project/runs/123", provider_url: "https://depot.dev/job/123", title: "1 failing test", summary: "AssertionError in tests/test_example.py::test_flag", text: "", annotations: [], test_failures: ["tests/test_example.py::test_flag"] }], unavailable: [] };
  let reads = 0; (h.controller.github as any).failureEvidence = async () => { reads++; return evidence; };
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Provider logs need login", attempts: 1, followups: 2, result: { ...answer(), category: "checks", response: "recheck" } };
  h.store.put(record); await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.job?.ciEvidence).toEqual(evidence);
  expect(h.store.get(42)?.assessment).toMatchObject({ ciEvidenceVersion: 1, followups: 2 });
  h.outcome({ state: "triaged", assessment: routeWithCIEvidence({ ...answer(), category: "checks" }, evidence) });
  await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", title: "CI still needs a fix", response: "retry" });
  expect(reads).toBe(1); expect(h.launches()).toBe(1);
  await h.controller.reconcile(record.snapshot); expect(reads).toBe(1); expect(h.launches()).toBe(1);
});


test("resumed follow-ups share daily budget with other queued PRs without increasing their original cap", async () => {
  const h = harness(); h.controller.config.dailyCapUSD = 4; h.controller.config.maxConcurrentJobs = 3;
  h.runner.resume = async () => {};
  for (const number of [43, 44]) { const snapshot = { ...pr(), number, branch: "feature-" + number }; snapshot.checks[0] = { ...snapshot.checks[0], conclusion: "FAILURE" }; h.store.put({ snapshot, paused: false, attempts: 0, fingerprint: fingerprint(snapshot), decision: { kind: "fix", reason: "Tests failed" } }); }
  const record = h.store.get(42)!; record.humanHead = undefined;
  const source = { name: "shared-budget-source", head: "abc", fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" as const, budgetUSD: 5 };
  h.store.saveRun({ id: source.name, number: 42, startedAt: source.startedAt, endedAt: source.startedAt, state: "stopped", model: "fixture", turns: 1, costUSD: 0.2, costsByDay: { [localDay()]: 0.2 }, summary: "Saved repair" });
  record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Follow-up needed", sourceJob: source, attempts: 1, followups: 0, result: answer("repair") };
  h.store.put(record); await h.controller.reconcile(record.snapshot);
  expect(h.store.get(42)?.job?.budgetUSD).toBeCloseTo(1.46);
  expect(h.store.run(source.name)?.budgetUSD).toBeCloseTo(1.46);
  expect(h.controller.budgetAvailable()).toBeCloseTo(2.54);
});


test.each([false, true])("verified owner escalation survives CI churn and restart (legacy=%s) until its thread changes", async legacy => {
  const h = harness(); const record = h.store.get(42)!; record.humanHead = undefined;
  record.snapshot.threads = [{ id: "privacy", comments: [{ author: "bot", body: "Only list connected projects", url: "https://example.com/thread" }] }];
  const result: AssessmentResult = { ...answer("repair"), category: "review", review_threads: [{ id: "privacy", status: "needs_repair", reason: "The saved repair is not published." }] };
  record.assessment = { head: record.snapshot.head, key: assessmentKey(record.snapshot), report: "Saved edits", result, attempts: 1, followups: 2 };
  h.store.put(record); await h.controller.reconcile(record.snapshot);
  const decision = h.store.get(42)!.decision;
  expect(decision.kind).toBe("human"); expect(decision.question).toContain("two follow-ups");
  if (legacy) { const prior = h.store.get(42)!; delete prior.assessment!.attention; h.store.put(prior); }
  const restarted = new Controller(h.controller.config, h.store, h.controller.github, h.runner);
  for (let i = 0; i < 4; i++) {
    const changed = { ...record.snapshot, updatedAt: String(i), reviewRequests: ["team"], checks: [{ name: "Other shard " + i, status: "IN_PROGRESS", conclusion: "", url: "" }] };
    await restarted.reconcile(changed, i % 2 === 0);
    expect(h.store.get(42)!.decision).toEqual(decision);
    expect(restarted.queueStatus(h.store.get(42)!)).toBeUndefined();
  }
  expect(h.launches()).toBe(0);
  const resolved = { ...h.store.get(42)!.snapshot, threads: [] };
  await restarted.reconcile(resolved, true);
  expect(h.store.get(42)!.assessment?.attention).toBeUndefined();
  expect(h.store.get(42)!.decision.kind).not.toBe("human");
});

test("an operations question remains stable through check updates and an explicit recheck releases it", async () => {
  const h = harness(); await h.controller.prepareAttention(); await h.controller.reconcile(h.snapshot);
  h.outcome({ state: "triaged", assessment: answer() }); await h.controller.reconcile(h.snapshot);
  const id = h.store.get(42)!.decision.id;
  await h.controller.reconcile({ ...h.snapshot, updatedAt: "new", checks: [] }, true);
  expect(h.store.get(42)!.decision.id).toBe(id); expect(h.store.get(42)!.assessment?.attention).toBeDefined();
  await h.controller.action(42, "recheck", { head: "abc" });
  expect(h.store.get(42)!.assessment?.attention).toBeUndefined(); expect(h.store.get(42)!.decision.kind).toBe("waiting");
});


test("a new commit supersedes an owner escalation and a changed relevant thread triggers verification", async () => {
  for (const change of ["head", "thread"] as const) {
    const h = harness(); const record = h.store.get(42)!; record.humanHead = undefined;
    record.snapshot.threads = [{ id: "privacy", comments: [] }];
    record.assessment = { head: "abc", key: assessmentKey(record.snapshot), report: "Two follow-ups", followups: 2, attempts: 1, result: { ...answer("repair"), category: "review", review_threads: [{ id: "privacy", status: "needs_repair", reason: "Privacy boundary" }] } };
    h.store.put(record); await h.controller.reconcile(record.snapshot);
    const changed = change === "head" ? { ...record.snapshot, head: "new" } : { ...record.snapshot, threads: [{ id: "privacy", comments: [{ author: "owner", body: "Fixed in the current commit", url: "https://example.com/reply" }] }] };
    await h.controller.reconcile(changed, true);
    expect(h.store.get(42)!.assessment?.attention).toBeUndefined();
    expect(h.store.get(42)!.decision.kind).not.toBe("human");
  }
});
