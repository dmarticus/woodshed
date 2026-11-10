export class PowerGuard {
  private assertion?: ReturnType<typeof Bun.spawn>;
  private lastTick = Date.now();
  update(active: boolean): boolean {
    const now = Date.now(); const resumed = now - this.lastTick > 30000; this.lastTick = now;
    if (process.platform !== "darwin") return resumed;
    if (active && (!this.assertion || this.assertion.exitCode !== null)) this.assertion = Bun.spawn(["/usr/bin/caffeinate", "-i", "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
    if (!active) this.close();
    return resumed;
  }
  close(): void { this.assertion?.kill(); this.assertion = undefined; }
}
