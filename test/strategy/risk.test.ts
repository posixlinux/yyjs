import { describe, expect, it } from "vitest";
import { computeCompanyRisk } from "../../src/strategy/risk.js";
import { computeForecastBridge } from "../../src/strategy/earnings.js";
import { screen } from "../../src/strategy/screen.js";
import { DECISION_AT, TEST_CONFIG, makeEligibleCandidate, makeForecast } from "./fixture.js";

function oracleForecast() {
  const f = makeForecast();
  f.funding!.openingUnrestrictedCashKRW = 40;
  f.funding!.openingDebtKRW = 200;
  for (const q of f.quarters) {
    Object.assign(q, { netInterestKRW: -10, dilutedCommonShares: 10 });
    Object.assign(q.segments[0]!, { volume: 10, unitPriceKRW: 20, variableCostPerUnitKRW: 10, fixedCostKRW: 0 });
  }
  for (const q of f.funding!.quarters) q.cashInterestPaidKRW = 10;
  return f;
}

describe("investment and funding risk", () => {
  it("independent cash oracle: positive profit, but capex and maturities need 35 extra cash", () => {
    const r = computeCompanyRisk(oracleForecast(), TEST_CONFIG.risk)!;
    expect(r.base.quarters[0]).toMatchObject({ operatingProfitKRW: 100, operatingCashProxyKRW: 60,
      freeCashFlowAfterCapexKRW: -20, endingCashKRW: -35, endingDebtKRW: 150, additionalFundingRequiredKRW: 35 });
    expect(r.base.fourQuarterEpsKRW).toBeCloseTo(4 * 7.2);
    expect(r.base.peakAdditionalFundingRequiredKRW).toBe(260);
  });

  it("stress scales variable cost with volume and applies additional interest once to cash and EPS", () => {
    const r = computeCompanyRisk(oracleForecast(), TEST_CONFIG.risk)!;
    expect(r.stress.quarters[0]).toMatchObject({ operatingProfitKRW: 76.5, incrementalInterestKRW: 1,
      cashInterestPaidKRW: 11, operatingCashProxyKRW: 35.5, freeCashFlowAfterCapexKRW: -44.5, endingCashKRW: -59.5 });
    // Opening debt falls 200 -> 150 -> 100 -> 50, so extra interest falls 1 -> .75 -> .5 -> .25.
    expect(r.stress.fourQuarterEpsKRW).toBeCloseTo([1, .75, .5, .25].reduce((n, interest) => n + (76.5 - 10 - interest) * .8 / 10, 0));
  });

  it("capex and principal affect cash/debt, not EPS; working capital release adds cash", () => {
    const f = oracleForecast();
    const before = computeForecastBridge(f).ntmEpsKRW;
    f.funding!.quarters[0]!.capexKRW = 0;
    f.funding!.quarters[0]!.deltaWorkingCapitalKRW = -30;
    f.funding!.quarters[0]!.debtPrincipalDueKRW = 0;
    const r = computeCompanyRisk(f, TEST_CONFIG.risk)!;
    expect(r.base.fourQuarterEpsKRW).toBe(before);
    expect(r.base.quarters[0]!.endingCashKRW).toBe(-35 + 80 + 60 + 50);
    expect(r.base.quarters[0]!.endingDebtKRW).toBe(200);
  });

  it("committed financing adds cash and debt without adding profit; impossible repayments rejected", () => {
    const f = oracleForecast();
    f.funding!.quarters[0]!.committedDebtDrawKRW = 400;
    const r = computeCompanyRisk(f, TEST_CONFIG.risk)!;
    expect(r.base.quarters[0]!.endingCashKRW).toBe(365);
    expect(r.base.quarters[0]!.endingDebtKRW).toBe(550);
    expect(r.base.peakAdditionalFundingRequiredKRW).toBe(0);
    expect(r.base.fourQuarterEpsKRW).toBeCloseTo(28.8);
    f.funding!.quarters[0]!.debtPrincipalDueKRW = 601;
    expect(() => computeCompanyRisk(f, TEST_CONFIG.risk)).toThrow(/Principal due/);
  });

  it("does not invent interest coverage for interest-free debt or capex/revenue for zero sales", () => {
    const f = oracleForecast();
    for (const q of f.funding!.quarters) q.cashInterestPaidKRW = 0;
    for (const q of f.quarters) q.segments[0]!.volume = 0;
    const r = computeCompanyRisk(f, TEST_CONFIG.risk)!;
    expect(r.base.quarters[0]).toMatchObject({ interestCoverage: null, interestCoverageReason: "NO_CASH_INTEREST", capexToRevenue: null });
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });
});

