import { z } from "zod";
import { formatQuarter, parseQuarter } from "../domain/time.js";
import { CatalystSchema, SingleQuarterConsensusSchema, SingleQuarterForecastSchema, SingleQuarterFundingPlanSchema, type StrategySource } from "../strategy/schema.js";
import { seoulDateOf } from "../strategy/time.js";
import { checkCitation, numericSupport } from "./verify.js";
import type { Citation, EvidenceDocument, StrategyDropReason, StrategyExtraction } from "./types.js";

// Deterministic verification of the earnings-gap-auto/v1 fields returned under the required `strategy` key
// by the SEPARATE strategy call (see StrategyProposalSchema / StrategyDraftSchema below). This never widens what the model is trusted to assert: every source must resolve
// to a real supplied document (url + matching date), and every consensus/liquidity/catalyst fact must carry a
// citation whose quoted text actually anchors it -- not just a bare number or a resolvable URL, but text that
// deterministically expands to the SAME single quarter being claimed, affirmatively states consolidated/diluted
// basis, and (for a catalyst) actually describes a scheduled earnings/guidance/disclosure event, in the SAME
// document as the field's own declared `source`. Anything that fails is dropped with a reason, never silently
// coerced or guessed. Forward forecast segments/bridge/funding numbers MAY rest on a rationale rather than an
// exact-match citation (they are estimates, not observed facts), but the rationale's OWN source must still be a
// real supplied document -- never a free-floating manualReference with no evidence at all.
//
// Semantic limits (documented, not hidden): exact-match/quarter-expansion checking proves specific text and derived
// quarter tokens occur in a supplied document; it cannot prove the document's author meant exactly what the model
// claims beyond that. Residual risk (and this module's precise anchoring rules) are documented in docs/STRATEGY.md.

const drop = (field: string, code: string, message: string): StrategyDropReason => ({ field, code, message });

const STRATEGY_FIELDS = ["forecast", "currentConsensus", "priorConsensus", "catalyst"] as const;

// A key that must be present; its value may be null (explicitly "no evidence") but never simply omitted.
const requiredKey = z.unknown().refine((v) => v !== undefined, { message: "required (use null when there is no supporting evidence)" });

/** Outer shape of the draft's REQUIRED `strategy` field: an object carrying all four keys. Each value stays unknown
 * here (null = explicitly unavailable) and is parsed/verified piece by piece in verifyStrategyDraft, so a malformed
 * sub-object is still dropped with a reason instead of failing the whole draft. Omitting `strategy`, sending null,
 * or leaving out any of the four keys fails ProposalSchema validation. */
export const StrategyDraftSchema = z.object(Object.fromEntries(STRATEGY_FIELDS.map((k) => [k, requiredKey])) as Record<(typeof STRATEGY_FIELDS)[number], typeof requiredKey>);

type SourceOk = { doc: EvidenceDocument };
type SourceBad = { error: string };

/** Resolves a source to the real supplied document it claims to cite. `mode: "observed"` additionally forbids the
 * "manual_assumption" provenance kind (an observed fact cannot honestly carry that label). Every source -- including
 * forward-looking assumptions -- must have a real url; a manualReference-only source is never accepted; the
 * rationale for an estimate must still be grounded in an actual document, not free-floating. */
function resolveSource(path: string, s: StrategySource, docs: EvidenceDocument[], asOf: string, mode: "observed" | "assumption"): SourceOk | SourceBad {
  const day = seoulDateOf(s.knownAt);
  if (day > asOf) return { error: `${path}: source known after asOf` };
  if (mode === "observed" && s.kind === "manual_assumption") return { error: `${path}: an observed fact cannot be sourced as manual_assumption` };
  if (!s.url) return { error: `${path}: must cite a real supplied document url; a manualReference-only source is not accepted, even for a forward-looking assumption (the rationale must be grounded in an actual document)` };
  const doc = docs.find((d) => d.url === s.url);
  if (!doc) return { error: `${path}: source url is not among the supplied documents` };
  if (doc.publishedAt !== day) return { error: `${path}: source knownAt date differs from the supplied document's publishedAt` };
  return { doc };
}
const sourceIssue = (path: string, s: StrategySource, docs: EvidenceDocument[], asOf: string, mode: "observed" | "assumption"): string | null => {
  const r = resolveSource(path, s, docs, asOf, mode);
  return "error" in r ? r.error : null;
};

