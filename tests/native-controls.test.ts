import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { Settings } from "../src/settings";
import { handler } from "../src/http";
import { Runner } from "../src/runner";
import { GitHub } from "../src/github";
import type { Config, Snapshot, Job } from "../src/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "woodshed-native-")); roots.push(root); return root; };
const pr: Snapshot = { number: 42, title: "Fixture PR", url: "https://github.com/example/project/pull/42", head: "a", branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [], reviews: [], threads: [], labels: [] };
function harness() {
  const config: Config = { repository: "example/project", author: "@me", checkout: "", automation: false, paused: false, port: 7341, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, reviewLabel: "review", approvalLabel: "approval" };
  const store = new Store(":memory:");
  const calls: string[] = [];
  const runner: any = { launch: async () => { calls.push("launch"); }, status: async () => ({ state: "working" }), send: async () => { calls.push("reply"); return 7; }, stop: async () => { calls.push("stop"); }, interrupt: async () => { calls.push("interrupt"); }, inspect: async () => ({ name: "ws-test", output: "Fixture output", state: "working", kind: null, message: "" }) };
  const github: any = { list: async () => [], snapshot: async () => pr, canMaintainKnown: () => true, requestReviewer: async (_: number, reviewer: string) => { calls.push(`reviewer:${reviewer}`); } };
  const controller = new Controller(config, store, github, runner);
  store.put({ snapshot: pr, decision: { kind: "human", reason: "Needs input" }, paused: false, attempts: 0, fingerprint: "" });
  return { config, store, calls, runner, controller };
}
const job: Job = { name: "ws-test", head: "a", fingerprint: "", startedAt: new Date().toISOString() };

test("native settings persist atomically and preserve repository configuration", async () => {
  const h = harness();
  const path = join(temp(), "config.json");
  await Bun.write(path, JSON.stringify({ ...h.config, approvalLabel: "custom-approval" }));
  const settings = new Settings(h.config, path);
  await settings.update({ paused: true, maxAttempts: 4 });
  expect(h.config.paused).toBe(true);
  const disk = await Bun.file(path).json();
  expect(disk.maxAttempts).toBe(4);
  expect(disk.approvalLabel).toBe("custom-approval");
  await expect(settings.update({ automation: "yes" })).rejects.toThrow();
  await expect(settings.update({ maxConcurrentJobs: 129 })).rejects.toThrow();
  await expect(settings.update({ checkout: "/unexpected" })).rejects.toThrow();
});

test("automatic concurrency and resource targets persist without changing spend caps", async () => {
  const h = harness(); h.config.runCapUSD = 5; h.config.dailyCapUSD = 20;
  const path = join(temp(), "config.json"); const settings = new Settings(h.config, path);
  await settings.update({ concurrencyMode: "adaptive", cpuTargetPercent: 75, memoryTargetPercent: 80 });
  expect(await Bun.file(path).json()).toMatchObject({ concurrencyMode: "adaptive", cpuTargetPercent: 75, memoryTargetPercent: 80, runCapUSD: 5, dailyCapUSD: 20 });
  for (const patch of [{ concurrencyMode: "unlimited" }, { cpuTargetPercent: 101 }, { memoryTargetPercent: 100 }, { cpuTargetPercent: "80" }]) await expect(settings.update(patch)).rejects.toThrow();
});

test("global pause prevents launching new automated jobs", async () => {
  const h = harness(); h.config.automation = true; h.config.paused = true;
  await h.controller.reconcile({ ...pr, mergeable: "CONFLICTING" });
  expect(h.calls).toEqual([]);
});

test("an explicit native repair runs once in monitor mode with owner instructions", async () => {
  const h = harness();
  await h.controller.action(42, "retry", { head: "a", message: "Keep paused reports visible." });
  await h.controller.reconcile(pr);
  expect(h.calls).toEqual(["launch"]);
  expect(h.store.get(42)?.job?.instructions).toBe("Keep paused reports visible.");
  expect(h.store.get(42)?.runRequested).toBe(false);
  await h.controller.reconcile(pr);
  expect(h.calls).toEqual(["launch"]);
});

test("retry stops the previous writer before requesting another attempt", async () => {
  const h = harness(); const r = h.store.get(42)!; r.job = job; h.store.put(r);
  await h.controller.action(42, "retry", { head: "a", message: "Try a smaller fix." });
  await h.controller.reconcile(pr);
  expect(h.calls).toEqual(["stop", "launch"]);
});

