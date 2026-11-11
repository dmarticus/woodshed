import { expect, test } from "bun:test";
import { Controller, diskUsage } from "../src/controller";
import { Runner } from "../src/runner";
import { Store } from "../src/store";
import type { Config } from "../src/model";

test("runner counts consecutive hc failures but not missing sessions or other commands", async () => {
  let failure: Error | undefined;
  const runner = new Runner({ repository: "example/project" } as Config, "/tmp", async argv => { if (failure) throw failure; return argv[0] === "hc" ? "{}" : ""; });
  const call = (argv: string[]) => runner.exec(argv).catch(() => undefined);
  failure = new Error('hc exited 1: {"error":{"kind":"internal","message":"cannot save terminals: registry writer stopped"}}');
  for (let i = 0; i < 3; i++) await call(["hc", "get", "--json", "job"]);
  await call(["git", "status"]);
  expect(runner.herdr.consecutiveFailures).toBe(3);
  expect(runner.herdr.lastError).toContain("registry writer stopped");
  const since = runner.herdr.failingSince;
  await call(["hc", "get", "--json", "job"]);
  expect(runner.herdr.failingSince).toBe(since);
  failure = new Error('hc exited 3: {"error":{"kind":"not_found"}}');
  await call(["hc", "get", "--json", "job"]);
  expect(runner.herdr).toMatchObject({ consecutiveFailures: 0, failingSince: undefined });
  failure = new Error("hc exited 1: boom"); await call(["hc", "ls"]);
  failure = undefined; await call(["hc", "ls"]);
  expect(runner.herdr.consecutiveFailures).toBe(0);
});

test("controller warns when herdr keeps failing", () => {
  const herdr = { consecutiveFailures: 2, failingSince: "2026-11-10T17:49:00.000Z", lastError: "registry writer stopped" };
  const controller = new Controller({ repository: "example/project" } as Config, new Store(":memory:"), {} as any, { herdr } as any);
  expect(controller.warnings().map(w => w.id)).not.toContain("herdr-failing");
  herdr.consecutiveFailures = 3;
  expect(controller.warnings().find(w => w.id === "herdr-failing")?.message).toContain("hc server restart");
});

test("disk usage matches df and flags the controller disk from 80% full", () => {
  const stat = (blocks: number, bfree: number, bavail: number) => (() => ({ blocks, bfree, bavail, bsize: 4096 })) as any;
  expect(diskUsage("/data", stat(1000, 300, 250))).toEqual({ usedPercent: 74, freeGB: 0 });
  expect(diskUsage("/data", stat(37_600_000, 0, 0))).toEqual({ usedPercent: 100, freeGB: 0 });
  expect(diskUsage("/data", () => { throw new Error("ENOENT"); })).toBeUndefined();
  expect(diskUsage(undefined)).toBeUndefined();
});
