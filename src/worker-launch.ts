import { mkdirSync, rmSync } from "node:fs";
import { readWorkerToken, workerEnvironment } from "./worker-credentials";

const [tokenPath, configDirectory, separator, ...argv] = process.argv.slice(2);
if (!tokenPath || !configDirectory || separator !== "--" || !argv.length) {
  console.error("Usage: worker-launch.ts <token file> <gh config directory> -- <command>");
  process.exit(2);
}
let token: string;
try { token = readWorkerToken(tokenPath); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(78); }
// A fresh, empty gh config each launch, so a worker never finds a stored login.
rmSync(configDirectory, { recursive: true, force: true });
mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
const child = Bun.spawn(argv, { env: workerEnvironment(process.env, token, configDirectory), stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
// The terminal already delivers Ctrl-C to the whole process group; forwarding it would interrupt twice.
process.on("SIGINT", () => {});
process.exit(await child.exited);
