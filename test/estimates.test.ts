import { describe, expect, it } from "vitest";
import { adjustEstimatedMarkets, groundedness, listEstimates, observedStructures } from "../src/domain/market-structure.js";
import { DatasetSchema, type Dataset } from "../src/domain/schema.js";
import { validateAsOf, validateStatic } from "../src/domain/validate.js";
import { analyze } from "../src/model/model.js";
import { AS_OF, makeDataset } from "./fixture.js";

const src = (title: string, publishedAt: string) => ({ title, manualReference: "test-fixture", publishedAt });
const est = (basedOn: string[] = ["products[0].revenue[3].revenue"]) => ({ method: "share_implied" as const, basedOn, rationale: "company says it holds about 10% of the market" });
const tri = (a: number, b: number, c: number) => ({ bear: a, base: b, bull: c });
const QUARTERS = ["2025Q1", "2025Q2", "2025Q3", "2025Q4"];

/** market m1 = 1e9/quarter (fixture); company 1e8 (10%). Adds two competitors (3e8 and 2e8) => others 4e8. */
function withCompetitors(over: { rev?: number[]; delta?: ReturnType<typeof tri> } = {}): Dataset {
  const ds = makeDataset();
  const mk = (id: string, name: string, revenue: number, delta?: ReturnType<typeof tri>) => ({
    id, name, marketId: "m1",
    revenue: QUARTERS.map((q) => ({ quarter: q, revenue, currency: "USD", basis: "quarterly" as const, source: src(`${name} ${q}`, "2026-01-10") })),
    ...(delta && { shareDelta: { value: delta, source: src("delta", "2025-12-20") } }),
  });
  ds.competitors = [mk("c1", "Alpha", over.rev?.[0] ?? 3e8, over.delta), mk("c2", "Beta", over.rev?.[1] ?? 2e8)];
  return ds;
}

const base = (ds: Dataset) => analyze(ds, AS_OF).scenarios.find((s) => s.scenario === "base")!;

describe("estimates in the schema", () => {
  it("accepts an estimate marker on market, product and competitor revenue, and lists them", () => {
    const ds = withCompetitors();
    ds.markets[0]!.observations[3]!.estimate = est();
    ds.products[0]!.revenue[3]!.estimate = { method: "segment_allocation", basedOn: ["doc-1"], rationale: "carved out of the reported segment" };
    ds.competitors![0]!.revenue[3]!.estimate = { method: "model_knowledge", basedOn: [], rationale: "analyst knowledge, no supplied document" };
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    expect(listEstimates(ds).map((e) => `${e.kind}:${e.estimate.method}`)).toEqual(["market:share_implied", "product:segment_allocation", "competitor:model_knowledge"]);
    expect(groundedness(ds)).toMatchObject({ total: 4 + 4 + 8, estimated: 3 });
  });

  it("rejects unknown estimate methods, an empty rationale and unknown keys", () => {
    const bad = (e: unknown) => { const ds = makeDataset() as any; ds.markets[0].observations[3].estimate = e; return DatasetSchema.safeParse(ds).success; };
    expect(bad({ method: "guess", basedOn: [], rationale: "x" })).toBe(false);
    expect(bad({ method: "share_implied", basedOn: [], rationale: "" })).toBe(false);
    expect(bad({ method: "share_implied", basedOn: [], rationale: "x", confidence: 1 })).toBe(false);
  });
});

