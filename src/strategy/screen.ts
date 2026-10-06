export const sectorKey = (sector: string): string => sector.trim().normalize("NFKC").toLowerCase();
import { parseQuarter, quarterEnd, quarterOfDate } from "../domain/time.js";
import { AppError } from "../errors.js";
import { classifySecurity } from "../domain/security.js";
import { contentHashOf } from "./journal.js";
import { computeCompanyRisk, type CompanyRisk } from "./risk.js";
import type { StrategyConfig } from "./config.js";
import { configDigest, StrategyConfigSchema } from "./config.js";
import { computeForecastBridge, type ForecastBridge } from "./earnings.js";
import { computeDiagnostic, gapPct, revisionPct, type DiagnosticResult } from "./expectations.js";
import { CandidateInputSchema, isoDateTime, type CandidateInput } from "./schema.js";
import { seoulDateOf, daysBetweenInstants, epoch, singleQuarterHorizon } from "./time.js";

// Screening/ranking (STRATEGY_SPEC.md "Expectations and catalyst" + "Fixed experiment configuration"). Pure and
// deterministic: given already-resolved candidate bundles (the caller/service layer resolves journal IDs first) and
// a frozen config, produces every candidate's eligibility with reasons, a rank, and a selection. This function never
// sees session/price data, so eligibility and ranking cannot depend on price outcomes by construction
// (STRATEGY_SPEC.md "Eligibility/ranking must not depend on available price outcomes").

export type EligibilityReason = { code: string; message: string };

export type EligibleCandidate = {
  ticker: string;
  eligible: true;
  evidenceMode: CandidateInput["evidenceMode"];
  forecastNtmEpsKRW: number;
  currentConsensusEpsKRW: number;
  priorConsensusEpsKRW: number;
  gapPct: number;
  revisionPct: number;
  bridge: ForecastBridge;
  diagnostic: DiagnosticResult | null;
  catalyst: { eventAt: string; daysAhead: number };
  rank: number | null; // 1-based rank among eligible candidates by gap descending, ticker ascending; null until ranked
  selected: boolean;
  risk: CompanyRisk | null;
  stressValuationLossFraction: number | null;
};

export type IneligibleCandidate = { ticker: string; eligible: false; reasons: EligibilityReason[]; risk?: CompanyRisk | null };

export type CandidateEvaluation = EligibleCandidate | IneligibleCandidate;

export type ScreenResult = {
  version: string;
  configDigest: string;
  decisionAt: string;
  evaluations: CandidateEvaluation[];
  selected: { ticker: string; rank: number; weight: number }[];
  unusedCapitalPct: number; // fraction of initial capital left as idle cash
  noTrade: boolean;
  config: StrategyConfig;
  inputSnapshots: CandidateInput[];
  inputHashes: Record<string, string>;
  evidenceModes: Record<string, CandidateInput["evidenceMode"]>;
  experimentMode: "synthetic" | "retrospective_research";
  notes: string[];
  portfolio: {
    investedKRW: number; idleCashKRW: number; sectorWeight: number; investedWeight: number; sectorWeights: Record<string, number>; largestSectorWeight: number; largestPositionWeight: number;
    stressLossFraction: number | null; stressValuationCoverageWeight: number;
    positions: { ticker: string; budgetKRW: number; participationRate: number | null; liquidityLimited: boolean }[];
  };
};

const reason = (code: string, message: string): EligibilityReason => ({ code, message });

/** Exported for the automatic single-candidate path (strategy/auto.ts): eligibility/gap/revision/risk only, never
 * portfolio weight (that is computed later in screen() below, which needs real, explicitly configured capital).
 * `horizon` is "next_four" for the /v1/strategy/* API; the automatic short-term path passes "single_quarter" (one quarter,
 * either the one just ended or the one in progress -- see singleQuarterHorizon). */
