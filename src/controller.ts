import { MergedDecisions, type DecisionRepository } from "./merged-decisions";
import { Outcomes, repositoryPath } from "./outcomes";
import { randomUUID } from "node:crypto";
import { approvalRequestState, hasRequestedApproval, stamphogRefused, decide, fingerprint, modeOf, repairResolved, failed, type Config, type Record, type Snapshot, type Job, type Run } from "./model";
import { localDay } from "./usage";
import { GitHub } from "./github";
import { Runner } from "./runner";
import { Store } from "./store";
import { assessmentKey } from "./triage";
import { bindDecision, sameQuestion, remainingRepairDecision } from "./decisions";
import { checkWithJev } from "./jev";
import { recoveryDelay, temporaryFailure, type Recovery } from "./recovery";
import { handoffSchema, type Handoff } from "./handoff";
import { stackBlock, stackOrder } from "./stack";
import { SharedCI } from "./ci-incidents";
import { Playbooks } from "./playbooks";
import type { Analytics } from "./analytics";
import { ProductAnalytics, type ActionSource } from "./product-analytics";
import { workerCapacity, dollarsDown, MIN_RUN_BUDGET, ADMISSION_INTERVAL_MS, type CapacityPolicy, type WorkerCapacity } from "./capacity";
import { ownerAttention, attentionStillNeeded } from "./owner-attention";
import { QueueSubmissionRejected, trackMergeQueue, mergeQueueDecision } from "./merge-queue";
import { queueSubmission } from "./merge-queue-readiness";
import { buildInfo } from "./build-info";

