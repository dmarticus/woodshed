import { expect, test } from "bun:test";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { GitHub } from "../src/github";
import { fingerprint, type Config, type Record, type Snapshot } from "../src/model";
import { QueueSubmissionRejected, parseTrunkComments, parseTrunkCheck, trackMergeQueue, mergeQueueDecision, type QueueObservation } from "../src/merge-queue";
import { queueSubmission } from "../src/merge-queue-readiness";

const url = "https://app.trunk.io/example/merge-queue/queue/1";
const healthy = (number = 1): Snapshot => ({ number, title: "Fixture", url: `https://github.com/example/project/pull/${number}`, head: `head-${number}`, branch: `feature-${number}`, base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], reviews: [{ author: "posthog[bot]", head: `head-${number}`, state: "COMMENTED", body: "Reviewed", submittedAt: new Date().toISOString() }], labels: [], author: "owner" });
const observation = (state: QueueObservation["state"], revision: string = state): QueueObservation => ({ provider: "trunk", state, revision, url, updatedAt: new Date().toISOString(), reason: state === "failed" ? "Required tests failed in the merge queue." : undefined });
const record = (number = 1): Record => ({ snapshot: healthy(number), observedAt: new Date().toISOString(), decision: { kind: "ready", reason: "Ready" }, paused: false, watching: true, attempts: 0, fingerprint: "fixture" });
const bot = (body: string, id = 1) => ({ id, body, user: { login: "trunk-io[bot]", type: "Bot" }, html_url: "https://github.com/example/project/pull/1#issuecomment-1", updated_at: new Date().toISOString() });
function harness() {
  const store = new Store(":memory:"); const r = record(); trackMergeQueue(r, observation("available"), Date.now()); store.put(r);
  let state = observation("available"); let submissions = 0; let launches = 0; let stops = 0;
  const github: any = { snapshot: async (n: number) => structuredClone(store.get(n)!.snapshot), mergeQueue: async () => state, canMaintain: async () => true, submitMergeQueue: async () => { submissions++; return "https://github.com/example/project/pull/1#issuecomment-2"; } };
  const runner: any = { launch: async () => { launches++; }, stop: async () => { stops++; }, status: async () => ({ state: "working" }) };
  const config = { repository: "example/project", mode: "auto", automation: true, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 3, runCapUSD: 5, dailyCapUSD: 20 } as Config;
  const controller = new Controller(config, store, github, runner);
  return { store, controller, github, runner, state: (s: QueueObservation) => { state = s; }, counts: () => ({ submissions, launches, stops }) };
}

test.each([
  ["<!-- Trunk Merge -->\nMerging to `main` in this repository is managed by Trunk.\n\nIf the PR fails, failure details will be posted here", "available"],
  ["⏳ This pull request has been submitted to the merge queue. [details](" + url + ")", "queued"],
  ["⏳ This pull request is in the merge queue. [details](" + url + ")", "queued"],
  ["Testing this pull request. [details](" + url + ")", "testing"],
  ["Pending Failure: tests failed, waiting for upstream PRs. [details](" + url + ")", "pending_failure"],
  ["Tests passed. Waiting to merge. [details](" + url + ")", "passing"],
  ["🚫 This pull request was removed from the merge queue because it was canceled by a GitHub user. [here](" + url + ")", "cancelled"],
  ["This pull request was removed from the merge queue because required checks failed. [here](" + url + ")", "failed"],
  ["😎 Stack merged successfully - [details](" + url + ").", "merged"],
] as const)("parses trusted Trunk bot lifecycle: %s", (body, state) => {
  expect(parseTrunkComments([bot(body)], healthy())?.state).toBe(state);
});

test("queue state cannot be spoofed by a human comment or a lookalike bot", () => {
  const c = bot("This pull request was removed from the merge queue."); c.user.type = "User";
  expect(parseTrunkComments([c], healthy())).toBeUndefined();
  c.user.type = "Bot"; c.user.login = "other-trunk-io[bot]";
  expect(parseTrunkComments([c], healthy())).toBeUndefined();
});

