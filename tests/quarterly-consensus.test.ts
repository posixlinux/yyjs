import { describe, expect, it } from "vitest";
import { compareQuarterlyConsensus } from "../src/strategy/quarterly-consensus.js";
import { computeForecastBridge } from "../src/strategy/earnings.js";
import { evaluateAutoStrategy } from "../src/strategy/auto.js";
import { DECISION_AT, makeSingleQuarterForecast } from "../test/strategy/fixture.js";
import type { QuarterlyConsensus } from "../src/collection/types.js";

const forecast = makeSingleQuarterForecast();
const bridge = computeForecastBridge(forecast);
const sample = (over: Partial<QuarterlyConsensus> = {}): QuarterlyConsensus => ({
  ticker: forecast.ticker, quarter: forecast.quarters[0].quarter, revenueKRW: 800, operatingProfitKRW: 200,
  netIncomeKRW: null, epsKRW: 2, scope: "provider_default", epsBasis: "unspecified", observedAt: DECISION_AT,
  sourceUrl: `https://m.stock.naver.com/api/stock/${forecast.ticker}/finance/quarter`, ...over,
});

describe("single-quarter estimate next to the provider consensus", () => {
  it("the estimate stands on its own; the same-quarter consensus is only a reference comparison", () => {
    const result = evaluateAutoStrategy({ ticker: forecast.ticker, mode: "live", decisionAt: DECISION_AT, forecast,
      currentConsensus: null, priorConsensus: null, catalyst: null, quarterlyConsensus: [sample()], unavailable: [],
      minimumCashBufferKRW: 0, cashBufferConfigured: true });
    const comparison = result.quarterlyConsensus[0];
    expect(comparison.status).toBe("same_quarter_reference");
    expect(comparison.revenue?.forecastKRW).toBe(bridge.quarters[0].revenueKRW);
    expect(comparison.revenue?.differenceKRW).toBe(bridge.quarters[0].revenueKRW - 800);
    expect(comparison).not.toHaveProperty("epsGapPct");
    expect(result.evaluation).toBeNull();
    expect(result.status).toBe("estimate_only");
    expect(comparison.note).toContain("연결/별도");
  });
  it("shows a standalone estimate even if no model forecast could be produced", () => {
    const [r] = compareQuarterlyConsensus(forecast.ticker, [sample()], null, DECISION_AT);
    expect(r.status).toBe("consensus_only");
    expect(r.consensus.epsKRW).toBe(2);
    expect(r.revenue).toBeNull();
  });
  it("does not compare a different quarter or multiply single-quarter EPS by four", () => {
    const [r] = compareQuarterlyConsensus(forecast.ticker, [sample({ quarter: "2025Q4" })], bridge, DECISION_AT);
    expect(r.status).toBe("consensus_only");
    expect(r.operatingProfit).toBeNull();
    expect(r.consensus.epsKRW).toBe(2);
  });
  it("does not compute percentage gaps against a loss or zero", () => {
    for (const operatingProfitKRW of [0, -100]) {
      const [r] = compareQuarterlyConsensus(forecast.ticker, [sample({ operatingProfitKRW })], bridge, DECISION_AT);
      expect(r.operatingProfit?.differencePct).toBeNull();
      expect(r.operatingProfit?.differenceKRW).toBe(bridge.quarters[0].operatingProfitKRW - operatingProfitKRW);
    }
  });
  it("excludes other tickers, future observations, stale snapshots and invalid quarters", () => {
    const inputs = [sample({ ticker: "000660" }), sample({ observedAt: "2099-01-01T00:00:00Z" }),
      sample({ observedAt: "2000-01-01T00:00:00Z" }), sample({ quarter: "2026Q5" })];
    expect(compareQuarterlyConsensus(forecast.ticker, inputs, bridge, DECISION_AT)).toEqual([]);
  });
});
