import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { supportDirectory } from "../src/connection";
import { readWorkerToken, workerEnvironment } from "../src/worker-credentials";

const configPath = resolve(process.env.WOODSHED_CONFIG ?? "woodshed.config.json");
const config = await Bun.file(configPath).json();
const repository: string = config.repository;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Set repository in the Woodshed config first");

console.log(`Woodshed workers need their own read-only GitHub token for ${repository}.

1. Open https://github.com/settings/personal-access-tokens/new (a fine-grained token, not a classic one).
2. Resource owner: ${repository.split("/")[0]}. Repository access: Only select repositories, then ${repository}.
3. Repository permissions, all Read-only: Actions, Checks, Commit statuses, Contents, Issues, Pull requests. Metadata is read-only automatically.
   Leave every other permission at No access. Don't grant any write access.
4. Generate the token and paste it below. It is not shown while you paste it.
`);

async function readSecret(): Promise<string> {
  const tty = process.stdin.isTTY;
  if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    process.stdout.write("Token: ");
    for await (const line of console) return line.trim();
    return "";
  } finally { if (tty) { Bun.spawnSync(["stty", "echo"], { stdin: "inherit" }); process.stdout.write("\n"); } }
}

const token = await readSecret();
if (!token.startsWith("github_pat_")) throw new Error("Use a fine-grained token (it starts with github_pat_). Classic tokens can't be limited to one repository or to read access");

// Check the token on its own, without the controller's gh login.
const scratch = mkdtempSync(join(tmpdir(), "woodshed-worker-token-"));
async function api(method: string, path: string): Promise<number> {
  const proc = Bun.spawn(["gh", "api", "--method", method, path], { env: workerEnvironment(process.env, token, scratch), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return code === 0 ? 200 : Number(error.match(/\(HTTP (\d{3})\)/)?.[1] ?? 0);
}
try {
  for (const path of [`repos/${repository}`, `repos/${repository}/pulls?per_page=1`, `repos/${repository}/issues?per_page=1`, `repos/${repository}/actions/runs?per_page=1`, `repos/${repository}/commits/HEAD/check-runs?per_page=1`, `repos/${repository}/commits/HEAD/status`]) {
    const status = await api("GET", path);
    if (status !== 200) throw new Error(`The token can't read ${path} (HTTP ${status || "error"}). Check its repository and read permissions`);
  }
  // Both requests are incomplete on purpose: GitHub refuses them with 403 or 404 without write access,
  // and with write access it rejects them as invalid (422), so nothing is ever created.
  for (const [what, method, path] of [["create issues", "POST", `repos/${repository}/issues`], ["change files or workflows", "PUT", `repos/${repository}/contents/.github/workflows/woodshed-write-probe.yml`]]) {
    const status = await api(method, path);
    if (status !== 403 && status !== 404) throw new Error(`The token can ${what} (HTTP ${status || "error"}). Create a token with read-only permissions`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

const directory = supportDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = join(directory, "worker-github-token");
writeFileSync(`${path}.tmp`, `${token}\n`, { mode: 0o600 }); chmodSync(`${path}.tmp`, 0o600); renameSync(`${path}.tmp`, path);
readWorkerToken(path);
await Bun.write(`${configPath}.tmp`, JSON.stringify({ ...config, workerGitHubTokenPath: path }, null, 2) + "\n");
chmodSync(`${configPath}.tmp`, 0o600); renameSync(`${configPath}.tmp`, configPath);
console.log(`Saved the read-only worker token to ${path} (mode 0600). Restart the controller so new workers use it.`);
