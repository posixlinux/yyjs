import { DatasetSchema, type Dataset } from "./domain/schema.js";
import { seoulToday } from "./domain/time.js";
import { validateAsOf, validateStatic } from "./domain/validate.js";
import { classifySecurity } from "./domain/security.js";
import { AppError, dataError } from "./errors.js";
import { analyze } from "./model/model.js";
import type { LocalStore } from "./providers/local.js";

export type Mode = "demo" | "manual";

const summary = (ds: Dataset, mode: Mode) => ({
  ticker: ds.company.ticker,
  name: ds.company.name,
  exchange: ds.company.exchange,
  sector: ds.company.sector,
  mode,
  synthetic: ds.synthetic === true,
});

export class Service {
  constructor(
    private stores: { manual: LocalStore; demo: LocalStore },
    private opts: { demoEnabled: boolean; now: () => Date },
  ) {}

  private store(mode: Mode): LocalStore {
    if (mode === "demo" && !this.opts.demoEnabled)
      throw new AppError(400, "DEMO_MODE_DISABLED", "Demo mode is disabled on this server", undefined, "Use mode=manual with an ingested dataset, or set DEMO_MODE_ENABLED=true.");
    return this.stores[mode];
  }

  private notFound(ticker: string, mode: Mode): AppError {
    return new AppError(
      404,
      "COMPANY_NOT_FOUND",
      `No ${mode} dataset registered for ticker ${ticker}`,
      { ticker, mode },
      mode === "manual"
        ? "Register one with POST /v1/datasets (schema: GET /v1/schema, sample: examples/dataset.example.json). Demo fixtures require mode=demo."
        : "Demo fixtures exist only for a few fictional profiles; see GET /v1/companies?mode=demo.",
    );
  }

  async listCompanies(query: string | undefined, mode?: Mode) {
    const modes: Mode[] = mode ? [mode] : this.opts.demoEnabled ? ["manual", "demo"] : ["manual"];
    const q = query?.trim().toLowerCase();
    const out = (await Promise.all(modes.map(async (m) => (await this.store(m).list()).map((d) => summary(d, m))))).flat();
    return out.filter((c) => !q || c.ticker.startsWith(q) || c.name.toLowerCase().includes(q));
  }

  async getCompany(ticker: string, mode: Mode) {
    const ds = await this.store(mode).get(ticker);
    if (!ds) throw this.notFound(ticker, mode);
    return {
      ...summary(ds, mode),
      description: ds.company.description,
      sources: ds.company.sources,
      products: ds.products.map((p) => ({ id: p.id, name: p.name, marketId: p.marketId })),
      markets: ds.markets.map((m) => ({ id: m.id, name: m.name, scope: m.scope, currency: m.currency, latestObservation: m.observations.at(-1)!.quarter })),
      financialsQuarter: ds.financials.quarter,
      quote: ds.quote,
    };
  }

  /** asOf defaults to today's Asia/Seoul date; a date after it is invalid (no future analysis dates). */
  resolveAsOf(asOf?: string): string {
    const today = seoulToday(this.opts.now());
    if (asOf && asOf > today) throw new AppError(400, "INVALID_AS_OF", `asOf ${asOf} is in the future (today in Asia/Seoul is ${today})`);
    return asOf ?? today;
  }

  /** Synchronous analysis of a stored dataset (demo fixtures or manually ingested). */
  async analyze(req: { ticker: string; asOf?: string; mode: Mode }) {
    const asOf = this.resolveAsOf(req.asOf);
    const ds = await this.store(req.mode).get(req.ticker);
    if (!ds) throw this.notFound(req.ticker, req.mode);
    const issues = [...validateStatic(ds), ...validateAsOf(ds, asOf)];
    if (issues.length) throw dataError(issues, `Dataset for ${req.ticker} cannot be used for asOf ${asOf}`);
    return { mode: req.mode, ...analyze(ds, asOf) };
  }

  /** Validates and atomically persists a real (non-synthetic) dataset; replaces an existing ticker. */
  async ingest(body: unknown) {
    const ds = DatasetSchema.parse(body);
    if (ds.synthetic) throw dataError([{ code: "SYNTHETIC_NOT_ALLOWED", path: "synthetic", message: "synthetic datasets cannot be ingested into the manual store" }]);
    const issues = [
      ...classifySecurity({ ticker: ds.company.ticker, names: [ds.company.name], checkTickerSuffix: false }).map((r) => ({ code: "NOT_COMMON_STOCK", path: "company", message: r.message })),
      ...validateStatic(ds),
      ...validateAsOf(ds, seoulToday(this.opts.now())).filter((i) => i.code === "FUTURE_EVIDENCE"),
    ];
    if (issues.length) throw dataError(issues);
    const created = await this.stores.manual.put(ds);
    return { created, ...summary(ds, "manual") };
  }
}
