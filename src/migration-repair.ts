import { lstatSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { command } from "./command";

export type MigrationRepair = { directory: string; app: string; baseTip: string; tip: string; files: { from: string; to: string }[]; references: string[] };
type Inputs = { head: string; base: string; ownedFiles: string[]; conflicts: string[] };
type Prepared = MigrationRepair & { contents: { path: string; content: string }[] };

const migrationName = /^([0-9]{4,})_([A-Za-z0-9_]+)$/;
const numberedFile = /\/migrations\/[0-9]{4,}_[A-Za-z0-9_]+\.py$/;

export class MigrationRepairer {
  constructor(readonly checkout: string) {}
  private git(...args: string[]): Promise<string> { return command(["git", ...args], { cwd: this.checkout }); }
  private async content(ref: string, path: string): Promise<string> { return this.git("show", `${ref}:${path}`); }
  private async tracked(ref: string): Promise<Set<string>> { return new Set((await this.git("ls-tree", "-r", "--name-only", "-z", ref)).split("\0").filter(Boolean)); }
  private async transform(input: unknown): Promise<{ app: string; files: { from: string; to: string; content: string }[] }> {
    const process = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../scripts/rebase-migrations.py")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    process.stdin.write(JSON.stringify(input)); process.stdin.end();
    const timer = setTimeout(() => process.kill(), 10000);
    try {
      const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      if (code !== 0) throw new Error(`Migration chain could not be rebased automatically: ${error.trim()}`);
      return JSON.parse(output);
    } finally { clearTimeout(timer); }
  }
  async prepare(plan: Inputs): Promise<Prepared[]> {
    const markers = plan.conflicts.filter(path => path.endsWith("/migrations/max_migration.txt"));
    if (!markers.length) return [];
    const ancestor = (await this.git("merge-base", plan.head, plan.base)).trim();
    const added = new Set((await this.git("diff", "--name-only", "--diff-filter=A", "-z", ancestor, plan.head)).split("\0").filter(Boolean));
    const baseFiles = await this.tracked(plan.base);
    const repairs: Prepared[] = [];
    const sharedContents = new Map<string, string>();
    const identifiers = new Map<string, string>();
    for (const marker of markers) {
      const directory = dirname(marker);
      const candidates = plan.ownedFiles.filter(path => dirname(path) === directory && numberedFile.test(path)).sort((a, b) => Number(basename(a).split("_")[0]) - Number(basename(b).split("_")[0]));
      if (!candidates.length) continue;
      if (candidates.some(path => !added.has(path) || baseFiles.has(path))) throw new Error("Automatic migration repair cannot rename or edit migrations already present on the base");
      const common = (await this.content(ancestor, marker)).trim();
      const baseTip = (await this.content(plan.base, marker)).trim();
      const branchTip = (await this.content(plan.head, marker)).trim();
      const baseNumber = migrationName.exec(baseTip);
      if (!migrationName.test(common) || !baseNumber || branchTip !== basename(candidates.at(-1)!, ".py") || !baseFiles.has(`${directory}/${baseTip}.py`) || !baseFiles.has(`${directory}/${common}.py`)) throw new Error("Migration tips do not identify one linear PR-added chain");
      const width = Math.max(baseNumber[1].length, 4);
      const sources = [];
      for (const [index, path] of candidates.entries()) {
        const oldName = basename(path, ".py"); const parts = migrationName.exec(oldName)!;
        const newName = `${String(Number(baseNumber[1]) + index + 1).padStart(width, "0")}_${parts[2]}`;
        const to = `${directory}/${newName}.py`;
        if (baseFiles.has(to)) throw new Error(`Migration rename would overwrite a base migration: ${to}`);
        sources.push({ from: path, to, oldName, newName, content: await this.content(plan.head, path) });
      }
      const transformed = await this.transform({ common, baseTip, sources });
      const renamed = new Map(sources.map(s => [s.oldName, s.newName]));
      for (const [from, to] of renamed) {
        if (identifiers.has(from) && identifiers.get(from) !== to) throw new Error("Migration identifiers are ambiguous across the affected apps");
        identifiers.set(from, to);
      }
      const references: string[] = [];
      const contents = transformed.files.map(f => ({ path: f.to, content: f.content }));
      for (const path of plan.ownedFiles) {
        if (candidates.includes(path) || path === marker || plan.conflicts.includes(path) || !await Bun.file(join(this.checkout, path)).exists()) continue;
        if (!lstatSync(join(this.checkout, path)).isFile()) continue;
        const before = sharedContents.get(path) ?? await Bun.file(join(this.checkout, path)).text();
        const after = before.replace(/\b[0-9]{4,}_[A-Za-z0-9_]+\b/g, name => renamed.get(name) ?? name);
        if (after !== before && numberedFile.test(path)) throw new Error("Cross-app migration references need additional graph validation before renumbering");
        if (after !== before) { references.push(path); sharedContents.set(path, after); contents.push({ path, content: after }); }
      }
      const tip = sources.at(-1)!.newName;
      contents.push({ path: marker, content: `${tip}\n` });
      repairs.push({ directory, app: transformed.app, baseTip, tip, files: transformed.files.map(f => ({ from: f.from, to: f.to })), references, contents });
    }
    for (const repair of repairs) for (const file of repair.contents) file.content = sharedContents.get(file.path) ?? file.content;
    return repairs;
  }
  async apply(repairs: Prepared[]): Promise<MigrationRepair[]> {
    for (const repair of repairs) {
      for (const file of repair.files) {
        const path = join(this.checkout, file.from);
        if (lstatSync(path).isSymbolicLink()) throw new Error("Migration source must not be a symbolic link");
      }
      for (const file of repair.files) unlinkSync(join(this.checkout, file.from));
      for (const file of repair.contents) await Bun.write(join(this.checkout, file.path), file.content);
      const paths = [...new Set([...repair.files.flatMap(f => [f.from, f.to]), ...repair.references, `${repair.directory}/max_migration.txt`])];
      await this.git("--literal-pathspecs", "add", "-A", "--", ...paths);
    }
    return repairs.map(({ contents, ...repair }) => repair);
  }
}
