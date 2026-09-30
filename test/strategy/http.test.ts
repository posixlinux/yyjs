import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildApp } from "../../src/http/app.js";
import { LocalStore } from "../../src/providers/local.js";
import { ResearchService } from "../../src/research/service.js";
import { Service } from "../../src/service.js";
import { StrategyService } from "../../src/strategy/service.js";
import { DECISION_AT, TEST_CONFIG, makeCatalyst, makeConsensus, makeForecast, tmpDir } from "./fixture.js";

// buildApp's 5th argument (StrategyService) is optional and additive: this file only exercises that this backward-
// compatible wiring works end to end over real HTTP (via app.inject), not the pure strategy modules (covered
// elsewhere in test/strategy/).
async function setup(withStrategy = true) {
  const dataDir = await tmpDir("http");
  let clock = "2026-01-12T00:00:00+09:00";
  const config = { ...loadConfig({}), dataDir, demoDir: dataDir, logLevel: "silent", apiKey: "test-key", now: () => new Date(clock) };
  const service = new Service({ manual: new LocalStore(dataDir, false), demo: new LocalStore(dataDir, true) }, config);
  const research = new ResearchService(
    { collect: async () => { throw new Error("not used"); }, intelligence: async () => { throw new Error("not used"); }, now: config.now, secrets: config.secrets },
    config.jobs,
    (asOf) => service.resolveAsOf(asOf),
  );
  const base = await tmpDir("strategy-data");
  const strategy = withStrategy ? new StrategyService({ forecasts: `${base}/f`, consensus: `${base}/c`, catalysts: `${base}/k` }, { now: config.now }) : undefined;
  const app = buildApp(service, research, config, undefined, strategy);
  return { app, config, setClock: (at: string) => { clock = at; } };
}

const KEY = { "x-api-key": "test-key" };

