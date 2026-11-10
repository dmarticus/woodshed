import { createHash } from "node:crypto";
import { failed, type Check, type Snapshot } from "./model";
import type { Store } from "./store";

export type InfrastructureSignal = { signature: string; label: string; head: string; job: string; run: string; url: string };
export type CIIncident = { id: string; head: string; signature: string; label: string; related_prs: number[]; evidence: string[]; first_seen: string; retry_until: string };

export function infrastructureKind(log: string): { kind: string; label: string } | undefined {
  if (/The (?:self-hosted|hosted) runner[^\n]{0,100}lost communication with the server/i.test(log)) return { kind: "runner-connection", label: "Shared CI runner interruption" };
  if (/(?:failed|unable) to (?:download|upload) (?:an? )?(?:artifact|action)[\s\S]{0,400}(?:503|502|504|Service Unavailable|ECONNRESET|ETIMEDOUT)/i.test(log)) return { kind: "actions-transport", label: "Shared CI download or upload failure" };
  if (/(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)[^\n]{0,200}(?:registry\.npmjs\.org|pypi\.org)|(?:registry\.npmjs\.org|pypi\.org)[^\n]{0,200}(?:503|502|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i.test(log)) return { kind: "package-registry", label: "Shared package registry connection failure" };
  return undefined;
}

export class SharedCI {
  constructor(readonly github: { failureSignal?: (pr: Snapshot, check: Check) => Promise<InfrastructureSignal | undefined>; snapshot: (number: number) => Promise<Snapshot>; rerunFailed?: (signal: InfrastructureSignal) => Promise<void> }, readonly store: Store, readonly now: () => number = Date.now) {}
  async inspect(pr: Snapshot): Promise<CIIncident | undefined> {
    if (!this.github.failureSignal) return undefined;
    const failures = pr.checks.filter(failed);
    if (!failures.length || failures.length > 3) return undefined;
    const peers = this.store.all().filter(r => r.snapshot.number !== pr.number && r.snapshot.state === "OPEN" && r.snapshot.head !== pr.head && r.observedAt && this.now() - Date.parse(r.observedAt) < 300000 && r.snapshot.checks.some(c => failed(c) && failures.some(f => f.name === c.name))).slice(0, 3);
    if (!peers.length) return undefined;
    const signals: InfrastructureSignal[] = [];
    for (const check of failures) {
      const signal = await this.github.failureSignal(pr, check);
      if (!signal || signal.head !== pr.head) return undefined;
      signals.push(signal);
    }
    if (signals.some(s => s.signature !== signals[0].signature)) return undefined;
    const related: number[] = []; const evidence = signals.map(s => s.url);
    for (const peer of peers) {
      const live = await this.github.snapshot(peer.snapshot.number);
      if (live.head !== peer.snapshot.head || live.state !== "OPEN") continue;
      for (const check of live.checks.filter(c => failed(c) && failures.some(f => f.name === c.name)).slice(0, 3)) {
        const signal = await this.github.failureSignal(live, check);
        if (signal?.head === live.head && signal.signature === signals[0].signature) { related.push(live.number); evidence.push(signal.url); break; }
      }
    }
    if (!related.length) return undefined;
    const previous = this.store.get(pr.number)?.ciIncident;
    const same = previous?.head === pr.head && previous.signature === signals[0].signature && previous.evidence[0] === signals[0].url;
    const first = same ? previous.first_seen : new Date(this.now()).toISOString();
    const incident: CIIncident = { id: createHash("sha256").update(signals[0].signature).digest("hex"), head: pr.head, signature: signals[0].signature, label: signals[0].label, related_prs: [...new Set([pr.number, ...related])].sort((a, b) => a - b), evidence: [...new Set(evidence)], first_seen: first, retry_until: same ? previous.retry_until : new Date(this.now() + 300000).toISOString() };
    if (this.now() < Date.parse(incident.retry_until) && this.github.rerunFailed) {
      for (const signal of signals) {
        const key = `ci-rerun:${pr.head}:${signal.run}`;
        if (!this.store.claimAction(key, { number: pr.number, signal })) continue;
        try { await this.github.rerunFailed(signal); this.store.audit("ci-rerun", pr.number, { key, outcome: "requested", incident: incident.id }); }
        catch (error) { this.store.audit("ci-rerun", pr.number, { key, outcome: "unconfirmed", error: String(error) }); }
      }
    }
    return incident;
  }
}
