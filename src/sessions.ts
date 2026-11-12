import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, constants, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { command } from "./command";
import { MissingSession } from "./recovery";

// What the runner needs from whatever keeps an agent running after the controller restarts.
export type Terminal = { state: "live" | "finished"; status?: { state?: string; kind?: string; msg?: string }; turn?: number; reason?: string };
export interface Sessions {
  readonly kind: "herdr" | "systemd";
  run(name: string, cwd: string, argv: string[]): Promise<void>;
  get(name: string): Promise<Terminal>;
  read(name: string, lines: number): Promise<string>;
  kill(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  send(name: string, text: string, force: boolean): Promise<void>;
  interrupt(name: string): Promise<void>;
  // Gives files the agent created back to the controller so housekeeping can delete them.
  release(name: string): Promise<void>;
}

export class HerdrSessions implements Sessions {
  readonly kind = "herdr";
  constructor(readonly exec: typeof command) {}
  async run(name: string, cwd: string, argv: string[]): Promise<void> {
    await this.exec(["hc", "run", "--json", "--bg", "--no-parent", "--name", name, "--cwd", cwd, ...argv], { timeout: 90_000 });
  }
  async get(name: string): Promise<Terminal> { return JSON.parse(await this.exec(["hc", "get", "--json", name])); }
  read(name: string, lines: number): Promise<string> { return this.exec(["hc", "read", "--lines", String(lines), name]); }
  async kill(name: string): Promise<void> { await this.exec(["hc", "kill", name]); }
  async remove(name: string): Promise<void> { await this.exec(["hc", "rm", name]); }
  async send(name: string, text: string, force: boolean): Promise<void> { await this.exec(["hc", "send", "--json", ...(force ? ["--force"] : []), name, text]); }
  async interrupt(name: string): Promise<void> { await this.exec(["hc", "interrupt", name]); }
  async release(): Promise<void> {}
}

export const WORKER_USER = "woodshed-worker";
export const JOB_UNIT = "/etc/systemd/system/woodshed-job@.service";

// Each job runs as WORKER_USER in a woodshed-job@<name> unit that scripts/setup-job-isolation.sh installs.
// The unit fixes what runs and what it can see; the controller can only start and stop it.
export class SystemdSessions implements Sessions {
  readonly kind = "systemd";
  constructor(readonly dataDir: string, readonly exec: typeof command = command, readonly controllerUid = process.getuid?.() ?? 0) {}
  private unit(name: string, template = "woodshed-job"): string {
    if (!/^ws-[a-z0-9-]{1,60}$/.test(name)) throw new Error(`Invalid job name ${name}`);
    return `${template}@${name}.service`;
  }
  private directory(name: string): string { return join(this.dataDir, "jobs", name); }
  private systemctl(...args: string[]): Promise<string> { return this.exec(["systemctl", "--no-ask-password", ...args], { timeout: 60_000 }); }
  private setfacl(...args: string[]): Promise<string> { return this.exec(["setfacl", ...args]); }
  // The job directory stays read-only to the agent: the controller writes its plans, prompts, and
  // control files there, so a writable directory would let the agent plant symlinks the controller follows.
  // Only the checkout, the result directory, and the worker's own state directory are writable.
  async isolate(directory: string): Promise<void> {
    const controller = `u:${this.controllerUid}`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await this.setfacl("-m", `u:${WORKER_USER}:rx,d:u:${WORKER_USER}:rX,d:${controller}:rwX`, directory);
    for (const writable of ["checkout", "agent-result", "worker"]) {
      mkdirSync(join(directory, writable), { recursive: true, mode: 0o700 });
      await this.setfacl("-m", `u:${WORKER_USER}:rwx,d:u:${WORKER_USER}:rwX,d:${controller}:rwX`, join(directory, writable));
    }
    // With default ACLs a new directory's group bits become its ACL mask; 0o700 would hide these from the agent.
    for (const readable of ["control", "approvals"]) mkdirSync(join(directory, readable), { recursive: true, mode: 0o750 });
  }
  async run(name: string, cwd: string, argv: string[]): Promise<void> {
    const directory = this.directory(name);
    // The unit always runs the Woodshed worker on this job's worker.json; anything else cannot be isolated.
    if (cwd !== join(directory, "checkout") || argv.at(-1) !== join(directory, "worker.json") || !argv.some(arg => arg.endsWith("/worker.ts")))
      throw new Error("Isolated jobs can only run the Woodshed worker in their own checkout");
    if (!existsSync(join(directory, "worker"))) await this.isolate(directory);
    // systemd would create the log as root; the controller owns it so it can read and rotate it.
    if (!existsSync(join(directory, "output.log"))) await Bun.write(join(directory, "output.log"), "");
    const session = join(directory, "session.json");
    await Bun.write(`${session}.tmp`, JSON.stringify({ unit: this.unit(name), startedAt: new Date().toISOString() })); renameSync(`${session}.tmp`, session);
    await this.systemctl("reset-failed", this.unit(name)).catch(() => undefined);
    await this.systemctl("start", "--no-block", this.unit(name));
  }
  async get(name: string): Promise<Terminal> {
    if (!existsSync(join(this.directory(name), "session.json"))) throw new MissingSession(`no session for ${name}`);
    const fields = Object.fromEntries((await this.systemctl("show", this.unit(name), "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus", "-p", "InvocationID")).trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (["active", "activating", "deactivating", "reloading"].includes(fields.ActiveState)) return { state: "live" };
    // systemd unloads a stopped unit, so no invocation means it ended before a reboot or was stopped and collected.
    const reason = !fields.InvocationID ? "unloaded" : fields.Result === "success" ? "exited" : fields.Result;
    return { state: "finished", reason, status: { state: reason === "oom-kill" ? "error" : undefined, msg: reason === "oom-kill" ? "The run used more memory than a job is allowed and was stopped" : undefined } };
  }
  async read(name: string, lines: number): Promise<string> {
    const text = readTail(join(this.directory(name), "output.log"), 256 * 1024);
    return text.split("\n").slice(-lines).join("\n");
  }
  async kill(name: string): Promise<void> { await this.systemctl("stop", this.unit(name)); }
  async remove(name: string): Promise<void> {
    try { unlinkSync(join(this.directory(name), "session.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.systemctl("reset-failed", this.unit(name)).catch(() => undefined);
  }
  async send(): Promise<void> { throw new Error("Isolated runs take replies through Woodshed, not the terminal"); }
  async interrupt(): Promise<void> { throw new Error("Isolated runs are interrupted through Woodshed, not the terminal"); }
  async release(name: string): Promise<void> {
    if (existsSync(join(this.directory(name), "worker"))) await this.systemctl("start", this.unit(name, "woodshed-job-release"));
  }
}

// Why isolated jobs cannot start on this machine, or undefined when they can.
export function isolationProblem(dataDir: string, tokenPath: string | undefined, unitPath = JOB_UNIT): string | undefined {
  let unit: string[];
  try { unit = readFileSync(unitPath, "utf8").split("\n"); } catch { return "Job isolation is not installed. Run scripts/setup-job-isolation.sh as root"; }
  if (!unit.includes(`BindPaths=${dataDir}/jobs/%i`)) return `The installed job unit is for a different data directory than ${dataDir}. Rerun scripts/setup-job-isolation.sh as root`;
  if (!tokenPath) return "Isolated jobs need a read-only worker GitHub token. Run scripts/setup-worker-token.ts";
  if (!unit.includes(`LoadCredential=github-token:${tokenPath}`)) return `The installed job unit loads a different worker token than ${tokenPath}. Rerun scripts/setup-job-isolation.sh as root`;
  return undefined;
}

// Reads a file the agent can write without following a symlink it planted to a controller file.
export function readUntrusted(path: string, limit = 4 * 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > limit) throw new Error(`${path} is larger than ${limit} bytes`);
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) { const n = readSync(fd, buffer, read, stat.size - read, read); if (!n) break; read += n; }
    return buffer.subarray(0, read).toString("utf8");
  } finally { closeSync(fd); }
}
export function readUntrustedJSON<T = any>(path: string): T { return JSON.parse(readUntrusted(path)); }
export function untrustedExists(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function readTail(path: string, bytes: number): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return ""; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}

// Answers the worker has not acknowledged yet, oldest first. Used by the worker and woodshed-respond.
export function pendingRequests(directory: string): string[] {
  try { return readdirSync(directory).filter(file => /^[\w-]+\.json$/.test(file)).sort(); } catch { return []; }
}
