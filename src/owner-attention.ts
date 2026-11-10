import { currentChecks, failed, type AssessmentResult, type Decision, type Snapshot } from "./model";

// Owner decisions follow their blocker, not GitHub's volatile updatedAt/checks.
export type OwnerAttention = {
  head: string; decision: Decision; threads: Snapshot["threads"]; checks: string[];
  conflict: boolean; persistent: boolean;
};
export function ownerAttention(pr: Snapshot, result: AssessmentResult, decision: Decision): OwnerAttention {
  const ids = result.review_threads?.filter(t => t.status === "needs_repair").map(t => t.id);
  const threads = result.category === "review" ? pr.threads.filter(t => !ids || ids.includes(t.id)) : [];
  const checks = result.category === "checks" ? currentChecks(pr.checks).filter(failed).map(c => c.name) : [];
  const conflict = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND";
  return { head: pr.head, decision, threads, checks, conflict,
    persistent: !threads.length && !checks.length && !conflict || ["operations", "product", "visual", "internal"].includes(result.category) };
}
export function attentionStillNeeded(attention: OwnerAttention, pr: Snapshot): boolean {
  if (attention.head !== pr.head || pr.state !== "OPEN" || pr.draft) return false;
  if (attention.persistent) return true;
  // A reply/edit on the relevant thread deserves a fresh investigation.
  if (attention.threads.length && attention.threads.every(original => {
    const current = pr.threads.find(t => t.id === original.id);
    return current && JSON.stringify(current) === JSON.stringify(original);
  })) return true;
  // Missing checks aren't evidence of resolution. An actual rerun can supersede
  // a CI-only escalation, independently of unrelated matrix check progress.
  if (attention.checks.some(name => !currentChecks(pr.checks).some(c => c.name === name) || currentChecks(pr.checks).some(c => c.name === name && failed(c)))) return true;
  return attention.conflict && (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND");
}
