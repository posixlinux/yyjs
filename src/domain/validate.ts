import type { Dataset, Market, Product, Source } from "./schema.js";
import { daysBetween, parseQuarter, quarterEnd, quarterOfDate } from "./time.js";
import type { Issue } from "../errors.js";
import { adjustEstimatedMarkets, playerSum } from "./market-structure.js";

// Evidence-quality limits (documented in README).
export const MAX_QUARTERS_BEFORE_ASOF = 3; // latest market/financial/share observation may be at most 3 quarters before asOf's quarter
export const MAX_QUOTE_AGE_DAYS = 14;
export const MAX_FX_AGE_DAYS = 30;
export const MAX_SHARES_AGE_DAYS = 200;
export const MAX_SOURCE_AGE_DAYS = 730;
export const MIN_COVERAGE = 0.5;
// Only floating-point/rounding noise may be left uncovered without an explicit residual segment (0.01% of revenue).
export const ROUNDING_TOLERANCE = 1e-4;
const MAX_QUARTER_JUMP = 3; // consecutive quarterly observations differing by >3x smell like annual/quarterly mixing

// ---------- derived facts shared by validation and the model ----------

export const fxRate = (ds: Dataset, ccy: string): number | undefined =>
  ccy === "KRW" ? 1 : ds.fx.find((f) => f.currency === ccy)?.krwPerUnit;

export const marketOf = (ds: Dataset, p: Product): Market | undefined => ds.markets.find((m) => m.id === p.marketId);

/** Revenue share at the latest quarter present in both the product's and the market's series. */
export function shareAnchor(ds: Dataset, p: Product) {
  const m = marketOf(ds, p);
  if (!m) return undefined;
  const byQ = new Map(m.observations.map((o) => [o.quarter, o.revenue]));
  const common = p.revenue.filter((r) => byQ.has(r.quarter)).sort((a, b) => parseQuarter(b.quarter) - parseQuarter(a.quarter))[0];
  if (!common) return undefined;
  const marketRevenue = byQ.get(common.quarter)!;
  return { quarter: common.quarter, productRevenue: common.revenue, marketRevenue, share: common.revenue / marketRevenue };
}

/**
 * The quarter the model projects: the first quarter whose company results are not yet reported (the one after
 * financials.quarter), kept within the quarter that just ended and the quarter in progress at asOf. A quarter that
 * just ended is usually still unreported for several weeks, so it is the target rather than being skipped. The target
 * is also always after every market's latest observation, so it is a projection, never an observed quarter.
 */
export function targetQuarterIndex(ds: Dataset, asOf: string): number {
  const current = quarterOfDate(asOf);
  const afterReported = parseQuarter(ds.financials.quarter) + 1;
  const afterObserved = Math.max(...ds.markets.map((m) => parseQuarter(m.observations.at(-1)!.quarter) + 1));
  return Math.min(current, Math.max(current - 1, afterReported, afterObserved));
}

/** Share of company revenue (financials quarter) explained by the registered products, in KRW. */
export function coverage(ds: Dataset) {
  let coveredKRW = 0;
  let missing = false;
  for (const p of ds.products) {
    const r = p.revenue.find((x) => x.quarter === ds.financials.quarter);
    const fx = r && fxRate(ds, r.currency);
    if (!r || fx === undefined) missing = true;
    else coveredKRW += r.revenue * fx;
  }
  const total = ds.financials.totalRevenueKRW;
  return { quarter: ds.financials.quarter, totalKRW: total, coveredKRW, residualKRW: Math.max(0, total - coveredKRW), ratio: coveredKRW / total, missing };
}

export function* walkSources(o: unknown, path = ""): Generator<{ path: string; source: Source }> {
  if (Array.isArray(o)) {
    for (const [i, v] of o.entries()) yield* walkSources(v, `${path}[${i}]`);
  } else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (k === "source") yield { path: p, source: v as Source };
      else if (k === "sources") for (const [i, s] of (v as Source[]).entries()) yield { path: `${p}[${i}]`, source: s };
      else yield* walkSources(v, p);
    }
  }
}

// ---------- static validation (independent of analysis date) ----------

