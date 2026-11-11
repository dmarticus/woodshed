import { Database } from "bun:sqlite";

type Shadow = { job: string; choice: string; confidence: number; wouldSkip: boolean; costUSD: number };
type Outcome = { job: string; route: string };
export type ShadowReport = {
  compared: number; pending: number;
  matrix: { [jev: string]: { [investigation: string]: number } };
  skips: { total: number; safe: number; unsafe: { number: number; job: string; jev: string; investigation: string; confidence: number }[] };
  investigationUSD: { total: number; avoidable: number }; jevUSD: number;
};

// Compares each shadow verdict with the investigation that ran for the same job.
// A skip is safe only when the investigation also concluded wait or ready.
export function shadowReport(db: Database, since: string): ShadowReport {
  const rows = (kind: string) => db.query("SELECT number, data FROM audits WHERE kind = ? AND time >= ?").all(kind, since) as { number: number; data: string }[];
  const outcomes = new Map(rows("triage-outcome").map(r => { const o = JSON.parse(r.data) as Outcome; return [o.job, o.route] as const; }));
  const costs = new Map((db.query("SELECT id, data FROM runs WHERE id LIKE 'ws-triage-%'").all() as { id: string; data: string }[]).map(r => [r.id, JSON.parse(r.data).costUSD as number | null]));
  const report: ShadowReport = { compared: 0, pending: 0, matrix: {}, skips: { total: 0, safe: 0, unsafe: [] }, investigationUSD: { total: 0, avoidable: 0 }, jevUSD: 0 };
  for (const row of rows("jev-shadow")) {
    const shadow = JSON.parse(row.data) as Shadow;
    report.jevUSD += shadow.costUSD;
    const route = outcomes.get(shadow.job);
    if (!route) { report.pending++; continue; }
    report.compared++;
    (report.matrix[shadow.choice] ??= {})[route] = (report.matrix[shadow.choice][route] ?? 0) + 1;
    const cost = costs.get(shadow.job) ?? 0;
    report.investigationUSD.total += cost;
    if (!shadow.wouldSkip) continue;
    report.skips.total++;
    if (route === "wait" || route === "ready") { report.skips.safe++; report.investigationUSD.avoidable += cost; }
    else report.skips.unsafe.push({ number: row.number, job: shadow.job, jev: shadow.choice, investigation: route, confidence: shadow.confidence });
  }
  return report;
}

if (import.meta.main) {
  const [path = ".woodshed/state.sqlite", days = "7"] = process.argv.slice(2);
  const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
  const db = new Database(path, { readonly: true });
  try { console.log(JSON.stringify(shadowReport(db, since), null, 2)); } finally { db.close(); }
}
