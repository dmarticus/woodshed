import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/command";
import { isolateJobGit, resetJobGit } from "../src/job-git";
import { SystemdSessions, isolationProblem, readUntrusted } from "../src/sessions";
import { missingSession } from "../src/recovery";
import { Runner } from "../src/runner";
import { Worker } from "../src/worker";
import { parseReplies } from "../src/replies";
import { GitHub } from "../src/github";
import { publishedPrices, localDay } from "../src/usage";
import type { Config, Job, Snapshot } from "../src/model";

const roots: string[] = [];
afterEach(() => { resetJobGit(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "woodshed-isolation-"))); roots.push(root); return root; }
function systemctl(responses: { [verb: string]: string } = {}) {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => { calls.push(argv); return argv[0] === "systemctl" ? responses[argv[2]] ?? "" : ""; };
  return { calls, exec: exec as any };
}

test("the controller ignores a checkout's .git pointer, hooks, and fsmonitor when jobs are isolated", async () => {
  const root = scratch();
  const source = join(root, "source"); const evil = join(root, "evil"); const marker = join(root, "ran");
  for (const repo of [source, evil]) {
    await command(["git", "init", "-q", "--initial-branch=main", repo]);
    for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.com"], ["commit.gpgsign", "false"]]) await command(["git", "config", key, value], { cwd: repo });
    await command(["git", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  }
  // Repository hooks live in the tree an agent edits, like PostHog's .husky.
  const sourceHook = join(source, "hooks", "pre-commit"); mkdirSync(join(source, "hooks"));
  writeFileSync(sourceHook, `#!/bin/sh\necho source-hook >> ${marker}\n`); chmodSync(sourceHook, 0o755);
  await command(["git", "config", "core.hooksPath", join(source, "hooks")], { cwd: source });
  const monitor = join(root, "monitor"); writeFileSync(monitor, `#!/bin/sh\necho evil-fsmonitor >> ${marker}\nexit 1\n`); chmodSync(monitor, 0o755);
  await command(["git", "config", "core.fsmonitor", monitor], { cwd: evil });
  const dataDir = join(root, "data"); const checkout = join(dataDir, "jobs", "ws-1-abc", "checkout");
  mkdirSync(join(dataDir, "jobs", "ws-1-abc"), { recursive: true });
  await command(["git", "worktree", "add", "-q", "--detach", checkout, "HEAD"], { cwd: source });
  const head = (await command(["git", "rev-parse", "HEAD"], { cwd: source })).trim();
  // The agent repoints its checkout at a repository it controls.
  writeFileSync(join(checkout, ".git"), `gitdir: ${join(evil, ".git")}\n`);
  await command(["git", "status"], { cwd: checkout });
  expect(await Bun.file(marker).text()).toContain("evil-fsmonitor");
  rmSync(marker);

  isolateJobGit(dataDir, [join(source, ".git")]);
  expect((await command(["git", "rev-parse", "HEAD"], { cwd: checkout })).trim()).toBe(head);
  await command(["git", "status"], { cwd: checkout });
  await command(["git", "commit", "-q", "--allow-empty", "-m", "controller commit"], { cwd: checkout });
  expect(existsSync(marker)).toBe(false);
  expect((await command(["git", "log", "-1", "--format=%s"], { cwd: checkout })).trim()).toBe("controller commit");
  mkdirSync(join(checkout, "nested"));
  await expect(command(["git", "status"], { cwd: join(checkout, "nested") })).rejects.toThrow("root of a job checkout");
});

test("an isolated session only starts the Woodshed worker in its own job", async () => {
  const root = scratch(); const fake = systemctl();
  const sessions = new SystemdSessions(root, fake.exec, 501);
  const directory = join(root, "jobs", "ws-7-abc");
  await expect(sessions.run("ws-7-abc", "/tmp", ["sh", "-c", "id"])).rejects.toThrow("only run the Woodshed worker");
  await expect(sessions.run("../evil", join(root, "jobs", "../evil", "checkout"), ["bun", "/x/worker.ts", join(root, "jobs", "../evil", "worker.json")])).rejects.toThrow();
  await sessions.run("ws-7-abc", join(directory, "checkout"), ["bun", "/release/src/worker.ts", join(directory, "worker.json")]);
  expect(fake.calls).toContainEqual(["setfacl", "-m", "u:woodshed-worker:rx,d:u:woodshed-worker:rX,d:u:501:rwX", directory]);
  for (const writable of ["checkout", "agent-result", "worker"]) expect(fake.calls).toContainEqual(["setfacl", "-m", "u:woodshed-worker:rwx,d:u:woodshed-worker:rwX,d:u:501:rwX", join(directory, writable)]);
  expect(fake.calls.filter(c => c[0] === "setfacl").some(c => c.at(-1)?.endsWith("approvals") || c.at(-1)?.endsWith("control"))).toBe(false);
  expect(fake.calls.at(-1)).toEqual(["systemctl", "--no-ask-password", "start", "--no-block", "woodshed-job@ws-7-abc.service"]);
  expect(existsSync(join(directory, "output.log")) && existsSync(join(directory, "session.json"))).toBe(true);
});

test("isolated session state comes from the unit, and a removed session is missing", async () => {
  const root = scratch(); mkdirSync(join(root, "jobs", "ws-7-abc"), { recursive: true });
  let show = "ActiveState=active\nResult=success\nExecMainStatus=0\nInvocationID=1f\n";
  const sessions = new SystemdSessions(root, (async (argv: string[]) => argv[2] === "show" ? show : "") as any);
  const missing = await sessions.get("ws-7-abc").catch(error => error);
  expect(missingSession(missing)).toBe(true);
  writeFileSync(join(root, "jobs", "ws-7-abc", "session.json"), "{}");
  expect((await sessions.get("ws-7-abc")).state).toBe("live");
  show = "ActiveState=failed\nResult=oom-kill\nExecMainStatus=9\nInvocationID=1f\n";
  expect(await sessions.get("ws-7-abc")).toMatchObject({ state: "finished", reason: "oom-kill", status: { state: "error" } });
  show = "ActiveState=inactive\nResult=success\nExecMainStatus=0\nInvocationID=\n";
  expect(await sessions.get("ws-7-abc")).toMatchObject({ state: "finished", reason: "unloaded" });
  await sessions.remove("ws-7-abc");
  expect(missingSession(await sessions.get("ws-7-abc").catch(error => error))).toBe(true);
});

test("files the agent controls are read without following its symlinks", () => {
  const root = scratch();
  writeFileSync(join(root, "secret"), "oauth_token: controller");
  symlinkSync(join(root, "secret"), join(root, "result.json"));
  expect(() => readUntrusted(join(root, "result.json"))).toThrow();
  writeFileSync(join(root, "runtime.json"), "{}");
  expect(readUntrusted(join(root, "runtime.json"))).toBe("{}");
});

test("isolation is refused until the installed unit matches this controller", () => {
  const root = scratch(); const unit = join(root, "woodshed-job@.service");
  expect(isolationProblem("/data", "/token", unit)).toContain("not installed");
  writeFileSync(unit, "BindPaths=/other/jobs/%i\nLoadCredential=github-token:/token\n");
  expect(isolationProblem("/data", "/token", unit)).toContain("different data directory");
  writeFileSync(unit, "BindPaths=/data/jobs/%i\nLoadCredential=github-token:/token\n");
  expect(isolationProblem("/data", undefined, unit)).toContain("read-only worker GitHub token");
  expect(isolationProblem("/data", "/elsewhere", unit)).toContain("different worker token");
  expect(isolationProblem("/data", "/token", unit)).toBeUndefined();
});

test("an isolated run writes no controller database path and is reached through its own state directory", async () => {
  const root = scratch(); const fake = systemctl();
  const runner = new Runner({ repository: "example/project", checkout: "", workerProtocol: "app-server", jobIsolation: "systemd", runCapUSD: 5, dailyCapUSD: 20, gitSigningKey: "/home/woodshed/.ssh/signing" } as Config, root, fake.exec);
  runner.models.choose = async () => ({ id: "fixture", name: "Fixture", isDefault: true, price: { input: 1, cached: 0, cacheWrite: 0, output: 1 } });
  (runner as any).checkWorkerToken = () => {};
  const pr = { number: 7, head: "abc", title: "t", url: "", branch: "b", base: "main", state: "OPEN", draft: false, checks: [], threads: [], reviews: [], labels: [] } as unknown as Snapshot;
  const job: Job = { name: "ws-triage-7-abc", head: "abc", fingerprint: "", startedAt: new Date().toISOString(), kind: "triage" };
  await runner.launchTriage(pr, job, "report");
  const directory = join(root, "jobs", job.name);
  const config = await Bun.file(join(directory, "worker.json")).json();
  expect(config.dbPath).toBeUndefined(); expect(config.gitSigningKey).toBeUndefined();
  expect(config).toMatchObject({ stateDirectory: join(directory, "worker"), approvalsDirectory: join(directory, "approvals"), spendPath: join(directory, "spend.json") });
  expect(fake.calls.at(-1)).toEqual(["systemctl", "--no-ask-password", "start", "--no-block", `woodshed-job@${job.name}.service`]);

  job.adapter = "app-server";
  writeFileSync(join(directory, "worker", "runtime.json"), JSON.stringify({ id: job.name, status: "blocked", prompt: { id: "q1", kind: "question", text: "Which?" } }));
  expect((await runner.runtime(job))?.prompt?.id).toBe("q1");
  // The worker answers in worker/control because it cannot write the control directory.
  const answering = (async () => {
    for (let i = 0; i < 50; i++) {
      const request = readdirSync(join(directory, "control")).find(f => f.endsWith(".json"));
      if (request) { mkdirSync(join(directory, "worker", "control"), { recursive: true }); writeFileSync(join(directory, "worker", "control", `${request}.ack`), "{}"); return request; }
      await Bun.sleep(20);
    }
  })();
  await runner.send(job, "the first one", "q1");
  expect(await answering).toBeDefined();
  expect(readdirSync(join(directory, "control"))).toEqual([]);
});

test("an isolated worker stops at the daily cap using the spend the controller shares", async () => {
  const root = scratch(); const calls: any[] = [];
  const rpc: any = { request: async (method: string) => { calls.push(method); return {}; }, write: () => {}, close: () => {} };
  writeFileSync(join(root, "spend.json"), JSON.stringify({ day: localDay(), othersUSD: 9.5 }));
  const worker = new Worker({ id: "ws-1-a", number: 1, checkout: root, directory: root, stateDirectory: root, spendPath: join(root, "spend.json"), resultDirectory: root, model: "gpt-6.1-sol", price: publishedPrices["gpt-6.1-sol"], prices: publishedPrices, budgetUSD: 5, dailyCapUSD: 10, startedAt: new Date().toISOString(), prompt: "x" }, rpc);
  worker.state.costsByDay = { [localDay()]: 0.4 };
  expect(await worker.spentToday()).toBeCloseTo(9.9);
  worker.state.costsByDay = { [localDay()]: 0.6 };
  expect(await worker.spentToday()).toBeGreaterThanOrEqual(10);
  writeFileSync(join(root, "spend.json"), JSON.stringify({ day: "1999-01-01", othersUSD: 100 }));
  expect(await worker.spentToday()).toBeCloseTo(0.6);
});

test("agent review replies are limited to this PR's threads and signed", () => {
  const threads = [{ id: "T1", comments: [] }, { id: "T2", comments: [] }];
  expect(parseReplies([{ thread: "T1", body: "Fixed in this commit" }, { thread: "T1", body: "again" }, { thread: "OTHER", body: "x" }, { thread: "T2", body: "Done. via Woodshed", resolve: true }, { thread: "T2", body: "" }, "junk"], threads)).toEqual([
    { thread: "T1", body: "Fixed in this commit\n\nvia Woodshed", resolve: false },
    { thread: "T2", body: "Done. via Woodshed", resolve: true },
  ]);
  expect(parseReplies(undefined, threads)).toEqual([]);
});

test("the controller posts a reply only to a thread on the PR, and resolves only when asked", async () => {
  const calls: string[][] = [];
  const github = new GitHub({ repository: "example/project" } as Config, async (argv: string[]) => {
    calls.push(argv);
    return argv.some(a => a.includes("addPullRequestReviewThreadReply")) ? JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "C" } } } }) : JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } });
  });
  const pr = { number: 7, threads: [{ id: "T1", comments: [] }] } as unknown as Snapshot;
  await expect(github.replyToThread(pr, { thread: "T9", body: "x", resolve: false })).rejects.toThrow("not on this PR");
  await github.replyToThread(pr, { thread: "T1", body: "Fixed\n\nvia Woodshed", resolve: false });
  expect(calls).toHaveLength(1); expect(calls[0]).toContain("body=Fixed\n\nvia Woodshed");
  await github.replyToThread(pr, { thread: "T1", body: "Fixed", resolve: true });
  expect(calls).toHaveLength(3); expect(calls[2].join(" ")).toContain("resolveReviewThread");
});

test("a run its unit killed for memory is reported as failed instead of resumed", async () => {
  const root = scratch();
  const runner = new Runner({ repository: "example/project", checkout: "", workerProtocol: "app-server", jobIsolation: "systemd" } as Config, root, (async (argv: string[]) => argv[2] === "show" ? "ActiveState=failed\nResult=oom-kill\nExecMainStatus=9\nInvocationID=1f\n" : "") as any);
  const job: Job = { name: "ws-9-abc", head: "abc", fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" };
  const directory = join(root, "jobs", job.name);
  mkdirSync(join(directory, "worker"), { recursive: true });
  writeFileSync(join(directory, "worker.json"), "{}"); writeFileSync(join(directory, "session.json"), "{}");
  writeFileSync(join(directory, "worker", "runtime.json"), JSON.stringify({ id: job.name, status: "working", state: "running", summary: "Running tests" }));
  expect((await runner.health(job)).state).toBe("finished");
  expect(await runner.runtime(job)).toMatchObject({ status: "error", state: "failed", summary: "The run used more memory than a job is allowed and was stopped" });
  expect(await runner.status(job)).toEqual({ state: "human", reason: "The run used more memory than a job is allowed and was stopped" });
});
