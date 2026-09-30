import { describe, expect, it } from "vitest";
import { replay, ReplayInputSchema, type PriceSeries } from "../../src/strategy/replay.js";
import { screen } from "../../src/strategy/screen.js";
import { CandidateInputSchema } from "../../src/strategy/schema.js";
import { DECISION_AT, TEST_CONFIG, makeCandidateWithTicker, makeEligibleCandidate } from "./fixture.js";

const SRC = { title: "test prices", manualReference: "test-fixture", kind: "market_data_vendor" as const, knownAt: "2026-01-16T09:00:00+09:00" };
const series = (label: PriceSeries["label"], prices: { open: number | null; close: number | null }[]): PriceSeries => ({ label, provider: "test", adjustmentBasis: "total_return", source: SRC, prices });

// 3-session calendar matching TEST_CONFIG.holdSessions=3, entry the day after DECISION_AT (2026-01-15).
const SESSIONS = [
  { openAt: "2026-01-16T09:00:00+09:00", closeAt: "2026-01-16T15:30:00+09:00" },
  { openAt: "2026-01-19T09:00:00+09:00", closeAt: "2026-01-19T15:30:00+09:00" },
  { openAt: "2026-01-20T09:00:00+09:00", closeAt: "2026-01-20T15:30:00+09:00" },
];

function selection() {
  return screen([CandidateInputSchema.parse(makeEligibleCandidate())], TEST_CONFIG, DECISION_AT);
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    decisionAt: DECISION_AT,
    calendar: { provider: "test-exchange", adjustmentBasis: "total_return" as const, sessions: SESSIONS },
    marketBenchmark: series("MARKET_BENCHMARK", [{ open: 1000, close: 1010 }, { open: 1010, close: 1005 }, { open: 1005, close: 1020 }]),
    sectorBenchmark: series("SECTOR_BENCHMARK", [{ open: 500, close: 505 }, { open: 505, close: 502 }, { open: 502, close: 510 }]),
    tickerPrices: [series("999990", [{ open: 100, close: 110 }, { open: 110, close: 90 }, { open: 90, close: 121 }])],
    ...overrides,
  };
}

describe("replay: hand-computed entry/exit costs", () => {
  it("applies fee+slippage on entry and fee+slippage+tax on exit exactly as specified", () => {
    const result = replay(ReplayInputSchema.parse(baseInput()), selection(), TEST_CONFIG);
    if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);
    const pos = result.positions[0]!;
    // config: feeBpsPerSide=10 (0.001), slippageBpsPerSide=20 (0.002), sellTaxBps=18 (0.0018)
    const expectedEntryCost = 100 * (1 + 0.002) * (1 + 0.001); // 100.2 * 1.001 = 100.3002
    expect(pos.effectiveEntryCostKRW).toBeCloseTo(expectedEntryCost, 9);
    const budget = TEST_CONFIG.initialCapitalKRW * TEST_CONFIG.maxWeightPerHolding; // 200,000
    expect(pos.budgetKRW).toBe(budget);
    expect(pos.units).toBeCloseTo(budget / expectedEntryCost, 9);
    // exit close is session[2].close = 121
    const expectedExitProceedsPerUnit = 121 * (1 - 0.002) * (1 - 0.001 - 0.0018);
    expect(pos.exitProceedsPerUnitKRW).toBeCloseTo(expectedExitProceedsPerUnit, 9);
    const expectedFinalEquity = (TEST_CONFIG.initialCapitalKRW - budget) + pos.units * expectedExitProceedsPerUnit;
    expect(result.finalEquityKRW).toBeCloseTo(expectedFinalEquity, 6);
    expect(result.netReturnPct).toBeCloseTo((expectedFinalEquity / TEST_CONFIG.initialCapitalKRW - 1) * 100, 9);
    // gross ignores fee/slippage/tax entirely: units_gross = budget/100, proceeds_gross = units_gross*121
    const grossFinal = (TEST_CONFIG.initialCapitalKRW - budget) + (budget / 100) * 121;
    expect(result.grossReturnPct).toBeCloseTo((grossFinal / TEST_CONFIG.initialCapitalKRW - 1) * 100, 9);
    expect(result.netReturnPct).toBeLessThan(result.grossReturnPct); // costs always drag net below gross here
  });

  it("shows an intra-hold drawdown despite a final recovery to a new high", () => {
    // price path 100 -> 110 (session0 close) -> 90 (session1 close, a dip) -> 121 (session2 close, new high)
    const result = replay(ReplayInputSchema.parse(baseInput()), selection(), TEST_CONFIG);
    if (result.status !== "completed") throw new Error("expected completed");
    // equity curve: [capital, mark@close0, mark@close1(dip), exit@close2(recovery, net of costs)]
    expect(result.equityCurve).toHaveLength(4);
    expect(result.equityCurve[2]!).toBeLessThan(result.equityCurve[1]!); // the dip
    expect(result.equityCurve[3]!).toBeGreaterThan(result.equityCurve[1]!); // recovers past the earlier high
    expect(result.maxDrawdownPct).toBeGreaterThan(0); // the dip is captured even though the run finishes up
  });

  it("negative returns when the exit price falls below the effective entry cost", () => {
    const input = baseInput({ tickerPrices: [series("999990", [{ open: 100, close: 95 }, { open: 95, close: 90 }, { open: 90, close: 80 }])] });
    const result = replay(ReplayInputSchema.parse(input), selection(), TEST_CONFIG);
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.netReturnPct).toBeLessThan(0);
    expect(result.grossReturnPct).toBeLessThan(0);
  });
});

