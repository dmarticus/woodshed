import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller";
import { Runner } from "../src/runner";
import { Store } from "../src/store";
import { gitShellSettings } from "../src/git-environment";
import { WorkerCredentialError } from "../src/worker-credentials";
import { fingerprint, type Config, type Job, type Snapshot } from "../src/model";

const TOKEN = `github_pat_${"WorkerFixture0".repeat(4)}`;
const CONTROLLER_TOKEN = `gho_${"ControllerFixture".repeat(2)}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "woodshed-worker-token-")); roots.push(root); return root; };
const tokenFile = (root: string, mode = 0o600) => { const path = join(root, "worker-github-token"); writeFileSync(path, `${TOKEN}\n`); chmodSync(path, mode); return path; };
const pr = (): Snapshot => ({ number: 42, title: "Fixture PR", url: "https://github.com/example/project/pull/42", head: "a".repeat(40), branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, checks: [{ name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }], reviews: [], threads: [], labels: [] });
const job = (name: string, kind: Job["kind"] = "repair"): Job => ({ name, head: "a".repeat(40), fingerprint: "", startedAt: new Date().toISOString(), kind, model: "fixture-model", budgetUSD: 5 });
const files = (root: string): string[] => readdirSync(root, { recursive: true, encoding: "utf8" }).map(p => join(root, p)).filter(p => statSync(p).isFile());
const launcher = join(import.meta.dir, "../src/worker-launch.ts");

function runner(root: string, overrides: Partial<Config> = {}) {
  const commands: string[][] = [];
  const config = { repository: "example/project", checkout: root, ...overrides } as Config;
  const result = new Runner(config, join(root, "data"), async argv => {
    commands.push(argv);
    if (argv[0] === "git" && argv[1] === "rev-parse") return `${"a".repeat(40)}\n`;
    return argv[0] === "hc" ? "{}" : "";
  });
  result.models.list = async () => [{ id: "fixture-model", name: "Fixture", isDefault: true, price: { input: 1, cached: 0, output: 1, cacheWrite: 0 } }];
  return { runner: result, commands, launches: () => commands.filter(argv => argv[0] === "hc" && argv[1] === "run") };
}

test("every worker launch path starts under the worker token without exposing it", async () => {
  const root = temp(); const path = tokenFile(root);
  const classic = runner(root, { workerGitHubTokenPath: path });
  await classic.runner.launch(pr(), job("ws-repair"));
  await classic.runner.launchTriage(pr(), job("ws-triage", "triage"), "Investigate the failing check");
  const server = runner(root, { workerGitHubTokenPath: path, workerProtocol: "app-server" });
  await server.runner.launchTriage(pr(), job("ws-server", "triage"), "Investigate the failing check");
  const directory = join(root, "data", "jobs", "ws-server");
  await Bun.write(join(directory, "runtime.json"), JSON.stringify({ id: "ws-server", number: 42, threadId: "thread", costUSD: 0.1, status: "working" }));
  await server.runner.resume({ ...job("ws-server", "triage"), adapter: "app-server" }, "Continue");

  const launches = [...classic.launches(), ...server.launches()];
  expect(launches.length).toBe(4);
  for (const argv of launches) {
    const wrapped = argv.slice(argv.indexOf("--cwd") + 2);
    expect(wrapped.slice(1, 3)).toEqual([launcher, path]);
    expect(wrapped[4]).toBe("--");
  }
  expect(launches.map(argv => argv.at(-1))).toEqual([expect.stringContaining("read-only"), expect.any(String), expect.stringContaining("worker.json"), expect.stringContaining("worker.json")]);
  expect(JSON.stringify([...classic.commands, ...server.commands])).not.toContain(TOKEN);
  for (const file of files(join(root, "data"))) expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
});

test("workers get only the worker token and can't fall back to the controller's login", async () => {
  const root = temp(); const path = tokenFile(root);
  const home = join(root, "home"); mkdirSync(join(home, ".config/gh"), { recursive: true });
  writeFileSync(join(home, ".config/gh/hosts.yml"), `github.com:\n    oauth_token: ${CONTROLLER_TOKEN}\n    user: controller\n    git_protocol: https\n`);
  const helper = `!f() { echo username=controller; echo password=${CONTROLLER_TOKEN}; }; f`;
  writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = "${helper}"\n[credential "https://github.com"]\n\thelper = "${helper}"\n`);
  const fill = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p'`;
  const script = [
    `expected=$(cat "$FIXTURE_TOKEN_FILE")`,
    `[ "$(${fill})" = "$expected" ] && echo git-uses-worker-token`,
    `[ "$(gh auth token 2>/dev/null)" = "$expected" ] && echo gh-uses-worker-token`,
    `[ -z "$(unset GH_TOKEN; ${fill})" ] && echo git-has-no-fallback`,
    `(unset GH_TOKEN; gh auth token >/dev/null 2>&1) || echo gh-has-no-fallback`,
  ].join("\n");
  const { runner: r, launches } = runner(root, { workerGitHubTokenPath: path });
  await r.launchTriage(pr(), job("ws-env", "triage"), "Investigate");
  const argv = launches()[0]; const wrapped = argv.slice(argv.indexOf("--cwd") + 2, argv.indexOf("--") + 1);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GH_TOKEN: CONTROLLER_TOKEN, GITHUB_TOKEN: CONTROLLER_TOKEN, FIXTURE_TOKEN_FILE: path };
  delete env.XDG_CONFIG_HOME; delete env.GH_CONFIG_DIR;
  const result = Bun.spawnSync([...wrapped, "sh", "-c", script], { env, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.stdout.toString().trim().split("\n")).toEqual(["git-uses-worker-token", "gh-uses-worker-token", "git-has-no-fallback", "gh-has-no-fallback"]);
  expect(output).not.toContain(TOKEN); expect(output).not.toContain(CONTROLLER_TOKEN);
  expect(readdirSync(join(root, "data", "jobs", "ws-env", "github"))).toEqual([]);
  expect(JSON.stringify(gitShellSettings(undefined, "worker"))).not.toContain("gh auth git-credential");
});

