import { failed, type Record, type Snapshot } from "./model";

export function parentPR(snapshot: Snapshot, records: Record[]): Record | undefined {
  const matches = records.filter(r => r.snapshot.number !== snapshot.number && r.snapshot.branch === snapshot.base && r.snapshot.state === "OPEN");
  return matches.length === 1 ? matches[0] : undefined;
}

export function stackOrder(numbers: number[], records: Record[]): number[] {
  const rank = (number: number, seen = new Set<number>()): number => {
    if (seen.has(number)) return 0;
    seen.add(number);
    const record = records.find(r => r.snapshot.number === number);
    const parent = record && parentPR(record.snapshot, records);
    return parent ? 1 + rank(parent.snapshot.number, seen) : 0;
  };
  return [...numbers].sort((a, b) => rank(a) - rank(b));
}

export function stackBlock(snapshot: Snapshot, records: Record[], ready: boolean): Record["stackWait"] {
  const parent = parentPR(snapshot, records);
  if (!parent) return undefined;
  const lower = parent.snapshot;
  const changing = !!parent.job || !!parent.recovery?.retryAt || lower.checks.some(c => failed(c) || c.status !== "COMPLETED" || !c.conclusion) || lower.threads.length > 0 || lower.mergeable !== "MERGEABLE" || lower.mergeStateStatus === "BEHIND";
  if (ready || changing) return { number: lower.number, head: lower.head, reason: ready ? `Waiting for PR #${lower.number} below this PR to merge` : `Waiting for PR #${lower.number} below this PR to finish its repairs and checks` };
  return undefined;
}
