import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { supportDirectory } from "../src/connection";

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, error, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(`${argv[0]} failed: ${error.slice(0, 1600)}`);
  return out.trim();
}

const directory = join(supportDirectory(), "signing");
mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
const key = join(directory, "id_ed25519");
if (!await Bun.file(key).exists()) await run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "Woodshed commit signing", "-f", key]);
chmodSync(key, 0o600);
const publicKey = (await Bun.file(`${key}.pub`).text()).trim();
const identity = (value: string) => value.split(/\s+/).slice(0, 2).join(" ");
const login = await run(["gh", "api", "user", "--jq", ".login"]);
const registered = async () => {
  const keys = JSON.parse(await run(["gh", "api", `users/${login}/ssh_signing_keys`, "--paginate", "--slurp"])).flat();
  return keys.some((k: { key: string }) => identity(k.key) === identity(publicKey));
};
if (!await registered()) {
  try { await run(["gh", "ssh-key", "add", `${key}.pub`, "--type", "signing", "--title", `Woodshed on ${hostname()}`]); }
  catch (error) { console.error(`Public signing key prepared at ${key}.pub. GitHub registration is still required.`); throw error; }
}
if (!await registered()) throw new Error("GitHub did not confirm the new public signing key");
const configPath = resolve(process.env.WOODSHED_CONFIG ?? "woodshed.config.json");
const config = await Bun.file(configPath).json();
await Bun.write(`${configPath}.tmp`, JSON.stringify({ ...config, gitSigningKey: key }, null, 2) + "\n");
chmodSync(`${configPath}.tmp`, 0o600);
renameSync(`${configPath}.tmp`, configPath);
console.log(`Woodshed signing configured for ${login}. Fingerprint: ${await run(["/usr/bin/ssh-keygen", "-lf", `${key}.pub`])}`);
