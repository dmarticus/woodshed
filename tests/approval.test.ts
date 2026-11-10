import { expect, test } from "bun:test";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { GitHub } from "../src/github";
import { Settings } from "../src/settings";
import { handler, publicState } from "../src/http";
import { approvalRequestState, decide, fingerprint, type Config, type Record as PRRecord, type Snapshot } from "../src/model";
import { assessmentKey } from "../src/triage";

const snapshot = (head = "head-a"): Snapshot => ({ number: 42, author: "owner", title: "Fix reports", url: "https://github.com/example/project/pull/42", head, branch: "fix/reports", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["Team Surfaces"], checks: [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], reviews: [{ author: "posthog[bot]", state: "COMMENTED", body: "Reviewed", head, submittedAt: "2026-01-01T00:00:00Z" }], threads: [], labels: [] });
const record = (pr = snapshot()): PRRecord => ({ snapshot: pr, decision: decide(pr), paused: false, watching: true, attempts: 0, fingerprint: fingerprint(pr) });
function harness(mode: Config["mode"] = "auto") {
  const config: Config = { mode, automation: mode === "auto", repository: "example/project", author: "@me", checkout: "", port: 7341, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, approvalLabel: "stamphog", reviewLabel: "posthog-review" };
  const store = new Store(":memory:"); let live = snapshot(); let owner = true; let requests = 0; let launches = 0;
  const labels: string[] = [];
  const github: any = { snapshot: async () => structuredClone(live), list: async () => [], canMaintain: async () => owner, canMaintainKnown: () => owner, requestApproval: async (number: number, head: string) => { expect(number).toBe(42); expect(head).toBe(live.head); requests++; }, label: async (_: number, label: string) => { labels.push(label); } };
  const runner: any = { launch: async () => { launches++; }, stop: async () => {}, status: async () => ({ state: "working" }) };
  const controller = new Controller(config, store, github, runner);
  store.put(record(live));
  return { config, store, github, runner, controller, requests: () => requests, launches: () => launches, labels, live: (next: Snapshot) => { live = next; }, owner: (value: boolean) => { owner = value; } };
}

test("pending human reviewers do not block Stamphog after current-commit review", () => {
  const pr = snapshot();
  expect(decide(pr).kind).toBe("approval");
  expect(approvalRequestState(record(pr), true, "watch")).toMatchObject({ status: "available", canRequest: true, head: pr.head });
  pr.reviews = [];
  expect(decide(pr)).toMatchObject({ kind: "waiting", reason: "Waiting for review from Team Surfaces" });
  expect(approvalRequestState(record(pr), true, "auto").canRequest).toBe(false);
});

test.each(["pending CI", "failed CI", "threads", "conflict", "unknown mergeability", "changes requested", "old review", "draft", "closed", "owner decision"])("approval cannot bypass %s", async blocker => {
  const h = harness("watch"); const pr = snapshot(); const row = record(pr);
  if (blocker === "pending CI") pr.checks[0] = { ...pr.checks[0], status: "IN_PROGRESS", conclusion: null };
  if (blocker === "failed CI") pr.checks[0].conclusion = "FAILURE";
  if (blocker === "threads") pr.threads = [{ id: "open", comments: [] }];
  if (blocker === "conflict") pr.mergeable = "CONFLICTING";
  if (blocker === "unknown mergeability") pr.mergeable = "UNKNOWN";
  if (blocker === "changes requested") pr.reviewDecision = "CHANGES_REQUESTED";
  if (blocker === "old review") pr.reviews[0].head = "old";
  if (blocker === "draft") pr.draft = true;
  if (blocker === "closed") pr.state = "CLOSED";
  row.decision = blocker === "owner decision" ? { kind: "human", reason: "Confirm an operational prerequisite" } : decide(pr);
  h.store.put(row); h.live(pr);
  expect(approvalRequestState(row, true, "watch").canRequest).toBe(false);
  await expect(h.controller.action(42, "request-approval", { head: pr.head })).rejects.toThrow();
  expect(h.requests()).toBe(0);
});

test("Auto requests once per commit and persists the receipt across a controller restart", async () => {
  const h = harness(); await h.controller.reconcile(snapshot());
  expect(h.requests()).toBe(1);
  expect(h.store.get(42)).toMatchObject({ requestedApproval: "head-a", decision: { kind: "approval" } });
  expect(h.store.get(42)?.approvalRequestedAt).toBeString();
  const restarted = new Controller(h.config, h.store, h.github, h.runner);
  await restarted.reconcile(snapshot()); await restarted.action(42, "request-approval", { head: "head-a" });
  expect(h.requests()).toBe(1);
  const next = snapshot("head-b"); next.reviews[0].head = "head-a"; h.live(next);
  await restarted.reconcile(next); expect(h.requests()).toBe(1);
  next.reviews[0].head = "head-b"; h.live(next);
  await restarted.reconcile(next); expect(h.requests()).toBe(2);
  h.live(snapshot()); await restarted.reconcile(snapshot());
  expect(h.requests()).toBe(2); // Returning to a previously requested commit must not trigger it again.
});

