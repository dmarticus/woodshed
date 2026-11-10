import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics, type AnalyticsFetch } from "../src/analytics";
import { ProductAnalytics } from "../src/product-analytics";
import { Store } from "../src/store";
import { Controller } from "../src/controller";
import { fingerprint, type Config, type Record as PRRecord, type Run, type Snapshot } from "../src/model";

const resources: { root: string; analytics: Analytics; store?: Store }[] = [];
afterEach(() => { for (const r of resources.splice(0)) { r.analytics.close(); r.store?.db.close(); rmSync(r.root, { recursive: true, force: true }); } });
const initial = Date.UTC(2026, 10, 9, 22);
const config: Config = { repository: "private/repository", author: "@me", checkout: "", mode: "auto", automation: true, port: 7341, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, reviewLabel: "review", approvalLabel: "approval" };
const snapshot = (): Snapshot => ({ number: 42, title: "SECRET TITLE", url: "https://github.com/private/repository/pull/42", head: "a".repeat(40), branch: "secret-branch", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Private check", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], reviews: [{ author: "secret-author", state: "APPROVED", head: "a".repeat(40), body: "SECRET REVIEW", submittedAt: "" }], threads: [], labels: [] });
const record = (): PRRecord => ({ snapshot: snapshot(), decision: { kind: "waiting", reason: "SECRET REASON" }, watching: true, paused: false, attempts: 0, fingerprint: "private fingerprint", observedAt: new Date(initial).toISOString() });
function harness(send: AnalyticsFetch = (async () => new Response("ok")) as AnalyticsFetch) {
  const root = mkdtempSync(join(tmpdir(), "woodshed-analytics-"));
  let clock = initial;
  const options = { token: "TEST_INGESTION_TOKEN", autoFlush: false, fetch: send, now: () => clock };
  const analytics = new Analytics(root, options);
  const store = new Store(":memory:");
  const cfg = { ...config };
  const telemetry = new ProductAnalytics(analytics, store, cfg, () => clock);
  resources.push({ root, analytics, store });
  const events = () => {
    const db = new Database(join(root, "analytics.sqlite"), { readonly: true });
    try { return (db.query("SELECT payload FROM outbox ORDER BY rowid").all() as { payload: string }[]).map(r => JSON.parse(r.payload)); } finally { db.close(); }
  };
  return { root, analytics, store, cfg, telemetry, events, options, advance: (ms: number) => { clock += ms; } };
}

test("outbox survives restart, preserves original event identity and timestamp, and stores no token", async () => {
  const bodies: any[] = [];
  const h = harness((async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return new Response("retry", { status: 503 }); }) as AnalyticsFetch);
  h.analytics.capture("woodshed_started", { component: "controller" }, "startup");
  const original = h.events()[0];
  await h.analytics.flush();
  expect(h.analytics.status().queued).toBe(1);
  expect(h.analytics.status().lastError).toBe("http_503");
  expect(readFileSync(join(h.root, "analytics.sqlite")).includes(Buffer.from("TEST_INGESTION_TOKEN"))).toBe(false);
  h.analytics.close(); h.advance(2000);
  const next = new Analytics(h.root, { ...h.options, fetch: (async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return new Response("ok"); }) as AnalyticsFetch });
  resources[resources.length - 1].analytics = next;
  expect(next.capture("woodshed_started", {}, "startup")).toBe(false);
  await next.flush();
  expect(next.status().queued).toBe(0);
  expect(bodies[1].timestamp).toBe(original.timestamp);
  expect(bodies[1].properties.$insert_id).toBe(original.properties.$insert_id);
  expect(bodies[1].distinct_id).toBe(original.distinct_id);
});

test("rate limits back off all queued events and permanent rejection is visible", async () => {
  let calls = 0;
  const h = harness((async () => { calls++; return new Response("slow", { status: 429, headers: { "Retry-After": "60" } }); }) as AnalyticsFetch);
  h.analytics.capture("woodshed_started"); h.analytics.capture("woodshed_started");
  await h.analytics.flush(); h.advance(10_000); await h.analytics.flush();
  expect(calls).toBe(1);
  h.advance(60_000); await h.analytics.flush(); expect(calls).toBe(2);
  const rejected = harness((async () => new Response("bad", { status: 400 })) as AnalyticsFetch);
  rejected.analytics.capture("woodshed_started"); await rejected.analytics.flush();
  expect(rejected.analytics.status().quarantined).toBe(1);
  expect(rejected.analytics.status().lastError).toBe("http_400");
});

