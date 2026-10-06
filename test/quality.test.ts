import { describe, expect, it } from "vitest";
import { analyze } from "../src/model/model.js";
import { consensusGapCheck, peBandCheck, qualityTier } from "../src/research/quality.js";
import { buildPredictionRecord, scorePrediction, summarizeScores } from "../src/research/predictions.js";
import { AS_OF, makeDataset } from "./fixture.js";

const per = (min: number, median: number, max: number) => ({ ttmEpsKRW: 4000, quarters: ["2025Q1", "2025Q2", "2025Q3", "2025Q4"], latestClose: { date: "2026-01-10", closeKRW: 50000 }, current: median, window: { from: "2025-06-01", to: "2026-01-10", sessions: 150, min, median, max }, sourceUrls: [] });

describe("valuation sanity checks", () => {
  const a = analyze(makeDataset(), AS_OF); // P/E bear 5, base 10, bull 15

  it("flags a base P/E outside the range the stock traded at", () => {
    expect(peBandCheck(a, per(8, 11, 14))).toBeNull();
    const w = peBandCheck(a, per(20, 25, 30))!;
    expect(w.code).toBe("PE_OUTSIDE_OBSERVED_RANGE");
    expect(w.message).toMatch(/base 10 is outside the observed 20~30/);
    expect(peBandCheck(a, null)).toBeNull();
  });

  it("flags a bear case above the observed maximum and a bull case below the minimum", () => {
    expect(peBandCheck(a, per(9, 10, 11))).toBeNull(); // a bull above / bear below the range is a legitimate scenario
    expect(peBandCheck(a, per(1, 3, 4))!.message).toMatch(/bear 5 is above the observed maximum 4/);
    expect(peBandCheck(a, per(16, 18, 20))!.message).toMatch(/bull 15 is below the observed minimum 16/);
  });

  it("warns when the base case is far from the consensus for the same quarter", () => {
    const base = a.scenarios.find((s) => s.scenario === "base")!.totals;
    const c = (rev: number, op: number) => [{ ticker: "111110", quarter: a.targetQuarter, revenueKRW: rev, operatingProfitKRW: op, netIncomeKRW: null, epsKRW: null, scope: "provider_default" as const, epsBasis: "unspecified" as const, observedAt: "2026-01-15T00:00:00Z", sourceUrl: "x" }];
    expect(consensusGapCheck(a, c(base.revenueKRW * 1.1, base.operatingProfitKRW * 0.9))).toBeNull();
    const w = consensusGapCheck(a, c(base.revenueKRW * 2, base.operatingProfitKRW))!;
    expect(w.code).toBe("CONSENSUS_GAP_LARGE");
    expect(w.message).toMatch(/revenue -50\.0%/);
    expect(consensusGapCheck(a, [])).toBeNull();
  });

  it("grades how far to trust a valuation", () => {
    expect(qualityTier({ grade: "verified", crossChecked: true, dataGrounding: "high", warnings: [] })).toEqual({ tier: "high", reasons: [] });
    expect(qualityTier({ grade: "verified", crossChecked: false, dataGrounding: "high", warnings: [] }).tier).toBe("medium");
    expect(qualityTier({ grade: "provisional", crossChecked: false, dataGrounding: "low", warnings: [] }).tier).toBe("low");
    expect(qualityTier({ grade: "verified", crossChecked: true, dataGrounding: "high", warnings: ["PE_OUTSIDE_OBSERVED_RANGE"] }).tier).toBe("low");
    expect(qualityTier({ grade: null, crossChecked: true, dataGrounding: null, warnings: [] }).tier).toBeNull();
  });
});

describe("prediction log scoring", () => {
  const a = analyze(makeDataset(), AS_OF);
  const strategyAuto = { status: "estimate_only", bridge: { quarters: [{ quarter: a.targetQuarter, epsKRW: 1000, revenueKRW: 1e11, operatingProfitKRW: 1e10 }] }, nextQuarterPrice: { fairPriceKRW: 60000 } } as never;
  const rec = buildPredictionRecord({ jobId: "j1", recordedAt: "2026-01-15T00:00:00Z", ticker: "111110", asOf: AS_OF, analysis: a, grade: "verified", strategyAuto, quarterlyConsensus: [{ quarter: a.targetQuarter, epsKRW: 1200, operatingProfitKRW: null, revenueKRW: null }], quality: null, warnings: [] })!;

  it("records the valuation, the one-quarter estimate and the consensus of the same quarter", () => {
    expect(rec.valuation!.targetQuarter).toBe(a.targetQuarter);
    expect(rec.valuation!.scenarios.map((s) => s.scenario)).toEqual(["bear", "base", "bull"]);
    expect(rec.quarterEstimate).toMatchObject({ quarter: a.targetQuarter, epsKRW: 1000, fairPriceKRW: 60000 });
    expect(rec.consensus).toEqual([{ quarter: a.targetQuarter, epsKRW: 1200, operatingProfitKRW: null, revenueKRW: null }]);
  });

  it("stays pending until the quarter is reported, then scores EPS and price direction", () => {
    expect(scorePrediction(rec, [], null)[0]!.status).toBe("pending");
    const base = rec.valuation!.scenarios.find((s) => s.scenario === "base")!;
    const actual = 1050;
    const [s] = scorePrediction(rec, [{ ticker: "111110", quarter: a.targetQuarter, epsKRW: actual, scope: "provider_default", epsBasis: "unspecified", observedAt: "x", sourceUrl: "x" }], { date: "2026-05-01", closeKRW: rec.quote!.priceKRW * 1.1 });
    expect(s!.status).toBe("scored");
    expect(s!.valuation!.errorPct).toBeCloseTo(((base.quarterlyEpsKRW! - actual) / actual) * 100, 6);
    expect(s!.quarterEstimate).toMatchObject({ epsKRW: 1000, consensusEpsKRW: 1200, beatConsensusError: true }); // |1000-1050| < |1200-1050|
    expect(s!.price!.directionHit).toBe(base.upsidePct! > 0);
    const sum = summarizeScores([s!]);
    expect(sum.quarterEstimate.moreAccurateThanConsensus).toEqual({ hits: 1, of: 1, rate: 1 });
  });
});
