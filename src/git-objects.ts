import { createHash } from "node:crypto";
import { command } from "./command";

export class GitObjects {
  constructor(readonly checkout: string, readonly repository?: string, readonly exec = command, readonly progress: (message: string) => Promise<void> = async () => {}) {}
  async ensureMergeInputs(head: string, base: string): Promise<void> {
    const options = { cwd: this.checkout, timeout: 600_000, env: { GIT_NO_LAZY_FETCH: "1" } };
    const ancestor = (await this.exec(["git", "merge-base", head, base], options)).trim();
    const objects = new Set<string>();
    for (const tip of [head, base]) {
      const changes = (await this.exec(["git", "diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z", ancestor, tip], options)).split("\0");
      for (let i = 0; i + 1 < changes.length; i += 2) {
        const fields = changes[i].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [A-Z]$/);
        if (!fields) throw new Error("Could not identify the merge's Git objects");
        for (const [mode, oid] of [[fields[1], fields[3]], [fields[2], fields[4]]]) if (mode !== "160000" && !/^0+$/.test(oid)) objects.add(oid);
      }
    }
    if (!objects.size) return;
    const missing = async (oids: string[]) => {
      const output = await this.exec(["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"], { ...options, input: oids.join("\n") + "\n" });
      return output.trim().split("\n").filter(line => line.endsWith(" missing")).map(line => line.split(" ")[0]);
    };
    const absent = await missing([...objects]);
    let recovered = 0; let bytes = 0;
    for (let i = 0; i < absent.length; i += 64) {
      const batch = absent.slice(i, i + 64);
      await this.progress(`Downloading merge inputs (${Math.min(i + batch.length, absent.length)}/${absent.length} missing Git objects)`);
      try { await this.exec(["git", "-c", "fetch.negotiationAlgorithm=noop", "fetch", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "origin", "--stdin"], { cwd: this.checkout, timeout: 600_000, input: batch.join("\n") + "\n" }); }
      catch (error) { if (!/not our ref|promisor remote|could not fetch|bad revision|did not send all necessary objects/i.test(String(error))) throw error; }
      for (const oid of await missing(batch)) {
        if (!this.repository || !/^[\w.-]+\/[\w.-]+$/.test(this.repository) || ++recovered > 128) throw new Error("Git object recovery exceeded its bounded allowance");
        const blob = JSON.parse(await this.exec(["gh", "api", `repos/${this.repository}/git/blobs/${oid}`]));
        if (blob.sha !== oid || blob.encoding !== "base64" || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > 10 * 1024 * 1024 || typeof blob.content !== "string" || blob.content.length > 15 * 1024 * 1024) throw new Error("GitHub returned an invalid Git object");
        const content = Buffer.from(blob.content, "base64"); bytes += content.length;
        const hash = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
        if (content.length !== blob.size || hash !== oid || bytes > 64 * 1024 * 1024) throw new Error("Git object content did not match its expected identity or recovery limit");
        const stored = (await this.exec(["git", "hash-object", "-w", "--no-filters", "--stdin"], { cwd: this.checkout, input: content })).trim();
        if (stored !== oid) throw new Error("Git did not confirm the recovered object's identity");
      }
    }
    if ((await missing([...objects])).length) throw new Error("Merge inputs are still missing after Git object recovery");
  }
}
