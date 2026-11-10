import { createInterface } from "node:readline";
import { Readable } from "node:stream";

export type RPCMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };

export class CodexRPC {
  process: ReturnType<typeof Bun.spawn>;
  nextId = 1;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onMessage: (message: RPCMessage) => void = () => {};
  onExit: (code: number) => void = () => {};
  constructor(cwd?: string) {
    this.process = Bun.spawn([process.env.WOODSHED_CODEX ?? "codex", "app-server", "--listen", "stdio://"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines = createInterface({ input: Readable.fromWeb(this.process.stdout as any) });
    lines.on("line", line => {
      let message: RPCMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id === "number" && !message.method && this.pending.has(message.id)) {
        const item = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
      } else this.onMessage(message);
    });
    void new Response(this.process.stderr as any).text();
    void this.process.exited.then(code => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Codex app-server exited ${code}`)); }
      this.pending.clear(); this.onExit(code);
    });
  }
  write(message: RPCMessage): void { (this.process.stdin as any).write(JSON.stringify(message) + "\n"); }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "woodshed", title: "Woodshed", version: "0.2.0" } });
    this.write({ method: "initialized", params: {} });
  }
  close(): void { this.process.kill(); }
}
