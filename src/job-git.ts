import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

// When agents run as another user they can rewrite anything in their checkout, including the `.git` file
// that tells Git where its repository is. A checkout pointing at a repository the agent made could run
// its hooks or fsmonitor as the controller. So the controller's Git commands in a job checkout name the
// worktree's admin directory themselves, found in repositories the agent cannot write, and never run hooks
// or an fsmonitor from a tree the agent edited.
let isolated: { jobs: string; repositories: string[]; uid: number } | undefined;

export function isolateJobGit(dataDir: string, repositories: string[], uid = process.getuid?.() ?? 0): void {
  isolated = { jobs: realpathSync(join(dataDir, "jobs")), repositories, uid };
}
export function resetJobGit(): void { isolated = undefined; }

export function jobGitEnvironment(cwd?: string): { env: { [key: string]: string }; config: [string, string][] } | undefined {
  if (!isolated || !cwd) return undefined;
  let real: string;
  try { real = realpathSync(cwd); } catch { return undefined; }
  if (!real.startsWith(isolated.jobs + sep)) return undefined;
  const [name, part] = real.slice(isolated.jobs.length + 1).split(sep);
  if (part !== "checkout") return undefined;
  const checkout = join(isolated.jobs, name, "checkout");
  if (real !== checkout) throw new Error("Controller Git commands must run at the root of a job checkout");
  const pointer = join(checkout, ".git");
  for (const common of [join(isolated.jobs, name, "repository.git"), ...isolated.repositories]) {
    let entries: string[];
    try { entries = readdirSync(join(common, "worktrees")); } catch { continue; }
    for (const entry of entries) {
      const admin = join(common, "worktrees", entry);
      try {
        if (lstatSync(admin).uid !== isolated.uid || lstatSync(join(admin, "gitdir")).uid !== isolated.uid) continue;
        if (readFileSync(join(admin, "gitdir"), "utf8").trim() !== pointer) continue;
      } catch { continue; }
      return { env: { GIT_DIR: admin, GIT_WORK_TREE: checkout }, config: [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["submodule.recurse", "false"]] };
    }
  }
  throw new Error(`No controller-owned Git directory for ${checkout}`);
}