export function validateStatic(input: Dataset): Issue[] {
  // Estimated market totals below the identified players are lifted (and reported by the model) before any check runs.
  const ds = adjustEstimatedMarkets(input).dataset;
  const issues: Issue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });

  const checkSeries = (path: string, series: { quarter: string; revenue: number; basis: string; source: Source }[]) => {
    series.forEach((o, i) => {
      const p = `${path}[${i}]`;
      if (o.basis !== "quarterly")
        add("ANNUAL_QUARTERLY_CONFUSION", `${p}.basis`, `basis "${o.basis}" rejected: only quarterly revenue is accepted (divide annual figures into quarters yourself and cite it)`);
      if (o.source.publishedAt < quarterEnd(parseQuarter(o.quarter)))
        add("SOURCE_BEFORE_PERIOD_END", `${p}.source.publishedAt`, `source published ${o.source.publishedAt} before ${o.quarter} ended`);
      const prev = series[i - 1];
      if (!prev) return;
      if (parseQuarter(o.quarter) - parseQuarter(prev.quarter) !== 1)
        add("NON_CONSECUTIVE_OBSERVATIONS", `${p}.quarter`, `${o.quarter} does not directly follow ${prev.quarter}; list consecutive ascending quarters without gaps or duplicates`);
      const ratio = o.revenue / prev.revenue;
      if (ratio > MAX_QUARTER_JUMP || ratio < 1 / MAX_QUARTER_JUMP)
        add("ANNUAL_QUARTERLY_CONFUSION", `${p}.revenue`, `${o.quarter} is ${ratio.toFixed(2)}x ${prev.quarter}; suspected annual/quarterly (or unit) mix-up`);
    });
  };

  // Source publication must not predate the period/date it reports.
  const notBefore = (path: string, s: Source, date: string, what: string) => {
    if (s.publishedAt < date) add("SOURCE_BEFORE_PERIOD_END", `${path}.publishedAt`, `${what} source published ${s.publishedAt} predates the ${date} it reports`);
  };
  notBefore("financials.source", ds.financials.source, quarterEnd(parseQuarter(ds.financials.quarter)), `financials ${ds.financials.quarter}`);
  notBefore("quote.source", ds.quote.source, ds.quote.asOf, "quote");
  notBefore("shares.source", ds.shares.source, ds.shares.asOf, "share count");
  ds.fx.forEach((f, i) => notBefore(`fx[${i}].source`, f.source, f.asOf, `fx ${f.currency}`));

  // Textual duplicate detection only (case/punctuation/whitespace-insensitive); it cannot detect semantic overlap.
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const ids = new Set<string>();
  const marketNames = new Set<string>();
  const marketScopes = new Set<string>();
  const referenced = new Set(ds.products.map((p) => p.marketId));
  ds.markets.forEach((m, i) => {
    const p = `markets[${i}]`;
    if (ids.has(m.id) || marketNames.has(norm(m.name)) || marketScopes.has(norm(m.scope)))
      add("DUPLICATE_MARKET", p, `market ${m.id} duplicates another market's id, name or scope (textual match)`);
    ids.add(m.id);
    marketNames.add(norm(m.name));
    marketScopes.add(norm(m.scope));
    if (!referenced.has(m.id)) add("UNUSED_MARKET", p, `market ${m.id} is not used by any product; remove it or add the product that sells into it`);
    checkSeries(`${p}.observations`, m.observations);
    if (fxRate(ds, m.currency) === undefined) add("MISSING_FX", `${p}.currency`, `no fx entry for ${m.currency}`);
    const s = m.seasonality.value;
    const mean = (s.q1 + s.q2 + s.q3 + s.q4) / 4;
    if (Math.abs(mean - 1) > 0.02) add("SEASONALITY_NOT_NORMALISED", `${p}.seasonality`, `seasonality indices must average 1 (±0.02), got ${mean.toFixed(3)}`);
  });

  const fxSeen = new Set<string>();
  ds.fx.forEach((f, i) => {
    if (f.currency === "KRW") add("INVALID_FX", `fx[${i}]`, "KRW is implicit (rate 1); remove this entry");
    if (fxSeen.has(f.currency)) add("DUPLICATE_FX", `fx[${i}]`, `duplicate fx for ${f.currency}`);
    fxSeen.add(f.currency);
  });

  const productIds = new Set<string>();
  const productNames = new Set<string>();
  const usedMarkets = new Map<string, string>();
  ds.products.forEach((p, i) => {
    const path = `products[${i}]`;
    if (productIds.has(p.id) || productNames.has(norm(p.name))) add("DUPLICATE_PRODUCT", path, `duplicate product ${p.id}/${p.name} (textual match)`);
    productIds.add(p.id);
    productNames.add(norm(p.name));
    const other = usedMarkets.get(p.marketId);
    if (other) add("OVERLAPPING_PRODUCT_MARKET", `${path}.marketId`, `products ${other} and ${p.id} map to the same market ${p.marketId}; their revenue would be double counted`);
    usedMarkets.set(p.marketId, p.id);

    const m = marketOf(ds, p);
    if (!m) return add("MISSING_MARKET", `${path}.marketId`, `unknown market ${p.marketId}`);
    checkSeries(`${path}.revenue`, p.revenue);
    p.revenue.forEach((r, j) => {
      if (r.currency !== m.currency)
        add("CURRENCY_MISMATCH", `${path}.revenue[${j}].currency`, `product revenue in ${r.currency} vs market in ${m.currency}; revenue share needs the same currency`);
      if (fxRate(ds, r.currency) === undefined) add("MISSING_FX", `${path}.revenue[${j}].currency`, `no fx entry for ${r.currency}`);
    });
    const a = shareAnchor(ds, p);
    if (!a) return add("MISSING_COVERAGE", `${path}.revenue`, "no quarter present in both product revenue and market observations");
    // Every overlapping historical quarter must be consistent, not just the latest one.
    const marketByQ = new Map(m.observations.map((o) => [o.quarter, o.revenue]));
    let shareBroken = false;
    for (const r of p.revenue) {
      const mr = marketByQ.get(r.quarter);
      if (mr !== undefined && r.revenue > mr) {
        shareBroken = true;
        add("INVALID_SHARE", `${path}.revenue`, `revenue share ${(r.revenue / mr).toFixed(3)} > 1 in ${r.quarter}: product revenue exceeds the market (volume vs revenue, scope or period mismatch?)`);
      }
    }
    if (!shareBroken && (a.share < p.shareBounds.min || a.share > p.shareBounds.max))
      add("SHARE_OUT_OF_BOUNDS", `${path}.shareBounds`, `observed share ${a.share.toFixed(4)} outside bounds [${p.shareBounds.min}, ${p.shareBounds.max}]`);
  });

  // Competitors: same series rules as products, and the named players can never exceed a REPORTED market total.
  const competitorIds = new Set<string>();
  (ds.competitors ?? []).forEach((c, i) => {
    const path = `competitors[${i}]`;
    if (competitorIds.has(c.id)) add("DUPLICATE_COMPETITOR", path, `duplicate competitor id ${c.id}`);
    competitorIds.add(c.id);
    const m = ds.markets.find((x) => x.id === c.marketId);
    if (!m) return add("COMPETITOR_MARKET_UNKNOWN", `${path}.marketId`, `unknown market ${c.marketId}`);
    checkSeries(`${path}.revenue`, c.revenue);
    c.revenue.forEach((r, j) => {
      if (r.currency !== m.currency) add("CURRENCY_MISMATCH", `${path}.revenue[${j}].currency`, `competitor revenue in ${r.currency} vs market in ${m.currency}`);
    });
  });
  for (const [i, m] of ds.markets.entries())
    for (const [j, o] of m.observations.entries()) {
      if (o.estimate) continue; // estimated totals were already lifted to the player sum
      const sum = playerSum(ds, m.id, m.currency, o.quarter).total;
      if (sum > o.revenue * (1 + ROUNDING_TOLERANCE))
        add("PLAYERS_EXCEED_MARKET", `markets[${i}].observations[${j}].revenue`, `company + named competitors (${sum}) exceed the reported market total (${o.revenue}) in ${o.quarter}: wrong scope, period or unit`);
    }

  const missing = ds.products.filter((p) => !p.revenue.some((r) => r.quarter === ds.financials.quarter));
  for (const p of missing) add("MISSING_COVERAGE", `products.${p.id}.revenue`, `no product revenue for financials quarter ${ds.financials.quarter}`);
  if (!missing.length && !issues.some((x) => x.code === "MISSING_FX" || x.code === "CURRENCY_MISMATCH")) {
    const c = coverage(ds);
    if (c.coveredKRW > c.totalKRW * (1 + ROUNDING_TOLERANCE))
      add("COVERAGE_EXCEEDS_TOTAL", "financials.totalRevenueKRW", `product revenue ${Math.round(c.coveredKRW)} KRW exceeds company revenue ${c.totalKRW} KRW (overlap or wrong period/unit)`);
    else if (c.ratio < MIN_COVERAGE)
      add("COVERAGE_INSUFFICIENT", "products", `products explain only ${(c.ratio * 100).toFixed(1)}% of company revenue (< ${MIN_COVERAGE * 100}%); add products before valuing the company`);
    else if (c.residualKRW > c.totalKRW * ROUNDING_TOLERANCE && !ds.residual)
      add("RESIDUAL_REQUIRED", "residual", `products explain ${(c.ratio * 100).toFixed(2)}% of revenue; provide explicit residual growth/margin assumptions for the remaining ${(100 - c.ratio * 100).toFixed(2)}%`);
  }
  return issues;
}