test("workers fail closed when the configured token can't be used", async () => {
  const root = temp();
  for (const path of [join(root, "missing-token"), tokenFile(root, 0o640)]) {
    const { runner: r, commands } = runner(root, { workerGitHubTokenPath: path, workerProtocol: "app-server" });
    await expect(r.launch(pr(), job("ws-closed"))).rejects.toBeInstanceOf(WorkerCredentialError);
    await expect(r.launchTriage(pr(), job("ws-closed", "triage"), "Investigate")).rejects.toBeInstanceOf(WorkerCredentialError);
    await expect(r.resume({ ...job("ws-closed"), adapter: "app-server" }, "Continue")).rejects.toBeInstanceOf(WorkerCredentialError);
    expect(commands).toEqual([]);
  }
  const marker = join(root, "started");
  const result = Bun.spawnSync([process.execPath, launcher, join(root, "missing-token"), join(root, "gh"), "--", "touch", marker], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(78); expect(existsSync(marker)).toBe(false);
});

test("an unreadable worker token becomes an owner decision instead of a launch", async () => {
  const root = temp(); const path = join(root, "worker-github-token");
  const store = new Store(":memory:"); let launched = 0; let triaged = 0;
  const config = { repository: "example/project", mode: "auto", automation: true, maxAttempts: 3, maxConcurrentJobs: 1, runCapUSD: 5, dailyCapUSD: 20, reviewLabel: "review", approvalLabel: "approval", workerGitHubTokenPath: path } as Config;
  const runner: any = { launch: async () => { launched++; }, launchTriage: async () => { triaged++; }, stop: async () => {}, status: async () => ({ state: "working" }) };
  const controller = new Controller(config, store, { snapshot: async () => pr() } as any, runner);
  store.put({ snapshot: pr(), decision: { kind: "fix", reason: "Tests failed" }, fingerprint: fingerprint(pr()), attempts: 0, paused: false });

  await controller.reconcile(pr());
  await controller.prepareAttention();
  expect(store.get(42)!.decision).toMatchObject({ kind: "human", title: "Fix the worker GitHub token" });
  expect({ launched, triaged }).toEqual({ launched: 0, triaged: 0 });
  expect(controller.warnings().map(w => w.id)).toContain("worker-token-unreadable");

  tokenFile(root);
  await controller.reconcile(pr());
  expect(launched).toBe(1); expect(controller.warnings().map(w => w.id).filter(id => id.startsWith("worker-token"))).toEqual([]);
  config.workerGitHubTokenPath = undefined;
  expect(controller.warnings().map(w => w.id)).toContain("worker-token-shared");
});
