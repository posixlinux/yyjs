import { z } from "zod";
import { isValidIsoDateTime } from "./time.js";

// Strict input schemas for the earnings-gap-auto/v1 strategy slice (docs/STRATEGY_SPEC.md). This is a separate
// experiment surface from the product-market model in src/domain/schema.ts: different version, different inputs,
// no automatic conversion between the two (STRATEGY_SPEC.md "Do NOT auto-convert existing single-quarter model
// output into a strategy forecast").

const isoDateTime = z.string().refine(isValidIsoDateTime, "must be an ISO 8601 datetime with an explicit UTC offset, e.g. 2026-01-15T09:00:00+09:00");
const text = (max: number) => z.string().trim().min(1).max(max);
const ticker = z.string().regex(/^\d{6}$/, "six-digit KOSPI ticker");
const quarterTag = z.string().regex(/^\d{4}Q[1-4]$/, "must look like 2026Q2 (calendar fiscal quarter, v1 restriction)");
const money = (max = 1e15) => z.number().min(-max).max(max);

const fourConsecutiveQuarters = (quarters: string[]): boolean => {
  const idx = (q: string) => Number(q.slice(0, 4)) * 4 + Number(q[5]) - 1;
  for (let i = 1; i < quarters.length; i++) if (idx(quarters[i]!) - idx(quarters[i - 1]!) !== 1) return false;
  return new Set(quarters).size === quarters.length;
};

// ---------- provenance ----------

// "model_knowledge" is deliberately absent: STRATEGY_SPEC.md requires LLM background knowledge to never be eligible
// for a strategy decision, so there is no schema-legal way to tag a source as such (rejected at parse time, not
// filtered out later).
export const STRATEGY_SOURCE_KINDS = ["filing", "guidance", "press_release", "exchange_notice", "analyst_report", "market_data_vendor", "manual_assumption", "archive"] as const;
export type StrategySourceKind = (typeof STRATEGY_SOURCE_KINDS)[number];

export const StrategySourceSchema = z
  .object({
    title: text(200),
    url: z.url({ protocol: /^https?$/ }).max(500).optional(),
    manualReference: text(300).optional(),
    kind: z.enum(STRATEGY_SOURCE_KINDS),
    knownAt: isoDateTime, // when this fact became known/publicly available
  })
  .strict()
  .refine((s) => s.url || s.manualReference, "source needs url or manualReference");
export type StrategySource = z.infer<typeof StrategySourceSchema>;

// An analyst-supplied assumption: explicitly labeled as such (never silently blended with sourced facts) and always
// carries a rationale, per STRATEGY_SPEC.md "Analyst-supplied assumptions must be explicitly labeled as assumptions."
const assumption = <T extends z.ZodType>(value: T) =>
  z.object({ value, isAssumption: z.literal(true), rationale: text(500), source: StrategySourceSchema }).strict();

export const ForecastAssumptionsSchema = z.object({ isAssumption: z.literal(true), rationale: text(1000), source: StrategySourceSchema }).strict();
const cashAmount = z.number().nonnegative().max(1e18);
export const FundingQuarterSchema = z.object({
  quarter: quarterTag,
  depreciationAndAmortizationKRW: cashAmount,
  capexKRW: cashAmount,
  deltaWorkingCapitalKRW: money(1e18),
  cashTaxesKRW: cashAmount,
  cashInterestPaidKRW: cashAmount,
  otherOperatingCashFlowKRW: money(1e18),
  otherOperatingCashFlowRationale: text(500),
  debtPrincipalDueKRW: cashAmount,
  committedDebtDrawKRW: cashAmount,
  dividendsAndBuybacksKRW: cashAmount,
  assumptions: ForecastAssumptionsSchema,
}).strict();
export const FundingPlanSchema = z.object({
  // These are projected balances at the START of the first forecast quarter, not today's cash silently
  // carried past an unmodelled stub period. Intraperiod/stub funding risk is separately disclosed.
  openingBalanceBasis: z.literal("projected_start_of_horizon"),
  openingUnrestrictedCashKRW: cashAmount,
  openingDebtKRW: cashAmount,
  assumptions: ForecastAssumptionsSchema,
  quarters: z.array(FundingQuarterSchema).length(4),
}).strict().refine((p) => fourConsecutiveQuarters(p.quarters.map((q) => q.quarter)), "funding quarters must be consecutive");
export type FundingPlan = z.infer<typeof FundingPlanSchema>;

export const LiquiditySchema = z.object({
  averageDailyTradedValueKRW: z.number().positive().max(1e18),
  windowSessions: z.number().int().min(5).max(250),
  asOf: isoDateTime,
  knownAt: isoDateTime,
  source: StrategySourceSchema,
}).strict();

// ---------- four-quarter earnings forecast (the earnings bridge) ----------

export const SegmentForecastSchema = z
  .object({
    name: text(100),
    volume: z.number().min(0).max(1e15), // units sold in the quarter; nonnegative, losses come from margin not volume
    unitPriceKRW: z.number().positive().max(1e12),
    variableCostPerUnitKRW: z.number().min(0).max(1e12),
    fixedCostKRW: z.number().min(0).max(1e18),
    source: StrategySourceSchema,
    assumptions: ForecastAssumptionsSchema.optional(),
  })
  .strict();