/** Validates a field's own top-level `knownAt` (e.g. currentConsensus.knownAt, catalyst.knownAt -- distinct from
 * the nested `source.knownAt` resolveSource already checks) against the resolved source document's REAL publication
 * date, in KST calendar days (never a raw ISO-string slice). This closes the "false refresh": a model asserting a
 * stale consensus/catalyst became known on some later, uncited date to make it look fresh again. There is no
 * separately-citable observation timestamp in this schema more precise than the document's own publishedAt, so
 * nothing later than that date may honestly be claimed. */
function groundedKnownAt(path: string, knownAt: string, doc: EvidenceDocument): string | null {
  const day = seoulDateOf(knownAt);
  if (day !== doc.publishedAt) return `${path}: knownAt (${day}) is not grounded in the cited source's publication date (${doc.publishedAt}); a fact cannot be claimed "known" on a date the model invented`;
  return null;
}

/** A numeric field that must never be fabricated: requires a citation whose quote and unit actually derive the value. */
function citedNumber(fieldPath: string, value: number, citations: Citation[], docs: Map<string, EvidenceDocument>, asOf: string): string | null {
  const cands = citations.filter((c) => c.fieldPath === fieldPath);
  if (!cands.length) return "no citation for this number";
  let last = "no supporting citation";
  for (const c of cands) {
    const bad = checkCitation(c, docs, asOf);
    if (bad) { last = bad.message; continue; }
    const why = numericSupport(c, value);
    if (!why) return null;
    last = why;
  }
  return last;
}

// ---- date anchoring (catalyst.eventAt) ----------------------------------------------------------------------

const dateVariants = (iso: string): string[] => {
  const d = seoulDateOf(iso);
  const [y, m, day] = d.split("-").map(Number);
  return [d, `${y}.${String(m).padStart(2, "0")}.${String(day).padStart(2, "0")}`, `${y}/${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}`, `${y}년 ${m}월 ${day}일`];
};
// A catalyst date must be quoted from text that actually describes a scheduled earnings/guidance/disclosure event
// (the concrete fabrication this closes: any random future date -- a contract expiry, a maturity date -- being
// accepted as an "earnings release schedule" merely because a matching date string appears somewhere).
const EVENT_KEYWORDS: Record<string, RegExp> = {
  earnings_release: /실적\s*발표|잠정\s*실적|경영\s*실적|영업\s*\(?잠정\)?\s*실적|결산\s*발표|결산\s*실적\s*공시\s*예고|earnings\s*(release|call)/i,
  guidance_update: /가이던스|실적\s*전망\s*(수정|변경)|전망치\s*(수정|변경)|guidance/i,
  other_scheduled_disclosure: /공시\s*예정|이사회\s*(결의|개최)|주주총회|정기\s*보고서\s*제출|발표\s*예정|scheduled\s*disclosure/i,
};
function citedDate(fieldPath: string, iso: string, eventType: string, citations: Citation[], docs: Map<string, EvidenceDocument>, asOf: string, sameDocumentAs: string): string | null {
  const cands = citations.filter((c) => c.fieldPath === fieldPath);
  if (!cands.length) return "no citation anchoring this date";
  const variants = dateVariants(iso);
  const keyword = EVENT_KEYWORDS[eventType];
  let last = "no supporting citation";
  for (const c of cands) {
    const bad = checkCitation(c, docs, asOf);
    if (bad) { last = bad.message; continue; }
    if (c.documentId !== sameDocumentAs) { last = "eventAt citation is not in the same document as catalyst.source"; continue; }
    if (!variants.some((v) => c.evidenceQuote.includes(v))) { last = `evidenceQuote does not contain the claimed date (expected one of: ${variants[0]})`; continue; }
    if (!keyword?.test(c.evidenceQuote)) { last = `evidenceQuote does not describe a scheduled ${eventType} event (a date alone is not a catalyst)`; continue; }
    return null;
  }
  return last;
}

