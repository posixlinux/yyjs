import type { Dataset } from "./domain/schema.js";
import { seoulToday } from "./domain/time.js";
import { validateAsOf, validateStatic } from "./domain/validate.js";
import { AppError, dataError } from "./errors.js";
import { analyze } from "./model/model.js";
import type { LocalStore } from "./providers/local.js";

export type Mode = "demo";

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
    private stores: { demo: LocalStore },
    private opts: { demoEnabled: boolean; now: () => Date },
  ) {}

  private store(mode: Mode): LocalStore {
    if (!this.opts.demoEnabled)
      throw new AppError(400, "DEMO_MODE_DISABLED", "Demo mode is disabled on this server", undefined, "Use mode=public, or set DEMO_MODE_ENABLED=true.");
    return this.stores[mode];
  }

  private notFound(ticker: string, mode: Mode): AppError {
    return new AppError(
      404,
      "COMPANY_NOT_FOUND",
      `No ${mode} dataset registered for ticker ${ticker}`,
      { ticker, mode },
      "Demo fixtures exist only for a few fictional profiles; see GET /v1/companies. Real companies are analysed with mode=public.",
    );
  }

  async listCompanies(query: string | undefined) {
    if (!this.opts.demoEnabled) return [];
    const q = query?.trim().toLowerCase();
    const out = (await this.store("demo").list()).map((d) => summary(d, "demo"));
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

  /** Synchronous analysis of a bundled demo fixture. */
  async analyze(req: { ticker: string; asOf?: string; mode: Mode }) {
    const asOf = this.resolveAsOf(req.asOf);
    const ds = await this.store(req.mode).get(req.ticker);
    if (!ds) throw this.notFound(req.ticker, req.mode);
    const issues = [...validateStatic(ds), ...validateAsOf(ds, asOf)];
    if (issues.length) throw dataError(issues, `Dataset for ${req.ticker} cannot be used for asOf ${asOf}`);
    return { mode: req.mode, ...analyze(ds, asOf) };
  }
}
