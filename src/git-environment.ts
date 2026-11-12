// Workers get only the token in their own environment, never the controller's gh login.
const workerCredentialHelper = `!f() { test "$1" = get || exit 0; test -n "$GH_TOKEN" || exit 1; printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; }; f`;

export function gitEnvironment(signingKey?: string, base: NodeJS.ProcessEnv = process.env, credentials: "controller" | "worker" = "controller", extra: [string, string][] = []): NodeJS.ProcessEnv {
  const env = { ...base };
  const entries: [string, string][] = [
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ...(credentials === "worker" ? [["credential.helper", ""] as [string, string]] : []),
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", credentials === "worker" ? workerCredentialHelper : "!gh auth git-credential"],
    ["credential.interactive", "false"],
    ...extra,
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

export function gitShellSettings(signingKey?: string, credentials: "controller" | "worker" = "controller"): { [key: string]: string } {
  const env = gitEnvironment(signingKey, {}, credentials);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
