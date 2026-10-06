import { describe, expect, it, vi } from "vitest";
import { setup } from "../test/app.js";
import { toItem, UniverseProvider } from "../src/research/universe.js";

const row = (itemCode: string, stockName: string, stockEndType = "stock", marketValue = "1,000", code = "KS") => ({ itemCode, stockName, stockEndType, marketValue, stockExchangeType: { code } });

// One listing per market URL (.../marketValue/KOSPI, .../marketValue/KOSDAQ); rows are routed by their exchange code.
const listing = (rows: ReturnType<typeof row>[]) =>
  vi.fn(async (input: string | URL) => {
    const code = new URL(String(input)).pathname.endsWith("/KOSDAQ") ? "KQ" : "KS";
    const stocks = rows.filter((r) => r.stockExchangeType.code === code);
    return new Response(JSON.stringify({ stocks, totalCount: stocks.length }), { status: 200 });
  }) as unknown as typeof fetch;

describe("universe", () => {
  it("keeps only KOSPI/KOSDAQ common stocks (drops ETF, preferred, REIT, infra fund) sorted by market cap", async () => {
    const u = new UniverseProvider({
      fetch: listing([
        row("005930", "삼성전자", "stock", "15,000,000"),
        row("005935", "삼성전자우", "stock", "2,000,000"),
        row("069500", "KODEX 200", "etf"),
        row("348950", "제이알글로벌리츠"),
        row("088980", "맥쿼리인프라"),
        row("000660", "SK하이닉스", "stock", "9,000,000"),
        row("000660", "SK하이닉스"), // duplicate
        row("196170", "알테오젠", "stock", "180,000", "KQ"),
      ]),
    });
    const r = await u.get();
    expect(r.items.map((i) => i.ticker)).toEqual(["005930", "000660", "196170"]);
    expect(r.items.find((i) => i.ticker === "196170")?.exchange).toBe("KOSDAQ");
    expect(r.items[0]!.marketCapKRW).toBe(15_000_000 * 1e8);
    expect(UniverseProvider.search(r, "하이", 10).items.map((i) => i.ticker)).toEqual(["000660"]);
    expect(UniverseProvider.search(r, "0059", 10).total).toBe(1);
  });

  it("caches, and serves the stale list when a refresh fails", async () => {
    const f = listing([row("005930", "삼성전자")]);
    let t = 0;
    const u = new UniverseProvider({ fetch: f, ttlMs: 10, now: () => new Date(t) });
    await u.get();
    await u.get();
    expect(f).toHaveBeenCalledTimes(2); // one page per market, once
    t = 100;
    (f as any).mockImplementation(async () => new Response("x", { status: 500 }));
    expect((await u.get()).items).toHaveLength(1);
  });

  it("rejects rows on other exchanges and malformed rows", () => {
    expect(toItem({ itemCode: "123450", stockName: "X", stockExchangeType: { code: "KN" } })).toBeNull();
    expect(toItem({ itemCode: "123450", stockName: "X", stockExchangeType: { code: "KQ" } })?.exchange).toBe("KOSDAQ");
    expect(toItem(null)).toBeNull();
    expect(toItem(row("12345", "short"))).toBeNull();
  });
});

describe("web UI routes", () => {
  it("serves the page with a strict CSP and its assets, and 404s unknown assets", async () => {
    const { app } = await setup();
    const page = await app.inject({ url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");
    expect(page.body).not.toMatch(/<script>[^<]/); // no inline script
    for (const f of ["app.js", "style.css"]) expect((await app.inject({ url: `/assets/${f}` })).statusCode).toBe(200);
    expect((await app.inject({ url: "/assets/../package.json" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/assets/secret.txt" })).statusCode).toBe(404);
  });

  it("GET /v1/universe searches the injected list and reports upstream failure as 502", async () => {
    const { app } = await setup();
    // default provider has no injected fetch in setup(); use a dedicated app for the fake list
    const { buildApp } = await import("../src/http/app.js");
    const s = await setup();
    const good = buildApp(s.service, s.research, { ...s.config, logLevel: "silent" }, new UniverseProvider({ fetch: listing([row("005930", "삼성전자"), row("005935", "삼성전자우")]) }));
    const res = await good.inject({ url: "/v1/universe?query=삼성" });
    expect(res.json()).toMatchObject({ markets: ["KOSPI", "KOSDAQ"], commonStocksOnly: true, total: 1, items: [{ ticker: "005930", name: "삼성전자" }] });
    expect((await good.inject({ url: "/v1/universe?limit=0" })).statusCode).toBe(400);
    const bad = buildApp(s.service, s.research, { ...s.config, logLevel: "silent" }, new UniverseProvider({ fetch: (async () => new Response("x", { status: 500 })) as unknown as typeof fetch }));
    const r = await bad.inject({ url: "/v1/universe" });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe("UNIVERSE_UNAVAILABLE");
    void app;
  });
});
