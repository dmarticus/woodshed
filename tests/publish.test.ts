import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "../src/runner";
import { Publisher } from "../src/publish";
import { command } from "../src/command";
import type { Snapshot } from "../src/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "woodshed-publish-")); roots.push(root);
  const checkout = join(root, "checkout"); const origin = join(root, "origin.git"); const directory = join(root, "jobs", "job"); mkdirSync(directory, { recursive: true });
  await command(["git", "init", "--bare", origin]);
  await command(["git", "init", "--initial-branch=feature", checkout]);
  const git = (...args: string[]) => command(["git", ...args], { cwd: checkout });
  await git("config", "user.name", "Woodshed fixture"); await git("config", "user.email", "fixture@example.com"); await git("config", "commit.gpgSign", "false");
  await git("commit", "--allow-empty", "-m", "chore: initial fixture");
  await git("remote", "add", "origin", origin); await git("push", "origin", "feature");
  const head = (await git("rev-parse", "HEAD")).trim();
  const pr = { number: 42, head, branch: "feature", base: "main", state: "OPEN", draft: false } as Snapshot;
  await Bun.write(join(checkout, "repair.txt"), "verified repair\n");
  return { root, checkout, origin, directory, git, head, pr, publisher: new Publisher(checkout, directory), remoteHead: async () => (await command(["git", "--git-dir", origin, "rev-parse", "feature"])).trim() };
}

test("controller publishes exactly declared changes and recovers without a duplicate commit", async () => {
  const f = await fixture();
  const commit = await f.publisher.publish(f.head, f.pr, ["repair.txt"]);
  expect(await f.remoteHead()).toBe(commit);
  expect(await f.git("log", "-1", "--format=%B")).toContain("Woodshed-Run: job");
  expect((await f.git("rev-parse", "HEAD^")).trim()).toBe(f.head);
  expect(await f.publisher.publish(f.head, { ...f.pr, head: commit }, ["repair.txt"])).toBe(commit);
  expect((await f.git("rev-list", "--count", `${f.head}..HEAD`)).trim()).toBe("1");
});
test("undeclared changed files cannot be published", async () => {
  const f = await fixture(); await Bun.write(join(f.checkout, "unexpected.txt"), "unrelated\n");
  await expect(f.publisher.publish(f.head, f.pr, ["repair.txt"])).rejects.toThrow("declared repair scope");
  expect(await f.remoteHead()).toBe(f.head);
});
test("a changed remote head is never overwritten", async () => {
  const f = await fixture();
  await f.git("commit", "--allow-empty", "-m", "chore: simulate concurrent update"); await f.git("push", "origin", "feature");
  const newer = await f.remoteHead(); await f.git("checkout", "--detach", f.head);
  await expect(f.publisher.publish(f.head, f.pr, ["repair.txt"])).rejects.toThrow("branch changed");
  expect(await f.remoteHead()).toBe(newer);
});
test.each(["pre-commit", "pre-push"])("%s hooks remain authoritative for service publishing", async hook => {
  const f = await fixture(); const path = join(f.checkout, ".git", "hooks", hook);
  await Bun.write(path, "#!/bin/sh\nexit 1\n"); chmodSync(path, 0o755);
  await expect(f.publisher.publish(f.head, f.pr, ["repair.txt"])).rejects.toThrow();
  expect(await f.remoteHead()).toBe(f.head);
});

test.each(["ready_to_publish", "no_change"])("a clean %s result never attempts an empty publish", async outcome => {
  const f = await fixture(); unlinkSync(join(f.checkout, "repair.txt"));
  symlinkSync(f.checkout, join(f.directory, "checkout"), "dir");
  mkdirSync(join(f.directory, "agent-result"));
  await Bun.write(join(f.directory, "agent-result", "result.json"), JSON.stringify({ outcome, files: [], reason: "The issue was fixed elsewhere" }));
  await Bun.write(join(f.directory, "runtime.json"), JSON.stringify({ id: "job", status: "done" }));
  const runner = new Runner({} as any, f.root, async argv => {
    if (argv[0] !== "hc" || argv[1] !== "get") throw new Error("A no-change run must not publish or launch work");
    return JSON.stringify({ state: "finished" });
  });
  expect(await runner.status({ name: "job", head: f.head, fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" }, f.pr)).toMatchObject({ state: "completed", reason: "The issue was fixed elsewhere" });
  expect(await f.remoteHead()).toBe(f.head);
});
