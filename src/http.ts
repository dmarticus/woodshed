import { approvalRequestState } from "./model";
import type { Controller } from "./controller";
import { authorized } from "./api-auth";
import { StateEvents } from "./events";
import { randomBytes } from "node:crypto";
import type { Settings } from "./settings";
import { AgentAPI } from "./agent-api";
import { readiness, readinessSummary } from "./readiness";

export function handler(controller: Controller, settings: Settings, token = randomBytes(32).toString("hex"), events = new StateEvents()): (request: Request) => Promise<Response> {
  const origin = `http://127.0.0.1:${controller.config.port}`;
  const agentAPI = new AgentAPI(controller);
  return async request => {
    const url = new URL(request.url);
    const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    if (request.headers.get("host") !== `127.0.0.1:${controller.config.port}`) return json({ error: "Invalid host" }, 403);
    if (!authorized(request, token)) return json({ error: "Woodshed authentication required" }, 401);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json(controller.health());
      if (request.method === "GET" && url.pathname === "/api/events") { events.publish(publicState(controller, settings)); return events.response(); }
      if (request.method === "GET" && url.pathname === "/api/state") return json(publicState(controller, settings));
      if (request.method === "GET" && url.pathname === "/api/agent/inbox") return json(agentAPI.inbox());
      if (request.method === "GET" && url.pathname === "/api/agent/attention") return json(agentAPI.attention());
      if (request.method === "GET" && url.pathname === "/api/agent/playbooks") return json({ playbooks: controller.playbooks.catalog() });
      const proof = url.pathname.match(/^\/api\/agent\/prs\/(\d+)\/readiness$/);
      if (request.method === "GET" && proof) return json(agentAPI.readiness(Number(proof[1])));
      const status = url.pathname.match(/^\/api\/agent\/prs\/(\d+)(\/wait)?$/);
      if (request.method === "GET" && status) {
        const number = Number(status[1]);
        return json(status[2] ? await agentAPI.wait(number, url.searchParams.get("version") ?? "", Number(url.searchParams.get("timeout_seconds") ?? 20), request.signal) : agentAPI.status(number));
      }
      if (request.method === "GET" && url.pathname === "/api/models") return json({ models: await controller.runner.models.list() });
      if (request.method === "GET" && url.pathname === "/") return json({ service: "Woodshed", interface: "macOS menu bar", status: "running" });
      const agent = url.pathname.match(/^\/api\/prs\/(\d+)\/agent$/);
      if (request.method === "GET" && agent) {
        const record = controller.store.get(Number(agent[1]));
        if (!record?.job) return json({ error: "No agent session for this PR" }, 404);
        return json(await controller.runner.inspect(record.job));
      }
      if (request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 16000) return json({ error: "Request is too large" }, 413);
        const input = raw ? JSON.parse(raw) : {};
        if (url.pathname === "/api/analytics") {
          if (settings.demo) return json({ ok: true });
          const number = Number.isSafeInteger(input.number) && input.number > 0 && controller.store.get(input.number) ? input.number : undefined;
          if (["open_pr", "copy_pr_link", "merge_on_github", "open_session"].includes(input.action)) controller.telemetry?.action(number, input.action, "native_app");
          if (input.event === "notification") controller.telemetry?.notification(input.action, number);
          if (input.event === "ui" && ["app", "main", "settings"].includes(input.action)) controller.analytics?.capture("woodshed_ui_opened", { surface: input.action, source: "native_app" });
          return json({ ok: true });
        }
        if (url.pathname === "/api/agent/handoff") {
          if (settings.demo) return json({ error: "Handoffs are disabled in previews" }, 409);
          const result = await controller.handoff(input); void controller.sync();
          return json({ handoff_id: result.handoff.id, accepted_head: result.handoff.head, replayed: result.replayed, status: agentAPI.status(result.handoff.number) });
        }
        const recheck = url.pathname.match(/^\/api\/agent\/prs\/(\d+)\/recheck$/);
        if (recheck) {
          if (settings.demo) return json({ error: "Live rechecks are disabled in previews" }, 409);
          if (typeof input.head !== "string" || !/^[a-f0-9]{40}$/.test(input.head)) return json({ error: "Include the exact PR head being rechecked" }, 400);
          const number = Number(recheck[1]); await controller.action(number, "recheck", { head: input.head, source: "mcp" }); void controller.sync();
          return json(agentAPI.status(number));
        }
        if (url.pathname === "/api/power") {
          if (!["sleep", "wake"].includes(input.event)) return json({ error: "Invalid power event" }, 400);
          controller.power(input.event); if (input.event === "wake") void controller.sync();
          return json({ ok: true });
        }
        if (url.pathname === "/api/settings") {
          const before = settings.public().mode;
          await settings.update(input);
          if (!settings.demo) {
            controller.telemetry?.modeChanged(before);
            const keys = Object.keys(input).filter(key => ["pollSeconds", "maxAttempts", "maxConcurrentJobs", "defaultModel", "retryModel", "escalateOnRetry", "runCapUSD", "dailyCapUSD", "modelPrices", "watchFilter", "watchQuery"].includes(key)).sort();
            if (keys.length) controller.analytics?.capture("woodshed_settings_changed", { fields: keys.join(","), source: "native_app" });
          }
          if (before !== settings.public().mode) controller.store.log(null, `Mode: ${settings.public().mode}`);
          if (!settings.demo) void controller.sync();
          return json({ ok: true });
        }
        if (url.pathname === "/api/refresh") { if (!settings.demo) { controller.telemetry?.action(undefined, "refresh_all", "native_app"); void controller.sync(); } return json({ ok: true }); }
        const match = url.pathname.match(/^\/api\/prs\/(\d+)\/(pause|resume|reply|interrupt|retry|reviewer|watch|unwatch|skip|recheck|topup|stop|confirm-reply|discard-reply|mark-ready|mark-draft|request-approval)$/);
        if (match) {
          if (settings.demo && ["reply", "interrupt", "retry", "reviewer", "watch", "unwatch", "skip", "recheck", "topup", "stop", "confirm-reply", "discard-reply", "mark-ready", "mark-draft", "request-approval"].includes(match[2])) return json({ error: "Live actions are disabled in previews" }, 409);
          if (["reply", "interrupt", "retry", "reviewer", "watch", "unwatch", "skip", "recheck", "topup", "stop", "confirm-reply", "discard-reply", "mark-ready", "mark-draft", "request-approval"].includes(match[2]) && typeof input.head !== "string") return json({ error: "Include the PR head when submitting a decision" }, 400);
          for (const key of ["model", "promptId", "decisionId", "questionKey", "runId"]) if (input[key] !== undefined && typeof input[key] !== "string") return json({ error: "Invalid action input" }, 400);
          if (input.message !== undefined && typeof input.message !== "string" || input.reviewer !== undefined && typeof input.reviewer !== "string") return json({ error: "Invalid action input" }, 400);
          if (input.amount !== undefined && (typeof input.amount !== "number" || !Number.isFinite(input.amount))) return json({ error: "Invalid top-up amount" }, 400);
          if (input.source !== undefined && !["native_app", "notification"].includes(input.source)) return json({ error: "Invalid action source" }, 400);
          if (settings.demo && ["pause", "resume"].includes(match[2])) {
            const record = controller.store.get(Number(match[1]));
            if (!record) return json({ error: "PR not found" }, 404);
            record.paused = match[2] === "pause"; record.decision = { kind: record.paused ? "paused" : "waiting", reason: record.paused ? "Paused by you" : "Watching this PR" }; controller.store.put(record);
          } else await controller.action(Number(match[1]), match[2], input);
          if (!settings.demo) void controller.sync();
          return json({ ok: true });
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (!settings.demo && ["/api/agent/handoff", "/api/settings"].includes(url.pathname)) controller.analytics?.capture("woodshed_action_failed", { action: url.pathname === "/api/settings" ? "settings" : "handoff", source: url.pathname === "/api/settings" ? "native_app" : "mcp" });
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
}

export function publicState(controller: Controller, settings: Settings): unknown {
  const records = controller.store.all(); const runs = controller.store.runs();
  return { repository: controller.config.repository, mode: settings.public().mode, automation: settings.public().automation, paused: settings.public().paused, demo: settings.demo, lastSync: controller.lastSync, syncing: controller.syncing || controller.refreshingAttention, error: controller.error, health: controller.health(), settings: settings.public(), prs: records.map(record => ({ ...record, queue: controller.queueStatus(record), approvalRequests: undefined, canMarkReady: controller.github.canMaintainKnown(record.snapshot), approval: approvalRequestState(record, controller.github.canMaintainKnown(record.snapshot), settings.public().mode), readiness: readinessSummary(readiness(record, controller.config, records, runs)) })), events: controller.store.events(), runs, spend: controller.store.spend(controller.config.dailyCapUSD ?? 20), models: controller.runner.models?.prices(controller.runner.models.cache) ?? [] };
}
