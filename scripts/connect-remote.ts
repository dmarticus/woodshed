import { mkdirSync, chmodSync, renameSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { supportDirectory, validateConnection } from "../src/connection";

const [machine, source] = process.argv.slice(2);
if (!source || !machine) throw new Error("Usage: bun scripts/connect-remote.ts <hc-machine-alias> <private-remote-token-file>");
const attributes = lstatSync(source);
if (!attributes.isFile() || attributes.isSymbolicLink() || attributes.uid !== process.getuid?.() || attributes.size > 256 || attributes.mode & 0o077) throw new Error("The remote token file must be private and owned by you");
const token = (await Bun.file(source).text()).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid remote controller credential");
const directory = supportDirectory();
const connection = validateConnection({ url: "http://127.0.0.1:7341", token_path: join(directory, "remote-api-token"), machine });
const response = await fetch(`${connection.url}/health`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
if (!response.ok || (await response.json() as { remote?: boolean }).remote !== true) throw new Error("The SSH tunnel must reach the headless controller before connecting");
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const [path, contents] of [[connection.token_path, token + "\n"], [join(directory, "controller.json"), JSON.stringify(connection) + "\n"]]) {
  await Bun.write(`${path}.tmp`, contents); chmodSync(`${path}.tmp`, 0o600); renameSync(`${path}.tmp`, path);
}
console.log(`Connected to ${machine}. Reopen Woodshed and reconnect MCP. Enable Auto only after confirming the local controller is stopped.`);
