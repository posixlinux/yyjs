import { describe, expect, it } from "vitest";
import { evaluateAutoStrategy } from "../src/strategy/auto.js";
import { DECISION_AT, makeCatalyst, makeConsensus, makeForecast, makeFunding } from "../test/strategy/fixture.js";

// Unit coverage for the automatic single-candidate path (src/strategy/auto.ts): given whatever the intelligence
// module could verify for one ticker, does it compute a genuinely useful complete OR partial result without ever
// inventing a portfolio, and without silently masking missing pieces as eligible/zero?

const TICKER = "999990";
const base = () => ({
  ticker: TICKER,
  decisionAt: DECISION_AT,
  mode: "live" as const,
  forecast: makeForecast(),
  currentConsensus: makeConsensus({ epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00" }),
  priorConsensus: makeConsensus({ epsPerShare: 6, knownAt: "2025-12-06T00:00:00+09:00" }),
  catalyst: makeCatalyst(),
  unavailable: [],
  minimumCashBufferKRW: 0,
  cashBufferConfigured: true,
});

describe("evaluateAutoStrategy: complete-data path", () => {
  it("produces a bridge, risk, and a full eligible evaluation when every piece is present and consistent", () => {
    const r = evaluateAutoStrategy(base());
    expect(r.status).toBe("eligible");
    expect(r.bridge!.ntmEpsKRW).toBeCloseTo(8);
    expect(r.risk).not.toBeNull();
    expect(r.risk!.base.peakAdditionalFundingRequiredKRW).toBeDefined();
    expect(r.evaluation).toMatchObject({ eligible: true, gapPct: expect.closeTo(8 / 7 - 1, 5), revisionPct: expect.closeTo(7 / 6 - 1, 5) });
    expect(r.missing).toEqual([]);
  });

  it("never computes or exposes a position weight/budget (no invented portfolio)", () => {
    const r = evaluateAutoStrategy(base());
    expect(JSON.stringify(r.evaluation)).not.toMatch(/"weight"|"budgetKRW"/);
  });
});

describe("evaluateAutoStrategy: genuinely useful partial path", () => {
  it("missing consensus: bridge and funding risk stay visible, no eligibility number is fabricated", () => {
    const r = evaluateAutoStrategy({ ...base(), currentConsensus: null, priorConsensus: null });
    expect(r.status).toBe("insufficient_data");
    expect(r.bridge!.ntmEpsKRW).toBeCloseTo(8); // earnings bridge is independent of consensus
    expect(r.risk).not.toBeNull(); // funding risk is independent of consensus too
    expect(r.evaluation).toBeNull();
    expect(r.missing.map((m) => m.field)).toEqual(expect.arrayContaining(["currentConsensus", "priorConsensus"]));
  });

  it("missing funding: risk is unavailable (never treated as zero), forecast/eligibility still run", () => {
    const forecast = makeForecast({ funding: undefined });
    const r = evaluateAutoStrategy({ ...base(), forecast });
    expect(r.risk).toBeNull();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "funding", code: "FUNDING_UNAVAILABLE" }));
    // eligibility still runs on the other three pieces; risk data missing makes it explicitly ineligible, not silently passed
    expect(r.status).toBe("ineligible");
    expect(r.evaluation!.eligible).toBe(false);
    expect((r.evaluation as any).reasons.map((x: any) => x.code)).toContain("RISK_DATA_MISSING");
  });

  it("no forecast at all: nothing is fabricated, every dependent piece is reported unavailable", () => {
    const r = evaluateAutoStrategy({ ...base(), forecast: null });
    expect(r.status).toBe("insufficient_data");
    expect(r.bridge).toBeNull();
    expect(r.risk).toBeNull();
    expect(r.evaluation).toBeNull();
    expect(r.missing.map((m) => m.field)).toContain("forecast");
  });

  it("flags an unconfigured cash buffer explicitly instead of silently assuming one", () => {
    const configured = evaluateAutoStrategy(base());
    expect(configured.notes.join(" ")).not.toMatch(/minimumCashBufferKRW is not configured/);
    const unconfigured = evaluateAutoStrategy({ ...base(), cashBufferConfigured: false });
    expect(unconfigured.notes.join(" ")).toMatch(/minimumCashBufferKRW is not configured/);
  });

  it("propagates upstream intelligence drop reasons (e.g. invented provenance rejected) into `missing`", () => {
    const r = evaluateAutoStrategy({
      ...base(),
      currentConsensus: null,
      unavailable: [{ field: "currentConsensus", code: "EPS_UNCITED", message: "epsPerShare: no citation for this number" }],
    });
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "EPS_UNCITED" }));
  });
});