// ---------- analysis-date validation ----------

export function validateAsOf(input: Dataset, asOf: string): Issue[] {
  const ds = adjustEstimatedMarkets(input).dataset;
  const issues: Issue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const current = quarterOfDate(asOf);

  for (const { path, source } of walkSources(ds)) {
    if (source.publishedAt > asOf) add("FUTURE_EVIDENCE", `${path}.publishedAt`, `source "${source.title}" published ${source.publishedAt} is after asOf ${asOf}`);
    else if (daysBetween(source.publishedAt, asOf) > MAX_SOURCE_AGE_DAYS) add("STALE_EVIDENCE", `${path}.publishedAt`, `source "${source.title}" is older than ${MAX_SOURCE_AGE_DAYS} days`);
  }

  const dated = (path: string, d: string, maxAge: number, what: string) => {
    if (d > asOf) add("FUTURE_EVIDENCE", path, `${what} dated ${d} is after asOf ${asOf}`);
    else if (daysBetween(d, asOf) > maxAge) add("STALE_EVIDENCE", path, `${what} dated ${d} is older than ${maxAge} days`);
  };
  dated("quote.asOf", ds.quote.asOf, MAX_QUOTE_AGE_DAYS, "quote");
  dated("shares.asOf", ds.shares.asOf, MAX_SHARES_AGE_DAYS, "share count");
  ds.fx.forEach((f, i) => dated(`fx[${i}].asOf`, f.asOf, MAX_FX_AGE_DAYS, `fx ${f.currency}`));

  const period = (path: string, q: string, what: string) => {
    const idx = parseQuarter(q);
    if (quarterEnd(idx) > asOf) add("FUTURE_EVIDENCE", path, `${what} ${q} has not ended by asOf ${asOf}`);
    else if (current - idx > MAX_QUARTERS_BEFORE_ASOF) add("STALE_EVIDENCE", path, `${what} ${q} is more than ${MAX_QUARTERS_BEFORE_ASOF} quarters before asOf's quarter`);
  };
  period("financials.quarter", ds.financials.quarter, "financials");
  ds.markets.forEach((m, i) => {
    m.observations.forEach((o, j) => quarterEnd(parseQuarter(o.quarter)) > asOf && add("FUTURE_EVIDENCE", `markets[${i}].observations[${j}].quarter`, `${o.quarter} has not ended by asOf ${asOf}`));
    period(`markets[${i}].observations`, m.observations.at(-1)!.quarter, `latest ${m.id} observation`);
  });
  (ds.competitors ?? []).forEach((c, i) =>
    c.revenue.forEach((r, j) => quarterEnd(parseQuarter(r.quarter)) > asOf && add("FUTURE_EVIDENCE", `competitors[${i}].revenue[${j}].quarter`, `${r.quarter} has not ended by asOf ${asOf}`)),
  );
  ds.products.forEach((p, i) => {
    p.revenue.forEach((r, j) => quarterEnd(parseQuarter(r.quarter)) > asOf && add("FUTURE_EVIDENCE", `products[${i}].revenue[${j}].quarter`, `${r.quarter} has not ended by asOf ${asOf}`));
    const a = shareAnchor(ds, p);
    if (a) period(`products[${i}].revenue`, a.quarter, `share anchor of ${p.id}`);
  });
  return issues;
}
