import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { readFileSync } from "node:fs";

export const MIN_RUN_BUDGET = 0.10;
export const dollarsDown = (value: number): number => Math.max(0, Math.floor((value + 1e-9) * 100) / 100);
export type WorkerCapacity = { limit: number; blocked?: "memory" | "cpu"; availableMB?: number; load?: number };
export function capacityFor(configured: number, host: { cpus: number; totalGB: number; availableGB: number; load: number }): WorkerCapacity {
  // Leave room for the controller/OS and allow 2 GB per independent worktree.
  const memoryLimit = Math.max(1, Math.floor((host.totalGB - 1.5) / 2));
  const limit = Math.max(1, Math.min(configured, host.cpus, memoryLimit));
  const blocked = host.availableGB < 2 ? "memory" : host.load > host.cpus * 1.2 ? "cpu" : undefined;
  return { limit, blocked, availableMB: Math.floor(host.availableGB * 1024), load: host.load };
}
export function workerCapacity(configured: number): WorkerCapacity {
  if (process.platform !== "linux" || process.env.WOODSHED_REMOTE !== "1") return { limit: configured };
  let available = freemem();
  try { const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m); if (match) available = Number(match[1]) * 1024; } catch {}
  return capacityFor(configured, { cpus: availableParallelism(), totalGB: totalmem() / 2 ** 30, availableGB: available / 2 ** 30, load: loadavg()[0] });
}
