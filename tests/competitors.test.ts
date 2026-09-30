import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { collectPublicEvidence, CollectionInputError } from "../src/collection/index.js";
import { parseCompetitorIds } from "../src/collection/competitors.js";
import { calendarPeriodOf } from "../src/collection/period.js";
import { parseCodeList, revenueFromCsv, targetPeriods } from "../src/collection/edinet.js";
import { buildDocuments } from "../src/research/evidence.js";

const NOW = () => new Date("2026-10-01T03:00:00Z");
const ASOF = "2026-10-01";
const UA = "yyjs-test tester@example.com";
const EDINET_KEY = "edinetKEY0123456789";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function fake(handler: (u: URL, init: RequestInit) => Response | undefined) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {}) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function zip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const comp = deflateRawSync(raw);
    const nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameB.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(lh, nameB, comp);
    central.push(cd, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ---------- SEC fixtures (shape of data.sec.gov companyfacts) ----------
const fact = (start: string, end: string, val: number, form: string, filed: string, fy: number, fp: string) => ({ start, end, val, accn: `0000723125-${filed.slice(2, 4)}-000001`, fy, fp, form, filed });
const MU_FACTS = {
  cik: 723125,
  entityName: "Micron Technology, Inc.",
  facts: {
    "us-gaap": {
      Revenues: { units: { USD: [fact("2017-06-02", "2017-08-31", 6_138_000_000, "10-K", "2017-10-26", 2017, "FY")] } }, // old tag: loses to the newer one
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            fact("2024-08-30", "2024-11-28", 8_709_000_000, "10-Q", "2024-12-18", 2025, "Q1"),
            fact("2024-11-29", "2025-02-27", 8_053_000_000, "10-Q", "2025-03-21", 2025, "Q2"),
            fact("2025-02-28", "2025-05-29", 9_301_000_000, "10-Q", "2025-06-26", 2025, "Q3"),
            fact("2025-02-28", "2025-05-29", 9_301_000_000, "10-Q", "2026-06-25", 2026, "Q3"), // later comparative: earliest filing wins
            fact("2024-08-30", "2025-08-28", 37_378_000_000, "10-K", "2025-10-03", 2025, "FY"),
            fact("2025-08-29", "2025-11-27", 13_643_000_000, "10-Q", "2025-12-18", 2026, "Q1"),
            fact("2025-08-29", "2026-02-26", 37_503_000_000, "10-Q", "2026-03-19", 2026, "Q2"), // 6-month YTD: ignored
            fact("2025-11-28", "2026-02-26", 23_860_000_000, "10-Q", "2026-03-19", 2026, "Q2"),
            fact("2026-02-27", "2026-05-28", 41_456_000_000, "10-Q", "2026-06-25", 2026, "Q3"),
            fact("2026-05-29", "2026-08-27", 45_000_000_000, "10-Q", "2026-10-01", 2026, "Q4"), // filed 10-01 ET: public only on 10-02 KST, after asOf
          ],
        },
      },
    },
  },
};
const TSM_FACTS = { cik: 1046179, entityName: "TSMC", facts: { "ifrs-full": { Revenue: { units: { TWD: [] } } } } };
const secHandler = (u: URL) => {
  if (u.hostname === "www.sec.gov" && u.pathname === "/files/company_tickers.json")
    return json({ "0": { cik_str: 723125, ticker: "MU", title: "MICRON TECHNOLOGY INC" }, "1": { cik_str: 1046179, ticker: "TSM", title: "TAIWAN SEMICONDUCTOR" } });
  if (u.hostname === "data.sec.gov" && u.pathname === "/api/xbrl/companyfacts/CIK0000723125.json") return json(MU_FACTS);
  if (u.hostname === "data.sec.gov" && u.pathname === "/api/xbrl/companyfacts/CIK0001046179.json") return json(TSM_FACTS);
  return undefined;
};