describe("evaluateAutoStrategy: identity/scope/horizon validation runs BEFORE any bridge/risk is shown", () => {
  it("a forecast for the wrong ticker never produces a bridge, even with consensus null (company check does not require consensus)", () => {
    const wrongTicker = makeForecast({ ticker: "123450" });
    const r = evaluateAutoStrategy({ ...base(), forecast: wrongTicker, currentConsensus: null, priorConsensus: null, catalyst: null });
    expect(r.bridge).toBeNull();
    expect(r.risk).toBeNull();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "forecast", code: "FORECAST_TICKER_MISMATCH" }));
  });

  it("a forecast whose quarters are in the past is never labelled as the next four quarters", () => {
    const pastForecast = makeForecast({ quarters: makeForecast().quarters.map((q) => ({ ...q, quarter: "2024Q2" })) });
    const r = evaluateAutoStrategy({ ...base(), forecast: pastForecast });
    expect(r.bridge).toBeNull();
    expect(r.missing.some((m) => m.field === "forecast" && (m.code === "FORECAST_HORIZON_NOT_NEXT_FOUR" || m.code === "FORECAST_QUARTER_NOT_FUTURE"))).toBe(true);
  });

  it("an invalid debt schedule is caught and degrades to funding-unavailable instead of crashing the whole result", () => {
    const funding = makeFunding();
    funding.quarters[0]!.debtPrincipalDueKRW = 999_999; // far exceeds opening debt + committed draws
    const forecast = makeForecast({ funding });
    expect(() => evaluateAutoStrategy({ ...base(), forecast })).not.toThrow();
    const r = evaluateAutoStrategy({ ...base(), forecast });
    expect(r.risk).toBeNull();
    expect(r.bridge).not.toBeNull(); // the bridge (earnings) survives a bad funding schedule
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "funding", code: "INVALID_DEBT_SCHEDULE" }));
  });

  it("company/scope validation runs even when consensus/catalyst are entirely absent", () => {
    const badScope = makeForecast({ company: undefined });
    const r = evaluateAutoStrategy({ ...base(), forecast: badScope, currentConsensus: null, priorConsensus: null, catalyst: null });
    expect(r.bridge).toBeNull();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "forecast", code: "FORECAST_COMPANY_SCOPE_MISSING" }));
  });
});

describe("evaluateAutoStrategy: source timing validated even for partial (no-consensus) results", () => {
  it("a segment source backdated after the forecast's generatedAt never produces a bridge, even with consensus/catalyst absent", () => {
    const backdated = makeForecast({
      quarters: makeForecast().quarters.map((q, i) =>
        i === 0 ? { ...q, segments: [{ ...q.segments[0]!, source: { ...q.segments[0]!.source, knownAt: "2026-01-11T00:00:00+09:00" } }] } : q,
      ),
    });
    const r = evaluateAutoStrategy({ ...base(), forecast: backdated, currentConsensus: null, priorConsensus: null, catalyst: null });
    expect(r.bridge).toBeNull();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "forecast", code: "FORECAST_SOURCE_AFTER_GENERATION" }));
  });

  it("a company source backdated after generatedAt never produces a bridge", () => {
    const forecast = makeForecast();
    const backdated = { ...forecast, company: { ...forecast.company!, source: { ...forecast.company!.source, knownAt: "2026-01-11T00:00:00+09:00" } } };
    const r = evaluateAutoStrategy({ ...base(), forecast: backdated, currentConsensus: null, priorConsensus: null, catalyst: null });
    expect(r.bridge).toBeNull();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "forecast", code: "FORECAST_SOURCE_AFTER_GENERATION" }));
  });

  it("liquidity known after generatedAt is dropped by itself; the earnings bridge (core forecast) survives", () => {
    const base_ = makeForecast();
    const forecast = { ...base_, liquidity: { ...base_.liquidity!, knownAt: "2026-01-12T00:00:00+09:00", source: { ...base_.liquidity!.source, knownAt: "2026-01-12T00:00:00+09:00" } } };
    const r = evaluateAutoStrategy({ ...base(), forecast });
    expect(r.bridge).not.toBeNull();
    expect(r.forecast!.liquidity).toBeUndefined();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "liquidity", code: "LIQUIDITY_TIME_MISMATCH" }));
  });

  it("funding known after generatedAt is dropped by itself (risk unavailable); the earnings bridge survives", () => {
    const base_ = makeForecast();
    const funding = { ...base_.funding!, assumptions: { ...base_.funding!.assumptions, source: { ...base_.funding!.assumptions.source, knownAt: "2026-01-12T00:00:00+09:00" } } };
    const forecast = { ...base_, funding };
    const r = evaluateAutoStrategy({ ...base(), forecast });
    expect(r.bridge).not.toBeNull();
    expect(r.risk).toBeNull();
    expect(r.forecast!.funding).toBeUndefined();
    expect(r.missing).toContainEqual(expect.objectContaining({ field: "funding", code: "FUNDING_TIME_MISMATCH" }));
  });
});

describe("evaluateAutoStrategy: source-linked assumptions surfaced for the UI, explicitly labelled as LLM estimates", () => {
  it("lists every segment/bridge/funding assumption with fieldPath/rationale/source, marked not independently audited", () => {
    const r = evaluateAutoStrategy(base());
    expect(r.assumptions!.length).toBeGreaterThan(0);
    for (const a of r.assumptions!) {
      expect(a.isModelEstimate).toBe(true);
      expect(a.independentlyAudited).toBe(false);
      expect(a.rationale).toBeTruthy();
      expect(a.source).toBeDefined();
    }
    expect(r.assumptions!.some((a) => a.fieldPath.includes("bridgeAssumptions"))).toBe(true);
    expect(r.assumptions!.some((a) => a.fieldPath.includes("segments[0].assumptions"))).toBe(true);
    expect(r.assumptions!.some((a) => a.fieldPath.includes("funding"))).toBe(true);
  });

  it("is empty (never fabricated) when there is no forecast at all", () => {
    const r = evaluateAutoStrategy({ ...base(), forecast: null });
    expect(r.assumptions).toEqual([]);
  });
});

describe("evaluateAutoStrategy: live vs retrospective mode", () => {
  it("a historical (retrospective) run is explicitly labelled, not shown as a live current judgement", () => {
    const r = evaluateAutoStrategy({ ...base(), mode: "retrospective_research" });
    expect(r.mode).toBe("retrospective_research");
    expect(r.notes.join(" ")).toMatch(/Historical request.*not a live current signal/);
  });

  it("a live run carries no retrospective disclaimer", () => {
    const r = evaluateAutoStrategy(base());
    expect(r.mode).toBe("live");
    expect(r.notes.join(" ")).not.toMatch(/Historical request/);
  });
});
