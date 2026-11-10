import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "../src/mcp";
import { ControllerClient } from "../src/controller-client";
import { AgentAPI } from "../src/agent-api";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { Settings } from "../src/settings";
import { handler } from "../src/http";
import type { Config, Snapshot, Job } from "../src/model";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
function harness() {
  const store = new Store(":memory:"); const jobs: Job[] = [];
  let live: Snapshot = { number: 42, title: "Fixture change", url: "https://github.com/example/project/pull/42", head: "a".repeat(40), branch: "feature", base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, checks: [{ name: "Tests", status: "COMPLETED", conclusion: "FAILURE", url: "" }], threads: [], reviews: [], labels: [], author: "fixture" };
  const config = { repository: "example/project", mode: "auto", automation: true, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, runCapUSD: 5, dailyCapUSD: 20, port: 7341 } as Config;
  let own = true;
  const github: any = { snapshot: async () => live, canMaintain: async () => own };
  const runner: any = { launch: async (_: Snapshot, job: Job) => { jobs.push(job); }, status: async () => ({ state: "working" }) };
  const controller = new Controller(config, store, github, runner);
  controller.sync = async () => {};
  const api = new AgentAPI(controller);
  const token = "b".repeat(64); const fetch = handler(controller, new Settings(config, "/unused"), token);
  const client = new ControllerClient("http://127.0.0.1:7341", () => token);
  client.request = async (path, input, signal) => {
    const response = await fetch(new Request(`http://127.0.0.1:7341/${path}`, { method: input === undefined ? "GET" : "POST", headers: { Host: "127.0.0.1:7341", Authorization: `Bearer ${token}` }, body: input === undefined ? undefined : JSON.stringify(input), signal }));
    const data = await response.json() as any; if (!response.ok) throw new Error(data.error); return data;
  };
  const handoff = { repository: config.repository, number: 42, head: live.head, request_id: "fixture/session/42", summary: "Added an explicit choice", intent: "Keep existing reports visible until the owner archives them", tradeoffs: ["Pausing delivery does not archive a report"], validation: ["Ran the scoped report tests"], source_session: { kind: "codex" as const, id: "fixture-session" } };
  return { store, controller, config, jobs, api, client, fetch, token, handoff, live: (patch: Partial<Snapshot>) => { live = { ...live, ...patch }; }, own: (value: boolean) => { own = value; } };
}

test("MCP handoff is durable, idempotent, and feeds implementation intent to one maintenance job", async () => {
  const h = harness(); const server = createMcpServer(h.client); const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); close.push(async () => { await client.close(); await server.close(); });
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(["handoff-pr", "get-pr-status", "list-attention", "request-recheck", "wait-for-change"]);
  const first = await client.callTool({ name: "handoff-pr", arguments: h.handoff });
  expect(first.isError).not.toBe(true);
  const accepted = first.structuredContent as any;
  expect(accepted.accepted_head).toBe(h.handoff.head);
  const retry = await client.callTool({ name: "handoff-pr", arguments: h.handoff });
  expect(retry.structuredContent).toMatchObject({ handoff_id: accepted.handoff_id, replayed: true });
  expect(h.jobs).toHaveLength(0);
  const live = h.store.get(42)!.snapshot; await h.controller.reconcile(live); await h.controller.reconcile(live);
  expect(h.jobs).toHaveLength(1); expect(h.jobs[0].handoff?.intent).toBe(h.handoff.intent);
  const status = await client.callTool({ name: "get-pr-status", arguments: { number: 42 } });
  expect(status.structuredContent).toMatchObject({ phase: "preparing", head: live.head, next_action: { owner: "woodshed" }, run: { state: "preparing", turns: 0, estimated_cost_usd: 0 } });
  expect((await client.listResources()).resources.map(r => r.uri)).toContain("woodshed://inbox");
  const resource = await client.readResource({ uri: "woodshed://prs/42" });
  expect(JSON.parse((resource.contents[0] as any).text).handoff.intent).toBe(h.handoff.intent);
});

