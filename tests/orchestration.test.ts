import { expect, test } from "bun:test";
import { readiness } from "../src/readiness";
import { stackOrder } from "../src/stack";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { decide, fingerprint, type Snapshot, type Record, type Config, type Job } from "../src/model";
import { infrastructureKind } from "../src/ci-incidents";
import { GitHub } from "../src/github";
import { Playbooks, repairContext } from "../src/playbooks";
import { headlessUnit } from "../scripts/setup-headless";
import { validateConnection, controllerConnection } from "../src/connection";
import { chmodSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const config = { repository: "example/project", mode: "auto", automation: true, pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, runCapUSD: 5, dailyCapUSD: 20 } as Config;
const snapshot = (number = 42): Snapshot => ({ number, title: "Fixture", url: `https://github.com/example/project/pull/${number}`, head: String(number).padStart(40, "a"), baseHead: "b".repeat(40), branch: `feature-${number}`, base: "main", state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", url: "" }], threads: [], reviews: [{ author: "reviewer", head: String(number).padStart(40, "a"), state: "APPROVED", body: "", submittedAt: "" }], labels: [] });
const record = (pr: Snapshot, time = Date.now()): Record => ({ snapshot: pr, paused: false, watching: true, attempts: 0, fingerprint: fingerprint(pr), decision: decide(pr), observedAt: new Date(time).toISOString() });

test("readiness evidence is bound to the head, base, check results, approval, and expiry", () => {
  const now = Date.UTC(2026, 0, 1); const r = record(snapshot(), now);
  const first = readiness(r, config, [r], [], now);
  expect(first.ready).toBe(true); expect(first.merge_authorization).toBe(false);
  expect(first.evidence.base_head).toBe("b".repeat(40));
  expect(readiness(r, config, [r], [], now + 300001).ready).toBe(false);
  r.snapshot.checks[0].conclusion = "FAILURE";
  const failed = readiness(r, config, [r], [], now);
  expect(failed.ready).toBe(false); expect(failed.id).not.toBe(first.id);
  r.snapshot.checks[0].conclusion = "SUCCESS"; r.snapshot.head = "c".repeat(40);
  expect(readiness(r, config, [r], [], now).ready).toBe(false);
});

test("stack scheduling repairs the base first and never updates a branch merely because its base moved", async () => {
  const store = new Store(":memory:"); const lower = record(snapshot(41)); const upper = snapshot(42); upper.base = lower.snapshot.branch;
  lower.snapshot.checks[0].conclusion = "FAILURE";
  store.put(lower); store.put(record(upper));
  expect(stackOrder([42, 41], store.all())).toEqual([41, 42]);
  const jobs: Job[] = [];
  const controller = new Controller(config, store, {} as any, { launch: async (_: Snapshot, job: Job) => { jobs.push(job); } } as any);
  const failed = { ...upper, checks: [{ ...upper.checks[0], conclusion: "FAILURE" }] };
  await controller.reconcile(failed);
  expect(jobs).toHaveLength(0); expect(store.get(42)?.stackWait?.number).toBe(41);
  lower.snapshot.checks[0].conclusion = "SUCCESS"; lower.snapshot.head = "d".repeat(40); store.put(lower);
  await controller.reconcile(upper);
  expect(jobs).toHaveLength(0); expect(store.get(42)?.decision.reason).toContain("to merge");
  await controller.reconcile(failed);
  expect(jobs).toHaveLength(1); expect(jobs[0].kind).toBe("repair");
});

test("an upper PR becomes ready after its tracked base merges", async () => {
  const store = new Store(":memory:"); const lower = record(snapshot(41)); const upper = snapshot(42); upper.base = lower.snapshot.branch;
  store.put(lower); store.put(record(upper));
  const controller = new Controller(config, store, {} as any, {} as any);
  await controller.reconcile(upper);
  expect(store.get(42)?.decision.kind).toBe("waiting");
  expect(readiness(store.get(42)!, config, store.all(), []).ready).toBe(false);
  lower.snapshot.state = "MERGED"; store.put(lower);
  await controller.reconcile(upper);
  expect(store.get(42)?.decision.kind).toBe("ready");
  expect(readiness(store.get(42)!, config, store.all(), []).ready).toBe(true);
});

test.each(["infrastructure", "code", "mixed"])("shared CI handles %s failures without hiding checks or retrying forever", async kind => {
  let now = Date.UTC(2026, 0, 1); const store = new Store(":memory:"); let reruns = 0; let launches = 0;
  const pr = snapshot(42); pr.checks[0].conclusion = "FAILURE";
  if (kind === "mixed") pr.checks.push({ name: "Typecheck", status: "COMPLETED", conclusion: "FAILURE", url: "" });
  const peer = snapshot(43); peer.checks[0].conclusion = "FAILURE";
  store.put(record(pr, now)); store.put(record(peer, now));
  const github: any = { snapshot: async () => peer, failureSignal: async (snapshot: Snapshot, check: any) => {
    const log = kind === "code" || check.name === "Typecheck" ? "TS2322: Type string is not assignable to number" : "The hosted runner lost communication with the server";
    const family = infrastructureKind(log);
    return family ? { signature: `${family.kind}:tests`, label: family.label, head: snapshot.head, run: String(snapshot.number), job: "job", url: `${snapshot.url}/checks` } : undefined;
  }, rerunFailed: async () => { reruns++; } };
  const controller = new Controller(config, store, github, { launch: async () => { launches++; } } as any, () => now);
  await controller.reconcile(pr);
  expect(store.get(42)?.snapshot.checks[0].conclusion).toBe("FAILURE");
  expect(readiness(store.get(42)!, config, store.all(), [], now).ready).toBe(false);
  if (kind === "infrastructure") {
    expect(launches).toBe(0); expect(reruns).toBe(1);
    expect(store.get(42)?.ciIncident?.related_prs).toEqual([42, 43]);
    await controller.reconcile(pr); expect(reruns).toBe(1);
    now += 300001; const refreshed = store.get(43)!; refreshed.observedAt = new Date(now).toISOString(); store.put(refreshed);
    await controller.reconcile(pr); expect(launches).toBe(1); expect(reruns).toBe(1);
  } else { expect(launches).toBe(1); expect(reruns).toBe(0); }
});

test("CI log classification rejects jobs from another head and only reruns a completed matching run", async () => {
  const pr = snapshot(); const check = { ...pr.checks[0], conclusion: "FAILURE", url: "https://github.com/example/project/actions/runs/123/job/456" };
  let head = "other"; let writes = 0; let logs = 0;
  const github = new GitHub(config, async argv => {
    if (argv[1] === "run") { writes++; return ""; }
    const endpoint = argv[2];
    if (endpoint.endsWith("/logs")) { logs++; return "The hosted runner lost communication with the server"; }
    return JSON.stringify({ head_sha: head, status: "completed", run_id: 123 });
  });
  expect(await github.failureSignal(pr, check)).toBeUndefined(); expect(logs).toBe(0);
  head = pr.head; const signal = await github.failureSignal(pr, check);
  expect(signal?.head).toBe(pr.head); expect(logs).toBe(1);
  head = "other"; await expect(github.rerunFailed(signal!)).rejects.toThrow("changed"); expect(writes).toBe(0);
  head = pr.head; await github.rerunFailed(signal!); expect(writes).toBe(1);
});

test("shared CI never reruns another author's PR", async () => {
  const store = new Store(":memory:"); const pr = snapshot(); pr.checks[0].conclusion = "FAILURE";
  let inspected = false;
  const github = { canMaintain: async () => false, failureSignal: async () => { inspected = true; } };
  const controller = new Controller(config, store, github as any, {} as any);
  await controller.reconcile(pr);
  expect(inspected).toBe(false); expect(store.get(pr.number)?.job).toBeUndefined();
});

test("repair memory requires fresh green checks on the published head and is advisory and idempotent", () => {
  const store = new Store(":memory:"); const playbooks = new Playbooks(store); const pr = snapshot(); pr.checks[0].conclusion = "FAILURE";
  const job = { name: "ws-memory", head: pr.head, fingerprint: fingerprint(pr) } as Job;
  const published = "e".repeat(40); const result = { publishedHead: published, repair: { files: ["src/a.ts", "../outside", "/absolute"], reason: "Handle the missing field" } };
  playbooks.published(pr.number, job, { repair: result.repair });
  const peer = snapshot(43); peer.checks[0].conclusion = "FAILURE";
  expect(playbooks.hints(peer)).toEqual([]);
  playbooks.published(pr.number, job, result); playbooks.published(pr.number, job, result);
  expect(playbooks.hints(peer)).toEqual([]);
  playbooks.confirm({ ...pr, head: published });
  expect(playbooks.hints(peer)).toEqual([]);
  pr.checks[0].conclusion = "SUCCESS"; playbooks.confirm(pr);
  expect(playbooks.hints(peer)).toEqual([]);
  playbooks.confirm({ ...pr, head: published }); playbooks.confirm({ ...pr, head: published });
  const hints = playbooks.hints(peer);
  expect(hints).toHaveLength(1); expect(hints[0].files).toEqual(["src/a.ts"]);
  expect(hints[0].published_head).toBe(published);
  expect(repairContext(hints)).toContain("advisory");
  expect(playbooks.hints({ ...peer, number: pr.number })).toEqual([]);
  peer.checks[0].name = "Other test"; expect(playbooks.hints(peer)).toEqual([]);
  playbooks.applied(pr.number, job, "clean-base-merge", published); playbooks.applied(pr.number, job, "clean-base-merge", published);
  expect(playbooks.catalog().find(p => p.id === "clean-base-merge")?.successes).toBe(1);
});

test("remote connection rejects public URLs, credentials, unsafe aliases and writable or symlinked configuration", () => {
  const valid = { url: "http://127.0.0.1:7341", token_path: "/tmp/token", machine: "woodshed-vm" };
  expect(validateConnection(valid)).toEqual(valid);
  for (const update of [{ url: "https://remote.example.com" }, { url: "http://user@127.0.0.1:7341" }, { url: "http://127.0.0.1:7341/path" }, { machine: "vm;echo" }, { token_path: "relative" }]) expect(() => validateConnection({ ...valid, ...update })).toThrow();
  const directory = mkdtempSync(join(tmpdir(), "woodshed-connection-")); const path = join(directory, "controller.json");
  writeFileSync(path, JSON.stringify(valid), { mode: 0o600 });
  expect(controllerConnection(path)).toEqual(valid);
  chmodSync(path, 0o666); expect(() => controllerConnection(path)).toThrow(); chmodSync(path, 0o600);
  const link = join(directory, "link"); symlinkSync(path, link); expect(() => controllerConnection(link)).toThrow();
});

test("headless service uses private persistent user service settings and rejects injected paths", () => {
  const unit = headlessUnit("/srv/Woodshed repo", "/usr/local/bin/bun", "/home/woodshed");
  expect(unit).toContain('WorkingDirectory=/srv/Woodshed repo\n');
  expect(unit).toContain('ExecStart="/usr/local/bin/bun" "/srv/Woodshed repo/src/server.ts"');
  expect(unit).toContain('Environment="PATH=/home/woodshed/.local/bin:');
  expect(unit).toContain("Environment=WOODSHED_REMOTE=1");
  expect(unit).toContain("Restart=on-failure"); expect(unit).toContain("UMask=0077");
  for (const path of ["relative", "/tmp/invalid\nExecStart=other", "/tmp/$EXPANSION"]) expect(() => headlessUnit(path, "/bin/bun", "/home/user")).toThrow();
});

test.skipIf(process.platform !== "linux" || !Bun.which("systemd-analyze"))("systemd accepts the generated service with a working directory containing spaces", async () => {
  const directory = mkdtempSync(join(tmpdir(), "woodshed service-"));
  try {
    const path = join(directory, "woodshed-test.service");
    writeFileSync(path, headlessUnit(directory, process.execPath, "/home/woodshed"));
    const child = Bun.spawn(["systemd-analyze", "--user", "verify", path], { stdout: "pipe", stderr: "pipe" });
    const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).toBe("");
    expect(status).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
