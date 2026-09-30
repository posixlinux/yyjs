import { describe, expect, it } from "vitest";
import { verifyStrategyDraft } from "../src/intelligence/strategyVerify.js";
import type { Citation, EvidenceDocument } from "../src/intelligence/types.js";

// Unit coverage for the deterministic strategy-extraction verifier (src/intelligence/strategyVerify.ts): the safety
// net that stops a model from fabricating consensus/catalyst provenance or claiming an uncited "observed" number,
// while still allowing genuinely forward-looking forecast segments that are explicitly labelled as assumptions.

const ASOF = "2026-06-30"; // Q2 -> next four quarters are 2026Q3..2027Q2
const HORIZON = ["2026Q3", "2026Q4", "2027Q1", "2027Q2"];
const DOC: EvidenceDocument = {
  id: "d1",
  title: "1H26 report",
  url: "https://dart.fss.or.kr/r/1",
  publishedAt: "2026-05-15",
  text:
    "2026년 2분기 실제 판매량 10개, 평균단가 100원, 변동비 60원, 고정비 100원. " +
    "2026Q3~2027Q2 연결 기준 보통주 희석 컨센서스 EPS 7원. " +
    "실적발표 예정일 2026-08-10.",
};
const OTHER_DOC: EvidenceDocument = { ...DOC, id: "d2", url: "https://news.example.com/other" };
const realSource = (knownAt = "2026-05-15T00:00:00+09:00") => ({ title: "doc", url: DOC.url, kind: "filing" as const, knownAt });
const manualSource = (knownAt = "2026-06-01T00:00:00+09:00") => ({ title: "analyst note", manualReference: "애널리스트 통상 추정", kind: "analyst_report" as const, knownAt });

const quarter = (q: string, segmentOverride: Record<string, unknown> = {}) => ({
  quarter: q,
  segments: [{
    name: "seg", volume: 10, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 100,
    source: realSource(),
    assumptions: { isAssumption: true, rationale: "forward projection based on last quarter", source: realSource() },
    ...segmentOverride,
  }],
  coverageAttestation: { complete: true, statedBy: "model" },
  netInterestKRW: -10, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100,
  bridgeAssumptions: { isAssumption: true, rationale: "held flat from last quarter", source: realSource() },
});
const forecast = (quarterOverrides: Record<number, Record<string, unknown>> = {}) => ({
  schemaVersion: 1, ticker: "005930", scope: "consolidated", sector: "tech", fiscalYearBasis: "calendar", currency: "KRW",
  generatedAt: "2026-06-30T00:00:00+09:00", analyst: "claude",
  quarters: HORIZON.map((q, i) => quarter(q, quarterOverrides[i])),
});
const fundingQuarter = (q: string, over: Record<string, unknown> = {}) => ({
  quarter: q, depreciationAndAmortizationKRW: 10, capexKRW: 10, deltaWorkingCapitalKRW: 0, cashTaxesKRW: 5,
  cashInterestPaidKRW: 2, otherOperatingCashFlowKRW: 0, otherOperatingCashFlowRationale: "none",
  debtPrincipalDueKRW: 0, committedDebtDrawKRW: 0, dividendsAndBuybacksKRW: 0,
  assumptions: { isAssumption: true, rationale: "funding plan quarter assumption", source: realSource() },
  ...over,
});
const funding = (over: Record<string, unknown> = {}) => ({
  openingBalanceBasis: "projected_start_of_horizon" as const, openingUnrestrictedCashKRW: 100, openingDebtKRW: 50,
  assumptions: { isAssumption: true, rationale: "funding plan assumption", source: realSource() },
  quarters: HORIZON.map((q) => fundingQuarter(q)), ...over,
});
const liquidity = (over: Record<string, unknown> = {}) => ({
  averageDailyTradedValueKRW: 1_000_000, windowSessions: 20, asOf: "2026-05-15T00:00:00+09:00",
  knownAt: "2026-05-15T00:00:00+09:00", source: realSource(), ...over,
});
// knownAt defaults are grounded on the SAME KST calendar day as DOC.publishedAt (2026-05-15): a field's own knownAt
// must never be a later, uncited date the model invented to make a fact look freshly "refreshed" (see the dedicated
// KNOWN_AT_NOT_GROUNDED tests below, which deliberately diverge the two to prove that case is rejected).
const consensus = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, ticker: "005930", scope: "consolidated", basis: "common_diluted", currency: "KRW", unit: "KRW_per_share",
  horizonQuarters: HORIZON, epsPerShare: 7, knownAt: "2026-05-15T09:00:00+09:00", source: realSource(), ...over,
});
const catalyst = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, ticker: "005930", eventType: "earnings_release", eventAt: "2026-08-10T09:00:00+09:00",
  knownAt: "2026-05-15T09:00:00+09:00", source: realSource(), ...over,
});
const cite = (fieldPath: string, quote: string, quotedNumber: string, doc = DOC): Citation => ({ fieldPath, documentId: doc.id, url: doc.url, publishedAt: doc.publishedAt, evidenceQuote: quote, quotedNumber });

