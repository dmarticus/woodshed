import { homedir } from "node:os";
import { join } from "node:path";
import { CodexRPC } from "./codex-rpc";
import type { Config, ModelOption } from "./model";
import { publishedPrices } from "./usage";

export class Models {
  cache: ModelOption[] = [];
  fetched = 0;
  loading?: Promise<ModelOption[]>;
  constructor(readonly config: Config) {}
  async list(): Promise<ModelOption[]> {
    if (this.cache.length && Date.now() - this.fetched < 3_600_000) return this.prices(this.cache);
    if (this.loading) return this.loading;
    this.loading = this.fetch().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  prices(models: ModelOption[]): ModelOption[] { return models.map(m => ({ ...m, price: this.config.modelPrices?.[m.id] ?? publishedPrices[m.id] })); }
  private async fetch(): Promise<ModelOption[]> {
    let rpc: CodexRPC | undefined;
    try {
      rpc = new CodexRPC();
      await rpc.initialize();
      let cursor: string | undefined;
      const rows: ModelOption[] = [];
      do {
        const page = await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const m of page.data) rows.push({ id: m.model, name: m.displayName, isDefault: m.isDefault });
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      this.cache = rows; this.fetched = Date.now();
      return this.prices(rows);
    } catch (error) {
      const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
      if (!await Bun.file(path).exists()) throw error;
      const source = await Bun.file(path).json();
      const rows = source.models.filter((m: any) => m.visibility === "list").sort((a: any, b: any) => a.priority - b.priority).map((m: any, index: number) => ({ id: m.slug, name: m.display_name, isDefault: index === 0 }));
      this.cache = rows; this.fetched = Date.now();
      return this.prices(rows);
    } finally { rpc?.close(); }
  }
  async choose(requested?: string, retry = false): Promise<ModelOption> {
    const rows = await this.list();
    const id = requested || (retry && this.config.escalateOnRetry ? this.config.retryModel : undefined) || this.config.defaultModel;
    const model = id ? rows.find(m => m.id === id) : rows.find(m => m.isDefault) ?? rows[0];
    if (!model) throw new Error("The selected model is not in the Codex catalog. Choose a model in Settings.");
    if (!model.price) throw new Error(`No spend estimate is configured for ${model.name}. Add its token rates in Spend settings before starting a capped run.`);
    return model;
  }
}
