import { describe, expect, it } from "vitest";
import { collectPublicEvidence, CollectionInputError } from "../src/collection/index.js";
import { classifySecurity, isCommonStock } from "../src/domain/security.js";

const codes = (f: Parameters<typeof classifySecurity>[0]) => classifySecurity(f).map((r) => r.code);

describe("common-stock eligibility", () => {
  it("accepts ordinary operating companies", () => {
    for (const [ticker, name] of [["005930", "삼성전자"], ["000660", "SK하이닉스"], ["095570", "AJ네트웍스"], ["005380", "현대차"], ["003550", "LG"]])
      expect(isCommonStock({ ticker, names: [name], endType: "stock" }), `${ticker} ${name}`).toBe(true);
  });

  it("rejects preferred shares by ticker suffix and by name", () => {
    expect(codes({ ticker: "005935", names: ["삼성전자우"] })).toContain("PREFERRED_STOCK");
    expect(codes({ ticker: "005387", names: ["현대차2우B"] })).toContain("PREFERRED_STOCK");
    expect(codes({ ticker: "123450", names: ["예시2우B"], checkTickerSuffix: false })).toContain("PREFERRED_STOCK");
    expect(codes({ ticker: "123450", names: ["예시우선주"] })).toContain("PREFERRED_STOCK");
    expect(codes({ ticker: "123456", names: ["예시전자"], checkTickerSuffix: false })).toEqual([]); // fictional dataset ticker
  });

  it("rejects ETF/ETN and non-stock instrument types", () => {
    expect(codes({ ticker: "069500", names: ["KODEX 200"], endType: "etf" })).toEqual(["ETF_ETN"]);
    expect(codes({ ticker: "570010", names: ["ABC ETN"], endType: "etn" })).toEqual(["ETF_ETN"]);
    expect(codes({ ticker: "100000", names: ["X"], endType: "fund" })).toEqual(["NON_STOCK"]);
    expect(codes({ ticker: "069500", names: ["KODEX 200"] })).toContain("ETF_ETN");
  });

  it("rejects REITs, infrastructure funds, SPACs and ship funds", () => {
    expect(codes({ ticker: "348950", names: ["제이알글로벌리츠", "(주)제이알글로벌위탁관리부동산투자회사"] })).toContain("REIT");
    expect(codes({ ticker: "330590", names: ["롯데리츠"] })).toContain("REIT");
    expect(codes({ ticker: "088980", names: ["맥쿼리인프라", "맥쿼리한국인프라투융자회사"], industryCode: "64201" })).toContain("INFRA_FUND");
    expect(codes({ ticker: "100000", names: ["예시"], industryCode: "64201" })).toContain("INFRA_FUND");
    expect(codes({ ticker: "100000", names: ["삼성머스트스팩1호"] })).toContain("SPAC");
    expect(codes({ ticker: "078420", names: ["동북아1호선박투자회사"] })).toContain("SHIP_FUND");
  });

  it("matches English words whole: operating companies whose English names contain the letters are not rejected", () => {
    // DART also supplies corp_name_eng; "Aerospace" contains "spac" and was rejected as a SPAC.
    expect(codes({ ticker: "012450", names: ["한화에어로스페이스", "한화에어로스페이스(주)", "Hanwha Aerospace Co.,Ltd."], checkTickerSuffix: false })).toEqual([]);
    expect(codes({ ticker: "047810", names: ["한국항공우주", "KOREA AEROSPACE INDUSTRIES,LTD."] })).toEqual([]);
    expect(codes({ ticker: "100000", names: ["예시인프라", "Example Infra Co., Ltd."] })).toEqual([]); // operating company named ...인프라
    expect(codes({ ticker: "100000", names: ["Pureit Holdings"] })).toEqual([]);
    // the real vehicles are still caught by their English names
    expect(codes({ ticker: "100000", names: ["Hana Financial SPAC No.25"] })).toContain("SPAC");
    expect(codes({ ticker: "100000", names: ["ABC Special Purpose Acquisition Co."] })).toContain("SPAC");
    expect(codes({ ticker: "330590", names: ["LOTTE REIT Co., Ltd."] })).toContain("REIT");
    expect(codes({ ticker: "088980", names: ["맥쿼리인프라"] })).toContain("INFRA_FUND");
  });
});

// ---- collector integration (fake fetch) -------------------------------------------------------------------------

const NOW = () => new Date("2026-09-28T03:00:00Z");
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const basic = (over: Record<string, unknown>) => ({
  itemCode: "005930",
  stockName: "삼성전자",
  stockEndType: "stock",
  closePrice: "71,200",
  localTradedAt: "2026-09-25T15:30:00+09:00",
  stockExchangeType: { name: "KOSPI", code: "KS", nameEng: "KOSPI" },
  ...over,
});

function run(ticker: string, over: Record<string, unknown>) {
  const calls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u);
    return u.pathname.endsWith("/basic") ? json(basic({ itemCode: ticker, ...over })) : new Response("nf", { status: 404 });
  }) as typeof fetch;
  return { calls, p: collectPublicEvidence({ ticker, asOf: "2026-09-28" }, { fetch: fetchFn, now: NOW, env: {}, maxArticles: 0 }) };
}

describe("collector common-stock gate", () => {
  it("throws for a preferred ticker before any network call", async () => {
    const { calls, p } = run("005935", { stockName: "삼성전자우" });
    await expect(p).rejects.toBeInstanceOf(CollectionInputError);
    expect(calls).toHaveLength(0);
  });

  it("stops after Naver basic for ETFs and REITs (no quote, no news)", async () => {
    for (const [ticker, over] of [
      ["069500", { stockName: "KODEX 200", stockEndType: "etf" }],
      ["348950", { stockName: "제이알글로벌리츠" }],
    ] as const) {
      const { calls, p } = run(ticker, over);
      const e = await p;
      expect(e.issues.some((i) => i.code === "not_common_stock"), ticker).toBe(true);
      expect(e.market.quote).toBeNull();
      expect(e.market.news).toEqual([]);
      expect(calls).toHaveLength(1);
    }
  });

  it("still collects an ordinary common stock", async () => {
    const { p } = run("005930", {});
    const e = await p;
    expect(e.issues.some((i) => i.code === "not_common_stock")).toBe(false);
    expect(e.market.quote?.close).toBe(71200);
  });
});