// ---- horizon anchoring (consensus.horizonQuarters) ----------------------------------------------------------

/** Every distinct quarter token found in text, normalised to "YYYYQn": "2026Q4", "2026.Q4", "2026-Q4", "2026년 4분기". */
function quarterTokensIn(text: string): string[] {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/(\d{4})\s*[.\-]?\s*[Qq]\s*([1-4])\b/g)) tokens.add(`${m[1]}Q${m[2]}`);
  for (const m of text.matchAll(/(\d{4})\s*년\s*([1-4])\s*분기/g)) tokens.add(`${m[1]}Q${m[2]}`);
  return [...tokens];
}
/** Deterministically expands whatever quarter tokens the quote contains into the exact ordered horizon it anchors,
 * or null if the quote does not unambiguously anchor a horizon at all (no tokens, or an unrecognised shape). Two
 * tokens exactly 3 quarters apart, with a range connector between them, are read as an inclusive start~end range
 * (a common phrasing: "2026Q4~2027Q3 컨센서스"); anything else is taken as an explicit enumerated list. */
function anchoredHorizon(text: string): string[] | null {
  const tokens = quarterTokensIn(text);
  if (!tokens.length) return null;
  if (tokens.length === 2) {
    const idx = tokens.map(parseQuarter).sort((a, b) => a - b);
    if (idx[1]! - idx[0]! === 3 && /[~\-–—]|부터|까지|to\b/i.test(text)) return [0, 1, 2, 3].map((i) => formatQuarter(idx[0]! + i));
  }
  return [...tokens].sort((a, b) => parseQuarter(a) - parseQuarter(b));
}
const sameQuarters = (a: string[], b: string[]): boolean => a.length === b.length && a.every((q, i) => q === b[i]);

// Affirmative consolidated/common-diluted basis: required to actually be stated, not merely not-contradicted.
const CONSOLIDATED_RE = /연결(?!\s*×)/; // "연결" (consolidated); DART/Naver consensus lines routinely say 연결 or 지배주주
// The schema's `basis: "common_diluted"` literal is a model SELF-declaration; it must still be grounded in text that
// affirmatively names the DILUTED basis ("희석"/"diluted"). "보통주"(common share) alone is not enough -- diluted is
// never inferred merely from "common" -- and a quote that explicitly names the BASIC basis ("기본"/"basic") instead
// (e.g. "보통주 기본 EPS", "basic EPS") must be rejected outright, even though it also contains "보통주".
const EXPLICIT_DILUTED_RE = /희석\s*(주당|EPS|보통주)?|\bdiluted\b/i;
const EXPLICIT_BASIC_RE = /기본\s*(주당|EPS)?|\bbasic\b/i;

function citedHorizon(field: string, horizonQuarters: string[], citations: Citation[], docs: Map<string, EvidenceDocument>, asOf: string, sameDocumentAs: string): string | null {
  const cands = citations.filter((c) => c.fieldPath === `${field}.horizonQuarters`);
  if (!cands.length) return "no citation anchoring the consensus quarter (a citation on epsPerShare alone is not enough)";
  let last = "no supporting citation";
  for (const c of cands) {
    const bad = checkCitation(c, docs, asOf);
    if (bad) { last = bad.message; continue; }
    if (c.documentId !== sameDocumentAs) { last = "horizon citation is not in the same document as the consensus source/epsPerShare citation"; continue; }
    const found = anchoredHorizon(c.evidenceQuote);
    if (!found) { last = "evidenceQuote does not contain any recognisable quarter token"; continue; }
    if (!sameQuarters(found, horizonQuarters)) { last = `evidenceQuote anchors quarters [${found.join(", ")}], not the claimed horizon [${horizonQuarters.join(", ")}]`; continue; }
    if (!CONSOLIDATED_RE.test(c.evidenceQuote)) { last = "evidenceQuote does not affirmatively state a consolidated (연결) basis"; continue; }
    if (EXPLICIT_BASIC_RE.test(c.evidenceQuote) && !EXPLICIT_DILUTED_RE.test(c.evidenceQuote)) { last = "evidenceQuote explicitly states a basic (기본/basic) EPS basis, not diluted -- common_diluted must never be accepted from a basic-EPS quote"; continue; }
    if (!EXPLICIT_DILUTED_RE.test(c.evidenceQuote)) { last = "evidenceQuote does not affirmatively state a diluted (희석/diluted) basis; a common-share (보통주) mention alone is not sufficient"; continue; }
    return null;
  }
  return last;
}

