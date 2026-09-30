import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import type { Catalyst, ConsensusSnapshot, EarningsForecastSnapshot, StrategySource } from "../../src/strategy/schema.js";
import type { StrategyConfig } from "../../src/strategy/config.js";
import { DEFAULT_RISK_PARAMS } from "../../src/strategy/config.js";
import type { FundingPlan } from "../../src/strategy/schema.js";

// Small, hand-verifiable fixtures for the earnings-gap-auto/v1 strategy slice. Kept deliberately simple (round
// numbers) so eligibility/arithmetic assertions can be checked with pencil-and-paper math; the larger, more
// realistic synthetic scenario lives in examples/strategy/ and is exercised by test/strategy/example.test.ts.

export const DECISION_AT = "2026-01-15T06:00:00+09:00"; // decision "close"; entry must be strictly after this
export const HORIZON = ["2026Q2", "2026Q3", "2026Q4", "2027Q1"];

const src = (title: string, knownAt: string): StrategySource => ({ title, manualReference: "test-fixture", kind: "manual_assumption", knownAt });
export const planAssumptions = () => ({ isAssumption: true as const, rationale: "Synthetic plan; every number is a declared assumption", source: src("plan", "2026-01-05T00:00:00+09:00") });
export function makeFunding(): FundingPlan {
  return { openingBalanceBasis: "projected_start_of_horizon", openingUnrestrictedCashKRW: 10000, openingDebtKRW: 1000, assumptions: planAssumptions(),
    quarters: HORIZON.map((quarter) => ({ quarter, depreciationAndAmortizationKRW: 20, capexKRW: 80, deltaWorkingCapitalKRW: 30,
      cashTaxesKRW: 20, cashInterestPaidKRW: 50, otherOperatingCashFlowKRW: 0, otherOperatingCashFlowRationale: "No other flows in synthetic model",
      debtPrincipalDueKRW: 50, committedDebtDrawKRW: 0, dividendsAndBuybacksKRW: 5, assumptions: planAssumptions() })) };
}

/** Every quarter identical: volume 10 @ price 100 / varCost 60 / fixed 100 -> OP 300, netInterest -50, tax 20%, EPS 2. */
export function makeForecast(overrides: Partial<EarningsForecastSnapshot> = {}): EarningsForecastSnapshot {
  const quarter = (q: string) => ({
    quarter: q,
    coverageAttestation: { complete: true as const, statedBy: "test" },
    netInterestKRW: -50,
    taxRate: 0.2,
    noncontrollingShare: 0,
    preferredClaimsKRW: 0,
    dilutedCommonShares: 100,
    bridgeAssumptions: planAssumptions(),
    segments: [{ name: "seg", volume: 10, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 100, source: src(`plan ${q}`, "2026-01-05T00:00:00+09:00"), assumptions: planAssumptions() }],
  });
  return {
    schemaVersion: 1,
    ticker: "999990",
    company: { name: "Synthetic manufacturer", exchange: "KOSPI", securityType: "common_stock", source: src("company", "2026-01-01T00:00:00+09:00") },
    scope: "consolidated",
    sector: "automotive",
    fiscalYearBasis: "calendar",
    currency: "KRW",
    generatedAt: "2026-01-10T00:00:00+09:00",
    analyst: "test analyst",
    quarters: HORIZON.map(quarter),
    funding: makeFunding(),
    liquidity: { averageDailyTradedValueKRW: 100_000_000, windowSessions: 20, asOf: "2026-01-09T15:30:00+09:00", knownAt: "2026-01-09T16:00:00+09:00", source: src("traded value", "2026-01-09T16:00:00+09:00") },
    ...overrides,
  };
}