// ---------- EDINET fixtures ----------
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CODELIST = Buffer.concat([
  BOM,
  Buffer.from(
    [
      "ダウンロード実行日,2026年09月30日現在,件数,3件",
      "ＥＤＩＮＥＴコード,提出者種別,上場区分,連結の有無,資本金,決算日,提出者名,提出者名（英字）,提出者名（ヨミ）,所在地,提出者業種,証券コード,提出者法人番号",
      '"E02652","内国法人・組合","上場","有","54961","3月31日","東京エレクトロン株式会社","Tokyo Electron Limited","","港区","電気機器","80350","4010401020757"',
      '"E99999","外国法人・組合","上場","有","1","12月31日","Foreign Co","Foreign Co","","","","99990",""',
    ].join("\r\n"),
  ),
]);
const csvRow = (...cols: string[]) => cols.map((c) => `"${c}"`).join("\t");
const HEADER = csvRow("要素ID", "項目名", "コンテキストID", "相対年度", "連結・個別", "期間・時点", "ユニットID", "単位", "値");
const reportCsv = (ctx: string, value: string) =>
  Buffer.from(
    "﻿" + [
      HEADER,
      csvRow("jpcrp_cor:NetSalesSummaryOfBusinessResults", "売上高", ctx, "当期", "連結", "期間", "JPY", "円", value),
      csvRow("jpcrp_cor:NetSalesSummaryOfBusinessResults", "売上高", `${ctx}_NonConsolidatedMember`, "当期", "個別", "期間", "JPY", "円", "1"),
    ].join("\r\n"),
    "utf16le",
  );
// FY2025 (to 2026-03-31) annual report filed 2026-06-19; H1 to 2025-09-30 filed 2025-11-12; H1 to 2026-09-30 not yet filed.
const EDINET_DOCS: Record<string, unknown[]> = {
  "2026-06-19": [{ docID: "S100AAAA", edinetCode: "E02652", docTypeCode: "120", periodStart: "2025-04-01", periodEnd: "2026-03-31", submitDateTime: "2026-06-19 15:00", csvFlag: "1", withdrawalStatus: "0" }],
  "2025-11-12": [{ docID: "S100BBBB", edinetCode: "E02652", docTypeCode: "160", periodStart: "2025-04-01", periodEnd: "2025-09-30", submitDateTime: "2025-11-12 15:00", csvFlag: "1", withdrawalStatus: "0" }],
};
const edinetHandler = (u: URL) => {
  if (u.hostname === "disclosure2dl.edinet-fsa.go.jp") return new Response(zip({ "EdinetcodeDlInfo.csv": CODELIST }));
  if (u.hostname !== "api.edinet-fsa.go.jp") return undefined;
  if (u.searchParams.get("Subscription-Key") !== EDINET_KEY) return json({ StatusCode: 401, message: "Access denied" }, 401);
  if (u.pathname === "/api/v2/documents.json") return json({ metadata: { status: "200" }, results: EDINET_DOCS[u.searchParams.get("date") ?? ""] ?? [] });
  if (u.pathname === "/api/v2/documents/S100AAAA") return new Response(zip({ "XBRL_TO_CSV/jpcrp030000-asr-001_E02652.csv": reportCsv("CurrentYearDuration", "2400000000000") }));
  if (u.pathname === "/api/v2/documents/S100BBBB") return new Response(zip({ "XBRL_TO_CSV/jpcrp040300-ssr-001_E02652.csv": reportCsv("InterimDuration", "1100000000000") }));
  return undefined;
};

const run = (f: ReturnType<typeof fake>, competitors: string[], env: Record<string, string> = { SEC_USER_AGENT: UA, EDINET_API_KEY: EDINET_KEY }) =>
  collectPublicEvidence({ ticker: "000660", asOf: ASOF, competitors }, { fetch: f.fetch, now: NOW, env, maxArticles: 0 });