const evaluate = (c = makeEligibleCandidate(), config = TEST_CONFIG) => screen([c], config, DECISION_AT).evaluations[0]!;
const codes = (e: ReturnType<typeof evaluate>) => e.eligible ? [] : e.reasons.map((r) => r.code);

describe("risk affects eligibility and capital allocation", () => {
  it("excludes a profitable candidate whose investment plan exhausts cash", () => {
    const c = makeEligibleCandidate();
    c.forecast.funding!.quarters[0]!.capexKRW = 20000;
    const e = evaluate(c);
    expect(codes(e)).toContain("BASE_FUNDING_GAP");
    expect(e.risk!.base.fourQuarterEpsKRW).toBe(8);
    expect(e.risk!.base.peakAdditionalFundingRequiredKRW).toBeGreaterThan(0);
  });

  it("excludes only stress-funded candidates when the policy requests it", () => {
    const c = makeEligibleCandidate();
    c.forecast.funding!.openingUnrestrictedCashKRW = 0;
    // Base cash +65 each quarter, stressed cash -52 after +5 stress interest in Q1.
    const e = evaluate(c);
    expect(codes(e)).toContain("STRESS_FUNDING_GAP");
    expect(codes(e)).not.toContain("BASE_FUNDING_GAP");
    expect(evaluate(c, { ...TEST_CONFIG, risk: { ...TEST_CONFIG.risk, excludeStressFundingGap: false } }).eligible).toBe(true);
  });

  it("requires funding and liquidity instead of silently assuming zeros", () => {
    const c = makeEligibleCandidate();
    delete c.forecast.funding;
    delete c.forecast.liquidity;
    expect(codes(evaluate(c))).toEqual(expect.arrayContaining(["RISK_DATA_MISSING", "LIQUIDITY_DATA_MISSING"]));
  });

  it("rejects future liquidity/funding sources and weak interest coverage", () => {
    const c = makeEligibleCandidate();
    c.forecast.liquidity!.source.knownAt = "2027-01-01T00:00:00Z";
    c.forecast.funding!.assumptions.source.knownAt = "2027-01-01T00:00:00Z";
    c.forecast.funding!.quarters[0]!.cashInterestPaidKRW = 500;
    expect(codes(evaluate(c))).toEqual(expect.arrayContaining(["LIQUIDITY_TIME_MISMATCH", "SOURCE_KNOWN_AFTER_GENERATION", "LOW_INTEREST_COVERAGE"]));
  });

  it("caps industry exposure, then reduces small-cap allocation by observed capacity, leaving cash", () => {
    const a = makeEligibleCandidate();
    const b = makeEligibleCandidate();
    b.ticker = b.forecast.ticker = b.currentConsensus.ticker = b.priorConsensus.ticker = b.catalyst.ticker = "111110";
    b.forecast.liquidity!.averageDailyTradedValueKRW = 1_000_000;
    const r = screen([a, b], { ...TEST_CONFIG, maxWeightPerHolding: 1 }, DECISION_AT);
    expect(r.selected.find((s) => s.ticker === a.ticker)!.weight).toBe(.3);
    expect(r.selected.find((s) => s.ticker === b.ticker)!.weight).toBe(.01);
    expect(r.portfolio.sectorWeight).toBeCloseTo(.31);
    expect(r.portfolio.idleCashKRW).toBeCloseTo(690000);
    expect(r.portfolio.positions.find((p) => p.ticker === b.ticker)).toMatchObject({ budgetKRW: 10000, participationRate: .01, liquidityLimited: true });
    expect(r.portfolio.stressLossFraction).toBeNull(); // no price/PER diagnostics; don't invent risk
  });
});