test("Watch mode requires the manual button and does not start repair work", async () => {
  const h = harness("watch"); await h.controller.reconcile(snapshot()); expect(h.requests()).toBe(0);
  await h.controller.action(42, "request-approval", { head: "head-a" });
  expect(h.requests()).toBe(1); expect(h.launches()).toBe(0); expect(h.config.mode).toBe("watch");
  const row = h.store.get(42)!;
  expect(approvalRequestState(row, true, "watch")).toMatchObject({ status: "requested", canRequest: false });
  expect(row.decision.reason).toContain("Stamphog requested");
  expect(row.snapshot.reviewDecision).toBe("REVIEW_REQUIRED");
});

test.each(["watch", "paused", "PR paused", "not watched", "not owner", "observe"])("Auto respects the %s guard", async guard => {
  const h = harness(); const row = h.store.get(42)!;
  if (guard === "watch" || guard === "paused") h.config.mode = guard;
  if (guard === "PR paused") row.paused = true;
  if (guard === "not watched") row.watching = false;
  if (guard === "not owner") h.owner(false);
  h.store.put(row); await h.controller.reconcile(snapshot(), guard === "observe");
  expect(h.requests()).toBe(0);
});

test("manual requests reject stale heads, missing heads, paused work and other authors", async () => {
  const h = harness("watch");
  await expect(h.controller.action(42, "request-approval", {})).rejects.toThrow("head");
  h.live(snapshot("head-b"));
  await expect(h.controller.action(42, "request-approval", { head: "head-a" })).rejects.toThrow("changed");
  h.live(snapshot()); h.owner(false);
  await expect(h.controller.action(42, "request-approval", { head: "head-a" })).rejects.toThrow("own PRs");
  h.owner(true); h.config.mode = "paused";
  await expect(h.controller.action(42, "request-approval", { head: "head-a" })).rejects.toThrow("Resume");
  expect(h.requests()).toBe(0);
});

test("a label failure never becomes a successful request receipt and can be retried", async () => {
  const h = harness("watch"); const send = h.github.requestApproval;
  h.github.requestApproval = async () => { throw new Error("GitHub unavailable"); };
  await expect(h.controller.action(42, "request-approval", { head: "head-a" })).rejects.toThrow("unavailable");
  expect(h.store.get(42)?.requestedApproval).toBeUndefined();
  expect(approvalRequestState(h.store.get(42)!, true, "watch").status).toBe("available");
  h.github.requestApproval = send; await h.controller.action(42, "request-approval", { head: "head-a" }); expect(h.requests()).toBe(1);
});

test("a cached generic review wait cannot suppress an eligible approval request", async () => {
  const h = harness(); const row = h.store.get(42)!;
  row.assessment = { head: row.snapshot.head, key: assessmentKey(row.snapshot), report: "Previously waiting for reviewers", attempts: 1, followups: 0, result: { head: row.snapshot.head, route: "wait", category: "review", title: "Wait for review", reason: "Another reviewer is requested", evidence: [] } };
  h.runner.launchTriage = async () => { throw new Error("No new investigation is needed"); };
  h.store.put(row); await h.controller.reconcile(snapshot()); expect(h.requests()).toBe(1);
});

test("an operational wait still blocks manual approval despite green CI and review", async () => {
  const h = harness("watch"); const row = h.store.get(42)!;
  row.decision = { kind: "waiting", reason: "Waiting for the migration to finish" };
  row.assessment = { head: row.snapshot.head, key: assessmentKey(row.snapshot), report: "Operational prerequisite", attempts: 1, followups: 0, result: { head: row.snapshot.head, route: "wait", category: "operations", title: "Wait for migration", reason: "Waiting for the migration to finish", evidence: [] } };
  h.store.put(row);
  expect(approvalRequestState(row, true, "watch").canRequest).toBe(false);
  await expect(h.controller.action(42, "request-approval", { head: row.snapshot.head })).rejects.toThrow("migration");
  expect(h.requests()).toBe(0);
});

test("Stamphog refusals stay human decisions and a later approval resolves them", async () => {
  const h = harness(); const pr = snapshot();
  pr.reviews.push({ author: "stamphog[bot]", head: pr.head, state: "COMMENTED", body: "REFUSED: confirm the migration", submittedAt: "2026-01-01T00:01:00Z" });
  h.runner.launchTriage = async () => { throw new Error("Do not route the refusal back to an agent"); };
  h.live(pr); await h.controller.reconcile(pr); await h.controller.reconcile(pr);
  expect(h.store.get(42)?.decision.kind).toBe("human"); expect(h.requests()).toBe(0);
  pr.checks[0].conclusion = "FAILURE"; h.live(pr); await h.controller.reconcile(pr);
  expect(h.store.get(42)?.decision.kind).toBe("human"); expect(h.launches()).toBe(0);
  pr.checks[0].conclusion = "SUCCESS";
  expect(approvalRequestState(h.store.get(42)!, true, "auto").status).toBe("human");
  await expect(h.controller.action(42, "request-approval", { head: pr.head })).rejects.toThrow("human review");
  pr.reviewDecision = "APPROVED";
  pr.reviews.push({ author: "human-reviewer", head: pr.head, state: "APPROVED", body: "Migration confirmed", submittedAt: "2026-01-01T00:02:00Z" });
  h.live(pr); await h.controller.reconcile(pr); expect(h.store.get(42)?.decision.kind).toBe("ready");
});