describe("competitor ids", () => {
  it("accepts Korea/US/Japan only, normalizes and drops the analysed company", () => {
    expect(parseCompetitorIds(["kr:000270", "US:mu", " JP : 8035 ", "US:MU", "KR:005930"], "005930")).toEqual([
      { market: "KR", code: "000270" }, { market: "US", code: "MU" }, { market: "JP", code: "8035" },
    ]);
    for (const bad of ["TW:2330", "CN:600519", "MU", "KR:12345", "JP:80350"]) expect(() => parseCompetitorIds([bad])).toThrow(CollectionInputError);
    expect(() => parseCompetitorIds(["US:A", "US:B", "US:C", "US:D", "US:E", "US:F", "US:G"])).toThrow(/at most 6/);
  });

  it("maps fiscal periods to the calendar period holding most of them", () => {
    expect(calendarPeriodOf("2025-05-29", 3)).toEqual({ calendarPeriod: "2025Q2", calendarAlignment: "approximate" });
    expect(calendarPeriodOf("2026-03-31", 3)).toEqual({ calendarPeriod: "2026Q1", calendarAlignment: "exact" });
    expect(calendarPeriodOf("2025-09-30", 6)).toEqual({ calendarPeriod: "2025Q2~2025Q3", calendarAlignment: "exact" }); // Apr-Sep half
    expect(calendarPeriodOf("2026-03-31", 12)).toEqual({ calendarPeriod: "2025Q2~2026Q1", calendarAlignment: "exact" });
    expect(calendarPeriodOf("2025-12-31", 12)).toEqual({ calendarPeriod: "2025Q1~2025Q4", calendarAlignment: "exact" });
    expect(calendarPeriodOf("2025-08-28", 12)).toEqual({ calendarPeriod: "2024Q4~2025Q3", calendarAlignment: "approximate" });
  });
});