describe("strategy HTTP routes: optional wiring", () => {
  it("is entirely absent (404) when no StrategyService is supplied to buildApp", async () => {
    const { app } = await setup(false);
    const res = await app.inject({ url: "/v1/strategy/config/defaults" });
    expect(res.statusCode).toBe(404);
    const res2 = await app.inject({ method: "POST", url: "/v1/strategy/screen", payload: {}, headers: KEY });
    expect(res2.statusCode).toBe(404);
  });

  it("existing routes/behavior are unaffected by the optional 5th argument", async () => {
    const { app } = await setup(false);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});

describe("strategy HTTP routes: authenticated CRUD + screen + replay", () => {
  it("serves config defaults without a key", async () => {
    const { app } = await setup();
    const res = await app.inject({ url: "/v1/strategy/config/defaults" });
    expect(res.statusCode).toBe(200);
    expect(res.json().hypothesisDefaults.gapThresholdPct).toBe(0.1);
  });

  it("requires x-api-key for every record/screen/replay route", async () => {
    const { app } = await setup();
    for (const req of [
      { method: "POST" as const, url: "/v1/strategy/records/forecasts", payload: {} },
      { method: "GET" as const, url: "/v1/strategy/records/forecasts" },
      { method: "POST" as const, url: "/v1/strategy/screen", payload: {} },
      { method: "POST" as const, url: "/v1/strategy/replay", payload: {} },
    ]) {
      const res = await app.inject(req);
      expect(res.statusCode, req.url).toBe(401);
    }
  });

  it("records a forecast, lists it, fetches it by id, then screens and replays end to end", async () => {
    const { app, setClock } = await setup();
    const recF = await app.inject({ method: "POST", url: "/v1/strategy/records/forecasts", payload: { mode: "forward", payload: makeForecast() }, headers: KEY });
    expect(recF.statusCode).toBe(201);
    const forecastId = recF.json().id;

    const recCur = await app.inject({ method: "POST", url: "/v1/strategy/records/consensus", payload: { mode: "forward", payload: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }) }, headers: KEY });
    const recPrior = await app.inject({ method: "POST", url: "/v1/strategy/records/consensus", payload: { mode: "forward", payload: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }) }, headers: KEY });
    const recCat = await app.inject({ method: "POST", url: "/v1/strategy/records/catalysts", payload: { mode: "forward", payload: makeCatalyst() }, headers: KEY });

    const list = await app.inject({ url: "/v1/strategy/records/forecasts", headers: KEY });
    expect(list.json().records.map((r: { id: string }) => r.id)).toContain(forecastId);
    const got = await app.inject({ url: `/v1/strategy/records/forecasts/${forecastId}`, headers: KEY });
    expect(got.statusCode).toBe(200);
    expect(got.json().payload.ticker).toBe("999990");

    const screenReq = {
      config: TEST_CONFIG,
      decisionAt: DECISION_AT,
      candidates: [{ ticker: "999990", evidenceMode: "forward", forecast: { recordId: forecastId }, currentConsensus: { recordId: recCur.json().id }, priorConsensus: { recordId: recPrior.json().id }, catalyst: { recordId: recCat.json().id } }],
    };
    const screenRes = await app.inject({ method: "POST", url: "/v1/strategy/screen", payload: screenReq, headers: KEY });
    expect(screenRes.statusCode, screenRes.body).toBe(200);
    expect(screenRes.json().selected).toEqual([{ ticker: "999990", rank: 1, weight: 0.2 }]);

    const replayInput = {
      schemaVersion: 1,
      decisionAt: DECISION_AT,
      calendar: { provider: "t", adjustmentBasis: "total_return", sessions: [{ openAt: "2026-01-16T09:00:00+09:00", closeAt: "2026-01-16T15:30:00+09:00" }, { openAt: "2026-01-19T09:00:00+09:00", closeAt: "2026-01-19T15:30:00+09:00" }, { openAt: "2026-01-20T09:00:00+09:00", closeAt: "2026-01-20T15:30:00+09:00" }] },
      marketBenchmark: { label: "MARKET_BENCHMARK", provider: "t", adjustmentBasis: "total_return", source: { title: "t", manualReference: "t", kind: "market_data_vendor", knownAt: "2026-01-20T16:00:00+09:00" }, prices: [{ open: 1000, close: 1010 }, { open: 1010, close: 1005 }, { open: 1005, close: 1020 }] },
      sectorBenchmark: { label: "SECTOR_BENCHMARK", provider: "t", adjustmentBasis: "total_return", source: { title: "t", manualReference: "t", kind: "market_data_vendor", knownAt: "2026-01-20T16:00:00+09:00" }, prices: [{ open: 500, close: 505 }, { open: 505, close: 502 }, { open: 502, close: 510 }] },
      tickerPrices: [{ label: "999990", provider: "t", adjustmentBasis: "total_return", source: { title: "t", manualReference: "t", kind: "market_data_vendor", knownAt: "2026-01-20T16:00:00+09:00" }, prices: [{ open: 100, close: 110 }, { open: 110, close: 90 }, { open: 90, close: 121 }] }],
    };
    setClock("2026-01-21T00:00:00+09:00");
    const replayRes = await app.inject({ method: "POST", url: "/v1/strategy/replay", payload: { screen: screenReq, replay: replayInput }, headers: KEY });
    expect(replayRes.statusCode, replayRes.body).toBe(200);
    expect(replayRes.json().result.status).toBe("completed");
  });

  it("404s for an unknown record id and returns structured validation errors for bad bodies", async () => {
    const { app } = await setup();
    const res = await app.inject({ url: "/v1/strategy/records/forecasts/00000000-0000-4000-8000-000000000000", headers: KEY });
    expect(res.statusCode).toBe(404);
    const bad = await app.inject({ method: "POST", url: "/v1/strategy/records/forecasts", payload: { mode: "not-a-mode", payload: {} }, headers: KEY });
    expect(bad.statusCode).toBe(400);
  });
});
