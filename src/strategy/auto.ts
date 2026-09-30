import { classifySecurity } from "../domain/security.js";
import { AppError } from "../errors.js";
import { DEFAULT_HYPOTHESIS_PARAMS, DEFAULT_RISK_PARAMS, StrategyConfigSchema, type RiskPolicy, type StrategyConfig } from "./config.js";
import { computeForecastBridge, type ForecastBridge } from "./earnings.js";
import { computeCompanyRisk, type CompanyRisk } from "./risk.js";
import { evaluateOne, type CandidateEvaluation } from "./screen.js";
import { SingleQuarterCandidateInputSchema, type Catalyst, type ConsensusSnapshot, type EarningsForecastSnapshot, type StrategySource } from "./schema.js";
import { epoch, seoulDateOf, singleQuarterHorizon } from "./time.js";
import type { DailyClose, QuarterlyActual, QuarterlyConsensus } from "../collection/types.js";
import { compareQuarterlyConsensus, type QuarterlyConsensusComparison } from "./quarterly-consensus.js";
import { computeNextQuarterPrice, type NextQuarterPrice } from "./price-target.js";

// Automatic single-candidate strategy path (see docs/STRATEGY.md "Automatic connection"): turns whatever the
// intelligence module could verify (src/intelligence/strategyVerify.ts) for ONE ticker into the same deterministic
// earnings-bridge/risk/eligibility calculations the /v1/strategy/* API exposes, without ever inventing a
// personal portfolio. It never computes or exposes a position weight/budget: that requires real, explicitly
// configured capital/cost assumptions and stays exclusive to POST /v1/strategy/screen (config.ts DEFAULT_HYPOTHESIS_PARAMS
// note: "Supply feeBpsPerSide... explicitly"). This path only answers "is this one candidate eligible and what do its
// own numbers look like", which does not depend on capital at all (see evaluateOne).
//
// Short-term horizon: this path estimates exactly ONE quarter on its own -- the quarter that just ended (results
// still unpublished) or the one in progress -- because it serves trades held for three months at most. It does not
// need four quarters of forecast or consensus; the four-quarter horizon stays exclusive to the
// /v1/strategy/* API. The single-quarter estimate is a result in itself ("estimate_only") even when no consensus
// or catalyst could be verified.
//
// Every forecast is validated for identity/scope/horizon/temporal provenance BEFORE any bridge or risk number is
// computed or displayed: a forecast for the wrong ticker, a security that fails the KOSPI-common-stock filter, or a
// horizon that is not exactly one of those two quarters must never produce a bridge. This check runs
// unconditionally, independent of whether consensus or a catalyst were extracted at all (company membership must
// never be gated behind consensus availability).

export type AutoStrategyDropReason = { field: string; code: string; message: string };

/** One explicit, source-linked assumption backing the forecast (a segment/bridge/funding `assumptions` object),
 * surfaced so a consumer (the web UI) can render exactly which numbers rest on an LLM-authored estimate rather than
 * an observed fact -- and never mistake one for the other. `isModelEstimate` is true except for a statement-derived funding plan; `independentlyAudited` is always these
 * literal values here: unlike the product-market Dataset path, this automatic strategy path never runs the estimate
 * through a second-model audit (see AutoStrategyResult.independentlyAudited). */
export type AutoStrategyAssumptionRef = {
  fieldPath: string; // e.g. "forecast.quarters[0].segments[0].assumptions", "forecast.funding.assumptions"
  rationale: string;
  source: StrategySource;
  /** false only for the funding plan derived deterministically from DART statements (fundingOrigin below). */
  isModelEstimate: boolean;
  independentlyAudited: false;
};

