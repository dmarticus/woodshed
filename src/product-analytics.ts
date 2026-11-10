import { randomUUID } from "node:crypto";
import { Analytics, type AnalyticsProperties } from "./analytics";
import { modeOf, type Config, type Record as PRRecord, type Run } from "./model";
import type { Store } from "./store";
import { readiness } from "./readiness";

type PRState = { episode: string; enrolledAt: number; baseline: boolean; phase: string | null; active: boolean; decisions: number; decision?: string; decisionAt?: number; ready: boolean };
type RunState = { state: string; ended: boolean; revision: number; segment: number; cost: number; costKnown: boolean; baseline: boolean; kind: string; trigger: string; episode: string | null; startedAt: number };
export type ActionSource = "native_app" | "notification" | "mcp" | "automation";
const actions = new Set(["pause", "resume", "reply", "interrupt", "retry", "reviewer", "watch", "unwatch", "skip", "recheck", "topup", "stop", "confirm-reply", "discard-reply", "mark-ready", "mark-draft", "request-approval", "open_pr", "copy_pr_link", "refresh_all", "merge_on_github", "open_session"]);

/** Observe persisted facts once, regardless of whether a UI, an agent, or a poll caused them. */
export class ProductAnalytics {
  actionContext?: { action: string; source: ActionSource };
  constructor(readonly analytics: Analytics, readonly store: Store, readonly config: Config, readonly now: () => number) {
    if (!analytics.enabled) return;
    store.observer = { record: (record, previous) => this.record(record, previous), run: (run, previous) => this.run(run, previous) };
    for (const record of store.all()) this.record(record, record, true);
    for (const run of store.runs().filter(run => !run.endedAt)) this.run(run, run, true);
  }
  private properties(number: number): AnalyticsProperties {
    const state = this.analytics.state<PRState>(`pr:${number}`);
    return { pr_id: this.analytics.id(`pr:${number}`), episode_id: state?.episode ?? null, mode: modeOf(this.config) };
  }
  record(record: PRRecord, previous?: PRRecord, baseline = false): void {
    this.analytics.transaction(() => {
      const number = record.snapshot.number, pr = record.snapshot;
      const key = `pr:${number}`;
      let state = this.analytics.state<PRState>(key);
      const enrolled = pr.state === "OPEN" && !pr.draft && record.watching !== false;
      const handoff = !!record.handoff && record.handoff.id !== previous?.handoff?.id;
      const entryPoint = handoff ? "mcp" : this.actionContext?.source ?? (baseline ? "existing" : "discovery");
      if (!state && !enrolled) return;
      if (!state || !state.active && enrolled) {
        state = { episode: randomUUID(), enrolledAt: this.now(), baseline, phase: null, active: true, decisions: 0, ready: false };
        this.analytics.setState(key, state);
        this.analytics.capture("woodshed_pr_enrolled", { ...this.properties(number), entry_point: entryPoint, baseline: state.baseline });
      }
      const props = { ...this.properties(number), baseline: state.baseline };
      if (handoff) this.analytics.capture("woodshed_handoff_accepted", { ...props, source: "mcp" }, `handoff:${record.handoff!.id}`);
      const phase = pr.state === "MERGED" ? "merged" : pr.state !== "OPEN" ? "closed" : record.watching === false ? "unwatched" : pr.draft ? "draft" : record.paused || modeOf(this.config) === "paused" && !record.job ? "paused" : record.decision.kind === "human" ? "needs_human" : record.recovery?.retryAt ? "recovering" : record.job ? ["preparing", "running"].includes(this.store.run(record.job.name)?.state ?? "preparing") ? this.store.run(record.job.name)?.state ?? "preparing" : "waiting" : record.decision.kind === "ready" && readiness(record, this.config, this.store.all(), [], this.now()).ready ? "ready" : "waiting";
      const decision = enrolled && record.decision.kind === "human" ? record.decision.id : undefined;
      if (state.decision && state.decision !== decision) {
        this.analytics.capture("woodshed_attention_resolved", { ...props, decision_id: this.analytics.id(`decision:${state.decision}`), duration_ms: Math.max(0, this.now() - (state.decisionAt ?? this.now())), resolution: this.actionContext?.action ?? (phase === "merged" || phase === "closed" ? phase : "state_changed"), source: this.actionContext?.source ?? "automatic" });
        state.decision = undefined; state.decisionAt = undefined;
      }
      if (decision && state.decision !== decision) {
        const emitted = this.analytics.capture("woodshed_attention_raised", { ...props, decision_id: this.analytics.id(`decision:${decision}`), category: record.budgetDay ? "budget" : record.recovery ? "recovery" : record.assessment?.result?.category ?? "other" }, `attention:${state.episode}:${decision}`);
        if (emitted) state.decisions++;
        state.decision = decision; state.decisionAt = this.now();
      }
      if (phase !== state.phase) {
        this.analytics.capture("woodshed_pr_state_changed", { ...props, from_phase: state.phase, to_phase: phase, elapsed_ms: Math.max(0, this.now() - state.enrolledAt), human_decisions: state.decisions });
        state.phase = phase;
      }
      if (phase === "ready") {
        const emitted = this.analytics.capture("woodshed_pr_ready", { ...props, first_ready: !state.ready, elapsed_ms: Math.max(0, this.now() - state.enrolledAt), human_decisions: state.decisions, without_owner_decision: state.decisions === 0, repair_attempts: record.attempts }, `ready:${state.episode}:${pr.head}`);
        if (emitted) state.ready = true;
      }
      state.active = enrolled;
      this.analytics.setState(key, state);
    });
  }
  run(run: Run, previous?: Run, baseline = false): void {
    this.analytics.transaction(() => {
      const key = `run:${run.id}`;
      const record = this.store.get(run.number), job = record?.job?.name === run.id ? record.job : undefined;
      let state = this.analytics.state<RunState>(key);
      const ended = !!run.endedAt || ["succeeded", "failed", "stopped", "budget"].includes(run.state);
      if (!state) {
        state = { state: "", ended: false, revision: 0, segment: 0, cost: baseline ? run.costUSD ?? 0 : 0, costKnown: run.costUSD !== null, baseline: baseline || !!previous, kind: job?.kind ?? (run.id.startsWith("ws-triage-") ? "triage" : run.id.startsWith("jev-") ? "routing_check" : "repair"), trigger: job?.manual ? "manual" : "automatic", episode: this.analytics.state<PRState>(`pr:${run.number}`)?.episode ?? null, startedAt: Date.parse(run.startedAt) };
        const props = { ...this.properties(run.number), episode_id: state.episode, run_id: this.analytics.id(key), kind: state.kind, trigger: state.trigger, baseline: state.baseline, model: job?.model ?? run.model };
        this.analytics.capture("woodshed_run_started", props, `started:${run.id}`);
      }
      const props = { ...this.properties(run.number), episode_id: state.episode, run_id: this.analytics.id(key), kind: state.kind, trigger: state.trigger, model: run.model, baseline: state.baseline, cost_known: run.costUSD !== null };
      if (state.ended && !ended) { state.segment++; this.analytics.capture("woodshed_run_resumed", { ...props, segment: state.segment }); }
      if (state.state !== run.state || state.ended !== ended) {
        state.revision++;
        this.analytics.capture("woodshed_run_state_changed", { ...props, from_state: state.state || null, to_state: run.state, segment: state.segment });
        if (ended && !state.ended) this.analytics.capture("woodshed_run_finished", { ...props, state: run.state, segment: state.segment, duration_ms: Math.max(0, this.now() - state.startedAt), estimated_cost_usd: run.costUSD, turns: run.turns }, `finished:${run.id}:${state.revision}`);
      }
      if (run.costUSD !== null && Number.isFinite(run.costUSD) && (run.costUSD !== state.cost || !state.costKnown)) {
        this.analytics.capture("woodshed_run_cost_updated", { ...props, cost_usd_delta: run.costUSD - state.cost, cumulative_cost_usd: run.costUSD, baseline: false, cost_known: true });
        state.cost = run.costUSD;
      }
      if (run.costUSD === null && state.costKnown) this.analytics.capture("woodshed_run_cost_updated", { ...props, cost_usd_delta: 0, cumulative_cost_usd: null, baseline: false, cost_known: false });
      state.costKnown = run.costUSD !== null;
      state.state = run.state; state.ended = ended;
      this.analytics.setState(key, state);
      if (record) this.record(record, record);
    });
  }
  routingCheck(number: number, run: string, route: string, confidence: number, disagreement: boolean): void {
    this.analytics.transaction(() => this.analytics.capture("woodshed_jev_check", { ...this.properties(number), run_id: this.analytics.id(`run:${run}`), route, confidence_band: confidence < 0.5 ? "low" : confidence < 0.8 ? "medium" : "high", disagreement }));
  }
  action(number: number | undefined, action: string, source: ActionSource, failed = false, durationMs = 0): void {
    if (!actions.has(action)) return;
    this.analytics.transaction(() => this.analytics.capture(failed ? "woodshed_action_failed" : "woodshed_pr_action", { ...(number === undefined ? { pr_id: null, episode_id: null, mode: modeOf(this.config) } : this.properties(number)), action, source, duration_ms: Math.max(0, durationMs) }));
  }
  modeChanged(before: string): void {
    const mode = modeOf(this.config);
    if (before === mode) return;
    this.analytics.capture("woodshed_mode_changed", { from_mode: before, mode, source: "native_app" });
    for (const record of this.store.all()) this.record(record, record);
  }
  notification(action: string, number?: number): void {
    if (!["scheduled", "failed", "opened", "spend_settings", "permission_granted", "permission_denied"].includes(action)) return;
    this.analytics.transaction(() => this.analytics.capture("woodshed_notification", { ...(number === undefined ? {} : this.properties(number)), action, source: "notification" }));
  }
}
