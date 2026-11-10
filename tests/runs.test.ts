import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
import { Settings } from "../src/settings";
import { addUsage, emptyUsage, estimate, localDay, publishedPrices } from "../src/usage";
import { Worker } from "../src/worker";
import { Controller } from "../src/controller";
import { Runner } from "../src/runner";
import type { Config, Run, Snapshot } from "../src/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "woodshed-runs-")); roots.push(root); return root; };
const config = (): Config => ({ repository: "example/project", author: "@me", checkout: "", automation: false, port: 7341, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 2, reviewLabel: "review", approvalLabel: "approval" });
const run = (id = "run-1"): Run => ({ id, number: 42, state: "running", model: "gpt-6.1-sol", startedAt: new Date().toISOString(), turns: 0, costUSD: 0, costsByDay: {}, usage: emptyUsage(), summary: "Working", budgetUSD: 5 });
const pr = (number = 42): Snapshot => ({ number, title: "Fixture PR", url: "https://github.com/example/project/pull/42", head: "a", branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: null, checks: [], reviews: [], threads: [], labels: [] });

test("migrates legacy flags to one mode and never leaves Watch paused", async () => {
  const cfg = { ...config(), automation: true, paused: true };
  const settings = new Settings(cfg, join(temp(), "config.json"));
  expect(settings.public().mode).toBe("paused");
  await settings.update({ mode: "watch" });
  expect(cfg.automation).toBe(false); expect(cfg.paused).toBe(false);
  expect((await Bun.file(settings.path).json()).mode).toBe("watch");
});

test("cached tokens and reasoning tokens are not charged twice", () => {
  const usage = { ...emptyUsage(), inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 100, totalTokens: 1200 };
  expect(estimate(usage, publishedPrices["gpt-6.1-sol"])).toBeCloseTo((400 * 2 + 500 * 0.1 + 100 * 2.5 + 200 * 10) / 1e6);
});

test("cumulative usage updates are idempotent and roll up across local days", () => {
  const r = run(); const usage = { ...emptyUsage(), inputTokens: 1000, outputTokens: 100, totalTokens: 1100 };
  const first = new Date(2026, 10, 5, 23, 59); const second = new Date(2026, 10, 6, 0, 1);
  addUsage(r, usage, usage, publishedPrices[r.model], first);
  const cost = r.costUSD;
  addUsage(r, usage, usage, publishedPrices[r.model], first);
  expect(r.costUSD).toBe(cost);
  addUsage(r, { ...usage, inputTokens: 2000, outputTokens: 200, totalTokens: 2200 }, usage, publishedPrices[r.model], second);
  expect(Object.keys(r.costsByDay)).toHaveLength(2);
  expect(r.costsByDay[localDay(first)]).toBeCloseTo(r.costsByDay[localDay(second)]);
});

test("daily totals include archived runs and do not double-count telemetry refreshes", () => {
  const store = new Store(":memory:"); const r = run(); r.costUSD = 0.5; r.costsByDay = { [localDay()]: 0.5 };
  store.saveRun(r); store.saveRun(r);
  expect(store.spent(localDay())).toBe(0.5);
  expect(store.spend(20).prTotals["42"]).toBe(0.5);
  r.costUSD = null; r.endedAt = new Date().toISOString(); store.saveRun(r);
  expect(store.spend(20).unknownRuns).toBe(1);
  const second = run("second"); second.costUSD = 1; store.saveRun(second);
  expect(store.spend(20).prTotals["42"]).toBeNull();
});

