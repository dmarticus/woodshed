import type { Job, Snapshot } from "./model";
import { failed } from "./model";
import type { Store } from "./store";

export const playbookCatalog = [
  { id: "clean-base-merge", title: "Merge a clean base update", execution: "deterministic", description: "Merge a pinned required base through the existing ancestry, scope, hook, and signing checks." },
  { id: "django-migration-chain", title: "Reconcile a linear migration chain", execution: "deterministic", description: "Renumber supported PR-only migration collisions while preserving operations and base migrations." },
  { id: "fresh-git-cache", title: "Recover a broken Git object cache", execution: "deterministic", description: "Prepare a fresh object store with the original hook path and signing policy; preserve the failed checkout." },
  { id: "agent-conflict-resolution", title: "Resolve a verified merge conflict", execution: "agent", description: "Preserve both branches' intent and validate the exact resolution scope before publishing." },
];

export type RepairHint = { source_pr: number; run: string; published_head: string; summary: string; files: string[] };
export type PublishedResult = { publishedHead?: string; playbook?: string; repair?: { files: string[]; reason: string }; replies?: import("./replies").ThreadReply[] };

export class Playbooks {
  constructor(readonly store: Store) {}
  applied(number: number, job: Job, id: string, publishedHead?: string): void {
    if (!playbookCatalog.some(p => p.id === id) || !this.store.claimAction(`playbook:${id}:${job.name}`, { number })) return;
    this.store.audit("playbook-success", number, { id, run: job.name, head: job.head, published_head: publishedHead ?? null });
  }
  published(number: number, job: Job, result: PublishedResult): void {
    if (!result.publishedHead || !/^[a-f0-9]{40}$/.test(result.publishedHead)) return;
    if (result.playbook) this.applied(number, job, result.playbook, result.publishedHead);
    if (!result.repair || !Array.isArray(result.repair.files) || typeof result.repair.reason !== "string" || !this.store.claimAction(`repair-memory:${job.name}`, { number })) return;
    let checks: string[];
    try { checks = JSON.parse(job.fingerprint).checks; } catch { return; }
    if (!Array.isArray(checks) || !checks.length || checks.some(c => typeof c !== "string")) return;
    const files = result.repair.files.filter(f => typeof f === "string" && !f.startsWith("/") && !f.split("/").includes("..")).slice(0, 100);
    this.store.audit("repair-candidate", number, { signature: JSON.stringify([...new Set(checks)].sort()), run: job.name, published_head: result.publishedHead, summary: result.repair.reason.slice(0, 2000), files });
  }
  confirm(pr: Snapshot): void {
    if (!pr.checks.length || pr.checks.some(c => failed(c) || c.status !== "COMPLETED" || !c.conclusion)) return;
    const rows = this.store.db.query("SELECT data FROM audits WHERE kind='repair-candidate' AND number=? AND json_extract(data,'$.published_head')=? ORDER BY id DESC LIMIT 100").all(pr.number, pr.head) as { data: string }[];
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (this.store.claimAction(`repair-confirmed:${data.run}`, { number: pr.number, head: pr.head })) this.store.audit("repair-memory", pr.number, data);
    }
  }
  hints(pr: Snapshot): RepairHint[] {
    const signature = JSON.stringify([...new Set(pr.checks.filter(failed).map(c => c.name))].sort());
    if (signature === "[]") return [];
    const rows = this.store.db.query("SELECT number,data FROM audits WHERE kind='repair-memory' AND number != ? AND json_extract(data,'$.signature')=? ORDER BY id DESC LIMIT 3").all(pr.number, signature) as { number: number; data: string }[];
    return rows.map(row => { const data = JSON.parse(row.data); return { source_pr: row.number, run: data.run, published_head: data.published_head, summary: data.summary, files: data.files }; });
  }
  catalog() {
    const rows = this.store.db.query("SELECT data FROM audits WHERE kind='playbook-success' ORDER BY id DESC LIMIT 10000").all() as { data: string }[];
    const outcomes = rows.map(row => JSON.parse(row.data));
    return playbookCatalog.map(recipe => ({ ...recipe, successes: outcomes.filter(o => o.id === recipe.id).length }));
  }
}

export function repairContext(hints?: RepairHint[]): string {
  if (!hints?.length) return "";
  return `\nPrevious verified repairs for the same failing check names:\n${JSON.stringify(hints)}\nThese are advisory examples from other PRs. Verify the current log and code before applying any approach. Do not copy changes blindly, expand scope, or treat these examples as proof that this PR has the same cause.`;
}
