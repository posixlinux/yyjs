import { describe, expect, it } from "vitest";
import { DatasetSchema, type Dataset } from "../src/domain/schema.js";
import { validateAsOf, validateStatic } from "../src/domain/validate.js";
import { AS_OF, makeDataset } from "./fixture.js";

const codes = (ds: Dataset, asOf = AS_OF) => [...validateStatic(ds), ...validateAsOf(ds, asOf)].map((i) => i.code);
const mutate = (fn: (ds: Dataset) => void) => {
  const ds = makeDataset();
  fn(ds);
  return ds;
};

describe("evidence dates", () => {
  it("rejects a source published after the analysis date", () => {
    expect(codes(mutate((d) => (d.markets[0].annualGrowth.source.publishedAt = "2026-01-16")))).toContain("FUTURE_EVIDENCE");
  });
  it("rejects a quote dated after the analysis date", () => {
    expect(codes(mutate((d) => (d.quote.asOf = "2026-01-20")))).toContain("FUTURE_EVIDENCE");
  });
  it("rejects a market quarter that has not ended by asOf", () => {
    const ds = mutate((d) => {
      const o = d.markets[0].observations;
      o.push({ ...o[3], quarter: "2026Q1", source: { ...o[3].source, publishedAt: "2026-01-10" } });
    });
    expect(codes(ds)).toContain("FUTURE_EVIDENCE");
  });
  it("rejects a stale quote, fx, share count, source and market observation", () => {
    expect(codes(mutate((d) => (d.quote.asOf = "2025-12-01")))).toContain("STALE_EVIDENCE");
    expect(codes(mutate((d) => (d.fx[0].asOf = "2025-11-01")))).toContain("STALE_EVIDENCE");
    expect(codes(mutate((d) => (d.shares.asOf = "2025-01-01")))).toContain("STALE_EVIDENCE");
    expect(codes(mutate((d) => (d.company.sources[0].publishedAt = "2023-01-01")))).toContain("STALE_EVIDENCE");
    expect(codes(makeDataset(), "2026-12-31")).toContain("STALE_EVIDENCE"); // 2025Q4 is 5 quarters before 2027Q1
  });
  it("rejects a source published before the observed quarter ended", () => {
    expect(codes(mutate((d) => (d.markets[0].observations[3].source.publishedAt = "2025-11-01")))).toContain("SOURCE_BEFORE_PERIOD_END");
  });
});

