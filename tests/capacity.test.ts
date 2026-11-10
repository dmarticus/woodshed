import { expect, test } from "bun:test";
import { capacityFor, dollarsDown } from "../src/capacity";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { fingerprint, type Config, type Snapshot } from "../src/model";

const snapshot = (number: number): Snapshot => ({ number, title: "Fixture", url: "https://github.com/example/project/pull/" + number, head: "head-" + number, branch: "branch-" + number, base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, checks: [{ name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }], threads: [], reviews: [], labels: [] });
function fixture(cap = 4.57, limit = 3) {
  const store = new Store(":memory:");
  const config = { mode: "auto", automation: true, workerProtocol: "app-server", dailyCapUSD: cap, runCapUSD: 5, maxConcurrentJobs: limit, maxAttempts: 3 } as Config;
  let launches = 0;
  const runner: any = { launch: async (_: unknown, job: any) => { job.adapter = "app-server"; launches++; }, status: async () => ({ state: "working" }) };
  const controller = new Controller(config, store, {} as any, runner, Date.now, undefined, requested => ({ limit: requested }));
  for (const n of [1, 2, 3]) { const pr = snapshot(n); store.put({ snapshot: pr, paused: false, attempts: 0, fingerprint: fingerprint(pr), decision: { kind: "fix", reason: "1 failing check" } }); }
  return { store, controller, launches: () => launches };
}

test("4 CPU / 8 GB VM allows three workers with memory headroom", () => {
  expect(capacityFor(8, { cpus: 4, totalGB: 7.75, availableGB: 6.9, load: 0.4 })).toMatchObject({ limit: 3, blocked: undefined });
  expect(capacityFor(2, { cpus: 4, totalGB: 7.75, availableGB: 6.9, load: 0.4 }).limit).toBe(2);
  expect(capacityFor(8, { cpus: 8, totalGB: 15.6, availableGB: 13, load: 2 }).limit).toBe(7);
});

test.each(["cpu", "memory"] as const)("temporary %s pressure pauses starts without changing configured concurrency", pressure => {
  const host = { cpus: 4, totalGB: 8, availableGB: pressure === "memory" ? 1 : 7, load: pressure === "cpu" ? 5 : 1 };
  expect(capacityFor(3, host)).toMatchObject({ limit: 3, blocked: pressure });
});

test("independent repairs share the remaining daily allowance and fill three slots", async () => {
  const f = fixture();
  for (const number of [1, 2, 3]) await f.controller.reconcile(snapshot(number));
  expect(f.launches()).toBe(3); expect(f.controller.activeSlots()).toBe(3);
  expect(f.store.all().map(r => r.job!.budgetUSD).sort()).toEqual([1.52, 1.52, 1.53]);
  expect(f.controller.budgetAvailable()).toBe(0);
});

test("available budget does not become a microscopic new run", async () => {
  expect(dollarsDown(1.7763568394002505e-15)).toBe(0);
  const f = fixture(0.05); await f.controller.reconcile(snapshot(1));
  expect(f.launches()).toBe(0); expect(f.store.get(1)?.job).toBeUndefined();
});

test("small remaining budgets fund a meaningful worker instead of deadlocking every queued PR", async () => {
  const f = fixture(0.15); await f.controller.reconcile(snapshot(1));
  expect(f.launches()).toBe(1); expect(f.store.get(1)?.job?.budgetUSD).toBe(0.15);
});

test("resource backpressure leaves a repair queued with the real reason", async () => {
  const f = fixture(); (f.controller as any).resources = () => ({ limit: 3, blocked: "memory" });
  await f.controller.reconcile(snapshot(1));
  expect(f.launches()).toBe(0);
  expect(f.controller.queueStatus(f.store.get(1)!)).toMatchObject({ reason: "memory", message: "Waiting for memory to free up on the server" });
});

test("stack children wait even when independent worker slots are available", async () => {
  const f = fixture(); const upper = f.store.get(2)!; upper.snapshot.base = "branch-1"; f.store.put(upper);
  await f.controller.reconcile(upper.snapshot);
  expect(f.store.get(2)?.job).toBeUndefined(); expect(f.store.get(2)?.decision.reason).toContain("PR #1");
});

test("old active reservations stay visible after more than 300 later historical runs", () => {
  const f = fixture(20);
  f.store.saveRun({ id: "old-active", number: 9, state: "running", startedAt: "2020-01-01T00:00:00Z", turns: 1, costUSD: 1, budgetUSD: 5, costsByDay: {}, model: "fixture", summary: "Working" });
  for (let i = 0; i < 301; i++) f.store.saveRun({ id: "done-" + i, number: 10, state: "succeeded", startedAt: "2021-01-01T00:00:00Z", endedAt: "2021-01-01T00:01:00Z", turns: 0, costUSD: 0, costsByDay: {}, model: "fixture", summary: "Done" });
  expect(f.store.runs()).toHaveLength(300); expect(f.controller.budgetAvailable()).toBe(16);
});


test("a completed worker immediately asks the scheduler to refill free slots", async () => {
  const f = fixture(); await f.controller.reconcile(snapshot(1));
  let polls = 0; (f.controller as any).sync = async () => { polls++; };
  const job = f.store.get(1)!.job!;
  (f.controller.runner as any).telemetry = async () => ({ ...f.store.run(job.name)!, state: "succeeded", endedAt: new Date().toISOString() });
  await f.controller.checkBudgets(); expect(polls).toBe(1);
  await f.controller.checkBudgets(); expect(polls).toBe(1);
});
