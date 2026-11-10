export type Recovery = { head: string; attempts: number; kind: "prepare" | "resume" | "probe"; retryAt?: string; reason: string; freshCheckout?: boolean; instructions?: string };

export function missingSession(error: unknown): boolean {
  return /hc exited 3:/.test(String(error)) && /"kind"\s*:\s*"not_found"|no terminal/.test(String(error));
}

export function temporaryFailure(error: unknown): boolean {
  return /not our ref|promisor remote|could not fetch|could not resolve|connection (?:reset|refused|closed)|network|timed? out|unavailable|cannot start core|broken pipe|stream disconnected|Codex process exited|HTTP 50[234]/i.test(String(error));
}

export function recoveryDelay(attempt: number): number {
  return [30_000, 120_000, 600_000][Math.min(Math.max(attempt - 1, 0), 2)];
}
