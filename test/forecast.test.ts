import { describe, expect, it } from "vitest";
import { backtestStats, buildSamples, forecast, pValueAbove, walkForward, DEFAULT_OPTIONS } from "../src/forecast/engine.js";
import { alignLagged, context, features, FEATURE_NAMES } from "../src/forecast/features.js";
import { createHttp } from "../src/collection/http.js";
import { loadUsdKrw } from "../src/forecast/history.js";
import { parseBars, type Bar } from "../src/forecast/history.js";
import { fitLogistic, fitRidge, solveSpd } from "../src/forecast/model.js";

/** Deterministic PRNG (mulberry32) + Box-Muller, so the synthetic markets are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

const day = (i: number) => new Date(Date.UTC(2023, 0, 2) + i * 86_400_000).toISOString().slice(0, 10);

/** Daily log returns r_t = phi * r_{t-1} + sigma * e_t (phi = 0: a random walk). */
function market(n: number, phi: number, seed: number, sigma = 0.02): Bar[] {
  const g = rng(seed);
  let r = 0, c = 10_000;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    r = phi * r + sigma * g();
    const prev = c;
    c = c * Math.exp(r);
    bars.push({ date: day(i), open: prev, high: Math.max(prev, c) * 1.005, low: Math.min(prev, c) * 0.995, close: c, volume: 1e6 * (1 + 0.2 * Math.abs(g())) });
  }
  return bars;
}

describe("forecast model pieces", () => {
  it("solves a small SPD system", () => {
    const x = solveSpd([[4, 1], [1, 3]], [1, 2]);
    expect(x[0]).toBeCloseTo(1 / 11, 9);
    expect(x[1]).toBeCloseTo(7 / 11, 9);
  });

  it("recovers a separable logistic relation and a linear ridge relation", () => {
    const X = Array.from({ length: 400 }, (_, i) => [Math.sin(i), Math.cos(i * 1.7)]);
    const y = X.map((x) => (x[0]! > 0 ? 1 : 0));
    const m = fitLogistic(X, y, 1);
    expect(m.w[0]).toBeGreaterThan(3);
    const r = fitRidge(X, X.map((x) => 2 * x[0]! - x[1]! + 0.5), 1e-6);
    expect(r.w[0]).toBeCloseTo(2, 4);
    expect(r.w[1]).toBeCloseTo(-1, 4);
    expect(r.b).toBeCloseTo(0.5, 4);
  });

  it("p-value of the binomial test behaves", () => {
    expect(pValueAbove(50, 100, 0.5)).toBeCloseTo(0.5, 2);
    expect(pValueAbove(70, 100, 0.5)).toBeLessThan(0.001);
  });

  it("parses Naver price rows into ascending OHLCV bars", () => {
    const bars = parseBars([
      { localTradedAt: "2026-10-02", closePrice: "71,200", openPrice: "70,000", highPrice: "72,000", lowPrice: "69,900", accumulatedTradingVolume: "12,345" },
      { localTradedAt: "2026-10-01", closePrice: "70,100" },
      { localTradedAt: "bad", closePrice: "1" },
    ]);
    expect(bars).toEqual([
      { date: "2026-10-01", open: null, high: null, low: null, close: 70100, volume: null },
      { date: "2026-10-02", open: 70000, high: 72000, low: 69900, close: 71200, volume: 12345 },
    ]);
  });
});

