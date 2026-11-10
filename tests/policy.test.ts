import { describe, expect, test } from "bun:test";
import { decide, fingerprint, type Snapshot, type Record } from "../src/model";
import { Controller } from "../src/controller";
import { Store } from "../src/store";

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({ number: 42, title: "Fix export", url: "https://github.com/example/project/pull/42", head: "a", branch: "fix/export", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], labels: [], reviews: [{ author: "posthog[bot]", state: "COMMENTED", body: "Reviewed", head: "a", submittedAt: "" }], ...overrides });
const record = (pr: Snapshot, overrides: Partial<Record> = {}): Record => ({ snapshot: pr, decision: decide(pr), paused: false, attempts: 0, fingerprint: fingerprint(pr), ...overrides });

describe("readiness", () => {
  test("requires completed CI and review on this head", () => {
    expect(decide(snapshot()).kind).toBe("ready");
    expect(decide(snapshot({ checks: [] })).kind).toBe("waiting");
    expect(decide(snapshot({ checks: [{ name: "Tests", status: "IN_PROGRESS", conclusion: null, url: "" }] })).kind).toBe("waiting");
    expect(decide(snapshot({ head: "new" })).kind).toBe("review");
  });
  test("queue BLOCKED does not invent a missing review", () => {
    expect(decide(snapshot({ mergeStateStatus: "BLOCKED" })).kind).toBe("ready");
    expect(decide(snapshot({ reviewDecision: "REVIEW_REQUIRED" })).kind).toBe("approval");
  });
  test("failed visual checks and current Stamphog refusals need a person", () => {
    const visual = snapshot({ checks: [{ name: "PostHog Visual Review / storybook (partial)", status: "COMPLETED", conclusion: "FAILURE", url: "https://example.com/visual-diff", description: "Visual changes detected: 1 changed (partial run)" }] });
    expect(decide(visual).kind).toBe("human");
    expect(decide(visual).action?.url).toBe("https://example.com/visual-diff");
    expect(decide(visual).reason).toContain("1 changed (partial run)");
    expect(decide(snapshot({ reviewDecision: "REVIEW_REQUIRED", reviews: [{ author: "stamphog[bot]", state: "COMMENTED", body: "REFUSED: needs review", head: "a", submittedAt: "" }] })).kind).toBe("human");
    expect(decide(snapshot({ reviews: [{ author: "stamphog[bot]", state: "COMMENTED", body: "REFUSED", head: "old", submittedAt: "" }] })).kind).toBe("review");
  });
  test.each([
    { name: "Commit snapshot changes", conclusion: "CANCELLED" },
    { name: "Commit snapshot changes", conclusion: "FAILURE" },
    { name: "Visual regression tests pass", conclusion: "CANCELLED" },
    { name: "Complete Visual Review run", conclusion: "TIMED_OUT" },
    { name: "Complete Visual Review run", conclusion: "FAILURE" },
    { name: "PostHog Visual Review / storybook", conclusion: "FAILURE", description: "Unable to process artifacts" },
    { name: "PostHog Visual Review / storybook (tracking)", conclusion: "FAILURE", description: "Visual changes detected: 1 changed" },
  ])("$name ($conclusion) is repair work without evidence of a reviewable diff", check => {
    expect(decide(snapshot({ checks: [{ ...check, status: "COMPLETED", url: "" }] })).kind).toBe("fix");
  });
  test("a new commit invalidates a previous human escalation", () => {
    const pr = snapshot();
    const r = record(pr, { humanHead: "a", humanReason: "Decision needed" });
    expect(decide(pr, r).kind).toBe("human");
    expect(decide(snapshot({ head: "b" }), r).kind).toBe("review");
  });
});

