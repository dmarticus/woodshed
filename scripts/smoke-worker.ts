import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "../src/command";
import { publishedPrices } from "../src/usage";

const directory = mkdtempSync(join(tmpdir(), "woodshed-worker-smoke-"));
const resultDirectory = join(directory, "result"); mkdirSync(resultDirectory);
const name = `ws-smoke-${randomUUID().slice(0, 8)}`;
const model = "gpt-6.1-sol";
await Bun.write(join(directory, "AGENTS.md"), "This is an isolated Woodshed smoke test. Only create the requested result file. No network or shell commands are needed.\n");
const path = join(directory, "worker.json");
await Bun.write(path, JSON.stringify({ id: name, number: 0, checkout: directory, directory, resultDirectory, model, price: publishedPrices[model], prices: publishedPrices, budgetUSD: 1, startedAt: new Date().toISOString(), prompt: `Create ${join(resultDirectory, "result.json")} with exactly {"outcome":"needs_human","reason":"Smoke test question: keep the sample behavior?"}. Do not inspect other files, use the network, run commands, start subagents, or modify a repository. Then stop.` }));
let started = false;
try {
  await command(["hc", "run", "--json", "--bg", "--no-parent", "--name", name, "--cwd", directory, process.execPath, join(import.meta.dir, "../src/worker.ts"), path]);
  started = true;
  await command(["hc", "wait", "--json", "--timeout", "55", name]);
  const state = await Bun.file(join(directory, "runtime.json")).json();
  if (state.status !== "blocked" || !state.usage?.totalTokens || state.costUSD === null) throw new Error(`Worker did not reach a metered question: ${JSON.stringify({ status: state.status, summary: state.summary, tokens: state.usage?.totalTokens })}`);
  console.log(JSON.stringify({ metered: true, question: state.prompt?.kind, model: state.model, tokens: state.usage.totalTokens, estimatedUSD: state.costUSD, directory }));
} finally {
  if (started) { await command(["hc", "kill", name]); await command(["hc", "rm", name]); }
}
