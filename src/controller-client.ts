import { loadAPIToken } from "./api-auth";
import { controllerConnection } from "./connection";

export class ControllerClient {
  readonly base: URL;
  readonly token: () => string;
  constructor(url?: string, token?: () => string) {
    const connection = url ? undefined : controllerConnection();
    this.base = new URL(url ?? process.env.WOODSHED_URL ?? connection?.url ?? "http://127.0.0.1:7341");
    this.token = token ?? (() => loadAPIToken(process.env.WOODSHED_TOKEN_PATH ?? connection?.token_path));
    if (this.base.protocol !== "http:" || this.base.hostname !== "127.0.0.1" || this.base.username || this.base.password || this.base.pathname !== "/" || this.base.search || this.base.hash) throw new Error("Use a loopback Woodshed URL, optionally through an SSH tunnel");
  }
  async request(path: string, input?: unknown, signal?: AbortSignal, timeout = 10000): Promise<unknown> {
    if (!/^api\/agent\//.test(path)) throw new Error("Unsupported Woodshed agent endpoint");
    let response: Response;
    try {
      response = await fetch(new URL(path, this.base), { method: input === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${this.token()}`, ...(input === undefined ? {} : { "Content-Type": "application/json" }) }, body: input === undefined ? undefined : JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: "error" });
    } catch (error) {
      if (signal?.aborted) throw new Error("Woodshed request canceled");
      throw new Error("Cannot reach Woodshed. Start the controller, check its connection, and retry.");
    }
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Woodshed returned HTTP ${response.status}`);
    return result;
  }
}
