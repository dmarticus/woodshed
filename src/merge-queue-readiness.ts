import { decide, type Config, type Record, type Run } from "./model";
import { readiness } from "./readiness";
import { parentPR } from "./stack";

export function queueSubmission(record: Record, config: Config, records: Record[], runs: Run[], now = Date.now(), canMaintain?: (pr: Record["snapshot"]) => boolean) {
  const scope: Record[] = []; const seen = new Set<number>(); let member: Record | undefined = record;
  while (member && !seen.has(member.snapshot.number)) { scope.push(member); seen.add(member.snapshot.number); member = parentPR(member.snapshot, records); }
  let reason: string | undefined;
  if (scope.length > 50) reason = "Submit at most 50 PRs in one stack.";
  if (member) reason = "The PR stack contains a cycle. Refresh its branches before submitting.";
  if (!record.mergeQueue || record.mergeQueue.error) reason ??= "Refresh Trunk queue status before submitting.";
  if (record.mergeQueue?.active) reason ??= "This PR has already been submitted to Trunk.";
  if ((record.snapshot.stack?.position ?? 1) > scope.length) reason ??= "Watch the PRs below this one before submitting the stack.";
  for (const item of scope) {
    if (canMaintain && !canMaintain(item.snapshot)) reason ??= "Woodshed only submits your own PRs to the merge queue.";
    if (item.snapshot.draft || item.snapshot.state !== "OPEN") reason ??= `PR #${item.snapshot.number} must be open and ready for review.`;
    if (item.job || item.mergeQueue?.error) reason ??= `Wait for PR #${item.snapshot.number} to finish maintenance and refresh its queue status.`;
    const check = { ...item, mergeQueue: undefined };
    // A queue eviction itself is recoverable by resubmitting after CI is fixed.
    // Other human questions and maintenance work remain blockers.
    if (item.decision.context && item.decision.context === item.mergeQueue?.terminal?.id) check.decision = decide(item.snapshot, check);
    if (!item.mergeQueue?.active) {
      const report = readiness(check, config, [check], runs, now);
      if (!report.ready) reason ??= `PR #${item.snapshot.number}: ${report.reasons[0]}`;
    }
    if (item.paused || item.watching === false) reason ??= `Resume watching PR #${item.snapshot.number} before submitting.`;
  }
  return { canSubmit: !reason && record.snapshot.state === "OPEN" && !record.snapshot.draft,
    reason: reason ?? null, label: scope.length > 1 ? `Add ${scope.length} PRs to merge queue` : "Add to merge queue",
    scope: scope.map(r => r.snapshot.number).reverse(), heads: Object.fromEntries(scope.map(r => [String(r.snapshot.number), r.snapshot.head])) };
}
