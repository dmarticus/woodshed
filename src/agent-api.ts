import { createHash } from "node:crypto";
import type { Controller } from "./controller";
import { failed, modeOf } from "./model";
import { readiness, readinessSummary } from "./readiness";

export class AgentAPI {
  private waits = 0;
  constructor(readonly controller: Controller, readonly now: () => number = Date.now) {}
  status(number: number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Use a valid PR number");
    const record = this.controller.store.get(number);
    if (!record) throw new Error("PR is not watched by Woodshed. Use handoff-pr to enroll it.");
    const pr = record.snapshot;
    const run = record.job ? this.controller.store.run(record.job.name) : this.controller.store.runs().find(r => r.number === number);
    const mode = modeOf(this.controller.config);
    const report = this.readiness(number);
    const queue = this.controller.queueStatus(record);
    const phase = pr.state !== "OPEN" ? "closed" : !record.watching && record.watching !== undefined || record.paused || mode === "paused" && !record.job ? "paused" : record.decision.kind === "human" ? "needs_human" : record.recovery?.retryAt ? "recovering" : record.job && run?.state === "preparing" ? "preparing" : record.job && run?.state === "running" ? "running" : record.decision.kind === "ready" && report.ready ? "ready" : "waiting";
    const watching = mode === "watch" && !record.job && !["human", "ready", "closed"].includes(record.decision.kind);
    const owner = phase === "needs_human" || phase === "ready" ? "human" : phase === "closed" || phase === "paused" || watching ? "none" : ["running", "preparing", "recovering"].includes(phase) || ["fix", "review", "approval"].includes(record.decision.kind) ? "woodshed" : pr.reviewRequests?.length ? "reviewer" : "github";
    const data = {
      repository: this.controller.config.repository, number, url: pr.url, title: pr.title, head: pr.head, phase, mode,
      next_action: { owner, description: watching ? "Watch mode is monitoring this PR. Enable Auto in Woodshed to start maintenance." : record.decision.kind === "ready" && !report.ready ? report.reasons[0] : queue?.message ?? record.decision.question ?? record.decision.reason, action: record.decision.action ?? null, options: record.decision.options ?? [] },
      checks: { passed: pr.checks.filter(c => c.conclusion === "SUCCESS").length, failed: pr.checks.filter(failed).length, pending: pr.checks.filter(c => c.status !== "COMPLETED" || !c.conclusion).length, skipped: pr.checks.filter(c => c.conclusion === "SKIPPED").length },
      open_threads: pr.threads.length,
      run: run ? { id: run.id, state: run.state, step: run.summary, turns: run.turns, estimated_cost_usd: run.costUSD, budget_usd: run.budgetUSD ?? null, started_at: run.startedAt, ended_at: run.endedAt ?? null } : null,
      handoff: record.handoff ?? null,
      recovery: record.recovery ? { attempts: record.recovery.attempts, retry_at: record.recovery.retryAt ?? null } : null,
      last_error: record.lastError ?? null,
      dependency: record.stackWait ?? null,
      queue: queue ?? null,
      shared_ci: record.ciIncident ?? null,
      readiness: readinessSummary(report),
    };
    const { readiness: receipt, ...stable } = data;
    const version = createHash("sha256").update(JSON.stringify({ ...stable, readiness: { ready: receipt.ready, reasons: receipt.reasons, evidence: report.evidence } })).digest("hex");
    return { ...data, version, observed_at: record.observedAt ?? null, stale: !report.fresh };
  }
  readiness(number: number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Use a valid PR number");
    const record = this.controller.store.get(number);
    if (!record) throw new Error("PR is not watched by Woodshed");
    return readiness(record, this.controller.config, this.controller.store.all(), this.controller.store.runs(), this.now());
  }
  attention() {
    return { repository: this.controller.config.repository, items: this.controller.store.all().filter(r => r.snapshot.state === "OPEN" && r.watching !== false && !r.paused && r.decision.kind === "human").map(r => this.status(r.snapshot.number)) };
  }
  inbox() {
    return { repository: this.controller.config.repository, mode: modeOf(this.controller.config), health: this.controller.health(), prs: this.controller.store.all().filter(r => r.snapshot.state === "OPEN" && r.watching !== false).map(r => this.status(r.snapshot.number)) };
  }
  async wait(number: number, version: string, seconds: number, signal?: AbortSignal): Promise<{ changed: boolean; status: ReturnType<AgentAPI["status"]> }> {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{64}$/.test(version) || !Number.isFinite(seconds) || seconds < 0 || seconds > 25) throw new Error("Use a valid PR number, version, and timeout from 0 to 25 seconds");
    if (this.waits >= 32) throw new Error("Too many pending status waits. Retry after an existing wait completes.");
    if (signal?.aborted) throw new Error("Status wait canceled");
    this.waits++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true; unsubscribe(); clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.waits--;
        if (error) reject(error); else { try { const status = this.status(number); resolve({ changed: status.version !== version, status }); } catch (e) { reject(e); } }
      };
      const check = (): void => { try { if (this.status(number).version !== version) finish(); } catch (error) { finish(error); } };
      const cancel = (): void => finish(new Error("Status wait canceled"));
      const unsubscribe = this.controller.store.subscribe(check);
      const timer = setTimeout(() => finish(), seconds * 1000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel(); else check();
    });
  }
}