test("preview mode does not initialize tracking or send events", async () => {
  let sent = false;
  const root = mkdtempSync(join(tmpdir(), "woodshed-preview-analytics-"));
  const analytics = new Analytics(root, { enabled: false, token: "test", fetch: (async () => { sent = true; return new Response("ok"); }) as AnalyticsFetch });
  resources.push({ root, analytics });
  expect(analytics.capture("woodshed_started")).toBe(false); await analytics.flush();
  expect(sent).toBe(false); expect(analytics.status().enabled).toBe(false);
});

test("PR readiness requires fresh verified evidence and is idempotent across polls and restarts", () => {
  const h = harness(), pr = record();
  h.store.put(pr); h.store.put(pr);
  expect(h.events().filter(e => e.event === "woodshed_pr_enrolled")).toHaveLength(1);
  pr.decision = { kind: "ready", reason: "Ready" }; pr.snapshot.checks[0].conclusion = "FAILURE"; h.store.put(pr);
  expect(h.events().filter(e => e.event === "woodshed_pr_ready")).toHaveLength(0);
  pr.snapshot.checks[0].conclusion = "SUCCESS"; h.advance(5000); h.store.put(pr); h.store.put(pr);
  const ready = h.events().filter(e => e.event === "woodshed_pr_ready");
  expect(ready).toHaveLength(1); expect(ready[0].properties.elapsed_ms).toBe(5000);
  new ProductAnalytics(h.analytics, h.store, h.cfg, h.options.now); h.store.put(pr);
  expect(h.events().filter(e => e.event === "woodshed_pr_ready")).toHaveLength(1);
  pr.snapshot.state = "MERGED"; h.store.put(pr);
  expect(h.events().filter(e => e.event === "woodshed_pr_state_changed").at(-1).properties.to_phase).toBe("merged");
});

