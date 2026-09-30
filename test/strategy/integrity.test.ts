import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { screen } from "../../src/strategy/screen.js";
import { replay, ReplayInputSchema } from "../../src/strategy/replay.js";
import { StrategyService } from "../../src/strategy/service.js";
import { isValidIsoDateTime } from "../../src/strategy/time.js";
import { DECISION_AT, TEST_CONFIG, makeEligibleCandidate, tmpDir } from "./fixture.js";

const req = () => ({ config: structuredClone(TEST_CONFIG), decisionAt: DECISION_AT, candidates: [makeEligibleCandidate()] });
const codes = (r: ReturnType<typeof screen>) => r.evaluations.flatMap((e) => e.eligible ? [] : e.reasons.map((r) => r.code));
const example = (name: string) => JSON.parse(readFileSync(`examples/strategy/${name}.json`, "utf8"));
async function service() {
  const dir = await tmpDir("integrity");
  return new StrategyService({ forecasts: `${dir}/f`, consensus: `${dir}/c`, catalysts: `${dir}/e` }, { now: () => new Date("2026-01-12T00:00:00+09:00") });
}

describe("point-in-time integrity", () => {
  it("rejects duplicate allocations before ranking", () => {
    const c = makeEligibleCandidate();
    expect(() => screen([c, c], TEST_CONFIG, DECISION_AT)).toThrow(/duplicate/i);
  });

  it("backdating the consensus envelope cannot hide a future source", () => {
    const r = req();
    r.candidates[0]!.currentConsensus.source.knownAt = "2030-01-01T00:00:00Z";
    expect(codes(screen(r.candidates, r.config, r.decisionAt))).toContain("SOURCE_TIME_MISMATCH");
  });

  it("matching consensus far in the future is not a next-four-quarter forecast", () => {
    const c = makeEligibleCandidate();
    const horizon = ["2030Q1", "2030Q2", "2030Q3", "2030Q4"];
    c.forecast.quarters.forEach((q, i) => { q.quarter = horizon[i]!; });
    c.forecast.funding!.quarters.forEach((q, i) => { q.quarter = horizon[i]!; });
    c.currentConsensus.horizonQuarters = horizon;
    c.priorConsensus.horizonQuarters = horizon;
    expect(codes(screen([c], TEST_CONFIG, DECISION_AT))).toContain("FORECAST_HORIZON_NOT_NEXT_FOUR");
  });

  it("quarter boundaries follow KST rather than the UTC date", () => {
    const c = makeEligibleCandidate(); // Q2 start allowed while decision in Q1; not after KST April 1
    const r = screen([c], TEST_CONFIG, "2026-03-31T16:00:00Z"); // April 1 01:00 KST
    expect(codes(r)).toContain("FORECAST_HORIZON_NOT_NEXT_FOUR");
  });

  it("invalid timestamps cannot bypass the availability checks with NaN", async () => {
    expect(isValidIsoDateTime("2026-02-30T00:00:00Z")).toBe(false);
    expect(isValidIsoDateTime("2026-13-01T00:00:00Z")).toBe(false);
    const s = await service();
    await expect(s.screen({ ...req(), decisionAt: "not-a-date" })).rejects.toThrow();
  });

  it("inline data cannot claim to be recorded forward evidence", async () => {
    const s = await service();
    const r = req();
    await expect(s.screen({ ...r, candidates: [{ ...r.candidates[0], evidenceMode: "forward" }] })).rejects.toMatchObject({ code: "EVIDENCE_MODE_MISMATCH" });
  });

  it("a forward forecast does not upgrade historical consensus to forward", async () => {
    const s = await service();
    const c = makeEligibleCandidate();
    const f = await s.record("forecast", { mode: "forward", payload: c.forecast });
    const current = await s.record("consensus", { mode: "historical_import_unverified", payload: c.currentConsensus,
      archiveSource: { title: "archive", manualReference: "test", kind: "archive", knownAt: DECISION_AT } });
    const prior = await s.record("consensus", { mode: "forward", payload: c.priorConsensus });
    const catalyst = await s.record("catalyst", { mode: "forward", payload: c.catalyst });
    const request = { ...req(), candidates: [{ ticker: c.ticker, evidenceMode: "forward", forecast: { recordId: f.id },
      currentConsensus: { recordId: current.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: catalyst.id } }] };
    await expect(s.screen(request)).rejects.toMatchObject({ code: "EVIDENCE_MODE_MISMATCH" });
    request.candidates[0]!.evidenceMode = "historical_import_unverified";
    const result = await s.screen(request);
    expect(result.experimentMode).toBe("retrospective_research");
    expect(result.inputSnapshots[0]!.recordRefs!.forecast!.id).toBe(f.id);
  });

  it("records cannot contain not-yet-generated forecasts", async () => {
    const s = await service();
    const c = makeEligibleCandidate();
    c.forecast.generatedAt = "2027-01-01T00:00:00Z";
    await expect(s.record("forecast", { mode: "forward", payload: c.forecast })).rejects.toMatchObject({ code: "RECORD_FROM_FUTURE" });
  });
});

