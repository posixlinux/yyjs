import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CandidateInputSchema } from "../../src/strategy/schema.js";
import { StrategyConfigSchema } from "../../src/strategy/config.js";
import { screen } from "../../src/strategy/screen.js";
import { replay, ReplayInputSchema } from "../../src/strategy/replay.js";

// Proves the bundled runnable example (examples/strategy/*.json, documented in README.md) actually executes and
// produces the two-candidates / cash-left-over / costs / benchmark-comparison vertical slice the deliverable calls
// for. Numbers here were independently cross-checked by hand (see IMPLEMENTATION_REPORT.md); this test pins them so
// the example can't silently drift from the documentation.

const dir = path.join(process.cwd(), "examples/strategy");
const readJson = async (f: string) => JSON.parse(await readFile(path.join(dir, f), "utf8"));

describe("bundled synthetic example: two candidates, partial cash, costs, benchmarks", () => {
  it("funding-gap example excludes positive-EPS earnings opportunity because capex exhausts cash", async () => {
    const req = await readJson("screen-request-funding-gap.json");
    const result = screen(req.candidates, req.config, req.decisionAt);
    expect(result.noTrade).toBe(true);
    const e = result.evaluations[0]!;
    expect(e.risk!.base.fourQuarterEpsKRW).toBeGreaterThan(0);
    expect(e.risk!.base.peakAdditionalFundingRequiredKRW).toBeGreaterThan(0);
    if (e.eligible) throw new Error("funding gap must exclude");
    expect(e.reasons.map((r) => r.code)).toContain("BASE_FUNDING_GAP");
  });

  it("liquidity example caps the highest-ranked name at 5% and leaves 75% cash", async () => {
    const req = await readJson("screen-request-liquidity-limit.json");
    const selection = screen(req.candidates, req.config, req.decisionAt);
    expect(selection.selected[0]).toEqual({ ticker: "222220", rank: 1, weight: .05 });
    const r = replay(await readJson("replay-input.json"), selection, req.config);
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.idleCashKRW).toBe(75_000_000);
    expect(r.grossReturnPct).toBeCloseTo(2.6); // .2 * 8% + .05 * 20%; remainder cash
  });
  it("screens both candidates as eligible, ranks 222220 above 111110, and leaves 60% as idle cash", async () => {
    const req = await readJson("screen-request.json");
    const config = StrategyConfigSchema.parse(req.config);
    const candidates = req.candidates.map((c: unknown) => CandidateInputSchema.parse(c));
    const result = screen(candidates, config, req.decisionAt);

    expect(result.noTrade).toBe(false);
    expect(result.selected).toEqual([
      { ticker: "222220", rank: 1, weight: 0.2 },
      { ticker: "111110", rank: 2, weight: 0.2 },
    ]);
    expect(result.unusedCapitalPct).toBeCloseTo(0.6, 9);

    const byTicker = Object.fromEntries(result.evaluations.filter((e) => e.eligible).map((e) => [e.ticker, e]));
    expect(byTicker["111110"].gapPct).toBeCloseTo(0.1003, 3); // ~10.03% (just above the 10% threshold)
    expect(byTicker["222220"].gapPct).toBeCloseTo(0.2019, 3); // ~20.19%
    for (const e of Object.values(byTicker) as { evidenceMode: string }[]) expect(e.evidenceMode).toBe("synthetic");
  });

  it("replays the two-candidate selection with real costs and a benchmark comparison", async () => {
    const req = await readJson("screen-request.json");
    const config = StrategyConfigSchema.parse(req.config);
    const candidates = req.candidates.map((c: unknown) => CandidateInputSchema.parse(c));
    const selection = screen(candidates, config, req.decisionAt);

    const replayInput = ReplayInputSchema.parse(await readJson("replay-input.json"));
    const result = replay(replayInput, selection, config);
    if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);

    expect(result.idleCashKRW).toBe(60_000_000); // 60% of 100,000,000 initial capital
    expect(result.positions).toHaveLength(2);
    expect(result.costs.totalCostKRW).toBeGreaterThan(0);
    expect(result.netReturnPct).toBeLessThan(result.grossReturnPct); // costs always drag net below gross
    expect(result.grossReturnPct).toBeCloseTo(5.6, 6); // 0.2*8% (111110) + 0.2*20% (222220), idle cash contributes 0
    expect(result.marketReturnPct).toBeCloseTo(1.5, 6);
    expect(result.sectorReturnPct).toBeCloseTo(3.0, 6);
    expect(result.excessReturnVsMarketPct).toBeCloseTo(result.netReturnPct - 1.5, 6);
    expect(result.maxDrawdownPct).toBe(0); // the example's price paths are monotonic by construction
    expect(result.notes.join(" ")).toMatch(/no annualized Sharpe\/CAGR/i);
  });

  it("a separately screened ineligible-only candidate produces a genuine no-trade replay (cash + benchmark comparison)", async () => {
    const req = await readJson("screen-request-no-trade.json");
    const config = StrategyConfigSchema.parse(req.config);
    const candidates = req.candidates.map((c: unknown) => CandidateInputSchema.parse(c));
    const selection = screen(candidates, config, req.decisionAt);
    expect(selection.noTrade).toBe(true);
    expect(selection.evaluations[0]!.eligible).toBe(false);

    const replayInput = ReplayInputSchema.parse(await readJson("replay-input.json"));
    const result = replay(replayInput, selection, config);
    expect(result.status).toBe("no_trade");
    if (result.status !== "no_trade") throw new Error("unreachable");
    expect(result.finalEquityKRW).toBe(config.initialCapitalKRW);
    expect(result.netReturnPct).toBe(0);
    expect(result.marketReturnPct).toBeCloseTo(1.5, 6);
    expect(result.excessReturnVsMarketPct).toBeCloseTo(-1.5, 6); // cash lagged the benchmark
  });
});
