import { describe, expect, it } from "vitest";
import { computeForecastBridge } from "../../src/strategy/earnings.js";
import { EarningsForecastSnapshotSchema, type EarningsForecastSnapshot } from "../../src/strategy/schema.js";
import { makeForecast, HORIZON } from "./fixture.js";

const src = (title: string) => ({ title, manualReference: "test-fixture", kind: "manual_assumption" as const, knownAt: "2026-01-05T00:00:00+09:00" });

// Four genuinely different quarters (one a loss) so the sum cannot be mistaken for "last quarter x 4".
function fourDistinctQuarters(): EarningsForecastSnapshot {
  return makeForecast({
    quarters: [
      { quarter: HORIZON[0]!, coverageAttestation: { complete: true, statedBy: "t" }, netInterestKRW: -50, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100, segments: [{ name: "seg", volume: 10, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 100, source: src("q1") }] }, // EPS 2
      { quarter: HORIZON[1]!, coverageAttestation: { complete: true, statedBy: "t" }, netInterestKRW: -50, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100, segments: [{ name: "seg", volume: 5, unitPriceKRW: 100, variableCostPerUnitKRW: 90, fixedCostKRW: 1000, source: src("q2") }] }, // loss quarter
      { quarter: HORIZON[2]!, coverageAttestation: { complete: true, statedBy: "t" }, netInterestKRW: -50, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100, segments: [{ name: "seg", volume: 20, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 100, source: src("q3") }] }, // EPS 5.2
      { quarter: HORIZON[3]!, coverageAttestation: { complete: true, statedBy: "t" }, netInterestKRW: -50, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100, segments: [{ name: "seg", volume: 8, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 50, source: src("q4") }] }, // EPS 1.76
    ],
  });
}

describe("computeForecastBridge", () => {
  it("sums four distinct quarterly EPS values, not last-quarter times four", () => {
    const snapshot = EarningsForecastSnapshotSchema.parse(fourDistinctQuarters());
    const bridge = computeForecastBridge(snapshot);
    expect(bridge.quarters.map((q) => Number(q.epsKRW.toFixed(4)))).toEqual([2, -10, 5.2, 1.76]);
    expect(bridge.ntmEpsKRW).toBeCloseTo(-1.04, 6); // 2 - 10 + 5.2 + 1.76
    expect(bridge.ntmEpsKRW).not.toBeCloseTo(bridge.quarters.at(-1)!.epsKRW * 4, 1); // rules out the quarter*4 fallacy
  });

  it("applies no tax credit on a pretax loss (conservative)", () => {
    const bridge = computeForecastBridge(EarningsForecastSnapshotSchema.parse(fourDistinctQuarters()));
    const lossQuarter = bridge.quarters[1]!;
    expect(lossQuarter.pretaxKRW).toBe(-1000); // 5*(100-90) - 1000 - 50 interest
    expect(lossQuarter.taxKRW).toBe(0);
    expect(lossQuarter.netIncomeKRW).toBe(-1000);
    expect(lossQuarter.commonEarningsKRW).toBe(-1000);
    expect(lossQuarter.epsKRW).toBe(-10);
  });

  it("computes diluted per-quarter EPS and per-segment break-even volume", () => {
    const bridge = computeForecastBridge(EarningsForecastSnapshotSchema.parse(fourDistinctQuarters()));
    // segment 1: fixedCost 100 / contribution (100-60)=40 -> breakeven 2.5 units
    expect(bridge.quarters[0]!.segments[0]!.breakEvenVolume).toBeCloseTo(2.5, 9);
    // loss-quarter segment: fixedCost 1000 / contribution (100-90)=10 -> breakeven 100 units (far above actual volume 5)
    expect(bridge.quarters[1]!.segments[0]!.breakEvenVolume).toBeCloseTo(100, 9);
  });

  it("reports null break-even when contribution margin is zero or negative (never breaks even)", () => {
    const snapshot = makeForecast({
      quarters: HORIZON.map((q) => ({ quarter: q, coverageAttestation: { complete: true, statedBy: "t" }, netInterestKRW: 0, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100, segments: [{ name: "seg", volume: 10, unitPriceKRW: 100, variableCostPerUnitKRW: 100, fixedCostKRW: 50, source: src(q) }] })),
    });
    const bridge = computeForecastBridge(EarningsForecastSnapshotSchema.parse(snapshot));
    expect(bridge.quarters[0]!.segments[0]!.breakEvenVolume).toBeNull();
  });

  it("sensitivity perturbations move EPS in the expected direction and are additive across quarters", () => {
    const bridge = computeForecastBridge(EarningsForecastSnapshotSchema.parse(makeForecast()));
    // base: EPS 2/quarter, NTM 8. Price +1% -> unitPrice 101, revenue +10/quarter*(1-tax*(1-nc))... just check direction & magnitude bounds.
    expect(bridge.sensitivity.priceUp1Pct.deltaEpsKRW).toBeGreaterThan(0);
    expect(bridge.sensitivity.volumeUp1Pct.deltaEpsKRW).toBeGreaterThan(0);
    expect(bridge.sensitivity.variableCostUp1Pct.deltaEpsKRW).toBeLessThan(0);
    // hand check price+1%: revenue +1000*0.01=10/quarter, OP +10, pretax +10, tax +10*0.2=2, netIncome +8, EPS +0.08/quarter -> NTM +0.32
    expect(bridge.sensitivity.priceUp1Pct.deltaEpsKRW).toBeCloseTo(0.32, 6);
  });
});
