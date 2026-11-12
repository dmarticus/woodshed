import { mergeQueueDecision, queueCheck } from "./merge-queue";
export type Check = { app?: string; required?: boolean; name: string; status: string; conclusion: string | null; url: string; description?: string; startedAt?: string; source?: { workflow: string; run: string; createdAt: string } };
export type Thread = { id: string; path?: string; comments: { author: string; authorType?: string; body: string; url: string }[] };
export type Review = { author: string; state: string; body: string; head: string; submittedAt: string };
export type Snapshot = {
  number: number; title: string; url: string; head: string; branch: string; base: string;
  state: string; draft: boolean; mergeable: string; mergeStateStatus: string;
  reviewDecision: string | null; checks: Check[]; threads: Thread[]; reviews: Review[]; labels: string[];
  author?: string; body?: string; updatedAt?: string; reviewRequests?: string[]; stack?: { position: number; size: number } | null;
  baseHead?: string; mergeQueue?: import("./merge-queue").QueueObservation;
};
export type Decision = {
  kind: "paused" | "waiting" | "fix" | "review" | "approval" | "human" | "ready" | "closed";
  reason: string;
  response?: "reply" | "retry" | "recheck";
  action?: { label: string; url: string };
  title?: string;
  question?: string;
  context?: string; id?: string; questionKey?: string;
  options?: { id: string; label: string; value: string }[];
};
export type Job = { decisionVersions?: string[]; decisionContextAfterTurn?: number; contextReview?: boolean; name: string; head: string; fingerprint: string; startedAt: string; kind?: "repair" | "branch-update" | "triage"; instructions?: string; afterTurn?: number; model?: string; budgetUSD?: number; adapter?: "app-server"; budgetOverride?: boolean; manual?: boolean; freshCheckout?: boolean; handoff?: import("./handoff").Handoff; ciEvidence?: import("./check-evidence").CIEvidence; repairHints?: import("./playbooks").RepairHint[]; playbooksApplied?: string[] };
export type ReviewThreadAssessment = { id: string; status: "addressed" | "needs_repair" | "awaiting_reviewer"; reason: string; category?: import("./outcomes").FindingCategory; code_url?: string };
export type AssessmentResult = { head: string; route: "wait" | "repair" | "ask" | "ready"; category: "review" | "checks" | "visual" | "product" | "operations" | "internal"; response?: "reply" | "recheck"; ci_access?: import("./check-evidence").CIAccessBlocker; title: string; reason: string; question?: string; options?: { id: string; label: string; value: string }[]; instructions?: string; action?: { label: string; url: string }; evidence: { url: string; detail: string }[]; review_threads?: ReviewThreadAssessment[] };
export type Assessment = { id?: string; head: string; key: string; report: string; sourceJob?: Job; attempts: number; result?: AssessmentResult; reply?: string; followups: number; jevChecked?: boolean; allowWatch?: boolean; attentionVersion?: number; ciEvidenceVersion?: number; ciEvidence?: import("./check-evidence").CIEvidence; attention?: import("./owner-attention").OwnerAttention };
export type Record = {
  snapshot: Snapshot; decision: Decision; paused: boolean; attempts: number;
  fingerprint: string; job?: Job; lastError?: string;
  requestedReview?: string; requestedApproval?: string; approvalRequestedAt?: string; approvalRequests?: { [head: string]: string }; humanHead?: string; humanReason?: string;
  resumeRequested?: string;
  runRequested?: boolean; instructions?: string;
  watching?: boolean; stateSince?: string; pendingReply?: string; requestedModel?: string;
  pendingPromptId?: string; skippedHead?: string; budgetDay?: string;
  humanObservation?: JobObservation;
  assessment?: Assessment;
  mergeQueue?: import("./merge-queue").QueueTracking;
  closedAt?: string; sleepInterruptedAt?: string;
  pendingAnswer?: { text: string; questionKey?: string; requiresConfirmation: boolean };
  topUpUSD?: number;
  recovery?: import("./recovery").Recovery;
  handoff?: import("./handoff").Handoff;
  observedAt?: string;
  stackWait?: { number: number; head: string; reason: string };
  ciIncident?: import("./ci-incidents").CIIncident;
};
export type JobObservation = { state: "working" | "blocked" | "done" | "error" | "unknown"; summary: string; promptId?: string };
export type Config = {
  repository: string; author: string; checkout: string; pollSeconds: number; maxAttempts: number;
  maxConcurrentJobs: number; automation: boolean; port: number; reviewLabel: string; approvalLabel: string;
  concurrencyMode?: "adaptive" | "fixed"; cpuTargetPercent?: number; memoryTargetPercent?: number;
  paused?: boolean;
  mode?: Mode; defaultModel?: string; retryModel?: string; escalateOnRetry?: boolean; runCapUSD?: number; dailyCapUSD?: number;
  modelPrices?: { [model: string]: ModelPrice }; watchFilter?: "mine" | "mine-and-reviews" | "query"; watchQuery?: string;
  workerProtocol?: "app-server";
  gitSigningKey?: string;
  // Owner-only file holding a read-only, single-repository token. When unset, workers share the controller's gh login.
  workerGitHubTokenPath?: string;
  // "systemd" runs each job as a separate Unix user in a hardened unit (scripts/setup-job-isolation.sh) instead of under herdr.
  jobIsolation?: "systemd";
  // Integrations whose absence should warn in /health and block a deploy, instead of degrading silently.
  requiredIntegrations?: ("typesafe" | "posthog")[];
};

