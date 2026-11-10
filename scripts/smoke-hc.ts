import { randomUUID } from "node:crypto";
import { command } from "../src/command";

const name = `ws-smoke-${randomUUID().slice(0, 8)}`;
let started = false;
try {
  const result = JSON.parse(await command(["hc", "run", "--json", "--bg", "--no-parent", "--name", name, "/usr/bin/true"]));
  started = true;
  if (!result.address) throw new Error("hc returned no terminal address");
  const wait = JSON.parse(await command(["hc", "wait", "--json", "--timeout", "10", name]));
  const terminal = JSON.parse(await command(["hc", "get", "--json", name]));
  if (terminal.state !== "finished" || terminal.exit_code !== 0) throw new Error(JSON.stringify({ wait, terminal }));
  console.log("hc smoke passed: detached launch, wait, exact status, exit code");
} finally {
  if (started) await command(["hc", "rm", name]);
}
