import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "../src/git-environment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("service Git uses HTTPS and signs without an agent while leaving repository settings unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "woodshed-signing-")); roots.push(root);
  const base = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", SSH_AUTH_SOCK: join(root, "no-agent") };
  const exec = (argv: string[], env = base) => {
    const result = Bun.spawnSync(argv, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${argv[0]}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const key = join(root, "service-key");
  exec(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
  exec(["git", "init", "-q"]);
  exec(["git", "config", "user.name", "Woodshed fixture"]);
  exec(["git", "config", "user.email", "woodshed@example.com"]);
  exec(["git", "config", "commit.gpgSign", "false"]);
  exec(["git", "remote", "add", "origin", "git@github.com:example/project.git"]);
  const env = gitEnvironment(key, base);
  expect(exec(["git", "remote", "get-url", "origin"], env as typeof base)).toBe("https://github.com/example/project.git");
  exec(["git", "commit", "--allow-empty", "-m", "chore: verify unattended signing"], env as typeof base);
  const publicKey = Bun.spawnSync(["ssh-keygen", "-y", "-f", key]).stdout.toString().trim();
  const allowed = join(root, "allowed-signers"); writeFileSync(allowed, `woodshed@example.com ${publicKey}\n`);
  exec(["git", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", "HEAD"], env as typeof base);
  expect(exec(["git", "remote", "get-url", "origin"])).toBe("git@github.com:example/project.git");
  expect(exec(["git", "config", "--local", "commit.gpgSign"])).toBe("false");
});

test("inherited command configuration survives service overrides", () => {
  const base = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Existing identity" };
  const env = gitEnvironment(undefined, base);
  const result = Bun.spawnSync(["git", "config", "user.name"], { env: { ...process.env, ...env } });
  expect(result.stdout.toString().trim()).toBe("Existing identity");
  expect(base.GIT_CONFIG_COUNT).toBe("1");
});