export type Mode = "watch" | "auto" | "paused";
export const modeOf = (config: Config): Mode => config.mode ?? (config.paused ? "paused" : config.automation ? "auto" : "watch");
export type ModelPrice = { input: number; cached: number; output: number; cacheWrite: number; source?: string };
export type ModelOption = { id: string; name: string; isDefault: boolean; price?: ModelPrice };
export type Usage = { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number };
export type Run = { updatedAt?: string; id: string; number: number; startedAt: string; endedAt?: string; state: "preparing" | "running" | "waiting" | "succeeded" | "failed" | "stopped" | "budget"; model: string; turns: number; costUSD: number | null; costsByDay: { [day: string]: number }; usage?: Usage; summary: string; budgetUSD?: number; threadId?: string; prompt?: { id: string; kind: "question" | "permission"; text: string } };

export const failed = (check: Check): boolean =>
  !(check.conclusion === "CANCELLED" && check.required === false) && ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].includes(check.conclusion ?? "");

export function currentChecks(checks: Check[]): Check[] {
  return checks.filter(check => !check.source || !checks.some(next => {
    if (!next.source || next === check || next.source.workflow !== check.source!.workflow || next.conclusion === "CANCELLED") return false;
    const newerRun = next.source.createdAt > check.source!.createdAt;
    const laterAttempt = next.source.run === check.source!.run && !!next.startedAt && !!check.startedAt && next.startedAt > check.startedAt;
    return (newerRun || laterAttempt) && (next.name === check.name || check.conclusion === "CANCELLED" && newerRun);
  }));
}

export function repairResolved(snapshot: Snapshot, basis: string): boolean {
  let evidence: { checks: string[]; threads: [string, unknown][]; conflict: boolean };
  try { evidence = JSON.parse(basis); } catch { return false; }
  if (!Array.isArray(evidence.checks) || !Array.isArray(evidence.threads) || !evidence.checks.length && !evidence.threads.length && !evidence.conflict) return false;
  const settled = (c: Check) => c.status === "COMPLETED" && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion ?? "");
  const allSettled = snapshot.checks.length > 0 && snapshot.checks.every(settled);
  if (evidence.checks.some(name => {
    const matching = snapshot.checks.filter(c => c.name === name);
    return matching.length ? !matching.every(settled) : !allSettled;
  })) return false;
  if (evidence.threads.some(([id]) => snapshot.threads.some(t => t.id === id))) return false;
  if (evidence.conflict && (snapshot.mergeable !== "MERGEABLE" || ["BEHIND", "UNKNOWN", "DIRTY"].includes(snapshot.mergeStateStatus))) return false;
  return true;
}

export function fingerprint(pr: Snapshot): string {
  return JSON.stringify({
    checks: pr.checks.filter(failed).map(c => c.name).sort(),
    threads: pr.threads.map(t => [t.id, t.comments.map(c => c.body)]).sort(),
    conflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND",
  });
}

export const hasRequestedApproval = (record: Record | undefined, head: string): boolean => record?.requestedApproval === head || Object.hasOwn(record?.approvalRequests ?? {}, head);
export const currentStamphogReview = (pr: Snapshot): Review | undefined => [...pr.reviews].reverse().find(r => /stamphog/i.test(r.author) && r.head === pr.head);
export const stamphogRefused = (pr: Snapshot): boolean => {
  const review = currentStamphogReview(pr);
  return pr.reviewDecision !== "APPROVED" && review?.state !== "APPROVED" && /\b(?:REFUSED|ESCALATE|GATED)\b/i.test(review?.body ?? "");
};
export const reviewedOnHead = (pr: Snapshot): boolean => pr.reviews.some(r => r.head === pr.head && (r.state === "APPROVED" || /posthog|review.hog/i.test(r.author) && !/stamphog/i.test(r.author)));