export function evaluateOne(c: CandidateInput, config: StrategyConfig, decisionAt: string, horizon: "next_four" | "single_quarter" = "next_four"): CandidateEvaluation {
  const reasons: EligibilityReason[] = [];
  const add = (code: string, message: string) => reasons.push(reason(code, message));

  if (c.forecast.ticker !== c.ticker || c.currentConsensus.ticker !== c.ticker || c.priorConsensus.ticker !== c.ticker || c.catalyst.ticker !== c.ticker) add("TICKER_MISMATCH", "forecast/consensus/catalyst ticker does not match the candidate ticker");
  const company = c.forecast.company;
  if (!company || c.forecast.scope !== "consolidated") add("COMPANY_SCOPE_MISSING", "Company/exchange/security type and consolidated scope must be declared");
  else if (!["KOSPI", "KOSDAQ"].includes(company.exchange) || company.securityType !== "common_stock" || classifySecurity({ ticker: c.ticker, names: [company.name] }).length)
    add("NOT_KOSPI_COMMON", "Strategy requires declared KOSPI/KOSDAQ common shares passing the security filter");

  const forecastQuarters = c.forecast.quarters.map((q) => q.quarter);
  const currentHorizon = c.currentConsensus.horizonQuarters;
  const priorHorizon = c.priorConsensus.horizonQuarters;
  if (JSON.stringify(currentHorizon) !== JSON.stringify(forecastQuarters)) add("HORIZON_MISMATCH", "current consensus horizon does not exactly match the forecast's quarters");
  if (JSON.stringify(priorHorizon) !== JSON.stringify(forecastQuarters)) add("ROLLING_HORIZON_CHANGED", "prior consensus horizon does not exactly match the forecast's quarters (rolling horizon change)");

  const decisionDate = seoulDateOf(decisionAt);
  if (horizon === "single_quarter") {
    const allowed = singleQuarterHorizon(decisionDate);
    if (forecastQuarters.length !== 1 || (forecastQuarters[0] !== allowed.previous && forecastQuarters[0] !== allowed.current))
      add("FORECAST_HORIZON_NOT_SINGLE_QUARTER", `Forecast must be exactly one quarter: ${allowed.previous} (just ended) or ${allowed.current} (in progress at the KST decision date)`);
  } else {
    if (parseQuarter(forecastQuarters[0]!) !== quarterOfDate(decisionDate) + 1)
      add("FORECAST_HORIZON_NOT_NEXT_FOUR", "Forecast must start in the calendar quarter immediately after the KST decision quarter");
    for (const q of c.forecast.quarters) if (quarterEnd(parseQuarter(q.quarter)) <= decisionDate) add("FORECAST_QUARTER_NOT_FUTURE", `forecast quarter ${q.quarter} does not end strictly after the decision date ${decisionDate}`);
  }

  if (epoch(c.forecast.generatedAt) > epoch(decisionAt)) add("FORECAST_GENERATED_AFTER_DECISION", "forecast generatedAt is after decisionAt");
  for (const q of c.forecast.quarters)
    for (const s of q.segments) if (epoch(s.source.knownAt) > epoch(c.forecast.generatedAt)) add("SOURCE_KNOWN_AFTER_GENERATION", `segment "${s.name}" (${q.quarter}) source knownAt is after the forecast's generatedAt`);
  const forecastSources = [company?.source];
  for (const q of c.forecast.quarters) {
    if (!q.bridgeAssumptions || q.segments.some((s) => !s.assumptions)) add("FORECAST_PROVENANCE_MISSING", `${q.quarter}: bridge and segment forecasts require explicit assumptions and provenance`);
    forecastSources.push(q.bridgeAssumptions?.source, ...q.segments.map((s) => s.assumptions?.source));
  }
  if (c.forecast.funding) forecastSources.push(c.forecast.funding.assumptions.source, ...c.forecast.funding.quarters.map((q) => q.assumptions.source));
  for (const source of forecastSources) if (source && epoch(source.knownAt) > epoch(c.forecast.generatedAt))
    add("SOURCE_KNOWN_AFTER_GENERATION", `${source.title}: source known after forecast generation`);

  for (const [label, value] of Object.entries({ currentConsensus: c.currentConsensus, priorConsensus: c.priorConsensus, catalyst: c.catalyst, ...(c.diagnostic && { diagnostic: c.diagnostic }) })) {
    if (epoch(value.source.knownAt) > epoch(value.knownAt) || epoch(value.knownAt) > epoch(decisionAt))
      add("SOURCE_TIME_MISMATCH", `${label}: source must be known by the declared observation time and decision time`);
  }

  const liquidity = c.forecast.liquidity;
  if (!liquidity && config.risk.requireLiquidity) add("LIQUIDITY_DATA_MISSING", "Observed trailing traded value is required for position sizing");
  if (liquidity) {
    if (epoch(liquidity.asOf) > epoch(liquidity.knownAt) || epoch(liquidity.source.knownAt) > epoch(liquidity.knownAt)
        || epoch(liquidity.knownAt) > epoch(c.forecast.generatedAt) || epoch(liquidity.knownAt) > epoch(decisionAt))
      add("LIQUIDITY_TIME_MISMATCH", "Liquidity must be observed and published by forecast generation and decision");
    if (daysBetweenInstants(liquidity.asOf, decisionAt) > config.risk.maxLiquidityAgeDays)
      add("LIQUIDITY_STALE", "Trailing traded value is too old for capacity sizing");
  }

  let risk: CompanyRisk | null = null;
  if (!c.forecast.funding && config.risk.requireFundingData) add("RISK_DATA_MISSING", "Investment, working capital and debt cash-flow plan is required");
  if (c.forecast.funding) {
    try { risk = computeCompanyRisk(c.forecast, config.risk); }
    catch (e) { if (e instanceof AppError) add(e.code, e.message); else throw e; }
    if (risk) {
      if (risk.base.peakAdditionalFundingRequiredKRW > 0) add("BASE_FUNDING_GAP", "Base case cash falls below the required buffer after investment and financing flows");
      if (config.risk.excludeStressFundingGap && risk.stress.peakAdditionalFundingRequiredKRW > 0) add("STRESS_FUNDING_GAP", "Downside scenario requires additional funding");
      if (config.risk.minInterestCoverage !== null && risk.base.quarters.some((q) => q.interestCoverage !== null && q.interestCoverage < config.risk.minInterestCoverage!))
        add("LOW_INTEREST_COVERAGE", "Base EBIT/cash-interest coverage falls below the configured floor");
    }
  }

  const eps = (v: number, label: string, code: string, nearZeroCode: string) => {
    if (v <= 0) add(code, `${label} consensus EPS ${v} is not positive`);
    else if (v < config.minConsensusEpsKRW) add(nearZeroCode, `${label} consensus EPS ${v} is below the minimum usable denominator ${config.minConsensusEpsKRW} KRW/share`);
  };
  eps(c.currentConsensus.epsPerShare, "current", "NONPOSITIVE_CURRENT_CONSENSUS_EPS", "NEAR_ZERO_CURRENT_CONSENSUS_EPS");
  eps(c.priorConsensus.epsPerShare, "prior", "NONPOSITIVE_PRIOR_CONSENSUS_EPS", "NEAR_ZERO_PRIOR_CONSENSUS_EPS");

  if (epoch(c.currentConsensus.knownAt) > epoch(decisionAt)) add("CURRENT_CONSENSUS_FUTURE", "current consensus knownAt is after decisionAt");
  else if (daysBetweenInstants(c.currentConsensus.knownAt, decisionAt) > config.maxCurrentConsensusAgeDays) add("CURRENT_CONSENSUS_STALE", `current consensus is older than ${config.maxCurrentConsensusAgeDays} days at decision time`);
  if (epoch(c.priorConsensus.knownAt) > epoch(decisionAt)) add("PRIOR_CONSENSUS_FUTURE", "prior consensus knownAt is after decisionAt");
  if (epoch(c.priorConsensus.knownAt) >= epoch(c.currentConsensus.knownAt)) add("PRIOR_CONSENSUS_NOT_BEFORE_CURRENT", "prior consensus knownAt must be strictly before current consensus knownAt");
  else {
    const lag = daysBetweenInstants(c.priorConsensus.knownAt, c.currentConsensus.knownAt);
    if (lag < config.minPriorConsensusLagDays || lag > config.maxPriorConsensusLagDays) add("PRIOR_CONSENSUS_LAG_OUT_OF_RANGE", `prior-to-current consensus lag ${lag.toFixed(2)} days is outside [${config.minPriorConsensusLagDays}, ${config.maxPriorConsensusLagDays}]`);
  }

  if (epoch(c.catalyst.knownAt) > epoch(decisionAt)) add("CATALYST_SOURCE_FUTURE", "catalyst schedule knownAt is after decisionAt");
  if (epoch(c.catalyst.eventAt) <= epoch(decisionAt)) add("CATALYST_NOT_FUTURE", "catalyst eventAt must be strictly after decisionAt");
  else {
    const daysAhead = daysBetweenInstants(decisionAt, c.catalyst.eventAt);
    if (daysAhead < config.catalystMinDaysAhead || daysAhead > config.catalystMaxDaysAhead) add("CATALYST_WINDOW_VIOLATION", `catalyst is ${daysAhead.toFixed(2)} days ahead, outside [${config.catalystMinDaysAhead}, ${config.catalystMaxDaysAhead}]`);
  }

  // Gap/revision require positive, in-range, correctly-lagged consensus; skip computing them if those already failed
  // (an out-of-range denominator would otherwise produce a misleading ratio in the reasons list).
  const denominatorsOk = !reasons.some((r) => r.code.includes("CONSENSUS_EPS") || r.code === "PRIOR_CONSENSUS_NOT_BEFORE_CURRENT");
  let gap = NaN;
  let revision = NaN;
  if (denominatorsOk) {
    const bridge = computeForecastBridge(c.forecast);
    gap = gapPct(bridge.ntmEpsKRW, c.currentConsensus.epsPerShare);
    revision = revisionPct(c.currentConsensus.epsPerShare, c.priorConsensus.epsPerShare);
    if (revision <= config.minRevisionPct) add("NO_POSITIVE_REVISION", `revision ${(revision * 100).toFixed(2)}% is not strictly greater than the required ${(config.minRevisionPct * 100).toFixed(2)}%`);
    if (gap < config.gapThresholdPct) add("GAP_BELOW_THRESHOLD", `EPS gap ${(gap * 100).toFixed(2)}% is below the required ${(config.gapThresholdPct * 100).toFixed(2)}%`);
  }

  if (reasons.length) return { ticker: c.ticker, eligible: false, reasons, risk };

  const bridge = computeForecastBridge(c.forecast);
  const diagnostic = c.diagnostic ? computeDiagnostic(bridge.ntmEpsKRW, c.diagnostic.referencePE, c.diagnostic.currentPriceKRW) : null;
  return {
    ticker: c.ticker,
    eligible: true,
    evidenceMode: c.evidenceMode,
    forecastNtmEpsKRW: bridge.ntmEpsKRW,
    currentConsensusEpsKRW: c.currentConsensus.epsPerShare,
    priorConsensusEpsKRW: c.priorConsensus.epsPerShare,
    gapPct: gap,
    revisionPct: revision,
    bridge,
    diagnostic,
    catalyst: { eventAt: c.catalyst.eventAt, daysAhead: daysBetweenInstants(decisionAt, c.catalyst.eventAt) },
    rank: null,
    selected: false,
    risk,
    stressValuationLossFraction: risk && diagnostic ? Math.max(0, 1 - Math.max(0, risk.stress.fourQuarterEpsKRW * diagnostic.referencePE) / diagnostic.currentPriceKRW) : null,
  };
}

