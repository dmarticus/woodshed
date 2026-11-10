import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Record, Run } from "./model";
import { bindDecision } from "./decisions";
import { localDay } from "./usage";
import type { Handoff } from "./handoff";

export class Store {
  db: Database;
  onChange?: () => void;
  localHistory?: { record(record: Record): void; run(run: Run): void; audit(kind: string, number: number, data: any): void };
  observer?: { record: (record: Record, previous?: Record) => void; run: (run: Run, previous?: Run) => void };
  private observe(work: () => void): void { try { work(); } catch { /* Optional analytics never interrupts persistence. */ } }
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { this.onChange?.(); for (const listener of this.listeners) listener(); }
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS prs (number INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, number INTEGER, message TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, number INTEGER NOT NULL, started TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS usage_days (run TEXT NOT NULL, day TEXT NOT NULL, cost REAL NOT NULL, PRIMARY KEY(run, day))");
    this.db.exec("CREATE TABLE IF NOT EXISTS handoffs (request_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS automation_actions (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS outcome_handoffs (request_id TEXT PRIMARY KEY, repository TEXT NOT NULL, author TEXT NOT NULL, number INTEGER NOT NULL, received_at TEXT NOT NULL, data TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, time TEXT NOT NULL, kind TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS outcomes_request_kind ON outcomes(request_id,kind,id); CREATE INDEX IF NOT EXISTS outcome_handoffs_scope ON outcome_handoffs(repository,author,received_at)");
    this.db.exec("CREATE TABLE IF NOT EXISTS outcome_runs (run TEXT PRIMARY KEY, request_id TEXT NOT NULL, data TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS merged_decisions (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, repository TEXT NOT NULL, author TEXT NOT NULL, merged_at TEXT NOT NULL, data TEXT NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS merged_decisions_scope ON merged_decisions(repository,author,merged_at)");
    this.db.exec("CREATE TABLE IF NOT EXISTS decision_promotions (request_id TEXT PRIMARY KEY, repository TEXT NOT NULL, author TEXT NOT NULL, state TEXT NOT NULL, retry_at TEXT NOT NULL, data TEXT NOT NULL)");
    const noTurnRuns = this.db.query("SELECT data FROM runs WHERE json_extract(data,'$.costUSD') IS NULL AND json_extract(data,'$.turns')=0 AND json_extract(data,'$.endedAt') IS NOT NULL").all() as { data: string }[];
    for (const row of noTurnRuns) {
      const run = JSON.parse(row.data) as Run;
      run.costUSD = 0;
      this.saveRun(run);
    }
  }
  claimAction(key: string, data: unknown): boolean { return this.db.query("INSERT OR IGNORE INTO automation_actions VALUES (?,?)").run(key, JSON.stringify(data)).changes === 1; }
  handoff(requestId: string): Handoff | undefined {
    const row = this.db.query("SELECT data FROM handoffs WHERE request_id=?").get(requestId) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }
  acceptHandoff(record: Record, handoff: Handoff): void {
    const previous = this.observer ? this.get(record.snapshot.number) : undefined;
    bindDecision(record);
    this.db.transaction(() => {
      this.db.query("INSERT INTO handoffs VALUES (?,?)").run(handoff.request_id, JSON.stringify(handoff));
      this.db.query("INSERT INTO prs VALUES (?,?) ON CONFLICT(number) DO UPDATE SET data=excluded.data").run(record.snapshot.number, JSON.stringify(record));
      this.localHistory?.record(record);
    })();
    this.observe(() => this.observer?.record(record, previous));
    this.changed();
  }
  audit(kind: string, number: number, data: unknown): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)");
    this.db.transaction(() => {
      this.db.query("INSERT INTO audits(time,number,kind,data) VALUES(?,?,?,?)").run(new Date().toISOString(), number, kind, JSON.stringify(data));
      this.localHistory?.audit(kind, number, data);
    })();
  }
  all(): Record[] { return this.db.query("SELECT data FROM prs ORDER BY number DESC").all().map((row: any) => JSON.parse(row.data)); }
  get(number: number): Record | undefined {
    const row = this.db.query("SELECT data FROM prs WHERE number=?").get(number) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }
  put(record: Record): void {
    const previous = this.observer ? this.get(record.snapshot.number) : undefined;
    bindDecision(record);
    this.db.transaction(() => {
      this.db.query("INSERT INTO prs VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET data=excluded.data").run(record.snapshot.number, JSON.stringify(record));
      this.localHistory?.record(record);
    })();
    this.observe(() => this.observer?.record(record, previous));
    this.changed();
  }
  log(number: number | null, message: string): void {
    this.db.query("INSERT INTO events (time,number,message) VALUES (?,?,?)").run(new Date().toISOString(), number, message);
    this.changed();
  }
  events(): unknown[] { return this.db.query("SELECT * FROM events ORDER BY id DESC LIMIT 100").all(); }
  saveRun(run: Run): void {
    const previous = this.observer ? this.run(run.id) : undefined;
    this.db.transaction(() => {
      this.db.query("INSERT INTO runs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(run.id, run.number, run.startedAt, JSON.stringify(run));
      this.db.query("INSERT OR IGNORE INTO usage_days VALUES (?,?,0)").run(run.id, localDay(new Date(run.startedAt)));
      this.localHistory?.run(run);
      for (const [day, cost] of Object.entries(run.costsByDay)) this.db.query("INSERT INTO usage_days VALUES (?,?,?) ON CONFLICT(run,day) DO UPDATE SET cost=excluded.cost").run(run.id, day, cost);
    })();
    this.observe(() => this.observer?.run(run, previous));
    this.changed();
  }
  run(id: string): Run | undefined {
    const row = this.db.query("SELECT data FROM runs WHERE id=?").get(id) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }
  runs(): Run[] { return this.db.query("SELECT data FROM runs ORDER BY started DESC LIMIT 300").all().map((r: any) => JSON.parse(r.data)); }
  unfinishedRuns(): Run[] { return this.db.query("SELECT data FROM runs WHERE json_extract(data,'$.endedAt') IS NULL").all().map((r: any) => JSON.parse(r.data)); }
  spent(day: string): number { return (this.db.query("SELECT COALESCE(SUM(cost),0) AS total FROM usage_days WHERE day=?").get(day) as { total: number }).total; }
  spend(cap: number) {
    const day = localDay();
    const count = (this.db.query("SELECT COUNT(*) AS n FROM usage_days WHERE day=?").get(day) as { n: number }).n;
    const unknown = (this.db.query("SELECT COUNT(*) AS n FROM runs r JOIN usage_days u ON r.id=u.run WHERE u.day=? AND json_extract(r.data,'$.costUSD') IS NULL AND json_extract(r.data,'$.endedAt') IS NOT NULL").get(day) as { n: number }).n;
    const totals = this.db.query("SELECT number, CASE WHEN COUNT(json_extract(data,'$.costUSD')) < COUNT(*) THEN NULL ELSE SUM(json_extract(data,'$.costUSD')) END AS cost FROM runs GROUP BY number").all() as { number: number; cost: number | null }[];
    return { day, spentUSD: this.spent(day), capUSD: cap, runs: count, unknownRuns: unknown, prTotals: Object.fromEntries(totals.map(t => [String(t.number), t.cost])) };
  }
}
