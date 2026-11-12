import type { Decision } from "./model";

export type Recovery = { head: string; attempts: number; kind: "prepare" | "resume" | "probe"; retryAt?: string; reason: string; freshCheckout?: boolean; instructions?: string };

export const MAX_RECOVERY_RETRIES = 3;

// Name the last failure so the owner can act on it instead of retrying blind.
export function recoveryExhausted(recovery: Recovery): Decision {
  return { kind: "human", title: "Retry recovery", reason: `Woodshed could not restore this run after ${MAX_RECOVERY_RETRIES} retries. Existing files are preserved. Retry recovery to try once more. Last failure: ${recovery.reason.slice(0, 500)}` };
}

export function missingSession(error: unknown): boolean {
  return /hc exited 3:/.test(String(error)) && /"kind"\s*:\s*"not_found"|no terminal/.test(String(error));
}

export function temporaryFailure(error: unknown): boolean {
  return /not our ref|promisor remote|could not fetch|could not resolve|connection (?:reset|refused|closed)|network|timed? out|unavailable|cannot start core|broken pipe|stream disconnected|Codex process exited|HTTP 50[234]/i.test(String(error));
}

export function recoveryDelay(attempt: number): number {
  return [30_000, 120_000, 600_000][Math.min(Math.max(attempt - 1, 0), 2)];
}
