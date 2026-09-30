import { describe, expect, it } from "vitest";
import { relaxDataset } from "../src/domain/relax.js";
import { AuditSchema, ProposalSchema } from "../src/intelligence/types.js";
import { verifyProposal } from "../src/intelligence/verify.js";
import { analyze } from "../src/model/model.js";
import { JobManager } from "../src/research/jobs.js";
import { AS_OF, makeDataset } from "../test/fixture.js";

const proposal = (dataset: unknown) => ({ dataset, missingFields: [], narrative: { product: "p", industry: "i" }, citations: [], assumptions: [], limitations: [] });

describe("verifier: soft issues keep a provisional dataset", () => {
  it("uncited numbers / unsupplied sources null the verified dataset but keep the provisional one", () => {
    const v = verifyProposal(AS_OF, "111110", [], proposal(makeDataset()));
    expect(v.dataset).toBeNull();
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["NUMBER_UNCITED", "SOURCE_NOT_SUPPLIED"]));
    expect(v.provisionalDataset?.company.ticker).toBe("111110");
  });

  it("a wrong ticker, synthetic data or a future date leaves no provisional dataset", () => {
    expect(verifyProposal(AS_OF, "222220", [], proposal(makeDataset())).provisionalDataset).toBeNull();
    expect(verifyProposal(AS_OF, "111110", [], proposal({ ...makeDataset(), synthetic: true })).provisionalDataset).toBeNull();
    const future = makeDataset();
    future.quote.asOf = "2026-02-01";
    expect(verifyProposal(AS_OF, "111110", [], proposal(future)).provisionalDataset).toBeNull();
  });
});

describe("model replies: over-long prose is truncated, not rejected", () => {
  it("accepts a disagreement longer than 500 characters (was SCHEMA_INVALID)", () => {
    const r = AuditSchema.safeParse({ approved: false, claims: [{ fieldPath: "quote.priceKRW", verdict: "rejected", note: "n".repeat(900) }], disagreements: ["x".repeat(1200)], missingFields: [], summary: "s".repeat(5000) });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.disagreements[0]).toHaveLength(500);
    expect(r.data.disagreements[0]!.endsWith("…")).toBe(true);
    expect(r.data.claims[0]!.note).toHaveLength(500);
    expect(r.data.summary).toHaveLength(4000);
  });

  it("truncates over-long lists and draft prose, but keeps verbatim fields strict", () => {
    const p = ProposalSchema.safeParse({ ...proposal(null), missingFields: Array.from({ length: 80 }, (_, i) => `f${i}`), narrative: { product: "p".repeat(5000), industry: "i" } });
    expect(p.success).toBe(true);
    if (p.success) expect([p.data.missingFields.length, p.data.narrative.product.length]).toEqual([50, 4000]);
    const bad = ProposalSchema.safeParse({ ...proposal(null), citations: [{ fieldPath: "x", documentId: "d", url: "u", publishedAt: "2026-01-01", evidenceQuote: "q".repeat(1001) }] });
    expect(bad.success).toBe(false);
  });
});

describe("relaxDataset", () => {
  it("drops quarters that had not ended by asOf when enough history remains", () => {
    const ds = makeDataset();
    const src = { title: "late", manualReference: "x", publishedAt: "2026-01-12" };
    ds.markets[0]!.observations.push({ quarter: "2026Q1", revenue: 1e9, basis: "quarterly", source: src });
    const r = relaxDataset(ds, AS_OF);
    expect(r.hard).toEqual([]);
    expect(r.repairs.map((x) => x.code)).toContain("UNFINISHED_QUARTERS_DROPPED");
    expect(r.dataset.markets[0]!.observations.at(-1)!.quarter).toBe("2025Q4");
  });

  it("keeps look-ahead that cannot be dropped as a hard issue", () => {
    const ds = makeDataset();
    ds.financials.quarter = "2026Q1";
    expect(relaxDataset(ds, AS_OF).hard.map((i) => i.code)).toContain("FUTURE_EVIDENCE");
  });
});

describe("model: stale competitor anchors", () => {
  it("leaves out a competitor whose latest share is older than the input staleness limit", () => {
    const ds = makeDataset();
    const src = { title: "c", manualReference: "x", publishedAt: "2025-05-15" };
    ds.markets[0]!.observations.unshift(
      { quarter: "2024Q3", revenue: 1e9, basis: "quarterly", source: { ...src, publishedAt: "2024-11-15" } },
      { quarter: "2024Q4", revenue: 1e9, basis: "quarterly", source: { ...src, publishedAt: "2025-02-15" } },
    );
    ds.competitors = [
      { id: "old", name: "Old", marketId: "m1", revenue: [{ quarter: "2024Q3", revenue: 5e8, currency: "USD", basis: "quarterly", source: { ...src, publishedAt: "2024-11-15" } }] },
      { id: "fresh", name: "Fresh", marketId: "m1", revenue: [{ quarter: "2025Q4", revenue: 3e8, currency: "USD", basis: "quarterly", source: { ...src, publishedAt: "2026-01-10" } }] },
    ];
    const a = analyze(ds, AS_OF); // target 2026Q2: 2024Q3 is 7 quarters back
    const s = a.scenarios[1]!.products[0]!.structure;
    expect(s.competitors.map((c) => c.competitorId)).toEqual(["fresh"]);
    expect(a.dataQuality.warnings.join(" ")).toMatch(/Competitor old's latest share \(2024Q3\)/);
  });
});

describe("JobManager slots", () => {
  it("keeps a timed-out job's slot until its work actually settles", async () => {
    const jm = new JobManager({ maxRunning: 1, maxPending: 5, maxRetained: 10, ttlMs: 60_000, jobTimeoutMs: 10 });
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    const a = jm.submit("analysis", "a", {}, async () => { await hung; return { status: "completed" }; }); // ignores the abort signal
    await new Promise((r) => setTimeout(r, 30));
    expect(jm.get(a.job.id, "analysis")?.outcome?.error?.code).toBe("JOB_TIMEOUT");
    const b = jm.submit("analysis", "b", {}, async () => ({ status: "completed" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(b.job.status).toBe("queued"); // the abandoned work still runs: no second concurrent job
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(b.job.status).toBe("completed");
  });
});