describe("point-in-time features", () => {
  it("uses only USD/KRW rates published before the session (one-day lag) and parses Frankfurter ranges", async () => {
    const bars = [{ date: "2026-01-05" }, { date: "2026-01-06" }, { date: "2026-01-07" }] as Bar[];
    const fx = [{ date: "2026-01-05", close: 1400 }, { date: "2026-01-06", close: 1410 }, { date: "2026-01-07", close: 1420 }] as Bar[];
    expect(alignLagged(bars, fx)).toEqual([NaN, 1400, 1410]);
    const f = (async (u: string) => {
      expect(String(u)).toBe("https://api.frankfurter.dev/v1/2026-01-05..2026-01-07?base=USD&symbols=KRW");
      return new Response(JSON.stringify({ base: "USD", rates: { "2026-01-06": { KRW: 1410.5 }, "2026-01-05": { KRW: 1400 }, bad: { KRW: 1 } } }));
    }) as typeof fetch;
    const http = createHttp({ fetch: f, timeoutMs: 1000, maxBytes: 1e6, maxRequests: 2, secrets: [] });
    expect((await loadUsdKrw(http, "2026-01-05", "2026-01-07")).map((b) => [b.date, b.close])).toEqual([["2026-01-05", 1400], ["2026-01-06", 1410.5]]);
  });

  it("never read bars after t", () => {
    const bars = market(200, 0, 1);
    const idx = market(200, 0, 2);
    const t = 120;
    const full = features(context(bars, idx), t);
    const cut = features(context(bars.slice(0, t + 1), idx.slice(0, t + 1)), t);
    expect(cut).toEqual(full);
    expect(full).toHaveLength(FEATURE_NAMES.length);
  });

  it("walk-forward never trains on an outcome that ends after the prediction date", () => {
    // A market whose future is planted into the past would be predicted perfectly by a leaky backtest.
    const bars = market(500, 0, 3);
    const s = buildSamples([{ ticker: "000001", bars, index: market(500, 0, 4) }]);
    const oos = walkForward(s, 2, { ...DEFAULT_OPTIONS, minTrain: 150 });
    expect(oos.length).toBeGreaterThan(200);
    expect(backtestStats(oos, 3).accuracy!).toBeLessThan(0.6);
  });
});

describe("short-term forecast on synthetic markets", () => {
  it("gives a volatile stock a proportionally wider range than a calm one when pooled together", () => {
    const index = market(600, 0, 40);
    const calm = Array.from({ length: 3 }, (_, i) => ({ ticker: `30000${i}`, bars: market(600, 0, 41 + i, 0.01), index }));
    const wild = Array.from({ length: 3 }, (_, i) => ({ ticker: `40000${i}`, bars: market(600, 0, 51 + i, 0.04), index }));
    const width = (f: ReturnType<typeof forecast>) => f.horizons[0]!.range80Pct[1] - f.horizons[0]!.range80Pct[0];
    const fc = forecast(calm[0]!, [...calm.slice(1), ...wild]);
    const fw = forecast(wild[0]!, [...wild.slice(1), ...calm]);
    expect(width(fw) / width(fc)).toBeGreaterThan(2.5);
    expect(width(fw) / width(fc)).toBeLessThan(6);
    // a one-session 80% range of a 1%-volatility stock is roughly +-1.3%
    expect(width(fc)).toBeGreaterThan(1.5);
    expect(width(fc)).toBeLessThan(4);
  }, 180_000);

  it("reports no edge and a near-base-rate probability on a random walk", () => {
    const target = { ticker: "111110", bars: market(700, 0, 11), index: market(700, 0, 12) };
    const peers = [21, 31].map((seed, i) => ({ ticker: `22222${i}`, bars: market(700, 0, seed), index: target.index }));
    const f = forecast(target, peers);
    for (const h of f.horizons) {
      expect(h.backtest.edge).toBe("none");
      expect(h.confidence).toBe("low");
      expect(Math.abs(h.probabilityUp - 0.5)).toBeLessThan(0.08);
      expect(h.range80Pct[0]).toBeLessThan(0);
      expect(h.range80Pct[1]).toBeGreaterThan(0);
    }
    expect(f.notes[0]).toMatch(/동전 던지기/);
  }, 120_000);

  it("detects real short-term momentum and predicts its direction", () => {
    const target = { ticker: "111110", bars: market(700, 0.35, 5), index: market(700, 0, 6) };
    const f = forecast(target);
    const h1 = f.horizons[0]!;
    expect(h1.backtest.edge).toBe("detected");
    expect(h1.backtest.accuracy!).toBeGreaterThan(0.55);
    expect(h1.backtest.meanAbsErrorPct!).toBeLessThan(h1.backtest.zeroForecastMaePct!);
    // The latest session's return carries forward with phi > 0.
    const lastRet = Math.log(target.bars.at(-1)!.close / target.bars.at(-2)!.close);
    expect(h1.direction).toBe(lastRet > 0 ? "up" : "down");
  }, 120_000);
});