describe("replay: cash, no-trade and budget limits", () => {
  it("no eligible candidates -> no_trade, full capital stays cash, benchmarks still compared", () => {
    const ineligible = { ...makeEligibleCandidate(), currentConsensus: { ...makeEligibleCandidate().currentConsensus, epsPerShare: 100 } };
    const sel = screen([CandidateInputSchema.parse(ineligible)], TEST_CONFIG, DECISION_AT);
    const result = replay(ReplayInputSchema.parse(baseInput()), sel, TEST_CONFIG);
    expect(result.status).toBe("no_trade");
    if (result.status !== "no_trade") throw new Error("unreachable");
    expect(result.finalEquityKRW).toBe(TEST_CONFIG.initialCapitalKRW);
    expect(result.netReturnPct).toBe(0);
    expect(result.marketReturnPct).toBeCloseTo((1020 / 1000 - 1) * 100, 9);
    expect(result.excessReturnVsMarketPct).toBeCloseTo(0 - result.marketReturnPct, 9);
  });

  it("fewer eligible names than maxHoldings leaves the remaining budget as idle, zero-return cash", () => {
    const result = replay(ReplayInputSchema.parse(baseInput()), selection(), { ...TEST_CONFIG, maxHoldings: 5 });
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.idleCashKRW).toBe(TEST_CONFIG.initialCapitalKRW * (1 - 0.2));
    expect(result.positions).toHaveLength(1);
  });
});

