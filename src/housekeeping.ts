import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { command } from "./command";
import type { Store } from "./store";
import { readUntrustedJSON, untrustedExists, type Sessions } from "./sessions";

// `sessions.release` hands an isolated agent's files back to the controller first, since the agent may have made them private.
export async function cleanArtifacts(dataDir: string, store: Store, now = Date.now(), exec = command, decisions?: { prune(): Promise<number> }, sessions?: Pick<Sessions, "release">): Promise<void> {
  if (decisions) await decisions.prune();
  const root = join(dataDir, "jobs");
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return;
  for (const record of store.all()) {
    if (record.snapshot.state !== "OPEN" && !record.closedAt) { record.closedAt = new Date(now).toISOString(); store.put(record); }
  }
  const protectedNames = new Set(store.all().flatMap(r => [r.job?.name, r.assessment?.sourceJob?.name]).filter(Boolean));
  for (const name of readdirSync(root)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || protectedNames.has(name)) continue;
    const directory = join(root, name);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== join(realpathSync(root), name)) continue;
    const artifactAge = now - lstatSync(directory).mtimeMs;
    const run = store.run(name);
    if (!run?.endedAt || ["running", "waiting", "budget"].includes(run.state)) continue;
    const record = store.get(run.number);
    if (!record) continue;
    const runtimePath = [join(directory, "worker", "runtime.json"), join(directory, "runtime.json")].find(untrustedExists);
    try { if (runtimePath && readUntrustedJSON(runtimePath).status === "working") continue; } catch { continue; }
    const checkout = join(directory, "checkout");
    if (existsSync(checkout)) {
      if (lstatSync(checkout).isSymbolicLink() || realpathSync(checkout) !== join(realpathSync(directory), "checkout")) continue;
      if (name.startsWith("ws-triage-") && !existsSync(join(checkout, ".git")) && readdirSync(checkout).length === 0) rmdirSync(checkout);
      else try {
        const tracked = (await exec(["git", "rev-parse", "--show-toplevel"], { cwd: checkout })).trim();
        if (realpathSync(tracked) !== realpathSync(checkout)) continue;
        // Superseded runs release their checkout once nothing unpublished remains; ignored build output and dependencies do not count.
        if ((await exec(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: checkout })).trim()) continue;
        if ((await exec(["git", "rev-list", "-1", "HEAD", "--not", "--remotes"], { cwd: checkout })).trim()) continue;
        const registered = (await exec(["git", "worktree", "list", "--porcelain"], { cwd: checkout })).split("\n").filter(line => line.startsWith("worktree ")).some(line => { try { return realpathSync(line.slice(9)) === realpathSync(checkout); } catch { return false; } });
        if (registered) {
          await sessions?.release(name);
          const common = (await exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout })).trim();
          await exec(["git", "--git-dir", common, "worktree", "remove", checkout], { cwd: dataDir });
        }
      } catch { continue; }
      if (existsSync(checkout)) continue;
      store.log(run.number, `Removed clean worktree for retained run ${name}`);
    }
    if (record.snapshot.state === "OPEN" || !record.closedAt || now - Date.parse(record.closedAt) < 7 * 86400000) continue;
    if (now - Date.parse(run.endedAt) >= 30 * 86400000 && artifactAge >= 30 * 86400000) {
      await sessions?.release(name);
      rmSync(directory, { recursive: true });
      store.log(run.number, `Removed expired run artifacts for ${name}; spend history retained`);
    }
  }
}

// herdr-core 0.1.19 `connect` relays outlive their SSH session when the Mac drops it (sleep, Wi-Fi), one per reconnect.
// A relay whose parent is no longer sshd has no client left, so stop it before hundreds accumulate.
export function reapOrphanedConnects(proc = "/proc", uid = process.getuid?.(), kill: (pid: number) => unknown = pid => process.kill(pid, "SIGTERM")): number {
  if (!existsSync(proc)) return 0;
  let reaped = 0;
  for (const pid of readdirSync(proc).filter(name => /^\d+$/.test(name))) {
    try {
      if (lstatSync(join(proc, pid)).uid !== uid) continue;
      const argv = readFileSync(join(proc, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (argv.length !== 2 || !/(^|\/)(herdr-core|hc)$/.test(argv[0]) || argv[1] !== "connect") continue;
      const parent = readFileSync(join(proc, pid, "stat"), "utf8").replace(/^.*\) /s, "").split(" ")[1];
      if (/^sshd/.test(readFileSync(join(proc, parent, "comm"), "utf8").trim())) continue;
      kill(Number(pid)); reaped++;
    } catch { /* The process exited while being inspected. */ }
  }
  return reaped;
}
