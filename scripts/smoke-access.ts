import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "../src/command";
import { publishedPrices } from "../src/usage";
import { gitEnvironment } from "../src/git-environment";
import { workerCommand } from "../src/worker-credentials";
import { SystemdSessions } from "../src/sessions";

const config = await Bun.file(process.argv[2]).json();
if (!config.gitSigningKey) throw new Error("Complete setup-signing before running this smoke test");
process.env.WOODSHED_SIGNING_KEY = config.gitSigningKey;
// With jobIsolation the agent runs in a woodshed-job unit as the worker user, exactly like a real run.
const isolated = config.jobIsolation === "systemd";
const name = `ws-access-${randomUUID().slice(0, 8)}`;
const dataDir = isolated ? realpathSync(resolve(import.meta.dir, "..", ".woodshed")) : "";
const sessions = isolated ? new SystemdSessions(dataDir) : undefined;
const directory = isolated ? join(dataDir, "jobs", name) : mkdtempSync(join(tmpdir(), "woodshed-access-"));
if (sessions) await sessions.isolate(directory);
const checkout = isolated ? join(directory, "checkout") : directory;
const resultDirectory = join(directory, isolated ? "agent-result" : "result"); mkdirSync(resultDirectory, { recursive: true });
await command(["git", "init", "-q"], { cwd: checkout });
await command(["git", "remote", "add", "origin", "git@github.com:PostHog/posthog.git"], { cwd: checkout });
await Bun.write(join(checkout, "AGENTS.md"), "This is an isolated Woodshed access test. The owner authorizes reading GitHub PR 130393 and preparing verified.txt for the controller to sign locally. Never push, mutate GitHub, or change another repository.\n");
const path = join(directory, "worker.json"); const model = "gpt-6.1-sol";
await Bun.write(path, JSON.stringify({ id: name, number: 0, checkout, directory, resultDirectory, model, price: publishedPrices[model], prices: publishedPrices, budgetUSD: 1, startedAt: new Date().toISOString(), ...(isolated ? { stateDirectory: join(directory, "worker"), approvalsDirectory: join(directory, "approvals") } : {}), prompt: `Verify routine GitHub access without asking for permission: run gh api repos/PostHog/posthog/pulls/130393 --jq .number; run git remote get-url origin and git ls-remote origin HEAD. After all commands succeed create verified.txt containing 'GitHub read verified'. Do not stage, commit, push, or mutate GitHub. The controller will sign this locally. Write ${join(resultDirectory, "result.json")} with {"outcome":"ready_to_publish","files":["verified.txt"],"reason":"GitHub read verified"} only if all commands succeed, otherwise {"outcome":"needs_human","reason":"the verified failure"}. Stop.` }));
const argv = [process.execPath, join(import.meta.dir, "../src/worker.ts"), path];
let started = false;
try {
  if (sessions) {
    await sessions.run(name, checkout, argv); started = true;
    for (let i = 0; i < 450 && (await sessions.get(name)).state === "live" && !["done", "blocked", "error"].includes((await Bun.file(join(directory, "worker", "runtime.json")).json().catch(() => ({}))).status); i++) await Bun.sleep(200);
  } else {
    await command(["hc", "run", "--json", "--bg", "--no-parent", "--name", name, "--cwd", directory, ...workerCommand(config, directory, argv)]); started = true;
    await command(["hc", "wait", "--json", "--timeout", "90", name], { timeout: 100_000 });
  }
  const state = await Bun.file(join(directory, isolated ? "worker" : "", "runtime.json")).json();
  if (state.status !== "done") throw new Error(`Access smoke stopped: ${state.summary}`);
  if (!await Bun.file(join(checkout, "verified.txt")).exists()) throw new Error("Agent did not prepare its declared change");
  // Sign in a repository the controller alone controls, as publishing does.
  const signing = mkdtempSync(join(tmpdir(), "woodshed-access-sign-"));
  await command(["git", "init", "-q"], { cwd: signing });
  await command(["git", "config", "user.name", "Woodshed access test"], { cwd: signing });
  await command(["git", "config", "user.email", "woodshed@example.com"], { cwd: signing });
  cpSync(join(checkout, "verified.txt"), join(signing, "verified.txt"));
  await command(["git", "add", "--", "verified.txt"], { cwd: signing });
  await command(["git", "-c", "core.hooksPath=/dev/null", "commit", "-m", "chore: verify Woodshed service signing"], { cwd: signing });
  const allowed = join(signing, "allowed-signers");
  await Bun.write(allowed, `woodshed@example.com ${await Bun.file(config.gitSigningKey + ".pub").text()}`);
  const env = gitEnvironment(config.gitSigningKey);
  const verification = Bun.spawn(["git", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", "HEAD"], { cwd: signing, env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(verification.stderr).text();
  if (await verification.exited !== 0) throw new Error(`Signature verification failed: ${output}`);
  rmSync(signing, { recursive: true, force: true });
  console.log(JSON.stringify({ githubRead: true, isolated, localSignature: "verified", prompts: 0, estimatedUSD: state.costUSD, directory }));
} finally {
  if (started && sessions) { await sessions.kill(name).catch(() => undefined); await sessions.remove(name); await sessions.release(name); rmSync(directory, { recursive: true, force: true }); }
  else if (started) { await command(["hc", "kill", name]); await command(["hc", "rm", name]); }
}