describe("replay: integrity guards", () => {
  it("incomplete price data for a selected ticker makes the whole result incomplete (never substitutes a runner-up)", () => {
    const input = baseInput({ tickerPrices: [series("999990", [{ open: 100, close: 110 }, { open: null, close: null }, { open: 90, close: 121 }])] });
    const result = replay(ReplayInputSchema.parse(input), selection(), TEST_CONFIG);
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("unreachable");
    expect(result.missing.some((m) => m.subject === "999990")).toBe(true);
  });

  it("a missing selected ticker's price series entirely (not just a hole) is also incomplete", () => {
    const input = baseInput({ tickerPrices: [] });
    const result = replay(ReplayInputSchema.parse(input), selection(), TEST_CONFIG);
    expect(result.status).toBe("incomplete");
  });

  it("incomplete benchmark data also makes the result incomplete", () => {
    const input = baseInput({ marketBenchmark: series("MARKET_BENCHMARK", [{ open: 1000, close: 1010 }, { open: null, close: null }, { open: 1005, close: 1020 }]) });
    const result = replay(ReplayInputSchema.parse(input), selection(), TEST_CONFIG);
    expect(result.status).toBe("incomplete");
  });

  it("rejects a calendar whose length does not match config.holdSessions", () => {
    // Truncate every series consistently (so the schema's own length cross-checks pass); only holdSessions vs the
    // calendar length itself should fail, inside replay()'s own guard.
    const input = baseInput({
      calendar: { provider: "test", adjustmentBasis: "total_return" as const, sessions: SESSIONS.slice(0, 2) },
      marketBenchmark: series("MARKET_BENCHMARK", [{ open: 1000, close: 1010 }, { open: 1010, close: 1005 }]),
      sectorBenchmark: series("SECTOR_BENCHMARK", [{ open: 500, close: 505 }, { open: 505, close: 502 }]),
      tickerPrices: [series("999990", [{ open: 100, close: 110 }, { open: 110, close: 90 }])],
    });
    const result = replay(ReplayInputSchema.parse(input), selection(), TEST_CONFIG);
    expect(result.status).toBe("incomplete");
  });

  it("rejects decisionAt at or after the first session's open (no same-close fills)", () => {
    const lateDecision = "2026-01-16T09:00:00+09:00"; // exactly session[0].openAt
    const sel = screen([CandidateInputSchema.parse(makeEligibleCandidate())], TEST_CONFIG, lateDecision);
    const input = baseInput({ decisionAt: lateDecision });
    const result = replay(ReplayInputSchema.parse(input), sel, TEST_CONFIG);
    expect(result.status).toBe("incomplete");
  });

  it("rejects a selection produced under a different config (configDigest mismatch)", () => {
    const otherConfigSelection = screen([CandidateInputSchema.parse(makeEligibleCandidate())], { ...TEST_CONFIG, gapThresholdPct: 0.05 }, DECISION_AT);
    const result = replay(ReplayInputSchema.parse(baseInput()), otherConfigSelection, TEST_CONFIG);
    expect(result.status).toBe("incomplete");
  });

  it("benchmark timing: returns are measured over the same entry-open-to-exit-close horizon as the strategy", () => {
    const result = replay(ReplayInputSchema.parse(baseInput()), selection(), TEST_CONFIG);
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.entryOpenAt).toBe(SESSIONS[0]!.openAt);
    expect(result.exitCloseAt).toBe(SESSIONS[2]!.closeAt);
    expect(result.marketReturnPct).toBeCloseTo((1020 / 1000 - 1) * 100, 9); // session[0].open -> session[2].close
    expect(result.sectorReturnPct).toBeCloseTo((510 / 500 - 1) * 100, 9);
  });

  it("the schema rejects duplicate ticker price series and non-chronological sessions", () => {
    expect(() => ReplayInputSchema.parse(baseInput({ tickerPrices: [series("999990", baseInput().tickerPrices[0]!.prices), series("999990", baseInput().tickerPrices[0]!.prices)] }))).toThrow();
    const badCalendar = { provider: "test", adjustmentBasis: "total_return" as const, sessions: [SESSIONS[1]!, SESSIONS[0]!, SESSIONS[2]!] };
    expect(() => ReplayInputSchema.parse(baseInput({ calendar: badCalendar }))).toThrow();
  });

  it("replays a mixed-sector selection whose combined weight exceeds the single-sector cap (per-sector, not global)", () => {
    const candidates = [
      makeCandidateWithTicker("400010", "tech"),
      makeCandidateWithTicker("400020", "bio"),
      makeCandidateWithTicker("400030", "finance"),
    ].map((c) => CandidateInputSchema.parse(c));
    const config = { ...TEST_CONFIG, maxHoldings: 3, maxWeightPerHolding: 1 };
    const sel = screen(candidates, config, DECISION_AT);
    expect(sel.selected).toHaveLength(3);
    expect(sel.portfolio.investedWeight).toBeCloseTo(1, 9); // 3 * 1/3 = 100%, each sector alone stays under the 60% cap
    const path = [{ open: 100, close: 110 }, { open: 110, close: 90 }, { open: 90, close: 121 }];
    const input = baseInput({ tickerPrices: [series("400010", path), series("400020", path), series("400030", path)] });
    const result = replay(ReplayInputSchema.parse(input), sel, config);
    if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);
    expect(result.positions).toHaveLength(3);
    expect(result.idleCashKRW).toBeCloseTo(0, 6);
  });
});
