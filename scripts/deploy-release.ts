import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { command } from "../src/command";
import { defaultTokenPath } from "../src/connection";
import type { Mode } from "../src/model";

type State = { mode: Mode; syncing: boolean; prs: { job?: unknown }[]; health: { activeRuns: number; build?: { commit: string }; routingCheck?: { state: string }; analytics?: { enabled: boolean }; warnings?: { id: string; message: string }[] } };

// Older controllers don't report routingCheck, so an unknown state never counts as lost.
function integrations(health: State["health"]): Set<string> {
  const enabled = new Set<string>();
  if (health.routingCheck && health.routingCheck.state !== "off") enabled.add("typesafe");
  if (health.analytics?.enabled) enabled.add("posthog");
  return enabled;
}
export type Deployment = {
  state(): Promise<State>; mode(mode: Mode): Promise<void>;
  stop(): Promise<void>; backup(): Promise<void>; activate(): Promise<void>;
  rollback(): Promise<void>; start(): Promise<void>;
  wait(): Promise<void>; now(): number; aborted(): boolean;
};

// All waits happen before stopping the controller. A failed release returns to the previous code.
export async function deploy(ops: Deployment, commit: string, drainMS = 20 * 60_000, healthMS = 60_000): Promise<void> {
  const initial = await ops.state();
  const original = initial.mode;
  const before = integrations(initial.health);
  let stopped = false;
  const checkAbort = () => { if (ops.aborted()) throw Error("Deployment interrupted"); };
  try {
    if (original === "auto") await ops.mode("watch");
    const deadline = ops.now() + drainMS;
    while (true) {
      checkAbort();
      const state = await ops.state();
      if (state.mode !== (original === "auto" ? "watch" : original)) throw Error("Mode changed during deployment; leaving the current version running");
      if (!state.syncing && !state.health.activeRuns && !state.prs.some(pr => pr.job)) break;
      if (ops.now() >= deadline) throw Error("Repairs have not drained; leaving the current version running");
      await ops.wait();
    }
    checkAbort();
    stopped = true;
    await ops.stop();
    await ops.backup();
    await ops.activate();
    await ops.start();
    const healthDeadline = ops.now() + healthMS;
    while (true) {
      checkAbort();
      const health = await ops.state().then(state => state.health, () => undefined);
      if (health?.build?.commit === commit) {
        // A release must not silently drop an integration the running controller had, e.g. a lost .env.local.
        const lost = [...before].filter(name => !integrations(health).has(name));
        if (lost.length) throw Error(`New controller lost configured integrations: ${lost.join(", ")}`);
        const missing = health.warnings?.filter(w => w.id.endsWith("-missing")) ?? [];
        if (missing.length) throw Error(`New controller is missing required integrations: ${missing.map(w => w.message).join("; ")}`);
        break;
      }
      if (ops.now() >= healthDeadline) throw Error("New controller did not become healthy on the expected commit");
      await ops.wait();
    }
  } catch (error) {
    if (stopped) {
      await ops.stop();
      await ops.rollback();
      await ops.start();
    }
    throw error;
  } finally {
    // Respect a deliberate switch to Paused while the deployment was draining.
    if (original === "auto" && (await ops.state()).mode === "watch") await ops.mode("auto");
  }
}

async function main(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() === 0) throw Error("Deploy as the non-root controller user on Linux");
  const [targetArg, commit] = process.argv.slice(2);
  if (!targetArg || !/^[a-f0-9]{40}$/.test(commit ?? "")) throw Error("Usage: deploy-release.ts /absolute/release/path COMMIT");
  const target = realpathSync(targetArg);
  const current = join(homedir(), "woodshed-current");
  const previous = realpathSync(current);
  if (target === previous) { console.log(`Already deployed ${commit}`); return; }
  const info = await Bun.file(join(target, "build-info.json")).json();
  if (info.commit !== commit) throw Error("Release identity does not match the requested commit");
  const configPath = process.env.WOODSHED_CONFIG ?? join(homedir(), "repos/woodshed/woodshed.config.json");
  const config = await Bun.file(configPath).json();
  const token = (await Bun.file(defaultTokenPath()).text()).trim();
  const api = async (path: string, mode?: Mode): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${config.port ?? 7341}${path}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(mode ? { method: "POST", body: JSON.stringify({ mode }) } : {}), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error(`Controller returned HTTP ${response.status}`);
    return response.json();
  };
  const link = (path: string) => {
    const temporary = `${current}.next`;
    if (existsSync(temporary)) unlinkSync(temporary);
    symlinkSync(path, temporary); renameSync(temporary, current);
  };
  const stateDir = realpathSync(join(previous, ".woodshed"));
  symlinkSync(stateDir, join(target, ".woodshed"));
  const env = join(previous, ".env.local");
  if (existsSync(env)) symlinkSync(realpathSync(env), join(target, ".env.local"));
  let aborted = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { aborted = true; });
  await deploy({
    state: () => api("/api/state"), mode: mode => api("/api/settings", mode),
    stop: () => command(["systemctl", "--user", "stop", "woodshed.service"]).then(() => {}),
    start: () => command(["systemctl", "--user", "start", "woodshed.service"]).then(async () => {
      for (let i = 0; i < 30; i++) { try { await api("/health"); return; } catch { await Bun.sleep(1000); } }
      throw Error("Controller did not start");
    }),
    backup: async () => {
      const directory = join(homedir(), ".config/woodshed/backups"); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const db = new Database(join(stateDir, "state.sqlite"));
      try { db.exec(`VACUUM INTO '${join(directory, `before-${info.version}-${Date.now()}.sqlite`).replaceAll("'", "''")}'`); } finally { db.close(); }
    },
    activate: async () => { link(target); }, rollback: async () => { link(previous); },
    wait: () => Bun.sleep(3000), now: Date.now, aborted: () => aborted,
  }, commit!);
  console.log(`Deployed Woodshed ${info.version} (${commit})`);
}
if (import.meta.main) await main();
