import { describe, expect, it } from "vitest";
import { DatasetSchema, type Dataset } from "../src/domain/schema.js";
import { validateAsOf, validateStatic } from "../src/domain/validate.js";
import { analyze, assertFinite } from "../src/model/model.js";
import { AS_OF, makeDataset } from "./fixture.js";

const codes = (ds: Dataset) => [...validateStatic(ds), ...validateAsOf(ds, AS_OF)].map((i) => i.code);
const mutate = (fn: (ds: Dataset) => void) => {
  const ds = makeDataset();
  fn(ds);
  return ds;
};
const parses = (fn: (d: any) => void) => {
  const d = structuredClone(makeDataset()) as any;
  fn(d);
  return DatasetSchema.safeParse(d).success;
};

describe("financial review fixes: validation", () => {
  it("rejects sources published before the period/date they report", () => {
    expect(codes(mutate((d) => (d.financials.source.publishedAt = "2025-12-30")))).toContain("SOURCE_BEFORE_PERIOD_END");
    expect(codes(mutate((d) => (d.quote.source.publishedAt = "2026-01-09")))).toContain("SOURCE_BEFORE_PERIOD_END");
    expect(codes(mutate((d) => (d.shares.source.publishedAt = "2025-12-30")))).toContain("SOURCE_BEFORE_PERIOD_END");
    expect(codes(mutate((d) => (d.fx[0].source.publishedAt = "2026-01-09")))).toContain("SOURCE_BEFORE_PERIOD_END");
  });

  it("checks revenue <= market for EVERY overlapping quarter, not just the latest", () => {
    expect(codes(mutate((d) => (d.products[0].revenue[1].revenue = 2e9)))).toContain("INVALID_SHARE"); // 2025Q2 only
  });

  it("requires explicit residual assumptions for any material uncovered revenue (no silent 2% drop)", () => {
    const uncovered1pct = (d: Dataset) => (d.financials.totalRevenueKRW = 1.01e11);
    expect(codes(mutate((d) => { uncovered1pct(d); delete d.residual; }))).toContain("RESIDUAL_REQUIRED");
    expect(codes(mutate((d) => uncovered1pct(d)))).toEqual([]); // with a residual it is fine
    // only rounding noise (< 0.01%) may stay uncovered without a residual segment
    expect(codes(mutate((d) => { d.financials.totalRevenueKRW = 1e11 * (1 + 5e-5); delete d.residual; }))).toEqual([]);
  });

  it("rejects unused markets and textual duplicate markets/products", () => {
    const extra = (d: Dataset, over: object) => d.markets.push({ ...structuredClone(d.markets[0]), id: "m2", ...over });
    expect(codes(mutate((d) => extra(d, { name: "Other market", scope: "Something else entirely" })))).toContain("UNUSED_MARKET");
    expect(codes(mutate((d) => extra(d, { name: "MARKET-1!", scope: "different" })))).toContain("DUPLICATE_MARKET");
    expect(codes(mutate((d) => extra(d, { name: "Other", scope: "global  WIDGETS, revenue; USD" })))).toContain("DUPLICATE_MARKET");
    expect(codes(mutate((d) => d.products.push({ ...structuredClone(d.products[0]), id: "p2", name: "product   1" })))).toContain("DUPLICATE_PRODUCT");
  });

  it("requires a rationale on the earnings bridge and only knows preferredClaimsKRW", () => {
    expect(parses((d) => delete d.earningsBridge.rationale)).toBe(false);
    expect(parses((d) => { d.earningsBridge.value.preferredDividendsKRW = 0; })).toBe(false); // old name is an unknown key
    expect(parses((d) => delete d.earningsBridge.value.preferredClaimsKRW)).toBe(false);
  });

  it("rejects non-finite and overflow-prone magnitudes", () => {
    expect(parses((d) => (d.financials.totalRevenueKRW = 1e19))).toBe(false);
    expect(parses((d) => (d.markets[0].observations[0].revenue = Infinity))).toBe(false);
    expect(parses((d) => (d.quote.priceKRW = NaN))).toBe(false);
    expect(parses((d) => (d.earningsBridge.value.netInterestKRW = -1e19))).toBe(false);
    expect(parses((d) => (d.fx[0].krwPerUnit = 1e12))).toBe(false);
  });
});