export function decide(pr: Snapshot, record?: Record): Decision {
  pr = { ...pr, checks: pr.checks.filter(c => !queueCheck(c)) };
  if (pr.state !== "OPEN") return { kind: "closed", reason: pr.state === "MERGED" ? "Merged" : "Closed" };
  if (record?.watching === false) return { kind: "paused", reason: "Not watching this PR" };
  if (record?.skippedHead === pr.head) return { kind: "paused", reason: "Skipped this run on the current commit" };
  if (record?.paused || pr.draft) return { kind: "paused", reason: pr.draft ? "Draft PR" : "Paused by you" };
  if (record) { const queue = mergeQueueDecision(record); if (queue) return queue; }
  if (record?.job) return { kind: "waiting", reason: record.job.kind === "branch-update" ? "Automatically resolving conflicts and updating the PR branch" : "Coding agent is working" };
  if (record?.humanHead === pr.head) return { kind: "human", reason: record.humanReason ?? "Agent needs your input" };
  if (stamphogRefused(pr)) return { kind: "human", title: "Request a human review", reason: "Stamphog could not approve these changes. A human reviewer is needed.", action: { label: "Open reviewers on GitHub", url: pr.url } };

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND") return {
    kind: "fix", reason: pr.mergeable === "CONFLICTING" ? "Queued for automatic conflict resolution" : "Queued to incorporate the required base update",
  };

  const visual = pr.checks.find(c => c.conclusion === "FAILURE" && /visual|chromatic|percy/i.test(c.name) && !/\(tracking\)/i.test(c.name) && /visual changes detected|snapshots? (?:need|require).*review|changes (?:need|require).*approval/i.test(c.description ?? ""));
  if (visual) return {
    kind: "human", reason: `${visual.name}: ${visual.description}. Inspect the diff and approve it if the change is intended.`,
    ...(visual.url ? { action: { label: "Review visual diff", url: visual.url } } : {}),
  };


  const needsFix = pr.checks.some(failed) || pr.threads.length > 0 ||
    pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND";
  if (needsFix) {
    return { kind: "fix", reason: [
      pr.checks.filter(failed).length ? `${pr.checks.filter(failed).length} failing checks` : "",
      pr.threads.length ? `${pr.threads.length} open review threads` : "",
      pr.mergeable === "CONFLICTING" ? "Merge conflict" : "",
      pr.mergeStateStatus === "BEHIND" ? "GitHub requires a branch update" : "",
    ].filter(Boolean).join(" · ") };
  }
  if (pr.checks.length === 0 || pr.checks.some(c => c.status !== "COMPLETED" || !c.conclusion))
    return { kind: "waiting", reason: "Waiting for checks to finish" };
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
    return { kind: "waiting", reason: "GitHub is calculating mergeability" };
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { kind: "human", reason: "Changes are still requested. A reviewer needs to confirm their feedback is addressed." };

  const reviewed = reviewedOnHead(pr);
  if (!reviewed && pr.reviewDecision !== "APPROVED" && pr.reviewRequests?.length) return { kind: "waiting", reason: `Waiting for review from ${pr.reviewRequests.join(", ")}` };
  if (!reviewed) return { kind: "review", reason: "Waiting for PostHog Review on this commit" };
  if (pr.reviewDecision !== "APPROVED" && currentStamphogReview(pr)?.state === "APPROVED")
    return { kind: "waiting", reason: "Stamphog approved this commit; waiting for remaining required approvals" };
  if (pr.reviewDecision !== "APPROVED") return { kind: "approval", reason: hasRequestedApproval(record, pr.head) ? "Stamphog requested; waiting for approval on this commit" : "Waiting for approval on the current changes" };
  if (!["CLEAN", "BLOCKED", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus))
    return { kind: "waiting", reason: `GitHub merge state: ${pr.mergeStateStatus}` };
  return { kind: "ready", reason: "Checks passed, review addressed, and approval recorded. Ready for your merge decision." };
}

export type ApprovalRequestState = { head: string; status: "available" | "requested" | "approved" | "blocked" | "human"; canRequest: boolean; reason: string; requestedAt?: string };
/** A label records a request. Only a review on this head can establish approval. */
export function approvalRequestState(record: Record, canMaintain: boolean, mode: Mode): ApprovalRequestState {
  const pr = record.snapshot;
  const state = (status: ApprovalRequestState["status"], reason: string): ApprovalRequestState => ({ head: pr.head, status, reason, canRequest: status === "available" });
  if (stamphogRefused(pr)) return state("human", "Stamphog needs a human review");
  if (currentStamphogReview(pr)?.state === "APPROVED") return state("approved", "Stamphog approved this commit");
  if (pr.reviewDecision === "APPROVED" && pr.reviews.some(r => r.head === pr.head && r.state === "APPROVED")) return state("approved", "Approval recorded on this commit");
  if (hasRequestedApproval(record, pr.head)) return { ...state("requested", "Stamphog requested for this commit"), requestedAt: record.approvalRequests?.[pr.head] || (record.requestedApproval === pr.head ? record.approvalRequestedAt : undefined) };
  if (pr.state !== "OPEN" || pr.draft) return state("blocked", "Mark this PR ready for review first");
  if (!canMaintain) return state("blocked", "Woodshed only requests approval for your own PRs");
  if (mode === "paused" || record.paused) return state("blocked", "Resume before requesting Stamphog approval");
  if (record.job || record.pendingReply || record.resumeRequested || record.recovery?.retryAt || record.assessment && !record.assessment.result) return state("blocked", "Waiting for maintenance to finish");
  if (record.decision.kind === "human" || record.assessment?.result?.route === "ask") return state("blocked", "Resolve the current decision before requesting approval");
  if (record.assessment?.result?.route === "wait" && ["operations", "product", "visual"].includes(record.assessment.result.category)) return state("blocked", record.assessment.result.reason);
  const policy = decide(pr, record);
  if (policy.kind !== "approval") return state("blocked", policy.reason);
  return state("available", "Ready to request Stamphog approval");
}
