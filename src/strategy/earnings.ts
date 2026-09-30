import type { EarningsForecastSnapshot, QuarterForecast, SegmentForecast } from "./schema.js";

// Deterministic four-quarter earnings bridge (STRATEGY_SPEC.md "Earnings model"). Sums four independently modelled
// quarters; this is NOT last quarter's EPS multiplied by four.

export type QuarterBridge = {
  quarter: string;
  revenueKRW: number;
  operatingProfitKRW: number;
  netInterestKRW: number;
  pretaxKRW: number;
  taxKRW: number;
  netIncomeKRW: number;
  noncontrollingKRW: number;
  preferredClaimsKRW: number;
  commonEarningsKRW: number;
  dilutedCommonShares: number;
  epsKRW: number;
  segments: { name: string; revenueKRW: number; contributionKRW: number; breakEvenVolume: number | null }[];
};

function bridgeOneQuarter(q: QuarterForecast): QuarterBridge {
  const revenueKRW = q.segments.reduce((t, s) => t + s.volume * s.unitPriceKRW, 0);
  const operatingProfitKRW = q.segments.reduce((t, s) => t + s.volume * (s.unitPriceKRW - s.variableCostPerUnitKRW) - s.fixedCostKRW, 0);
  const pretaxKRW = operatingProfitKRW + q.netInterestKRW;
  const taxKRW = Math.max(pretaxKRW, 0) * q.taxRate; // no tax credit on a pretax loss (conservative)
  const netIncomeKRW = pretaxKRW - taxKRW;
  const noncontrollingKRW = netIncomeKRW * q.noncontrollingShare;
  const commonEarningsKRW = netIncomeKRW - noncontrollingKRW - q.preferredClaimsKRW;
  const epsKRW = commonEarningsKRW / q.dilutedCommonShares;
  const segments = q.segments.map((s) => {
    const contributionPerUnit = s.unitPriceKRW - s.variableCostPerUnitKRW;
    return {
      name: s.name,
      revenueKRW: s.volume * s.unitPriceKRW,
      contributionKRW: s.volume * contributionPerUnit - s.fixedCostKRW,
      breakEvenVolume: contributionPerUnit > 0 ? s.fixedCostKRW / contributionPerUnit : null, // null = never breaks even at this price/cost
    };
  });
  return { quarter: q.quarter, revenueKRW, operatingProfitKRW, netInterestKRW: q.netInterestKRW, pretaxKRW, taxKRW, netIncomeKRW, noncontrollingKRW, preferredClaimsKRW: q.preferredClaimsKRW, commonEarningsKRW, dilutedCommonShares: q.dilutedCommonShares, epsKRW, segments };
}

const sumEps = (quarters: QuarterBridge[]): number => quarters.reduce((t, q) => t + q.epsKRW, 0);

type Perturbation = { field: "unitPriceKRW" | "volume" | "variableCostPerUnitKRW"; factor: number };

/** Applies the same multiplicative perturbation to one segment field, in every quarter, holding everything else fixed. */
function perturb(snapshot: EarningsForecastSnapshot, p: Perturbation): EarningsForecastSnapshot {
  return {
    ...snapshot,
    quarters: snapshot.quarters.map((q) => ({
      ...q,
      segments: q.segments.map((s: SegmentForecast) => ({ ...s, [p.field]: s[p.field] * p.factor })),
    })),
  };
}

export type ForecastBridge = {
  quarters: QuarterBridge[];
  ntmEpsKRW: number; // sum of the four quarterly common EPS figures, not quarter*4
  sensitivity: {
    // Deterministic perturbations, NOT confidence intervals (STRATEGY_SPEC.md explicit warning).
    priceUp1Pct: { ntmEpsKRW: number; deltaEpsKRW: number };
    volumeUp1Pct: { ntmEpsKRW: number; deltaEpsKRW: number }; // variable cost total scales automatically with volume
    variableCostUp1Pct: { ntmEpsKRW: number; deltaEpsKRW: number };
  };
};

export function computeForecastBridge(snapshot: EarningsForecastSnapshot): ForecastBridge {
  const quarters = snapshot.quarters.map(bridgeOneQuarter);
  const ntmEpsKRW = sumEps(quarters);
  const sensitivity = (field: Perturbation["field"]) => {
    const perturbed = perturb(snapshot, { field, factor: 1.01 }).quarters.map(bridgeOneQuarter);
    const eps = sumEps(perturbed);
    return { ntmEpsKRW: eps, deltaEpsKRW: eps - ntmEpsKRW };
  };
  return {
    quarters,
    ntmEpsKRW,
    sensitivity: {
      priceUp1Pct: sensitivity("unitPriceKRW"),
      volumeUp1Pct: sensitivity("volume"),
      variableCostUp1Pct: sensitivity("variableCostPerUnitKRW"),
    },
  };
}
