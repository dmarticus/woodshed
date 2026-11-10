import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import type { Config } from "./model";

export const MIN_RUN_BUDGET = 0.10;
export const ADMISSION_INTERVAL_MS = 5_000;
export const dollarsDown = (value: number): number => Math.max(0, Math.floor((value + 1e-9) * 100) / 100);
export type CapacityPolicy = Pick<Config, "concurrencyMode" | "cpuTargetPercent" | "memoryTargetPercent"> & { active: number };
export type WorkerCapacity = { limit: number; blocked?: "memory" | "cpu"; availableMB?: number; load?: number; cpuPercent?: number; memoryPercent?: number };
export function capacityFor(configured: number, host: { cpus: number; totalGB: number; availableGB: number; load: number; cpuPercent?: number }, policy?: CapacityPolicy): WorkerCapacity {
  const cpuPercent = host.cpuPercent ?? Math.min(100, host.load / host.cpus * 100);
  const memoryPercent = (1 - host.availableGB / host.totalGB) * 100;
  const reserve = host.totalGB * (1 - (policy?.memoryTargetPercent ?? 80) / 100);
  // Launch headroom, not a per-agent allocation. Admit one at a time and resample
  // after startup; idle network-bound agents can outnumber CPUs.
  const room = Math.max(0, Math.floor((host.availableGB - reserve) / 0.5));
  const availableLimit = (policy?.active ?? 0) + room;
  const limit = policy?.concurrencyMode === "adaptive" ? availableLimit : Math.min(configured, availableLimit);
  const blocked = room === 0 ? "memory" : cpuPercent >= (policy?.cpuTargetPercent ?? 80) ? "cpu" : undefined;
  return { limit, blocked, availableMB: Math.floor(host.availableGB * 1024), load: host.load, cpuPercent, memoryPercent };
}
let previousCPU: { total: number; idle: number; time: number } | undefined;
let measuredCPU: number | undefined;
function cpuUsage(): number | undefined {
  const time = Date.now();
  if (previousCPU && time - previousCPU.time < 1000) return measuredCPU;
  const times = cpus().map(cpu => cpu.times);
  const total = times.reduce((sum, t) => sum + t.user + t.nice + t.sys + t.idle + t.irq, 0);
  const idle = times.reduce((sum, t) => sum + t.idle, 0);
  if (previousCPU && total > previousCPU.total) measuredCPU = 100 * (1 - (idle - previousCPU.idle) / (total - previousCPU.total));
  previousCPU = { total, idle, time };
  return measuredCPU;
}
export function workerCapacity(configured: number, policy?: CapacityPolicy): WorkerCapacity {
  if (process.env.WOODSHED_REMOTE !== "1" && policy?.concurrencyMode !== "adaptive") return { limit: configured };
  let available = freemem();
  if (process.platform === "linux") {
    try { const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m); if (match) available = Number(match[1]) * 1024; } catch {}
  }
  return capacityFor(configured, { cpus: availableParallelism(), totalGB: totalmem() / 2 ** 30, availableGB: available / 2 ** 30, load: loadavg()[0], cpuPercent: cpuUsage() }, policy);
}