/** epsPerShare citation(s), structurally valid, numerically supporting, and in the SAME document as consensus.source. */
function validEpsCitations(fieldPath: string, value: number, citations: Citation[], docs: Map<string, EvidenceDocument>, asOf: string, sameDocumentAs: string): { ok: Citation[]; reason: string | null } {
  const cands = citations.filter((c) => c.fieldPath === fieldPath);
  const ok: Citation[] = [];
  let reason = cands.length ? "no supporting citation" : "no citation for this number";
  for (const c of cands) {
    const bad = checkCitation(c, docs, asOf);
    if (bad) { reason = bad.message; continue; }
    if (c.documentId !== sameDocumentAs) { reason = "epsPerShare citation is not in the same document as consensus.source"; continue; }
    const why = numericSupport(c, value);
    if (why) { reason = why; continue; }
    ok.push(c);
  }
  return { ok, reason: ok.length ? null : reason };
}

// Volume x unit-price segment modelling assumes an operating company selling units at a price; it is not meaningful
// for banks, insurers, financial holding companies or brokerages (their "revenue" is interest/premium/fee income).
// Detected heuristically from the declared company name / sector text: a false positive only means the automatic
// path reports itself unavailable (safe default), never that a bank gets a fabricated unit-economics forecast.
const FINANCIAL_SECTOR_RE = /은행|저축은행|보험|생명보험|화재해상|손해보험|캐피탈|카드사|금융지주|증권(?!거래소|시장)/;
function isFinancialSector(name: string | undefined, sector: string | undefined): boolean {
  return FINANCIAL_SECTOR_RE.test(name ?? "") || FINANCIAL_SECTOR_RE.test(sector ?? "");
}

// Rationale fields are display prose, and the funding prompt asks for formulas, account names and numbers in them.
// Over-long prose is truncated (same policy as `prose` in types.ts) instead of discarding the whole plan; numeric and
// structural fields are never touched.
function clipFundingProse(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const clipAt = (v: unknown, max: number) => (typeof v === "string" && v.length > max ? `${v.slice(0, max - 1)}…` : v);
  const clipAssumptions = (a: unknown) => (typeof a === "object" && a !== null ? { ...a, rationale: clipAt((a as Record<string, unknown>).rationale, 1000) } : a);
  const plan = raw as Record<string, unknown>;
  return {
    ...plan,
    ...("assumptions" in plan && { assumptions: clipAssumptions(plan.assumptions) }),
    ...(Array.isArray(plan.quarters) && {
      quarters: plan.quarters.map((q) => (typeof q === "object" && q !== null ? {
        ...q,
        ...("assumptions" in q && { assumptions: clipAssumptions((q as Record<string, unknown>).assumptions) }),
        ...("otherOperatingCashFlowRationale" in q && { otherOperatingCashFlowRationale: clipAt((q as Record<string, unknown>).otherOperatingCashFlowRationale, 500) }),
      } : q)),
    }),
  };
}