export type AutoStrategyInput = {
  ticker: string;
  /** The decision instant this automatic run is evaluated AT: server "now" for a live (today) request, or the
   * end of the requested historical asOf day (KST) for a historical request -- never a mix of the two, so a
   * retrospective run is never displayed as if it were a live current judgement (see research/service.ts). */
  decisionAt: string;
  /** "live": asOf is today, decisionAt is the actual current instant. "retrospective_research": asOf is a past
   * date, decisionAt is anchored to that date instead of now, and the whole result is a historical replay of what
   * the evidence available by that date would have supported -- not a live signal. */
  mode: "live" | "retrospective_research";
  forecast: EarningsForecastSnapshot | null;
  currentConsensus: ConsensusSnapshot | null;
  quarterlyConsensus?: QuarterlyConsensus[];
  /** Reported quarterly EPS and daily closes (Naver) for the PER-hold next-quarter price; optional. */
  quarterlyActuals?: QuarterlyActual[];
  dailyCloses?: DailyClose[];
  priorConsensus: ConsensusSnapshot | null;
  catalyst: Catalyst | null;
  unavailable: AutoStrategyDropReason[]; // why any of the above is null (from intelligence verification)
  minimumCashBufferKRW: number;
  cashBufferConfigured: boolean;
  /** Who authored forecast.funding: the model (verified by strategyVerify.ts) or research/service.ts deriving it
   * from the collected consolidated statements (strategy/funding-derive.ts). Defaults to "model". */
  fundingOrigin?: "model" | "derived_from_filings";
  /** Explanations attached by the caller, e.g. why the model plan was replaced by the statement-derived one. */
  notes?: string[];
  /** Statement-derived plans only: current (<=12 months) debt and the part assumed due in the quarter, so the
   * all-current-debt-due-now, no-refinancing bound is computed next to the base/stress scenarios. */
  noRefinancing?: { currentDebtKRW: number; assumedPrincipalDueKRW: number };
};

export type AutoStrategyResult = {
  /** "estimate_only": a verified single-quarter estimate exists, but no cited consensus/catalyst to judge it against. */
  status: "eligible" | "ineligible" | "estimate_only" | "insufficient_data";
  mode: "live" | "retrospective_research";
  decisionAt: string;
  /** When the underlying forecast/consensus/catalyst extraction actually ran (server clock, never model-supplied). */
  generatedAt: string | null;
  /** Always false for this automatic path: strategy fields are deterministically citation-checked (see
   * strategyVerify.ts) but, unlike the product-market Dataset, never independently re-audited by the second model. */
  independentlyAudited: false;
  bridge: ForecastBridge | null;
  risk: CompanyRisk | null;
  evaluation: CandidateEvaluation | null; // full screen()-style eligibility, only when all four pieces are present and mutually consistent
  quarterlyConsensus: QuarterlyConsensusComparison[];
  /** Fair price for the estimated quarter at the base quarter's market P/E (reference only, never an eligibility input). */
  nextQuarterPrice?: NextQuarterPrice;
  missing: AutoStrategyDropReason[];
  notes: string[];
  // The validated inputs themselves (null if never extracted or dropped by identity validation), so a consumer (the
  // web UI) can show WHICH assumptions/sources actually back the bridge/risk numbers -- never just a bare "EPS".
  forecast: EarningsForecastSnapshot | null;
  currentConsensus: ConsensusSnapshot | null;
  priorConsensus: ConsensusSnapshot | null;
  catalyst: Catalyst | null;
  /** Additive/optional (backwards-compatible): every explicit source-linked assumption (segment/bridge/funding)
   * the forecast above carries, flattened for UI rendering. Empty when there is no forecast. This is derived
   * entirely from `forecast` (already present above) -- a purely additive convenience field, never a new source of
   * truth; consumers that don't read it lose nothing. */
  assumptions?: AutoStrategyAssumptionRef[];
  /** Conservative bound: every current borrowing falls due in the forecast quarter with no refinancing. */
  noRefinancingBound?: { currentDebtKRW: number; assumedPrincipalDueKRW: number; baseEndingCashKRW: number; stressEndingCashKRW: number; baseAdditionalFundingRequiredKRW: number; stressAdditionalFundingRequiredKRW: number } | null;
  /** Origin of the funding plan behind `risk`; null when no plan survived. */
  fundingOrigin?: "model" | "derived_from_filings" | null;
};

/** Flattens every explicit `assumptions` object off a verified forecast (segment/bridge/funding), each already
 * proven (by strategyVerify.ts) to be grounded in a real supplied document -- never a free-floating claim. Labels
 * every entry as an LLM estimate, not independently audited: this automatic path never claims a model-authored
 * assumption is an observed fact or has been re-checked by a second model. */
function collectAssumptions(forecast: EarningsForecastSnapshot, fundingFromFilings = false): AutoStrategyAssumptionRef[] {
  const refs: AutoStrategyAssumptionRef[] = [];
  const add = (fieldPath: string, a: { rationale: string; source: StrategySource } | undefined) => {
    if (a) refs.push({ fieldPath, rationale: a.rationale, source: a.source, isModelEstimate: !(fundingFromFilings && fieldPath.startsWith("forecast.funding")), independentlyAudited: false });
  };
  forecast.quarters.forEach((q, qi) => {
    add(`forecast.quarters[${qi}].bridgeAssumptions`, q.bridgeAssumptions);
    q.segments.forEach((s, si) => add(`forecast.quarters[${qi}].segments[${si}].assumptions`, s.assumptions));
  });
  if (forecast.funding) {
    add("forecast.funding.assumptions", forecast.funding.assumptions);
    forecast.funding.quarters.forEach((fq, fi) => add(`forecast.funding.quarters[${fi}].assumptions`, fq.assumptions));
  }
  return refs;
}