// ---- service + HTTP, against a fake Naver serving synthetic bars ---------------------------------------------------
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForecastService, scoreForecast } from "../src/forecast/service.js";
import { buildApp } from "../src/http/app.js";
import { setup } from "./app.js";

function naverFake(markets: Record<string, Bar[]>, index: Bar[]) {
  const rows = (bars: Bar[], page: number) =>
    [...bars].reverse().slice((page - 1) * 60, page * 60).map((b) => ({ localTradedAt: b.date, closePrice: String(Math.round(b.close)), openPrice: String(Math.round(b.open!)), highPrice: String(Math.round(b.high!)), lowPrice: String(Math.round(b.low!)), accumulatedTradingVolume: String(Math.round(b.volume!)) }));
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    const page = Number(u.searchParams.get("page") ?? "1");
    const m = /^\/api\/stock\/(\w{6})\/(basic|price)$/.exec(u.pathname);
    if (m && markets[m[1]!]) {
      const body = m[2] === "basic" ? { itemCode: m[1], stockName: `Co ${m[1]}`, stockExchangeType: { code: "KS", name: "코스피" } } : rows(markets[m[1]!]!, page);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.pathname === "/api/index/KOSPI/price") return new Response(JSON.stringify(rows(index, page)), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("forecast service and API", () => {
  it("forecasts through the API, logs the forecast and scores it once later sessions exist", async () => {
    const index = market(400, 0, 6);
    const all = market(403, 0.3, 8);
    const markets = { "111110": all.slice(0, 400), "222220": market(400, 0.3, 9), "333330": market(400, 0.3, 10) };
    const { f } = naverFake(markets, index);
    const logDir = await mkdtemp(path.join(tmpdir(), "fc-"));
    const svc = new ForecastService({ fetch: f, logDir, pages: 7 });
    const base = await setup();
    const app = buildApp(base.service, base.research, base.config, undefined, undefined, svc);
    const res = await app.inject({ method: "GET", url: "/v1/forecast/111110?peers=222220,333330,444440" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.horizons).toHaveLength(3);
    expect(body.trainedOn.tickers).toEqual(["111110", "222220", "333330"]);
    expect(body.peerFailures).toEqual(["444440"]);
    for (const h of body.horizons) {
      expect(h.probabilityUp).toBeGreaterThan(0);
      expect(h.probabilityUp).toBeLessThan(1);
      expect(h.range80Pct[0]).toBeLessThanOrEqual(h.expectedReturnPct);
      expect(h.range80Pct[1]).toBeGreaterThanOrEqual(h.expectedReturnPct);
    }
    expect((await app.inject({ method: "GET", url: "/v1/forecast/111115" })).statusCode).toBe(422); // preferred share
    expect((await app.inject({ method: "GET", url: "/v1/forecast/111110?peers=xx" })).statusCode).toBe(400);

    const [rec] = await svc.readLog();
    expect(rec!.ticker).toBe("111110");
    expect(scoreForecast(rec!, markets["111110"]).every((s) => s.status === "pending")).toBe(true);
    const later = scoreForecast(rec!, all);
    expect(later.map((s) => s.status)).toEqual(["scored", "scored", "scored"]);
    expect(later[2]!.actualReturnPct).toBeCloseTo((all[402]!.close / Math.round(all[399]!.close) - 1) * 100, 1);
    await app.close();
  }, 120_000);
  it("ranks the largest stocks of an exchange by the probability of a rise (one pooled model)", async () => {
    const index = market(320, 0, 6);
    const markets: Record<string, Bar[]> = Object.fromEntries(["111110", "222220", "333330", "444440", "555550"].map((t, i) => [t, market(320, 0.3, 70 + i)]));
    const { f } = naverFake(markets, index);
    const universe = { get: async () => ({ fetchedAt: "2026-10-06T00:00:00Z", scanned: 6, items: [...Object.keys(markets), "666660"].map((t, i) => ({ ticker: t, name: `Co${i}`, exchange: "KOSPI", marketCapKRW: 100 - i })) }) };
    const svc = new ForecastService({ fetch: f, pages: 6, universe: universe as never });
    const base = await setup();
    const app = buildApp(base.service, base.research, base.config, undefined, undefined, svc);
    const res = await app.inject({ method: "GET", url: "/v1/forecast-ranking?count=6&horizon=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ranked).toHaveLength(5);
    expect(body.failures).toEqual(["666660"]);
    const p = body.ranked.map((r: { probabilityUp: number }) => r.probabilityUp);
    expect([...p].sort((a, b) => b - a)).toEqual(p);
    expect(body.ranked[0].name).toMatch(/^Co/);
    expect(body.pooledBacktest.n).toBeGreaterThan(500);
    expect((await app.inject({ method: "GET", url: "/v1/forecast-ranking?exchange=NYSE" })).statusCode).toBe(400);
    await app.close();
  }, 180_000);

  it("shares one computation between identical concurrent requests and reuses peer histories", async () => {
    const index = market(300, 0, 6);
    const markets = { "111110": market(300, 0.3, 8), "222220": market(300, 0.3, 9), "333330": market(300, 0.3, 10) };
    const { f, calls } = naverFake(markets, index);
    const svc = new ForecastService({ fetch: f, pages: 5 });
    const [a, b] = await Promise.all([svc.run("111110", { peers: ["222220", "333330"] }), svc.run("111110", { peers: ["222220", "333330"] })]);
    expect(a).toBe(b);
    const naver = () => calls.filter((p) => p.startsWith("/api/")).length; // a failed FX lookup is retried, histories are not
    const before = naver();
    await svc.run("222220", { peers: ["111110", "333330"] }); // every history is cached now
    expect(naver()).toBe(before);
  }, 120_000);
});

describe("corporate actions", () => {
  it("folds a 1:5 split (a -80% 'move' beyond the +-30% limit) into earlier prices", async () => {
    const { adjustCorporateActions } = await import("../src/forecast/history.js");
    const bars = [100_000, 101_000, 20_400, 20_600].map((close, i) => ({ date: day(i), open: close, high: close, low: close, close, volume: 1000 }));
    const { bars: adj, adjusted } = adjustCorporateActions(bars);
    expect(adjusted).toEqual([day(2)]);
    expect(adj.map((b) => Math.round(b.close))).toEqual([20198, 20400, 20400, 20600]);
    expect(adj[0]!.volume).toBeCloseTo(1000 / (20_400 / 101_000), 6);
    // a genuine limit-down day (-29.9%) is left alone
    const real = [10_000, 7_010, 7_100].map((close, i) => ({ date: day(i), open: close, high: close, low: close, close, volume: 1 }));
    expect(adjustCorporateActions(real).adjusted).toEqual([]);
  });
});

describe("robustness to sparse data", () => {
  it("forecasts from closes alone (no open/high/low/volume) and reports a calibration table", () => {
    const strip = (bars: Bar[]) => bars.map((b) => ({ ...b, open: null, high: null, low: null, volume: null }));
    const index = market(500, 0, 61);
    const series = [0, 1, 2].map((i) => ({ ticker: `50000${i}`, bars: strip(market(500, 0.3, 62 + i)), index: [] as Bar[] }));
    const f = forecast(series[0]!, series.slice(1));
    expect(index.length).toBe(500);
    for (const h of f.horizons) {
      expect(Number.isFinite(h.probabilityUp)).toBe(true);
      expect(Number.isFinite(h.expectedReturnPct)).toBe(true);
      expect(h.backtest.calibration.reduce((n, b) => n + b.n, 0)).toBe(h.backtest.n);
    }
    expect(f.horizons[0]!.backtest.edge).toBe("detected"); // momentum still found without OHLV or index
  }, 180_000);
});