/** Automatic short-term path: the same synthetic company, estimated for ONE quarter (in progress at DECISION_AT). EPS 2. */
export const SINGLE_QUARTER = "2026Q1";
export function makeSingleQuarterForecast(overrides: Partial<EarningsForecastSnapshot> = {}): EarningsForecastSnapshot {
  const f = makeForecast();
  return { ...f, quarters: [{ ...f.quarters[0]!, quarter: SINGLE_QUARTER }], funding: { ...f.funding!, quarters: [{ ...f.funding!.quarters[0]!, quarter: SINGLE_QUARTER }] }, ...overrides };
}

export function makeConsensus(overrides: Partial<ConsensusSnapshot> = {}): ConsensusSnapshot {
  return {
    schemaVersion: 1,
    ticker: "999990",
    scope: "consolidated",
    basis: "common_diluted",
    currency: "KRW",
    unit: "KRW_per_share",
    horizonQuarters: [...HORIZON],
    epsPerShare: 7,
    knownAt: "2026-01-01T00:00:00+09:00",
    source: src("consensus", overrides.knownAt ?? "2026-01-01T00:00:00+09:00"),
    ...overrides,
  };
}

export function makeCatalyst(overrides: Partial<Catalyst> = {}): Catalyst {
  return {
    schemaVersion: 1,
    ticker: "999990",
    eventType: "earnings_release",
    eventAt: "2026-01-25T06:00:00+09:00",
    knownAt: "2026-01-01T00:00:00+09:00",
    source: src("IR calendar", "2026-01-01T00:00:00+09:00"),
    ...overrides,
  };
}

export const TEST_CONFIG: StrategyConfig = {
  version: "earnings-gap-auto/v1",
  sector: "automotive",
  currency: "KRW",
  exchange: "KOSPI",
  gapThresholdPct: 0.1,
  minRevisionPct: 0,
  maxCurrentConsensusAgeDays: 30,
  minPriorConsensusLagDays: 20,
  maxPriorConsensusLagDays: 40,
  catalystMinDaysAhead: 1,
  catalystMaxDaysAhead: 60,
  maxHoldings: 5,
  maxWeightPerHolding: 0.2,
  holdSessions: 3,
  minConsensusEpsKRW: 1,
  feeBpsPerSide: 10,
  slippageBpsPerSide: 20,
  sellTaxBps: 18,
  initialCapitalKRW: 1_000_000,
  risk: { ...DEFAULT_RISK_PARAMS, minimumCashBufferKRW: 0 },
};

/** Passes every eligibility check: NTM EPS 8 vs consensus 7 -> gap ~14.3%; prior 6 -> revision ~16.7%. */
export function makeEligibleCandidate() {
  return makeCandidateWithTicker("999990");
}

/** Same shape as makeEligibleCandidate, parameterized by ticker/sector -- for tests with several candidates
 * across different user-declared sectors. */
export function makeCandidateWithTicker(ticker: string, sector = "automotive") {
  return {
    ticker,
    evidenceMode: "synthetic" as const,
    forecast: makeForecast({ ticker, sector }),
    currentConsensus: makeConsensus({ ticker, epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }),
    priorConsensus: makeConsensus({ ticker, epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }), // 30 days before current
    catalyst: makeCatalyst({ ticker }),
  };
}

/** Single-quarter counterpart for the automatic short-term path: EPS 2 vs consensus 1.75 -> gap ~14.3%; prior 1.5 -> revision ~16.7%. */
export function makeSingleQuarterCandidate(ticker: string) {
  const consensus = (epsPerShare: number, knownAt: string) => makeConsensus({ ticker, horizonQuarters: [SINGLE_QUARTER], epsPerShare, knownAt });
  return {
    ticker,
    forecast: makeSingleQuarterForecast({ ticker }),
    currentConsensus: consensus(1.75, "2026-01-05T00:00:00+09:00"),
    priorConsensus: consensus(1.5, "2025-12-06T00:00:00+09:00"),
    catalyst: makeCatalyst({ ticker }),
  };
}

export async function tmpDir(name = "strategy"): Promise<string> {
  const base = path.join(process.cwd(), ".test-tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${name}-`));
}
