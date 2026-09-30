import type { QuarterlyConsensus } from "../collection/types.js";
import type { ForecastBridge } from "./earnings.js";

/** Descriptive comparison of the single-quarter estimate against the provider's figure for the SAME quarter. It is a
 * reference next to the estimate, never the estimate itself and never an eligibility input.
 * Public provider EPS has no declared diluted-share basis and is displayed without an EPS gap. */
export function compareQuarterlyConsensus(ticker: string, items: QuarterlyConsensus[], bridge: ForecastBridge | null, decisionAt: string) {
  const cutoff = Date.parse(decisionAt);
  return items.filter((c) => c.ticker === ticker && /^\d{4}Q[1-4]$/.test(c.quarter)
    && Number.isFinite(Date.parse(c.observedAt)) && Date.parse(c.observedAt) <= cutoff
    && cutoff - Date.parse(c.observedAt) <= 24 * 3600_000).map((consensus) => {
    const forecast = bridge?.quarters.find((q) => q.quarter === consensus.quarter);
    const difference = (estimate: number, market: number | null) => market === null ? null : ({
      forecastKRW: estimate, consensusKRW: market, differenceKRW: estimate - market,
      // Losses and zero denominators have a meaningful currency difference, not a misleading growth percentage.
      differencePct: market > 0 ? (estimate - market) / market * 100 : null,
    });
    return {
      consensus,
      status: forecast ? "same_quarter_reference" as const : "consensus_only" as const,
      revenue: forecast ? difference(forecast.revenueKRW, consensus.revenueKRW) : null,
      operatingProfit: forecast ? difference(forecast.operatingProfitKRW, consensus.operatingProfitKRW) : null,
      note: forecast
        ? "동일 분기 참고 비교입니다. 공급자의 연결/별도 기준이 명시되지 않아 엄밀한 동등 기준 비교나 전략 적합 판정에는 사용하지 않습니다."
        : "같은 분기의 자체 전망이 없어 컨센서스만 표시합니다. 다른 분기 전망을 대신 비교하지 않습니다.",
    };
  });
}

export type QuarterlyConsensusComparison = ReturnType<typeof compareQuarterlyConsensus>[number];