describe("SEC EDGAR (US)", () => {
  it("reads quarterly revenue from 10-Q/10-K facts, dated by the earliest filing, with Q4 = FY - Q1..Q3", async () => {
    const f = fake(secHandler);
    const e = await run(f, ["US:MU"]);
    const mu = e.competitors?.[0];
    expect(mu).toMatchObject({ market: "US", code: "MU", name: "Micron Technology, Inc.", system: "SEC EDGAR" });
    const q = mu!.periods.filter((p) => p.months === 3);
    expect(q.map((p) => `${p.periodEnd}:${p.revenue}`)).toEqual([
      "2026-05-28:41456000000", "2026-02-26:23860000000", "2025-11-27:13643000000",
      "2025-08-28:11315000000", // derived Q4 = 37,378 - (8,709 + 8,053 + 9,301)
      "2025-05-29:9301000000", "2025-02-27:8053000000", "2024-11-28:8709000000",
    ]);
    expect(q.find((p) => p.periodEnd === "2025-08-28")).toMatchObject({ basis: "derived", calendarPeriod: "2025Q3", filedDate: "2025-10-04" });
    expect(q.find((p) => p.periodEnd === "2025-05-29")).toMatchObject({ filedDate: "2025-06-27", calendarPeriod: "2025Q2", concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" });
    expect(mu!.periods.some((p) => p.periodEnd === "2026-08-27")).toBe(false); // filed after asOf
    expect(e.providers.competitors?.US?.status).toBe("ok");
    // SEC fair-access: every SEC request carries the configured User-Agent
    const sec = f.calls.filter((c) => c.url.hostname.endsWith("sec.gov"));
    expect(sec.every((c) => (c.init.headers as Record<string, string>)["user-agent"] === UA)).toBe(true);

    const doc = buildDocuments(e).documents.find((d) => d.id === "cmp-US-MU");
    expect(doc?.text).toContain("[USD] 매출 41,456,000,000");
    expect(doc?.publishedAt).toBe("2026-06-26");
  });

  it("rejects foreign private issuers (no 10-Q/10-K) and needs SEC_USER_AGENT", async () => {
    const e = await run(fake(secHandler), ["US:TSM"]);
    expect(e.competitors).toEqual([]);
    expect(e.issues.some((i) => i.provider === "sec" && ["no_us_gaap", "not_us_domestic"].includes(i.code))).toBe(true);
    const f = fake(secHandler);
    const n = await run(f, ["US:MU"], {});
    expect(n.providers.competitors?.US?.status).toBe("not_configured");
    expect(f.calls.some((c) => c.url.hostname.endsWith("sec.gov"))).toBe(false);
  });
});

describe("EDINET (Japan)", () => {
  it("parses the code list and plans reports near their deadlines", () => {
    const m = parseCodeList(CODELIST.subarray(3).toString("utf8"));
    expect(m.get("8035")).toMatchObject({ edinetCode: "E02652", fyEndMonth: 3, domestic: true });
    expect(m.get("9999")?.domestic).toBe(false);
    expect(targetPeriods(3, "2026-10-01")).toEqual([
      { end: "2026-09-30", kind: "H1", deadline: "2026-11-15" },
      { end: "2026-03-31", kind: "FY", deadline: "2026-07-01" },
      { end: "2025-09-30", kind: "H1", deadline: "2025-11-15" },
      { end: "2025-03-31", kind: "FY", deadline: "2025-07-01" },
    ]);
  });

  it("prefers consolidated summary revenue of the report's own period", () => {
    const text = new TextDecoder("utf-16le").decode(reportCsv("CurrentYearDuration", "2400000000000"));
    expect(revenueFromCsv(text, "FY")).toEqual({ value: 2_400_000_000_000, element: "jpcrp_cor:NetSalesSummaryOfBusinessResults", consolidated: true });
    expect(revenueFromCsv(text, "H1")).toBeNull();
  });

  it("finds annual and half-year reports by date, reads revenue and derives H2", async () => {
    const f = fake(edinetHandler);
    const e = await run(f, ["JP:8035"]);
    const tel = e.competitors?.[0];
    expect(tel).toMatchObject({ market: "JP", code: "8035", name: "Tokyo Electron Limited", system: "EDINET" });
    expect(tel!.periods.map((p) => `${p.calendarPeriod}:${p.months}:${p.basis}:${p.revenue}`)).toEqual([
      "2025Q4~2026Q1:6:derived:1300000000000", // second half (Oct-Mar) = FY 2.4T - first half 1.1T
      "2025Q2~2026Q1:12:reported:2400000000000",
      "2025Q2~2025Q3:6:reported:1100000000000",
    ]);
    expect(tel!.periods[0]).toMatchObject({ periodStart: "2025-10-01", periodEnd: "2026-03-31", filedDate: "2026-06-19", currency: "JPY", consolidated: true });
    expect(tel!.periods[2]).toMatchObject({ periodStart: "2025-04-01", sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100BBBB" });
    // weekends are never listed, the key never leaks into evidence
    const listed = f.calls.filter((c) => c.url.pathname === "/api/v2/documents.json").map((c) => new Date(`${c.url.searchParams.get("date")}T00:00:00Z`).getUTCDay());
    expect(listed.every((d) => d !== 0 && d !== 6)).toBe(true);
    expect(JSON.stringify(e)).not.toContain(EDINET_KEY);
    expect(e.providers.competitors?.JP?.status).toBe("ok");
  });

  it("rejects non-Japanese filers and needs EDINET_API_KEY", async () => {
    const e = await run(fake(edinetHandler), ["JP:9999"]);
    expect(e.issues.some((i) => i.provider === "edinet" && i.code === "not_jp_domestic")).toBe(true);
    const n = await run(fake(edinetHandler), ["JP:8035"], {});
    expect(n.providers.competitors?.JP?.status).toBe("not_configured");
  });
});
