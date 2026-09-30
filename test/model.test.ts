import { describe, expect, it } from "vitest";
import { analyze, projectMarket, quarterlyRate } from "../src/model/model.js";
import { formatQuarter, parseQuarter, quarterEnd, quarterOfDate } from "../src/domain/time.js";
import { targetQuarterIndex, validateAsOf, validateStatic } from "../src/domain/validate.js";
import { AS_OF, makeDataset } from "./fixture.js";

const base = (ds = makeDataset()) => analyze(ds, AS_OF).scenarios.find((s) => s.scenario === "base")!;

describe("quarter arithmetic and target date", () => {
  it("round-trips quarters and computes quarter end", () => {
    expect(formatQuarter(parseQuarter("2025Q4") + 1)).toBe("2026Q1");
    expect(quarterEnd(parseQuarter("2024Q1"))).toBe("2024-03-31");
    expect(quarterEnd(parseQuarter("2025Q4"))).toBe("2025-12-31");
  });

  it.each([
    ["2025-12-31", "2026Q1"],
    ["2026-01-01", "2026Q2"],
    ["2026-03-31", "2026Q2"],
    ["2026-04-01", "2026Q3"],
    ["2026-12-15", "2027Q1"],
  ])("asOf %s: the quarter after its calendar quarter is %s", (asOf, expected) => {
    expect(formatQuarter(quarterOfDate(asOf) + 1)).toBe(expected);
  });

  it("analyze reports the target quarter and its end date", () => {
    const a = analyze(makeDataset(), AS_OF);
    expect(a.targetQuarter).toBe("2026Q1");
    expect(a.targetQuarterEnd).toBe("2026-03-31");
  });

  // Target = first quarter without reported company results, kept within [quarter just ended, quarter in progress]
  // and after every market's latest observation.
  const target = (asOf: string, financials: string, latestObservation = financials) => {
    const ds = makeDataset();
    ds.financials.quarter = financials;
    ds.markets[0].observations.at(-1)!.quarter = latestObservation;
    return formatQuarter(targetQuarterIndex(ds, asOf));
  };

  it.each([
    ["2026-10-01", "2026Q2", "2026Q2", "2026Q3"], // Q3 ended but unreported: projected, not skipped to 2027Q1
    ["2026-11-20", "2026Q3", "2026Q3", "2026Q4"], // Q3 already reported: the quarter in progress
    ["2026-10-01", "2025Q4", "2025Q4", "2026Q3"], // older results never pull the target further back than the just-ended quarter
    ["2026-11-20", "2026Q2", "2026Q3", "2026Q4"], // the market already has an observation for Q3: stay a projection
    ["2026-12-31", "2026Q3", "2026Q3", "2026Q4"],
    ["2027-01-01", "2026Q3", "2026Q3", "2026Q4"], // year boundary
  ])("asOf %s, results through %s, market through %s -> target %s", (asOf, fin, obs, expected) => {
    expect(target(asOf, fin, obs)).toBe(expected);
  });
});

describe("market projection", () => {
  it("converts annual CAGR to quarterly via (1+g)^(1/4)-1", () => {
    expect(quarterlyRate(0.1)).toBeCloseTo(1.1 ** 0.25 - 1, 12);
    expect(1 + quarterlyRate(0.2155)).toBeCloseTo(1.05, 3); // ~5% per quarter
    expect((1 + quarterlyRate(0.2155)) ** 4).toBeCloseTo(1.2155, 10);
  });

  const flat = [1, 1, 1, 1] as [number, number, number, number];
  const p = (latest: string, target: string, extra = {}) =>
    projectMarket({ latestRevenue: 100, latestQuarter: parseQuarter(latest), targetQuarter: parseQuarter(target), annualGrowth: 0.1, seasonality: flat, cyclical: 1, ...extra });

  it("compounds every elapsed quarter, across a year boundary", () => {
    expect(p("2025Q4", "2026Q1")).toBeCloseTo(100 * 1.1 ** 0.25, 9);
    expect(p("2025Q4", "2026Q2")).toBeCloseTo(100 * 1.1 ** 0.5, 9); // not one step
    expect(p("2025Q3", "2026Q3")).toBeCloseTo(110, 9); // four quarters == one full year
    expect(p("2024Q4", "2026Q2")).toBeCloseTo(100 * 1.1 ** 1.5, 9);
  });

  it("rejects a target that is not after the observation", () => {
    expect(() => p("2026Q2", "2026Q2")).toThrow();
  });

  it("deseasonalises the observation and reseasonalises the target, then applies the cyclical multiplier", () => {
    const seasonality: [number, number, number, number] = [0.9, 1.0, 1.1, 1.0];
    const got = p("2025Q4", "2026Q1", { seasonality, annualGrowth: 0, cyclical: 0.95 });
    expect(got).toBeCloseTo((100 / 1.0) * 0.9 * 0.95, 9);
    const got2 = p("2025Q3", "2026Q1", { seasonality, annualGrowth: 0 });
    expect(got2).toBeCloseTo((100 / 1.1) * 0.9, 9);
  });
});