export class Controller {
  syncing = false;
  private dispatching = false;
  private lastAdmissionAt = -Infinity;
  private admitted(): void { this.lastAdmissionAt = this.now(); }
  private capacity(): WorkerCapacity { return this.resources(this.config.maxConcurrentJobs, { ...this.config, active: this.activeSlots() }); }
  private settling(): boolean { return this.config.concurrencyMode === "adaptive" && this.now() - this.lastAdmissionAt < ADMISSION_INTERVAL_MS; }
  acting = false;
  lastSync: string | null = null;
  error: string | null = null;
  refreshingAttention = false;
  lastContact: string | null = null;
  lastSleep: string | null = null;
  resumedAt: string | null = null;
  sleeping = false;
  health() {
    const records = this.store.all();
    return { build: buildInfo, scheduler: { ...this.capacity(), mode: this.config.concurrencyMode ?? "fixed", cpuTargetPercent: this.config.cpuTargetPercent ?? 80, memoryTargetPercent: this.config.memoryTargetPercent ?? 80, configured: this.config.maxConcurrentJobs }, remote: process.env.WOODSHED_REMOTE === "1", lastPoll: this.lastSync, lastContact: this.lastContact, queueDepth: records.filter(r => !mergeQueueDecision(r) && (r.decision.kind === "fix" || r.assessment && !r.assessment.result || r.recovery?.retryAt && r.decision.kind === "waiting")).length, activeRuns: this.activeSlots(), githubError: this.github.authenticationError ?? null, lastSleep: this.lastSleep, resumedAt: this.resumedAt, sleeping: this.sleeping, analytics: this.analytics?.status() ?? { enabled: false, queued: 0, quarantined: 0, lastError: null } };
  }
  power(event: "sleep" | "wake", confirmed = true): void {
    if (process.env.WOODSHED_REMOTE === "1" && confirmed) return;
    const time = new Date().toISOString();
    this.sleeping = event === "sleep";
    if (event === "sleep") this.lastSleep = time; else this.resumedAt = time;
    for (const record of this.store.all().filter(r => r.job)) {
      const run = this.store.run(record.job!.name);
      if (confirmed && run && ["running", "preparing"].includes(run.state) && !run.endedAt) record.sleepInterruptedAt = time;
      else if (!run || run.endedAt) record.sleepInterruptedAt = undefined;
      this.store.put(record);
    }
    this.store.log(null, event === "sleep" ? "Jobs paused while the Mac is asleep" : confirmed ? "Mac resumed; checking active runs against GitHub" : "Controller connection resumed; checking active runs");
  }
  private locks = new Map<number, Promise<unknown>>();
  async handoff(input: unknown): Promise<{ handoff: Handoff; replayed: boolean }> {
    const parsed = handoffSchema.parse(input);
    if (parsed.repository.toLowerCase() !== this.config.repository.toLowerCase()) throw new Error("This repository is not watched by Woodshed");
    return this.withPR(parsed.number, async () => {
      const existing = this.store.handoff(parsed.request_id);
      if (existing) {
        const { id, received_at, ...original } = existing;
        if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error("This request_id belongs to a different handoff");
        return { handoff: existing, replayed: true };
      }
      const snapshot = await this.github.snapshot(parsed.number);
      if (snapshot.head !== parsed.head) throw new Error("The PR head changed. Hand off the current GitHub head instead.");
      if (snapshot.state !== "OPEN" || snapshot.draft) throw new Error("Only open PRs marked ready for review can be handed off");
      if (!await this.github.canMaintain(snapshot)) throw new Error("Woodshed only maintains your own PRs");
      const record: Record = this.store.get(parsed.number) ?? { snapshot, paused: false, attempts: 0, fingerprint: fingerprint(snapshot), decision: { kind: "waiting", reason: "Checking the handed-off PR" } };
      const handoff: Handoff = { ...parsed, id: randomUUID(), received_at: new Date().toISOString() };
      record.snapshot = snapshot; record.observedAt = handoff.received_at; record.handoff = handoff; record.watching = true;
      if (!record.job && !record.humanHead) record.decision = decide(snapshot, record);
      this.store.acceptHandoff(record, handoff);
      this.store.audit("handoff", parsed.number, { id: handoff.id, head: handoff.head, source_session: handoff.source_session });
      return { handoff, replayed: false };
    });
  }
  readonly outcomes: Outcomes;
  readonly decisions: MergedDecisions;
  readonly incidents: SharedCI;
  readonly playbooks: Playbooks;
  readonly telemetry?: ProductAnalytics;
  constructor(readonly config: Config, readonly store: Store, readonly github: GitHub, readonly runner: Runner, readonly now: () => number = Date.now, readonly analytics?: Analytics, readonly resources: (configured: number, policy?: CapacityPolicy) => WorkerCapacity = workerCapacity, decisionRepository: DecisionRepository = github) {
    this.outcomes = new Outcomes(store, config, () => github.viewerName, now);
    this.decisions = new MergedDecisions(store, config, decisionRepository, () => github.viewerName, now);
    store.localHistory = { record: r => { this.outcomes.record(r); this.decisions.observe(r); }, run: r => this.outcomes.run(r), audit: (kind, number, data) => this.outcomes.audit(kind, number, data) };
    runner.decisionContextFor = async (pr, paths, job) => {
      if (!this.decisions.hasHistory()) return { records: [], omitted_records: 0 };
      const scope = paths ?? [...await decisionRepository.changedFiles(pr.number).catch(() => []), ...pr.threads.flatMap(t => t.path ? [t.path] : []), ...(job?.ciEvidence?.reports.flatMap(r => r.annotations.map(a => a.path)) ?? [])];
      return this.decisions.forPaths(scope.filter(path => path.length <= 500 && repositoryPath(path) !== null), true);
    };
    this.incidents = new SharedCI(github, store, now); this.playbooks = new Playbooks(store); runner.onProgress = run => store.saveRun(run);
    if (analytics) this.telemetry = new ProductAnalytics(analytics, store, config, now);
  }
  async prepareAttention(): Promise<void> {
    if (modeOf(this.config) !== "auto" || !this.runner.launchTriage) return;
    for (const record of this.store.all().filter(r => r.decision.kind === "human" && !r.assessment && !r.budgetDay && !r.paused && r.watching !== false && r.snapshot.state === "OPEN" && !r.snapshot.draft)) {
      try {
        await this.refreshHuman(record);
        if (record.humanHead || !record.job) await this.queueAssessment(record, record.decision.reason);
        else record.decision = { kind: "waiting", reason: "Agent continued; checking its result" };
        this.store.put(record);
      } catch (error) { this.store.log(record.snapshot.number, `Could not prepare attention investigation: ${String(error)}`); }
    }
  }
  private async withPR<T>(number: number, work: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(number) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(number, task);
    try { return await task; } finally { if (this.locks.get(number) === task) this.locks.delete(number); }
  }
  async refreshMergeQueues(): Promise<void> {
    if (this.acting || this.budgetChecking || this.sleeping) return;
    for (const record of this.store.all().filter(r => r.snapshot.state === "OPEN" && r.watching !== false && (r.mergeQueue?.active || r.mergeQueue?.terminal && !r.mergeQueue.terminal.acknowledged))) {
      if (this.locks.has(record.snapshot.number)) continue;
      try { await this.withPR(record.snapshot.number, async () => { await this.reconcile(await this.github.snapshot(record.snapshot.number), true); }); }
      catch (error) { this.store.log(record.snapshot.number, `Queue refresh deferred: ${String(error).slice(0, 300)}`); }
    }
  }
  async refreshAttention(): Promise<void> {
    if (this.refreshingAttention || this.acting || this.budgetChecking) return;
    this.refreshingAttention = true;
    try {
      const records = this.store.all().filter(r => r.decision.kind === "human" || r.humanHead !== undefined);
      for (const record of records) {
        try { await this.withPR(record.snapshot.number, async () => { await this.reconcile(await this.github.snapshot(record.snapshot.number), true); }); }
        catch (error) {
          const latest = this.store.get(record.snapshot.number);
          if (latest) { latest.lastError = error instanceof Error ? error.message : String(error); this.store.put(latest); }
        }
      }
    } finally { this.refreshingAttention = false; }
  }
  async sync(): Promise<void> {
    if (this.syncing || this.dispatching || this.acting || this.budgetChecking || this.sleeping) return;
    this.syncing = true; this.error = null;
    try {
      const attention = this.store.all().filter(r => r.decision.kind === "human").map(r => r.snapshot.number);
      const numbers = stackOrder([...new Set([...attention, ...await this.github.list(), ...this.store.all().filter(r => r.snapshot.state === "OPEN").map(r => r.snapshot.number)])], this.store.all());
      try { await this.github.prepareBatch?.(numbers); }
      catch (error) {
        if (this.github.authenticationError || /rate limit/i.test(String(error))) throw error;
        this.store.log(null, `Batch refresh unavailable; checking PRs individually: ${String(error).slice(0, 300)}`);
      }
      for (const number of numbers) {
        try { await this.withPR(number, async () => { await this.reconcile(await this.github.snapshot(number)); }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const r = this.store.get(number);
          if (r) { r.lastError = message; this.store.put(r); }
          this.store.log(number, message);
          this.error = message;
        }
      }
      this.lastSync = new Date().toISOString();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.syncing = false; }
  }
  async fillWorkers(): Promise<void> {
    if (this.dispatching || this.acting || this.budgetChecking || this.sleeping || modeOf(this.config) === "paused" || this.settling()) return;
    if (this.activeSlots() >= this.parallelLimit()) return;
    const records = this.store.all();
    const canFundStart = this.budgetAvailable() >= MIN_RUN_BUDGET;
    const eligible = records.filter(r => !this.locks.has(r.snapshot.number) && !r.paused && r.watching !== false && r.snapshot.state === "OPEN" && !r.snapshot.draft && !r.assessment?.attention && !mergeQueueDecision(r) && r.decision.kind !== "human" &&
      (modeOf(this.config) === "auto" || r.runRequested || r.assessment?.allowWatch || r.pendingReply || r.resumeRequested) &&
      (!r.recovery?.retryAt || Date.parse(r.recovery.retryAt) <= this.now()) && !stackBlock(r.snapshot, records, false) &&
      (r.pendingReply || r.resumeRequested || canFundStart && !r.job && (r.decision.kind === "fix" || r.assessment && (!r.assessment.result || r.assessment.result.route === "repair" && r.assessment.followups < 2))));
    if (!eligible.length) return;
    this.dispatching = true;
    let work: Promise<void>;
    try {
      const number = stackOrder(eligible.map(r => r.snapshot.number), records)[0]!;
      work = this.withPR(number, async () => { await this.reconcile(await this.github.snapshot(number)); });
    } finally { this.dispatching = false; }
    // Preparation can fetch a large checkout. Its PR lock and persisted budget
    // reservation remain held, while later ticks can admit other independent PRs.
    try { await work; } catch (error) { this.error = String(error); }
  }
  private async refreshHuman(record: Record): Promise<void> {
    if (record.humanHead === undefined) return;
    const snapshot = record.snapshot;
    const obsolete = snapshot.state !== "OPEN" || snapshot.draft || record.watching === false || record.humanHead !== snapshot.head;
    const resolved = !this.runner.launchTriage && !record.job?.instructions && !record.runRequested && repairResolved(snapshot, record.job?.fingerprint ?? record.fingerprint);
    if (obsolete || resolved) {
      if (record.job) {
        await this.runner.stop(record.job);
        await this.finishRun(record.job, snapshot.number, "stopped", obsolete ? "Question superseded by the current PR state" : "Original repair blockers resolved on GitHub; no input needed");
        record.job = undefined;
      }
      record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
      record.pendingReply = undefined; record.pendingPromptId = undefined; record.budgetDay = undefined;
      this.store.log(snapshot.number, obsolete ? "Cleared a superseded attention item" : "Cleared attention: original blockers resolved on GitHub");
      return;
    }
    if (!record.job || !this.runner.observe) return;
    const observation = await this.runner.observe(record.job);
    if (observation.state === "working" || observation.state === "done" && ["blocked", "error"].includes(record.humanObservation?.state ?? "")) {
      record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
      this.store.log(snapshot.number, "Agent continued outside Woodshed; cleared the answered decision");
    } else if (observation.state === "blocked" && observation.promptId !== record.humanObservation?.promptId) {
      record.humanReason = observation.summary; record.humanObservation = observation;
    }
  }
  async reconcile(snapshot: Snapshot, observeOnly = false): Promise<void> {
    const prior = this.store.get(snapshot.number);
    const previousKind = prior?.decision.kind;
    const previousHead = prior?.snapshot.head;
    const previousDecisionContext = prior?.decision.context;
    const record: Record = prior ?? { snapshot, decision: { kind: "waiting", reason: "Checking PR" }, paused: false, attempts: 0, fingerprint: "" };
    // Upgrade already-visible verified escalations using their previous snapshot
    // before replacing it with fresh GitHub data. Raw worker reports aren't latched.
    const assessment = record.assessment;
    const verified = assessment?.result;
    if (assessment && !assessment.attention && verified && record.decision.kind === "human" &&
      (verified.route === "ask" && record.decision.title === verified.title || verified.route === "repair" && assessment.followups >= 2 && record.decision.response === "retry")) {
      assessment.attention = ownerAttention(record.snapshot, verified, record.decision);
    }
    record.snapshot = snapshot;
    record.observedAt = new Date(this.now()).toISOString();
    this.playbooks.confirm(snapshot);
    this.lastContact = new Date().toISOString();
    if (snapshot.state !== "OPEN") record.closedAt ??= new Date().toISOString(); else record.closedAt = undefined;
    record.lastError = undefined;
    if (this.sleeping && !observeOnly) { record.decision = { kind: "waiting", reason: "Waiting for the Mac to wake" }; this.store.put(record); return; }
    if (record.recovery?.head !== snapshot.head) record.recovery = undefined;
    const leader = record.mergeQueue?.owner && record.mergeQueue.owner !== snapshot.number ? this.store.get(record.mergeQueue.owner)?.mergeQueue : undefined;
    const grouped = leader && leader.groupId === record.mergeQueue?.groupId;
    const queueObservation = grouped ? { provider: leader.provider, state: leader.state, revision: `group:${leader.revision}`, url: leader.url, reason: leader.reason, updatedAt: leader.updatedAt, error: leader.error } : this.github.mergeQueue ? await this.github.mergeQueue(snapshot) : snapshot.mergeQueue;
    snapshot.mergeQueue = queueObservation;
    trackMergeQueue(record, queueObservation, this.now());
    if (grouped && record.mergeQueue?.terminal) record.mergeQueue.terminal.acknowledged = true;
    const queueDecision = !snapshot.draft && (record.mergeQueue?.active || !record.paused && record.watching !== false) && mergeQueueDecision(record);
    if (queueDecision) {
      if (record.job) await this.queueAssessment(record, "PR entered the merge queue. Agent stopped; saved checkout and edits retained.");
      if (previousKind !== queueDecision.kind || previousHead !== snapshot.head || previousDecisionContext !== queueDecision.context) record.stateSince = new Date(this.now()).toISOString();
      record.decision = queueDecision; this.store.put(record); return;
    }
    if (await this.recover(record, observeOnly)) { this.store.put(record); return; }
    if (record.assessment?.result?.category === "operations" && record.assessment.head !== snapshot.head && snapshot.state === "OPEN") {
      record.assessment = { ...record.assessment, head: snapshot.head, key: "", result: undefined, attention: undefined, attempts: 0, jevChecked: false };
    }
    if (record.assessment && (record.assessment.head !== snapshot.head || snapshot.state !== "OPEN" || snapshot.draft || record.watching === false)) record.assessment = undefined;
    if (!record.assessment) await this.refreshHuman(record);
    if (record.budgetDay && (record.budgetDay !== localDay() || this.budgetAvailable() > 0 && (this.config.runCapUSD ?? 5) > 0)) {
      record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined; record.budgetDay = undefined;
    }
    if (record.job && (snapshot.state !== "OPEN" || snapshot.draft || record.watching === false)) {
      await this.runner.stop(record.job);
      await this.finishRun(record.job, snapshot.number, "stopped", "Stopped because the PR is no longer being maintained");
      record.job = undefined;
      record.pendingReply = undefined; record.pendingPromptId = undefined;
      record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
    }
    if (record.job && this.runner.telemetry) {
      const run = await this.runner.telemetry(record.job);
      if (run) { this.store.saveRun(run); if (record.sleepInterruptedAt && run.updatedAt && Date.parse(run.updatedAt) > Date.parse(this.resumedAt ?? record.sleepInterruptedAt)) record.sleepInterruptedAt = undefined; }
    }
    if (!observeOnly && record.resumeRequested && record.job && this.activeSlots(snapshot.number) < this.parallelLimit() && modeOf(this.config) !== "paused") {
      try { this.admitted(); await this.runner.resume(record.job, record.resumeRequested); }
      catch (error) {
        const instructions = record.resumeRequested;
        this.scheduleRecovery(record, "resume", String(error)); record.recovery!.instructions = instructions;
        record.resumeRequested = undefined; this.store.put(record); return;
      }
      record.resumeRequested = undefined; record.job.startedAt = new Date().toISOString();
      const resumed = this.store.run(record.job.name);
      if (resumed) { resumed.state = "running"; resumed.endedAt = undefined; resumed.prompt = undefined; this.store.saveRun(resumed); }
    }
    if (!observeOnly && record.pendingReply && record.job && this.activeSlots(snapshot.number) < this.parallelLimit() && modeOf(this.config) !== "paused") {
      this.admitted(); record.job.afterTurn = await this.runner.send(record.job, record.pendingReply, record.pendingPromptId);
      record.job.startedAt = new Date().toISOString();
      record.pendingReply = undefined; record.pendingPromptId = undefined;
      record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
    }
    const currentFingerprint = fingerprint(snapshot);
    if (record.fingerprint !== currentFingerprint) { record.attempts = 0; record.fingerprint = currentFingerprint; }
    if (!observeOnly && record.job && !record.resumeRequested && record.humanHead !== snapshot.head) {
      const result = await this.runner.status(record.job, snapshot);
      if (record.job.kind === "triage" && result.state !== "working") {
        const job = record.job;
        await this.runner.stop(job);
        await this.finishRun(job, snapshot.number, result.state === "triaged" ? "succeeded" : "failed", result.assessment?.title ?? "GitHub investigation did not complete");
        record.job = undefined;
        if (record.assessment && result.state === "triaged" && result.assessment?.head === snapshot.head) {
          record.assessment.result = result.assessment;
          this.outcomes.triage(record, result.assessment);
          this.store.audit("triage-outcome", snapshot.number, { assessmentId: record.assessment.id, head: snapshot.head, job: job.name, route: result.assessment.route, followups: record.assessment.followups });
          record.assessment.key = assessmentKey(snapshot);
          if (!record.assessment.jevChecked && this.budgetAvailable() >= 0.01) {
            record.assessment.jevChecked = true;
            try {
              const verdict = await checkWithJev(snapshot, result.assessment);
              if (verdict) {
                this.store.audit("jev-verdict", snapshot.number, { head: snapshot.head, assessmentId: record.assessment.id, assessment: job.name, proposed: result.assessment.route, verdict, disagreement: verdict.choice !== result.assessment.route });
                this.telemetry?.routingCheck(snapshot.number, `jev-${job.name}`, verdict.choice, verdict.confidence, verdict.choice !== result.assessment.route);
                this.store.log(snapshot.number, `Jev routing: ${verdict.choice}; investigation: ${result.assessment.route}; confidence ${verdict.confidence.toFixed(2)}`);
                const now = new Date().toISOString();
                this.store.saveRun({ id: `jev-${job.name}`, number: snapshot.number, startedAt: now, endedAt: now, state: "succeeded", model: verdict.model, turns: 1, costUSD: verdict.costUSD, costsByDay: { [localDay()]: verdict.costUSD }, summary: `Routing check: ${verdict.choice} (${verdict.confidence.toFixed(2)})` });
                if (verdict.choice !== result.assessment.route && verdict.confidence >= 0.9 && record.assessment.attempts < 2) {
                  record.assessment.result = undefined;
                  record.assessment.report += `\nIndependent routing check suggested ${verdict.choice}. Verify the disagreement against GitHub; preserve real operational/visual prerequisites. Previous investigation: ${JSON.stringify(result.assessment)}`;
                }
              }
            } catch { this.store.log(snapshot.number, "Optional TypeSafe routing check unavailable; using the GitHub investigation"); }
          }
        }
      } else if (result.state === "decision-context") {
        record.resumeRequested = result.reason;
        record.decision = { kind: "waiting", reason: "Reviewing historical tradeoffs before publishing" };
        const run = this.store.run(record.job.name);
        if (run) { run.state = "waiting"; run.endedAt = undefined; this.store.saveRun(run); }
        this.store.put(record); return;
      } else if ((result.state === "human" || result.state === "completed") && this.runner.launchTriage) {
        if (result.state === "completed") this.outcomes.notPublished(record.job);
        await this.queueAssessment(record, result.reason ?? "Run completed; verify any remaining blocker");
      } else if (result.state === "human") {
        record.humanHead = snapshot.head; record.humanReason = result.reason;
        record.humanObservation = await this.runner.observe?.(record.job);
      } else if (result.state === "published") {
        this.playbooks.published(snapshot.number, record.job, result);
        this.outcomes.published(record, record.job, result);
        this.store.log(snapshot.number, result.reason ?? "Agent published changes");
        await this.finishRun(record.job, snapshot.number, "succeeded", result.reason ?? "Run completed");
        record.job = undefined;
        this.store.put(record);
        return;
      } else if (result.state === "superseded") {
        this.store.log(snapshot.number, result.reason ?? "Branch changed; refreshing the repair plan");
        await this.finishRun(record.job, snapshot.number, "stopped", result.reason ?? "Branch changed while the run was working");
        record.job = undefined;
        record.attempts = Math.max(0, record.attempts - 1);
        record.decision = { kind: "waiting", reason: "Branch changed; refreshing the repair plan" };
        this.store.put(record);
        return;
      }
    }
    record.decision = decide(snapshot, record);
    if (record.runRequested && !record.paused && snapshot.state === "OPEN" && !snapshot.draft)
      record.decision = { kind: "fix", reason: "Repair requested by you" };
    if (record.humanHead === snapshot.head && !record.paused && !snapshot.draft && snapshot.state === "OPEN") record.decision = { kind: "human", reason: record.humanReason ?? "Agent needs input" };
    if (record.resumeRequested) record.decision = { kind: "waiting", reason: "Saved run queued to continue" };
    if (record.pendingReply) record.decision = { kind: "waiting", reason: "Your reply is queued until a run slot is available" };
    if (record.decision.kind === "fix" && record.attempts >= this.config.maxAttempts)
      record.decision = { kind: "human", reason: `${record.attempts} attempts without clearing this feedback. Inspect before retrying.` };
    if (await this.assess(record, observeOnly)) {
      if (!record.stateSince || previousKind !== record.decision.kind || previousHead !== snapshot.head) record.stateSince = new Date().toISOString();
      bindDecision(record);
      if (record.pendingAnswer && record.decision.kind === "human") {
        const candidate = record.pendingAnswer;
        if (sameQuestion(record.decision, candidate.questionKey) && record.assessment?.result?.route === "ask") {
          record.assessment.reply = candidate.text; record.assessment.attention = undefined; record.assessment.result = undefined; record.assessment.attempts = 0;
          record.pendingAnswer = undefined; record.decision = { kind: "waiting", reason: "Your answer still applies; checking the updated PR" };
        } else candidate.requiresConfirmation = true;
      }
      this.store.put(record); return;
    }
    record.stackWait = !record.job && ["fix", "ready"].includes(record.decision.kind) ? stackBlock(snapshot, this.store.all(), record.decision.kind === "ready") : undefined;
    if (record.stackWait) {
      record.decision = { kind: "waiting", reason: record.stackWait.reason };
      this.store.put(record); return;
    }
    if (!snapshot.checks.some(c => ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR"].includes(c.conclusion ?? "")) || record.ciIncident?.head !== snapshot.head) record.ciIncident = undefined;
    if (!observeOnly && !record.job && record.decision.kind === "fix" && snapshot.mergeable === "MERGEABLE" && snapshot.mergeStateStatus !== "BEHIND" && !snapshot.threads.length && modeOf(this.config) === "auto" && !record.paused && record.watching !== false && (!this.github.canMaintain || await this.github.canMaintain(snapshot))) {
      try { record.ciIncident = await this.incidents.inspect(snapshot); }
      catch (error) { this.store.log(snapshot.number, `Could not verify a shared CI failure: ${String(error)}`); }
      if (record.ciIncident && this.now() < Date.parse(record.ciIncident.retry_until)) {
        record.decision = { kind: "waiting", reason: `${record.ciIncident.label} across ${record.ciIncident.related_prs.length} PRs. Waiting for fresh CI before editing code.` };
        this.store.put(record); return;
      }
    }
    if (!observeOnly && (modeOf(this.config) === "auto" || record.runRequested) && modeOf(this.config) !== "paused" && !record.paused && record.watching !== false && record.skippedHead !== snapshot.head && !snapshot.draft && snapshot.state === "OPEN") {
      if (this.github.canMaintain && !await this.github.canMaintain(snapshot)) {
        record.decision = { kind: "waiting", reason: "Waiting for your review; Auto only changes your own PRs" };
        record.runRequested = false; this.store.put(record); return;
      }
      if (record.decision.kind === "review" && record.requestedReview !== snapshot.head) {
        await this.github.label(snapshot.number, this.config.reviewLabel);
        record.requestedReview = snapshot.head;
        this.store.log(snapshot.number, "Requested PostHog Review");
      } else if (record.decision.kind === "approval" && !hasRequestedApproval(record, snapshot.head)) {
        try {
          if (await this.requestStamphog(record, snapshot.head)) this.telemetry?.action(snapshot.number, "request-approval", "automation");
        } catch (error) { this.telemetry?.action(snapshot.number, "request-approval", "automation", true); throw error; }
      } else if (record.decision.kind === "fix" && !record.job && this.activeSlots() < this.parallelLimit()) {
        const available = this.config.workerProtocol ? this.launchBudget(this.config.runCapUSD ?? 5, snapshot.number) : Infinity;
        const limit = this.config.runCapUSD ?? 5;
        if (available < MIN_RUN_BUDGET || limit <= 0) {
          const reached = this.store.spent(localDay()) >= (this.config.dailyCapUSD ?? 20) || limit <= 0 || this.store.spend(this.config.dailyCapUSD ?? 20).unknownRuns > 0;
          record.decision = { kind: reached ? "human" : "waiting", reason: reached ? "Spend limit reached or usage is unavailable. Review Spend settings before starting another run." : "Waiting for a run budget to free up" };
          if (reached) { record.humanHead = snapshot.head; record.humanReason = record.decision.reason; record.budgetDay = localDay(); }
          this.store.put(record); return;
        }
        record.job = { name: `ws-${snapshot.number}-${randomUUID().slice(0, 8)}`, head: snapshot.head, fingerprint: currentFingerprint, startedAt: new Date().toISOString(), manual: record.runRequested, kind: snapshot.mergeable === "CONFLICTING" || snapshot.mergeStateStatus === "BEHIND" ? "branch-update" : "repair", instructions: record.instructions, model: record.requestedModel || (record.attempts > 0 && this.config.escalateOnRetry ? this.config.retryModel : this.config.defaultModel), budgetUSD: Math.min(limit, available), freshCheckout: record.recovery?.freshCheckout, handoff: record.handoff };
        record.job.repairHints = this.playbooks.hints(snapshot);
        record.requestedModel = undefined;
        record.runRequested = false;
        record.instructions = undefined;
        record.attempts++;
        this.store.put(record);
        this.admitted(); this.store.saveRun(this.initialRun(record.job, snapshot.number));
        try {
          if (record.job.kind === "repair" && this.github.failureEvidence) { record.job.ciEvidence = await this.github.failureEvidence(snapshot); this.store.put(record); }
          await this.runner.launch(snapshot, record.job);
          for (const id of record.job.playbooksApplied ?? []) this.playbooks.applied(snapshot.number, record.job, id);
        }
        catch (error) {
          if (this.runner.health && await this.recover(record, true, error)) { this.store.put(record); return; }
          record.humanHead = snapshot.head;
          record.humanObservation = undefined;
          record.humanReason = `Could not confirm job startup. Inspect before retrying: ${error instanceof Error ? error.message : error}`;
          record.decision = { kind: "human", reason: record.humanReason };
          await this.finishRun(record.job, snapshot.number, "failed", record.humanReason);
          this.store.put(record);
          return;
        }
        record.decision = { kind: "waiting", reason: record.job.kind === "branch-update" ? "Automatically resolving conflicts and updating the PR branch" : "Coding agent is working" };
        this.store.log(snapshot.number, `Started ${record.job.name}`);
      }
    }
    if (previousKind !== record.decision.kind) this.store.log(snapshot.number, record.decision.reason);
    if (!record.stateSince || previousKind !== record.decision.kind || previousHead !== snapshot.head) record.stateSince = new Date().toISOString();
    this.store.put(record);
  }
  private scheduleRecovery(record: Record, kind: Recovery["kind"], reason: string): void {
    const previous = record.recovery?.head === record.snapshot.head ? record.recovery : undefined;
    const attempts = (previous?.attempts ?? 0) + 1;
    record.recovery = { head: record.snapshot.head, attempts, kind, reason, retryAt: new Date(this.now() + recoveryDelay(attempts)).toISOString(), freshCheckout: previous?.freshCheckout || /promisor remote|not our ref/i.test(reason), instructions: previous?.instructions };
    record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
    record.sleepInterruptedAt = undefined; record.lastError = undefined;
    record.decision = attempts > 3 ? { kind: "human", title: "Retry recovery", reason: "Woodshed could not restore this run after three retries. Existing files are preserved. Retry recovery to try again." } : { kind: "waiting", reason: kind === "prepare" ? "Restoring the checkout before retrying" : "Reconnecting the saved run" };
    this.store.log(record.snapshot.number, `Recovery ${attempts}: ${kind}: ${reason}`);
  }
  private async recover(record: Record, observeOnly: boolean, launchError?: unknown): Promise<boolean> {
    if (!this.runner.health) return false;
    const pr = record.snapshot;
    if (record.resumeRequested) { record.recovery = undefined; record.sleepInterruptedAt = undefined; return false; }
    if (record.paused && record.recovery) { record.decision = { kind: "paused", reason: "Recovery paused by you" }; return true; }
    if (pr.state !== "OPEN" || pr.draft || record.watching === false || record.skippedHead === pr.head) {
      record.recovery = undefined; record.sleepInterruptedAt = undefined; return false;
    }
    const recovery = record.recovery;
    if (recovery?.retryAt) {
      if (recovery.attempts > 3) {
        record.decision = { kind: "human", title: "Retry recovery", reason: "Woodshed could not restore this run after three retries. Existing files are preserved. Retry recovery to try again." }; return true;
      }
      record.decision = { kind: "waiting", reason: recovery.kind === "prepare" ? "Restoring the checkout before retrying" : "Reconnecting the saved run" };
      if (observeOnly || this.sleeping || this.now() < Date.parse(recovery.retryAt) || modeOf(this.config) === "paused" || modeOf(this.config) !== "auto" && !record.runRequested && !record.job?.manual) return true;
      if (recovery.kind === "prepare") { recovery.retryAt = undefined; return false; }
    }
    const job = record.job;
    if (!job) { record.sleepInterruptedAt = undefined; return false; }
    let health;
    try { health = await this.runner.health(job); }
    catch (error) {
      if (!temporaryFailure(error)) throw error;
      this.scheduleRecovery(record, "probe", String(error)); return true;
    }
    record.sleepInterruptedAt = undefined;
    if (health.state === "complete" || health.state === "live") {
      if (recovery?.kind === "probe") record.recovery = undefined;
      else if (recovery) recovery.retryAt = undefined;
      if (launchError) {
        record.humanHead = undefined; record.humanReason = undefined;
        record.decision = { kind: "waiting", reason: "Confirmed the original run started; checking its progress" };
        return true;
      }
      return false;
    }
    if (job.head !== pr.head) {
      await this.finishRun(job, pr.number, "stopped", "Interrupted run superseded by the current PR head");
      record.job = undefined; record.recovery = undefined; record.humanHead = undefined; record.humanReason = undefined;
      return false;
    }
    const interrupted = await this.runner.telemetry?.(job);
    if (interrupted?.prompt && !recovery?.instructions) {
      record.recovery = undefined;
      record.humanHead = pr.head; record.humanReason = interrupted.prompt.text;
      record.humanObservation = { state: "blocked", summary: interrupted.prompt.text, promptId: interrupted.prompt.id };
      record.decision = { kind: "human", reason: interrupted.prompt.text };
      return true;
    }
    if (record.budgetDay || interrupted?.status === "error" && !temporaryFailure(interrupted.summary)) return false;
    const reason = String(launchError ?? record.humanReason ?? "The local worker session ended unexpectedly");
    if (!health.started) {
      const model = job.model;
      job.model = "No model";
      await this.finishRun(job, pr.number, "failed", reason);
      record.job = undefined; record.attempts = Math.max(0, record.attempts - 1);
      if (job.kind === "triage" && record.assessment) record.assessment.attempts = Math.max(0, record.assessment.attempts - 1);
      record.runRequested = job.manual; record.instructions = job.instructions; record.requestedModel = model;
      this.scheduleRecovery(record, "prepare", reason);
      return true;
    }
    if (job.adapter !== "app-server") return false;
    if (!recovery?.retryAt || recovery.kind !== "resume") {
      await this.runner.stop(job);
      this.scheduleRecovery(record, "resume", reason);
      const telemetry = await this.runner.telemetry?.(job);
      const run = telemetry ?? this.store.run(job.name);
      if (run && run.costUSD === null && !telemetry && run.turns === 0) run.costUSD = 0;
      if (run) { run.state = "waiting"; run.endedAt = undefined; this.store.saveRun(run); }
      return true;
    }
    if (observeOnly || record.paused || this.activeSlots(pr.number) >= this.parallelLimit()) return true;
    const run = await this.runner.telemetry?.(job) ?? this.store.run(job.name);
    const others = this.store.runs().filter(r => r.id !== job.name && !r.endedAt && ["preparing", "running", "waiting"].includes(r.state)).reduce((sum, r) => sum + Math.max(0, (r.budgetUSD ?? 0) - (r.costUSD ?? 0)), 0);
    const remaining = (job.budgetUSD ?? this.config.runCapUSD ?? 5) - (run?.costUSD ?? 0);
    if (run?.costUSD === null || remaining <= 0 || this.store.spend(this.config.dailyCapUSD ?? 20).unknownRuns || remaining > (this.config.dailyCapUSD ?? 20) - this.store.spent(localDay()) - others) {
      record.decision = { kind: "human", title: "Review the run budget", reason: "The interrupted run cannot resume within its spend limit. Review Spend settings before continuing." }; record.budgetDay = localDay(); return true;
    }
    try {
      this.admitted(); await this.runner.resume(job, recovery.instructions ?? "The local worker was interrupted. Recheck GitHub and continue the original task in this checkout. Preserve all existing edits and do not repeat publication already confirmed on GitHub.");
      recovery.retryAt = undefined;
      if (run) { run.state = "running"; run.endedAt = undefined; run.prompt = undefined; this.store.saveRun(run); }
      record.decision = { kind: "waiting", reason: "Resumed the interrupted run in its saved checkout" };
      return true;
    } catch (error) { this.scheduleRecovery(record, "resume", String(error)); return true; }
  }
  private async queueAssessment(record: Record, report: string): Promise<void> {
    const source = record.job?.kind !== "triage" ? record.job : record.assessment?.sourceJob;
    if (source) {
      await this.runner.stop(source);
      await this.finishRun(source, record.snapshot.number, "stopped", "Checking the run result against GitHub before asking you");
    }
    const followups = record.assessment?.followups ?? 0;
    record.assessment = { id: randomUUID(), head: record.snapshot.head, key: assessmentKey(record.snapshot), report, sourceJob: source, allowWatch: source?.manual, attempts: 0, followups };
    record.job = undefined;
    record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
    record.decision = { kind: "waiting", reason: "Checking the result against GitHub" };
    record.stateSince = new Date().toISOString();
  }
  private async assess(record: Record, observeOnly: boolean): Promise<boolean> {
    const pr = record.snapshot;
    if (!this.runner.launchTriage || record.paused || record.watching === false || record.skippedHead === pr.head || pr.draft || pr.state !== "OPEN" || record.budgetDay) return false;
    if (!record.job && !record.humanHead && stamphogRefused(pr) && record.decision.kind === "human" && record.assessment?.result?.route !== "ask") {
      record.assessment = undefined;
      return true;
    }
    if (!record.assessment && record.decision.kind === "human" && (modeOf(this.config) === "auto" || record.job)) await this.queueAssessment(record, record.decision.reason);
    const assessment = record.assessment;
    if (!assessment) return false;
    assessment.id ??= randomUUID();
    if (record.job?.kind === "triage") { record.decision = { kind: "waiting", reason: "Checking the result against GitHub" }; return true; }
    if (record.job) return false;
    if (assessment.result?.route === "repair" && assessment.result.category === "review" && !assessment.result.review_threads && assessment.result.instructions?.startsWith("Continue the original maintenance task in its saved checkout. GitHub still reports:")) {
      assessment.result = undefined; assessment.attempts = 0;
      assessment.report += "\nThe previous review-wait verdict was converted into a repair by the controller. Recheck each unresolved thread on the current commit and return its review_threads disposition. Preserve real defects and reviewer-owned actions.";
    }
    if (!observeOnly && !record.paused && modeOf(this.config) !== "paused" && (modeOf(this.config) === "auto" || assessment.allowWatch) && assessment.head === pr.head && assessment.key === assessmentKey(pr) && assessment.result?.review_threads?.some(t => t.status === "addressed" && pr.threads.some(thread => thread.id === t.id)) && this.github.resolveAddressedThreads) {
      try {
        const cleanup = await this.github.resolveAddressedThreads(pr, assessment.result.review_threads);
        const sameRemainingThreads = JSON.stringify(pr.threads.filter(t => !cleanup.resolved.includes(t.id))) === JSON.stringify(cleanup.snapshot.threads);
        Object.assign(pr, cleanup.snapshot);
        if (pr.head !== assessment.head) { record.assessment = undefined; record.decision = { kind: "waiting", reason: "PR changed; refreshing the review evidence" }; return true; }
        if (cleanup.resolved.length) {
          this.store.log(pr.number, `Resolved ${cleanup.resolved.length} bot review threads after verifying the fixes on the current commit`);
          if (sameRemainingThreads) assessment.key = assessmentKey(pr);
        }
      } catch (error) {
        record.decision = { kind: "waiting", reason: "Waiting for GitHub to confirm the resolved review feedback" };
        this.store.log(pr.number, `Verified review cleanup will retry: ${String(error).slice(0, 1000)}`);
        return true;
      }
    }
    if (assessment.result?.category === "review" && assessment.result.route === "wait" && pr.reviewDecision === "APPROVED" && decide(pr, { ...record, humanHead: undefined }).kind === "ready") {
      record.assessment = undefined;
      record.decision = decide(pr, record);
      return false;
    }
    if (assessment.attention) {
      if (attentionStillNeeded(assessment.attention, pr)) { record.decision = assessment.attention.decision; return true; }
      assessment.attention = undefined; assessment.result = undefined; assessment.attempts = 0;
    }
    const key = assessmentKey(pr);
    if (assessment.key !== key) { assessment.key = key; assessment.result = undefined; assessment.attempts = 0; assessment.ciEvidence = undefined; }
    // Older investigations hid failed CI behind a reviewer wait. Refresh that
    // exhausted escalation once, retaining the repair limit and spend history.
    if (!assessment.attentionVersion && assessment.followups >= 2 && assessment.result?.route === "wait" && assessment.result.category === "review" && pr.checks.some(failed)) {
      assessment.attentionVersion = 1; assessment.result = undefined; assessment.attempts = 0;
    }
    // Refresh old CI-access escalations once against GitHub's own diagnostics.
    // Keep substantive repair counters and spend history intact.
    if (!assessment.ciEvidenceVersion && assessment.result?.route === "ask" && assessment.result.category === "checks" && !assessment.result.ci_access && pr.checks.some(failed) && this.github.failureEvidence) {
      assessment.ciEvidence = await this.github.failureEvidence(pr); assessment.ciEvidenceVersion = 1;
      assessment.result = undefined; assessment.attempts = 0;
    }
    let result = assessment.result;
    if (result?.route === "wait" && result.category === "review") {
      const maintenance = decide(pr, { ...record, assessment: undefined, humanHead: undefined, job: undefined });
      if (["approval", "human"].includes(maintenance.kind)) {
        record.assessment = undefined; record.decision = maintenance;
        return maintenance.kind === "human";
      }
      const repairableThreads = pr.threads.filter(thread => !result!.review_threads?.some(finding => finding.id === thread.id && ["addressed", "awaiting_reviewer"].includes(finding.status)));
      const repairable = pr.checks.some(failed) || pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND" || repairableThreads.length > 0;
      if (maintenance.kind === "fix" && repairable) {
        result = { ...result, route: "repair", instructions: `Continue the original maintenance task in its saved checkout. GitHub still reports: ${maintenance.reason}. Requested reviews can proceed while these repairs are completed. The independent investigation found no owner decision is needed: ${result.reason}\nVerified investigation evidence: ${JSON.stringify(result.evidence)}\nReview thread findings: ${JSON.stringify(result.review_threads ?? [])}\nRecheck the current PR and base before editing. Preserve existing work, the original task scope, publishing guards, and both branches' intended behavior. Verify the original report against the actual merge stages and current code. Complete routine conflict, CI, and review work that remains; do not stop solely because a reviewer is already requested. If a concrete human prerequisite remains, report it with evidence.` };
      }
    }
    if (result) {
      if (result.route === "ask") {
        record.decision = { kind: "human", title: result.title, reason: result.reason, question: result.question, response: result.response ?? "reply", options: result.options, action: result.action };
        assessment.attention = ownerAttention(pr, result, record.decision);
        return true;
      }
      if (result.route === "wait") {
        const live = result.category === "review" && !pr.threads.length ? decide(pr, { ...record, assessment: undefined, humanHead: undefined, job: undefined }) : undefined;
        record.decision = { kind: "waiting", title: result.title, reason: live?.kind === "waiting" ? live.reason : result.reason };
        return true;
      }
      if (result.route === "ready") {
        const live = decide(pr, { ...record, assessment: undefined, humanHead: undefined, job: undefined });
        if (live.kind === "ready") {
          record.stackWait = stackBlock(pr, this.store.all(), true);
          record.decision = record.stackWait ? { kind: "waiting", reason: record.stackWait.reason } : live;
          return true;
        }
        if (["review", "approval", "waiting"].includes(live.kind)) { record.decision = live; return false; }
        record.decision = { kind: "waiting", reason: "GitHub still reports blockers; verifying the investigation" };
        assessment.result = undefined;
      }
      if (result.route === "repair") {
        record.stackWait = stackBlock(pr, this.store.all(), false);
        if (record.stackWait) { record.decision = { kind: "waiting", reason: record.stackWait.reason }; return true; }
        const prepared = assessment.sourceJob;
        if (!observeOnly && modeOf(this.config) === "auto" && this.activeSlots(pr.number) < this.parallelLimit() && prepared?.kind === "branch-update" && /Resolution (?:edited files outside the conflict set|changed the automatic merge outside its conflicts)/.test(assessment.report) && this.runner.recoverPreparedUpdate) {
          try {
            if (await this.runner.recoverPreparedUpdate(prepared, pr)) {
              this.admitted(); record.job = prepared; assessment.result = undefined; record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined; record.recovery = undefined;
              record.decision = { kind: "waiting", reason: "Validating the saved conflict resolution and its related PR edits" };
              this.store.log(pr.number, "Recovered the completed conflict resolution after validating its additional PR-owned files");
              return true;
            }
          } catch (error) { this.store.log(pr.number, `Saved conflict resolution did not qualify for bounded integration recovery: ${String(error)}`); }
        }
        if (assessment.followups >= 2) {
          record.decision = remainingRepairDecision(pr, result);
          assessment.attention = ownerAttention(pr, result, record.decision);
          return true;
        }
        record.decision = { kind: "waiting", reason: "Agent follow-up queued" };
        if (observeOnly || (modeOf(this.config) !== "auto" && !assessment.allowWatch) || modeOf(this.config) === "paused" || this.activeSlots(pr.number) >= this.parallelLimit()) return true;
        const source = assessment.sourceJob;
        if (source?.head === pr.head && source.adapter === "app-server") {
          const run = this.store.run(source.name);
          const remaining = (source.budgetUSD ?? this.config.runCapUSD ?? 5) - (run?.costUSD ?? Infinity);
          const allowance = this.launchBudget(remaining, pr.number);
          if (allowance >= MIN_RUN_BUDGET) {
            const previousBudget = source.budgetUSD;
            try {
              source.budgetUSD = (run?.costUSD ?? 0) + allowance;
              this.admitted(); await this.runner.resume(source, result.instructions!);
              this.outcomes.repairRound(record, source, `followup:${assessment.id}:${assessment.followups + 1}`);
              record.job = source; record.humanHead = undefined;
              if (run) { run.budgetUSD = source.budgetUSD; run.state = "running"; run.endedAt = undefined; run.prompt = undefined; this.store.saveRun(run); }
              assessment.followups++; assessment.result = undefined;
              record.decision = { kind: "waiting", reason: "Agent is handling the verified follow-up" };
              return true;
            } catch (error) {
              source.budgetUSD = previousBudget;
              this.store.log(pr.number, `Could not resume source run: ${String(error)}`);
              record.decision = { kind: "human", title: "Retry the saved repair", reason: "The original checkout is preserved, but its agent session could not resume.", question: "Open the saved run to recover its edits before starting another repair." };
              return true;
            }
          }
          record.decision = { kind: "human", title: "Review the run budget", reason: "The saved repair cannot resume within the available spend limit.", question: "Review Spend settings before continuing the saved run." };
          return true;
        }
        assessment.followups++; record.instructions = result.instructions; assessment.result = undefined;
        record.decision = { kind: "fix", reason: "Following up on verified GitHub evidence" };
        return false;
      }
    }
    record.decision = { kind: "waiting", reason: "Checking the result against GitHub" };
    if (assessment.attempts >= 2) {
      record.decision = { kind: "human", response: "recheck", title: "Recheck this PR", reason: "Woodshed could not verify the escalation against GitHub after two attempts.", question: "Choose Recheck GitHub to try again, or open the PR to inspect it.", action: { label: "Open pull request", url: pr.url } };
      assessment.attention = ownerAttention(pr, { head: pr.head, route: "ask", category: "internal", title: record.decision.title!, reason: record.decision.reason, evidence: [] }, record.decision);
      return true;
    }
    if (observeOnly || (modeOf(this.config) !== "auto" && !assessment.allowWatch) || modeOf(this.config) === "paused" || this.activeSlots(pr.number) >= this.parallelLimit()) return true;
    const available = this.budgetAvailable();
    const budget = this.launchBudget(Math.min(1, this.config.runCapUSD ?? 5), pr.number);
    if (budget < MIN_RUN_BUDGET) {
      if (this.store.unfinishedRuns().some(r => ["preparing", "running", "waiting"].includes(r.state))) {
        record.decision = { kind: "waiting", reason: "Waiting for reserved run budget to free up" };
      } else {
        record.decision = { kind: "human", title: "Review the spend limit", reason: "Less than $0.10 is available for another investigation.", question: "Review Spend settings to continue, or wait for the daily budget to reset." }; record.budgetDay = localDay();
      }
      return true;
    }
    const job: Job = { name: `ws-triage-${pr.number}-${randomUUID().slice(0, 8)}`, head: pr.head, fingerprint: record.fingerprint, startedAt: new Date().toISOString(), kind: "triage", model: this.config.defaultModel, budgetUSD: budget, adapter: "app-server" };
    this.admitted(); record.job = job; assessment.attempts++;
    this.store.put(record); this.store.saveRun(this.initialRun(job, pr.number));
    try {
      job.ciEvidence = assessment.ciEvidence?.head === pr.head ? assessment.ciEvidence : await this.github.failureEvidence?.(pr);
      this.store.put(record);
      await this.runner.launchTriage(pr, job, assessment.report + (assessment.reply ? `\nOwner answer: ${assessment.reply}` : "") + (assessment.sourceJob ? `\nOriginal run: ${assessment.sourceJob.name}. Follow-ups already attempted: ${assessment.followups}.` : "")); }
    catch (error) {
      this.store.log(pr.number, `Investigation startup failed: ${String(error)}`);
      try { await this.runner.stop(job); } catch { }
      await this.finishRun(job, pr.number, "failed", "GitHub investigation could not start");
      record.job = undefined;
    }
    return true;
  }
  private async requestStamphog(record: Record, expectedHead: string): Promise<boolean> {
    const current = await this.github.snapshot(record.snapshot.number);
    if (current.head !== expectedHead) throw new Error("The PR changed. Refresh before requesting Stamphog approval.");
    record.snapshot = current; record.observedAt = new Date(this.now()).toISOString();
    const owner = !this.github.canMaintain || await this.github.canMaintain(current);
    const eligibility = approvalRequestState(record, owner, modeOf(this.config));
    if (record.decision.kind !== "human" && record.assessment?.result?.route !== "ask") record.decision = decide(current, record);
    this.store.put(record);
    if (["requested", "approved"].includes(eligibility.status)) return false;
    if (!eligibility.canRequest) throw new Error(eligibility.reason);
    if (this.sleeping) throw new Error("Wait for Woodshed to reconnect after sleep before requesting approval");
    await this.github.requestApproval(current.number, expectedHead);
    record.approvalRequests ??= {};
    if (record.requestedApproval && !Object.hasOwn(record.approvalRequests, record.requestedApproval)) record.approvalRequests[record.requestedApproval] = record.approvalRequestedAt ?? "";
    record.requestedApproval = expectedHead;
    record.approvalRequestedAt = new Date(this.now()).toISOString();
    record.approvalRequests[expectedHead] = record.approvalRequestedAt;
    record.lastError = undefined; record.decision = decide(current, record);
    this.store.put(record);
    this.store.log(current.number, "Requested Stamphog approval for the current commit");
    return true;
  }
  async action(number: number, action: string, input: { head?: string; message?: string; reviewer?: string; model?: string; promptId?: string; decisionId?: string; questionKey?: string; runId?: string; amount?: number; source?: ActionSource; queueHeads?: {[number: string]: string} } = {}): Promise<void> {
    const started = this.now();
    const source = input.source ?? "native_app";
    if (this.acting || this.budgetChecking) { this.telemetry?.action(number, action, source, true); throw new Error("Another action is running. Try again in a moment."); }
    this.acting = true;
    if (this.telemetry) this.telemetry.actionContext = { action, source };
    try { await this.withPR(number, async () => {
    let record = this.store.get(number);
    if (!record) throw new Error("PR not found");
    if (action === "submit-merge-queue") {
      if (!["native_app", "notification"].includes(source)) throw Error("Merge queue submission requires an explicit action in the Woodshed app.");
      if (!input.head || !input.queueHeads || modeOf(this.config) === "paused" || this.sleeping) throw Error("Resume Woodshed and refresh this PR before submitting it to the merge queue.");
      const originalScope = queueSubmission(record, this.config, this.store.all(), this.store.runs(), this.now()).scope;
      const siblings = originalScope.filter(n => n !== number).sort((a, b) => a - b);
      if (siblings.some(n => this.locks.has(n))) throw Error("A PR in this stack is being refreshed. Try again in a moment.");
      const submit = async (): Promise<void> => {
      for (const n of originalScope) {
        const member = this.store.get(n)!; const fresh = await (this.github.freshSnapshot?.(n) ?? this.github.snapshot(n));
        if (fresh.head !== input.queueHeads[String(n)] || n === number && fresh.head !== input.head) throw Error(`PR #${n} changed. Review the current stack before submitting.`);
        if (!await this.github.canMaintain(fresh)) throw Error("Woodshed only submits your own PRs to the merge queue.");
        member.snapshot = fresh; member.observedAt = new Date(this.now()).toISOString();
        const observation = await this.github.mergeQueue(fresh); fresh.mergeQueue = observation; trackMergeQueue(member, observation, this.now()); this.store.put(member);
      }
      record = this.store.get(number)!;
      const eligibility = queueSubmission(record, this.config, this.store.all(), this.store.runs(), this.now());
      if (!eligibility.canSubmit) throw Error(eligibility.reason ?? "This PR is not ready for the merge queue.");
      if (Object.keys(input.queueHeads).length !== eligibility.scope.length || eligibility.scope.some(n => input.queueHeads![String(n)] !== eligibility.heads[String(n)])) throw Error("The stack changed. Review its current PRs before submitting.");
      const previousQueues = new Map(eligibility.scope.map(n => { const r = this.store.get(n)!; return [n, structuredClone({ mergeQueue: r.mergeQueue, decision: r.decision })]; }));
      const q = record.mergeQueue!; const id = randomUUID();
      q.submission = { id, head: record.snapshot.head, since: new Date(this.now()).toISOString(), baseline: q.revision };
      q.active = true; q.state = "submitted"; q.terminal = undefined; q.owner = number; q.groupId = id;
      record.decision = mergeQueueDecision(record)!; this.store.put(record);
      for (const n of eligibility.scope.filter(n => n !== number)) {
        const parent = this.store.get(n)!;
        const baseline = parent.mergeQueue?.revision ?? "";
        parent.mergeQueue = { ...q, head: parent.snapshot.head, submission: { ...q.submission, head: parent.snapshot.head, baseline } };
        parent.decision = mergeQueueDecision(parent)!; this.store.put(parent);
      }
      try { q.submission.url = await this.github.submitMergeQueue(record.snapshot, id); }
      catch (error) {
        if (error instanceof QueueSubmissionRejected) {
          for (const [n, previous] of previousQueues) { const r = this.store.get(n)!; r.mergeQueue = previous.mergeQueue; r.decision = previous.decision; this.store.put(r); }
          throw error;
        }
        q.submission.uncertain = true; q.error = "The submission response was interrupted. Check the request on GitHub before trying again."; this.store.put(record); throw error; }
      this.store.put(record); this.store.audit("merge-queue-submitted", number, { id, head: record.snapshot.head, scope: eligibility.scope });
      };
      const hold = (index: number): Promise<void> => index === siblings.length ? submit() : this.withPR(siblings[index]!, () => hold(index + 1));
      await hold(0); return;
    }
    if (action === "dismiss-queue-alert") {
      if (input.head !== record.snapshot.head) throw Error("The PR changed. Refresh before dismissing this alert.");
      if (record.mergeQueue?.terminal) record.mergeQueue.terminal.acknowledged = true;
      record.decision = decide(record.snapshot, record); this.store.put(record); return;
    }
    if (action === "request-approval") {
      if (!input.head) throw new Error("Include the PR head when requesting approval");
      await this.requestStamphog(record, input.head);
      return;
    }
    if (action === "mark-ready") {
      const current = await this.github.snapshot(number);
      if (!input.head || input.head !== current.head) throw new Error("The draft changed. Refresh before marking it ready.");
      if (current.state !== "OPEN" || !current.draft) throw new Error("This pull request is no longer a draft. Refresh its current state.");
      if (this.github.canMaintain && !await this.github.canMaintain(current)) throw new Error("Only the PR author can mark this draft ready for review.");
      if (record.job) throw new Error("A run is still attached to this draft. Refresh Woodshed before continuing.");
      await this.github.markReady(number, current.head);
      const refreshed = await this.github.snapshot(number);
      if (refreshed.head !== current.head || refreshed.state !== "OPEN" || refreshed.draft) throw new Error("GitHub did not confirm that this PR is ready for review. Refresh its state.");
      record.snapshot = refreshed;
      record.watching = true;
      record.paused = false;
      record.skippedHead = undefined;
      record.humanHead = undefined;
      record.humanReason = undefined;
      record.humanObservation = undefined;
      record.assessment = undefined;
      record.decision = { kind: "waiting", reason: "Marked ready for review; checking current GitHub state" };
      this.store.put(record);
      this.store.log(number, "Marked ready for review");
      // The HTTP caller schedules maintenance after acknowledging this state change.
      // Preparing a worktree or starting an agent can take minutes and must not hold the UI request.
      return;
    }
    if (action === "mark-draft") {
      const current = await this.github.snapshot(number);
      if (!input.head || input.head !== current.head) throw new Error("The pull request changed. Refresh before converting it to a draft.");
      if (current.state !== "OPEN" || current.draft) throw new Error("This pull request is no longer ready for review. Refresh its state.");
      if (this.github.canMaintain && !await this.github.canMaintain(current)) throw new Error("Only the PR author can convert this pull request to a draft.");
      await this.github.markDraft(number, current.head);
      const refreshed = await this.github.snapshot(number);
      if (refreshed.head !== current.head || refreshed.state !== "OPEN" || !refreshed.draft) throw new Error("GitHub did not confirm that this PR is a draft. Refresh its state.");
      record.snapshot = refreshed;
      record.watching = true;
      record.runRequested = false;
      record.decision = { kind: "paused", reason: "Draft PR; maintenance is paused until it’s ready for review" };
      this.store.put(record);
      this.store.log(number, "Converted to draft");
      await this.reconcile(refreshed);
      return;
    }
    if (["reply", "confirm-reply", "topup", "reviewer", "retry", "resume", "watch", "recheck"].includes(action)) {
      const live = await this.github.snapshot(number);
      if (live.head !== record.snapshot.head || live.state !== record.snapshot.state || live.draft !== record.snapshot.draft || ["reply", "confirm-reply", "recheck"].includes(action)) {
        await this.reconcile(live, true);
        record = this.store.get(number)!;
      }
    }
    if (record.snapshot.state !== "OPEN" || record.snapshot.draft) throw new Error("This PR is closed or a draft. Refresh its state before acting.");
    if (input.head && input.head !== record.snapshot.head || action === "reply" && input.decisionId && input.decisionId !== record.decision.id) {
      if (action === "reply" && input.message?.trim()) {
        record.pendingAnswer = { text: input.message.trim().slice(0, 8000), questionKey: input.questionKey, requiresConfirmation: !sameQuestion(record.decision, input.questionKey) };
        if (sameQuestion(record.decision, input.questionKey) && record.assessment?.result?.route === "ask") {
          record.assessment.reply = record.pendingAnswer.text; record.assessment.attention = undefined; record.assessment.result = undefined; record.assessment.attempts = 0;
          record.pendingAnswer = undefined; record.decision = { kind: "waiting", reason: "Your answer still applies; checking the updated PR" };
        }
        this.store.put(record); return;
      }
      throw new Error("The PR changed. Refresh before making this decision.");
    }
    if (action === "retry" && (record.paused || modeOf(this.config) === "paused")) throw new Error("Resume before starting another run");
    if (action === "confirm-reply") {
      if (!record.pendingAnswer || record.decision.kind !== "human") throw new Error("There is no current question to answer");
      if (input.decisionId !== record.decision.id) throw new Error("The question changed. Refresh before answering");
      input.message = record.pendingAnswer.text; record.pendingAnswer = undefined; action = "reply";
    }
    if (action === "discard-reply") {
      record.pendingAnswer = undefined;
    } else if (action === "topup") {
      if (!record.job || record.job.name !== input.runId) throw new Error("This run changed. Refresh before extending its budget");
      const amount = input.amount ?? 1;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100) throw new Error("Choose a top-up between $0 and $100");
      const run = this.store.run(record.job.name);
      if (!run || !["budget", "stopped", "waiting"].includes(run.state)) throw new Error("This run is not waiting for a budget extension");
      if (run.costUSD === null) throw new Error("Usage is unavailable; verify the run's spend before continuing");
      const newLimit = Math.max(record.job.budgetUSD ?? 0, run.costUSD) + amount;
      const remaining = newLimit - run.costUSD;
      if (remaining > this.budgetAvailable()) throw new Error("The daily cap cannot cover this top-up. Increase the daily cap separately in Spend settings.");
      if (modeOf(this.config) === "paused") throw new Error("Resume Auto before continuing the run");
      record.job.budgetUSD = newLimit; record.job.budgetOverride = true; record.job.manual = true;
      record.resumeRequested = "The owner extended this run's budget. Continue the original task, preserving the existing checkout and edits.";
      record.humanHead = undefined; record.humanReason = undefined; record.budgetDay = undefined;
      record.paused = false; record.topUpUSD = (record.topUpUSD ?? 0) + amount;
      run.budgetUSD = newLimit; run.state = "waiting"; run.endedAt = undefined; run.prompt = undefined; this.store.saveRun(run);
      record.decision = { kind: "waiting", reason: "Budget extended for this run; waiting for a run slot" };
    } else if (action === "stop") {
      if (record.job) { await this.runner.stop(record.job); await this.finishRun(record.job, number, "stopped", "Run stopped by you; worktree preserved"); }
      record.resumeRequested = undefined; record.job = undefined; record.paused = true; record.humanHead = undefined; record.humanReason = undefined; record.budgetDay = undefined; record.assessment = undefined;
      record.decision = { kind: "paused", reason: "Stopped by you; saved work is preserved" };
    } else if (action === "pause") {
      record.paused = true;
      record.decision = { kind: "paused", reason: record.job ? "Paused. The current agent remains attached; open its session to stop or take over." : "Paused by you" };
    } else if (action === "resume") {
      record.paused = false;
      record.humanHead = undefined;
      record.humanReason = undefined;
      record.humanObservation = undefined;
      record.attempts = 0;
      record.decision = { kind: "waiting", reason: "Refreshing PR state" };
    } else if (action === "recheck" || action === "reply" && record.assessment?.result?.route === "ask") {
      if (action === "recheck" && record.recovery) { record.recovery.attempts = 0; record.recovery.retryAt = new Date(this.now()).toISOString(); }
      if (action === "reply" && (!input.message?.trim() || input.message.length > 8000)) throw new Error("Enter a reply of at most 8000 characters");
      if (record.assessment) {
        record.assessment.reply = input.message?.trim();
        if (action === "reply") record.assessment.allowWatch = true;
        record.assessment.attention = undefined; record.assessment.result = undefined; record.assessment.attempts = 0;
        record.assessment.key = "";
      }
      record.humanHead = undefined; record.humanReason = undefined;
      record.decision = { kind: "waiting", reason: "Checking fresh GitHub evidence" };
    } else if (action === "reply") {
      if (!record.job) throw new Error("There is no active agent session. Start a repair with your instructions instead.");
      if (!input.message?.trim() || input.message.length > 8000) throw new Error("Enter a reply of at most 8000 characters");
      if (record.job.adapter === "app-server" && this.runner.health && ["missing", "finished"].includes((await this.runner.health(record.job)).state)) {
        const run = await this.runner.telemetry(record.job);
        if (run?.prompt?.kind === "permission") throw new Error("Reconnect the required account before resuming this run.");
        if (run?.prompt && run.prompt.id !== input.promptId) throw new Error("The question changed. Open the current decision before replying.");
        record.resumeRequested = `Owner answer to the saved question: ${input.message.trim()}`;
        record.recovery = undefined; record.humanHead = undefined; record.humanReason = undefined;
        record.decision = { kind: "waiting", reason: "Your answer is saved; reconnecting the original run" };
        this.store.put(record); return;
      }
      if (this.activeSlots(number) >= this.parallelLimit() || modeOf(this.config) === "paused") {
        record.pendingReply = input.message.trim(); record.pendingPromptId = input.promptId;
        record.decision = { kind: "waiting", reason: "Your reply is queued until a run slot is available" };
        this.store.put(record); return;
      }
      const afterTurn = await this.runner.send(record.job, input.message.trim(), input.promptId);
      record.job.afterTurn = afterTurn;
      record.job.startedAt = new Date().toISOString();
      record.humanHead = undefined;
      record.humanReason = undefined;
      record.humanObservation = undefined;
      record.decision = { kind: "waiting", reason: "Agent is handling your reply" };
    } else if (action === "interrupt") {
      if (!record.job) throw new Error("There is no active agent session");
      await this.runner.interrupt(record.job);
      record.paused = true;
      record.humanHead = record.snapshot.head;
      record.humanReason = "Agent interrupted by you. Open its session to take over, or start a new repair.";
      record.decision = { kind: "paused", reason: record.humanReason };
    } else if (action === "retry") {
      if (record.mergeQueue?.active) throw Error("Remove this PR from Trunk before starting a repair.");
      if (record.mergeQueue?.terminal) record.mergeQueue.terminal.acknowledged = true;
      if (this.github.canMaintain && !await this.github.canMaintain(record.snapshot)) throw new Error("Woodshed can only run agents on your own PRs. Open this PR on GitHub to review it.");
      if (input.message && input.message.length > 8000) throw new Error("Instructions must be at most 8000 characters");
      if (input.model !== undefined && !/^[a-zA-Z0-9._/-]{0,120}$/.test(input.model)) throw new Error("Invalid model");
      if (record.job) { await this.runner.stop(record.job); await this.finishRun(record.job, number, "stopped", "Replaced by a new run at your request"); }
      record.job = undefined;
      record.recovery = undefined;
      record.assessment = undefined;
      record.paused = false;
      record.humanHead = undefined;
      record.humanReason = undefined;
      record.humanObservation = undefined;
      record.attempts = 0;
      record.runRequested = true;
      record.watching = true; record.skippedHead = undefined; record.requestedModel = input.model;
      record.instructions = input.message?.trim();
      record.decision = { kind: "fix", reason: this.config.paused ? "Repair queued; new work is paused" : "Repair requested by you" };
    } else if (action === "reviewer") {
      if (!input.reviewer) throw new Error("Enter a GitHub username or organization/team");
      await this.github.requestReviewer(number, input.reviewer.trim());
      this.store.log(number, `Requested review from ${input.reviewer.trim()}`);
      return;
    } else if (["unwatch", "skip"].includes(action)) {
      if (record.job) { await this.runner.stop(record.job); await this.finishRun(record.job, number, "stopped", action === "skip" ? "Run skipped by you" : "Stopped watching this PR"); }
      record.job = undefined; record.runRequested = false; record.pendingReply = undefined;
      record.humanHead = undefined; record.humanReason = undefined; record.humanObservation = undefined;
      if (action === "unwatch") record.watching = false; else record.skippedHead = record.snapshot.head;
      record.decision = { kind: "paused", reason: action === "unwatch" ? "Not watching this PR" : "Run skipped on the current commit" };
    } else if (action === "watch") {
      record.watching = true; record.paused = false; record.skippedHead = undefined;
      record.decision = { kind: "waiting", reason: "Watching this PR" };
    } else throw new Error("Unknown action");
    this.store.put(record);
    this.store.log(number, record.decision.reason);
    }); this.telemetry?.action(number, action, source, false, this.now() - started);
    } catch (error) { this.telemetry?.action(number, action, source, true, this.now() - started); throw error; }
    finally { this.acting = false; if (this.telemetry) this.telemetry.actionContext = undefined; }
  }
  parallelLimit(): number {
    const capacity = this.capacity();
    return capacity.blocked || this.settling() ? 0 : capacity.limit;
  }
  launchBudget(limit: number, number?: number): number {
    const records = this.store.all();
    const runnable = records.filter(r => !mergeQueueDecision(r) && !r.job && !r.paused && r.watching !== false && r.skippedHead !== r.snapshot.head && r.snapshot.state === "OPEN" && !r.snapshot.draft && !stackBlock(r.snapshot, records, false) && (r.decision.kind === "fix" || r.decision.kind !== "human" && r.assessment && (!r.assessment.result || r.assessment.result.route === "repair")));
    const waiting = runnable.length + (number !== undefined && !runnable.some(r => r.snapshot.number === number) ? 1 : 0);
    const available = this.budgetAvailable();
    const contenders = Math.max(1, Math.min(this.capacity().limit - this.activeSlots(), waiting, Math.floor((available + 1e-9) / MIN_RUN_BUDGET)));
    return dollarsDown(Math.min(limit, available / contenders));
  }
  queueStatus(record: Record): { reason: string; message: string } | undefined {
    if (mergeQueueDecision(record) || record.job || record.paused || record.watching === false || record.snapshot.draft || record.snapshot.state !== "OPEN" || ["human", "ready", "closed"].includes(record.decision.kind) || record.stackWait) return undefined;
    if (record.decision.kind !== "fix" && !(record.assessment && (!record.assessment.result || record.assessment.result.route === "repair" && record.assessment.followups < 2))) return undefined;
    if (modeOf(this.config) === "paused") return { reason: "paused", message: "Waiting for automation to resume" };
    if (modeOf(this.config) !== "auto" && !record.runRequested && !record.assessment?.allowWatch) return undefined;
    const capacity = this.capacity();
    if (capacity.blocked === "memory") return { reason: "memory", message: "Waiting for memory to free up on the server" };
    if (capacity.blocked === "cpu") return { reason: "cpu", message: "Waiting for CPU capacity on the server" };
    if (this.settling()) return { reason: "settling", message: "Checking server headroom before starting the next agent" };
    const active = this.activeSlots();
    if (active >= capacity.limit) return { reason: "capacity", message: `Waiting for a worker · ${active} of ${capacity.limit} running` };
    if (this.budgetAvailable() < MIN_RUN_BUDGET) return { reason: "budget", message: "Waiting for available spend budget" };
    return { reason: "refresh", message: "Ready for repair · checking current PR state" };
  }
  activeSlots(except?: number): number {
    return this.store.all().filter(r => r.snapshot.number !== except && r.job && !r.paused && r.watching !== false && !r.pendingReply && r.decision.kind !== "human" && ["preparing", "running"].includes(this.store.run(r.job.name)?.state ?? "running")).length;
  }
  budgetAvailable(): number {
    if (this.store.spend(this.config.dailyCapUSD ?? 20).unknownRuns) return 0;
    const jobBudgets = new Map(this.store.all().filter(r => r.job?.budgetUSD !== undefined).map(r => [r.job!.name, r.job!.budgetUSD!]));
    const reserved = this.store.unfinishedRuns().filter(r => ["preparing", "running", "waiting"].includes(r.state)).reduce((sum, r) => sum + Math.max(0, (jobBudgets.get(r.id) ?? r.budgetUSD ?? 0) - (r.costUSD ?? 0)), 0);
    return dollarsDown((this.config.dailyCapUSD ?? 20) - this.store.spent(localDay()) - reserved);
  }
  initialRun(job: Job, number: number): Run {
    return { id: job.name, number, model: "No model", startedAt: job.startedAt, state: "preparing", turns: 0, costUSD: 0, costsByDay: {}, summary: "Preparing the PR checkout", budgetUSD: job.budgetUSD };
  }
  private async finishRun(job: Job, number: number, state: Run["state"], summary: string): Promise<void> {
    const run = await this.runner.telemetry?.(job) ?? this.store.run(job.name) ?? this.initialRun(job, number);
    run.state = state; run.summary = summary; run.endedAt ??= new Date().toISOString();
    run.prompt = undefined;
    if (run.turns === 0) run.costUSD = 0;
    if (job.model === "No model") { run.costUSD = 0; run.model = "No model"; }
    this.store.saveRun(run);
  }
  budgetChecking = false;
  async checkBudgets(): Promise<void> {
    if (this.budgetChecking || this.acting || this.syncing || this.refreshingAttention) return;
    this.budgetChecking = true;
    let freedSlot = false;
    try {
      for (const record of this.store.all().filter(r => r.job?.adapter === "app-server")) {
        const run = await this.runner.telemetry(record.job!);
        if (run) {
          const previous = this.store.run(run.id);
          if (previous && ["preparing", "running"].includes(previous.state) && !["preparing", "running"].includes(run.state)) freedSlot = true;
          this.store.saveRun(run);
        }
      }
      {
        const dailyReached = this.store.spent(localDay()) >= (this.config.dailyCapUSD ?? 20);
        for (const record of this.store.all().filter(r => r.job?.adapter === "app-server")) {
          const run = this.store.run(record.job!.name);
          if (run?.state !== "running") continue;
          if (!dailyReached && (run.costUSD ?? 0) < (record.job!.budgetOverride ? record.job!.budgetUSD ?? run.budgetUSD ?? Infinity : Math.min(record.job!.budgetUSD ?? run.budgetUSD ?? Infinity, this.config.runCapUSD ?? 5))) continue;
          await this.runner.stop(record.job!);
          await this.finishRun(record.job!, record.snapshot.number, "budget", dailyReached ? "Daily spend cap reached" : "Run spend cap reached");
          freedSlot = true;
          record.humanHead = record.snapshot.head; record.humanReason = dailyReached ? "The daily spend cap is reached. Review the daily cap in Spend settings, or stop the run." : "This run reached its spending limit. Add $1.00 to continue within the daily cap, or stop the run.";
          record.decision = { kind: "human", reason: record.humanReason }; record.budgetDay = localDay();
          this.store.put(record);
        }
      }
    } finally { this.budgetChecking = false; }
    if (freedSlot) void this.sync();
  }
}
