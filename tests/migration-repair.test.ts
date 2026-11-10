import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { BranchUpdate } from "../src/branch-update";
import type { Snapshot } from "../src/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const migration = (parent: string, swappable = false) => `from django.db import migrations\n\nclass Migration(migrations.Migration):\n    dependencies = [("notes", "${parent}")${swappable ? ", migrations.swappable_dependency(settings.AUTH_USER_MODEL)" : ""}]\n    operations = [migrations.RunSQL("SELECT '${parent}'")]\n`;

async function fixture(options: { conflict?: boolean; historical?: boolean; dynamic?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "woodshed-migration-")); roots.push(root);
  const source = join(root, "source"); const origin = join(root, "origin.git"); const directory = join(root, "job"); const checkout = join(directory, "checkout");
  mkdirSync(directory);
  await command(["git", "init", "--bare", origin]); await command(["git", "init", "--initial-branch=main", source]);
  const git = (...args: string[]) => command(["git", ...args], { cwd: source });
  await git("config", "user.name", "Woodshed fixture"); await git("config", "user.email", "fixture@example.com"); await git("config", "commit.gpgSign", "false");
  const prefix = "app/migrations/";
  await Bun.write(join(source, prefix, "0001_initial.py"), "from django.db import migrations\nclass Migration(migrations.Migration):\n    dependencies = []\n    operations = []\n");
  await Bun.write(join(source, prefix, "max_migration.txt"), "0001_initial\n");
  await Bun.write(join(source, "views.py"), "original behavior\n");
  await git("add", "."); await git("commit", "-m", "chore: create fixture"); await git("branch", "feature");
  const baseMigration = migration("0001_initial");
  await Bun.write(join(source, prefix, "0002_billing.py"), baseMigration); await Bun.write(join(source, prefix, "max_migration.txt"), "0002_billing\n");
  await Bun.write(join(source, "views.py"), "base behavior\n");
  await git("add", "."); await git("commit", "-m", "chore: advance base"); const base = (await git("rev-parse", "HEAD")).trim();
  await git("remote", "add", "origin", origin); await git("push", "origin", "main"); await git("checkout", "feature");
  const first = options.dynamic ? migration("0001_initial").replace('[("notes", "0001_initial")]', '[("notes", "0001_initial"), extra_dependencies()]') : migration("0001_initial", true);
  await Bun.write(join(source, prefix, "0002_fields.py"), first); await Bun.write(join(source, prefix, "0003_backfill.py"), migration("0002_fields"));
  await Bun.write(join(source, prefix, "max_migration.txt"), "0003_backfill\n"); await Bun.write(join(source, "references.txt"), "notes.0002_fields\nnotes.0003_backfill\n");
  if (options.conflict !== false) await Bun.write(join(source, "views.py"), "feature behavior\n");
  if (options.historical) await Bun.write(join(source, prefix, "0001_initial.py"), "changed historical migration\n");
  await git("add", "."); await git("commit", "-m", "feat: add fixture migrations"); const head = (await git("rev-parse", "HEAD")).trim(); await git("push", "origin", "feature");
  await git("worktree", "add", "--detach", checkout, head);
  const pr = { number: 42, head, branch: "feature", base: "main", state: "OPEN", draft: false } as Snapshot;
  const update = new BranchUpdate(checkout, directory);
  return { root, prefix, checkout, directory, pr, update, head, base, first, baseMigration, remoteHead: async () => (await command(["git", "--git-dir", origin, "rev-parse", "feature"])).trim() };
}

test("rebases only PR-added migrations and references while preserving operations and base history", async () => {
  const f = await fixture(); const plan = await f.update.prepare(f.pr, "fixture");
  expect(plan.conflicts).toEqual(["views.py"]);
  expect(plan.migrationRepairs?.[0].files).toEqual([{ from: "app/migrations/0002_fields.py", to: "app/migrations/0003_fields.py" }, { from: "app/migrations/0003_backfill.py", to: "app/migrations/0004_backfill.py" }]);
  expect(await Bun.file(join(f.checkout, f.prefix, "0003_fields.py")).text()).toBe(f.first.replace('"0001_initial"', '"0002_billing"'));
  expect(await Bun.file(join(f.checkout, f.prefix, "0004_backfill.py")).text()).toBe(migration("0002_fields").replace('("notes", "0002_fields")', '("notes", "0003_fields")'));
  expect(await Bun.file(join(f.checkout, f.prefix, "0002_billing.py")).text()).toBe(f.baseMigration);
  expect(await Bun.file(join(f.checkout, "references.txt")).text()).toBe("notes.0003_fields\nnotes.0004_backfill\n");
  expect(await Bun.file(join(f.checkout, f.prefix, "max_migration.txt")).text()).toBe("0004_backfill\n");
  await Bun.write(join(f.checkout, "views.py"), "base behavior\nfeature behavior\n");
  const result = await f.update.finish(plan, f.pr);
  expect(await f.remoteHead()).toBe(result.commit);
  const parents = (await command(["git", "rev-list", "--parents", "-n", "1", result.commit], { cwd: f.checkout })).trim().split(" ").slice(1);
  expect(parents).toEqual([f.head, f.base]);
});

test("a migration-only conflict is resolved without an agent and remains resumable", async () => {
  const f = await fixture({ conflict: false }); const plan = await f.update.prepare(f.pr, "fixture");
  expect(plan.conflicts).toEqual([]); await f.update.repairMigrations(plan);
  const first = await f.update.finish(plan, f.pr);
  const second = await f.update.finish(await f.update.load(), { ...f.pr, head: first.commit });
  expect(first.commit).toBe(second.commit);
});

test.each(["historical", "dynamic"])("does not mechanically rewrite an unsupported %s migration graph", async option => {
  const f = await fixture({ [option]: true });
  await expect(f.update.prepare(f.pr, "fixture")).rejects.toThrow(option === "historical" ? "already present on the base" : "Dynamic migration dependencies");
  expect(await f.remoteHead()).toBe(f.head);
  expect(await Bun.file(join(f.checkout, f.prefix, "0002_fields.py")).exists()).toBe(true);
});

test.each(["0003_fields.py", "0002_billing.py"])("rejects agent edits to the mechanically prepared %s", async filename => {
  const f = await fixture(); const plan = await f.update.prepare(f.pr, "fixture");
  await Bun.write(join(f.checkout, "views.py"), "base behavior\nfeature behavior\n");
  await Bun.write(join(f.checkout, f.prefix, filename), "changed migration operations\n");
  await expect(f.update.finish(plan, f.pr)).rejects.toThrow("outside the conflict set");
  expect(await f.remoteHead()).toBe(f.head);
});
