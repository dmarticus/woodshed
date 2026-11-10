import { join, resolve } from "node:path";
import { Store } from "../src/store";
import { command } from "../src/command";
import type { WorkerConfig, WorkerState } from "../src/worker";

const root = resolve(import.meta.dir, "..");
const config = await Bun.file(join(root, "woodshed.config.json")).json();
const store = new Store(join(root, ".woodshed/state.sqlite"));
for (const number of process.argv.slice(2).map(Number)) {
  const record = store.get(number);
  if (!record?.job || record.job.adapter !== "app-server") continue;
  const job = record.job; const directory = join(root, ".woodshed/jobs", job.name);
  const runtimePath = join(directory, "runtime.json");
  const run: WorkerState = await Bun.file(runtimePath).json();
  if (run.status === "done" || run.state === "budget") { console.log(`Left completed/capped PR ${number} for normal reconciliation`); continue; }
  if (run.status === "blocked" && !(run.prompt?.kind === "permission" && /fetch.*(?:reviews|checks|CI|GitHub)|read.*(?:CI log|reviews|checks)/i.test(run.summary))) {
    console.log(`Preserved the actual decision for PR ${number}`); continue;
  }
  await command(["hc", "kill", job.name]);
  const path = join(directory, "worker.json");
  const previous: WorkerConfig = await Bun.file(path).json();
  if (!run.threadId) throw new Error(`PR ${number} has no resumable thread`);
  const prompt = previous.prompt.replace(/If ordinary git publishing is permitted,[^\n]*/, "Do not stage, commit, or push. Woodshed validates, signs, and publishes your declared changed files.")
    .replace('"outcome":"published"|"needs_human"|"superseded","reason":', '"outcome":"ready_to_publish"|"needs_human"|"superseded","files":["exact/relative/changed/file"],"reason":');
  await Bun.write(path, JSON.stringify({ ...previous, prompt, gitSigningKey: config.gitSigningKey, resumeThreadId: run.threadId, resumeQueued: true }));
  await command(["hc", "run", "--json", "--bg", "--no-parent", "--name", job.name, "--cwd", previous.checkout, process.execPath, join(root, "src/worker.ts"), path]);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(200);
    const current: WorkerState = await Bun.file(runtimePath).json();
    if (current.status === "blocked" && !current.prompt && current.summary.startsWith("Ready to resume")) { ready = true; break; }
    if (current.status === "error" || current.state === "budget") throw new Error(`PR ${number} could not resume: ${current.summary}`);
  }
  if (!ready) throw new Error(`PR ${number} did not confirm its updated runtime`);
  record.pendingReply = "The owner has authorized routine GitHub fetches, reviews, and CI/log reads. Continue the original PR task and preserve existing work. GitHub access and Woodshed signing are configured. Do not ask for confirmation merely to fetch or read GitHub.";
  record.pendingPromptId = undefined; record.humanHead = undefined; record.humanReason = undefined;
  record.decision = { kind: "waiting", reason: "Authorized GitHub access; queued to resume" }; store.put(record);
  console.log(`PR ${number} upgraded in its existing worktree and queued within the concurrency limit`);
}