// Citations proving the consensus horizon/eps together, and the catalyst date, in the SAME document as their source.
const HORIZON_QUOTE = "2026Q3~2027Q2 연결 기준 보통주 희석 컨센서스 EPS 7원";
const epsAndHorizonCitations = (field: "currentConsensus" | "priorConsensus" = "currentConsensus") => [
  cite(`${field}.epsPerShare`, HORIZON_QUOTE, "7"),
  cite(`${field}.horizonQuarters`, HORIZON_QUOTE, "7"),
];
const catalystCitations = () => [cite("catalyst.eventAt", "실적발표 예정일 2026-08-10", "2026-08-10")];

const run = (raw: unknown, citations: Citation[] = []) => verifyStrategyDraft(ASOF, [DOC, OTHER_DOC], citations, raw);

describe("verifyStrategyDraft: forecast", () => {
  it("accepts forward segments explicitly labelled as assumptions and grounded in a real source", () => {
    const r = run({ forecast: forecast(), currentConsensus: null, priorConsensus: null, catalyst: null });
    expect(r.forecast).not.toBeNull();
    expect(r.unavailable.filter((u) => u.field === "forecast")).toEqual([]);
  });

  it("rejects a segment number that is neither cited nor marked as an assumption (no fabricated 'observed' facts)", () => {
    const r = run({ forecast: forecast({ 0: { assumptions: undefined } }) });
    expect(r.forecast).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "SEGMENT_FIELD_UNCITED" }));
  });

  it("accepts an uncited segment once it carries a real citation instead of an assumptions label", () => {
    const raw = forecast({ 0: { assumptions: undefined } });
    const citations = [
      cite("forecast.quarters[0].segments[0].volume", "실제 판매량 10개", "10"),
      cite("forecast.quarters[0].segments[0].unitPriceKRW", "평균단가 100원", "100"),
      cite("forecast.quarters[0].segments[0].variableCostPerUnitKRW", "변동비 60원", "60"),
      cite("forecast.quarters[0].segments[0].fixedCostKRW", "고정비 100원", "100"),
    ];
    const r = run({ forecast: raw }, citations);
    expect(r.forecast).not.toBeNull();
  });

  it("rejects a segment source that is a manual reference instead of a real supplied document", () => {
    const r = run({ forecast: forecast({ 0: { source: manualSource() } }) });
    expect(r.forecast).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "SEGMENT_SOURCE_INVALID" }));
  });

  it("rejects a source dated after asOf", () => {
    const r = run({ forecast: forecast({ 0: { source: realSource("2026-07-01T00:00:00+09:00") } }) });
    expect(r.forecast).toBeNull();
  });

  it("rejects a quarter with no bridgeAssumptions at all (guessed shares/tax/interest, neither observed nor assumed)", () => {
    const raw = forecast();
    (raw.quarters[0] as any).bridgeAssumptions = undefined;
    const r = run({ forecast: raw });
    expect(r.forecast).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "BRIDGE_ASSUMPTIONS_MISSING" }));
  });

  it("rejects a bridgeAssumptions/segment-assumptions source that is manualReference-only (assumptions still need a real grounding document)", () => {
    const raw = forecast();
    (raw.quarters[0] as any).bridgeAssumptions = { isAssumption: true, rationale: "guess", source: manualSource() };
    const r = run({ forecast: raw });
    expect(r.forecast).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "BRIDGE_ASSUMPTION_SOURCE_INVALID" }));
  });

  it("keeps a valid core EPS forecast intact when an optional funding plan is present and valid", () => {
    const raw = forecast() as any;
    raw.funding = funding();
    const r = run({ forecast: raw });
    expect(r.forecast).not.toBeNull();
    expect(r.forecast!.funding).toBeDefined();
    expect(r.unavailable.filter((u) => u.field === "forecast")).toEqual([]);
  });

  it("drops ONLY the funding block, never the valid core EPS forecast, when funding assumptions are ungrounded", () => {
    const raw = forecast() as any;
    raw.funding = funding({ assumptions: { isAssumption: true, rationale: "guess", source: manualSource() } });
    const r = run({ forecast: raw });
    expect(r.forecast).not.toBeNull();
    expect(r.forecast!.funding).toBeUndefined();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "FUNDING_ASSUMPTION_SOURCE_INVALID" }));
  });

  it("drops ONLY the liquidity block, never the valid core EPS forecast, when liquidity is uncited", () => {
    const raw = forecast() as any;
    raw.liquidity = liquidity();
    const r = run({ forecast: raw }); // no citation for liquidity.averageDailyTradedValueKRW at all
    expect(r.forecast).not.toBeNull();
    expect(r.forecast!.liquidity).toBeUndefined();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "LIQUIDITY_UNCITED" }));
  });

  it("drops the forecast for a declared financial-sector company instead of computing a fabricated unit-economics model", () => {
    const raw = forecast();
    (raw as any).company = { name: "테스트은행", exchange: "KOSPI", securityType: "common_stock", source: realSource() };
    const r = run({ forecast: raw });
    expect(r.forecast).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "FINANCIAL_SECTOR_UNSUPPORTED" }));
  });
});

