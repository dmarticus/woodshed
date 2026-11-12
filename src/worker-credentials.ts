import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitEnvironment } from "./git-environment";
import { supportDirectory } from "./connection";
import type { Config } from "./model";

export class WorkerCredentialError extends Error {}

// Anything that could let a worker reach the controller's GitHub login instead of the worker token.
const inheritedCredentials = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];

// `private` is false for a systemd credential: systemd makes it readable only by the one unit, with its own mode.
export function readWorkerToken(path: string, private_ = true): string {
  let token: string;
  try {
    if (private_ && statSync(path).mode & 0o077) throw new WorkerCredentialError(`The worker GitHub token at ${path} must be readable only by its owner (mode 0600)`);
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof WorkerCredentialError) throw error;
    throw new WorkerCredentialError(`Cannot read the worker GitHub token at ${path}`);
  }
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new WorkerCredentialError(`The worker GitHub token at ${path} is empty or malformed`);
  return token;
}

export function workerCredentialProblem(config: Pick<Config, "workerGitHubTokenPath">): string | undefined {
  if (!config.workerGitHubTokenPath) return undefined;
  try { readWorkerToken(config.workerGitHubTokenPath); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export function workerEnvironment(base: NodeJS.ProcessEnv, token: string, configDirectory: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of inheritedCredentials) delete env[key];
  env.GH_TOKEN = token; env.GH_CONFIG_DIR = configDirectory; env.GH_PROMPT_DISABLED = "1";
  env.WOODSHED_WORKER_GITHUB = "read-only";
  return gitEnvironment(undefined, env, "worker");
}

// Wraps a worker command so it starts with only the worker token. The token is read from its file
// when the worker starts and never appears in argv, prompts, or job files.
export function workerCommand(config: Pick<Config, "workerGitHubTokenPath">, directory: string, argv: string[]): string[] {
  if (!config.workerGitHubTokenPath) return argv;
  readWorkerToken(config.workerGitHubTokenPath);
  return [process.execPath, join(import.meta.dir, "worker-launch.ts"), config.workerGitHubTokenPath, join(directory, "github"), "--", ...argv];
}

// The token file an isolated job's unit loads: the read-only worker token, or with workerGitHub "controller",
// a copy of the controller's own token that the runner refreshes before each start.
export function isolatedTokenPath(config: Pick<Config, "workerGitHubTokenPath" | "workerGitHub">): string | undefined {
  return config.workerGitHubTokenPath ?? (config.workerGitHub === "controller" ? join(supportDirectory(), "worker-github-token") : undefined);
}
