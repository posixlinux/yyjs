import { DatasetSchema, SCENARIOS, type Dataset } from "./schema.js";
import { parseQuarter, quarterEnd } from "./time.js";
import { coverage, fxRate, ROUNDING_TOLERANCE, shareAnchor, validateAsOf, validateStatic } from "./validate.js";
import { adjustEstimatedMarkets } from "./market-structure.js";
import type { Issue } from "../errors.js";

// Relaxed gate for model-proposed (public) datasets: repair what can be repaired deterministically, then split the
// remaining validation issues into HARD ones (the price would be wrong by construction or would use data from after
// asOf) and SOFT ones (quality concerns: the price is still computed, but reported as provisional with every concern).
// Bundled demo fixtures keep the strict gate (service.ts).

export type Repair = { code: string; path: string; message: string };

/** Issues that make a valuation wrong by construction (double counting, unit/currency mix-ups, look-ahead, crashes). */
export function isHardIssue(i: Issue): boolean {
  switch (i.code) {
    case "FUTURE_EVIDENCE":
    case "MISSING_MARKET":
    case "MISSING_FX":
    case "INVALID_FX":
    case "DUPLICATE_FX":
    case "INVALID_SHARE":
    case "MISSING_COVERAGE":
    case "COVERAGE_EXCEEDS_TOTAL":
    case "OVERLAPPING_PRODUCT_MARKET":
    case "RESIDUAL_REQUIRED":
      return true;
    case "ANNUAL_QUARTERLY_CONFUSION": // an annual basis is 4x off; a large quarter-to-quarter jump is only suspicious
      return i.path.endsWith(".basis");
    case "CURRENCY_MISMATCH": // competitors only shape the market-structure view (the model skips mismatched ones)
      return !i.path.startsWith("competitors");
    default:
      return false;
  }
}

type Series = { quarter: string; revenue: number }[];

/** Ascending, one entry per quarter (a later duplicate wins). */
function sortSeries<T extends { quarter: string }>(s: T[]): T[] {
  const byQ = new Map<string, T>();
  for (const x of s) byQ.set(x.quarter, x);
  return [...byQ.values()].sort((a, b) => parseQuarter(a.quarter) - parseQuarter(b.quarter));
}

const sameOrder = (a: Series, b: Series) => a.length === b.length && a.every((x, i) => x === b[i]);

export function relaxDataset(input: Dataset, asOf: string): { dataset: Dataset; repairs: Repair[]; hard: Issue[]; soft: Issue[] } {
  const ds = structuredClone(input);
  const repairs: Repair[] = [];

  // 1. Series order: sort ascending and drop duplicate quarters. 2. Drop quarters that had not ended by asOf
  //    (look-ahead) when enough history remains; otherwise FUTURE_EVIDENCE stays and blocks the valuation.
  const fixSeries = <T extends { quarter: string; revenue: number }>(path: string, s: T[], min: number): T[] => {
    let out = sortSeries(s);
    if (!sameOrder(out, s)) repairs.push({ code: "SERIES_SORTED", path, message: `${path}: quarters sorted ascending and duplicate quarters removed` });
    const ended = out.filter((x) => quarterEnd(parseQuarter(x.quarter)) <= asOf);
    if (ended.length !== out.length && ended.length >= min) {
      repairs.push({ code: "UNFINISHED_QUARTERS_DROPPED", path, message: `${path}: ${out.length - ended.length} quarter(s) not ended by asOf ${asOf} dropped` });
      out = ended;
    }
    return out;
  };
  ds.markets.forEach((m, i) => (m.observations = fixSeries(`markets[${i}].observations`, m.observations, 4)));
  ds.products.forEach((p, i) => (p.revenue = fixSeries(`products[${i}].revenue`, p.revenue, 1)));
  if (ds.competitors) {
    ds.competitors.forEach((c, i) => (c.revenue = fixSeries(`competitors[${i}].revenue`, c.revenue, 0)));
    const kept = ds.competitors.filter((c) => c.revenue.length > 0);
    if (kept.length !== ds.competitors.length) repairs.push({ code: "COMPETITOR_DROPPED", path: "competitors", message: `${ds.competitors.length - kept.length} competitor(s) without any ended quarter dropped` });
    ds.competitors = kept;
  }

  // 3. Share bounds must contain the observed anchor share, otherwise the model would clamp the observation away.
  const adjusted = adjustEstimatedMarkets(ds).dataset;
  ds.products.forEach((p, i) => {
    const a = shareAnchor(adjusted, p);
    if (!a || a.share > 1) return;
    if (a.share < p.shareBounds.min || a.share > p.shareBounds.max) {
      const before = `[${p.shareBounds.min}, ${p.shareBounds.max}]`;
      p.shareBounds = { min: Math.min(p.shareBounds.min, a.share), max: Math.max(p.shareBounds.max, a.share) };
      repairs.push({ code: "SHARE_BOUNDS_WIDENED", path: `products[${i}].shareBounds`, message: `bounds ${before} widened to include the observed share ${a.share.toFixed(4)}` });
    }
  });

  // 4. Revenue not explained by products needs residual assumptions: flat revenue at the products' revenue-weighted
  //    margin (per scenario), stated as a server assumption instead of silently valuing that revenue at zero.
  const cov = coverage(ds);
  if (!ds.residual && !cov.missing && cov.coveredKRW > 0 && cov.residualKRW > cov.totalKRW * ROUNDING_TOLERANCE) {
    const weights = ds.products.map((p) => {
      const r = p.revenue.find((x) => x.quarter === ds.financials.quarter)!;
      return { w: r.revenue * fxRate(ds, r.currency)!, m: p.operatingMargin.value };
    });
    const total = weights.reduce((t, x) => t + x.w, 0);
    const margin = Object.fromEntries(SCENARIOS.map((sc) => [sc, Math.min(0.6, Math.max(-0.5, weights.reduce((t, x) => t + (x.w / total) * x.m[sc], 0)))])) as Record<(typeof SCENARIOS)[number], number>;
    ds.residual = {
      value: { annualGrowth: { bear: 0, base: 0, bull: 0 }, operatingMargin: margin },
      source: { title: "서버 보정: 잔여 매출 가정", manualReference: "SERVER_REPAIR: residual assumptions supplied by the server because the model proposed none", publishedAt: ds.financials.source.publishedAt },
      rationale: "제품으로 설명되지 않는 매출은 성장 0%, 제품 매출 가중 평균 영업이익률로 가정(서버 보정)",
    };
    repairs.push({ code: "RESIDUAL_ASSUMED", path: "residual", message: `products explain ${(cov.ratio * 100).toFixed(1)}% of revenue; the rest is modelled flat at the products' weighted margin (bear/base/bull ${SCENARIOS.map((s) => (margin[s] * 100).toFixed(1)).join("/")}%)` });
  }

  // Repairs never leave the schema; if one ever did, fall back to the input so the issues are reported as they were.
  const parsed = DatasetSchema.safeParse(ds);
  const dataset = parsed.success ? parsed.data : input;
  const issues = [...validateStatic(dataset), ...validateAsOf(dataset, asOf)];
  return { dataset, repairs: parsed.success ? repairs : [], hard: issues.filter(isHardIssue), soft: issues.filter((i) => !isHardIssue(i)) };
}
