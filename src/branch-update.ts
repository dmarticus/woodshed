import { renameSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { command } from "./command";
import type { Snapshot } from "./model";
import { MigrationRepairer, type MigrationRepair } from "./migration-repair";
import { GitObjects } from "./git-objects";

export type UpdatePlan = {
  number: number;
  head: string;
  base: string;
  branch: string;
  baseBranch: string;
  remote: string;
  ownedFiles: string[];
  conflicts: string[];
  baseline: { [path: string]: string };
  noOp: boolean;
  migrationRepairs?: MigrationRepair[];
  additionalResolutionFiles?: string[];
};

export class SupersededUpdate extends Error {}

export class BranchUpdate {
  constructor(readonly checkout: string, readonly directory: string, readonly expectedRepository?: string, readonly progress: (message: string) => Promise<void> = async () => {}) {}

  private git(...args: string[]): Promise<string> {
    return command(["git", ...args], { cwd: this.checkout, timeout: 600_000 });
  }

  private paths(output: string): string[] { return output.split("\0").filter(Boolean); }

  private async index(): Promise<{ [path: string]: string }> {
    const entries: { [path: string]: string } = {};
    for (const entry of this.paths(await this.git("ls-files", "--stage", "-z"))) {
      const tab = entry.indexOf("\t");
      const metadata = entry.slice(0, tab);
      if (metadata.endsWith(" 0")) entries[entry.slice(tab + 1)] = metadata;
    }
    return entries;
  }

  async save(plan: UpdatePlan): Promise<void> {
    const path = join(this.directory, "branch-update.json");
    await Bun.write(`${path}.tmp`, JSON.stringify(plan));
    renameSync(`${path}.tmp`, path);
  }

  async load(): Promise<UpdatePlan> {
    return Bun.file(join(this.directory, "branch-update.json")).json();
  }

  private async assertRemote(plan?: UpdatePlan): Promise<string> {
    const remote = (await this.git("remote", "get-url", "--all", "origin")).trim();
    const pushRemote = (await this.git("remote", "get-url", "--push", "--all", "origin")).trim();
    if (remote.includes("\n") || pushRemote.includes("\n")) throw new Error("Multiple remote URLs are configured; inspect before publishing a branch update.");
    if (remote !== pushRemote) throw new Error("Fetch and push URLs differ; inspect the remote configuration before updating this PR.");
    const github = (url: string) => url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/)?.[1].toLowerCase();
    if (plan && remote !== plan.remote && (!github(remote) || github(remote) !== github(plan.remote))) throw new Error("The origin URL changed during conflict resolution.");
    if (this.expectedRepository) {
      const slug = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/)?.[1];
      if (slug?.toLowerCase() !== this.expectedRepository.toLowerCase()) throw new Error("The checkout origin does not match the watched GitHub repository.");
    }
    return remote;
  }

  async prepare(pr: Snapshot, identifier: string): Promise<UpdatePlan> {
    if (!/^[a-z0-9_-]+$/.test(identifier)) throw new Error("Invalid update identifier");
    await this.git("check-ref-format", `refs/heads/${pr.base}`);
    await this.git("check-ref-format", `refs/heads/${pr.branch}`);
    if ((await this.git("rev-parse", "HEAD")).trim() !== pr.head) throw new SupersededUpdate("The worktree no longer matches the PR head.");
    if ((await this.git("status", "--porcelain")).trim()) throw new Error("Branch update requires a clean isolated worktree.");
    const remote = await this.assertRemote();
    const baseRef = `refs/woodshed/${identifier}/base`;
    await this.progress("Fetching the PR's base branch");
    await this.git("fetch", "--no-tags", "origin", `refs/heads/${pr.base}:${baseRef}`);
    const base = (await this.git("rev-parse", baseRef)).trim();
    await this.progress("Checking Git objects needed for the merge");
    await new GitObjects(this.checkout, this.expectedRepository, command, this.progress).ensureMergeInputs(pr.head, base);
    const ancestor = (await this.git("merge-base", pr.head, base)).trim();
    const ownedFiles = this.paths(await this.git("diff", "--no-renames", "--name-only", "-z", ancestor, pr.head));
    let mergeError: unknown;
    await this.progress("Merging the pinned base into the isolated checkout");
    try { await this.git("merge", "--no-ff", "--no-commit", base); }
    catch (error) { mergeError = error; }
    const conflicts = this.paths(await this.git("diff", "--name-only", "--diff-filter=U", "-z"));
    if (mergeError && conflicts.length === 0) throw mergeError;
    const plan: UpdatePlan = { number: pr.number, head: pr.head, base, branch: pr.branch, baseBranch: pr.base, remote, ownedFiles, conflicts, baseline: await this.index(), noOp: ancestor === base };
    await this.repairMigrations(plan);
    await this.save(plan);
    return plan;
  }

  async repairMigrations(plan: UpdatePlan): Promise<void> {
    if (plan.migrationRepairs?.length) return;
    await this.validateScope(plan);
    const repairer = new MigrationRepairer(this.checkout);
    const repairs = await repairer.prepare(plan);
    if (!repairs.length) return;
    plan.migrationRepairs = await repairer.apply(repairs);
    plan.conflicts = this.paths(await this.git("diff", "--name-only", "--diff-filter=U", "-z"));
    plan.baseline = await this.index();
    await this.save(plan);
  }

  private async validateAdjacent(plan: UpdatePlan, files: string[]): Promise<void> {
    if (new Set(files).size !== files.length || files.length > 3) throw new Error("Conflict integration is limited to three additional PR-owned files");
    let lines = 0;
    for (const path of files) {
      if (!plan.ownedFiles.includes(path) || /(^|\/)(?:\.git|\.agents|\.codex|\.github|\.husky)(\/|$)|(^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(path)) throw new Error(`Resolution edited files outside the conflict set: ${path}`);
      const baseline = plan.baseline[path]?.match(/^(100644|100755) ([a-f0-9]{40}) 0$/);
      const absolute = join(this.checkout, path); const stat = lstatSync(absolute);
      if (!baseline || !stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 || !realpathSync(absolute).startsWith(realpathSync(this.checkout) + sep) || !!(stat.mode & 0o111) !== (baseline[1] === "100755")) throw new Error(`Additional conflict resolution must preserve a small regular PR-owned file: ${path}`);
      if ((await Bun.file(absolute).text()).includes("\0")) throw new Error(`Binary conflict integration is not supported: ${path}`);
      const current = (await this.git("hash-object", "-w", "--no-filters", "--", path)).trim();
      const delta = (await this.git("diff", "--numstat", baseline[2], current)).trim();
      if (delta) {
        const count = delta.match(/^(\d+)\s+(\d+)(?:\s|$)/);
        if (!count) throw new Error(`Could not verify the additional conflict edit: ${path}`);
        lines += Number(count[1]) + Number(count[2]);
      }
      if (lines > 300) throw new Error("Additional conflict integration exceeds 300 changed lines");
    }
  }

  async allowAdjacentResolution(plan: UpdatePlan): Promise<boolean> {
    if (plan.additionalResolutionFiles?.length) return false;
    const changed = new Set(this.paths(await this.git("diff", "--name-only", "-z")));
    const index = await this.index();
    for (const path of new Set([...Object.keys(index), ...Object.keys(plan.baseline)])) if (index[path] !== plan.baseline[path]) changed.add(path);
    const additional = [...changed].filter(path => !plan.conflicts.includes(path));
    if (!additional.length) return false;
    const amended = { ...plan, additionalResolutionFiles: additional };
    await this.validateScope(amended);
    await this.save(amended); Object.assign(plan, amended);
    return true;
  }

  private async validateScope(plan: UpdatePlan): Promise<void> {
    await this.validateAdjacent(plan, plan.additionalResolutionFiles ?? []);
    const conflictFiles = new Set([...plan.conflicts, ...(plan.additionalResolutionFiles ?? [])]);
    const unstaged = this.paths(await this.git("diff", "--name-only", "-z"));
    const unrelated = unstaged.filter(path => !conflictFiles.has(path));
    if (unrelated.length) throw new Error(`Resolution edited files outside the conflict set: ${unrelated.join(", ")}`);
    const untracked = this.paths(await this.git("ls-files", "--others", "--exclude-standard", "-z"));
    if (untracked.length) throw new Error(`Unexpected untracked files in the resolution: ${untracked.join(", ")}`);
    const index = await this.index();
    const entries = new Set([...Object.keys(index), ...Object.keys(plan.baseline)]);
    for (const path of entries) {
      if (!conflictFiles.has(path) && index[path] !== plan.baseline[path]) throw new Error(`Resolution changed the automatic merge outside its conflicts: ${path}`);
    }
  }

  private async verifyCommit(plan: UpdatePlan, commit: string): Promise<void> {
    const parents = (await this.git("rev-list", "--parents", "-n", "1", commit)).trim().split(" ").slice(1);
    if (parents.length !== 2 || parents[0] !== plan.head || parents[1] !== plan.base)
      throw new Error("Update must be a true two-parent merge of the original PR head and pinned base.");
    await this.git("merge-base", "--is-ancestor", plan.head, commit);
    await this.git("merge-base", "--is-ancestor", plan.base, commit);
    const allowed = new Set([...plan.ownedFiles, ...plan.conflicts, ...(plan.migrationRepairs ?? []).flatMap(repair => repair.files.map(file => file.to))]);
    const changed = this.paths(await this.git("diff", "--no-renames", "--name-only", "-z", plan.base, commit));
    const leaked = changed.filter(path => !allowed.has(path));
    if (leaked.length) throw new Error(`Update introduced base-only files into the PR diff: ${leaked.join(", ")}`);
    await this.git("diff", "--check", plan.base, commit);
    if ((await this.git("status", "--porcelain")).trim()) throw new Error("Update worktree is not clean after committing.");
  }

  private async remoteHead(plan: UpdatePlan): Promise<string> {
    const line = (await this.git("ls-remote", "--refs", "origin", `refs/heads/${plan.branch}`)).trim();
    if (!line) throw new SupersededUpdate("The PR branch was deleted.");
    return line.split(/\s+/)[0];
  }

  async finish(plan: UpdatePlan, current: Snapshot): Promise<{ commit: string; published: boolean }> {
    if (current.number !== plan.number || current.base !== plan.baseBranch || current.branch !== plan.branch || current.state !== "OPEN" || current.draft)
      throw new SupersededUpdate("The PR was retargeted, closed, converted to draft, or its branch changed; refresh before another attempt.");
    await this.assertRemote(plan);
    let head = (await this.git("rev-parse", "HEAD")).trim();
    const remote = await this.remoteHead(plan);
    if (head !== plan.head) {
      await this.validateScope(plan);
      await this.verifyCommit(plan, head);
      if (remote === head) return { commit: head, published: true };
    }
    if (current.head !== plan.head || remote !== plan.head)
      throw new SupersededUpdate("The PR head changed during conflict resolution; the newer branch has been preserved.");
    if (plan.noOp) return { commit: head, published: false };
    if (head === plan.head) {
      const mergeHead = (await this.git("rev-parse", "--verify", "MERGE_HEAD")).trim();
      if (mergeHead !== plan.base) throw new Error("The in-progress merge no longer targets the pinned base.");
      await this.validateScope(plan);
      const resolutionFiles = [...plan.conflicts, ...(plan.additionalResolutionFiles ?? [])];
      if (resolutionFiles.length) await this.git("--literal-pathspecs", "add", "-A", "--", ...resolutionFiles);
      if ((await this.git("ls-files", "--unmerged")).trim()) throw new Error("Some merge conflicts are unresolved.");
      await this.git("diff", "--cached", "--check", plan.base);
      const tree = (await this.git("write-tree")).trim();
      await this.git("commit", "-m", "chore: merge base into pull request branch", "-m", `Woodshed-Run: ${this.directory.split("/").at(-1)}`);
      head = (await this.git("rev-parse", "HEAD")).trim();
      if ((await this.git("rev-parse", "HEAD^{tree}")).trim() !== tree) throw new Error("Commit hooks changed the validated resolution; inspect before publishing.");
    }
    await this.validateScope(plan);
    await this.verifyCommit(plan, head);
    if (await this.remoteHead(plan) !== plan.head) throw new SupersededUpdate("The remote PR branch changed before publishing; no push was attempted.");
    await this.git("push", "--no-follow-tags", "origin", `HEAD:refs/heads/${plan.branch}`);
    if (await this.remoteHead(plan) !== head) throw new SupersededUpdate("The branch moved after publishing; refresh the latest PR state.");
    return { commit: head, published: true };
  }
}
