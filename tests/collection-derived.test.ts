import { describe, expect, it } from "vitest";
import { parseFx } from "../src/collection/fx.js";
import { parseAnnualFinance } from "../src/collection/naver.js";
import { perReference } from "../src/collection/per.js";
import type { QuarterlyActual } from "../src/collection/types.js";

const act = (quarter: string, epsKRW: number): QuarterlyActual => ({ ticker: "005930", quarter, epsKRW, scope: "provider_default", epsBasis: "unspecified", observedAt: "2026-09-28T00:00:00Z", sourceUrl: "u" });
const closes = [{ date: "2026-09-25", closeKRW: 60000 }, { date: "2026-09-24", closeKRW: 40000 }, { date: "2026-09-23", closeKRW: 50000 }];

describe("perReference", () => {
  it("divides the latest close and the close range by the TTM EPS of the latest four consecutive quarters", () => {
    const p = perReference(closes, [act("2025Q2", 999), act("2025Q3", 1000), act("2025Q4", 1000), act("2026Q1", 1500), act("2026Q2", 1500)], ["u"]);
    expect(p).toMatchObject({ ttmEpsKRW: 5000, quarters: ["2025Q3", "2025Q4", "2026Q1", "2026Q2"], latestClose: { date: "2026-09-25", closeKRW: 60000 }, current: 12 });
    expect(p?.window).toEqual({ from: "2026-09-23", to: "2026-09-25", sessions: 3, min: 8, median: 10, max: 12 });
  });

  it("needs four consecutive quarters and a positive TTM EPS", () => {
    expect(perReference(closes, [act("2025Q3", 1), act("2025Q4", 1), act("2026Q1", 1)], [])).toBeNull();
    expect(perReference(closes, [act("2025Q2", 1), act("2025Q4", 1), act("2026Q1", 1), act("2026Q2", 1)], [])).toBeNull(); // gap
    expect(perReference(closes, [act("2025Q3", -5), act("2025Q4", 1), act("2026Q1", 1), act("2026Q2", 1)], [])).toBeNull();
    expect(perReference([], [act("2025Q3", 1), act("2025Q4", 1), act("2026Q1", 1), act("2026Q2", 1)], [])).toBeNull();
  });
});

describe("parseFx", () => {
  const body = (over: Record<string, unknown> = {}) => ({ base: "EUR", date: "2026-09-25", rates: { KRW: 1600, USD: 1.25, JPY: 160 }, ...over });

  it("crosses EUR reference rates into KRW per unit and skips currencies without a rate", () => {
    const fx = parseFx(body(), "2026-09-27", "https://api.frankfurter.dev/v1/2026-09-27");
    expect(fx.map((f) => [f.currency, f.krwPerUnit])).toEqual([["USD", 1280], ["EUR", 1600], ["JPY", 10]]);
    expect(fx.every((f) => f.rateDate === "2026-09-25")).toBe(true);
  });

  it("rejects a rate dated after the requested day, a wrong base or a missing KRW rate", () => {
    expect(() => parseFx(body({ date: "2026-09-28" }), "2026-09-27", "u")).toThrow(/after the requested/);
    expect(() => parseFx(body({ base: "USD" }), "2026-09-27", "u")).toThrow(/EUR base/);
    expect(() => parseFx(body({ rates: { USD: 1.25 } }), "2026-09-27", "u")).toThrow(/KRW/);
  });
});

describe("parseAnnualFinance", () => {
  it("rejects a response for another ticker or period type", () => {
    const ok = { itemCode: "005930", financePeriodType: "annual", financeInfo: { itemCode: "005930", trTitleList: [{ key: "202512", isConsensus: "N" }], rowList: [{ title: "매출액", columns: { "202512": { value: "10" } } }] } };
    expect(parseAnnualFinance(ok, "005930", "t")[0]).toMatchObject({ period: "2025.12", isConsensus: false, revenueKRW: 1e9 });
    expect(() => parseAnnualFinance({ ...ok, financePeriodType: "quarter" }, "005930", "t")).toThrow();
    expect(() => parseAnnualFinance(ok, "000660", "t")).toThrow();
  });
});
