import { createHash } from "node:crypto";
import { failed, type AssessmentResult, type Decision, type Record, type Snapshot } from "./model";

export function bindDecision(record: Record): void {
  if (record.decision.kind !== "human") return;
  const decision = record.decision;
  const content = JSON.stringify({ context: decision.context, title: decision.title, question: decision.question ?? decision.reason, options: decision.options, response: decision.response === "reply" ? undefined : decision.response });
  const questionKey = createHash("sha256").update(content).digest("hex");
  decision.questionKey = questionKey;
  decision.id = createHash("sha256").update(record.snapshot.head + questionKey).digest("hex");
}
export function sameQuestion(decision: Decision, key?: string): boolean { return !!key && decision.kind === "human" && decision.questionKey === key; }

export function remainingRepairDecision(pr: Snapshot, result: AssessmentResult): Decision {
  const finding = result.review_threads?.find(t => t.status === "needs_repair");
  const check = pr.checks.find(c => c.required && failed(c)) ?? pr.checks.find(failed);
  const thread = finding ? pr.threads.find(t => t.id === finding.id) : !check ? pr.threads[0] : undefined;
  return {
    kind: "human", response: "retry",
    title: finding ? "Review feedback still needs a fix" : check ? "CI still needs a fix" : pr.mergeable === "CONFLICTING" ? "A merge conflict still needs a fix" : "The repair needs your help",
    reason: finding?.reason ?? "Woodshed stopped after repeated attempts to finish this repair.",
    question: "Woodshed stopped after two follow-ups. Review the remaining issue, then retry with instructions or finish the fix yourself.",
    action: { label: thread ? "Open review feedback" : check?.url ? "Open failed check" : "Open pull request", url: thread?.comments[0]?.url ?? (check?.url || pr.url) },
  };
}