test("only the target branch's authentic Trunk status check is used", () => {
  const pr = healthy(); pr.checks = [{ app: "trunk-io", name: "Trunk Merge Queue (other)", status: "COMPLETED", conclusion: "FAILURE", url }];
  expect(parseTrunkCheck(pr)).toBeUndefined();
  pr.checks[0]!.name = "Trunk Merge Queue (main)"; pr.checks[0]!.url = "https://app.trunk.io.evil.example/merge-queue/1";
  expect(parseTrunkCheck(pr)).toBeUndefined();
  pr.checks[0]!.url = url; expect(parseTrunkCheck(pr)?.state).toBe("failed");
});

test("pending failure and unavailable data retain membership without notifying", () => {
  const r = record(); trackMergeQueue(r, observation("testing"), Date.now());
  trackMergeQueue(r, observation("pending_failure"), Date.now()); expect(r.mergeQueue?.active).toBe(true); expect(r.mergeQueue?.terminal).toBeUndefined();
  trackMergeQueue(r, { ...observation("unknown"), error: "API unavailable" }, Date.now());
  expect(r.mergeQueue?.active).toBe(true); expect(r.mergeQueue?.terminal).toBeUndefined();
  trackMergeQueue(r, undefined, Date.now()); expect(mergeQueueDecision(r)?.kind).toBe("waiting");
});

test("a terminal eviction gets one durable event, and re-submission can create a new event", () => {
  let r = record(); trackMergeQueue(r, observation("testing"), Date.now()); trackMergeQueue(r, observation("failed", "failure-1"), Date.now());
  const id = r.mergeQueue!.terminal!.id; expect(mergeQueueDecision(r)).toMatchObject({ kind: "human", context: id });
  r = JSON.parse(JSON.stringify(r)); trackMergeQueue(r, observation("failed", "failure-1"), Date.now()); expect(r.mergeQueue!.terminal!.id).toBe(id);
  trackMergeQueue(r, observation("queued", "retry-2"), Date.now()); expect(r.mergeQueue?.terminal).toBeUndefined();
  trackMergeQueue(r, observation("failed", "failure-2"), Date.now()); expect(r.mergeQueue!.terminal!.id).not.toBe(id);
});

test("historical failures and successful merges don't create eviction alerts", () => {
  const r = record(); trackMergeQueue(r, observation("failed"), Date.now()); expect(r.mergeQueue?.terminal).toBeUndefined();
  trackMergeQueue(r, observation("queued"), Date.now()); r.snapshot.state = "MERGED"; trackMergeQueue(r, undefined, Date.now());
  expect(r.mergeQueue).toMatchObject({ active: false, state: "merged" }); expect(r.mergeQueue?.terminal).toBeUndefined();
});

test("an old terminal bot comment is not a new event on a changed head", () => {
  const r = record(); trackMergeQueue(r, observation("failed"), Date.now()); r.snapshot.head = "new"; trackMergeQueue(r, observation("failed"), Date.now()); expect(r.mergeQueue?.terminal).toBeUndefined();
});

test("submission is explicit, head-bound, durable and doesn't launch another agent", async () => {
  const h = harness(); await h.controller.action(1, "submit-merge-queue", { head: "head-1", queueHeads: { "1": "head-1" } });
  expect(h.store.get(1)?.mergeQueue).toMatchObject({ active: true, state: "submitted" }); expect(h.counts().submissions).toBe(1);
  await h.controller.reconcile(healthy()); expect(h.store.get(1)?.mergeQueue?.state).toBe("submitted"); expect(h.counts().launches).toBe(0);
  await expect(h.controller.action(1, "submit-merge-queue", { head: "head-1", queueHeads: { "1": "head-1" } })).rejects.toThrow(); expect(h.counts().submissions).toBe(1);
});

