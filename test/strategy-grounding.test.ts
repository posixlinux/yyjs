import { describe, expect, it } from "vitest";
import { verifyStrategyDraft } from "../src/intelligence/strategyVerify.js";
import type { Citation, EvidenceDocument } from "../src/intelligence/types.js";
import { evaluateAutoStrategy } from "../src/strategy/auto.js";

// End-to-end coverage of the full verifyStrategyDraft -> evaluateAutoStrategy pipeline: proves the deterministic
// citation/provenance verifier (src/intelligence/strategyVerify.ts) and the automatic single-candidate evaluator
// (src/strategy/auto.ts) compose correctly -- a bad optional block never destroys an otherwise-valid ticker-only
// automatic analysis, and a genuinely fabricated fact never survives the pipeline to produce a number.

const TICKER = "005930";
const ASOF = "2026-06-30";
const DECISION_AT = "2026-06-30T09:00:00+09:00"; // KST; asOf's end-of-day-equivalent decision instant
const HORIZON = ["2026Q2"]; // the quarter in progress at DECISION_AT

const DOC: EvidenceDocument = {
  id: "d1",
  title: "1H26 report",
  url: "https://dart.fss.or.kr/r/1",
  publishedAt: "2025-12-06",
  text:
    "2026년 1분기 실제 판매량 10개, 평균단가 100원, 변동비 60원, 고정비 100원. " +
    "2026Q2 연결 기준 보통주 희석 컨센서스 EPS 7원. " +
    "실적발표 예정일 2026-08-10.",
};
const realSource = (knownAt = "2025-12-06T00:00:00+09:00") => ({ title: "doc", url: DOC.url, kind: "filing" as const, knownAt });
const manualSource = () => ({ title: "analyst note", manualReference: "애널리스트 통상 추정", kind: "analyst_report" as const, knownAt: "2025-12-06T00:00:00+09:00" });

const quarter = (q: string) => ({
  quarter: q,
  segments: [{
    name: "seg", volume: 10, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 100,
    source: realSource(),
    assumptions: { isAssumption: true, rationale: "forward projection based on last quarter", source: realSource() },
  }],
  coverageAttestation: { complete: true, statedBy: "model" },
  netInterestKRW: -10, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 100,
  bridgeAssumptions: { isAssumption: true, rationale: "held flat from last quarter", source: realSource() },
});
const forecastRaw = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, ticker: TICKER, scope: "consolidated", sector: "tech", fiscalYearBasis: "calendar", currency: "KRW",
  company: { name: "삼성전자", exchange: "KOSPI", securityType: "common_stock", source: realSource() },
  generatedAt: "2025-12-06T12:00:00+09:00", analyst: "claude",
  quarters: HORIZON.map(quarter),
  ...over,
});
const cite = (fieldPath: string, quote: string, quotedNumber: string, doc = DOC): Citation => ({ fieldPath, documentId: doc.id, url: doc.url, publishedAt: doc.publishedAt, evidenceQuote: quote, quotedNumber });
const HORIZON_QUOTE = "2026Q2 연결 기준 보통주 희석 컨센서스 EPS 7원";

function runPipeline(rawStrategy: unknown, citations: Citation[], docs: EvidenceDocument[] = [DOC]) {
  const extraction = verifyStrategyDraft(ASOF, docs, citations, { forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null, ...(rawStrategy as Record<string, unknown>) });
  const result = evaluateAutoStrategy({
    ticker: TICKER,
    decisionAt: DECISION_AT,
    mode: "live",
    forecast: extraction.forecast,
    currentConsensus: extraction.currentConsensus,
    priorConsensus: extraction.priorConsensus,
    catalyst: extraction.catalyst,
    unavailable: extraction.unavailable,
    minimumCashBufferKRW: 0,
    cashBufferConfigured: true,
  });
  return { extraction, result };
}

