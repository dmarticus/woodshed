import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../src/command";

export async function packageServer(root: string, output: string, info: { version: string; commit: string; build: number }): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(info.version) || !/^[a-f0-9]{40}$/.test(info.commit) || !Number.isSafeInteger(info.build) || info.build < 1) throw Error("Invalid release identity");
  const stage = mkdtempSync(join(tmpdir(), "woodshed-release-"));
  try {
    // Allowlist prevents local configuration, credentials, state and dependencies entering releases.
    for (const path of ["src", "scripts", "package.json", "bun.lock", "woodshed.config.example.json", "README.md"]) cpSync(join(root, path), join(stage, path), { recursive: true });
    await Bun.write(join(stage, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
    mkdirSync(resolve(output, ".."), { recursive: true });
    await command(["tar", "-czf", resolve(output), "-C", stage, "."]);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const [version, commit, build, output = "dist/Woodshed-server.tar.gz"] = process.argv.slice(2);
  await packageServer(resolve(import.meta.dir, ".."), output, { version: version!, commit: commit!, build: Number(build) });
}
