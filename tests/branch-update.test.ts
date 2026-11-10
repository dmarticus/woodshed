import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, chmodSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchUpdate, SupersededUpdate } from "../src/branch-update";
import { command } from "../src/command";
import type { Snapshot } from "../src/model";
import type { Config, Job } from "../src/model";
import { Runner } from "../src/runner";
import { GitObjects } from "../src/git-objects";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(conflict = true, baseWhitespace = false) {
  const root = mkdtempSync(join(tmpdir(), "woodshed-merge-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const directory = join(root, "job");
  const checkout = join(directory, "checkout");
  mkdirSync(directory);
  const git = (...args: string[]) => command(["git", ...args], { cwd: source });
  await command(["git", "init", "--bare", origin]);
  await command(["git", "init", "--initial-branch=main", source]);
  await git("config", "user.name", "Woodshed Fixture");
  await git("config", "user.email", "fixture@example.com");
  await git("config", "commit.gpgsign", "false");
  await Bun.write(join(source, "shared.txt"), "original behavior\n");
  await Bun.write(join(source, "base-only.txt"), "old base configuration\n");
  await git("add", "."); await git("commit", "-m", "chore: create fixture");
  await git("branch", "feature");
  if (conflict) await Bun.write(join(source, "shared.txt"), "new base behavior\n");
  await Bun.write(join(source, "base-only.txt"), baseWhitespace ? "new base configuration\n  \n" : "new base configuration\n");
  await git("add", "."); await git("commit", "-m", "chore: update fixture base");
  const base = (await git("rev-parse", "HEAD")).trim();
  await git("remote", "add", "origin", origin);
  await git("push", "origin", "main");
  await git("checkout", "feature");
  await Bun.write(join(source, "shared.txt"), "feature behavior\n");
  await Bun.write(join(source, "feature.txt"), "feature content\n");
  await git("add", "."); await git("commit", "-m", "feat: add fixture behavior");
  const head = (await git("rev-parse", "HEAD")).trim();
  await git("push", "origin", "feature");
  await git("worktree", "add", "--detach", checkout, head);
  const pr: Snapshot = { number: 42, title: "Fixture PR", url: "https://github.com/example/project/pull/42", head, branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: null, checks: [], threads: [], reviews: [], labels: [] };
  const update = new BranchUpdate(checkout, directory);
  const plan = await update.prepare(pr, "fixture");
  const remoteHead = async () => (await command(["git", "--git-dir", origin, "rev-parse", "refs/heads/feature"])).trim();
  const resolve = () => Bun.write(join(checkout, "shared.txt"), "new base behavior\nfeature behavior\n");
  return { root, origin, source, directory, checkout, git, base, head, pr, update, plan, remoteHead, resolve };
}

test("conflict resolution publishes a true merge preserving both branches and base-only files", async () => {
  const f = await fixture();
  expect(f.plan.conflicts).toEqual(["shared.txt"]);
  await f.resolve();
  const result = await f.update.finish(f.plan, f.pr);
  expect(result.published).toBe(true);
  expect(await f.remoteHead()).toBe(result.commit);
  const parents = (await command(["git", "rev-list", "--parents", "-n", "1", result.commit], { cwd: f.checkout })).trim().split(" ").slice(1);
  expect(parents).toEqual([f.head, f.base]);
  expect(await Bun.file(join(f.checkout, "base-only.txt")).text()).toBe("new base configuration\n");
  const changed = await command(["git", "diff", "--name-only", f.base, result.commit], { cwd: f.checkout });
  expect(changed.trim().split("\n").sort()).toEqual(["feature.txt", "shared.txt"]);
  expect(await Bun.file(join(f.checkout, "shared.txt")).text()).toBe("new base behavior\nfeature behavior\n");
});

test.each([false, true])("base-only whitespace is accepted while new PR whitespace is rejected (PR whitespace: %s)", async prWhitespace => {
  const f = await fixture(true, true);
  await f.resolve();
  if (prWhitespace) await Bun.write(join(f.checkout, "shared.txt"), "new base behavior\nfeature behavior  \n");
  await expect(command(["git", "diff", "--cached", "--check"], { cwd: f.checkout })).rejects.toThrow("git exited 2");
  if (prWhitespace) {
    await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow("git exited 2");
    expect((await command(["git", "rev-parse", "HEAD"], { cwd: f.checkout })).trim()).toBe(f.head);
    expect(await f.remoteHead()).toBe(f.head);
  } else {
    const result = await f.update.finish(f.plan, f.pr);
    expect(result.published).toBe(true);
    expect(await f.remoteHead()).toBe(result.commit);
    expect(await command(["git", "rev-parse", `${result.commit}:base-only.txt`], { cwd: f.checkout }))
      .toBe(await command(["git", "rev-parse", `${f.base}:base-only.txt`], { cwd: f.checkout }));
    expect(await command(["git", "diff", "--check", f.base, result.commit], { cwd: f.checkout })).toBe("");
  }
});

test("clean branch updates need no conflict-resolution agent", async () => {
  const f = await fixture(false);
  expect(f.plan.conflicts).toEqual([]);
  const result = await f.update.finish(f.plan, { ...f.pr, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" });
  expect(await f.remoteHead()).toBe(result.commit);
  expect(await Bun.file(join(f.checkout, "shared.txt")).text()).toBe("feature behavior\n");
});

test("a fresh recovery checkout avoids the old object cache and retains publishing hooks", async () => {
  const f = await fixture(false);
  await f.git("push", "origin", `${f.head}:refs/pull/42/head`);
  const hooks = (await f.git("rev-parse", "--path-format=absolute", "--git-path", "hooks")).trim();
  const hook = join(hooks, "pre-commit"); await Bun.write(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  let agents = 0;
  const runner = new Runner({ repository: "example/project", checkout: f.source, workerProtocol: "app-server" } as Config, join(f.root, "recovery"), async (argv, options) => {
    if (argv[0] === "hc") { agents++; return "{}"; }
    if (argv[1] === "clone") { const local = [...argv]; local[6] = f.origin; return command(local, options); }
    return command(argv, options);
  });
  runner.models.choose = async () => ({ id: "fixture", name: "Fixture", isDefault: true, price: { input: 1, cached: 0, cacheWrite: 0, output: 1 } });
  const job: Job = { name: "fresh-recovery", head: f.head, fingerprint: "", startedAt: new Date().toISOString(), freshCheckout: true, kind: "repair" };
  await runner.launch(f.pr, job);
  const checkout = join(f.root, "recovery", "jobs", job.name, "checkout");
  expect((await command(["git", "rev-parse", "HEAD"], { cwd: checkout })).trim()).toBe(f.head);
  expect((await command(["git", "config", "core.hooksPath"], { cwd: checkout })).trim()).toBe(hooks);
  expect(await Bun.file(join(checkout, "feature.txt")).text()).toBe("feature content\n");
  await expect(command(["git", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "chore: verify recovery hook"], { cwd: checkout })).rejects.toThrow();
  expect(agents).toBe(1);
});

test.each([false, true])("missing merge blobs use a verified API fallback without changing the checkout (bad payload: %s)", async bad => {
  const f = await fixture(false);
  const oid = (await f.git("rev-parse", `${f.base}:base-only.txt`)).trim();
  const contents = "new base configuration\n";
  const objectPath = (await f.git("rev-parse", "--path-format=absolute", "--git-path", `objects/${oid.slice(0, 2)}/${oid.slice(2)}`)).trim();
  unlinkSync(objectPath);
  const indexPath = (await command(["git", "rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: f.checkout })).trim();
  const index = await Bun.file(indexPath).arrayBuffer(); let calls = 0;
  const objects = new GitObjects(f.checkout, "example/project", async (argv, options) => {
    if (argv[0] === "git" && argv.includes("fetch")) throw new Error("git exited 128: fatal: not our ref");
    if (argv[0] === "gh") { calls++; return JSON.stringify({ sha: oid, size: contents.length, encoding: "base64", content: Buffer.from(bad ? "different content" : contents).toString("base64") }); }
    return command(argv, options);
  });
  if (bad) await expect(objects.ensureMergeInputs(f.head, f.base)).rejects.toThrow("expected identity");
  else {
    await objects.ensureMergeInputs(f.head, f.base);
    expect(await command(["git", "cat-file", "blob", oid], { cwd: f.checkout })).toBe(contents);
    await objects.ensureMergeInputs(f.head, f.base);
  }
  expect(calls).toBe(1);
  expect(await Bun.file(indexPath).arrayBuffer()).toEqual(index);
  expect((await command(["git", "rev-parse", "HEAD"], { cwd: f.checkout })).trim()).toBe(f.head);
});

test("checkout preparation reports progress before an agent exists and failure never becomes an empty running session", async () => {
  const f = await fixture(false); let hcCalls = 0;
  const runner = new Runner({ repository: "example/project", checkout: f.source, workerProtocol: "app-server" } as Config, join(f.root, "preparation"), async (argv, options) => {
    if (argv[0] === "hc") { hcCalls++; throw new Error("hc should not be needed during preparation"); }
    if (argv[1] === "fetch") throw new Error("git exited 128: could not fetch fixture from promisor remote");
    return command(argv, options);
  });
  const states: string[] = []; runner.onProgress = run => states.push(run.state);
  const job = { name: "preparation-fixture", head: f.head, startedAt: new Date().toISOString(), fingerprint: "" };
  await expect(runner.launch(f.pr, job)).rejects.toThrow("promisor remote");
  const inspected = await runner.inspect(job);
  expect(inspected.state).toBe("failed"); expect(inspected.output).toContain("Fetching the current PR head");
  expect(inspected.output).toContain("promisor remote"); expect(hcCalls).toBe(0);
  const run = await runner.telemetry(job);
  expect(run?.costUSD).toBe(0); expect(run?.turns).toBe(0); expect(states).toContain("preparing"); expect(states.at(-1)).toBe("failed");
});

test("rejects edits to base-only files before publishing", async () => {
  const f = await fixture();
  await f.resolve();
  await Bun.write(join(f.checkout, "base-only.txt"), "accidentally restored old configuration\n");
  await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow("outside the conflict set");
  expect(await f.remoteHead()).toBe(f.head);
});

test("rejects staged changes outside the conflict set", async () => {
  const f = await fixture();
  await f.resolve();
  await Bun.write(join(f.checkout, "feature.txt"), "unrelated rewrite\n");
  await command(["git", "add", "feature.txt"], { cwd: f.checkout });
  await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow("outside its conflicts");
  expect(await f.remoteHead()).toBe(f.head);
});

test.each(["unstaged", "staged", "base-only", "binary", "large"])("bounded adjacent conflict integration handles %s changes", async kind => {
  const f = await fixture(); await f.resolve();
  const path = kind === "base-only" ? "base-only.txt" : "feature.txt";
  await Bun.write(join(f.checkout, path), kind === "binary" ? "binary\0data" : kind === "large" ? "integration\n".repeat(301) : "feature content\nrequired conflict integration\n");
  if (kind === "staged") await command(["git", "add", path], { cwd: f.checkout });
  if (["base-only", "binary", "large"].includes(kind)) {
    await expect(f.update.allowAdjacentResolution(f.plan)).rejects.toThrow();
    expect(f.plan.additionalResolutionFiles).toBeUndefined(); expect(await f.remoteHead()).toBe(f.head);
  } else {
    expect(await f.update.allowAdjacentResolution(f.plan)).toBe(true);
    expect(f.plan.additionalResolutionFiles).toEqual(["feature.txt"]);
    expect(await f.update.allowAdjacentResolution(f.plan)).toBe(false);
    const result = await f.update.finish(f.plan, f.pr);
    expect(await f.remoteHead()).toBe(result.commit);
    expect(await command(["git", "show", `${result.commit}:feature.txt`], { cwd: f.checkout })).toContain("required conflict integration");
    expect(await command(["git", "rev-parse", `${result.commit}:base-only.txt`], { cwd: f.checkout })).toBe(await command(["git", "rev-parse", `${f.base}:base-only.txt`], { cwd: f.checkout }));
    expect((await command(["git", "rev-list", "--parents", "-n", "1", result.commit], { cwd: f.checkout })).trim().split(" ").slice(1)).toEqual([f.head, f.base]);
  }
});

test("the runner recovers a completed scope-blocked resolution once without restarting its agent", async () => {
  const f = await fixture(); await f.resolve();
  await Bun.write(join(f.checkout, "feature.txt"), "feature content\nrequired integration\n");
  mkdirSync(join(f.root, "jobs")); symlinkSync(f.directory, join(f.root, "jobs/saved-resolution"), "dir");
  mkdirSync(join(f.directory, "agent-result"));
  await Bun.write(join(f.directory, "runtime.json"), JSON.stringify({ id: "saved-resolution", status: "done", state: "succeeded" }));
  await Bun.write(join(f.directory, "agent-result/result.json"), JSON.stringify({ outcome: "resolved", reason: "Preserved the merged behavior and integrated its PR-owned helper" }));
  const runner = new Runner({ repository: "" } as Config, f.root);
  const job: Job = { name: "saved-resolution", kind: "branch-update", adapter: "app-server", head: f.head, fingerprint: "fixture", startedAt: new Date().toISOString() };
  expect(await runner.recoverPreparedUpdate(job, { ...f.pr, head: "changed" })).toBe(false);
  expect(await runner.recoverPreparedUpdate(job, f.pr)).toBe(true);
  expect(await runner.recoverPreparedUpdate(job, f.pr)).toBe(false);
  expect((await f.update.load()).additionalResolutionFiles).toEqual(["feature.txt"]);
  expect(await f.remoteHead()).toBe(f.head);
});

test("rejects leftover conflict markers", async () => {
  const f = await fixture();
  await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow();
  expect(await f.remoteHead()).toBe(f.head);
});

test("a concurrently changed remote head is never overwritten", async () => {
  const f = await fixture();
  await f.resolve();
  await Bun.write(join(f.source, "concurrent.txt"), "another writer's change\n");
  await f.git("add", "."); await f.git("commit", "-m", "fix: preserve concurrent fixture update");
  await f.git("push", "origin", "feature");
  const newer = await f.remoteHead();
  await expect(f.update.finish(f.plan, f.pr)).rejects.toBeInstanceOf(SupersededUpdate);
  expect(await f.remoteHead()).toBe(newer);
});

test("a retargeted PR requires a fresh merge plan", async () => {
  const f = await fixture();
  await f.resolve();
  await expect(f.update.finish(f.plan, { ...f.pr, base: "different-base" })).rejects.toBeInstanceOf(SupersededUpdate);
  expect(await f.remoteHead()).toBe(f.head);
});

test("recovers after publishing without creating a second commit", async () => {
  const f = await fixture();
  await f.resolve();
  const first = await f.update.finish(f.plan, f.pr);
  const restarted = new BranchUpdate(f.checkout, f.directory);
  const second = await restarted.finish(await restarted.load(), { ...f.pr, head: first.commit });
  expect(second.commit).toBe(first.commit);
  expect(await f.remoteHead()).toBe(first.commit);
});

test("commit and push hooks remain enforced", async () => {
  const f = await fixture();
  await f.resolve();
  const hooks = join(f.root, "hooks"); mkdirSync(hooks);
  const prePush = join(hooks, "pre-push");
  await Bun.write(prePush, "#!/bin/sh\nexit 1\n"); chmodSync(prePush, 0o755);
  await f.git("config", "core.hooksPath", hooks);
  await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow();
  expect(await f.remoteHead()).toBe(f.head);
});

test("full runner dispatches a conflict agent and publishes only after the result is checked", async () => {
  const f = await fixture();
  await command(["git", "--git-dir", f.origin, "update-ref", "refs/pull/42/head", f.head]);
  const dataDir = join(f.root, "runtime");
  const job: Job = { name: "ws-42-integration", head: f.head, fingerprint: "conflict", kind: "branch-update", startedAt: new Date().toISOString() };
  let launches = 0;
  let stopped = false;
  const exec: typeof command = async (argv, options) => {
    if (argv[0] === "hc") {
      if (argv[1] === "run") {
        launches++;
        const cwd = argv[argv.indexOf("--cwd") + 1];
        const prompt = argv.at(-1)!;
        expect(prompt).toContain("Do not run git add, commit, push");
        expect(prompt).toContain('"shared.txt"');
        await Bun.write(join(cwd, "shared.txt"), "new base behavior\nfeature behavior\n");
        await Bun.write(join(dataDir, "jobs", job.name, "agent-result", "result.json"), JSON.stringify({ outcome: "resolved", reason: "Preserved both intentions" }));
        expect(await f.remoteHead()).toBe(f.head);
        return JSON.stringify({ address: "fixture-terminal" });
      }
      if (argv[1] === "get") return JSON.stringify({ state: "live", status: { state: "done" }, turn: 1 });
      if (argv[1] === "kill") { stopped = true; return "{}"; }
      throw new Error("Unexpected hc operation");
    }
    if (argv[0] === "gh") return JSON.stringify({ headRefOid: await f.remoteHead(), headRefName: "feature", baseRefName: "main", state: "OPEN", isDraft: false });
    return command(argv, options);
  };
  const config = { repository: "", checkout: f.source } as Config;
  const runner = new Runner(config, dataDir, exec);
  await runner.launch(f.pr, job);
  expect(launches).toBe(1);
  const restarted = new Runner(config, dataDir, exec);
  const result = await restarted.status(job, f.pr);
  expect(result.state).toBe("published");
  expect(stopped).toBe(true);
  expect(await f.remoteHead()).not.toBe(f.head);
});

test("a clean update completes through the runner without launching Codex", async () => {
  const f = await fixture(false);
  await command(["git", "--git-dir", f.origin, "update-ref", "refs/pull/42/head", f.head]);
  const job: Job = { name: "ws-42-clean", head: f.head, fingerprint: "behind", kind: "branch-update", startedAt: new Date().toISOString() };
  const exec: typeof command = async (argv, options) => {
    if (argv[0] === "hc") throw new Error("Clean merges must not launch or query Codex");
    if (argv[0] === "gh") return JSON.stringify({ headRefOid: f.head, headRefName: "feature", baseRefName: "main", state: "OPEN", isDraft: false });
    return command(argv, options);
  };
  const runner = new Runner({ repository: "", checkout: f.source } as Config, join(f.root, "runtime"), exec);
  await runner.launch(f.pr, job);
  expect((await runner.status(job, f.pr)).state).toBe("published");
});

test("an agent-reported resolution with unrelated edits is never published by the runner", async () => {
  const f = await fixture();
  await command(["git", "--git-dir", f.origin, "update-ref", "refs/pull/42/head", f.head]);
  const dataDir = join(f.root, "runtime");
  const job: Job = { name: "ws-42-scope", head: f.head, fingerprint: "conflict", kind: "branch-update", startedAt: new Date().toISOString() };
  const exec: typeof command = async (argv, options) => {
    if (argv[0] === "hc") {
      if (argv[1] === "run") {
        const cwd = argv[argv.indexOf("--cwd") + 1];
        await Bun.write(join(cwd, "shared.txt"), "resolved behavior\n");
        await Bun.write(join(cwd, "base-only.txt"), "unrelated edit\n");
        await Bun.write(join(dataDir, "jobs", job.name, "agent-result", "result.json"), JSON.stringify({ outcome: "resolved", reason: "Done" }));
      }
      return JSON.stringify({ state: "finished", exit_code: 0 });
    }
    if (argv[0] === "gh") return JSON.stringify({ headRefOid: f.head, headRefName: "feature", baseRefName: "main", state: "OPEN", isDraft: false });
    return command(argv, options);
  };
  const runner = new Runner({ repository: "", checkout: f.source } as Config, dataDir, exec);
  await runner.launch(f.pr, job);
  const result = await runner.status(job, f.pr);
  expect(result.state).toBe("human");
  expect(result.reason).toContain("outside the conflict set");
  expect(await f.remoteHead()).toBe(f.head);
});

test("rejects a linear commit pretending to be a base merge", async () => {
  const f = await fixture();
  await command(["git", "merge", "--abort"], { cwd: f.checkout });
  await f.resolve();
  await command(["git", "add", "shared.txt"], { cwd: f.checkout });
  await command(["git", "commit", "-m", "chore: pretend to merge base"], { cwd: f.checkout });
  await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow();
  expect(await f.remoteHead()).toBe(f.head);
});

test("commit hooks can block a branch update", async () => {
  const f = await fixture();
  await f.resolve();
  const hooks = join(f.root, "hooks"); mkdirSync(hooks);
  const preCommit = join(hooks, "pre-commit");
  await Bun.write(preCommit, "#!/bin/sh\nexit 1\n"); chmodSync(preCommit, 0o755);
  await f.git("config", "core.hooksPath", hooks);
  await expect(f.update.finish(f.plan, f.pr)).rejects.toThrow();
  expect(await f.remoteHead()).toBe(f.head);
});

test("uses the pinned base without chasing subsequent base changes", async () => {
  const f = await fixture();
  await f.resolve();
  await f.git("checkout", "main");
  await Bun.write(join(f.source, "later-base-file.txt"), "base advanced while the agent worked\n");
  await f.git("add", "."); await f.git("commit", "-m", "chore: advance fixture base");
  await f.git("push", "origin", "main");
  const result = await f.update.finish(f.plan, f.pr);
  const parents = (await command(["git", "rev-list", "--parents", "-n", "1", result.commit], { cwd: f.checkout })).trim().split(" ").slice(1);
  expect(parents).toEqual([f.head, f.base]);
});

test("does not create an update when the pinned base is already an ancestor", async () => {
  const f = await fixture(false);
  const first = await f.update.finish(f.plan, f.pr);
  const directory = join(f.root, "second-job"); mkdirSync(directory);
  const checkout = join(directory, "checkout");
  await f.git("worktree", "add", "--detach", checkout, first.commit);
  const update = new BranchUpdate(checkout, directory);
  const current = { ...f.pr, head: first.commit };
  const plan = await update.prepare(current, "already-included");
  expect(plan.noOp).toBe(true);
  const result = await update.finish(plan, current);
  expect(result).toEqual({ commit: first.commit, published: false });
  expect(await f.remoteHead()).toBe(first.commit);
});
