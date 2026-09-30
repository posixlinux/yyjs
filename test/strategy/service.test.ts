import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { StrategyService } from "../../src/strategy/service.js";
import { DECISION_AT, TEST_CONFIG, makeCatalyst, makeConsensus, makeForecast, tmpDir } from "./fixture.js";

async function setup(now = () => new Date("2026-01-12T00:00:00+09:00")) {
  const base = await tmpDir("service");
  return new StrategyService({ forecasts: `${base}/forecasts`, consensus: `${base}/consensus`, catalysts: `${base}/catalysts` }, { now });
}

describe("StrategyService: journal-backed screening", () => {
  it("records forward snapshots and resolves them by id for screening", async () => {
    const svc = await setup();
    const f = await svc.record("forecast", { mode: "forward", payload: makeForecast() });
    const cur = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) });
    const prior = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) });
    const cat = await svc.record("catalyst", { mode: "forward", payload: makeCatalyst() });

    const result = await svc.screen({
      config: TEST_CONFIG,
      decisionAt: DECISION_AT,
      candidates: [{ ticker: "999990", evidenceMode: "forward", forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
    });
    expect(result.selected).toEqual([{ ticker: "999990", rank: 1, weight: 0.2 }]);
  });

  it("rejects using a forward record for a decision before it was recorded (lookahead guard)", async () => {
    const svc = await setup(); // server clock fixed at 2026-01-12
    const f = await svc.record("forecast", { mode: "forward", payload: makeForecast() });
    const cur = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) });
    const prior = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) });
    const cat = await svc.record("catalyst", { mode: "forward", payload: makeCatalyst() });

    // decisionAt is before the server's recordedAt (2026-01-12): using the forecast would be look-ahead.
    await expect(
      svc.screen({
        config: TEST_CONFIG,
        decisionAt: "2026-01-11T00:00:00+09:00",
        candidates: [{ ticker: "999990", evidenceMode: "forward", forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
      }),
    ).rejects.toMatchObject({ status: 422, code: "FORWARD_RECORD_NOT_YET_AVAILABLE" });
  });

  it("allows a forward record for a decision at or after its recordedAt (equality boundary)", async () => {
    const svc = await setup();
    const f = await svc.record("forecast", { mode: "forward", payload: makeForecast() });
    const cur = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) });
    const prior = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) });
    const cat = await svc.record("catalyst", { mode: "forward", payload: makeCatalyst() });
    const result = await svc.screen({
      config: TEST_CONFIG,
      decisionAt: "2026-01-12T00:00:00+09:00", // exactly recordedAt
      candidates: [{ ticker: "999990", evidenceMode: "forward", forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
    });
    expect(result.evaluations[0]!.eligible).toBe(true);
  });

  it("rejects a declared evidenceMode that contradicts the referenced forecast record's actual provenance", async () => {
    const svc = await setup();
    const f = await svc.record("forecast", {
      mode: "historical_import_unverified",
      payload: makeForecast(),
      archiveSource: { title: "archive", manualReference: "test", kind: "archive", knownAt: "2025-01-01T00:00:00+09:00" },
    });
    const cur = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) });
    const prior = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) });
    const cat = await svc.record("catalyst", { mode: "forward", payload: makeCatalyst() });
    await expect(
      svc.screen({
        config: TEST_CONFIG,
        decisionAt: DECISION_AT,
        candidates: [{ ticker: "999990", evidenceMode: "forward", forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
      }),
    ).rejects.toMatchObject({ status: 422, code: "EVIDENCE_MODE_MISMATCH" });
  });

  it("labels a synthetic historical import distinctly from a plain historical import", async () => {
    const svc = await setup();
    const f = await svc.record("forecast", {
      mode: "historical_import_unverified",
      payload: makeForecast(),
      archiveSource: { title: "archive", manualReference: "test", kind: "archive", knownAt: "2025-01-01T00:00:00+09:00" },
      synthetic: true,
    });
    const cur = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) });
    const prior = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) });
    const cat = await svc.record("catalyst", { mode: "forward", payload: makeCatalyst() });
    const result = await svc.screen({
      config: TEST_CONFIG,
      decisionAt: DECISION_AT,
      candidates: [{ ticker: "999990", evidenceMode: "synthetic", forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
    });
    const e = result.evaluations[0]!;
    expect(e.eligible && e.evidenceMode).toBe("synthetic");
  });

  it("cannot supply or backdate recordedAt: the field is rejected outright as unrecognized input", async () => {
    const svc = await setup(); // server clock fixed at 2026-01-12
    await expect(svc.record("forecast", { mode: "forward", payload: makeForecast(), recordedAt: "2000-01-01T00:00:00Z" } as never)).rejects.toThrow(/recordedAt/);
  });

  it("a historical_import_unverified record is never subject to the forward lookahead guard", async () => {
    const svc = await setup();
    const archiveSource = { title: "archive", manualReference: "test", kind: "archive" as const, knownAt: "2000-01-01T00:00:00Z" };
    const f = await svc.record("forecast", { mode: "historical_import_unverified", payload: makeForecast(), archiveSource });
    const cur = await svc.record("consensus", { mode: "historical_import_unverified", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }), archiveSource });
    const prior = await svc.record("consensus", { mode: "historical_import_unverified", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }), archiveSource });
    const cat = await svc.record("catalyst", { mode: "historical_import_unverified", payload: makeCatalyst(), archiveSource });
    // All four records were journaled (recordedAt) at the fixed server clock 2026-01-12, but decisionAt below is
    // long before that. A "forward" record would be rejected outright (FORWARD_RECORD_NOT_YET_AVAILABLE); a
    // historical import may legitimately be replayed at any decision date, so this must resolve without throwing
    // (it may still end up ineligible for unrelated, date-driven reasons -- that is not what this test checks).
    const result = await svc.screen({
      config: TEST_CONFIG,
      decisionAt: "2020-06-15T06:00:00+09:00",
      candidates: [{ ticker: "999990", evidenceMode: "historical_import_unverified", forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
    });
    expect(result.evaluations).toHaveLength(1);
  });

  it("404s for an unknown record id", async () => {
    const svc = await setup();
    await expect(svc.getRecord("forecast", "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(AppError);
  });

  it("screenAndReplay re-derives the selection instead of trusting a client-supplied one", async () => {
    let clock = "2026-01-12T00:00:00+09:00";
    const svc = await setup(() => new Date(clock));
    const f = await svc.record("forecast", { mode: "forward", payload: makeForecast() });
    const cur = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) });
    const prior = await svc.record("consensus", { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) });
    const cat = await svc.record("catalyst", { mode: "forward", payload: makeCatalyst() });
    const screenReq = {
      config: TEST_CONFIG,
      decisionAt: DECISION_AT,
      candidates: [{ ticker: "999990", evidenceMode: "forward" as const, forecast: { recordId: f.id }, currentConsensus: { recordId: cur.id }, priorConsensus: { recordId: prior.id }, catalyst: { recordId: cat.id } }],
    };
    const replayInput = {
      schemaVersion: 1 as const,
      decisionAt: DECISION_AT,
      calendar: { provider: "t", adjustmentBasis: "total_return" as const, sessions: [{ openAt: "2026-01-16T09:00:00+09:00", closeAt: "2026-01-16T15:30:00+09:00" }, { openAt: "2026-01-19T09:00:00+09:00", closeAt: "2026-01-19T15:30:00+09:00" }, { openAt: "2026-01-20T09:00:00+09:00", closeAt: "2026-01-20T15:30:00+09:00" }] },
      marketBenchmark: { label: "MARKET_BENCHMARK" as const, provider: "t", adjustmentBasis: "total_return" as const, source: { title: "t", manualReference: "t", kind: "market_data_vendor" as const, knownAt: "2026-01-20T16:00:00+09:00" }, prices: [{ open: 1000, close: 1010 }, { open: 1010, close: 1005 }, { open: 1005, close: 1020 }] },
      sectorBenchmark: { label: "SECTOR_BENCHMARK" as const, provider: "t", adjustmentBasis: "total_return" as const, source: { title: "t", manualReference: "t", kind: "market_data_vendor" as const, knownAt: "2026-01-20T16:00:00+09:00" }, prices: [{ open: 500, close: 505 }, { open: 505, close: 502 }, { open: 502, close: 510 }] },
      tickerPrices: [{ label: "999990" as const, provider: "t", adjustmentBasis: "total_return" as const, source: { title: "t", manualReference: "t", kind: "market_data_vendor" as const, knownAt: "2026-01-20T16:00:00+09:00" }, prices: [{ open: 100, close: 110 }, { open: 110, close: 90 }, { open: 90, close: 121 }] }],
    };
    clock = "2026-01-21T00:00:00+09:00";
    const { selection, result } = await svc.screenAndReplay(screenReq, replayInput);
    expect(selection.selected).toEqual([{ ticker: "999990", rank: 1, weight: 0.2 }]);
    expect(result.status).toBe("completed");
  });
});
