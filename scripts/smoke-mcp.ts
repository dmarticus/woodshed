import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join, resolve } from "node:path";
import { controllerConnection, defaultTokenPath } from "../src/connection";

const root = resolve(import.meta.dir, "..");
const live = process.argv.includes("--live");
const connection = live ? controllerConnection() : undefined;
const url = live ? connection?.url ?? "http://127.0.0.1:7341" : "http://127.0.0.1:7345";
const tokenPath = live ? connection?.token_path ?? defaultTokenPath() : join(root, ".woodshed/preview-api-token");
const controller = live ? undefined : Bun.spawn([process.execPath, "src/server.ts"], { cwd: root, env: { ...process.env, WOODSHED_DEMO: "1", WOODSHED_PORT: "7345" }, stdout: "pipe", stderr: "pipe" });
const client = new Client({ name: "woodshed-smoke", version: "1" });
try {
  let ready = false; let token = "";
  for (let i = 0; i < 100; i++) {
    try { token = (await Bun.file(tokenPath).text()).trim(); ready = (await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error("Controller unavailable for MCP smoke check");
  const state = await fetch(`${url}/api/state`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()) as any;
  const number = state.prs.find((r: any) => r.snapshot.state === "OPEN")?.snapshot.number ?? state.prs[0]?.snapshot.number;
  if (!number) throw new Error("No fixture PR available");
  const env = Object.fromEntries(Object.entries({ ...process.env, WOODSHED_URL: url, WOODSHED_TOKEN_PATH: tokenPath }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/woodshed-mcp.js")], env, stderr: "pipe" }));
  const tools = (await client.listTools()).tools.map(t => t.name);
  const status = await client.callTool({ name: "get-pr-status", arguments: { number } });
  if (status.isError) throw new Error(JSON.stringify(status.content));
  const data = status.structuredContent as any;
  if (data.number !== number || !data.version) throw new Error("Invalid structured PR status");
  const attention = await client.callTool({ name: "list-attention", arguments: {} });
  if (attention.isError) throw new Error("Attention query failed");
  const wait = await client.callTool({ name: "wait-for-change", arguments: { number, version: data.version, timeout_seconds: 0 } });
  if (wait.isError) throw new Error("Bounded status wait failed");
  await client.readResource({ uri: `woodshed://prs/${number}` });
  await client.readResource({ uri: `woodshed://prs/${number}/readiness` });
  await client.readResource({ uri: "woodshed://playbooks" });
  console.log(JSON.stringify({ passed: true, live, tools, number, phase: data.phase, stale: data.stale, structuredStatus: true, boundedWait: true, resource: true }));
} finally { await client.close(); controller?.kill(); if (controller) await controller.exited; }
