import { createHash } from "node:crypto";
import type { Decision, Record } from "./model";

export function bindDecision(record: Record): void {
  if (record.decision.kind !== "human") return;
  const decision = record.decision;
  const content = JSON.stringify({ title: decision.title, question: decision.question ?? decision.reason, options: decision.options });
  const questionKey = createHash("sha256").update(content).digest("hex");
  decision.questionKey = questionKey;
  decision.id = createHash("sha256").update(record.snapshot.head + questionKey).digest("hex");
}
export function sameQuestion(decision: Decision, key?: string): boolean { return !!key && decision.kind === "human" && decision.questionKey === key; }