/** Screens candidates already resolved to full objects (the service layer resolves journal IDs before calling this). */
export function screen(candidates: CandidateInput[], config: StrategyConfig, decisionAt: string): ScreenResult {
  decisionAt = isoDateTime.parse(decisionAt);
  config = StrategyConfigSchema.parse(config);
  candidates = candidates.map((c) => CandidateInputSchema.parse(c));
  if (new Set(candidates.map((c) => c.ticker)).size !== candidates.length)
    throw new AppError(422, "DUPLICATE_CANDIDATE", "Supply one explicitly chosen point-in-time snapshot per ticker; duplicate positions are not allowed");
  const evaluations = candidates.map((c) => evaluateOne(c, config, decisionAt));
  const eligible = evaluations.filter((e): e is EligibleCandidate => e.eligible);
  eligible.sort((a, b) => (b.gapPct !== a.gapPct ? b.gapPct - a.gapPct : a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  eligible.forEach((e, i) => {
    e.rank = i + 1;
    e.selected = i < config.maxHoldings;
  });
  const chosen = eligible.filter((e) => e.selected);
  const weight = chosen.length ? Math.min(config.maxWeightPerHolding, 1 / chosen.length) : 0;
  const byTicker = new Map(candidates.map((c) => [c.ticker, c]));
  const sectorCounts = new Map<string, number>();
  for (const e of chosen) {
    const key = sectorKey(byTicker.get(e.ticker)!.forecast.sector);
    sectorCounts.set(key, (sectorCounts.get(key) ?? 0) + 1);
  }
  const allocationLimit = (ticker: string) => Math.min(weight,
    config.risk.maxSectorWeight / sectorCounts.get(sectorKey(byTicker.get(ticker)!.forecast.sector))!);
  const selected = chosen.map((e) => {
    const liquidity = byTicker.get(e.ticker)!.forecast.liquidity;
    const capacityWeight = liquidity ? liquidity.averageDailyTradedValueKRW * config.risk.maxParticipationRate / config.initialCapitalKRW : weight;
    return { ticker: e.ticker, rank: e.rank!, weight: Math.min(allocationLimit(e.ticker), capacityWeight) };
  });
  const sectorTotals = new Map<string, number>();
  for (const p of selected) {
    const key = sectorKey(byTicker.get(p.ticker)!.forecast.sector);
    sectorTotals.set(key, (sectorTotals.get(key) ?? 0) + p.weight);
  }
  const investedWeight = selected.reduce((n, p) => n + p.weight, 0);
  const stressCoverageWeight = selected.reduce((n, p, i) => n + (chosen[i]!.stressValuationLossFraction !== null ? p.weight : 0), 0);
  return {
    version: config.version,
    configDigest: configDigest(config),
    decisionAt,
    evaluations,
    selected,
    unusedCapitalPct: Math.max(0, 1 - investedWeight),
    noTrade: selected.length === 0,
    config,
    inputSnapshots: candidates,
    inputHashes: Object.fromEntries(candidates.map((c) => [c.ticker, contentHashOf(c)])),
    evidenceModes: Object.fromEntries(candidates.map((c) => [c.ticker, c.evidenceMode])),
    experimentMode: candidates.some((c) => c.evidenceMode === "synthetic") ? "synthetic" : "retrospective_research",
    notes: ["Company membership and full coverage are user-attested, not independently verified.",
      "EPS covers the next four FULL calendar quarters after the KST decision quarter, not an exact rolling 12 months.",
      "Selection is recomputed, not a pre-registered forward experiment. Historical inputs and results remain unverified research.",
      "Participation is a capacity estimate, not a fill guarantee. The sector cap applies independently per user-declared sector label (not a single blended cap across all holdings); use consistent labels for the same sector across candidates.",
      "Stress valuation is fixed-PER with negative earnings floored to zero value, not a price forecast, probability or VaR."],
    portfolio: {
      investedKRW: investedWeight * config.initialCapitalKRW,
      idleCashKRW: (1 - investedWeight) * config.initialCapitalKRW,
      sectorWeight: investedWeight, // Deprecated total-exposure alias retained for older clients.
      investedWeight,
      sectorWeights: Object.fromEntries(sectorTotals),
      largestSectorWeight: Math.max(0, ...sectorTotals.values()),
      largestPositionWeight: Math.max(0, ...selected.map((s) => s.weight)),
      stressLossFraction: Math.abs(stressCoverageWeight - investedWeight) < 1e-12 ? selected.reduce((n, s, i) => n + s.weight * (chosen[i]!.stressValuationLossFraction ?? 0), 0) : null,
      stressValuationCoverageWeight: stressCoverageWeight,
      positions: selected.map((s) => {
        const l = byTicker.get(s.ticker)!.forecast.liquidity;
        return { ticker: s.ticker, budgetKRW: s.weight * config.initialCapitalKRW,
          participationRate: l ? s.weight * config.initialCapitalKRW / l.averageDailyTradedValueKRW : null, liquidityLimited: s.weight < allocationLimit(s.ticker) };
      }),
    },
  };
}
