// Answers an isolated run's question or permission request. Run it on the controller host as the controller's user:
//   woodshed-respond                  list runs waiting for an answer
//   woodshed-respond <job>            show the run's recent output and its request, then ask for your answer
//   woodshed-respond <job> <answer>   answer without prompting ("approve" or "deny" for a permission request)
// The agent runs as a user that cannot write the approvals directory, so it cannot answer its own requests,
// and the controller's API refuses permission answers. Only someone with a shell on this host can.
import { existsSync, readdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { readUntrustedJSON } from "../src/sessions";
import type { WorkerState } from "../src/worker";

const jobs = join(realpathSync(resolve(import.meta.dir, "..", ".woodshed")), "jobs");
// The agent writes its request text and output; strip control characters it could use to rewrite the terminal.
const printable = (text: string): string => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

function waiting(name: string): WorkerState | undefined {
  try {
    const run: WorkerState = readUntrustedJSON(join(jobs, name, "worker", "runtime.json"));
    return run.id === name && run.prompt && run.status === "blocked" ? run : undefined;
  } catch { return undefined; }
}

async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
}

const [name, ...rest] = process.argv.slice(2);
if (!name) {
  const names = existsSync(jobs) ? readdirSync(jobs).filter(n => /^ws-[a-z0-9-]{1,60}$/.test(n) && waiting(n)) : [];
  if (!names.length) console.log("No isolated run is waiting for an answer.");
  for (const n of names) { const run = waiting(n)!; console.log(`${n}  PR #${run.number}  ${run.prompt!.kind}: ${printable(run.prompt!.text).split("\n")[0].slice(0, 120)}`); }
  process.exit(0);
}
if (!/^ws-[a-z0-9-]{1,60}$/.test(name) || !existsSync(join(jobs, name, "approvals"))) throw new Error(`${name} is not an isolated run on this host`);
const run = waiting(name);
if (!run?.prompt) { console.log(`${name} is not waiting for an answer.`); process.exit(1); }
const prompt = run.prompt;
if (!rest.length) {
  const output = await Bun.file(join(jobs, name, "output.log")).text().catch(() => "");
  console.log(printable(output.split("\n").slice(-40).join("\n")).replace(/\r/g, ""));
  console.log(`\n── PR #${run.number}, ${prompt.kind === "permission" ? "permission request" : "question"} ──\n${printable(prompt.text)}\n`);
}
let answer = rest.join(" ").trim() || await ask(prompt.kind === "permission" ? "Type approve or deny: " : "Your answer: ");
if (prompt.kind === "permission") {
  answer = answer.toLowerCase();
  if (!["approve", "deny"].includes(answer)) throw new Error("Answer a permission request with approve or deny");
}
if (!answer) throw new Error("No answer given");

const id = randomUUID();
const request = join(jobs, name, "approvals", `${id}.json`);
await Bun.write(`${request}.tmp`, JSON.stringify({ promptId: prompt.id, answer })); renameSync(`${request}.tmp`, request);
const ack = join(jobs, name, "worker", "approvals", `${id}.json.ack`);
let result: { error?: string } | undefined;
const deadline = Date.now() + 15_000;
while (!result && Date.now() < deadline) {
  if (existsSync(ack)) result = readUntrustedJSON(ack); else await Bun.sleep(100);
}
// The worker cannot delete what it reads here, so the request is removed once it is answered or abandoned.
unlinkSync(request);
if (!result) throw new Error("The run did not confirm the answer. Check whether it is still running before answering again.");
if (result.error) throw new Error(`The run did not accept the answer: ${printable(String(result.error))}`);
console.log(prompt.kind === "permission" ? `Sent: ${answer}.` : "Sent your answer.");
