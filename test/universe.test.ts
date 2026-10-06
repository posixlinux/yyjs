import { describe, expect, it } from "vitest";
import { UniverseProvider, type Universe } from "../src/research/universe.js";

const row = (itemCode: string, stockName: string) => ({ itemCode, stockName, stockExchangeType: { code: "KS" }, stockEndType: "stock", marketValue: "100" });

describe("UniverseProvider", () => {
  it("finds alphanumeric tickers whatever the query's case", () => {
    const u: Universe = { fetchedAt: "2026-01-01T00:00:00Z", scanned: 2, items: [
      { ticker: "0009K0", name: "신규", exchange: "KOSPI", marketCapKRW: 1 },
      { ticker: "005930", name: "삼성전자", exchange: "KOSPI", marketCapKRW: 2 },
    ] };
    expect(UniverseProvider.search(u, "0009k0", 10).items.map((i) => i.ticker)).toEqual(["0009K0"]);
    expect(UniverseProvider.search(u, "0009K0", 10).items.map((i) => i.ticker)).toEqual(["0009K0"]);
  });

  it("waits before retrying Naver after a failed load", async () => {
    let calls = 0;
    let up = false;
    let t = Date.parse("2026-01-01T00:00:00Z");
    const fetchFn = (async () => {
      calls++;
      if (!up) return new Response("", { status: 503 });
      return new Response(JSON.stringify({ stocks: [row("005930", "삼성전자")], totalCount: 1 }), { status: 200 });
    }) as typeof fetch;
    const p = new UniverseProvider({ fetch: fetchFn, now: () => new Date(t), retryAfterMs: 60_000 });

    await expect(p.get()).rejects.toThrow(/503/);
    const afterFailure = calls;
    up = true;
    await expect(p.get()).rejects.toThrow(/503/); // within the back-off: no upstream request
    expect(calls).toBe(afterFailure);

    t += 61_000;
    expect((await p.get()).items.map((i) => i.ticker)).toEqual(["005930"]);
  });
});