describe("data consistency", () => {
  it("rejects annual figures and suspicious annual/quarterly jumps", () => {
    expect(codes(mutate((d) => (d.markets[0].observations[3].basis = "annual")))).toContain("ANNUAL_QUARTERLY_CONFUSION");
    expect(codes(mutate((d) => (d.markets[0].observations[3].revenue = 4e9)))).toContain("ANNUAL_QUARTERLY_CONFUSION");
  });
  it("rejects gaps and duplicates in the quarterly series", () => {
    expect(codes(mutate((d) => (d.markets[0].observations[2].quarter = "2025Q4")))).toContain("NON_CONSECUTIVE_OBSERVATIONS");
    expect(codes(mutate((d) => d.markets[0].observations.splice(1, 1)))).toContain("NON_CONSECUTIVE_OBSERVATIONS"); // gap
    expect(DatasetSchema.safeParse(mutate((d) => d.markets[0].observations.splice(0, 1))).success).toBe(false); // < 4 quarters of history
  });
  it("rejects a share above 100% (volume/scope/period mixup)", () => {
    expect(codes(mutate((d) => d.products[0].revenue.forEach((r) => (r.revenue = 2e9))))).toContain("INVALID_SHARE");
  });
  it("rejects an observed share outside shareBounds", () => {
    expect(codes(mutate((d) => (d.products[0].shareBounds = { min: 0.2, max: 0.3 })))).toContain("SHARE_OUT_OF_BOUNDS");
  });
  it("rejects product/market currency mismatch and missing fx", () => {
    expect(codes(mutate((d) => (d.products[0].revenue[3].currency = "EUR")))).toContain("CURRENCY_MISMATCH");
    expect(codes(mutate((d) => (d.fx = [])))).toContain("MISSING_FX");
  });
  it("rejects duplicate products and products overlapping in one market", () => {
    const dup = mutate((d) => d.products.push({ ...structuredClone(d.products[0]) }));
    expect(codes(dup)).toEqual(expect.arrayContaining(["DUPLICATE_PRODUCT", "OVERLAPPING_PRODUCT_MARKET"]));
    const overlap = mutate((d) => d.products.push({ ...structuredClone(d.products[0]), id: "p2", name: "Other" }));
    const c = codes(overlap);
    expect(c).toContain("OVERLAPPING_PRODUCT_MARKET");
    expect(c).not.toContain("DUPLICATE_PRODUCT");
  });
  it("rejects missing coverage for the financials quarter", () => {
    expect(codes(mutate((d) => (d.financials.quarter = "2025Q3")))).not.toContain("MISSING_COVERAGE");
    expect(codes(mutate((d) => d.products[0].revenue.pop()))).toContain("MISSING_COVERAGE");
  });
  it("requires a residual when coverage < 98%, and refuses coverage < 50% or > 100%", () => {
    expect(codes(mutate((d) => delete d.residual))).toContain("RESIDUAL_REQUIRED");
    expect(codes(mutate((d) => (d.financials.totalRevenueKRW = 1.0e11)))).toEqual([]); // 100% coverage needs no residual
    expect(codes(mutate((d) => { d.financials.totalRevenueKRW = 1.0e11; delete d.residual; }))).toEqual([]);
    expect(codes(mutate((d) => (d.financials.totalRevenueKRW = 2.5e11)))).toContain("COVERAGE_INSUFFICIENT"); // 40%
    expect(codes(mutate((d) => (d.financials.totalRevenueKRW = 9e10)))).toContain("COVERAGE_EXCEEDS_TOTAL");
  });
  it("requires seasonality indices to average 1", () => {
    expect(codes(mutate((d) => (d.markets[0].seasonality.value = { q1: 1.2, q2: 1.2, q3: 1.2, q4: 1.2 })))).toContain("SEASONALITY_NOT_NORMALISED");
  });
});

describe("schema", () => {
  const parse = (fn: (ds: any) => void) => {
    const ds = structuredClone(makeDataset()) as any;
    fn(ds);
    return DatasetSchema.safeParse(ds).success;
  };
  it("accepts the fixture", () => expect(parse(() => {})).toBe(true));
  it("requires exchange KOSPI and a six-digit ticker", () => {
    expect(parse((d) => (d.company.exchange = "KOSDAQ"))).toBe(false);
    expect(parse((d) => (d.company.ticker = "5930"))).toBe(false);
  });
  it("requires source url or manual reference, and a real date", () => {
    expect(parse((d) => delete d.quote.source.manualReference)).toBe(false);
    expect(parse((d) => (d.quote.source = { title: "x", url: "https://example.com/q", publishedAt: "2026-01-10" }))).toBe(true);
    expect(parse((d) => (d.quote.source = { title: "x", url: "file:///etc/passwd", publishedAt: "2026-01-10" }))).toBe(false);
    expect(parse((d) => (d.quote.source.publishedAt = "2026-02-30"))).toBe(false);
  });
  it("rejects missing sources on assumptions, unordered scenarios, out-of-range values and unknown keys", () => {
    expect(parse((d) => delete d.valuation.peMultiple.source)).toBe(false);
    expect(parse((d) => (d.valuation.peMultiple.value = { bear: 12, base: 10, bull: 15 }))).toBe(false);
    expect(parse((d) => (d.markets[0].annualGrowth.value.bull = 5))).toBe(false);
    expect(parse((d) => (d.extra = 1))).toBe(false);
  });
});