test("owner decisions measure resolution time and exclude decision text and identifiers", () => {
  const h = harness(), pr = record(); h.store.put(pr);
  pr.decision = { kind: "human", reason: "SECRET QUESTION", options: [{ id: "1", label: "SECRET OPTION", value: "SECRET ANSWER" }] };
  h.store.put(pr); h.store.put(pr); h.advance(20_000);
  h.telemetry.actionContext = { action: "reply", source: "notification" };
  pr.decision = { kind: "ready", reason: "Done" }; h.store.put(pr);
  const events = h.events();
  expect(events.filter(e => e.event === "woodshed_attention_raised")).toHaveLength(1);
  const resolution = events.find(e => e.event === "woodshed_attention_resolved");
  expect(resolution.properties.duration_ms).toBe(20_000); expect(resolution.properties.source).toBe("notification");
  expect(events.find(e => e.event === "woodshed_pr_ready").properties.without_owner_decision).toBe(false);
  const payload = JSON.stringify(events);
  for (const sensitive of ["SECRET", "private/repository", "secret-author", pr.snapshot.head, "secret-branch", pr.decision.id]) if (sensitive) expect(payload).not.toContain(sensitive);
  expect(events[0].properties.pr_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("triage and repair starts pair with resumable segments while cost deltas sum only once", () => {
  const h = harness(), pr = record(); h.store.put(pr);
  const r: Run = { id: "ws-triage-42-secret", number: 42, startedAt: new Date(initial).toISOString(), state: "preparing", model: "test-model", turns: 0, costUSD: 0, costsByDay: {}, summary: "SECRET OUTPUT" };
  h.store.saveRun(r); r.state = "running"; r.costUSD = 0.2; r.turns = 2; h.store.saveRun(r);
  r.state = "stopped"; r.endedAt = new Date(initial).toISOString(); h.store.saveRun(r); h.store.saveRun(r);
  r.state = "running"; r.endedAt = undefined; h.store.saveRun(r);
  r.costUSD = 0.5; r.state = "succeeded"; r.endedAt = new Date(initial + 5000).toISOString(); h.store.saveRun(r); h.store.saveRun(r);
  const events = h.events();
  expect(events.filter(e => e.event === "woodshed_run_started")).toHaveLength(1);
  expect(events.find(e => e.event === "woodshed_run_started").properties.kind).toBe("triage");
  expect(events.filter(e => e.event === "woodshed_run_resumed")).toHaveLength(1);
  const finishes = events.filter(e => e.event === "woodshed_run_finished");
  expect(finishes).toHaveLength(2); expect(finishes.map(e => e.properties.segment)).toEqual([0, 1]);
  expect(new Set(finishes.map(e => e.properties.run_id)).size).toBe(1);
  expect(events.filter(e => e.event === "woodshed_run_cost_updated").reduce((n, e) => n + e.properties.cost_usd_delta, 0)).toBeCloseTo(0.5);
  expect(JSON.stringify(events)).not.toContain(r.id); expect(JSON.stringify(events)).not.toContain("SECRET OUTPUT");
});

test("handoff acceptance is attributed to MCP and replay does not inflate enrollment", () => {
  const h = harness(), pr = record();
  const handoff: any = { id: "raw-handoff-secret", request_id: "raw-request-secret", received_at: new Date(initial).toISOString() };
  pr.handoff = handoff; h.store.acceptHandoff(pr, handoff); h.store.put(pr);
  const events = h.events();
  expect(events.filter(e => e.event === "woodshed_handoff_accepted")).toHaveLength(1);
  expect(events.find(e => e.event === "woodshed_pr_enrolled").properties.entry_point).toBe("mcp");
  expect(JSON.stringify(events)).not.toContain("raw-handoff-secret");
});

test("mark-ready acknowledges confirmed GitHub state before slow worktree preparation", async () => {
  const h = harness(); const pr = record(); pr.snapshot.draft = true; h.store.put(pr);
  let current = pr.snapshot, launched = false;
  const github: any = { snapshot: async () => current, canMaintain: async () => true, markReady: async () => { current = { ...current, draft: false, checks: [{ ...current.checks[0], conclusion: "FAILURE" }] }; } };
  const runner: any = { launch: async () => { launched = true; await new Promise(() => {}); } };
  const controller = new Controller(h.cfg, h.store, github, runner, h.options.now, h.analytics);
  const result = await Promise.race([controller.action(42, "mark-ready", { head: current.head }).then(() => "acknowledged"), Bun.sleep(200).then(() => "hung")]);
  expect(result).toBe("acknowledged"); expect(launched).toBe(false); expect(h.store.get(42)?.snapshot.draft).toBe(false);
  expect(h.store.get(42)?.decision.kind).toBe("waiting");
  expect(h.events().filter(e => e.event === "woodshed_pr_action")).toHaveLength(1);
});

test("existing active runs baseline prior spend and only add newly observed cost after rollout", () => {
  const h = harness(), pr = record(); h.store.put(pr);
  const r: Run = { id: "existing-private-run", number: 42, startedAt: new Date(initial - 60_000).toISOString(), state: "running", model: "test-model", turns: 2, costUSD: 0.2, costsByDay: {}, summary: "Existing work" };
  h.telemetry.run(r, r, true);
  expect(h.events().filter(e => e.event === "woodshed_run_cost_updated")).toHaveLength(0);
  r.costUSD = null; h.store.saveRun(r);
  expect(h.events().filter(e => e.event === "woodshed_run_cost_updated").at(-1).properties.cost_known).toBe(false);
  r.costUSD = 0.5; h.store.saveRun(r);
  const costs = h.events().filter(e => e.event === "woodshed_run_cost_updated");
  expect(costs.reduce((n, e) => n + e.properties.cost_usd_delta, 0)).toBeCloseTo(0.3);
  expect(costs.at(-1).properties.baseline).toBe(false);
});

test("pausing the global mode does not pretend an unresolved owner question was answered", () => {
  const h = harness(), pr = record(); pr.decision = { kind: "human", reason: "A real product decision" }; h.store.put(pr);
  h.cfg.mode = "paused"; h.telemetry.modeChanged("auto");
  h.cfg.mode = "auto"; h.telemetry.modeChanged("paused");
  expect(h.events().filter(e => e.event === "woodshed_attention_raised")).toHaveLength(1);
  expect(h.events().filter(e => e.event === "woodshed_attention_resolved")).toHaveLength(0);
});