test("budget reservations prevent concurrent runs from each spending the full daily allowance", async () => {
  const cfg = { ...config(), automation: true, workerProtocol: "app-server" as const, dailyCapUSD: 10, runCapUSD: 5, maxConcurrentJobs: 3 };
  const store = new Store(":memory:");
  const runner: any = { launch: async () => {}, status: async () => ({ state: "working" }) };
  const controller = new Controller(cfg, store, {} as any, runner);
  await controller.reconcile(pr(42)); await controller.reconcile(pr(43)); await controller.reconcile(pr(44));
  expect(store.get(42)?.job?.budgetUSD).toBe(5); expect(store.get(43)?.job?.budgetUSD).toBe(5);
  expect(store.get(44)?.job).toBeUndefined();
  expect(store.get(44)?.decision.kind).toBe("waiting");
  const first = store.run(store.get(42)!.job!.name)!;
  first.state = "succeeded"; first.endedAt = new Date().toISOString(); first.costUSD = 3; first.costsByDay = { [localDay()]: 3 }; store.saveRun(first);
  await controller.reconcile(pr(44));
  expect(store.get(44)?.job?.budgetUSD).toBe(2);
});

test("blocked questions free a worker slot and replies wait for an available slot", async () => {
  const cfg = { ...config(), automation: true, maxConcurrentJobs: 1 };
  const store = new Store(":memory:"); let replies = 0;
  const runner: any = { launch: async () => {}, status: async () => ({ state: "human", reason: "Question" }), send: async () => { replies++; return 2; } };
  const controller = new Controller(cfg, store, { snapshot: async (number: number) => pr(number) } as any, runner);
  await controller.reconcile(pr(42)); await controller.reconcile(pr(42)); await controller.reconcile(pr(43));
  expect(store.get(43)?.job).toBeDefined();
  await controller.action(42, "reply", { head: "a", message: "Preserve the behavior" });
  expect(replies).toBe(0); expect(store.get(42)?.pendingReply).toBeTruthy();
});

test("Stop watching survives subsequent PR refreshes", async () => {
  const cfg = config(); const store = new Store(":memory:");
  const controller = new Controller(cfg, store, {} as any, {} as any);
  await controller.reconcile(pr()); await controller.action(42, "unwatch", { head: "a" });
  cfg.automation = true; await controller.reconcile(pr());
  expect(store.get(42)?.watching).toBe(false); expect(store.get(42)?.job).toBeUndefined();
});

test.each(["run", "daily"])("lowering a %s cap stops an active run and persists its human decision", async kind => {
  const cfg = { ...config(), automation: true, workerProtocol: "app-server" as const, runCapUSD: 5, dailyCapUSD: 20 };
  const store = new Store(":memory:"); let stopped = false;
  const runner: any = { launch: async (_: unknown, job: any) => { job.adapter = "app-server"; }, telemetry: async (job: any) => store.run(job.name), stop: async () => { stopped = true; } };
  const controller = new Controller(cfg, store, {} as any, runner);
  await controller.reconcile(pr());
  const current = store.run(store.get(42)!.job!.name)!;
  current.state = "running"; current.costUSD = 2; current.costsByDay = { [localDay()]: 2 }; store.saveRun(current);
  if (kind === "run") cfg.runCapUSD = 1; else cfg.dailyCapUSD = 1;
  await controller.checkBudgets();
  expect(stopped).toBe(true); expect(store.get(42)?.decision.kind).toBe("human");
  expect(store.run(current.id)?.state).toBe("budget");
});

function worker(budget = 1) {
  const directory = temp(); const calls: any[] = [];
  const rpc: any = { request: async (method: string, params: any) => { calls.push({ method, params }); return {}; }, write: (message: any) => { calls.push(message); }, close: () => {} };
  const price = publishedPrices["gpt-6.1-sol"];
  const instance = new Worker({ id: "fixture", number: 42, checkout: directory, directory, resultDirectory: join(directory, "result"), model: "gpt-6.1-sol", price, prices: publishedPrices, budgetUSD: budget, startedAt: new Date().toISOString(), prompt: "Fixture" }, rpc);
  instance.state.threadId = "thread"; instance.state.activeTurn = "turn";
  return { instance, calls };
}

