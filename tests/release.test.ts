import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageServer } from "../scripts/package-release";
import { deploy, type Deployment } from "../scripts/deploy-release";
import { command } from "../src/command";
import type { Mode } from "../src/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const commit = "a".repeat(40);

test("server archive contains release identity and source, excludes runtime state and credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "woodshed-package-test-")); roots.push(root);
  for (const path of ["src", "scripts", ".woodshed", "node_modules"]) mkdirSync(join(root, path));
  for (const path of ["package.json", "bun.lock", "woodshed.config.example.json", "README.md", "src/server.ts", "scripts/deploy-release.ts"]) await Bun.write(join(root, path), "fixture");
  for (const path of ["woodshed.config.json", ".env.local", ".woodshed/state.sqlite", "node_modules/private"]) await Bun.write(join(root, path), "SECRET");
  const output = join(root, "dist/server.tar.gz");
  await packageServer(root, output, { version: "0.1.123", commit, build: 123 });
  const listing = await command(["tar", "-tzf", output]);
  expect(listing).toContain("./src/server.ts");
  expect(listing).not.toMatch(/\.env|state.sqlite|node_modules|woodshed\.config\.json/);
  expect(JSON.parse(await command(["tar", "-xOf", output, "./build-info.json"]))).toEqual({ version: "0.1.123", commit, build: 123 });
});

function fixture() {
  let mode: Mode = "auto", time = 0, deployed = false, active = 0, broken = false;
  const calls: string[] = [];
  const ops: Deployment = {
    state: async () => ({ mode, syncing: false, prs: active ? [{ job: {} }] : [], health: { activeRuns: active, build: { commit: deployed && !broken ? commit : "old" } } }),
    mode: async value => { mode = value; calls.push(value); },
    stop: async () => { calls.push("stop"); }, backup: async () => { calls.push("backup"); },
    activate: async () => { deployed = true; calls.push("activate"); },
    rollback: async () => { deployed = false; calls.push("rollback"); },
    start: async () => { calls.push("start"); }, wait: async () => { time += 10; }, now: () => time, aborted: () => false,
  };
  return { ops, calls, mode: () => mode, deployed: () => deployed, setMode: (value: Mode) => { mode = value; }, active: (value: number) => { active = value; }, breakHealth: () => { broken = true; } };
}

test("switches only after repairs drain, backs up first, verifies exact commit, restores Auto", async () => {
  const f = fixture(); f.active(1);
  f.ops.wait = async () => { expect(f.calls).toEqual(["watch"]); f.active(0); };
  await deploy(f.ops, commit);
  expect(f.calls).toEqual(["watch", "stop", "backup", "activate", "start", "auto"]);
  expect(f.deployed()).toBe(true);
});

test("drain timeout leaves old service running and restores Auto", async () => {
  const f = fixture(); f.active(1);
  await expect(deploy(f.ops, commit, 20)).rejects.toThrow("not drained");
  expect(f.calls).toEqual(["watch", "auto"]);
});

test("failed startup rolls back code and restores Auto", async () => {
  const f = fixture(); let starts = 0;
  f.ops.start = async () => { f.calls.push("start"); if (++starts === 1) throw Error("Startup failed"); };
  await expect(deploy(f.ops, commit)).rejects.toThrow("Startup failed");
  expect(f.calls).toEqual(["watch", "stop", "backup", "activate", "start", "stop", "rollback", "start", "auto"]);
  expect(f.deployed()).toBe(false);
});

test("wrong running commit rolls back even when the HTTP endpoint responds", async () => {
  const f = fixture(); f.breakHealth();
  await expect(deploy(f.ops, commit, 20, 20)).rejects.toThrow("expected commit");
  expect(f.calls).toContain("rollback"); expect(f.mode()).toBe("auto");
});

test("operator Paused takes precedence and interrupts draining without stopping the service", async () => {
  const f = fixture(); f.active(1);
  f.ops.wait = async () => { f.setMode("paused"); };
  await expect(deploy(f.ops, commit)).rejects.toThrow("Mode changed");
  expect(f.calls).toEqual(["watch"]); expect(f.mode()).toBe("paused");
});

test("Watch stays Watch and cancellation leaves old controller running", async () => {
  const f = fixture(); f.setMode("watch"); f.ops.aborted = () => true;
  await expect(deploy(f.ops, commit)).rejects.toThrow("interrupted");
  expect(f.calls).toEqual([]); expect(f.mode()).toBe("watch");
});
