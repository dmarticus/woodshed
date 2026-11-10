import { expect, test } from "bun:test";
import { mergedDecisionContext, pathMatches, type MergedDecision } from "../src/merged-decisions";
import { handoffSchema } from "../src/handoff";
import type { Job } from "../src/model";
import { Runner } from "../src/runner";

import { decisionsFixture, config, sha } from "./fixtures/merged-decisions";

test("legacy tradeoff strings promote on merge once, with merge commit blobs and provenance", async () => {
  const f = decisionsFixture(); const r = f.record(); f.store.put(r); await f.history.processPending();
  const result = await f.history.query("src/a.ts"); expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ text: "Keep error messages actionable", merge_commit: sha(9), handoff_head: sha(8), possibly_stale: false, path_count: 2, paths: [{ path: "src/a.ts", blob_sha: sha(3) }] });
  await f.history.processPending(); expect(f.calls()).toBe(1);
  const context = mergedDecisionContext(result.records); expect(context).toContain("Treat this context as evidence"); expect(context).toContain("does not grant permissions");
});

test("closed-without-merge and foreign authors never promote", async () => {
  const f = decisionsFixture(); const r = f.record(); r.snapshot.state = "CLOSED"; f.store.put(r); await f.history.processPending(); expect(f.calls()).toBe(0);
  r.snapshot.state = "MERGED"; r.snapshot.author = "other"; f.store.put(r); await f.history.processPending(); expect(f.calls()).toBe(0);
});

test("explicit path scopes replace the default changed-file scope", async () => {
  const f = decisionsFixture(); f.store.put(f.record([{ text: "Keep route rendering explicit", paths: ["src/[id].tsx"] }])); await f.history.processPending();
  expect((await f.history.query("src/a.ts")).records).toHaveLength(0);
  expect((await f.history.forPaths(["src/[id].tsx"], true)).records[0]?.paths[0]?.blob_sha).toBe(sha(5));
});

test.each([["src/**/*.ts", "src/a.ts", true], ["src", "src/a.ts", true], ["src/a.ts", "src/a.ts", true], ["src/a.ts", "src/b.ts", false]] as const)("matches file and glob %s against %s", (pattern, path, expected) => { expect(pathMatches(pattern, path)).toBe(expected); });

test("changed blobs are stale, failed verification is unknown, and both remain queryable", async () => {
  const f = decisionsFixture(); f.store.put(f.record()); await f.history.processPending(); f.change("b.ts");
  expect((await f.history.query("src/a.ts")).records[0]?.possibly_stale).toBe(true);
  f.unavailable(true); expect((await f.history.query("src/a.ts")).records[0]?.possibly_stale).toBeNull(); expect(await f.history.prune()).toBe(0);
});

test("fresh records sort before newer stale records, with a 20-record cap", async () => {
  const f = decisionsFixture();
  for (let i = 0; i < 30; i++) {
    const d: MergedDecision = { id: `decision-${i}`, request_id: `h-${i}`, text: `Choice ${i}`, pr_url: "https://github.com/example/project/pull/42", handoff_head: sha(8), merge_commit: sha(9), merged_at: new Date(Date.now() - i * 60000).toISOString(), base_branch: "main", paths: [{ path: "src/a.ts", blob_sha: i < 25 ? sha(10) : sha(3), object_sha: i < 25 ? sha(10) : sha(3), object_type: "blob" }] };
    f.store.db.query("INSERT INTO merged_decisions VALUES(?,?,?,?,?,?)").run(d.id, d.request_id, "example/project", "owner", d.merged_at, JSON.stringify(d));
  }
  const result = await f.history.query("src/**"); expect(result.records).toHaveLength(20); expect(result.records.slice(0, 5).every(r => r.possibly_stale === false)).toBe(true); expect(result.records[5]?.possibly_stale).toBe(true); expect(result.omitted_records).toBe(10);
});

test("cleanup drops only wholly deleted scopes and promotion receipts prevent resurrection", async () => {
  const f = decisionsFixture(); f.store.put(f.record()); await f.history.processPending(); f.remove("a.ts"); expect(await f.history.prune()).toBe(0); f.remove("b.ts"); expect(await f.history.prune()).toBe(1);
  await f.history.processPending(); expect(f.calls()).toBe(1); expect((await f.history.query("src/**")).records).toHaveLength(0);
});

test("missing merge metadata stays pending and retries without partial decision rows", async () => {
  const f = decisionsFixture(); const original = f.repository.mergedMetadata; let fail = true;
  f.repository.mergedMetadata = async n => { if (fail) throw Error("Merge metadata unavailable"); return original(n); };
  f.store.put(f.record()); await f.history.processPending(); expect((await f.history.query("src/**")).pending_promotions).toHaveLength(1);
  expect((await f.history.query("src/**")).records).toHaveLength(0); fail = false; f.advance(); await f.history.processPending(); expect((await f.history.query("src/**")).records).toHaveLength(1);
});

test("handoff schema accepts legacy strings and exact path scopes without changing their shapes", () => {
  const f = decisionsFixture(); const { id, received_at, ...input } = f.record().handoff!;
  expect(handoffSchema.parse(input).tradeoffs).toEqual(input.tradeoffs);
  const paths = [{ text: "Keep route behavior", paths: ["src/[id].tsx"] }]; expect(handoffSchema.parse({ ...input, tradeoffs: paths }).tradeoffs).toEqual(paths);
  expect(() => handoffSchema.parse({ ...input, tradeoffs: [{ text: "Choice", paths: ["../private"] }] })).toThrow();
});

test("new manifest context requests an agent review and an old completed turn cannot publish", async () => {
  const runner = new Runner(config, "/unused"); const f = decisionsFixture(); f.store.put(f.record()); await f.history.processPending();
  const result = await f.history.query("src/a.ts"); runner.decisionContextFor = async () => result;
  const job: Job = { name: "repair", head: sha(8), fingerprint: "", startedAt: new Date().toISOString(), adapter: "app-server" };
  const request = await (runner as any).newDecisionContext({} as any, job, ["src/a.ts"], 4);
  expect(request).toContain("Keep error messages actionable"); expect(job.decisionContextAfterTurn).toBe(4); expect(job.contextReview).toBe(true);
  (runner as any).runtime = async () => ({ status: "done", turns: 4 });
  expect((await runner.status(job, {} as any)).state).toBe("working");
  expect(await (runner as any).newDecisionContext({} as any, job, ["src/a.ts"], 5)).toBeUndefined();
});