describe("durable controller", () => {
  function harness(automation = true) {
    const store = new Store(":memory:");
    const labels: string[] = [];
    const launched: string[] = [];
    const config: any = { automation, maxAttempts: 2, maxConcurrentJobs: 1, reviewLabel: "posthog-review", approvalLabel: "stamphog" };
    const github: any = { label: async (_: number, label: string) => { labels.push(label); } };
    const runner: any = { launch: async (_: Snapshot, job: any) => { launched.push(job.name); }, status: async () => ({ state: "working" }) };
    return { store, labels, launched, config, github, runner, controller: new Controller(config, store, github, runner) };
  }
  const broken = () => snapshot({ checks: [{ name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }] });
  test("monitor mode does not launch jobs or request reviews", async () => {
    const h = harness(false);
    await h.controller.reconcile(broken());
    await h.controller.reconcile(snapshot({ reviews: [] }));
    expect(h.launched).toEqual([]); expect(h.labels).toEqual([]);
  });
  test("restart keeps one writer per PR", async () => {
    const h = harness();
    await h.controller.reconcile(broken());
    const restarted = new Controller(h.config, h.store, h.github, h.runner);
    await restarted.reconcile(broken());
    expect(h.launched.length).toBe(1);
  });
  test("ambiguous startup is latched for a person, never retried blindly", async () => {
    const h = harness();
    h.runner.launch = async () => { throw new Error("Timed out after launch"); };
    await h.controller.reconcile(broken());
    await h.controller.reconcile(broken());
    expect(h.store.get(42)?.decision.kind).toBe("human");
    expect(h.store.get(42)?.job).toBeDefined();
    expect(h.store.get(42)?.attempts).toBe(1);
  });
  test("failed checkout preparation retries across restarts without ghost sessions or model charges", async () => {
    const h = harness(); let clock = Date.now();
    h.controller = new Controller(h.config, h.store, h.github, h.runner, () => clock);
    h.runner.health = async () => ({ state: "missing", started: false });
    h.runner.launch = async (_: Snapshot, job: any) => { h.launched.push(job.name); if (h.launched.length > 1) expect(job.freshCheckout).toBe(true); throw new Error("git exited 128: not our ref; could not fetch from promisor remote"); };
    for (let attempt = 1; attempt <= 4; attempt++) {
      await h.controller.reconcile(broken());
      const saved = h.store.get(42)!;
      expect(saved.job).toBeUndefined(); expect(saved.attempts).toBe(0);
      expect(saved.decision.kind).toBe(attempt <= 3 ? "waiting" : "human");
      expect(h.store.run(h.launched.at(-1)!)?.costUSD).toBe(0);
      h.controller = new Controller(h.config, h.store, h.github, h.runner, () => clock);
      await h.controller.reconcile(broken());
      expect(h.launched).toHaveLength(attempt);
      clock = Date.parse(saved.recovery!.retryAt!) + 1;
    }
    await h.controller.reconcile(broken()); expect(h.launched).toHaveLength(4);
    h.github.snapshot = async () => broken();
    await h.controller.action(42, "recheck", { head: broken().head });
    await h.controller.reconcile(broken()); expect(h.launched).toHaveLength(5);
  });
  test.each(["missing", "finished"])("a %s worker resumes its saved run with the same budget and no second checkout", async state => {
    const h = harness(); let clock = Date.now(); let resumed = 0;
    h.controller = new Controller(h.config, h.store, h.github, h.runner, () => clock);
    h.runner.launch = async (_: Snapshot, job: any) => { job.adapter = "app-server"; h.launched.push(job.name); };
    await h.controller.reconcile(broken()); const original = h.store.get(42)!.job!;
    const run = h.store.run(original.name)!; run.costUSD = 0.25; run.budgetUSD = 5; h.store.saveRun(run);
    h.runner.health = async () => ({ state, started: true });
    h.runner.stop = async () => {};
    h.runner.resume = async (job: any) => { expect(job.name).toBe(original.name); expect(job.budgetUSD).toBe(5); resumed++; };
    await h.controller.reconcile(broken());
    expect(resumed).toBe(0); expect(h.store.get(42)?.decision.kind).toBe("waiting");
    clock = Date.parse(h.store.get(42)!.recovery!.retryAt!) + 1;
    await h.controller.reconcile(broken());
    expect(resumed).toBe(1); expect(h.launched).toHaveLength(1);
    expect(h.store.run(original.name)?.costUSD).toBe(0.25);
    expect(h.store.run(original.name)?.state).toBe("running");
  });
  test("an unavailable core keeps the original worker and reconnects without another launch", async () => {
    const h = harness(); let clock = Date.now();
    h.controller = new Controller(h.config, h.store, h.github, h.runner, () => clock);
    await h.controller.reconcile(broken()); const original = h.store.get(42)!.job!.name;
    h.runner.health = async () => { throw new Error("hc unavailable: connection refused"); };
    await h.controller.reconcile(broken());
    expect(h.store.get(42)?.job?.name).toBe(original); expect(h.store.get(42)?.decision.kind).toBe("waiting");
    h.runner.health = async () => ({ state: "live", started: true });
    clock = Date.parse(h.store.get(42)!.recovery!.retryAt!) + 1;
    await h.controller.reconcile(broken());
    expect(h.launched).toHaveLength(1); expect(h.store.get(42)?.recovery).toBeUndefined();
  });
  test.each(["paused", "new head", "budget"])("interrupted runs respect %s before resuming", async guard => {
    const h = harness(); let clock = Date.now(); let resumed = 0;
    h.controller = new Controller(h.config, h.store, h.github, h.runner, () => clock);
    h.runner.launch = async (_: Snapshot, job: any) => { job.adapter = "app-server"; h.launched.push(job.name); };
    await h.controller.reconcile(broken()); const record = h.store.get(42)!;
    const run = h.store.run(record.job!.name)!; run.costUSD = 0.25; h.store.saveRun(run);
    h.runner.health = async () => ({ state: "missing", started: true }); h.runner.stop = async () => {};
    h.runner.resume = async () => { resumed++; };
    await h.controller.reconcile(broken());
    clock = Date.parse(h.store.get(42)!.recovery!.retryAt!) + 1;
    if (guard === "paused") { const paused = h.store.get(42)!; paused.paused = true; h.store.put(paused); }
    if (guard === "budget") h.config.dailyCapUSD = 0.1;
    await h.controller.reconcile(guard === "new head" ? { ...broken(), head: "new" } : broken());
    expect(resumed).toBe(0);
    if (guard === "paused") expect(h.store.get(42)?.decision.kind).toBe("paused");
    if (guard === "budget") expect(h.store.get(42)?.decision.title).toBe("Review the run budget");
  });
  test("sleep state clears after a healthy probe and never attaches to a failed startup", async () => {
    const h = harness(); await h.controller.reconcile(broken());
    h.controller.power("sleep"); expect(h.store.get(42)?.sleepInterruptedAt).toBeDefined();
    h.controller.power("wake"); h.runner.health = async () => ({ state: "live", started: true });
    await h.controller.reconcile(broken()); expect(h.store.get(42)?.sleepInterruptedAt).toBeUndefined();
    const job = h.store.get(42)!.job!; const run = h.store.run(job.name)!;
    run.state = "failed"; run.endedAt = new Date().toISOString(); h.store.saveRun(run);
    h.controller.power("sleep"); expect(h.store.get(42)?.sleepInterruptedAt).toBeUndefined();
    h.controller.power("wake", false); expect(h.store.get(42)?.sleepInterruptedAt).toBeUndefined();
  });
  test("a lost session preserves its unanswered question and reconnects with the owner's saved answer", async () => {
    const h = harness(); let clock = Date.now(); const instructions: string[] = [];
    h.controller = new Controller(h.config, h.store, h.github, h.runner, () => clock);
    h.runner.launch = async (_: Snapshot, job: any) => { job.adapter = "app-server"; };
    await h.controller.reconcile(broken()); const record = h.store.get(42)!;
    const run = h.store.run(record.job!.name)!;
    run.costUSD = 0.25; run.state = "waiting"; run.prompt = { id: "question", kind: "question", text: "Keep paused reports visible?" }; h.store.saveRun(run);
    h.runner.health = async () => ({ state: "missing", started: true }); h.runner.stop = async () => {};
    h.runner.telemetry = async (job: any) => h.store.run(job.name);
    h.runner.resume = async (_: any, text: string) => { instructions.push(text); if (instructions.length === 1) throw new Error("connection reset"); };
    h.github.snapshot = async () => broken();
    await h.controller.reconcile(broken());
    expect(h.store.get(42)?.decision).toMatchObject({ kind: "human", reason: "Keep paused reports visible?" });
    expect(instructions).toHaveLength(0);
    await h.controller.action(42, "reply", { head: broken().head, promptId: "question", message: "Keep them visible" });
    await h.controller.reconcile(broken());
    clock = Date.parse(h.store.get(42)!.recovery!.retryAt!) + 1;
    await h.controller.reconcile(broken());
    expect(instructions).toHaveLength(2); expect(instructions.every(text => text.includes("Keep them visible"))).toBe(true);
    expect(h.store.get(42)?.decision.kind).toBe("waiting");
  });
  test("attempt budget survives agent pushes that leave the same failure", async () => {
    const h = harness();
    h.store.put(record(broken(), { attempts: 2 }));
    await h.controller.reconcile({ ...broken(), head: "new" });
    expect(h.store.get(42)?.decision.kind).toBe("human");
    expect(h.launched).toEqual([]);
  });
  test("review requests deduplicate per commit and repeat on a new head", async () => {
    const h = harness();
    await h.controller.reconcile(snapshot({ reviews: [] }));
    await h.controller.reconcile(snapshot({ reviews: [] }));
    await h.controller.reconcile(snapshot({ reviews: [], head: "b" }));
    expect(h.labels).toEqual(["posthog-review", "posthog-review"]);
  });
  test("a paused PR does not launch or request review", async () => {
    const h = harness(); h.store.put(record(broken(), { paused: true }));
    await h.controller.reconcile(broken());
    expect(h.launched).toEqual([]); expect(h.store.get(42)?.decision.kind).toBe("paused");
  });
  test("conflicts and required base updates dispatch automatic branch-update jobs", async () => {
    for (const state of [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }]) {
      const h = harness();
      await h.controller.reconcile(snapshot(state));
      expect(h.launched.length).toBe(1);
      expect(h.store.get(42)?.job?.kind).toBe("branch-update");
      expect(h.store.get(42)?.decision.kind).toBe("waiting");
    }
  });
  test("monitor mode queues conflicts without inventing a human decision", async () => {
    const h = harness(false);
    await h.controller.reconcile(snapshot({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }));
    expect(h.launched).toEqual([]);
    expect(h.store.get(42)?.decision.kind).toBe("fix");
  });
  test("superseded resolution is replanned without spending the failure budget", async () => {
    const h = harness();
    const pr = snapshot({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    await h.controller.reconcile(pr);
    h.runner.status = async () => ({ state: "superseded", reason: "Another writer updated the branch" });
    await h.controller.reconcile({ ...pr, head: "new" });
    expect(h.store.get(42)?.job).toBeUndefined();
    expect(h.store.get(42)?.attempts).toBe(0);
    await h.controller.reconcile({ ...pr, head: "new" });
    expect(h.launched.length).toBe(2);
  });
});