/** The short-term path never looks further ahead than about three months. */
const MAX_HOLDING_DAYS = 92;

/** Portfolio-shaped fields (fees/slippage/tax/capital/maxHoldings/maxWeightPerHolding) are structurally required by
 * StrategyConfigSchema but never read by evaluateOne(); placeholders here are never surfaced (see module note above). */
function placeholderConfig(risk: RiskPolicy): StrategyConfig {
  return StrategyConfigSchema.parse({
    ...DEFAULT_HYPOTHESIS_PARAMS,
    currency: "KRW",
    exchange: "KOSPI",
    feeBpsPerSide: 0,
    slippageBpsPerSide: 0,
    sellTaxBps: 0,
    initialCapitalKRW: 1,
    catalystMaxDaysAhead: MAX_HOLDING_DAYS,
    risk,
  });
}

/** Identity/scope/horizon/temporal-provenance checks, run on the forecast alone (never gated behind consensus). A
 * forecast that fails any of these is never used to compute a bridge/risk number, no matter how complete it looks. */
function validateForecastIdentity(ticker: string, forecast: EarningsForecastSnapshot, decisionAt: string): AutoStrategyDropReason[] {
  const reasons: AutoStrategyDropReason[] = [];
  const add = (code: string, message: string) => reasons.push({ field: "forecast", code, message });

  if (forecast.ticker !== ticker) add("FORECAST_TICKER_MISMATCH", `forecast ticker ${forecast.ticker} does not match the requested ticker ${ticker}`);
  if (!forecast.company || forecast.scope !== "consolidated") add("FORECAST_COMPANY_SCOPE_MISSING", "forecast company/exchange/security type and consolidated scope must be declared");
  else if (forecast.company.exchange !== "KOSPI" || forecast.company.securityType !== "common_stock" || classifySecurity({ ticker, names: [forecast.company.name] }).length)
    add("FORECAST_NOT_KOSPI_COMMON", "forecast does not declare a KOSPI common share passing the security filter");

  const decisionDate = seoulDateOf(decisionAt);
  const forecastQuarters = forecast.quarters.map((q) => q.quarter);
  const allowed = singleQuarterHorizon(decisionDate);
  if (forecastQuarters.length !== 1 || (forecastQuarters[0] !== allowed.previous && forecastQuarters[0] !== allowed.current))
    add("FORECAST_HORIZON_NOT_SINGLE_QUARTER", `forecast must cover exactly one quarter, ${allowed.previous} (just ended) or ${allowed.current} (in progress on ${decisionDate}), not [${forecastQuarters.join(", ")}]`);
  if (epoch(forecast.generatedAt) > epoch(decisionAt)) add("FORECAST_GENERATED_AFTER_DECISION", "forecast generatedAt is after decisionAt");

  // Core source provenance must be known BEFORE the forecast was generated -- same rule screen.ts applies once a
  // full four-piece candidate is assembled (SOURCE_KNOWN_AFTER_GENERATION), but run here unconditionally so a
  // PARTIAL result (no consensus/catalyst yet, so screen.ts's evaluateOne() never even runs) gets the identical
  // protection: a bridge/risk number must never be computed and displayed from a segment or bridge input whose
  // source is backdated to look known earlier than it actually was.
  if (forecast.company && epoch(forecast.company.source.knownAt) > epoch(forecast.generatedAt))
    add("FORECAST_SOURCE_AFTER_GENERATION", "company source known after forecast generatedAt");
  forecast.quarters.forEach((q, qi) => {
    if (q.bridgeAssumptions && epoch(q.bridgeAssumptions.source.knownAt) > epoch(forecast.generatedAt))
      add("FORECAST_SOURCE_AFTER_GENERATION", `quarters[${qi}].bridgeAssumptions source known after forecast generatedAt`);
    q.segments.forEach((s, si) => {
      if (epoch(s.source.knownAt) > epoch(forecast.generatedAt)) add("FORECAST_SOURCE_AFTER_GENERATION", `quarters[${qi}].segments[${si}] source known after forecast generatedAt`);
      if (s.assumptions && epoch(s.assumptions.source.knownAt) > epoch(forecast.generatedAt))
        add("FORECAST_SOURCE_AFTER_GENERATION", `quarters[${qi}].segments[${si}].assumptions source known after forecast generatedAt`);
    });
  });
  return reasons;
}

