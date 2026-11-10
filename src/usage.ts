import type { ModelPrice, Run, Usage } from "./model";

export const localDay = (date = new Date()): string => new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
export const emptyUsage = (): Usage => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

export const publishedPrices: { [model: string]: ModelPrice } = {
  "gpt-6.1-sol": { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10, source: "https://developers.openai.com/api/docs/models/gpt-6.1-sol" },
  "gpt-6.1-terra": { input: 1, cached: 0.05, cacheWrite: 1.25, output: 5, source: "https://developers.openai.com/api/docs/models/gpt-6.1-terra" },
  "gpt-6-astra": { input: 10, cached: 1, cacheWrite: 12.5, output: 50, source: "https://developers.openai.com/api/docs/models/gpt-6-astra" },
  "gpt-6-luna": { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5, source: "https://developers.openai.com/api/docs/models/gpt-6-luna" },
};

export function estimate(usage: Usage, price: ModelPrice, longContext = false): number {
  const cached = Math.max(0, usage.cachedInputTokens);
  const writes = Math.max(0, usage.cacheWriteInputTokens ?? 0);
  const input = Math.max(0, usage.inputTokens - cached - writes);
  return ((input * price.input + cached * price.cached + writes * price.cacheWrite) * (longContext ? 2 : 1) + Math.max(0, usage.outputTokens) * price.output * (longContext ? 1.5 : 1)) / 1_000_000;
}

export function addUsage(run: Run, total: Usage, last: Usage, price: ModelPrice | undefined, date = new Date()): void {
  const prior = run.usage ?? emptyUsage();
  const delta = Object.fromEntries(Object.keys(prior).map(key => [key, Math.max(0, (total[key as keyof Usage] ?? 0) - (prior[key as keyof Usage] ?? 0))])) as Usage;
  if (delta.totalTokens === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) return;
  run.usage = total;
  if (!price) { run.costUSD = null; return; }
  const cost = estimate(delta, price, last.inputTokens > 272_000);
  run.costUSD = (run.costUSD ?? 0) + cost;
  const day = localDay(date);
  run.costsByDay[day] = (run.costsByDay[day] ?? 0) + cost;
}
