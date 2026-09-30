import { SCENARIOS, type Dataset, type Scenario } from "../domain/schema.js";
import { formatQuarter, parseQuarter, quarterEnd, quarterOfDate } from "../domain/time.js";
import { coverage, fxRate, marketOf, MAX_QUARTERS_BEFORE_ASOF, ROUNDING_TOLERANCE, shareAnchor, targetQuarterIndex, walkSources } from "../domain/validate.js";
import { AppError } from "../errors.js";
import { adjustEstimatedMarkets, groundedness, listEstimates, observedStructures } from "../domain/market-structure.js";

export const MODEL_VERSION = "kospi-product-market/1.2.0";

/** Throws if any number in the output is NaN/Infinity (JSON would silently turn those into null). */
export function assertFinite(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AppError(422, "MODEL_NON_FINITE", `Model produced a non-finite number at ${path}`, { path }, "Check for extreme magnitudes in the dataset.");
  } else if (Array.isArray(value)) value.forEach((v, i) => assertFinite(v, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
}

const pct = (a: number, b: number) => (a / b - 1) * 100;

/** Observed (already ended) quarterly growth from the market series; YoY only when 5+ consecutive quarters exist. */
function observedGrowth(obs: { quarter: string; revenue: number }[]) {
  const n = obs.length;
  const last = obs[n - 1];
  const prev = obs[n - 2];
  const yearAgo = n >= 5 ? obs[n - 5] : undefined;
  return {
    quarter: last.quarter,
    revenue: last.revenue,
    qoqPct: pct(last.revenue, prev.revenue),
    qoqFromQuarter: prev.quarter,
    yoyPct: yearAgo ? pct(last.revenue, yearAgo.revenue) : null,
    yoyFromQuarter: yearAgo?.quarter ?? null,
  };
}

/** (1+g)^(1/4)-1 : annual CAGR -> quarterly compounding rate. */
export const quarterlyRate = (annual: number): number => (1 + annual) ** 0.25 - 1;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Advance a quarterly market revenue observation to the target quarter:
 * deseasonalise -> compound (target - latest) quarters -> reseasonalise -> cyclical multiplier.
 * Quarter indices are absolute (year*4+q-1) so year boundaries compound correctly.
 */
export function projectMarket(p: {
  latestRevenue: number;
  latestQuarter: number;
  targetQuarter: number;
  annualGrowth: number;
  seasonality: [number, number, number, number];
  cyclical: number;
}): number {
  const n = p.targetQuarter - p.latestQuarter;
  if (n < 1) throw new Error("target quarter must be after the latest observation");
  return (
    (p.latestRevenue / p.seasonality[p.latestQuarter % 4]) *
    (1 + quarterlyRate(p.annualGrowth)) ** n *
    p.seasonality[p.targetQuarter % 4] *
    p.cyclical
  );
}

/** Pure analysis of a dataset that already passed validateStatic + validateAsOf. */
export function analyze(input: Dataset, asOf: string) {
  // Estimated market totals below the identified players are lifted first; the lift is reported in dataQuality.
  const { dataset: ds, adjustments } = adjustEstimatedMarkets(input);
  const target = targetQuarterIndex(ds, asOf);
  const cov = coverage(ds);
  const bridge = ds.earningsBridge.value;
  const residualQuarters = target - parseQuarter(ds.financials.quarter);
  const anchors = ds.products.map((p) => ({ p, a: shareAnchor(ds, p)! }));

  // A competitor's share is anchored at its latest quarter shared with the market series, and only if that quarter is
  // as recent as any other input may be (MAX_QUARTERS_BEFORE_ASOF); an older or non-overlapping series is left out of
  // the market structure (its revenue falls into "others") and reported, instead of projecting a years-old share.
  const competitorAnchors = new Map<string, { quarter: string; revenue: number; estimate?: unknown }>();
  const competitorWarnings: string[] = [];
  for (const c of ds.competitors ?? []) {
    const m = ds.markets.find((x) => x.id === c.marketId);
    if (!m) continue;
    const quarters = new Set(m.observations.map((o) => o.quarter));
    const anchor = c.revenue.filter((r) => quarters.has(r.quarter) && r.currency === m.currency).sort((x, y) => parseQuarter(y.quarter) - parseQuarter(x.quarter))[0];
    if (!anchor) competitorWarnings.push(`Competitor ${c.id} has no revenue in ${m.id}'s quarters and currency; it is left out of the market structure.`);
    else if (quarterOfDate(asOf) - parseQuarter(anchor.quarter) > MAX_QUARTERS_BEFORE_ASOF)
      competitorWarnings.push(`Competitor ${c.id}'s latest share (${anchor.quarter}) is more than ${MAX_QUARTERS_BEFORE_ASOF} quarters before asOf's quarter (${formatQuarter(quarterOfDate(asOf))}); it is left out of the market structure.`);
    else competitorAnchors.set(c.id, anchor);
  }

  const scenarios = SCENARIOS.map((sc: Scenario) => {
    const products = anchors.map(({ p, a }) => {
      const m = marketOf(ds, p)!;
      const latest = m.observations.at(-1)!;
      const season = m.seasonality.value;
      const yearAgoObs = m.observations.find((o) => parseQuarter(o.quarter) === target - 4);
      const marketRevenue = projectMarket({
        latestRevenue: latest.revenue,
        latestQuarter: parseQuarter(latest.quarter),
        targetQuarter: target,
        annualGrowth: m.annualGrowth.value[sc],
        seasonality: [season.q1, season.q2, season.q3, season.q4],
        cyclical: m.cyclical.value[sc],
      });
      const share = clamp(a.share + p.shareDelta.value[sc], p.shareBounds.min, p.shareBounds.max);
      const fx = fxRate(ds, m.currency)!;
      const revenueKRW = marketRevenue * share * fx;
      const margin = p.operatingMargin.value[sc];
      // Company + competitors + others always add up to the projected market: competitors keep their last observed share
      // (plus an optional assumed shareDelta); if company + competitors would exceed 100%, the competitors are scaled
      // down to what is left (reported as scaled), and "others" is the remainder.
      const byQ = new Map(m.observations.map((o) => [o.quarter, o.revenue]));
      const raw = (ds.competitors ?? [])
        .filter((c) => c.marketId === m.id)
        .flatMap((c) => {
          const anchor = competitorAnchors.get(c.id);
          if (!anchor) return [];
          const share0 = anchor.revenue / byQ.get(anchor.quarter)!;
          return [{ c, anchor, share0, share: clamp(share0 + (c.shareDelta?.value[sc] ?? 0), 0, 1) }];
        });
      const rawSum = raw.reduce((t, x) => t + x.share, 0);
      const room = Math.max(0, 1 - share);
      const scale = rawSum > room && rawSum > 0 ? room / rawSum : 1;
      const competitors = raw
        .map((x) => ({
          competitorId: x.c.id,
          name: x.c.name,
          anchorQuarter: x.anchor.quarter,
          anchorShare: x.share0,
          share: x.share * scale,
          marketRevenue: marketRevenue * x.share * scale,
          revenueKRW: marketRevenue * x.share * scale * fx,
          estimated: !!x.anchor.estimate,
        }))
        .sort((a, b) => b.share - a.share);
      const identifiedShare = share + competitors.reduce((t, x) => t + x.share, 0);
      const structure = {
        marketRevenue,
        company: { share, marketRevenue: marketRevenue * share },
        competitors,
        others: { share: Math.max(0, 1 - identifiedShare), marketRevenue: marketRevenue * Math.max(0, 1 - identifiedShare) },
        identifiedShare,
        competitorsScaled: scale < 1,
        bottomUpBeforeScalingPct: (share + rawSum) * 100, // > 100 means the named players alone overshoot the projected market
        partsSumMarketRevenue: marketRevenue * share + competitors.reduce((t, x) => t + x.marketRevenue, 0) + marketRevenue * Math.max(0, 1 - identifiedShare),
      };
      return {
        productId: p.id,
        marketId: m.id,
        marketCurrency: m.currency,
        fxKrwPerUnit: fx,
        marketRevenue, // target quarter (projection/nowcast, NOT observed), market currency
        marketVsLatestObservedPct: pct(marketRevenue, latest.revenue),
        marketYoYPct: yearAgoObs ? pct(marketRevenue, yearAgoObs.revenue) : null, // vs same quarter last year when observed
        revenueShare: share,
        attributableRevenueKRW: revenueKRW,
        operatingMargin: margin,
        operatingProfitKRW: revenueKRW * margin,
        structure,
      };
    });

    const r = ds.residual?.value;
    const residualRevenue = r ? cov.residualKRW * (1 + quarterlyRate(r.annualGrowth[sc])) ** residualQuarters : 0;
    const residual = {
      revenueKRW: residualRevenue,
      operatingMargin: r?.operatingMargin[sc] ?? 0,
      operatingProfitKRW: residualRevenue * (r?.operatingMargin[sc] ?? 0),
    };

    const revenueKRW = products.reduce((t, x) => t + x.attributableRevenueKRW, 0) + residual.revenueKRW;
    const operatingProfitKRW = products.reduce((t, x) => t + x.operatingProfitKRW, 0) + residual.operatingProfitKRW;
    const pretaxKRW = operatingProfitKRW + bridge.netInterestKRW;
    const taxKRW = Math.max(0, pretaxKRW) * bridge.effectiveTaxRate; // no tax credit on losses (conservative)
    const netIncomeKRW = pretaxKRW - taxKRW;
    const noncontrollingKRW = netIncomeKRW * bridge.noncontrollingShare;
    // preferredClaimsKRW is the caller's explicit total for preferred classes (dividends + participation); never derived here.
    const commonEarningsKRW = netIncomeKRW - noncontrollingKRW - bridge.preferredClaimsKRW;

    const quote = ds.quote.priceKRW;
    const pe = ds.valuation.peMultiple.value[sc];
    const valuation =
      commonEarningsKRW > 0
        ? (() => {
            const quarterlyEpsKRW = commonEarningsKRW / ds.shares.dilutedCommon;
            const annualizedEpsKRW = quarterlyEpsKRW * 4;
            const targetPriceKRW = annualizedEpsKRW * pe;
            return { status: "available" as const, quarterlyEpsKRW, annualizedEpsKRW, peMultiple: pe, targetPriceKRW, upsidePct: (targetPriceKRW / quote - 1) * 100 };
          })()
        : { status: "unavailable" as const, reason: "Common-share attributable earnings are not positive; P/E valuation is undefined." };

    return {
      scenario: sc,
      products,
      residual,
      totals: { revenueKRW, operatingProfitKRW, pretaxKRW, taxKRW, netIncomeKRW, noncontrollingKRW, preferredClaimsKRW: bridge.preferredClaimsKRW, commonEarningsKRW },
      valuation,
    };
  });

  const warnings: string[] = [];
  if (cov.residualKRW > cov.totalKRW * ROUNDING_TOLERANCE) warnings.push(`Products explain ${(cov.ratio * 100).toFixed(1)}% of company revenue; the rest (${(100 - cov.ratio * 100).toFixed(1)}%) uses explicit residual assumptions.`);
  for (const m of ds.markets) {
    const n = target - parseQuarter(m.observations.at(-1)!.quarter);
    if (n >= 3) warnings.push(`Market ${m.id} projection extrapolates ${n} quarters from its latest observation.`);
  }
  if (scenarios.some((x) => x.valuation.status === "unavailable")) warnings.push("At least one scenario has non-positive common earnings; its valuation is unavailable.");
  const estimates = listEstimates(ds);
  const ground = groundedness(ds);
  if (estimates.length)
    warnings.push(`${estimates.length} of ${ground.total} revenue inputs (${((1 - ground.groundedRatio) * 100).toFixed(0)}%) are ESTIMATES inferred from other data, not read from a source; the valuation inherits their uncertainty.`);
  for (const a of adjustments) warnings.push(a.message);
  warnings.push(...competitorWarnings);
  if (ds.synthetic) warnings.push("SYNTHETIC DEMO DATA: fictional fixtures, not real prices, shares or market research.");

  const seen = new Set<string>();
  const provenance = [...walkSources(ds)].map((x) => x.source).filter((x) => {
    const k = `${x.title}|${x.url ?? x.manualReference}|${x.publishedAt}`;
    return !seen.has(k) && seen.add(k);
  });

  const contribution = ds.products
    .map((p) => {
      const r = p.revenue.find((x) => x.quarter === ds.financials.quarter)!;
      return { productId: p.id, name: p.name, quarter: r.quarter, revenueKRW: r.revenue * fxRate(ds, r.currency)! };
    })
    .sort((a, b) => b.revenueKRW - a.revenueKRW)
    .map((x, i) => ({ rank: i + 1, ...x, shareOfCompanyRevenue: x.revenueKRW / ds.financials.totalRevenueKRW }));

  const result = {
    modelVersion: MODEL_VERSION,
    ticker: ds.company.ticker,
    companyName: ds.company.name,
    asOf,
    targetQuarter: formatQuarter(target),
    targetQuarterEnd: quarterEnd(target),
    currency: "KRW",
    facts: {
      quote: { priceKRW: ds.quote.priceKRW, asOf: ds.quote.asOf },
      dilutedCommonShares: ds.shares.dilutedCommon,
      financials: { quarter: ds.financials.quarter, totalRevenueKRW: ds.financials.totalRevenueKRW },
      // "observed" = actuals of ended quarters; scenarios[] below are projections/nowcast for targetQuarter.
      productContribution: contribution,
      markets: ds.markets.map((m) => ({ id: m.id, name: m.name, scope: m.scope, currency: m.currency, observedLatest: observedGrowth(m.observations), observations: m.observations.map((o) => ({ quarter: o.quarter, revenue: o.revenue })), drivers: (m.drivers ?? []).map((d) => d.text) })),
      marketStructureObserved: observedStructures(ds), // latest ended quarter: company / competitors / others
      productShares: anchors.map(({ p, a }) => ({ productId: p.id, quarter: a.quarter, productRevenue: a.productRevenue, marketRevenue: a.marketRevenue, revenueShare: a.share })),
      fx: ds.fx.map((f) => ({ currency: f.currency, krwPerUnit: f.krwPerUnit, asOf: f.asOf })),
    },
    assumptions: {
      marketGrowthAndSeasonality: ds.markets.map((m) => ({ marketId: m.id, annualGrowth: m.annualGrowth.value, seasonality: m.seasonality.value, cyclicalMultiplier: m.cyclical.value })),
      products: ds.products.map((p) => ({ productId: p.id, shareDelta: p.shareDelta.value, shareBounds: p.shareBounds, operatingMargin: p.operatingMargin.value })),
      residual: ds.residual?.value ?? null,
      earningsBridge: { ...bridge, rationale: ds.earningsBridge.rationale },
      peMultiple: ds.valuation.peMultiple.value,
    },
    scenarios,
    dataQuality: {
      synthetic: ds.synthetic === true,
      coverage: { quarter: cov.quarter, ratio: cov.ratio, coveredKRW: cov.coveredKRW, residualKRW: cov.residualKRW, residualModelled: cov.residualKRW > 0 && !!ds.residual },
      markets: ds.markets.map((m) => ({ marketId: m.id, latestObservation: m.observations.at(-1)!.quarter, quartersToTarget: target - parseQuarter(m.observations.at(-1)!.quarter) })),
      estimates: estimates.map((e) => ({ path: e.path, kind: e.kind, quarter: e.quarter, value: e.value, currency: e.currency, method: e.estimate.method, basedOn: e.estimate.basedOn, rationale: e.estimate.rationale })),
      groundedness: ground,
      adjustments,
      warnings,
    },
    provenance,
    limitations: [
      "targetPriceKRW is a valuation proxy (annualized next-quarter EPS x scenario P/E), NOT a forecast of the realized market price. Annualization is EPS x 4 and ignores seasonality and cyclicality of the remaining quarters.",
      "Scenarios are bear/base/bull assumptions supplied in the dataset; no probabilities or confidence levels are implied.",
      "Market share is revenue share within the same global product scope, quarter and currency; volume shares must not be used.",
      "All FX conversion uses the single dated rate in the dataset; historical FX drift between quarters is not modelled.",
      "Residual (non-product) revenue is grown at a constant rate without seasonality; taxes are not credited on pre-tax losses.",
      "Pre-tax income is operating profit plus the stated net interest only; equity-method results and other non-operating gains/losses are not modelled.",
      "Share count must be diluted COMMON shares only. Earnings allocated to preferred classes (dividends AND any participation) must be supplied explicitly as preferredClaimsKRW with a rationale; the model does not derive capital-class rights, so a wrong or omitted value silently overstates common EPS.",
      "Output quality is bounded by the cited sources. Global product market revenue is rarely machine-readable: public collection surfaces candidates and news, dual LLM review can only accept figures that are quoted from supplied documents, and otherwise market inputs are inferred as flagged estimates (see the report).",
      "Observed quarters are ended-quarter actuals; the target quarter is a projection (nowcast), never an observation.",
    ],
  };
  assertFinite(result);
  return result;
}

export type Analysis = ReturnType<typeof analyze>;