describe("verifyStrategyDraft: consensus (must never be fabricated)", () => {
  it("rejects a consensus whose source is a manual/analyst assumption instead of a real supplied document", () => {
    const r = run({ currentConsensus: consensus({ source: manualSource() }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "SOURCE_INVALID" }));
  });

  it("rejects a consensus EPS with no supporting citation", () => {
    const r = run({ currentConsensus: consensus() });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "EPS_UNCITED" }));
  });

  it("rejects a consensus EPS whose citation quotes a different number (invented observation)", () => {
    const citations = [cite("currentConsensus.epsPerShare", "컨센서스 EPS 7원", "9")]; // "9" never occurs in the doc
    const r = run({ currentConsensus: consensus() }, citations);
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "EPS_UNCITED" }));
  });

  it("accepts a consensus EPS with a real, quote-matching citation anchored to the exact horizon", () => {
    const r = run({ currentConsensus: consensus() }, epsAndHorizonCitations());
    expect(r.currentConsensus).not.toBeNull();
    expect(r.currentConsensus!.epsPerShare).toBe(7);
  });

  it("rejects a consensus knownAt that is falsely 'refreshed' to a later, uncited date than the source was actually published", () => {
    // Reproduces the exact reported case: source published/known 2025-12-06, but the model claims the consensus
    // itself only became known a month later on 2026-01-05 -- with nothing supporting that later date.
    const staleDoc: EvidenceDocument = { ...DOC, id: "stale", publishedAt: "2025-12-06" };
    const src = { title: "d", url: staleDoc.url, kind: "filing" as const, knownAt: "2025-12-06T00:00:00+09:00" };
    const citations = [cite("currentConsensus.epsPerShare", HORIZON_QUOTE, "7", staleDoc), cite("currentConsensus.horizonQuarters", HORIZON_QUOTE, "7", staleDoc)];
    const r = verifyStrategyDraft(ASOF, [staleDoc], citations, { currentConsensus: consensus({ source: src, knownAt: "2026-01-05T00:00:00+09:00" }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "KNOWN_AT_NOT_GROUNDED" }));
  });

  it("rejects a schema-invalid consensus (e.g. wrong horizon length) without throwing", () => {
    const r = run({ currentConsensus: { ...consensus(), horizonQuarters: HORIZON.slice(0, 3) } });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "SCHEMA_INVALID" }));
  });

  it("rejects an annual-only EPS quote dressed up as a four-quarter horizon (the exact fabrication this closes)", () => {
    const annualDoc: EvidenceDocument = { ...DOC, id: "annual", text: "2026 annual EPS consensus is 7 KRW. No quarterly horizon or event schedule is supplied." };
    const citations = [
      cite("currentConsensus.epsPerShare", "2026 annual EPS consensus is 7 KRW.", "7", annualDoc),
      cite("currentConsensus.horizonQuarters", "2026 annual EPS consensus is 7 KRW.", "7", annualDoc),
    ];
    const r = verifyStrategyDraft(ASOF, [annualDoc], citations, { currentConsensus: consensus({ source: { title: "d", url: annualDoc.url, kind: "filing", knownAt: `${annualDoc.publishedAt}T00:00:00+09:00` } }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
  });

  it("rejects a horizon citation naming a different (even if adjacent) four-quarter range", () => {
    const wrongRange = "2025Q1~2025Q4 연결 보통주 희석 컨센서스 EPS 7원";
    const wrongDoc: EvidenceDocument = { ...DOC, id: "wrong-range", text: wrongRange };
    const citations = [cite("currentConsensus.epsPerShare", wrongRange, "7", wrongDoc), cite("currentConsensus.horizonQuarters", wrongRange, "7", wrongDoc)];
    const src = { title: "d", url: wrongDoc.url, kind: "filing" as const, knownAt: `${wrongDoc.publishedAt}T00:00:00+09:00` };
    const r = verifyStrategyDraft(ASOF, [wrongDoc], citations, { currentConsensus: consensus({ source: src }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
  });

  it("rejects a horizon quote that never affirmatively states consolidated/diluted basis (absence of contradiction is not enough)", () => {
    const noBasis = "2026Q3~2027Q2 컨센서스 EPS 7원"; // quarters present, but no 연결/희석 wording at all
    const noBasisDoc: EvidenceDocument = { ...DOC, id: "no-basis", text: noBasis };
    const citations = [cite("currentConsensus.epsPerShare", noBasis, "7", noBasisDoc), cite("currentConsensus.horizonQuarters", noBasis, "7", noBasisDoc)];
    const src = { title: "d", url: noBasisDoc.url, kind: "filing" as const, knownAt: `${noBasisDoc.publishedAt}T00:00:00+09:00` };
    const r = verifyStrategyDraft(ASOF, [noBasisDoc], citations, { currentConsensus: consensus({ source: src }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
  });

  it("rejects a horizon quote that states BASIC common EPS, not diluted, even though it names 보통주 (the exact fabrication this closes)", () => {
    const basicText = "2026Q3~2027Q2 연결 보통주 기본 EPS 컨센서스 7원.";
    const basicDoc: EvidenceDocument = { ...DOC, id: "basic-eps", text: basicText };
    const citations = [cite("currentConsensus.epsPerShare", basicText, "7", basicDoc), cite("currentConsensus.horizonQuarters", basicText, "7", basicDoc)];
    const src = { title: "d", url: basicDoc.url, kind: "filing" as const, knownAt: `${basicDoc.publishedAt}T00:00:00+09:00` };
    const r = verifyStrategyDraft(ASOF, [basicDoc], citations, { currentConsensus: consensus({ source: src, knownAt: `${basicDoc.publishedAt}T00:00:00+09:00` }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
  });

  it("rejects a horizon quote naming 보통주 alone with no diluted/basic wording at all (diluted is never inferred from common alone)", () => {
    const commonOnly = "2026Q3~2027Q2 연결 보통주 컨센서스 EPS 7원";
    const commonOnlyDoc: EvidenceDocument = { ...DOC, id: "common-only", text: commonOnly };
    const citations = [cite("currentConsensus.epsPerShare", commonOnly, "7", commonOnlyDoc), cite("currentConsensus.horizonQuarters", commonOnly, "7", commonOnlyDoc)];
    const src = { title: "d", url: commonOnlyDoc.url, kind: "filing" as const, knownAt: `${commonOnlyDoc.publishedAt}T00:00:00+09:00` };
    const r = verifyStrategyDraft(ASOF, [commonOnlyDoc], citations, { currentConsensus: consensus({ source: src, knownAt: `${commonOnlyDoc.publishedAt}T00:00:00+09:00` }) });
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
  });

  it("accepts an English-language diluted EPS statement as satisfying the diluted basis requirement", () => {
    const enText = "2026Q3~2027Q2 연결 diluted common EPS consensus is 7 KRW.";
    const enDoc: EvidenceDocument = { ...DOC, id: "en-diluted", text: enText };
    const citations = [cite("currentConsensus.epsPerShare", enText, "7", enDoc), cite("currentConsensus.horizonQuarters", enText, "7", enDoc)];
    const src = { title: "d", url: enDoc.url, kind: "filing" as const, knownAt: `${enDoc.publishedAt}T00:00:00+09:00` };
    const r = verifyStrategyDraft(ASOF, [enDoc], citations, { currentConsensus: consensus({ source: src, knownAt: `${enDoc.publishedAt}T00:00:00+09:00` }) });
    expect(r.currentConsensus).not.toBeNull();
  });

  it("rejects an EPS citation and a horizon citation that come from two different documents", () => {
    const citations = [cite("currentConsensus.epsPerShare", HORIZON_QUOTE, "7", DOC), cite("currentConsensus.horizonQuarters", HORIZON_QUOTE, "7", OTHER_DOC)];
    const r = run({ currentConsensus: consensus() }, citations);
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
  });

  it("rejects an EPS citation from a different document than consensus.source", () => {
    const citations = [cite("currentConsensus.epsPerShare", HORIZON_QUOTE, "7", OTHER_DOC), cite("currentConsensus.horizonQuarters", HORIZON_QUOTE, "7", OTHER_DOC)];
    const r = run({ currentConsensus: consensus() }, citations); // consensus().source points at DOC
    expect(r.currentConsensus).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "EPS_UNCITED" }));
  });
});

describe("verifyStrategyDraft: catalyst (must never be fabricated)", () => {
  it("rejects a catalyst whose source is not a real supplied document", () => {
    const r = run({ catalyst: catalyst({ source: manualSource() }) });
    expect(r.catalyst).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "catalyst", code: "SOURCE_INVALID" }));
  });

  it("accepts a catalyst with a real source and a date citation describing the scheduled event", () => {
    const r = run({ catalyst: catalyst() }, catalystCitations());
    expect(r.catalyst).not.toBeNull();
  });

  it("rejects an eventAt with no citation at all (source url resolving is not enough)", () => {
    const r = run({ catalyst: catalyst() });
    expect(r.catalyst).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "catalyst", code: "EVENT_DATE_UNANCHORED" }));
  });

  it("rejects a date citation that names the right date but describes an unrelated event (a contract date is not an earnings schedule)", () => {
    const citations = [cite("catalyst.eventAt", "공급 계약 만료일은 2026-08-10 입니다.", "2026-08-10")];
    const r = run({ catalyst: catalyst() }, citations);
    expect(r.catalyst).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "catalyst", code: "EVENT_DATE_UNANCHORED" }));
  });

  it("rejects a catalyst knownAt that is falsely 'refreshed' to a later, uncited date than the source was actually published", () => {
    const staleDoc: EvidenceDocument = { ...DOC, id: "stale-cat", publishedAt: "2025-12-06" };
    const src = { title: "d", url: staleDoc.url, kind: "filing" as const, knownAt: "2025-12-06T00:00:00+09:00" };
    const citations = [cite("catalyst.eventAt", "실적발표 예정일 2026-08-10", "2026-08-10", staleDoc)];
    const r = verifyStrategyDraft(ASOF, [staleDoc], citations, { catalyst: catalyst({ source: src, knownAt: "2026-01-05T00:00:00+09:00" }) });
    expect(r.catalyst).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "catalyst", code: "KNOWN_AT_NOT_GROUNDED" }));
  });

  it("rejects an eventAt citation from a different document than catalyst.source", () => {
    const citations = [cite("catalyst.eventAt", "실적발표 예정일 2026-08-10", "2026-08-10", OTHER_DOC)];
    const r = run({ catalyst: catalyst() }, citations); // catalyst().source points at DOC
    expect(r.catalyst).toBeNull();
    expect(r.unavailable).toContainEqual(expect.objectContaining({ field: "catalyst", code: "EVENT_DATE_UNANCHORED" }));
  });
});

describe("verifyStrategyDraft: no strategy object at all", () => {
  it("reports NOT_PROVIDED instead of guessing anything", () => {
    const r = verifyStrategyDraft(ASOF, [DOC], [], null);
    expect(r).toMatchObject({ forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null });
    expect(r.unavailable).toEqual([{ field: "all", code: "NOT_PROVIDED", message: "the model did not provide a strategy object" }]);
  });
});