test("actual current-head approval is required; a label and old approval are insufficient", () => {
  const pr = snapshot(); pr.labels.push("stamphog");
  expect(approvalRequestState(record(pr), true, "auto").status).toBe("available");
  pr.reviews.push({ author: "stamphog[bot]", head: "old-head", state: "APPROVED", body: "Approved", submittedAt: "" });
  expect(approvalRequestState(record(pr), true, "auto").status).toBe("available");
  pr.reviews.at(-1)!.head = pr.head;
  expect(approvalRequestState(record(pr), true, "auto").status).toBe("approved");
  expect(decide(pr)).toMatchObject({ kind: "waiting", reason: "Stamphog approved this commit; waiting for remaining required approvals" });
});

test("repair publication waits for fresh CI and review before requesting approval on the repaired head", async () => {
  const h = harness(); const old = snapshot(); old.checks[0].conclusion = "FAILURE";
  const row = record(old); row.job = { name: "repair", head: old.head, fingerprint: fingerprint(old), startedAt: "2026-01-01T00:00:00Z" };
  h.store.put(row); h.runner.status = async () => ({ state: "published" }); h.live(old);
  await h.controller.reconcile(old); expect(h.requests()).toBe(0); expect(h.store.get(42)?.job).toBeUndefined();
  const next = snapshot("repaired-head"); next.checks[0] = { ...next.checks[0], status: "IN_PROGRESS", conclusion: null };
  h.live(next); await h.controller.reconcile(next); expect(h.requests()).toBe(0);
  next.checks[0] = { ...next.checks[0], status: "COMPLETED", conclusion: "SUCCESS" };
  h.live(next); await h.controller.reconcile(next);
  expect(h.requests()).toBe(1); expect(h.store.get(42)?.requestedApproval).toBe("repaired-head");
});

test("the native endpoint enforces head and preview guards and exposes the request status", async () => {
  const h = harness("watch"); const settings = new Settings(h.config, "/unused-approval-fixture.json");
  const route = handler(h.controller, settings, "test-token");
  const request = (body: unknown) => new Request("http://127.0.0.1:7341/api/prs/42/request-approval", { method: "POST", headers: { Host: "127.0.0.1:7341", Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((publicState(h.controller, settings) as any).prs[0].approval.canRequest).toBe(true);
  expect((await route(request({}))).status).toBe(400);
  expect((await route(request({ head: "head-a" }))).status).toBe(200);
  expect((publicState(h.controller, settings) as any).prs[0].approval.status).toBe("requested");
  const preview = handler(h.controller, new Settings(h.config, "/unused-approval-fixture.json", true), "test-token");
  expect((await preview(request({ head: "head-a" }))).status).toBe(409);
});

test("a lingering approval label is removed and re-added with a head check between writes", async () => {
  const calls: string[][] = []; let views = 0;
  const github = new GitHub({ repository: "example/project", approvalLabel: "ai/approval" } as Config, async argv => {
    calls.push(argv);
    if (argv[1] === "pr" && argv[2] === "view") { views++; return JSON.stringify({ headRefOid: "current", state: "OPEN", isDraft: false, labels: [{ name: "ai/approval" }] }); }
    return "";
  });
  await github.requestApproval(42, "current");
  expect(views).toBe(2);
  expect(calls[1]).toContain("repos/example/project/issues/42/labels/ai%2Fapproval");
  expect(calls[1]).toContain("DELETE");
  expect(calls.at(-1)).toContain("--add-label");
  expect(calls.at(-1)).toContain("ai/approval");
});

test("a head change during label refresh prevents the approval trigger", async () => {
  const calls: string[][] = []; let views = 0;
  const github = new GitHub({ repository: "example/project", approvalLabel: "stamphog" } as Config, async argv => {
    calls.push(argv);
    if (argv[1] === "pr" && argv[2] === "view") return JSON.stringify({ headRefOid: ++views === 1 ? "old" : "new", state: "OPEN", isDraft: false, labels: [{ name: "stamphog" }] });
    return "";
  });
  await expect(github.requestApproval(42, "old")).rejects.toThrow("changed");
  expect(calls.some(argv => argv.includes("--add-label"))).toBe(false);
});
