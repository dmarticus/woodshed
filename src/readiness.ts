import { createHash } from "node:crypto";
import { decide, failed, type Config, type Record, type Run } from "./model";
import { stackBlock } from "./stack";

export function readiness(record: Record, config: Config, records: Record[], runs: Run[], now = Date.now()) {
  const pr = record.snapshot;
  const observed = record.observedAt ? Date.parse(record.observedAt) : NaN;
  const ttl = Math.max(180_000, Math.min(300_000, config.pollSeconds * 2000 + 30_000));
  const fresh = Number.isFinite(observed) && observed <= now + 1000 && now - observed <= ttl;
  const policy = decide(pr, { ...record, job: undefined, humanHead: undefined, assessment: undefined });
  const dependency = stackBlock(pr, records, true);
  const reasons = [!fresh ? "GitHub state needs a fresh check" : "", policy.kind !== "ready" ? policy.reason : "", dependency?.reason ?? "", record.job ? "A maintenance run is still attached" : "", record.decision.kind === "human" ? record.decision.question ?? record.decision.reason : "", record.recovery?.retryAt ? "Run recovery is pending" : "", record.assessment && !record.assessment.result ? "Independent investigation is pending" : "", record.lastError ? "The latest GitHub refresh did not complete" : ""].filter(Boolean);
  const evidence = {
    repository: config.repository, number: pr.number, head: pr.head, base: pr.base, base_head: pr.baseHead ?? null,
    review_decision: pr.reviewDecision, mergeable: pr.mergeable, merge_state: pr.mergeStateStatus,
    checks: [...pr.checks].map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion, required: c.required ?? null, url: c.url })).sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url)),
    unresolved_threads: pr.threads.map(t => t.id).sort(),
    reviews: pr.reviews.map(r => ({ author: r.author, state: r.state, head: r.head, submitted_at: r.submittedAt })),
    blocked_by: dependency ? { number: dependency.number, head: dependency.head } : null,
  };
  const id = createHash("sha256").update(JSON.stringify({ evidence, observed_at: record.observedAt ?? null })).digest("hex");
  return {
    id, head: pr.head, ready: reasons.length === 0, fresh, observed_at: record.observedAt ?? null, expires_at: fresh ? new Date(observed + ttl).toISOString() : null,
    reasons, evidence,
    summary: { passed: pr.checks.filter(c => c.conclusion === "SUCCESS").length, failed: pr.checks.filter(failed).length, pending: pr.checks.filter(c => c.status !== "COMPLETED" || !c.conclusion).length, skipped: pr.checks.filter(c => c.conclusion === "SKIPPED").length, open_threads: pr.threads.length, approval: pr.reviewDecision },
    recent_runs: runs.filter(r => r.number === pr.number && r.state === "succeeded" && !r.id.startsWith("ws-triage-") && !r.id.startsWith("jev-")).slice(0, 3).map(r => ({ id: r.id, summary: r.summary, ended_at: r.endedAt ?? null })),
    merge_authorization: false,
  };
}

export function readinessSummary(report: ReturnType<typeof readiness>) {
  const { evidence, ...summary } = report;
  return { ...summary, evidence_uri: `woodshed://prs/${evidence.number}/readiness` };
}
