import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Handoff } from "./handoff";
import { currentChecks, failed, type AssessmentResult, type Config, type Job, type Record as PRRecord, type Run } from "./model";
import { readiness } from "./readiness";
import { queueCheck } from "./merge-queue";

export const findingCategories = ["error_handling", "input_validation", "privacy_access", "data_integrity", "concurrency", "compatibility", "testing", "maintainability", "migration_order"] as const;
export type FindingCategory = typeof findingCategories[number];
const labels: {[K in FindingCategory]: string} = { error_handling: "error handling", input_validation: "input validation", privacy_access: "privacy or access control", data_integrity: "data integrity", concurrency: "concurrency", compatibility: "compatibility", testing: "test coverage", maintainability: "maintainability", migration_order: "migration ordering" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function repositoryPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !value.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split("/").some(p => !p || p === "." || p === "..") ? value : null;
}
export function codeEvidence(value: unknown, repository: string, head: string): { url: string; path: string } | null {
  if (typeof value !== "string" || value.length > 2048 || !/^[a-f0-9]{40}$/.test(head)) return null;
  try { const u = new URL(value); const prefix = `/${repository}/blob/${head}/`; const path = repositoryPath(decodeURIComponent(u.pathname.slice(prefix.length))); return u.origin === "https://github.com" && !u.username && !u.password && u.pathname.startsWith(prefix) && path ? { url: u.href, path } : null; } catch { return null; }
}
type Enrollment = { request_id: string; repository: string; author: string; number: number; head: string; received_at: string; source_session: Handoff["source_session"] | null; complete: boolean; coverage_from: string };
const deterministic = new Set(["clean-base-merge", "django-migration-chain"]);
export class Outcomes {
  readonly startedAt: string;
  constructor(readonly store: Store, readonly config: Config, readonly actor: () => string | undefined, readonly now = Date.now) { this.startedAt = new Date(now()).toISOString(); }
  private eligible(record: PRRecord): boolean { return !!this.actor() && record.snapshot.author?.toLowerCase() === this.actor()!.toLowerCase() && record.handoff?.repository.toLowerCase() === this.config.repository.toLowerCase(); }
  private enrollment(id: string): Enrollment | undefined { const row = this.store.db.query("SELECT data FROM outcome_handoffs WHERE request_id=? AND repository=? AND author=?").get(id, this.config.repository.toLowerCase(), this.actor()?.toLowerCase() ?? "") as any; return row ? JSON.parse(row.data) : undefined; }
  private append(id: string, kind: string, key: string, data: unknown, time = new Date(this.now()).toISOString()): void {
    this.store.db.query("INSERT OR IGNORE INTO outcomes(request_id,time,kind,dedupe,data) VALUES(?,?,?,?,?)").run(id, time, kind, `${id}:${kind}:${key}`, JSON.stringify(data));
  }
  private latest(id: string, kind: string): any { const row = this.store.db.query("SELECT id,data,time FROM outcomes WHERE request_id=? AND kind=? ORDER BY id DESC LIMIT 1").get(id, kind) as any; return row ? { ...JSON.parse(row.data), event_id: row.id, time: row.time } : undefined; }
  enroll(record: PRRecord, complete: boolean): Enrollment | undefined {
    if (!this.eligible(record)) return;
    const h = record.handoff!; const existing = this.enrollment(h.request_id); if (existing) return existing;
    const data: Enrollment = { request_id: h.request_id, repository: this.config.repository.toLowerCase(), author: this.actor()!.toLowerCase(), number: h.number, head: h.head, received_at: h.received_at, source_session: h.source_session ?? null, complete, coverage_from: complete ? h.received_at : new Date(this.now()).toISOString() };
    this.store.db.query("INSERT OR IGNORE INTO outcome_handoffs VALUES(?,?,?,?,?,?)").run(data.request_id, data.repository, data.author, data.number, data.received_at, JSON.stringify(data));
    return data;
  }
  private state(record: PRRecord, enrollment: Enrollment): void {
    const state = record.snapshot.state === "MERGED" ? "merged" : record.snapshot.state === "CLOSED" ? "closed_without_merge" : record.snapshot.state === "OPEN" ? "still_open" : null;
    if (!state) return;
    const previous = this.latest(enrollment.request_id, "state");
    if (previous?.state !== state) this.append(enrollment.request_id, "state", `${previous?.event_id ?? "initial"}:${state}`, { state, head: record.snapshot.head });
  }
  record(record: PRRecord): void {
    if (!this.eligible(record)) return;
    const h = this.enroll(record, record.handoff!.received_at >= this.startedAt); if (!h) return;
    this.state(record, h);
    if (record.snapshot.state !== "OPEN") {
      const rows = this.store.db.query("SELECT data FROM outcome_handoffs WHERE repository=? AND author=? AND number=?").all(h.repository, h.author, h.number) as any[];
      for (const row of rows) this.state(record, JSON.parse(row.data));
    }
    if (record.decision.kind === "human") {
      const category = record.mergeQueue?.terminal && !record.mergeQueue.terminal.acknowledged ? "merge_queue" : record.budgetDay ? "budget" : record.recovery ? "recovery" : record.assessment?.result?.category ?? (record.humanObservation?.promptId ? "agent_question" : null);
      this.append(h.request_id, "owner_decision", record.decision.id ?? hash([record.snapshot.head, record.decision.title, record.decision.question ?? record.decision.reason]), { category, head: record.snapshot.head });
    }
    if (!this.latest(h.request_id, "readiness") && readiness(record, this.config, this.store.all(), [], this.now()).ready) {
      const elapsed = this.now() - Date.parse(h.received_at);
      this.append(h.request_id, "readiness", "first", { head: record.snapshot.head, elapsed_ms: h.complete && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null });
    }
    if (record.job && record.job.kind !== "triage") this.repairRound(record, record.job, `start:${record.job.startedAt}`);
    const causes = this.store.db.query("SELECT data FROM outcomes WHERE request_id=? AND kind='ci_failure' AND json_extract(data,'$.head')=?").all(h.request_id, record.snapshot.head) as any[];
    for (const row of causes) {
      const cause = JSON.parse(row.data); if (!cause.source) continue;
      const original = { name: cause.check, status: "COMPLETED", conclusion: cause.conclusion, url: cause.url ?? "", source: cause.source, startedAt: cause.started_at ?? undefined };
      if (!currentChecks([...record.snapshot.checks, original]).includes(original)) this.append(h.request_id, "ci_superseded", cause.identity, { identity: cause.identity, head: cause.head });
    }
  }
  repairRound(record: PRRecord, job: Job, round: string): void {
    if (!this.eligible(record) || job.kind === "triage") return;
    const id = job.handoff?.request_id ?? record.handoff!.request_id;
    const h = this.enrollment(id); if (!h || !job.handoff && Date.parse(job.startedAt) < Date.parse(h.received_at)) return;
    const roundKey = `${id}:repair_round:${job.name}:${round}`;
    const previousRound = this.store.db.query("SELECT data FROM outcomes WHERE dedupe=?").get(roundKey) as any;
    const checks = currentChecks(record.snapshot.checks).filter(c => failed(c) && c.conclusion !== "CANCELLED" && !queueCheck(c)).map(c => ({ name: c.name.slice(0, 500), status: c.status, conclusion: c.conclusion, url: c.url, source: c.source, startedAt: c.startedAt }));
    const data = previousRound ? JSON.parse(previousRound.data) : { run: job.name, head: job.head, kind: job.kind ?? null, origin: job.contextReview ? "decision_context" : "repair", checks };
    this.store.db.query("INSERT OR IGNORE INTO outcome_runs VALUES(?,?,?)").run(job.name, id, JSON.stringify(data));
    this.append(id, "repair_round", `${job.name}:${round}`, data);
    const evidence = job.ciEvidence ?? record.assessment?.ciEvidence;
    for (const c of data.checks ?? []) {
      const report = evidence?.head === job.head ? evidence.reports.find(r => r.name === c.name && (!c.url || r.provider_url === c.url)) : undefined;
      const category = report?.test_failures.length ? "test_failure" : null;
      this.append(id, "ci_failure", hash([job.name, c.name, c.source, category]), { identity: hash([job.name, job.head, c.name, c.source]), run: job.name, head: job.head, check: c.name.slice(0, 500), conclusion: c.conclusion, source: c.source ?? null, started_at: c.startedAt ?? null, workflow: c.source?.workflow ?? null, workflow_run: c.source?.run ?? null, category, url: c.url || null });
    }
  }
  run(run: Run): void {
    const row = this.store.db.query("SELECT request_id FROM outcome_runs WHERE run=?").get(run.id) as any; if (!row || !this.enrollment(row.request_id)) return;
    const data = { run: run.id, state: run.state, model: run.model && run.model !== "No model" ? run.model : null, turns: Number.isFinite(run.turns) ? run.turns : null, estimated_cost_usd: typeof run.costUSD === "number" && Number.isFinite(run.costUSD) && !(run.model === "No model" && run.costUSD === 0) ? run.costUSD : null };
    this.append(row.request_id, "repair_run", hash(data), data);
  }
  triage(record: PRRecord, result: AssessmentResult): void {
    if (!this.eligible(record) || result.head !== record.snapshot.head) return;
    const h = this.enroll(record, false)!;
    for (const finding of result.review_threads ?? []) {
      if (finding.status !== "needs_repair") continue;
      const thread = record.snapshot.threads.find(t => t.id === finding.id); if (!thread) continue;
      const evidence = codeEvidence(finding.code_url, this.config.repository, result.head);
      const bot = thread.comments.length > 0 && thread.comments.every(c => c.authorType === "Bot");
      const kind = bot ? "bot" : thread.comments.some(c => c.authorType === "User") ? "human" : null;
      const data = { thread: finding.id, head: result.head, reviewer_kind: kind, reviewer: bot && thread.comments.some(c => /^posthog(?:\[bot\])?$/i.test(c.author)) ? "posthog_review" : kind, category: finding.category && findingCategories.includes(finding.category) ? finding.category : null, path: evidence?.path ?? repositoryPath(thread.path), reason: finding.reason.slice(0, 500), evidence_url: evidence?.url ?? null, source_run: record.assessment?.sourceJob?.name ?? null };
      this.append(h.request_id, "review_finding", hash(data), data);
    }
  }
  published(record: PRRecord, job: Job, result: { publishedHead?: string; playbook?: string }): void {
    const row = this.store.db.query("SELECT request_id FROM outcome_runs WHERE run=?").get(job.name) as any; if (!row || !this.enrollment(row.request_id) || !result.publishedHead) return;
    this.append(row.request_id, "publication", `${job.name}:${result.publishedHead}`, { run: job.name, published: true, head: result.publishedHead });
    if (result.playbook) this.audit("playbook-success", record.snapshot.number, { id: result.playbook, run: job.name, published_head: result.publishedHead });
  }
  notPublished(job: Job): void {
    const row = this.store.db.query("SELECT request_id FROM outcome_runs WHERE run=?").get(job.name) as any;
    if (row && this.enrollment(row.request_id)) this.append(row.request_id, "publication", `${job.name}:no-change`, { run: job.name, published: false, head: null });
  }
  audit(kind: string, _number: number, data: any): void {
    if (kind !== "playbook-success" || ![...deterministic, "fresh-git-cache"].includes(data.id)) return;
    const row = this.store.db.query("SELECT request_id FROM outcome_runs WHERE run=?").get(data.run) as any; if (!row || !this.enrollment(row.request_id)) return;
    this.append(row.request_id, "controller_repair", `${data.run}:${data.id}`, { run: data.run, category: data.id, head: data.published_head ?? null });
  }
  digest(since = "14d", limit = 50): any {
    const match = /^(\d+)(h|d|w)$/.exec(since); const duration = match ? Number(match[1]) * ({ h: 3600000, d: 86400000, w: 604800000 }[match[2]!] ?? 0) : 0;
    if (since.length > 16 || !Number.isSafeInteger(duration) || duration < 3600000 || duration > 3650 * 86400000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw Error("Use a duration such as 14d or 2w (1 hour to 10 years), and a limit from 1 to 200.");
    const actor = this.actor()?.toLowerCase();
    const response: any = { repository: this.config.repository, actor: actor ?? null, historical_context_only: true, since, since_at: new Date(this.now() - duration).toISOString(), totals: { prs_handed_off: null, merged: null, repair_rounds_per_pr: null, prs_needing_human: null, prs_ready_without_owner_decision: null }, coverage: { complete_prs: 0, partial_prs: 0 }, patterns: [], lessons: [], recent: [], truncated: false };
    if (!actor) { response.coverage = { identity_verified: false }; return response; }
    // Older handoffs have known PR state, but no claim of complete repair history.
    for (const row of this.store.db.query("SELECT data FROM handoffs").iterate() as Iterable<any>) {
      const h = JSON.parse(row.data) as Handoff; const r = this.store.get(h.number);
      if (r && h.repository.toLowerCase() === this.config.repository.toLowerCase() && r.snapshot.author?.toLowerCase() === actor) { const enrollment = this.enroll({ ...r, handoff: h }, false); if (enrollment) this.state(r, enrollment); }
    }
    const eligible = (this.store.db.query("SELECT data FROM outcome_handoffs WHERE repository=? AND author=? AND received_at>=? ORDER BY received_at DESC,request_id DESC").all(this.config.repository.toLowerCase(), actor, response.since_at) as any[]).map(row => JSON.parse(row.data) as Enrollment);
    const numbers = [...new Set(eligible.map(h => h.number))].slice(0, limit); const chosen = eligible.filter(h => numbers.includes(h.number));
    response.cohort = { matching_prs: new Set(eligible.map(h => h.number)).size, selected_prs: numbers.length, limit };
    const perPR = new Map(numbers.map(n => [n, { complete: true, state: null as string | null, ready: false, readyTime: Infinity, owners: [] as number[], rounds: 0 }]));
    const byID = new Map(chosen.map(h => [h.request_id, h])); const runs = new Map<string, any>(); const findings = new Map<string, any>(); const ci = new Map<string, any>(); const supersededCI = new Set<string>(); const recent = new Map<string, any>();
    for (const h of chosen) { perPR.get(h.number)!.complete &&= h.complete; recent.set(h.request_id, { request_id: h.request_id, source_session: h.source_session, pr_url: `https://github.com/${this.config.repository}/pull/${h.number}`, coverage_complete: h.complete, state: null, readiness_elapsed_ms: null, repairs: [] }); }
    if (chosen.length) for (const row of this.store.db.query(`SELECT request_id,kind,time,data FROM outcomes WHERE request_id IN (${chosen.map(() => "?").join(",")}) ORDER BY id`).iterate(...chosen.map(h => h.request_id)) as Iterable<any>) {
      const h = byID.get(row.request_id)!; const p = perPR.get(h.number)!; const d = JSON.parse(row.data); const entry = recent.get(h.request_id)!;
      if (row.kind === "state") { p.state = d.state; entry.state = d.state; }
      if (row.kind === "readiness") { p.ready = true; p.readyTime = Math.min(p.readyTime, Date.parse(row.time)); entry.readiness_elapsed_ms = d.elapsed_ms; }
      if (row.kind === "owner_decision") p.owners.push(Date.parse(row.time));
      if (row.kind === "review_finding") findings.set(`${h.request_id}:${d.thread}:${d.head}`, { ...d, number: h.number });
      if (row.kind === "ci_failure") ci.set(d.identity, { ...d, number: h.number });
      if (row.kind === "ci_superseded") supersededCI.add(d.identity);
      if (d.run) { const r = runs.get(d.run) ?? { run: d.run, number: h.number, request_id: h.request_id, rounds: 0, model: null, turns: null, estimated_cost_usd: null, published: null, controller: [] }; if (row.kind === "repair_round" && d.origin !== "decision_context") r.rounds++; if (row.kind === "repair_run") Object.assign(r, d); if (row.kind === "publication") r.published = d.published; if (row.kind === "controller_repair" && !r.controller.includes(d.category)) r.controller.push(d.category); runs.set(d.run, r); }
    }
    const controllerOnly = (run: any): boolean => !!run?.controller.some((c: string) => deterministic.has(c)) && !(run.turns > 0);
    for (const run of runs.values()) { if (!controllerOnly(run) && run.turns > 0) perPR.get(run.number)!.rounds += run.rounds; recent.get(run.request_id)?.repairs.push({ run: run.run, rounds: run.turns === null ? null : run.turns > 0 ? run.rounds : 0, model: run.model, published: run.published, estimated_cost_usd: run.estimated_cost_usd, controller_categories: run.controller }); }
    const groups = new Map<string, any>();
    const add = (key: string, data: any, number: number, evidence: any) => { const g = groups.get(key) ?? { id: hash(key).slice(0, 16), ...data, prs: new Set<number>(), paths: new Set<string>(), examples: [] }; g.prs.add(number); if (evidence.path) g.paths.add(evidence.path); if (evidence.url && !g.examples.some((e: any) => e.number === number) && g.examples.length < 3) g.examples.push({ number, head: evidence.head, url: evidence.url }); groups.set(key, g); };
    for (const f of findings.values()) {
      if (f.source_run && controllerOnly(runs.get(f.source_run))) continue;
      if (f.category) add(`review:category:${f.reviewer}:${f.category}`, { kind: "review", dimension: "category", reviewer: f.reviewer, reviewer_kind: f.reviewer_kind, category: f.category, path: null }, f.number, { path: f.path, url: f.evidence_url, head: f.head });
      if (f.path) add(`review:path:${f.path}`, { kind: "review", dimension: "path", reviewer: null, reviewer_kind: null, category: null, path: f.path }, f.number, { path: f.path, url: f.evidence_url, head: f.head });
    }
    for (const f of ci.values()) {
      if (supersededCI.has(f.identity) || controllerOnly(runs.get(f.run)) || !(runs.get(f.run)?.turns > 0) || !f.category) continue;
      add(`ci:${f.workflow}:${f.check}:${f.category}`, { kind: "ci", dimension: "category", category: f.category, check: f.check, workflow: f.workflow, path: null }, f.number, { head: f.head, url: /^[a-f0-9]{40}$/.test(f.head) ? `https://github.com/${this.config.repository}/commit/${f.head}` : null });
    }
    response.patterns = [...groups.values()].filter(g => g.prs.size >= 2).map(g => { const { prs, paths, ...rest } = g; return { ...rest, count: prs.size, paths: [...paths].sort().slice(0, 3), examples: g.examples }; }).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
    const all = [...perPR.values()]; const complete = all.every(p => p.complete);
    response.coverage = { complete_prs: all.filter(p => p.complete).length, partial_prs: all.filter(p => !p.complete).length };
    response.totals = { prs_handed_off: numbers.length, merged: all.some(p => p.state === null) ? null : all.filter(p => p.state === "merged").length, repair_rounds_per_pr: complete && all.length ? all.reduce((sum, p) => sum + p.rounds, 0) / all.length : null, prs_needing_human: complete ? all.filter(p => p.owners.length).length : null, prs_ready_without_owner_decision: complete ? all.filter(p => p.ready && !p.owners.some(t => t <= p.readyTime)).length : null };
    const agentRuns = [...runs.values()].filter(r => !controllerOnly(r) && r.turns > 0);
    response.totals.repair_runs = complete ? agentRuns.length : null;
    response.totals.controller_repairs = complete ? [...runs.values()].reduce((sum, r) => sum + r.controller.length, 0) : null;
    response.recent = [...recent.values()].slice(0, limit);
    const lessons = () => response.patterns.filter((p: any) => p.kind === "review").slice(0, 8).map((p: any) => { const who = p.reviewer === "posthog_review" ? "PostHog Review" : p.reviewer_kind === "human" ? "Human review" : p.reviewer_kind === "bot" ? "Automated review" : "Review"; return (p.dimension === "category" ? `${who} flagged ${labels[p.category as FindingCategory]} on ${p.count} of ${numbers.length} PRs.` : `Review findings needed repairs in ${p.path} on ${p.count} of ${numbers.length} PRs.`).slice(0, 200); });
    response.lessons = lessons();
    while (Buffer.byteLength(JSON.stringify(response)) > 16384 || Buffer.byteLength(JSON.stringify({ contents: [{ uri: "woodshed://outcomes?since=999999h", mimeType: "application/json", text: JSON.stringify(response) }] })) + 256 > 16384) { response.truncated = true; if (response.recent.length) response.recent.pop(); else if (response.patterns.length) { response.patterns.pop(); response.lessons = lessons(); } else break; }
    return response;
  }
}