describe("scenario model (fixture: market 1e9 USD, share 10%, fx 1000, margin 20%)", () => {
  it("fixture is valid for the analysis date", () => {
    expect([...validateStatic(makeDataset()), ...validateAsOf(makeDataset(), AS_OF)]).toEqual([]);
  });

  it("computes market -> share -> revenue -> profit -> EPS -> target price", () => {
    const b = base();
    const market = 1e9 * 1.1 ** 0.25; // one quarter: 2025Q4 -> 2026Q1
    const productRevenue = market * 0.1 * 1000;
    expect(b.products[0].marketRevenue).toBeCloseTo(market, 3);
    expect(b.products[0].revenueShare).toBeCloseTo(0.1, 12);
    expect(b.products[0].attributableRevenueKRW).toBeCloseTo(productRevenue, 0);
    // residual: 1.25e11 total - 1e11 covered = 2.5e10, 0% growth, 10% margin
    expect(b.residual.revenueKRW).toBeCloseTo(2.5e10, 0);
    const op = productRevenue * 0.2 + 2.5e10 * 0.1;
    expect(b.totals.operatingProfitKRW).toBeCloseTo(op, 0);
    expect(b.totals.commonEarningsKRW).toBeCloseTo(op * 0.8, 0);
    if (b.valuation.status !== "available") throw new Error("expected valuation");
    expect(b.valuation.quarterlyEpsKRW).toBeCloseTo((op * 0.8) / 1e7, 6);
    expect(b.valuation.annualizedEpsKRW).toBeCloseTo(((op * 0.8) / 1e7) * 4, 6);
    expect(b.valuation.targetPriceKRW).toBeCloseTo(((op * 0.8) / 1e7) * 4 * 10, 4);
    expect(b.valuation.upsidePct).toBeCloseTo((b.valuation.targetPriceKRW / 50_000 - 1) * 100, 6);
  });

  it("orders bear <= base <= bull", () => {
    const a = analyze(makeDataset(), AS_OF).scenarios.map((s) => (s.valuation.status === "available" ? s.valuation.targetPriceKRW : NaN));
    expect(a[0]).toBeLessThan(a[1]);
    expect(a[1]).toBeLessThan(a[2]);
  });

  it("bounds the revenue share by shareBounds", () => {
    const ds = makeDataset();
    ds.products[0].shareDelta.value = { bear: -0.2, base: 0.2, bull: 0.2 };
    const s = analyze(ds, AS_OF).scenarios;
    expect(s[0].products[0].revenueShare).toBeCloseTo(0.05, 12); // 0.1 - 0.2 -> clamped to min
    expect(s[1].products[0].revenueShare).toBeCloseTo(0.2, 12); // 0.1 + 0.2 -> clamped to max
  });

  it("normalises foreign-currency revenue to KRW with the explicit fx rate", () => {
    const ds = makeDataset();
    ds.fx[0].krwPerUnit = 1500;
    ds.financials.totalRevenueKRW = 1.875e11; // keep 20% residual at the new rate
    expect(base(ds).products[0].attributableRevenueKRW).toBeCloseTo(1.5 * base().products[0].attributableRevenueKRW, 0);
    expect(base(ds).products[0].fxKrwPerUnit).toBe(1500);
  });

  it("reports coverage and uses the residual segment", () => {
    const a = analyze(makeDataset(), AS_OF);
    expect(a.dataQuality.coverage.ratio).toBeCloseTo(0.8, 12);
    expect(a.dataQuality.coverage.residualKRW).toBeCloseTo(2.5e10, 0);
    expect(a.dataQuality.warnings.some((w) => w.includes("80.0%"))).toBe(true);
  });

  it("compounds the residual across elapsed quarters", () => {
    const ds = makeDataset();
    ds.residual!.value.annualGrowth = { bear: 0, base: 0.1, bull: 0.1 };
    expect(base(ds).residual.revenueKRW).toBeCloseTo(2.5e10 * 1.1 ** 0.25, 0);
  });

  it("subtracts net interest, tax (none on losses), noncontrolling interest and preferred dividends", () => {
    const ds = makeDataset();
    ds.earningsBridge.value = { netInterestKRW: -1e9, effectiveTaxRate: 0.25, noncontrollingShare: 0.1, preferredClaimsKRW: 5e8 };
    const b = base(ds);
    const pretax = b.totals.operatingProfitKRW - 1e9;
    expect(b.totals.taxKRW).toBeCloseTo(pretax * 0.25, 0);
    const net = pretax * 0.75;
    expect(b.totals.noncontrollingKRW).toBeCloseTo(net * 0.1, 0);
    expect(b.totals.commonEarningsKRW).toBeCloseTo(net * 0.9 - 5e8, 0);
  });

  it("returns valuation unavailable (not a negative price) when common earnings are not positive", () => {
    const ds = makeDataset();
    ds.products[0].operatingMargin.value = { bear: -0.3, base: 0.2, bull: 0.3 };
    ds.residual!.value.operatingMargin = { bear: -0.3, base: 0.1, bull: 0.1 };
    const [bear, baseS] = analyze(ds, AS_OF).scenarios;
    expect(bear.totals.commonEarningsKRW).toBeLessThan(0);
    expect(bear.valuation.status).toBe("unavailable");
    expect(baseS.valuation.status).toBe("available");
  });

  it("treats preferred claims (dividends + participation) as a deduction that can push common earnings below zero", () => {
    const ds = makeDataset();
    ds.earningsBridge.value.preferredClaimsKRW = 1e12;
    expect(base(ds).valuation.status).toBe("unavailable");
  });

  it("labels the valuation as a proxy and lists limitations, provenance and model version", () => {
    const a = analyze(makeDataset(), AS_OF);
    expect(a.modelVersion).toMatch(/^kospi-product-market\//);
    expect(a.limitations[0]).toContain("NOT a forecast");
    expect(a.provenance.length).toBeGreaterThan(5);
    expect(JSON.stringify(a)).not.toMatch(/probabilit(y|ies)":/);
  });
});