describe("replay validity and provenance", () => {
  it("equivalent timezone representations work and changed outcomes never alter selection", () => {
    const r = example("screen-request");
    const selection = screen(r.candidates, r.config, r.decisionAt);
    const input = example("replay-input");
    input.decisionAt = new Date(r.decisionAt).toISOString();
    const before = replay(input, selection, r.config);
    input.tickerPrices[0].prices.at(-1).close *= .1;
    const after = replay(input, selection, r.config);
    expect(before.status).toBe("completed");
    expect(after.status).toBe("completed");
    expect(before.selection.selected).toEqual(after.selection.selected);
    expect(after.outcomeInputHash).not.toBe(before.outcomeInputHash);
    if (before.status === "completed" && after.status === "completed") expect(after.netReturnPct).toBeLessThan(before.netReturnPct);
  });

  it("missing selected outcomes preserve the winner and full config without substitution", () => {
    const r = example("screen-request");
    const selection = screen(r.candidates, r.config, r.decisionAt);
    const input = example("replay-input");
    input.tickerPrices = input.tickerPrices.filter((p: { label: string }) => p.label !== selection.selected[0]!.ticker);
    const result = replay(input, selection, r.config);
    expect(result.status).toBe("incomplete");
    expect(result.selection.selected).toEqual(selection.selected);
    expect(result.config).toEqual(r.config);
    expect(result.experimentMode).toBe("synthetic");
    expect(result).not.toHaveProperty("netReturnPct");
  });

  it("future real outcomes are not reported as realized returns; later data remains retrospective", () => {
    const r = example("screen-request");
    r.candidates.forEach((c: { evidenceMode: string }) => { c.evidenceMode = "historical_import_unverified"; });
    const selection = screen(r.candidates, r.config, r.decisionAt);
    const input = example("replay-input");
    const afterClose = new Date(Date.parse(input.calendar.sessions.at(-1).closeAt) + 3600_000);
    for (const p of [input.marketBenchmark, input.sectorBenchmark, ...input.tickerPrices]) p.source.knownAt = afterClose.toISOString();
    const before = replay(input, selection, r.config, new Date(r.decisionAt));
    expect(before.status).toBe("incomplete");
    const after = replay(input, selection, r.config, afterClose);
    expect(after.status).toBe("completed");
    expect(after.experimentMode).toBe("retrospective_research");
    input.realizedEps = [{ ticker: r.candidates[0].ticker, quarter: r.candidates[0].forecast.quarters[0].quarter,
      epsKRW: 100, scope: "consolidated", basis: "common_diluted", unit: "KRW_per_share", source: { ...input.marketBenchmark.source } }];
    // April price outcomes can be known, but Q2 realized EPS cannot have been published before Q2 ended.
    expect(replay(input, selection, r.config, afterClose).status).toBe("incomplete");
  });

  it("zero realized EPS produces an absolute error with no infinite percentage", () => {
    const r = example("screen-request");
    const selection = screen(r.candidates, r.config, r.decisionAt);
    const input = example("replay-input");
    input.realizedEps = r.candidates[0].forecast.quarters.map((q: { quarter: string }) => ({ ticker: r.candidates[0].ticker,
      quarter: q.quarter, epsKRW: 0, scope: "consolidated", basis: "common_diluted", unit: "KRW_per_share", source: input.marketBenchmark.source }));
    const result = replay(input, selection, r.config);
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.forecastAccuracy[0]).toMatchObject({ realizedNtmEpsKRW: 0, errorPct: null, reason: "REALIZED_EPS_NEAR_ZERO" });
    expect(result.forecastAccuracy[0]!.errorKRW).toBeGreaterThan(0);
    input.realizedEps.push(input.realizedEps[0]);
    expect(() => ReplayInputSchema.parse(input)).toThrow(/duplicate/);
  });
});
