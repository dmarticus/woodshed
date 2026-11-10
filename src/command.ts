import { gitEnvironment } from "./git-environment";

export async function command(argv: string[], options: { cwd?: string; timeout?: number; input?: string | Uint8Array; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const environment = { ...process.env, ...options.env };
  const proc = Bun.spawn(argv, { cwd: options.cwd, env: argv[0] === "git" ? gitEnvironment(process.env.WOODSHED_SIGNING_KEY, environment) : environment, stdout: "pipe", stderr: "pipe", stdin: options.input === undefined ? "ignore" : "pipe" });
  if (options.input !== undefined) { (proc.stdin as Bun.FileSink).write(options.input); (proc.stdin as Bun.FileSink).end(); }
  const timer = setTimeout(() => proc.kill(), options.timeout ?? 60_000);
  try {
    const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${error.slice(0, 1600)}`);
    return out;
  } finally { clearTimeout(timer); }
}
