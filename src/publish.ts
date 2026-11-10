import { renameSync } from "node:fs";
import { join } from "node:path";
import { command } from "./command";
import { SupersededUpdate } from "./branch-update";
import type { Snapshot } from "./model";

type Plan = { head: string; branch: string; base: string; remote: string; tree: string; files: string[] };

export class Publisher {
  constructor(readonly checkout: string, readonly directory: string, readonly repository?: string) {}
  private git(...args: string[]): Promise<string> { return command(["git", ...args], { cwd: this.checkout, timeout: 600_000 }); }
  async changedFiles(): Promise<string[]> {
    return [...new Set((await this.git("diff", "--name-only", "-z", "HEAD") + await this.git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean))].sort();
  }
  private async remote(): Promise<string> {
    const fetch = (await this.git("remote", "get-url", "--all", "origin")).trim();
    const push = (await this.git("remote", "get-url", "--push", "--all", "origin")).trim();
    if (fetch !== push || fetch.includes("\n")) throw new Error("Origin fetch and push destinations must match");
    if (this.repository) {
      const slug = fetch.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/)?.[1];
      if (slug?.toLowerCase() !== this.repository.toLowerCase()) throw new Error("Origin does not match the watched repository");
    }
    return fetch;
  }
  private async remoteHead(branch: string): Promise<string> {
    return (await this.git("ls-remote", "--refs", "origin", `refs/heads/${branch}`)).trim().split(/\s+/)[0];
  }
  private async verify(plan: Plan, commit: string): Promise<void> {
    const parents = (await this.git("rev-list", "--parents", "-n", "1", commit)).trim().split(" ").slice(1);
    if (parents.length !== 1 || parents[0] !== plan.head || (await this.git("rev-parse", `${commit}^{tree}`)).trim() !== plan.tree) throw new Error("Published repair must contain exactly the prepared tree on the original PR head");
    if ((await this.git("status", "--porcelain")).trim()) throw new Error("Repair checkout changed during publication");
  }
  async publish(head: string, current: Snapshot, files: unknown): Promise<string> {
    await this.git("check-ref-format", `refs/heads/${current.branch}`);
    if (current.state !== "OPEN" || current.draft) throw new SupersededUpdate("The PR is closed or a draft");
    const remote = await this.remote();
    const path = join(this.directory, "repair-publish.json");
    let plan: Plan | undefined = await Bun.file(path).exists() ? await Bun.file(path).json() : undefined;
    let commit = (await this.git("rev-parse", "HEAD")).trim();
    if (plan && (plan.head !== head || plan.branch !== current.branch || plan.base !== current.base || plan.remote !== remote)) throw new SupersededUpdate("PR target changed since publication was prepared");
    if (plan && commit !== head) {
      await this.verify(plan, commit);
      const remoteHead = await this.remoteHead(plan.branch);
      if (remoteHead === commit && current.head === commit) return commit;
      if (remoteHead !== head || current.head !== head) throw new SupersededUpdate("PR branch changed; newer work was preserved");
    } else {
      if (commit !== head || current.head !== head || await this.remoteHead(current.branch) !== head) throw new SupersededUpdate("PR branch changed; refresh before publishing");
      if (!Array.isArray(files) || files.length === 0 || files.length > 10000 || files.some(f => typeof f !== "string" || !f || f.startsWith("/") || f.split("/").some(p => ["..", ".git"].includes(p)))) throw new Error("Agent must declare the exact relative files to publish");
      const actual = await this.changedFiles();
      const declared = [...new Set(files as string[])].sort();
      if (!actual.length || JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error("Changed files do not match the agent's declared repair scope");
      await this.git("--literal-pathspecs", "add", "-A", "--", ...declared);
      await this.git("diff", "--cached", "--check");
      plan = { head, branch: current.branch, base: current.base, remote, files: declared, tree: (await this.git("write-tree")).trim() };
      await Bun.write(`${path}.tmp`, JSON.stringify(plan)); renameSync(`${path}.tmp`, path);
      await this.git("commit", "-m", "fix: address PR review and CI feedback", "-m", `Woodshed-Run: ${this.directory.split("/").at(-1)}`);
      commit = (await this.git("rev-parse", "HEAD")).trim();
      await this.verify(plan, commit);
    }
    await this.git("push", "origin", `${commit}:refs/heads/${plan.branch}`);
    if (await this.remoteHead(plan.branch) !== commit) throw new Error("The published commit was not confirmed on the PR branch");
    return commit;
  }
}