test.each(["head", "repository", "owner", "draft", "closed", "request-id"])("handoff rejects a changed %s without launching work", async kind => {
  const h = harness(); const input = { ...h.handoff };
  if (kind === "head") h.live({ head: "c".repeat(40) });
  if (kind === "repository") input.repository = "example/other";
  if (kind === "owner") h.own(false);
  if (kind === "draft") h.live({ draft: true });
  if (kind === "closed") h.live({ state: "CLOSED" });
  if (kind === "request-id") { await h.controller.handoff(input); input.intent = "A conflicting retry"; }
  await expect(h.controller.handoff(input)).rejects.toThrow();
  expect(h.jobs).toHaveLength(0);
});

test("handoff preserves paused mode and duplicate requests remain idempotent across controller instances", async () => {
  const h = harness(); await h.controller.handoff(h.handoff);
  const record = h.store.get(42)!; record.paused = true; h.store.put(record);
  const restarted = new Controller(h.config, h.store, h.controller.github, h.controller.runner);
  const replay = await restarted.handoff(h.handoff);
  expect(replay.replayed).toBe(true); expect(h.store.get(42)?.paused).toBe(true);
  expect(h.jobs).toHaveLength(0);
});

test("status waits ignore polling timestamps, wake for progress, and cancel without stopping the run", async () => {
  const h = harness(); await h.controller.handoff(h.handoff);
  const version = h.api.status(42).version;
  const waiting = h.api.wait(42, version, 25);
  const unchanged = h.store.get(42)!; unchanged.observedAt = new Date(Date.now() + 1).toISOString(); h.store.put(unchanged);
  expect(h.api.status(42).version).toBe(version);
  unchanged.decision = { kind: "human", reason: "Keep the existing behavior?" }; h.store.put(unchanged);
  expect((await waiting).status.next_action.owner).toBe("human");
  expect(h.api.attention().items).toHaveLength(1);
  const abort = new AbortController(); const canceled = h.api.wait(42, h.api.status(42).version, 25, abort.signal); abort.abort();
  await expect(canceled).rejects.toThrow("canceled");
  expect((await h.api.wait(42, h.api.status(42).version, 0)).changed).toBe(false);
  expect(h.store.get(42)?.decision.kind).toBe("human");
});

test("agent endpoints require the local credential and the MCP bridge refuses external destinations", async () => {
  const h = harness();
  for (const path of ["api/agent/inbox", "api/agent/attention", "api/agent/prs/42"]) {
    expect((await h.fetch(new Request(`http://127.0.0.1:7341/${path}`, { headers: { Host: "127.0.0.1:7341" } }))).status).toBe(401);
    expect((await h.fetch(new Request(`http://127.0.0.1:7341/${path}`, { headers: { Host: "127.0.0.1:7341", Authorization: `Bearer ${h.token}`, Origin: "http://127.0.0.1:7341" } }))).status).toBe(401);
  }
  for (const url of ["https://example.com", "http://127.0.0.1:7341@evil.example", "http://127.0.0.1:7341/?token=value"]) expect(() => new ControllerClient(url)).toThrow();
});


test("outcome resources are discoverable, bounded, historical and support a since template", async () => {
  const h = harness(); h.controller.github.viewerName = "fixture"; await h.controller.handoff(h.handoff);
  const server = createMcpServer(h.client); const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); close.push(async () => { await client.close(); await server.close(); });
  expect((await client.listResources()).resources.some(r => r.uri === "woodshed://outcomes" && r.description?.includes("Not a rule set"))).toBe(true);
  expect((await client.listTools()).tools.find(t => t.name === "handoff-pr")?.description).toContain("woodshed://outcomes");
  for (const uri of ["woodshed://outcomes", "woodshed://outcomes?since=7d"]) {
    const result = await client.readResource({ uri }); const text = (result.contents[0] as any).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384); expect(JSON.parse(text)).toMatchObject({ historical_context_only: true, totals: { prs_handed_off: 1 } });
  }
  await expect(h.client.request("api/agent/outcomes?since=invalid")).rejects.toThrow();
});
