import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { command } from "./command";
import type { Store } from "./store";

export async function cleanArtifacts(dataDir: string, store: Store, now = Date.now(), exec = command, decisions?: { prune(): Promise<number> }): Promise<void> {
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
    if (!record || record.snapshot.state === "OPEN" || !record.closedAt || now - Date.parse(record.closedAt) < 7 * 86400000) continue;
    const runtimeFile = Bun.file(join(directory, "runtime.json"));
    if (await runtimeFile.exists()) {
      const runtime = await runtimeFile.json();
      if (["working", "blocked"].includes(runtime.status)) continue;
    }
    const checkout = join(directory, "checkout");
    if (existsSync(checkout)) {
      if (lstatSync(checkout).isSymbolicLink() || realpathSync(checkout) !== join(realpathSync(directory), "checkout")) continue;
      if (name.startsWith("ws-triage-") && !existsSync(join(checkout, ".git")) && readdirSync(checkout).length === 0) rmdirSync(checkout);
      else try {
        const tracked = (await exec(["git", "rev-parse", "--show-toplevel"], { cwd: checkout })).trim();
        if (realpathSync(tracked) !== realpathSync(checkout)) continue;
        if ((await exec(["git", "status", "--porcelain", "--untracked-files=all", "--ignored"], { cwd: checkout })).trim()) continue;
        const registered = (await exec(["git", "worktree", "list", "--porcelain"], { cwd: checkout })).split("\n").filter(line => line.startsWith("worktree ")).some(line => { try { return realpathSync(line.slice(9)) === realpathSync(checkout); } catch { return false; } });
        if (registered) {
          const common = (await exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout })).trim();
          await exec(["git", "--git-dir", common, "worktree", "remove", checkout], { cwd: dataDir });
        }
      } catch { continue; }
      if (existsSync(checkout)) continue;
      store.log(run.number, `Removed clean worktree for retained run ${name}`);
    }
    if (now - Date.parse(run.endedAt) >= 30 * 86400000 && artifactAge >= 30 * 86400000) {
      rmSync(directory, { recursive: true });
      store.log(run.number, `Removed expired run artifacts for ${name}; spend history retained`);
    }
  }
}