test("stale native decisions cannot send replies or review requests", async () => {
  const h = harness();
  await expect(h.controller.action(42, "reviewer", { head: "old", reviewer: "sample-reviewer" })).rejects.toThrow("PR changed");
  expect(h.calls).toEqual([]);
});

test("an owner reply clears the human latch and tracks the new agent turn", async () => {
  const h = harness(); const r = h.store.get(42)!; r.job = job; r.humanHead = "a"; h.store.put(r);
  await h.controller.action(42, "reply", { head: "a", message: "Keep the current behavior." });
  expect(h.store.get(42)?.humanHead).toBeUndefined();
  expect(h.store.get(42)?.job?.afterTurn).toBe(7);
  expect(h.calls).toEqual(["reply"]);
});

test("native API keeps host and origin protection and retires web assets", async () => {
  const h = harness();
  const route = handler(h.controller, new Settings(h.config, join(temp(), "config.json"), true), "fixture-token");
  const request = (path: string, method = "GET", origin: string | undefined = undefined, host = "127.0.0.1:7341") => new Request(`http://127.0.0.1:7341${path}`, { method, headers: { Host: host, Authorization: "Bearer fixture-token", ...(origin === undefined ? {} : { Origin: origin }) } });
  expect((await route(request("/api/state"))).status).toBe(200);
  expect((await route(request("/api/settings", "POST", "https://example.com"))).status).toBe(401);
  expect((await route(request("/api/state", "GET", "", "attacker.example"))).status).toBe(403);
  expect((await route(request("/app.js"))).status).toBe(404);
  expect((await route(request("/"))).headers.get("content-type")).toContain("application/json");
  expect((await route(request("/api/prs/42/retry", "POST"))).status).toBe(409);
});

test("reviewer input is validated before invoking GitHub", async () => {
  const calls: string[][] = [];
  const github = new GitHub({ repository: "example/project" } as Config, async argv => { calls.push(argv); return ""; });
  await expect(github.requestReviewer(42, "--unexpected")).rejects.toThrow();
  expect(calls).toEqual([]);
  await github.requestReviewer(42, "sample-reviewer");
  expect(calls[0].at(-1)).toBe("sample-reviewer");
});

test("agent replies never bypass a permission or authentication prompt", async () => {
  const commands: string[][] = [];
  const runner = new Runner({} as Config, temp(), async argv => { commands.push(argv); return JSON.stringify({ state: "live", status: { state: "blocked", kind: "permission" }, turn: 3 }); });
  await expect(runner.send(job, "continue")).rejects.toThrow("permission or login");
  expect(commands.length).toBe(1);
});

test("an explicit answer can continue a question and invalidates the old result", async () => {
  const root = temp(); const result = join(root, "jobs", job.name, "agent-result", "result.json");
  await Bun.write(result, JSON.stringify({ outcome: "needs_human", reason: "Question" }));
  const commands: string[][] = [];
  const runner = new Runner({} as Config, root, async argv => { commands.push(argv); return JSON.stringify({ state: "live", status: { state: "blocked", kind: "question" }, turn: 3 }); });
  expect(await runner.send(job, "Keep them visible.")).toBe(3);
  expect(commands[1]).toContain("--force");
  expect(await Bun.file(result).exists()).toBe(false);
  expect((await runner.status({ ...job, afterTurn: 3 })).state).toBe("working");
});

test("a permission prompt remains visible while an agent reply is pending", async () => {
  const runner = new Runner({} as Config, temp(), async () => JSON.stringify({ state: "live", status: { state: "blocked", kind: "permission", msg: "May I run this check?" }, turn: 3 }));
  const status = await runner.status({ ...job, afterTurn: 3 });
  expect(status.state).toBe("human");
  expect(status.reason).toBe("May I run this check?");
});

test("an undelivered reply has a bounded wait", async () => {
  const runner = new Runner({} as Config, temp(), async () => JSON.stringify({ state: "live", status: { state: "done" }, turn: 3 }));
  expect((await runner.status({ ...job, afterTurn: 3, startedAt: new Date(Date.now() - 46 * 60_000).toISOString() })).state).toBe("human");
});