/** Optional liquidity/funding blocks must ALSO be known by generatedAt/decisionAt before they feed a partial
 * result -- mirroring screen.ts's LIQUIDITY_TIME_MISMATCH/SOURCE_KNOWN_AFTER_GENERATION checks, which otherwise only
 * run once a full four-piece candidate exists. Unlike the core identity check above, a bad block here is dropped
 * BY ITSELF (with a specific reason recorded in `missing`) -- it must never mask an otherwise-valid earnings
 * forecast, and the surviving forecast's own timestamps are never rewritten to hide the drop. */
function dropUngroundedOptionalBlocks(forecast: EarningsForecastSnapshot, decisionAt: string): { forecast: EarningsForecastSnapshot; reasons: AutoStrategyDropReason[] } {
  const reasons: AutoStrategyDropReason[] = [];
  let { liquidity, funding } = forecast;
  if (liquidity) {
    const bad =
      epoch(liquidity.asOf) > epoch(liquidity.knownAt) ||
      epoch(liquidity.source.knownAt) > epoch(liquidity.knownAt) ||
      epoch(liquidity.knownAt) > epoch(forecast.generatedAt) ||
      epoch(liquidity.knownAt) > epoch(decisionAt);
    if (bad) { reasons.push({ field: "liquidity", code: "LIQUIDITY_TIME_MISMATCH", message: "liquidity must be observed and known by forecast generation and decision time" }); liquidity = undefined; }
  }
  if (funding) {
    let fundingBad = epoch(funding.assumptions.source.knownAt) > epoch(forecast.generatedAt) || epoch(funding.assumptions.source.knownAt) > epoch(decisionAt);
    for (const fq of funding.quarters)
      if (epoch(fq.assumptions.source.knownAt) > epoch(forecast.generatedAt) || epoch(fq.assumptions.source.knownAt) > epoch(decisionAt)) fundingBad = true;
    if (fundingBad) { reasons.push({ field: "funding", code: "FUNDING_TIME_MISMATCH", message: "funding plan assumptions must be known by forecast generation and decision time" }); funding = undefined; }
  }
  return { forecast: { ...forecast, liquidity, funding }, reasons };
}