describe("financial review fixes: model output", () => {
  it("reports observed latest QoQ / YoY separately from the projection", () => {
    const ds = makeDataset();
    ds.markets[0].observations = [
      { ...ds.markets[0].observations[0], quarter: "2024Q4", revenue: 8e8, source: { ...ds.markets[0].observations[0].source, publishedAt: "2025-02-15" } },
      ...ds.markets[0].observations,
    ];
    ds.markets[0].observations[4].revenue = 1.2e9; // 2025Q4, +20% QoQ
    const a = analyze(ds, AS_OF);
    const m = a.facts.markets[0].observedLatest;
    expect(m).toMatchObject({ quarter: "2025Q4", qoqFromQuarter: "2025Q3", yoyFromQuarter: "2024Q4" });
    expect(m.qoqPct).toBeCloseTo(20, 9);
    expect(m.yoyPct).toBeCloseTo(50, 9);
    const p = a.scenarios[1].products[0];
    expect(p.marketVsLatestObservedPct).toBeCloseTo((1.1 ** 0.25 - 1) * 100, 9); // projection vs observed, labelled separately
    expect(p.marketYoYPct).toBeCloseTo(((1.2 * 1.1 ** 0.25) / 1 - 1) * 100, 9); // target 2026Q1 vs observed 2025Q1 (1e9)
  });

  it("YoY of observed data is null with fewer than 5 quarters", () => {
    expect(analyze(makeDataset(), AS_OF).facts.markets[0].observedLatest.yoyPct).toBeNull();
  });

  it("ranks products by company revenue contribution in the financials quarter", () => {
    const ds = makeDataset();
    ds.markets.push({ ...structuredClone(ds.markets[0]), id: "m2", name: "Market 2", scope: "Global gadgets, revenue, USD" });
    ds.markets[1].observations.forEach((o) => (o.revenue = 3e9));
    ds.products.push({ ...structuredClone(ds.products[0]), id: "p2", name: "Product 2", marketId: "m2" });
    ds.products[1].revenue.forEach((r) => (r.revenue = 3e8));
    ds.financials.totalRevenueKRW = 4.25e11;
    const c = analyze(ds, AS_OF).facts.productContribution;
    expect(c.map((x) => x.productId)).toEqual(["p2", "p1"]);
    expect(c[0]).toMatchObject({ rank: 1, quarter: "2025Q4" });
    expect(c[0].revenueKRW).toBeCloseTo(3e11, 0);
    expect(c[0].shareOfCompanyRevenue).toBeCloseTo(3e11 / 4.25e11, 9);
  });

  it("assertFinite rejects NaN/Infinity anywhere in a result", () => {
    expect(() => assertFinite({ a: [1, { b: Infinity }] })).toThrowError(/non-finite/);
    expect(() => assertFinite({ a: [1, { b: NaN }] })).toThrowError(/\$\.a\[1\]\.b/);
    expect(() => assertFinite({ a: 1, b: null, c: "x" })).not.toThrow();
  });

  it("stays finite (JSON round-trips numerically) at the largest accepted magnitudes", () => {
    const ds = makeDataset();
    ds.fx[0].krwPerUnit = 1e9;
    ds.markets[0].observations.forEach((o) => (o.revenue = 1e18));
    ds.products[0].revenue.forEach((r) => (r.revenue = 1e17));
    ds.financials.totalRevenueKRW = 1e18;
    ds.shares.dilutedCommon = 1;
    const a = analyze(ds, AS_OF);
    const round = JSON.parse(JSON.stringify(a));
    expect(round.scenarios[2].totals.revenueKRW).toBe(a.scenarios[2].totals.revenueKRW);
  });
});