describe("competitors and the sum of all players", () => {
  it("valid competitors pass validation; observed structure = company + competitors + others", () => {
    const ds = withCompetitors();
    expect(validateStatic(ds)).toEqual([]);
    expect(validateAsOf(ds, AS_OF)).toEqual([]);
    const s = observedStructures(ds)[0]!;
    expect(s.quarter).toBe("2025Q4");
    expect(s.company).toMatchObject({ revenue: 1e8, share: 0.1 });
    expect(s.competitors.map((c) => [c.name, c.share])).toEqual([["Alpha", 0.3], ["Beta", 0.2]]);
    expect(s.others.revenue).toBeCloseTo(4e8);
    expect(s.identifiedCoverage).toBeCloseTo(0.6);
  });

  it("projected structure always adds up to the projected market (company + competitors + others)", () => {
    const p = base(withCompetitors()).products[0]!;
    const st = p.structure;
    expect(st.company.share).toBeCloseTo(0.1);
    expect(st.competitors.map((c) => c.share)).toEqual([expect.closeTo(0.3), expect.closeTo(0.2)]);
    expect(st.others.share).toBeCloseTo(0.4);
    expect(st.partsSumMarketRevenue).toBeCloseTo(st.marketRevenue, 3);
    expect(st.competitorsScaled).toBe(false);
    expect(st.bottomUpBeforeScalingPct).toBeCloseTo(60);
  });

  it("competitors that would overshoot the market are scaled down so the parts still sum to the total", () => {
    // company share 10% (bounds up to 20%); Alpha +0.7 => raw sum 1.7 > room 0.9
    const ds = withCompetitors({ rev: [3e8, 2e8], delta: tri(0.7, 0.7, 0.7) });
    const st = base(ds).products[0]!.structure;
    expect(st.competitorsScaled).toBe(true);
    expect(st.others.share).toBeCloseTo(0);
    expect(st.partsSumMarketRevenue).toBeCloseTo(st.marketRevenue, 3);
    expect(st.competitors.reduce((t, c) => t + c.share, 0) + st.company.share).toBeCloseTo(1);
    expect(st.bottomUpBeforeScalingPct).toBeGreaterThan(100);
  });

  it("named players above a REPORTED market total are rejected (PLAYERS_EXCEED_MARKET)", () => {
    const codes = validateStatic(withCompetitors({ rev: [8e8, 2e8] })).map((i) => i.code);
    expect(codes).toContain("PLAYERS_EXCEED_MARKET");
  });

  it("competitor consistency: unknown market, duplicate id, currency mismatch", () => {
    const ds = withCompetitors();
    ds.competitors![1]!.id = "c1";
    ds.competitors![0]!.marketId = "nope";
    ds.competitors![1]!.revenue[0]!.currency = "EUR";
    const codes = validateStatic(ds).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["DUPLICATE_COMPETITOR", "COMPETITOR_MARKET_UNKNOWN", "CURRENCY_MISMATCH"]));
  });
});

describe("estimated market totals", () => {
  it("an ESTIMATED total below the named players is lifted to their sum (reported, idempotent) instead of failing", () => {
    const ds = withCompetitors({ rev: [8e8, 2e8] }); // players = 1.1e9 > market 1e9 in every quarter
    for (const o of ds.markets[0]!.observations) o.estimate = est();
    const { dataset, adjustments } = adjustEstimatedMarkets(ds);
    expect(adjustments).toHaveLength(4);
    expect(dataset.markets[0]!.observations[3]!.revenue).toBeCloseTo(1.1e9);
    expect(ds.markets[0]!.observations[3]!.revenue).toBe(1e9); // input untouched
    expect(adjustEstimatedMarkets(dataset).adjustments).toEqual([]);
    expect(validateStatic(ds).map((i) => i.code)).not.toContain("PLAYERS_EXCEED_MARKET");
    const a = analyze(ds, AS_OF);
    expect(a.dataQuality.adjustments).toHaveLength(4);
    expect(a.dataQuality.warnings.join(" ")).toMatch(/lifted to the sum/);
  });

  it("the analysis reports how much of the input is estimated", () => {
    const ds = withCompetitors();
    ds.markets[0]!.observations[3]!.estimate = est();
    ds.competitors![0]!.revenue[3]!.estimate = { method: "model_knowledge", basedOn: [], rationale: "analyst knowledge" };
    const q = analyze(ds, AS_OF).dataQuality;
    expect(q.estimates.map((e) => [e.kind, e.method])).toEqual([["market", "share_implied"], ["competitor", "model_knowledge"]]);
    expect(q.groundedness).toMatchObject({ estimated: 2, total: 16 });
    expect(q.warnings.join(" ")).toMatch(/2 of 16 revenue inputs.*ESTIMATES/);
    expect(analyze(makeDataset(), AS_OF).dataQuality.estimates).toEqual([]);
  });

  it("estimates do not change the arithmetic: same numbers with or without the marker", () => {
    const a = withCompetitors();
    const b = withCompetitors();
    b.markets[0]!.observations[3]!.estimate = est();
    expect(base(b).valuation).toEqual(base(a).valuation);
  });
});
