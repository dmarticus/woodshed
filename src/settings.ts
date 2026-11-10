import { renameSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { modeOf, type Config, type Mode } from "./model";

export class Settings {
  updating = false;
  constructor(readonly config: Config, readonly path: string, readonly demo = false) {}
  public() {
    const mode = modeOf(this.config);
    return { repository: this.config.repository, author: this.config.author, mode, automation: mode === "auto", paused: mode === "paused",
      concurrencyMode: this.config.concurrencyMode ?? "fixed", cpuTargetPercent: this.config.cpuTargetPercent ?? 80, memoryTargetPercent: this.config.memoryTargetPercent ?? 80,
      pollSeconds: this.config.pollSeconds, maxAttempts: this.config.maxAttempts, maxConcurrentJobs: this.config.maxConcurrentJobs,
      defaultModel: this.config.defaultModel ?? "", retryModel: this.config.retryModel ?? "", escalateOnRetry: this.config.escalateOnRetry ?? false,
      runCapUSD: this.config.runCapUSD ?? 5, dailyCapUSD: this.config.dailyCapUSD ?? 20, modelPrices: this.config.modelPrices ?? {},
      watchFilter: this.config.watchFilter ?? "mine", watchQuery: this.config.watchQuery ?? "" };
  }
  async update(patch: unknown): Promise<void> {
    if (this.updating) throw new Error("Settings are being updated. Try again in a moment.");
    this.updating = true;
    try {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Expected settings");
      const allowed = new Set(["concurrencyMode", "cpuTargetPercent", "memoryTargetPercent", "mode", "automation", "paused", "pollSeconds", "maxAttempts", "maxConcurrentJobs", "defaultModel", "retryModel", "escalateOnRetry", "runCapUSD", "dailyCapUSD", "modelPrices", "watchFilter", "watchQuery"]);
      for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`Unsupported setting: ${key}`);
      const input = patch as { [key: string]: any };
      for (const key of ["automation", "paused", "escalateOnRetry"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean`);
      const next = { ...this.public(), ...input };
      let mode: Mode = next.mode;
      if (!input.mode && ("automation" in input || "paused" in input)) mode = next.paused ? "paused" : next.automation ? "auto" : "watch";
      if (!["watch", "auto", "paused"].includes(mode)) throw new Error("Choose Watch, Auto, or Paused");
      next.mode = mode; next.automation = mode === "auto"; next.paused = mode === "paused";
      for (const [key, min, max] of [["pollSeconds", 30, 3600], ["maxAttempts", 1, 10], ["maxConcurrentJobs", 1, 128], ["cpuTargetPercent", 20, 95], ["memoryTargetPercent", 50, 90]] as const)
        if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
      if (!["adaptive", "fixed"].includes(next.concurrencyMode)) throw new Error("Choose automatic or fixed concurrency");
      for (const key of ["runCapUSD", "dailyCapUSD"] as const) if (typeof next[key] !== "number" || !Number.isFinite(next[key]) || next[key] < 0 || next[key] > 10000) throw new Error(`${key} must be between $0 and $10,000`);
      for (const key of ["defaultModel", "retryModel"] as const) if (typeof next[key] !== "string" || !/^[a-zA-Z0-9._/-]{0,120}$/.test(next[key])) throw new Error("Invalid model identifier");
      if (!["mine", "mine-and-reviews", "query"].includes(next.watchFilter) || typeof next.watchQuery !== "string" || next.watchQuery.length > 1000) throw new Error("Invalid PR watch filter");
      if (next.watchFilter === "query" && !next.watchQuery.trim()) throw new Error("Enter a GitHub PR search query");
      if (!next.modelPrices || typeof next.modelPrices !== "object" || Array.isArray(next.modelPrices)) throw new Error("Invalid token rates");
      for (const [id, price] of Object.entries(next.modelPrices) as [string, any][]) {
        if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(id) || !price || typeof price !== "object") throw new Error("Invalid model rate");
        for (const key of ["input", "cached", "cacheWrite", "output"]) if (typeof price[key] !== "number" || !Number.isFinite(price[key]) || price[key] < 0 || price[key] > 100000) throw new Error("Token rates must be nonnegative numbers per million tokens");
      }
      if (this.demo && mode === "auto") throw new Error("Auto is disabled in previews");
      if (mode === "auto" && (!isAbsolute(this.config.checkout) || !await Bun.file(resolve(this.config.checkout, "AGENTS.md")).exists())) throw new Error("Configure a valid repository checkout before enabling Auto");
      if (!this.demo) {
        const existing = await Bun.file(this.path).exists() ? await Bun.file(this.path).json() : this.config;
        const contents = { ...existing, ...next };
        await Bun.write(`${this.path}.tmp`, JSON.stringify(contents, null, 2) + "\n");
        renameSync(`${this.path}.tmp`, this.path);
      }
      Object.assign(this.config, next);
    } finally { this.updating = false; }
  }
}
