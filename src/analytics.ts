import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";

export type AnalyticsEvent = "woodshed_ui_opened" | "woodshed_started" | "woodshed_pr_action" | "woodshed_action_failed" | "woodshed_mode_changed" | "woodshed_settings_changed" | "woodshed_pr_enrolled" | "woodshed_pr_state_changed" | "woodshed_pr_ready" | "woodshed_handoff_accepted" | "woodshed_attention_raised" | "woodshed_attention_resolved" | "woodshed_run_started" | "woodshed_run_resumed" | "woodshed_run_state_changed" | "woodshed_run_finished" | "woodshed_run_cost_updated" | "woodshed_jev_check" | "woodshed_notification";
export type AnalyticsProperties = Record<string, string | number | boolean | null>;
export type AnalyticsFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Options = { token?: string; host?: string; enabled?: boolean; autoFlush?: boolean; fetch?: AnalyticsFetch; now?: () => number };
type Queued = { id: string; payload: string; attempts: number };

/** Local outbox: analytics failure must never fail a maintenance action. No credentials are queued. */
export class Analytics {
  private db?: Database;
  private readonly token: string;
  private readonly endpoint: string;
  private readonly send: AnalyticsFetch;
  private readonly now: () => number;
  private distinctId = "";
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private depth = 0;
  private lastError: string | null = null;

  constructor(dataDir: string, options: Options = {}) {
    this.token = (options.token ?? process.env.POSTHOG_PROJECT_TOKEN ?? "").trim();
    this.endpoint = `${(options.host ?? process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "")}/i/v0/e/`;
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.enabled === false || !this.token || !this.endpoint.startsWith("https://")) return;
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const idPath = join(dataDir, "analytics-id");
      try { this.distinctId = readFileSync(idPath, "utf8").trim(); } catch { /* New installation. */ }
      if (!this.distinctId) { this.distinctId = randomUUID(); writeFileSync(idPath, this.distinctId, { mode: 0o600 }); }
      const path = join(dataDir, "analytics.sqlite");
      this.db = new Database(path);
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS identities (key TEXT PRIMARY KEY, id TEXT NOT NULL)");
      if (options.autoFlush !== false) {
        this.timer = setInterval(() => { void this.flush(); }, 10_000);
        this.timer.unref();
        queueMicrotask(() => { void this.flush(); });
      }
    } catch { this.lastError = "local_storage_unavailable"; this.db?.close(); this.db = undefined; }
  }

  get enabled(): boolean { return !!this.db; }
  transaction<T>(work: () => T): T | undefined {
    if (!this.db) return;
    if (this.depth) return work();
    try { return this.db.transaction(() => { this.depth++; try { return work(); } finally { this.depth--; } })(); }
    catch { this.lastError = "local_queue_unavailable"; }
  }
  state<T>(key: string): T | undefined {
    const row = this.db?.query("SELECT data FROM checkpoints WHERE key=?").get(key) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }
  setState(key: string, data: unknown): void {
    this.db?.query("INSERT INTO checkpoints VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(key, JSON.stringify(data));
  }
  /** Raw PR numbers, run names, heads, and decision hashes never leave this local mapping. */
  id(key: string): string | null {
    if (!this.db) return null;
    const row = this.db.query("SELECT id FROM identities WHERE key=?").get(key) as { id: string } | null;
    if (row) return row.id;
    const id = randomUUID();
    this.db.query("INSERT INTO identities VALUES (?,?)").run(key, id);
    return id;
  }
  capture(event: AnalyticsEvent, properties: AnalyticsProperties = {}, key?: string): boolean {
    return this.transaction(() => {
      if (key && this.db!.query("SELECT 1 FROM receipts WHERE key=?").get(key)) return false;
      const count = this.db!.query("SELECT count(*) AS n FROM outbox").get() as { n: number };
      if (count.n >= 10_000) throw new Error("Analytics outbox is full");
      const id = randomUUID();
      const payload = JSON.stringify({ event, distinct_id: this.distinctId, timestamp: new Date(this.now()).toISOString(), properties: { ...properties, app: "woodshed", app_version: version, schema_version: 2, $process_person_profile: false, $geoip_disable: true, $insert_id: id } });
      this.db!.query("INSERT INTO outbox(id,payload) VALUES (?,?)").run(id, payload);
      if (key) this.db!.query("INSERT INTO receipts VALUES (?)").run(key);
      return true;
    }) ?? false;
  }
  status(): { enabled: boolean; queued: number; quarantined: number; lastError: string | null } {
    try {
      const row = this.db?.query("SELECT count(*) AS queued, coalesce(sum(quarantined),0) AS quarantined FROM outbox").get() as { queued: number; quarantined: number } | undefined;
      return { enabled: this.enabled, queued: row?.queued ?? 0, quarantined: row?.quarantined ?? 0, lastError: this.lastError };
    } catch { return { enabled: false, queued: 0, quarantined: 0, lastError: "local_storage_unavailable" }; }
  }
  flush(): Promise<void> {
    if (!this.db) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.drain().catch(() => { this.lastError = "delivery_unavailable"; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async drain(): Promise<void> {
    const destination = this.state<{ nextTry: number }>("delivery");
    if (destination && destination.nextTry > this.now()) return;
    const rows = this.db!.query("SELECT id,payload,attempts FROM outbox WHERE quarantined=0 AND next_try<=? ORDER BY rowid LIMIT 50").all(this.now()) as Queued[];
    for (const row of rows) {
      if (!this.db) return;
      let retryMs = Math.min(3600_000, 1000 * 2 ** Math.min(row.attempts, 12));
      try {
        const response = await this.send(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: this.token, ...JSON.parse(row.payload) }), signal: AbortSignal.timeout(4000) });
        if (!this.db) return;
        if (response.ok) { this.db.query("DELETE FROM outbox WHERE id=?").run(row.id); this.lastError = null; continue; }
        this.lastError = `http_${response.status}`;
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          this.db.query("UPDATE outbox SET quarantined=1 WHERE id=?").run(row.id);
          continue;
        }
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          const delay = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.now();
          if (Number.isFinite(delay)) retryMs = Math.max(retryMs, Math.min(86_400_000, delay));
        }
      } catch { this.lastError = "network_error"; }
      this.db?.query("UPDATE outbox SET attempts=attempts+1,next_try=? WHERE id=?").run(this.now() + retryMs, row.id);
      this.setState("delivery", { nextTry: this.now() + retryMs });
      break;
    }
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.db?.close(); this.db = undefined; }
}
