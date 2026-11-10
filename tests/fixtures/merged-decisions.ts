import { Store } from "../../src/store";
import { MergedDecisions, type DecisionRepository } from "../../src/merged-decisions";
import type { Handoff } from "../../src/handoff";
import type { Config, Record as PRRecord } from "../../src/model";

export const sha = (n: number) => n.toString(16).repeat(40);
export const config = { repository: "example/project" } as Config;
export function decisionsFixture() {
  const store = new Store(":memory:"); let now = Date.now(); let calls = 0; let unavailable = false;
  const merged = { sha: sha(1), tree: [{ path: "src", type: "tree", sha: sha(2) }] };
  const directory = { sha: sha(2), tree: [{ path: "a.ts", type: "blob", sha: sha(3) }, { path: "b.ts", type: "blob", sha: sha(4) }, { path: "[id].tsx", type: "blob", sha: sha(5) }] };
  let current = structuredClone(directory);
  const repository: DecisionRepository = { changedFiles: async () => ["src/a.ts", "src/b.ts"], mergedMetadata: async () => { calls++; return { commit: sha(9), mergedAt: new Date(now - 86400000).toISOString(), base: "main", author: "owner", files: ["src/a.ts", "src/b.ts"] }; }, decisionTree: async ref => {
    if (ref === "main") { if (unavailable) throw Error("API unavailable"); return { sha: sha(6), tree: [{ path: "src", type: "tree", sha: sha(7) }] }; }
    if (ref === sha(7)) return current;
    if (ref === sha(9)) return merged;
    if (ref === sha(2)) return directory;
    throw Error("Unexpected tree " + ref);
  } };
  const history = new MergedDecisions(store, config, repository, () => "owner", () => now);
  const record = (tradeoffs: Handoff["tradeoffs"] = ["Keep error messages actionable"]): PRRecord => ({ snapshot: { number: 42, state: "MERGED", author: "owner" } as any, handoff: { repository: config.repository, number: 42, head: sha(8), request_id: "author/42", summary: "Fixture", intent: "Preserve behavior", tradeoffs, validation: [], id: "handoff", received_at: new Date(now - 2 * 86400000).toISOString() }, paused: false, attempts: 0, fingerprint: "", decision: { kind: "closed", reason: "Merged" } });
  return { store, history, repository, record, calls: () => calls, remove: (path: string) => { current = { ...current, tree: current.tree.filter(p => p.path !== path) }; }, change: (path: string) => { current.tree.find(p => p.path === path)!.sha = sha(10); }, unavailable: (v: boolean) => { unavailable = v; }, advance: () => { now += 3600000; } };
}