// Core (never-optional) forecast fields -- identity, segments, bridge inputs -- are what the EPS bridge is actually
// computed from: any invalid core field nulls the whole forecast, same as before. Liquidity/funding are OPTIONAL
// enrichments the bridge itself does not depend on (risk/sizing consumes them, degrading to "unavailable" when
// absent, per evaluateAutoStrategy); a bad or uncited liquidity/funding block must therefore be dropped BY ITSELF,
// with its own specific reasons recorded, never by nulling out an otherwise-valid core EPS forecast, and never by
// silently defaulting the discarded block to zero/absent-but-unexplained.
function verifyForecast(raw: unknown, docs: EvidenceDocument[], docsById: Map<string, EvidenceDocument>, citations: Citation[], asOf: string) {
  const drops: StrategyDropReason[] = [];
  if (raw === null || raw === undefined) return { value: null, drops };
  // Funding is optional enrichment. A null/incomplete plan from a model must not discard a valid EPS forecast;
  // keep the core so the dedicated funding pass can repair the plan.
  const rawFunding = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).funding : undefined;
  const parsed = SingleQuarterForecastSchema.safeParse(typeof raw === "object" && raw !== null ? { ...raw, funding: undefined } : raw);
  if (!parsed.success) return { value: null, drops: [drop("forecast", "SCHEMA_INVALID", parsed.error.issues[0]?.message ?? "forecast failed schema validation")] };
  const f = parsed.data;
  const bad = (code: string, msg: string) => drops.push(drop("forecast", code, msg));

  if (isFinancialSector(f.company?.name, f.sector))
    return { value: null, drops: [drop("forecast", "FINANCIAL_SECTOR_UNSUPPORTED", "volume x unit-price segment modelling is not applicable to banks/insurers/financial holding companies/brokerages; automatic earnings forecasting is unavailable for this sector")] };

  if (f.company) {
    const e = sourceIssue("company.source", f.company.source, docs, asOf, "observed");
    if (e) bad("COMPANY_SOURCE_INVALID", e);
  }
  f.quarters.forEach((q, qi) => {
    // Forward bridge inputs (netInterestKRW/taxRate/noncontrollingShare/preferredClaimsKRW/dilutedCommonShares) are
    // never exact-match cited (they are estimates), but they must never be a bare, ungrounded guess either: an
    // explicit bridgeAssumptions object, whose OWN source is a real document, is mandatory every quarter.
    if (!q.bridgeAssumptions) bad("BRIDGE_ASSUMPTIONS_MISSING", `quarters[${qi}]: netInterestKRW/taxRate/noncontrollingShare/preferredClaimsKRW/dilutedCommonShares require an explicit bridgeAssumptions object (rationale + a real source), never an unlabelled guess`);
    else {
      const e = sourceIssue(`quarters[${qi}].bridgeAssumptions.source`, q.bridgeAssumptions.source, docs, asOf, "assumption");
      if (e) bad("BRIDGE_ASSUMPTION_SOURCE_INVALID", e);
    }
    q.segments.forEach((s, si) => {
      const path = `quarters[${qi}].segments[${si}]`;
      const e = sourceIssue(`${path}.source`, s.source, docs, asOf, "observed");
      if (e) bad("SEGMENT_SOURCE_INVALID", e);
      if (s.assumptions) {
        const ae = sourceIssue(`${path}.assumptions.source`, s.assumptions.source, docs, asOf, "assumption");
        if (ae) bad("SEGMENT_ASSUMPTION_SOURCE_INVALID", ae);
      } else {
        for (const [field, value] of [["volume", s.volume], ["unitPriceKRW", s.unitPriceKRW], ["variableCostPerUnitKRW", s.variableCostPerUnitKRW], ["fixedCostKRW", s.fixedCostKRW]] as const) {
          const n = citedNumber(`forecast.${path}.${field}`, value, citations, docsById, asOf);
          if (n) bad("SEGMENT_FIELD_UNCITED", `${path}.${field}: ${n} (cite a document, or mark the segment with an explicit assumptions object grounded in a real source)`);
        }
      }
    });
  });
  if (drops.length) return { value: null, drops };

  // Optional blocks: validated independently of the core above (which is already known-valid at this point). A
  // failure here is recorded and returned in `drops` for visibility, but only strips the ONE offending block --
  // it never re-nulls the core forecast that already passed.
  const optionalDrops: StrategyDropReason[] = [];
  if (rawFunding !== undefined && rawFunding !== null) {
    const fp = SingleQuarterFundingPlanSchema.safeParse(clipFundingProse(rawFunding));
    if (fp.success) f.funding = fp.data;
    else optionalDrops.push(drop("funding", "FUNDING_SCHEMA_INVALID", fp.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ")));
  }
  let liquidity = f.liquidity;
  if (liquidity) {
    const e = sourceIssue("liquidity.source", liquidity.source, docs, asOf, "observed");
    if (e) { optionalDrops.push(drop("forecast", "LIQUIDITY_SOURCE_INVALID", e)); liquidity = undefined; }
    else {
      const n = citedNumber("forecast.liquidity.averageDailyTradedValueKRW", liquidity.averageDailyTradedValueKRW, citations, docsById, asOf);
      if (n) { optionalDrops.push(drop("forecast", "LIQUIDITY_UNCITED", `liquidity.averageDailyTradedValueKRW: ${n}`)); liquidity = undefined; }
    }
  }
  let funding = f.funding;
  if (funding) {
    let fundingBad = false;
    if (funding.quarters.some((q, i) => q.quarter !== f.quarters[i].quarter)) {
      optionalDrops.push(drop("funding", "FUNDING_HORIZON_MISMATCH", "자금 계획의 분기가 실적 전망 분기와 다릅니다."));
      fundingBad = true;
    }
    let debt = funding.openingDebtKRW;
    for (const q of funding.quarters) {
      debt += q.committedDebtDrawKRW - q.debtPrincipalDueKRW;
      if (debt < 0) {
        optionalDrops.push(drop("funding", "INVALID_DEBT_SCHEDULE", `${q.quarter}: 차입 원금 상환액이 차입 잔액과 확약 차입의 합계를 초과합니다.`));
        fundingBad = true;
        break;
      }
    }
    const fe = sourceIssue("funding.assumptions.source", funding.assumptions.source, docs, asOf, "assumption");
    if (fe) { optionalDrops.push(drop("forecast", "FUNDING_ASSUMPTION_SOURCE_INVALID", fe)); fundingBad = true; }
    funding.quarters.forEach((fq, fi) => {
      const qe = sourceIssue(`funding.quarters[${fi}].assumptions.source`, fq.assumptions.source, docs, asOf, "assumption");
      if (qe) { optionalDrops.push(drop("forecast", "FUNDING_QUARTER_ASSUMPTION_SOURCE_INVALID", qe)); fundingBad = true; }
    });
    if (fundingBad) funding = undefined;
  }
  return { value: { ...f, liquidity, funding }, drops: optionalDrops };
}

function verifyConsensus(field: "currentConsensus" | "priorConsensus", raw: unknown, docs: EvidenceDocument[], docsById: Map<string, EvidenceDocument>, citations: Citation[], asOf: string) {
  if (raw === null || raw === undefined) return { value: null, drops: [] as StrategyDropReason[] };
  const parsed = SingleQuarterConsensusSchema.safeParse(raw);
  if (!parsed.success) return { value: null, drops: [drop(field, "SCHEMA_INVALID", parsed.error.issues[0]?.message ?? "failed schema validation")] };
  const c = parsed.data;
  const src = resolveSource(`${field}.source`, c.source, docs, asOf, "observed");
  if ("error" in src) return { value: null, drops: [drop(field, "SOURCE_INVALID", src.error)] };
  const ge = groundedKnownAt(`${field}.knownAt`, c.knownAt, src.doc);
  if (ge) return { value: null, drops: [drop(field, "KNOWN_AT_NOT_GROUNDED", ge)] };
  // Both the EPS number and the horizon it covers must come from the SAME document as the declared source -- an
  // EPS quote from one filing plus an unrelated horizon quote from a different document would not actually connect
  // the number to the claimed quarter.
  const eps = validEpsCitations(`${field}.epsPerShare`, c.epsPerShare, citations, docsById, asOf, src.doc.id);
  if (!eps.ok.length) return { value: null, drops: [drop(field, "EPS_UNCITED", `epsPerShare: ${eps.reason}`)] };
  const horizonError = citedHorizon(field, c.horizonQuarters, citations, docsById, asOf, src.doc.id);
  if (horizonError) return { value: null, drops: [drop(field, "HORIZON_NOT_ANCHORED", horizonError)] };
  return { value: c, drops: [] as StrategyDropReason[] };
}

function verifyCatalyst(raw: unknown, docs: EvidenceDocument[], docsById: Map<string, EvidenceDocument>, citations: Citation[], asOf: string) {
  if (raw === null || raw === undefined) return { value: null, drops: [] as StrategyDropReason[] };
  const parsed = CatalystSchema.safeParse(raw);
  if (!parsed.success) return { value: null, drops: [drop("catalyst", "SCHEMA_INVALID", parsed.error.issues[0]?.message ?? "failed schema validation")] };
  const c = parsed.data;
  const src = resolveSource("catalyst.source", c.source, docs, asOf, "observed");
  if ("error" in src) return { value: null, drops: [drop("catalyst", "SOURCE_INVALID", src.error)] };
  const ge = groundedKnownAt("catalyst.knownAt", c.knownAt, src.doc);
  if (ge) return { value: null, drops: [drop("catalyst", "KNOWN_AT_NOT_GROUNDED", ge)] };
  const d = citedDate("catalyst.eventAt", c.eventAt, c.eventType, citations, docsById, asOf, src.doc.id);
  if (d) return { value: null, drops: [drop("catalyst", "EVENT_DATE_UNANCHORED", `eventAt: ${d}`)] };
  return { value: c, drops: [] as StrategyDropReason[] };
}

/** `asOf` is a YYYY-MM-DD KST date (same cutoff the Dataset draft is verified against). `citations` is the model's
 * raw citation list (unfiltered): strategy fieldPaths are verified independently of the Dataset's own citation pool
 * (see verifyProposal in verify.ts, which now skips strategy-prefixed fieldPaths entirely so a bad strategy citation
 * never nulls out the unrelated Dataset). `raw` is the required `strategy` field of the model's draft
 * (validated against StrategyDraftSchema here too). */
export function verifyStrategyDraft(asOf: string, docs: EvidenceDocument[], citations: Citation[], raw: unknown): StrategyExtraction {
  const docsById = new Map(docs.map((d) => [d.id, d]));
  // `strategy` is required (StrategyDraftSchema). ProposalSchema already rejects a draft without it; this re-check
  // keeps direct callers honest and reports exactly which required key is missing instead of guessing.
  const shape = StrategyDraftSchema.safeParse(raw);
  if (!shape.success) {
    const missing = shape.error.issues.map((i) => i.path.join(".")).filter(Boolean);
    const unavailable = missing.length
      ? missing.map((f) => drop(f, "NOT_PROVIDED", `the model did not provide the required strategy.${f} field`))
      : [drop("all", "NOT_PROVIDED", "the model did not provide the required strategy object")];
    return { forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null, unavailable };
  }
  const obj = shape.data;
  const f = verifyForecast(obj.forecast, docs, docsById, citations, asOf);
  const cc = verifyConsensus("currentConsensus", obj.currentConsensus, docs, docsById, citations, asOf);
  const pc = verifyConsensus("priorConsensus", obj.priorConsensus, docs, docsById, citations, asOf);
  const cat = verifyCatalyst(obj.catalyst, docs, docsById, citations, asOf);
  return { forecast: f.value, currentConsensus: cc.value, priorConsensus: pc.value, catalyst: cat.value, unavailable: [...f.drops, ...cc.drops, ...pc.drops, ...cat.drops] };
}
