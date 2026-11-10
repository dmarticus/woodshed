import { resolve, isAbsolute } from "node:path";
import { Controller } from "./controller";
import { demoRecords, seedDemoOutcomes, demoDecisionRepository } from "./demo";
import { GitHub } from "./github";
import { Runner } from "./runner";
import { Store } from "./store";
import { Settings } from "./settings";
import { loadAPIToken } from "./api-auth";
import { StateEvents } from "./events";
import { cleanArtifacts } from "./housekeeping";
import { PowerGuard } from "./power";
import { handler, publicState } from "./http";
import { modeOf, type Config } from "./model";
import { Analytics } from "./analytics";

const demo = process.env.WOODSHED_DEMO === "1";
const root = resolve(import.meta.dir, "..");
const configPath = process.env.WOODSHED_CONFIG ?? resolve(root, "woodshed.config.json");
const supplied = await Bun.file(configPath).exists() ? await Bun.file(configPath).json() : {};
const config: Config = {
  repository: "PostHog/posthog", author: "@me", checkout: "", pollSeconds: 90, maxAttempts: 3,
  maxConcurrentJobs: 1, automation: false, port: 7341, reviewLabel: "posthog-review", approvalLabel: "stamphog", runCapUSD: 5, dailyCapUSD: 20, workerProtocol: "app-server", defaultModel: "gpt-6.1-terra", ...supplied,
};
if (demo) config.repository = "example/project";
if (!config.defaultModel) config.defaultModel = "gpt-6.1-terra";
config.mode = demo ? "watch" : modeOf(config);
config.automation = config.mode === "auto"; config.paused = config.mode === "paused";
if (config.gitSigningKey) process.env.WOODSHED_SIGNING_KEY = config.gitSigningKey;
if (!["watch", "auto", "paused"].includes(config.mode)) throw new Error("mode must be watch, auto, or paused");
for (const key of ["runCapUSD", "dailyCapUSD"] as const) if (!Number.isFinite(config[key]) || config[key]! < 0 || config[key]! > 10000) throw new Error(`${key} must be between $0 and $10,000`);
if (process.env.WOODSHED_PORT) config.port = Number(process.env.WOODSHED_PORT);
if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) throw new Error("repository must be owner/name");
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error("port must be 1024–65535");
if (!Number.isFinite(config.pollSeconds) || config.pollSeconds < 30) throw new Error("pollSeconds must be at least 30");
if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || !Number.isInteger(config.maxConcurrentJobs) || config.maxConcurrentJobs < 1) throw new Error("Job limits must be positive integers");
if (config.concurrencyMode !== undefined && !["fixed", "adaptive"].includes(config.concurrencyMode)) throw new Error("concurrencyMode must be fixed or adaptive");
for (const [key, min, max] of [["cpuTargetPercent", 20, 95], ["memoryTargetPercent", 50, 90]] as const) if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key]! < min || config[key]! > max)) throw new Error(`${key} must be an integer between ${min} and ${max}`);
if (typeof config.automation !== "boolean") throw new Error("automation must be a boolean");
if (config.automation && (!isAbsolute(config.checkout) || !await Bun.file(resolve(config.checkout, "AGENTS.md")).exists())) throw new Error("Set checkout to an absolute repository path containing AGENTS.md before enabling automation");
const store = new Store(demo ? ":memory:" : resolve(root, ".woodshed", "state.sqlite"));
if (demo) demoRecords().forEach(r => store.put(r));
const analytics = new Analytics(resolve(root, ".woodshed"), { enabled: !demo });
const controller = new Controller(config, store, new GitHub(config), new Runner(config, resolve(root, ".woodshed")), Date.now, analytics, undefined, demo ? demoDecisionRepository() : undefined);
if (demo) { controller.github.viewerName = "demo"; seedDemoOutcomes(store, config); await controller.decisions.processPending(); }
const settings = new Settings(config, configPath, demo);
if (!demo) await controller.prepareAttention();
if (!demo) analytics.capture("woodshed_started", { mode: config.mode, component: "controller", remote: process.env.WOODSHED_REMOTE === "1" });
const apiToken = loadAPIToken(demo ? resolve(root, ".woodshed", "preview-api-token") : undefined);
const events = new StateEvents();
const publish = (): void => events.publish(publicState(controller, settings));
let scheduled = false;
store.onChange = () => { if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; publish(); }, 50); } };
const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: 32768, idleTimeout: 60, fetch: handler(controller, settings, apiToken, events) });
console.log(`Woodshed ${demo ? "demo" : config.mode} listening at ${server.url}`);
const power = new PowerGuard();
setInterval(() => {
  const resumed = power.update(!demo && store.all().some(r => !!r.job && !r.resumeRequested && ["running", "preparing"].includes(store.run(r.job.name)?.state ?? "")));
  if (resumed && !demo) { controller.power("wake", false); void controller.sync(); }
  publish();
}, 1000);
process.on("exit", () => power.close());
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => { server.stop(); power.close(); await Promise.race([analytics.flush(), Bun.sleep(1500)]); analytics.close(); process.exit(0); })();
});
if (!demo) {
  void cleanArtifacts(resolve(root, ".woodshed"), store, Date.now(), undefined, controller.decisions).catch(error => store.log(null, `Housekeeping: ${error.message}`));
  setInterval(() => { void cleanArtifacts(resolve(root, ".woodshed"), store, Date.now(), undefined, controller.decisions).catch(error => store.log(null, `Housekeeping: ${error.message}`)); }, 6 * 3600000);
  void controller.runner.models.list().catch(error => console.error(`Model catalog: ${error.message}`));
  void controller.sync();
  setInterval(() => { void controller.decisions.processPending().catch(error => store.log(null, `Decision promotion deferred: ${error.message}`)); }, 30_000);
  setInterval(() => { void controller.refreshMergeQueues(); }, 30_000);
  setInterval(() => { void controller.refreshAttention().catch(error => { controller.error = error.message; }); }, 30_000);
  setInterval(() => { void controller.fillWorkers(); }, 2_000);
  setInterval(() => { void controller.checkBudgets().catch(error => { controller.error = error.message; }); }, 1000);
  const schedule = (): void => { setTimeout(() => { controller.error = null; void controller.sync().finally(schedule); }, config.pollSeconds * 1000); };
  schedule();
}
