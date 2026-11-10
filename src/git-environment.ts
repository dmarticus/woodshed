export function gitEnvironment(signingKey?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const entries: [string, string][] = [
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["credential.interactive", "false"],
  ];
  if (signingKey) entries.push(
    ["gpg.format", "ssh"], ["gpg.ssh.program", "/usr/bin/ssh-keygen"],
    ["user.signingKey", signingKey], ["commit.gpgSign", "true"], ["tag.gpgSign", "true"],
  );
  let count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error("Invalid inherited Git configuration");
  for (const [key, value] of entries) { env[`GIT_CONFIG_KEY_${count}`] = key; env[`GIT_CONFIG_VALUE_${count++}`] = value; }
  env.GIT_CONFIG_COUNT = String(count);
  env.GIT_TERMINAL_PROMPT = "0"; env.GCM_INTERACTIVE = "Never";
  return env;
}

export function gitShellSettings(signingKey?: string): { [key: string]: string } {
  const env = gitEnvironment(signingKey, {});
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
