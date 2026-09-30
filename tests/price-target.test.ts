import { describe, expect, it } from "vitest";
import { computeNextQuarterPrice, quarterBounds, shiftQuarter } from "../src/strategy/price-target.js";
import { parseQuarterlyActuals } from "../src/collection/naver.js";
import type { ForecastBridge } from "../src/strategy/earnings.js";
import type { DailyClose, QuarterlyActual } from "../src/collection/types.js";

const bridge = (quarter: string, epsKRW: number) => ({ quarters: [{ quarter, epsKRW }], ntmEpsKRW: epsKRW }) as unknown as ForecastBridge;
const actual = (quarter: string, epsKRW: number): QuarterlyActual => ({
  ticker: "005930", quarter, epsKRW, scope: "provider_default", epsBasis: "unspecified", observedAt: "2026-10-01T00:00:00Z", sourceUrl: "https://m.stock.naver.com/api/stock/005930/finance/quarter",
});

/** Every weekday of the quarter at the given close (newest first, like the collector). */
function sessions(q: string, close: (i: number) => number): DailyClose[] {
  const { start, end } = quarterBounds(q);
  const out: DailyClose[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`), i = 0; t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push({ date: d.toISOString().slice(0, 10), closeKRW: close(i++) });
  }
  return out.reverse();
}

const ACTUALS = [actual("2025Q3", 1783), actual("2025Q4", 2864), actual("2026Q1", 6993), actual("2026Q2", 10718)];

describe("quarter helpers", () => {
  it("shifts across years and bounds quarters", () => {
    expect(shiftQuarter("2026Q1", -1)).toBe("2025Q4");
    expect(shiftQuarter("2025Q4", 1)).toBe("2026Q1");
    expect(shiftQuarter("2026Q3", -4)).toBe("2025Q3");
    expect(quarterBounds("2026Q2")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
  });
});

describe("PER-hold next-quarter price", () => {
  it("holds the base quarter's P/E and moves price only with trailing EPS", () => {
    const closes = [...sessions("2026Q3", () => 270_000), ...sessions("2026Q2", () => 200_000)];
    const r = computeNextQuarterPrice({ bridge: bridge("2026Q3", 13_616), quarterlyActuals: ACTUALS, dailyCloses: closes });
    expect(r.status).toBe("available");
    expect(r.baseQuarter).toBe("2026Q2");
    expect(r.base?.averageCloseKRW).toBe(200_000);
    const baseTtm = 1783 + 2864 + 6993 + 10718; // 22,358
    const targetTtm = 2864 + 6993 + 10718 + 13616; // 34,191
    expect(r.baseTtmEpsKRW).toBe(baseTtm);
    expect(r.targetTtmEpsKRW).toBe(targetTtm);
    expect(r.impliedPer).toBeCloseTo(200_000 / baseTtm, 2);
    expect(r.fairPriceKRW).toBe(Math.round((200_000 / baseTtm) * targetTtm));
    expect(r.changeVsBaseAveragePct).toBeCloseTo((targetTtm / baseTtm - 1) * 100, 2);
    expect(r.ttmComponents.map((c) => `${c.quarter}:${c.kind}`)).toEqual(["2025Q4:actual", "2026Q1:actual", "2026Q2:actual", "2026Q3:forecast"]);
    expect(r.latestClose?.closeKRW).toBe(270_000);
    expect(r.latestClose?.changeToFairPct).toBeCloseTo((r.fairPriceKRW! / 270_000 - 1) * 100, 2);
  });

  it("uses the average of the base quarter only", () => {
    const closes = sessions("2026Q2", (i) => (i % 2 ? 110 : 90));
    const r = computeNextQuarterPrice({ bridge: bridge("2026Q3", 100), quarterlyActuals: [actual("2025Q3", 100), actual("2025Q4", 100), actual("2026Q1", 100), actual("2026Q2", 100)], dailyCloses: closes });
    expect(r.base?.averageCloseKRW).toBeCloseTo(100, 0);
    expect(r.fairPriceKRW).toBe(Math.round(r.base!.averageCloseKRW)); // unchanged EPS -> unchanged price
    expect(r.changeVsBaseAveragePct).toBe(0);
  });

  it("is unavailable, never guessed, when inputs are missing or EPS is not positive", () => {
    const closes = sessions("2026Q2", () => 100);
    expect(computeNextQuarterPrice({ bridge: null, quarterlyActuals: ACTUALS, dailyCloses: closes }).reasons[0]?.code).toBe("NO_FORECAST");
    expect(computeNextQuarterPrice({ bridge: bridge("2026Q3", 1), quarterlyActuals: ACTUALS.slice(1), dailyCloses: closes }).reasons.map((r) => r.code)).toEqual(["ACTUAL_EPS_MISSING"]);
    expect(computeNextQuarterPrice({ bridge: bridge("2026Q3", 1), quarterlyActuals: ACTUALS, dailyCloses: closes.slice(0, 20) }).reasons[0]?.code).toBe("BASE_PRICES_INCOMPLETE");
    const losses = [actual("2025Q3", -50), actual("2025Q4", -50), actual("2026Q1", 10), actual("2026Q2", 10)];
    expect(computeNextQuarterPrice({ bridge: bridge("2026Q3", 100), quarterlyActuals: losses, dailyCloses: closes }).reasons[0]?.code).toBe("NON_POSITIVE_BASE_EPS");
    const r = computeNextQuarterPrice({ bridge: bridge("2026Q3", -500), quarterlyActuals: ACTUALS.map((a) => ({ ...a, epsKRW: 100 })), dailyCloses: closes });
    expect(r.status).toBe("unavailable");
    expect(r.reasons[0]?.code).toBe("NON_POSITIVE_TARGET_EPS");
    expect(r.fairPriceKRW).toBeNull();
  });
});

describe("Naver inputs for the price", () => {
  const table = {
    itemCode: "005930",
    financePeriodType: "quarter",
    financeInfo: {
      itemCode: "005930",
      trTitleList: [{ key: "202603", isConsensus: "N" }, { key: "202606", isConsensus: "N" }, { key: "202609", isConsensus: "Y" }],
      rowList: [{ title: "EPS", columns: { "202603": { value: "6,993" }, "202606": { value: "10,718" }, "202609": { value: "13,616" } } }],
    },
  };

  it("parses only reported (N) quarters as actual EPS", () => {
    expect(parseQuarterlyActuals(table, "005930", "2026-09-28T03:00:00Z").map((a) => [a.quarter, a.epsKRW])).toEqual([["2026Q1", 6993], ["2026Q2", 10718]]);
  });
});