export type SegmentForecast = z.infer<typeof SegmentForecastSchema>;

export const QuarterForecastSchema = z
  .object({
    quarter: quarterTag,
    segments: z.array(SegmentForecastSchema).min(1).max(30),
    // No fabricated missing segments: the analyst must affirmatively attest full coverage. This is a claim, not an
    // independent verification (STRATEGY_SPEC.md "label it user-supplied, not independently verified").
    coverageAttestation: z
      .object({
        complete: z.literal(true, { message: "coverage must be explicitly attested complete (v1 has no partial/residual segment concept)" }),
        statedBy: text(200),
        note: text(500).optional(),
      })
      .strict(),
    netInterestKRW: money(),
    taxRate: z.number().min(0).max(0.6),
    noncontrollingShare: z.number().min(0).max(1),
    preferredClaimsKRW: z.number().min(0).max(1e15),
    dilutedCommonShares: z.number().int().positive().max(1e13),
    bridgeAssumptions: ForecastAssumptionsSchema.optional(),
  })
  .strict();
export type QuarterForecast = z.infer<typeof QuarterForecastSchema>;

export const EarningsForecastSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    ticker,
    company: z.object({ name: text(100), exchange: z.string().min(1).max(20), securityType: z.string().min(1).max(40), source: StrategySourceSchema }).strict().optional(),
    scope: z.literal("consolidated").optional(),
    // User-declared sector, used only to group same-sector concentration limits in screen()/replay() (via
    // sectorKey). Never matched against config.sector or any allowlist -- candidates of any sector are eligible;
    // the user chooses which tickers to submit.
    sector: text(100),
    fiscalYearBasis: z.literal("calendar"), // explicit v1 restriction (STRATEGY_SPEC.md "Assume calendar fiscal year only")
    currency: z.literal("KRW"),
    generatedAt: isoDateTime, // forecast production time / observation cutoff
    analyst: text(200), // who/what produced the forecast; never "model_knowledge"
    quarters: z.array(QuarterForecastSchema).length(4),
    funding: FundingPlanSchema.optional(),
    liquidity: LiquiditySchema.optional(),
  })
  .strict()
  .refine((f) => fourConsecutiveQuarters(f.quarters.map((q) => q.quarter)), { message: "quarters must be four consecutive, non-duplicate calendar quarters in ascending order", path: ["quarters"] });
export type EarningsForecastSnapshot = z.infer<typeof EarningsForecastSnapshotSchema>;

// ---------- consensus (current and prior) ----------

export const ConsensusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    ticker,
    scope: z.literal("consolidated"), // rejects parent-only/segment consensus by construction
    basis: z.literal("common_diluted"), // rejects trailing/annual/basic-share consensus by construction
    currency: z.literal("KRW"),
    unit: z.literal("KRW_per_share"),
    horizonQuarters: z.array(quarterTag).length(4),
    epsPerShare: z.number().finite(), // sign is checked at eligibility time (explicit ineligible reason, not a 400)
    knownAt: isoDateTime,
    source: StrategySourceSchema,
  })
  .strict()
  .refine((c) => fourConsecutiveQuarters(c.horizonQuarters), { message: "horizonQuarters must be four consecutive, non-duplicate calendar quarters in ascending order", path: ["horizonQuarters"] });
export type ConsensusSnapshot = z.infer<typeof ConsensusSnapshotSchema>;

// ---------- catalyst schedule ----------

export const CatalystSchema = z
  .object({
    schemaVersion: z.literal(1),
    ticker,
    eventType: z.enum(["earnings_release", "guidance_update", "other_scheduled_disclosure"]),
    eventAt: isoDateTime,
    knownAt: isoDateTime,
    source: StrategySourceSchema,
  })
  .strict();
export type Catalyst = z.infer<typeof CatalystSchema>;

// ---------- optional fixed-PER diagnostic (never the trade signal) ----------

export const DiagnosticInputSchema = z
  .object({
    referencePE: z.number().positive().max(200),
    currentPriceKRW: z.number().positive().max(1e9),
    knownAt: isoDateTime,
    source: StrategySourceSchema,
  })
  .strict();
export type DiagnosticInput = z.infer<typeof DiagnosticInputSchema>;

// ---------- candidate bundle consumed by screen() ----------

export const EVIDENCE_MODES = ["forward", "historical_import_unverified", "synthetic"] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

export const CandidateInputSchema = z
  .object({
    ticker,
    evidenceMode: z.enum(EVIDENCE_MODES),
    forecast: EarningsForecastSnapshotSchema,
    currentConsensus: ConsensusSnapshotSchema,
    priorConsensus: ConsensusSnapshotSchema,
    catalyst: CatalystSchema,
    diagnostic: DiagnosticInputSchema.optional(),
    recordRefs: z.record(z.string(), z.object({ id: z.uuid(), contentHash: z.string(), recordedAt: isoDateTime, mode: z.enum(["forward", "historical_import_unverified", "synthetic"]) }).strict()).optional(),
  })
  .strict();
export type CandidateInput = z.infer<typeof CandidateInputSchema>;

export { assumption, money, isoDateTime, quarterTag, ticker as tickerSchema, fourConsecutiveQuarters };