describe("end-to-end: basic-EPS consensus must never be accepted as common_diluted", () => {
  it("rejects the reported fabrication -- '보통주 기본 EPS' quoted as the horizon basis -- all the way through to the auto-strategy result", () => {
    const basicText = "2026Q2 연결 보통주 기본 EPS 컨센서스 7원.";
    const basicDoc: EvidenceDocument = { ...DOC, id: "basic", text: basicText };
    const citations = [cite("currentConsensus.epsPerShare", basicText, "7", basicDoc), cite("currentConsensus.horizonQuarters", basicText, "7", basicDoc)];
    const src = { title: "d", url: basicDoc.url, kind: "filing" as const, knownAt: `${basicDoc.publishedAt}T00:00:00+09:00` };
    const consensus = { schemaVersion: 1, ticker: TICKER, scope: "consolidated", basis: "common_diluted", currency: "KRW", unit: "KRW_per_share", horizonQuarters: HORIZON, epsPerShare: 7, knownAt: `${basicDoc.publishedAt}T00:00:00+09:00`, source: src };
    const { extraction, result } = runPipeline({ currentConsensus: consensus }, citations, [basicDoc]);
    expect(extraction.currentConsensus).toBeNull();
    expect(extraction.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "HORIZON_NOT_ANCHORED" }));
    expect(result.currentConsensus).toBeNull();
    expect(result.evaluation).toBeNull();
    expect(result.missing).toContainEqual(expect.objectContaining({ field: "currentConsensus" }));
  });
});

describe("end-to-end: consensus knownAt must be grounded in the real source publish date, not model-invented", () => {
  it("rejects a currentConsensus falsely 'refreshed' to a later date than the source was actually published", () => {
    const citations = [cite("currentConsensus.epsPerShare", HORIZON_QUOTE, "7"), cite("currentConsensus.horizonQuarters", HORIZON_QUOTE, "7")];
    const consensus = { schemaVersion: 1, ticker: TICKER, scope: "consolidated", basis: "common_diluted", currency: "KRW", unit: "KRW_per_share", horizonQuarters: HORIZON, epsPerShare: 7, knownAt: "2026-01-05T00:00:00+09:00", source: realSource() };
    const { extraction, result } = runPipeline({ currentConsensus: consensus }, citations);
    expect(extraction.currentConsensus).toBeNull();
    expect(extraction.unavailable).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "KNOWN_AT_NOT_GROUNDED" }));
    expect(result.currentConsensus).toBeNull();
  });
});

describe("end-to-end: a malformed optional funding block never destroys a valid core EPS forecast/bridge", () => {
  it("keeps the bridge (and a partial result) when funding is present but ungrounded, instead of nulling the whole forecast", () => {
    const raw = forecastRaw({
      funding: {
        openingBalanceBasis: "projected_start_of_horizon", openingUnrestrictedCashKRW: 100, openingDebtKRW: 50,
        assumptions: { isAssumption: true, rationale: "guess", source: manualSource() }, // manualReference-only: invalid
        quarters: HORIZON.map((q) => ({
          quarter: q, depreciationAndAmortizationKRW: 10, capexKRW: 10, deltaWorkingCapitalKRW: 0, cashTaxesKRW: 5,
          cashInterestPaidKRW: 2, otherOperatingCashFlowKRW: 0, otherOperatingCashFlowRationale: "none",
          debtPrincipalDueKRW: 0, committedDebtDrawKRW: 0, dividendsAndBuybacksKRW: 0,
          assumptions: { isAssumption: true, rationale: "guess", source: realSource() },
        })),
      },
    });
    const { extraction, result } = runPipeline({ forecast: raw }, []);
    expect(extraction.forecast).not.toBeNull();
    expect(extraction.forecast!.funding).toBeUndefined();
    expect(extraction.unavailable).toContainEqual(expect.objectContaining({ field: "forecast", code: "FUNDING_ASSUMPTION_SOURCE_INVALID" }));

    expect(result.bridge).not.toBeNull();
    // OP = 10*(100-60)-100 = 300; pretax = 300 + (-10) = 290; tax = 290*0.2 = 58; net = 232; eps = 232/100 = 2.32 for the one quarter
    expect(result.bridge!.ntmEpsKRW).toBeCloseTo(2.32, 5);
    expect(result.risk).toBeNull(); // funding stripped -> risk unavailable, never fabricated as zero
    expect(result.missing).toContainEqual(expect.objectContaining({ field: "funding" }));
    expect(result.status).toBe("estimate_only"); // no consensus/catalyst supplied in this scenario
  });
});
