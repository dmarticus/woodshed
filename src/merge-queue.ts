export class QueueSubmissionRejected extends Error {}
import { createHash } from "node:crypto";
import type { Decision, Record, Snapshot } from "./model";

export type QueuePhase = "available" | "submitted" | "queued" | "testing" | "pending_failure" | "passing" | "merged" | "failed" | "cancelled" | "unknown";
export type QueueObservation = { provider: "trunk"; state: QueuePhase; revision: string; url: string; reason?: string; updatedAt?: string; error?: string };
export type QueueTracking = QueueObservation & {
  head: string; active: boolean; observedAt: string; owner?: number; groupId?: string;
  submission?: { id: string; head: string; since: string; baseline: string; url?: string; uncertain?: boolean };
  terminal?: { id: string; head: string; reason: string; url: string; acknowledged?: boolean };
};
export const activeQueuePhase = (state: QueuePhase): boolean => ["submitted", "queued", "testing", "pending_failure", "passing"].includes(state);
export const queueCheck = (check: Snapshot["checks"][number]): boolean => check.app === "trunk-io" && /^Trunk Merge Queue\s*\([^)]+\)$/i.test(check.name) && trunkURL(check.url) !== undefined;
export function trunkURL(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "app.trunk.io" && url.pathname.includes("/merge-queue/") ? url.href : undefined; } catch { return undefined; }
}
const revision = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = (body: string): string => body.replace(/<!--[\s\S]*?-->/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#]/g, "").trim();
export function parseTrunkComments(comments: any[], pr: Snapshot): QueueObservation | undefined {
  const statuses = comments.filter(c => c.user?.login === "trunk-io[bot]" && c.user?.type === "Bot" && typeof c.body === "string" && !c.body.includes("<!-- Trunk Test Analytics -->") && /<!-- Trunk Merge -->|<!-- Start PR Submit Checkbox -->|https:\/\/app\.trunk\.io\/[^\s]+\/merge-queue\//.test(c.body)).map(c => {
    const text = plain(c.body); const first = text.split(/\n\s*\n/)[0]!.replace(/^[^A-Za-z0-9]+/u, "").trim();
    const url = [...c.body.matchAll(/https:\/\/app\.trunk\.io\/[^\s)<>]+/g)].map(m => trunkURL(m[0])).find(Boolean) ?? c.html_url;
    let state: QueuePhase | undefined;
    // Pending Failure is still inside the queue, even though tests failed.
    if (/^Merging to .* in this repository is managed by Trunk/.test(first)) state = "available";
    else if (/pending[_ ]failure|failed.*(?:waiting for|upstream|still in the queue)/i.test(first)) state = "pending_failure";
    else if (/(?:stack )?merged successfully|^merged\b/i.test(first)) state = "merged";
    else if (/removed from (?:the )?merge queue/i.test(first)) state = /cancel[le]+d|canceled/i.test(first) ? "cancelled" : "failed";
    else if (/^(?:this (?:pull request|stack) (?:has |was |is )?)?(?:failed|cancelled|canceled)\b/i.test(first)) state = /cancel/i.test(first) ? "cancelled" : "failed";
    else if (/(?:tests? (?:have )?passed|waiting (?:to merge|for .*to merge)|^merging\b)/i.test(first)) state = "passing";
    else if (/^(?:this (?:pull request|stack) (?:has |was |is )?)?(?:currently )?(?:testing|running tests)\b|is (?:currently )?(?:being tested|testing)/i.test(first)) state = "testing";
    else if (/^(?:this (?:pull request|stack) (?:has |was |is )?)?(?:queued|pending|submitted|added to (?:the )?merge queue)\b|(?:has been|is) (?:added|submitted|queued) (?:to|for|in) (?:the )?merge queue|^This (?:pull request|stack) is (?:currently )?in (?:the )?merge queue/i.test(first)) state = "queued";
    else if (/Merging to `[^`]+` in this repository is managed by Trunk/.test(c.body) || /<!-- Start PR Submit Checkbox -->/.test(c.body) && /To merge this pull request/.test(c.body)) state = "available";
    if (!state) return undefined;
    return { provider: "trunk" as const, state, revision: revision([c.id, c.updated_at, c.body]), url: url || pr.url, updatedAt: c.updated_at, reason: ["failed", "cancelled", "pending_failure"].includes(state) ? first.slice(0, 600) : undefined };
  }).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  return statuses[0];
}
export function parseTrunkCheck(pr: Snapshot): QueueObservation | undefined {
  const check = pr.checks.find(c => c.name === `Trunk Merge Queue (${pr.base})` && queueCheck(c));
  if (!check) return undefined;
  const state: QueuePhase = check.status !== "COMPLETED" ? check.status === "IN_PROGRESS" ? "testing" : "queued" : check.conclusion === "SUCCESS" ? pr.state === "MERGED" ? "merged" : "passing" : check.conclusion === "CANCELLED" ? "cancelled" : ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"].includes(check.conclusion ?? "") ? "failed" : "unknown";
  return { provider: "trunk", state, revision: revision([pr.head, check]), url: check.url, reason: state === "failed" ? "Trunk could not merge this PR. Open the queue details to see the failed test or merge requirement." : state === "cancelled" ? "Trunk reports that this PR was removed from the merge queue." : undefined };
}
export function trackMergeQueue(record: Record, observation: QueueObservation | undefined, now: number): void {
  const previous = record.mergeQueue; const pr = record.snapshot; const at = new Date(now).toISOString();
  if (pr.state !== "OPEN") { if (previous) { previous.active = false; previous.state = pr.state === "MERGED" ? "merged" : "cancelled"; previous.terminal = undefined; previous.submission = undefined; } return; }
  if (!observation || observation.error || observation.state === "unknown") {
    if (previous) { previous.error = observation?.error ?? "Queue status could not be confirmed. Woodshed will check again."; previous.observedAt = at; }
    return;
  }
  if (previous?.submission && (observation.revision === previous.submission.baseline || Date.parse(observation.updatedAt ?? at) < Date.parse(previous.submission.since) - 1000)) return;
  // An old bot comment on a new head is historical, not a fresh eviction.
  if (previous && previous.head !== pr.head && previous.revision === observation.revision) { previous.error = "The PR changed; waiting for Trunk to confirm its queue state."; return; }
  if (previous?.active && observation.state === "available") { previous.error = "Waiting for Trunk to confirm whether this PR is still queued."; return; }
  const active = activeQueuePhase(observation.state);
  let terminal = previous?.terminal;
  if (active || observation.state === "merged") terminal = undefined;
  else if (["failed", "cancelled"].includes(observation.state) && (previous?.active || previous?.submission)) {
    terminal = { id: revision([pr.number, pr.head, observation.revision, previous.submission?.id]), head: pr.head, reason: observation.reason ?? "Trunk removed this PR from the merge queue.", url: observation.url };
  }
  record.mergeQueue = { ...observation, head: pr.head, active, observedAt: at, terminal, owner: previous?.owner, groupId: previous?.groupId };
}
export function mergeQueueDecision(record: Record): Decision | undefined {
  const q = record.mergeQueue;
  if (!q || record.snapshot.state !== "OPEN") return undefined;
  if (q.active) return { kind: "waiting", title: "In Trunk merge queue", reason: q.error ? "Checking merge queue status" : queueDescription(q.state), action: { label: "Open Trunk queue", url: q.url } };
  if (q.terminal && !q.terminal.acknowledged) return { kind: "human", response: "recheck", title: "Removed from the merge queue", context: q.terminal.id, reason: queueFailureSummary(q.terminal.reason), question: "Check why it was removed. Resubmit when ready, or start a repair.", action: { label: "Open queue failure", url: q.terminal.url } };
  return undefined;
}
export function queueDescription(state: QueuePhase): string {
  return ({ submitted: "Waiting for Trunk to accept the submission", queued: "Waiting in Trunk merge queue", testing: "Trunk is testing this PR", pending_failure: "Trunk is checking whether a test failure came from an earlier PR", passing: "Queue tests passed; waiting to merge" } as Partial<{[K in QueuePhase]: string}>)[state] ?? "Checking merge queue status";
}

export function queueFailureSummary(reason: string): string {
  if (/cancel/i.test(reason)) return "The queue submission was cancelled before this PR could merge.";
  if (/time.?out|timed out/i.test(reason)) return "The merge queue timed out before this PR could merge.";
  if (/test|check|failure|failed/i.test(reason)) return "This PR did not pass the merge queue’s checks.";
  return "Trunk removed this PR before it could merge.";
}
