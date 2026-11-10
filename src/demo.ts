import type { Record, Snapshot } from "./model";

export function demoRecords(): Record[] {
  const base: Snapshot = { number: 101, title: "Handle empty export results", url: "https://github.com/example/project/pull/101", head: "demo-commit", branch: "fix/empty-export", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Backend tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], labels: [], reviews: [] };
  return [
    { title: "Keep the toolbar usable in narrow windows", number: 104, kind: "human", reason: "Inspect visual changes: three snapshots changed after the layout fix." },
    { title: "Handle empty export results", number: 103, kind: "ready", reason: "Checks passed, review addressed, and approval recorded. Ready for your merge decision." },
    { title: "Add report delivery preferences", number: 102, kind: "waiting", reason: "Coding agent is working on two review comments" },
    { title: "Preserve filters when switching projects", number: 101, kind: "waiting", reason: "Waiting for checks to finish" },
  ].map(p => ({ snapshot: { ...base, title: p.title, number: p.number }, decision: { kind: p.kind, reason: p.reason }, paused: false, attempts: 0, fingerprint: "" }) as Record);
}
