import { describe, expect, it } from "vitest";
import { screen } from "../../src/strategy/screen.js";
import { CandidateInputSchema, EarningsForecastSnapshotSchema, STRATEGY_SOURCE_KINDS } from "../../src/strategy/schema.js";
import { DECISION_AT, HORIZON, TEST_CONFIG, makeCandidateWithTicker, makeCatalyst, makeConsensus, makeEligibleCandidate, makeForecast } from "./fixture.js";

const codesOf = (r: ReturnType<typeof screen>["evaluations"][number]) => (r.eligible ? [] : r.reasons.map((x) => x.code));

describe("screen: happy path", () => {
  it("accepts a candidate that clears every gate and ranks/selects it", () => {
    const result = screen([CandidateInputSchema.parse(makeEligibleCandidate())], TEST_CONFIG, DECISION_AT);
    expect(result.evaluations[0]!.eligible).toBe(true);
    const e = result.evaluations[0] as Extract<(typeof result.evaluations)[number], { eligible: true }>;
    expect(e.gapPct).toBeCloseTo(8 / 7 - 1, 9);
    expect(e.revisionPct).toBeCloseTo(7 / 6 - 1, 9);
    expect(e.rank).toBe(1);
    expect(e.selected).toBe(true);
    expect(result.selected).toEqual([{ ticker: "999990", rank: 1, weight: 0.2 }]);
    expect(result.noTrade).toBe(false);
    expect(result.unusedCapitalPct).toBeCloseTo(0.8, 9);
    expect(result.configDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("screen: exclusion reasons", () => {
  it("rejects a horizon mismatch between forecast and current consensus", () => {
    const c = makeEligibleCandidate();
    c.currentConsensus = makeConsensus({ horizonQuarters: ["2026Q1", "2026Q2", "2026Q3", "2026Q4"], epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" });
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(codesOf(result.evaluations[0]!)).toContain("HORIZON_MISMATCH");
  });

  it("rejects a rolling horizon change between prior and current consensus", () => {
    const c = makeEligibleCandidate();
    c.priorConsensus = makeConsensus({ horizonQuarters: ["2026Q1", "2026Q2", "2026Q3", "2026Q4"], epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" });
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(codesOf(result.evaluations[0]!)).toContain("ROLLING_HORIZON_CHANGED");
  });

  it("rejects a future consensus (knownAt after decisionAt)", () => {
    const c = makeEligibleCandidate();
    c.currentConsensus = makeConsensus({ epsPerShare: 7, knownAt: "2026-01-20T00:00:00+09:00" }); // after DECISION_AT
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(codesOf(result.evaluations[0]!)).toContain("CURRENT_CONSENSUS_FUTURE");
  });

  it("rejects a stale consensus (older than maxCurrentConsensusAgeDays)", () => {
    const c = makeEligibleCandidate();
    c.currentConsensus = makeConsensus({ epsPerShare: 7, knownAt: "2025-12-01T00:00:00+09:00" }); // 45 days before decision
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(codesOf(result.evaluations[0]!)).toContain("CURRENT_CONSENSUS_STALE");
  });

  it("rejects zero/no revision (current == prior)", () => {
    const c = makeEligibleCandidate();
    c.priorConsensus = makeConsensus({ epsPerShare: 7, knownAt: "2025-12-06T00:00:00+09:00" }); // equal to current
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(codesOf(result.evaluations[0]!)).toContain("NO_POSITIVE_REVISION");
  });

  it("accepts a user-selected technology stock despite legacy automotive config", () => {
    const c = makeEligibleCandidate();
    c.forecast = EarningsForecastSnapshotSchema.parse({ ...makeForecast(), sector: "technology" });
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(result.evaluations[0]!.eligible).toBe(true);
    expect(result.portfolio.sectorWeights).toEqual({ technology: 0.2 });
  });

  it("rejects nonpositive and near-zero consensus EPS with explicit equality boundaries", () => {
    const zero = makeEligibleCandidate();
    zero.currentConsensus = makeConsensus({ epsPerShare: 0, knownAt: "2026-01-05T00:00:00+09:00" });
    expect(codesOf(screen([CandidateInputSchema.parse(zero)], TEST_CONFIG, DECISION_AT).evaluations[0]!)).toContain("NONPOSITIVE_CURRENT_CONSENSUS_EPS");

    const negative = makeEligibleCandidate();
    negative.currentConsensus = makeConsensus({ epsPerShare: -5, knownAt: "2026-01-05T00:00:00+09:00" });
    expect(codesOf(screen([CandidateInputSchema.parse(negative)], TEST_CONFIG, DECISION_AT).evaluations[0]!)).toContain("NONPOSITIVE_CURRENT_CONSENSUS_EPS");

    // exactly at the minConsensusEpsKRW floor (1) is usable; below it is not
    const atFloor = makeEligibleCandidate();
    atFloor.currentConsensus = makeConsensus({ epsPerShare: 1, knownAt: "2026-01-05T00:00:00+09:00" });
    const atFloorReasons = codesOf(screen([CandidateInputSchema.parse(atFloor)], TEST_CONFIG, DECISION_AT).evaluations[0]!);
    expect(atFloorReasons).not.toContain("NEAR_ZERO_CURRENT_CONSENSUS_EPS");
    expect(atFloorReasons).not.toContain("NONPOSITIVE_CURRENT_CONSENSUS_EPS");

    const belowFloor = makeEligibleCandidate();
    belowFloor.currentConsensus = makeConsensus({ epsPerShare: 0.5, knownAt: "2026-01-05T00:00:00+09:00" });
    expect(codesOf(screen([CandidateInputSchema.parse(belowFloor)], TEST_CONFIG, DECISION_AT).evaluations[0]!)).toContain("NEAR_ZERO_CURRENT_CONSENSUS_EPS");
  });

  it("rejects a catalyst that is not strictly in the future, or outside the day-ahead window", () => {
    const past = makeEligibleCandidate();
    past.catalyst = makeCatalyst({ eventAt: DECISION_AT }); // same instant as decision, not strictly after
    expect(codesOf(screen([CandidateInputSchema.parse(past)], TEST_CONFIG, DECISION_AT).evaluations[0]!)).toContain("CATALYST_NOT_FUTURE");

    const tooFar = makeEligibleCandidate();
    tooFar.catalyst = makeCatalyst({ eventAt: "2026-04-01T06:00:00+09:00" }); // ~76 days ahead, config max is 60
    expect(codesOf(screen([CandidateInputSchema.parse(tooFar)], TEST_CONFIG, DECISION_AT).evaluations[0]!)).toContain("CATALYST_WINDOW_VIOLATION");
  });

  it("schema rejects an LLM-model-knowledge source outright (never eligible for a strategy decision)", () => {
    expect(STRATEGY_SOURCE_KINDS as readonly string[]).not.toContain("model_knowledge");
    const bad = { title: "x", manualReference: "y", kind: "model_knowledge", knownAt: "2026-01-01T00:00:00+09:00" };
    const c = { ...makeEligibleCandidate() };
    c.forecast = { ...c.forecast, quarters: c.forecast.quarters.map((q) => ({ ...q, segments: [{ ...q.segments[0]!, source: bad as never }] })) };
    expect(() => CandidateInputSchema.parse(c)).toThrow();
  });

  it("gap/revision equality boundaries are explicit (>= threshold passes, > 0 revision required)", () => {
    // gap exactly at threshold (10%): NTM 8 vs consensus 8/1.1 ~= 7.2727... use an exact consensus so gap == 0.10 exactly
    const exact = makeEligibleCandidate();
    exact.currentConsensus = makeConsensus({ epsPerShare: 8 / 1.1, knownAt: "2026-01-05T00:00:00+09:00" });
    exact.priorConsensus = makeConsensus({ epsPerShare: 8 / 1.1 - 0.01, knownAt: "2025-12-06T00:00:00+09:00" });
    const exactReasons = codesOf(screen([CandidateInputSchema.parse(exact)], TEST_CONFIG, DECISION_AT).evaluations[0]!);
    expect(exactReasons).not.toContain("GAP_BELOW_THRESHOLD");
  });
});

describe("screen: ranking and position limits", () => {
  it("ranks by gap descending, ties broken by ticker ascending, and caps selection at maxHoldings", () => {
    const mk = (ticker: string, gapEps: number) => {
      const c = makeEligibleCandidate();
      c.ticker = ticker;
      c.forecast = { ...c.forecast, ticker };
      c.currentConsensus = { ...c.currentConsensus, ticker, epsPerShare: gapEps };
      c.priorConsensus = { ...c.priorConsensus, ticker };
      c.catalyst = { ...c.catalyst, ticker };
      return CandidateInputSchema.parse(c);
    };
    // NTM EPS is fixed at 8 for all; lower consensus => bigger gap. All six stay >= the 10% threshold (8/7.2-1 = 11.1%).
    // 100000/200000 tie on gap (same consensus 6.5) -> ticker ascending breaks the tie.
    const candidates = [mk("300000", 6.9), mk("100000", 6.5), mk("200000", 6.5), mk("400000", 7.0), mk("500000", 7.1), mk("600000", 7.2)];
    const config = { ...TEST_CONFIG, maxHoldings: 3 };
    const result = screen(candidates, config, DECISION_AT);
    const eligible = result.evaluations.filter((e) => e.eligible) as Extract<(typeof result.evaluations)[number], { eligible: true }>[];
    expect(eligible).toHaveLength(6); // every gap is >= 10%, none excluded
    const order = [...eligible].sort((a, b) => a.rank! - b.rank!).map((e) => e.ticker);
    expect(order).toEqual(["100000", "200000", "300000", "400000", "500000", "600000"]);
    expect(result.selected.map((s) => s.ticker)).toEqual(["100000", "200000", "300000"]);
    expect(result.unusedCapitalPct).toBeCloseTo(1 - 3 * 0.2, 9);
  });

  it("fewer eligible names than maxHoldings leaves the rest as idle cash (no redistribution)", () => {
    const result = screen([CandidateInputSchema.parse(makeEligibleCandidate())], { ...TEST_CONFIG, maxHoldings: 5 }, DECISION_AT);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]!.weight).toBe(0.2); // not redistributed to fill 100%
    expect(result.unusedCapitalPct).toBeCloseTo(0.8, 9);
  });

  it("no eligible candidates produces an explicit no-trade result", () => {
    const c = makeEligibleCandidate();
    c.currentConsensus = makeConsensus({ epsPerShare: 100, knownAt: "2026-01-05T00:00:00+09:00" }); // gap deeply negative
    const result = screen([CandidateInputSchema.parse(c)], TEST_CONFIG, DECISION_AT);
    expect(result.noTrade).toBe(true);
    expect(result.selected).toEqual([]);
    expect(result.unusedCapitalPct).toBe(1);
  });
});

describe("screen: sector caps apply per user-declared sector, not one blended limit", () => {
  it("mixed-sector selections can invest well above the 60% same-sector cap, but never above 100%", () => {
    const candidates = [
      makeCandidateWithTicker("100010", "tech"),
      makeCandidateWithTicker("100020", "tech"),
      makeCandidateWithTicker("100030", "bio"),
      makeCandidateWithTicker("100040", "bio"),
    ].map((c) => CandidateInputSchema.parse(c));
    const config = { ...TEST_CONFIG, maxHoldings: 4, maxWeightPerHolding: 0.3 };
    const result = screen(candidates, config, DECISION_AT);
    expect(result.selected).toHaveLength(4);
    for (const s of result.selected) expect(s.weight).toBeCloseTo(0.25, 9); // min(0.3, 1/4) each; 2-per-sector cap (0.6/2=0.3) doesn't bind
    expect(result.portfolio.investedWeight).toBeCloseTo(1, 9); // 100%, well above the 60% single-sector cap
    expect(result.portfolio.sectorWeights).toEqual({ tech: 0.5, bio: 0.5 });
    expect(result.portfolio.largestSectorWeight).toBeCloseTo(0.5, 9);
  });

  it("same-sector selections are capped at maxSectorWeight even when maxWeightPerHolding is looser", () => {
    const candidates = [
      makeCandidateWithTicker("200010", "automotive"),
      makeCandidateWithTicker("200020", "automotive"),
      makeCandidateWithTicker("200030", "automotive"),
    ].map((c) => CandidateInputSchema.parse(c));
    const config = { ...TEST_CONFIG, maxHoldings: 3, maxWeightPerHolding: 1 };
    const result = screen(candidates, config, DECISION_AT);
    expect(result.selected).toHaveLength(3);
    for (const s of result.selected) expect(s.weight).toBeCloseTo(0.2, 9); // 0.6 sector cap / 3 same-sector names
    expect(result.portfolio.investedWeight).toBeCloseTo(0.6, 9);
    expect(result.portfolio.sectorWeights).toEqual({ automotive: 0.6 });
  });

  it("liquidityLimited flags only the position actually reduced by observed traded value, not the one at the sector cap", () => {
    const a = makeCandidateWithTicker("300010", "automotive");
    const b = makeCandidateWithTicker("300020", "automotive");
    b.forecast = { ...b.forecast, liquidity: { ...b.forecast.liquidity!, averageDailyTradedValueKRW: 1_000_000 } };
    const candidates = [a, b].map((c) => CandidateInputSchema.parse(c));
    const config = { ...TEST_CONFIG, maxHoldings: 2, maxWeightPerHolding: 1 };
    const result = screen(candidates, config, DECISION_AT);
    const posA = result.portfolio.positions.find((p) => p.ticker === "300010")!;
    const posB = result.portfolio.positions.find((p) => p.ticker === "300020")!;
    expect(posA.liquidityLimited).toBe(false); // capped by the 0.6/2=0.3 sector limit, ample liquidity headroom
    expect(posB.liquidityLimited).toBe(true); // capped by thin observed traded value, below the sector limit
    expect(result.selected.find((s) => s.ticker === "300010")!.weight).toBeCloseTo(0.3, 9);
    expect(result.selected.find((s) => s.ticker === "300020")!.weight).toBeCloseTo(0.01, 9);
  });
});