test("usage cap interrupts the active turn and creates a human decision", async () => {
  const { instance, calls } = worker(0.001);
  const usage = { ...emptyUsage(), inputTokens: 1000, outputTokens: 100, totalTokens: 1100 };
  await instance.event({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: usage, last: usage } } });
  expect(instance.state.state).toBe("budget"); expect(instance.state.status).toBe("blocked");
  expect(calls.some(c => c.method === "turn/interrupt")).toBe(true);
});

test("unknown rerouted pricing stops the run instead of inventing zero cost", async () => {
  const { instance } = worker();
  await instance.event({ method: "model/rerouted", params: { toModel: "unpriced-model" } });
  expect(instance.state.state).toBe("budget"); expect(instance.state.summary).toContain("without configured pricing");
});

test("notification replies are bound to the exact question", async () => {
  const { instance, calls } = worker();
  await instance.event({ id: 7, method: "item/tool/requestUserInput", params: { questions: [{ id: "q", question: "Keep existing behavior?" }] } });
  await expect(instance.input("Yes", "old-question")).rejects.toThrow("decision changed");
  expect(calls).toEqual([]);
  await instance.input("Yes", "7:0");
  expect(calls[0].result.answers.q.answers).toEqual(["Yes"]);
});

test("resuming an upgraded worker preserves accumulated usage and spend", async () => {
  const { instance, calls } = worker();
  instance.state.costUSD = 0.25; instance.state.turns = 2;
  instance.state.usage = { ...emptyUsage(), inputTokens: 1000, totalTokens: 1000 };
  await instance.persist();
  instance.config.resumeThreadId = "thread"; instance.config.resumeQueued = true;
  instance.rpc.initialize = async () => {};
  instance.rpc.request = async (method: string, params: unknown) => { calls.push({ method, params }); return { thread: { id: "thread" } }; };
  await instance.start();
  await instance.event({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: instance.state.usage, last: instance.state.usage } } });
  expect(instance.state.costUSD).toBe(0.25); expect(instance.state.turns).toBe(2);
  expect(calls[0].method).toBe("thread/resume"); expect(instance.state.state).toBe("waiting");
});

test("missing hc sessions stop idempotently and resume the same edited checkout", async () => {
  const root = temp(); const directory = join(root, "jobs", "run-1");
  const checkout = join(directory, "checkout"); const path = join(directory, "worker.json");
  await Bun.write(join(checkout, "saved.txt"), "unpublished work\n");
  await Bun.write(join(directory, "prompt.txt"), "Original repair");
  await Bun.write(path, JSON.stringify({ checkout, budgetUSD: 5, dailyCapUSD: 20 }));
  await Bun.write(join(directory, "runtime.json"), JSON.stringify({ ...run(), threadId: "saved-thread", costUSD: 0.4, status: "working" }));
  let launches = 0;
  const runner = new Runner(config(), root, async argv => {
    if (argv[1] === "get" || argv[1] === "rm" || argv[1] === "read") throw new Error('hc exited 3: {"error":{"kind":"not_found","message":"no terminal"}}');
    if (argv[1] === "run") { launches++; expect(argv).toContain(checkout); return "{}"; }
    throw new Error("Unexpected command");
  });
  const job = { name: "run-1", head: "a", fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" as const, budgetUSD: 5 };
  expect(await runner.health(job)).toEqual({ state: "missing", started: true });
  await runner.stop(job);
  expect((await runner.inspect(job)).state).toBe("recovering");
  await runner.resume(job, "Continue after an interruption");
  expect(launches).toBe(1); expect(await Bun.file(join(checkout, "saved.txt")).text()).toBe("unpublished work\n");
  expect((await Bun.file(path).json()).resumeThreadId).toBe("saved-thread");
  expect((await Bun.file(join(directory, "runtime.json")).json()).costUSD).toBe(0.4);
  const runtime = await Bun.file(join(directory, "runtime.json")).json(); runtime.pid = process.pid;
  await Bun.write(join(directory, "runtime.json"), JSON.stringify(runtime));
  await expect(runner.health(job)).rejects.toThrow("still running");
  expect(launches).toBe(1);
});