export function evaluateAutoStrategy(input: AutoStrategyInput): AutoStrategyResult {
  const notes: string[] = [...(input.notes ?? [])];
  const missing: AutoStrategyDropReason[] = [...input.unavailable];
  if (input.mode === "retrospective_research")
    notes.push(`Historical request: evaluated as of ${seoulDateOf(input.decisionAt)}, not today. This is retrospective research using evidence available by that date, not a live current signal.`);

  // Identity/scope/horizon/temporal validation runs unconditionally whenever a forecast was extracted, regardless
  // of whether consensus/catalyst are available, BEFORE any bridge or risk number is computed.
  let forecast = input.forecast;
  if (forecast) {
    const idReasons = validateForecastIdentity(input.ticker, forecast, input.decisionAt);
    if (idReasons.length) {
      missing.push(...idReasons);
      forecast = null;
    }
  }
  if (!input.forecast) missing.push({ field: "forecast", code: "FORECAST_UNAVAILABLE", message: "no verified single-quarter earnings estimate was extracted" });

  // Optional liquidity/funding blocks are time-validated and, if ungrounded, dropped on their own -- BEFORE the
  // bridge/risk below are computed -- so a bad block can never mask an otherwise-valid core earnings forecast, and
  // never silently degrades to a zero/default instead of an explicit "unavailable" reason.
  if (forecast) {
    const stripped = dropUngroundedOptionalBlocks(forecast, input.decisionAt);
    forecast = stripped.forecast;
    missing.push(...stripped.reasons);
  }

  const bridge = forecast ? computeForecastBridge(forecast) : null;
  const quarterlyConsensus = compareQuarterlyConsensus(input.ticker, input.quarterlyConsensus ?? [], bridge, input.decisionAt);
  const nextQuarterPrice = computeNextQuarterPrice({ bridge, quarterlyActuals: input.quarterlyActuals ?? [], dailyCloses: input.dailyCloses ?? [] });
  const riskPolicy: RiskPolicy = { ...DEFAULT_RISK_PARAMS, minimumCashBufferKRW: input.minimumCashBufferKRW };
  if (!input.cashBufferConfigured) notes.push("risk.minimumCashBufferKRW is not configured on this server (STRATEGY_MIN_CASH_BUFFER_KRW); funding-gap checks use 0, so only literally negative projected cash counts as a gap.");

  // A bad-but-otherwise-valid funding schedule (e.g. principal due exceeding debt plus committed draws) must never
  // crash the whole analysis job: it degrades to "funding risk unavailable", the bridge (and everything else)
  // stays intact.
  let risk: CompanyRisk | null = null;
  if (forecast?.funding) {
    try {
      risk = computeCompanyRisk(forecast, riskPolicy);
    } catch (e) {
      if (e instanceof AppError) missing.push({ field: "funding", code: e.code, message: e.message });
      else throw e;
    }
  } else if (forecast) missing.push({ field: "funding", code: "FUNDING_UNAVAILABLE", message: "no verified investment/working-capital/debt funding plan was extracted; funding risk is unavailable" });

  let noRefinancingBound: AutoStrategyResult["noRefinancingBound"] = null;
  if (risk && input.noRefinancing && input.fundingOrigin === "derived_from_filings") {
    const extra = input.noRefinancing.currentDebtKRW - input.noRefinancing.assumedPrincipalDueKRW;
    const baseEnd = risk.base.endingCashKRW - extra;
    const stressEnd = risk.stress.endingCashKRW - extra;
    noRefinancingBound = {
      ...input.noRefinancing, baseEndingCashKRW: baseEnd, stressEndingCashKRW: stressEnd,
      baseAdditionalFundingRequiredKRW: Math.max(0, riskPolicy.minimumCashBufferKRW - baseEnd),
      stressAdditionalFundingRequiredKRW: Math.max(0, riskPolicy.minimumCashBufferKRW - stressEnd),
    };
  }

  if (!input.currentConsensus) missing.push({ field: "currentConsensus", code: "CONSENSUS_UNAVAILABLE", message: "no verified current consensus for the estimated quarter with real publication provenance was found" });
  if (!input.priorConsensus) missing.push({ field: "priorConsensus", code: "CONSENSUS_UNAVAILABLE", message: "no verified prior consensus for the estimated quarter with real publication provenance was found" });
  if (!input.catalyst) missing.push({ field: "catalyst", code: "CATALYST_UNAVAILABLE", message: "no verified, sourced upcoming catalyst (earnings release/guidance/disclosure) was found" });

  let evaluation: CandidateEvaluation | null = null;
  if (forecast && input.currentConsensus && input.priorConsensus && input.catalyst) {
    const candidate = SingleQuarterCandidateInputSchema.safeParse({ ticker: input.ticker, evidenceMode: "forward" as const, forecast, currentConsensus: input.currentConsensus, priorConsensus: input.priorConsensus, catalyst: input.catalyst });
    if (candidate.success) evaluation = evaluateOne(candidate.data, placeholderConfig(riskPolicy), input.decisionAt, "single_quarter");
    else {
      notes.push("Extracted forecast/consensus/catalyst did not form a consistent candidate bundle.");
      missing.push({ field: "candidate", code: "CANDIDATE_SCHEMA_INVALID", message: candidate.error.issues[0]?.message ?? "candidate bundle failed validation" });
    }
  }

  if (bridge) notes.push(`Single-quarter estimate for ${bridge.quarters[0]!.quarter}, built for a holding period of at most about three months; it is not a four-quarter or annual forecast.`);
  const status: AutoStrategyResult["status"] = evaluation ? (evaluation.eligible ? "eligible" : "ineligible") : bridge ? "estimate_only" : "insufficient_data";
  return {
    status, mode: input.mode, decisionAt: input.decisionAt, generatedAt: forecast?.generatedAt ?? null, independentlyAudited: false,
    bridge, risk, evaluation, quarterlyConsensus, nextQuarterPrice, missing, notes,
    forecast, currentConsensus: input.currentConsensus, priorConsensus: input.priorConsensus, catalyst: input.catalyst,
    assumptions: forecast ? collectAssumptions(forecast, input.fundingOrigin === "derived_from_filings") : [],
    fundingOrigin: forecast?.funding ? (input.fundingOrigin ?? "model") : null,
    noRefinancingBound,
  };
}