test.each(["stale", "failing", "draft", "unapproved", "foreign", "paused"])("queue submission rejects %s before posting", async problem => {
  const h = harness(); const r = h.store.get(1)!;
  if (problem === "stale") h.github.snapshot = async () => ({ ...healthy(), head: "changed" });
  if (problem === "failing") r.snapshot.checks[0]!.conclusion = "FAILURE";
  if (problem === "draft") r.snapshot.draft = true;
  if (problem === "unapproved") r.snapshot.reviewDecision = "REVIEW_REQUIRED";
  if (problem === "foreign") h.github.canMaintain = async () => false;
  if (problem === "paused") h.controller.config.mode = "paused";
  h.store.put(r);
  await expect(h.controller.action(1, "submit-merge-queue", { head: "head-1", queueHeads: { "1": "head-1" } })).rejects.toThrow(); expect(h.counts().submissions).toBe(0);
});

test("stack submission names and binds every included PR and freezes all its writers", async () => {
  const h = harness(); const top = record(2); top.snapshot.base = "feature-1"; top.snapshot.stack = { position: 2, size: 2 };
  trackMergeQueue(top, observation("available"), Date.now()); h.store.put(top);
  expect(queueSubmission(top, h.controller.config, h.store.all(), []).scope).toEqual([1, 2]);
  await expect(h.controller.action(2, "submit-merge-queue", { head: "head-2", queueHeads: { "2": "head-2" } })).rejects.toThrow();
  await h.controller.action(2, "submit-merge-queue", { head: "head-2", queueHeads: { "1": "head-1", "2": "head-2" } });
  expect(h.store.get(1)?.mergeQueue).toMatchObject({ owner: 2, active: true }); expect(h.store.get(2)?.mergeQueue).toMatchObject({ owner: 2, active: true });
  h.state(observation("failed", "new-failure")); await h.controller.reconcile(h.store.get(2)!.snapshot); await h.controller.reconcile(h.store.get(1)!.snapshot);
  expect(h.store.get(2)?.decision.kind).toBe("human"); expect(h.store.get(1)?.mergeQueue?.active).toBe(false); expect(h.store.get(1)?.mergeQueue?.terminal?.acknowledged).toBe(true);
});

test("an interrupted submission stays pending and never auto-posts again", async () => {
  const h = harness(); let posts = 0; h.github.submitMergeQueue = async () => { posts++; throw Error("response lost"); };
  await expect(h.controller.action(1, "submit-merge-queue", { head: "head-1", queueHeads: { "1": "head-1" } })).rejects.toThrow();
  await h.controller.reconcile(healthy()); expect(h.store.get(1)?.mergeQueue?.submission?.uncertain).toBe(true); expect(posts).toBe(1); expect(h.counts().launches).toBe(0);
});

test("queue entry stops a running repair before its result can publish and keeps its checkout", async () => {
  const h = harness(); const r = h.store.get(1)!; r.job = { name: "saved-job", head: "head-1", startedAt: new Date().toISOString(), fingerprint: fingerprint(r.snapshot) }; h.store.put(r);
  h.state(observation("testing")); await h.controller.reconcile(r.snapshot);
  expect(h.counts().stops).toBe(1); expect(h.store.get(1)?.job).toBeUndefined(); expect(h.store.get(1)?.assessment?.sourceJob?.name).toBe("saved-job"); expect(h.store.get(1)?.decision.kind).toBe("waiting");
});

test("trusted bot status is found beyond the first comment page", async () => {
  const g = new GitHub({ repository: "example/project" } as Config); const pages: string[] = [];
  g.conditionalJSON = async endpoint => { pages.push(endpoint); return endpoint.endsWith("page=1") ? Array.from({ length: 100 }, (_, id) => ({ id, body: "unrelated" })) : [bot("This pull request is in the merge queue. [details](" + url + ")")]; };
  expect((await g.mergeQueue(healthy()))?.state).toBe("queued"); expect(pages).toHaveLength(2);
});


