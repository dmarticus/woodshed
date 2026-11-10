export {};
const alias = process.argv[2];
if (!alias || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(alias)) throw new Error("Provide a configured SSH host alias");
let child: ReturnType<typeof Bun.spawn> | undefined;
let stopped = false;
const shutdown = () => { stopped = true; child?.kill(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
let delay = 1;
while (!stopped) {
  const started = Date.now();
  child = Bun.spawn(["ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", "127.0.0.1:7341:127.0.0.1:7341", alias], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  await child.exited;
  if (Date.now() - started > 60_000) delay = 1;
  if (!stopped) { console.error(`Woodshed tunnel disconnected; reconnecting in ${delay}s`); await Bun.sleep(delay * 1000); delay = Math.min(delay * 2, 30); }
}
