import type { Dataset, Estimate } from "./schema.js";
import { parseQuarter } from "./time.js";

// Market structure = company + identified competitors + "others" (the remainder). Estimated market totals are never
// allowed to be smaller than the players we can name: they are lifted to the player sum and the lift is reported.

export type Adjustment = { code: "ESTIMATED_MARKET_LIFTED_TO_PLAYER_SUM"; marketId: string; quarter: string; from: number; to: number; message: string };

export type EstimateRef = { path: string; kind: "market" | "product" | "competitor"; quarter: string; value: number; currency: string; estimate: Estimate };

/** Every inferred (not source-read) revenue figure in the dataset, in a stable order. */
export function listEstimates(ds: Dataset): EstimateRef[] {
  const out: EstimateRef[] = [];
  ds.markets.forEach((m, i) => m.observations.forEach((o, j) => o.estimate && out.push({ path: `markets[${i}].observations[${j}].revenue`, kind: "market", quarter: o.quarter, value: o.revenue, currency: m.currency, estimate: o.estimate })));
  ds.products.forEach((p, i) => p.revenue.forEach((r, j) => r.estimate && out.push({ path: `products[${i}].revenue[${j}].revenue`, kind: "product", quarter: r.quarter, value: r.revenue, currency: r.currency, estimate: r.estimate })));
  (ds.competitors ?? []).forEach((c, i) => c.revenue.forEach((r, j) => r.estimate && out.push({ path: `competitors[${i}].revenue[${j}].revenue`, kind: "competitor", quarter: r.quarter, value: r.revenue, currency: r.currency, estimate: r.estimate })));
  return out;
}

/** Number of revenue figures the dataset rests on, and how many of them were read from a source. */
export function groundedness(ds: Dataset): { total: number; estimated: number; groundedRatio: number } {
  const total = ds.markets.reduce((n, m) => n + m.observations.length, 0) + ds.products.reduce((n, p) => n + p.revenue.length, 0) + (ds.competitors ?? []).reduce((n, c) => n + c.revenue.length, 0);
  const estimated = listEstimates(ds).length;
  return { total, estimated, groundedRatio: total ? (total - estimated) / total : 1 };
}

/** Sum of the company's products and the named competitors in a market at one quarter (market currency only). */
export function playerSum(ds: Dataset, marketId: string, currency: string, quarter: string) {
  let company = 0;
  let competitors = 0;
  for (const p of ds.products) if (p.marketId === marketId) company += p.revenue.find((r) => r.quarter === quarter && r.currency === currency)?.revenue ?? 0;
  for (const c of ds.competitors ?? []) if (c.marketId === marketId) competitors += c.revenue.find((r) => r.quarter === quarter && r.currency === currency)?.revenue ?? 0;
  return { company, competitors, total: company + competitors };
}

/** Returns a dataset whose ESTIMATED market observations are at least the sum of the identified players (idempotent). */
export function adjustEstimatedMarkets(ds: Dataset): { dataset: Dataset; adjustments: Adjustment[] } {
  const adjustments: Adjustment[] = [];
  let out = ds;
  ds.markets.forEach((m, i) =>
    m.observations.forEach((o, j) => {
      if (!o.estimate) return;
      const floor = playerSum(ds, m.id, m.currency, o.quarter).total;
      if (o.revenue >= floor) return;
      if (out === ds) out = structuredClone(ds);
      out.markets[i]!.observations[j]!.revenue = floor;
      adjustments.push({
        code: "ESTIMATED_MARKET_LIFTED_TO_PLAYER_SUM",
        marketId: m.id,
        quarter: o.quarter,
        from: o.revenue,
        to: floor,
        message: `Estimated ${m.id} market ${o.quarter} (${o.revenue}) was below the sum of the identified players (${floor}); lifted to the sum.`,
      });
    }),
  );
  return { dataset: out, adjustments };
}

export type ObservedStructure = {
  marketId: string;
  currency: string;
  quarter: string;
  marketRevenue: number;
  marketEstimated: boolean;
  company: { revenue: number; share: number; estimated: boolean };
  competitors: { id: string; name: string; revenue: number; share: number; estimated: boolean }[];
  others: { revenue: number; share: number };
  identifiedCoverage: number; // (company + competitors) / market
};

/** Company / competitors / others in each market at the market's latest observed quarter (already ended, not a projection). */
export function observedStructures(ds: Dataset): ObservedStructure[] {
  return ds.markets.map((m) => {
    const last = m.observations.reduce((a, b) => (parseQuarter(b.quarter) > parseQuarter(a.quarter) ? b : a));
    const total = last.revenue;
    let companyRev = 0;
    let companyEst = false;
    for (const p of ds.products)
      if (p.marketId === m.id) {
        const r = p.revenue.find((x) => x.quarter === last.quarter && x.currency === m.currency);
        if (r) {
          companyRev += r.revenue;
          companyEst ||= !!r.estimate;
        }
      }
    const competitors = (ds.competitors ?? [])
      .filter((c) => c.marketId === m.id)
      .flatMap((c) => {
        const r = c.revenue.find((x) => x.quarter === last.quarter && x.currency === m.currency);
        return r ? [{ id: c.id, name: c.name, revenue: r.revenue, share: r.revenue / total, estimated: !!r.estimate }] : [];
      })
      .sort((a, b) => b.revenue - a.revenue);
    const known = companyRev + competitors.reduce((t, c) => t + c.revenue, 0);
    const others = Math.max(0, total - known);
    return {
      marketId: m.id,
      currency: m.currency,
      quarter: last.quarter,
      marketRevenue: total,
      marketEstimated: !!last.estimate,
      company: { revenue: companyRev, share: companyRev / total, estimated: companyEst },
      competitors,
      others: { revenue: others, share: others / total },
      identifiedCoverage: Math.min(1, known / total),
    };
  });
}