test("a definite submission rejection restores queue state and permits another explicit attempt", async () => {
  const h = harness(); h.github.submitMergeQueue = async () => { throw new QueueSubmissionRejected("GitHub rejected this command"); };
  await expect(h.controller.action(1, "submit-merge-queue", { head: "head-1", queueHeads: { "1": "head-1" } })).rejects.toThrow();
  expect(h.store.get(1)?.mergeQueue).toMatchObject({ state: "available", active: false }); expect(h.store.get(1)?.mergeQueue?.submission).toBeUndefined();
});

test("a queued parent's unavailable status blocks a stack submission", () => {
  const h = harness(); const parent = h.store.get(1)!; parent.mergeQueue!.active = true; parent.mergeQueue!.error = "Status unavailable"; h.store.put(parent);
  const top = record(2); top.snapshot.base = parent.snapshot.branch; trackMergeQueue(top, observation("available"), Date.now()); h.store.put(top);
  expect(queueSubmission(top, h.controller.config, h.store.all(), []).canSubmit).toBe(false);
});

test("other Trunk products' failure reports aren't merge queue failures", () => {
  expect(parseTrunkComments([bot("<!-- Trunk Test Analytics -->\nFailed tests: 1. [details](https://app.trunk.io/example/flaky-tests/pr/1)")], healthy())).toBeUndefined();
});

test("an existing command receipt prevents duplicate GitHub comments after a retry", async () => {
  let posts = 0; const id = "11223344-1234-1234-1234-123456789abc";
  const g = new GitHub({ repository: "example/project" } as Config, async args => { if (args.includes("POST")) posts++; throw Error("No API write should occur"); }); g.viewerName = "owner";
  g.conditionalJSON = async () => [{ user: { login: "owner" }, body: `/trunk merge\n\n<!-- woodshed-merge-queue:${id} head:head-1 -->`, html_url: "https://github.com/example/project/pull/1#issuecomment-receipt" }];
  expect(await g.submitMergeQueue(healthy(), id)).toContain("receipt"); expect(posts).toBe(0);
});

test("merge queue submission isn't exposed to autonomous MCP actions", async () => {
  const h = harness(); await expect(h.controller.action(1, "submit-merge-queue", { head: "head-1", queueHeads: { "1": "head-1" }, source: "mcp" })).rejects.toThrow(); expect(h.counts().submissions).toBe(0);
});

test("GitHub submission rechecks the target and posts only the supported command plus its receipt", async () => {
  const calls: string[][] = [];
  const g = new GitHub({ repository: "example/project" } as Config, async args => {
    calls.push(args);
    return args[1] === "pr" ? JSON.stringify({ headRefOid: "head-1", baseRefName: "main", state: "OPEN", isDraft: false }) : JSON.stringify({ html_url: "https://github.com/example/project/pull/1#issuecomment-2" });
  }); g.conditionalJSON = async () => [];
  const id = "11223344-1234-1234-1234-123456789abc";
  await g.submitMergeQueue(healthy(), id);
  expect(calls[0]![1]).toBe("pr"); const post = calls.find(args => args.includes("POST"))!;
  expect(post.find(arg => arg.startsWith("body="))).toBe(`body=/trunk merge\n\n<!-- woodshed-merge-queue:${id} head:head-1 -->`);
});

test("a head movement during the final GitHub preflight never posts a queue command", async () => {
  let posts = 0; const g = new GitHub({ repository: "example/project" } as Config, async args => {
    if (args.includes("POST")) posts++;
    return JSON.stringify({ headRefOid: "changed", baseRefName: "main", state: "OPEN", isDraft: false });
  }); g.conditionalJSON = async () => [];
  await expect(g.submitMergeQueue(healthy(), "11223344-1234-1234-1234-123456789abc")).rejects.toBeInstanceOf(QueueSubmissionRejected);
  expect(posts).toBe(0);
});
