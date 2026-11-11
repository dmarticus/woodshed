import { mkdirSync, chmodSync, renameSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../src/command";

export function headlessUnit(root: string, bun: string, home: string): string {
  const quote = (path: string): string => {
    if (/[\r\n\0]/.test(path)) throw new Error("Use paths without line breaks");
    return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  };
  if ([root, bun, home].some(path => !path.startsWith("/") || path.includes("$"))) throw new Error("Use absolute paths without dollar signs");
  return `[Unit]\nDescription=Woodshed PR maintenance\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${root.replaceAll("%", "%%")}\nExecStart=${quote(bun)} ${quote(join(root, "src/server.ts"))}\nEnvironment=${quote(`PATH=${join(home, ".local/bin")}:${join(home, ".bun/bin")}:${join(home, ".cache/flox/bin") }:/usr/local/bin:/usr/bin:/bin`)}\nEnvironment=WOODSHED_REMOTE=1\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=30\nKillMode=process\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

async function main(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Run headless setup as the dedicated non-root Woodshed user on a Linux VM");
  const root = resolve(import.meta.dir, ".."); const checkout = process.argv[2];
  if (!checkout?.startsWith("/") || !await Bun.file(join(checkout, "AGENTS.md")).exists()) throw new Error("Provide the absolute path to the repository checkout containing AGENTS.md");
  for (const tool of ["git", "gh", "codex", "hc", ...(await Bun.file(join(checkout, ".codex/with-flox")).exists() ? ["flox"] : [])]) await command([tool, "--version"]);
  await command(["gh", "auth", "status"]);
  await command(["codex", "login", "status"]);
  const login = userInfo().username;
  const linger = await command(["loginctl", "show-user", login, "--property=Linger", "--value"]);
  if (linger.trim() !== "yes") throw new Error(`Enable persistent user services first: sudo loginctl enable-linger ${login}`);
  const configPath = join(root, "woodshed.config.json");
  const existing = await Bun.file(configPath).exists() ? await Bun.file(configPath).json() : {};
  if (existing.mode === "auto" || existing.automation === true) throw new Error("Headless bootstrap starts in Watch. Finish the controller cutover before enabling Auto.");
  const config = { repository: "PostHog/posthog", author: "@me", pollSeconds: 90, maxAttempts: 3, maxConcurrentJobs: 1, runCapUSD: 5, dailyCapUSD: 20, workerProtocol: "app-server", port: 7341, reviewLabel: "posthog-review", approvalLabel: "stamphog", ...existing, checkout, mode: "watch", automation: false, paused: false };
  await Bun.write(`${configPath}.tmp`, JSON.stringify(config, null, 2) + "\n"); chmodSync(`${configPath}.tmp`, 0o600); renameSync(`${configPath}.tmp`, configPath);
  const directory = join(homedir(), ".config/systemd/user"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  await Bun.write(join(directory, "woodshed.service"), headlessUnit(root, process.execPath, homedir()));
  await command(["systemctl", "--user", "daemon-reload"]);
  await command(["systemctl", "--user", "enable", "--now", "woodshed.service"]);
  console.log("Woodshed headless service installed in Watch mode. Complete GitHub, Codex, signing, the worker token (bun scripts/setup-worker-token.ts), and the Mac connection before enabling Auto.");
}
if (import.meta.main) await main();
