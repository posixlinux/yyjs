import { createHash } from "node:crypto";
import { z } from "zod";
import { STRATEGY_VERSION } from "./version.js";

export const DEFAULT_RISK_PARAMS = {
  requireFundingData: true,
  excludeStressFundingGap: true,
  minInterestCoverage: 1,
  volumeDecline: 0.1,
  priceDecline: 0.05,
  variableCostIncrease: 0.05,
  annualInterestShockBps: 200,
  maxSectorWeight: 0.6,
  requireLiquidity: true,
  maxParticipationRate: 0.01,
  maxLiquidityAgeDays: 10,
} as const;

export const RiskPolicySchema = z.object({
  requireFundingData: z.boolean(),
  excludeStressFundingGap: z.boolean(),
  minimumCashBufferKRW: z.number().nonnegative().max(1e18),
  minInterestCoverage: z.number().nonnegative().max(100).nullable(),
  volumeDecline: z.number().min(0).max(1),
  priceDecline: z.number().min(0).max(1),
  variableCostIncrease: z.number().min(0).max(5),
  annualInterestShockBps: z.number().min(0).max(10000),
  maxSectorWeight: z.number().positive().max(1),
  requireLiquidity: z.boolean(),
  maxParticipationRate: z.number().positive().max(1),
  maxLiquidityAgeDays: z.number().int().nonnegative().max(365),
}).strict();
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

// Fixed experiment configuration (STRATEGY_SPEC.md "Fixed experiment configuration"). The whole object is supplied
// with every run, frozen for that run, and digested so a result can be tied back to the exact parameters that
// produced it. The hypothesis thresholds (gap/revision/consensus-age/catalyst-window/position-limits) have
// documented proposed defaults below because STRATEGY_SPEC.md ships them as explicit numbers; they are NOT to be
// tuned on the sample being evaluated. Trading-cost assumptions (fees, slippage, sell tax) and initialCapitalKRW
// intentionally have NO defaults here: STRATEGY_SPEC.md says not to hardcode current legal tax rates and to let the
// caller choose assumed values explicitly every run.

export const StrategyConfigSchema = z
  .object({
    version: z.literal(STRATEGY_VERSION),
    // Legacy/optional field, retained for backward compatibility with old saved configs. screen()/replay() ignore
    // it entirely: the user chooses candidate tickers directly, and each candidate's own forecast.sector (see
    // schema.ts) drives concentration limits, not this top-level value.
    sector: z.string().trim().min(1).max(100).optional(),
    currency: z.literal("KRW"),
    exchange: z.literal("KOSPI"),
    gapThresholdPct: z.number().min(0).max(5), // fraction; 0.10 = 10%
    minRevisionPct: z.number().min(-1).max(5), // revision must be strictly greater than this
    maxCurrentConsensusAgeDays: z.number().int().positive().max(365),
    minPriorConsensusLagDays: z.number().int().nonnegative().max(365),
    maxPriorConsensusLagDays: z.number().int().positive().max(365),
    catalystMinDaysAhead: z.number().int().nonnegative().max(365),
    catalystMaxDaysAhead: z.number().int().positive().max(365),
    maxHoldings: z.number().int().positive().max(50),
    maxWeightPerHolding: z.number().positive().max(1), // fraction of initial capital
    holdSessions: z.number().int().positive().max(250),
    // Documented minimum positive consensus EPS (KRW/share) treated as usable; below this, the denominator is
    // "near zero" for gap/revision purposes and the candidate is ineligible rather than producing a blown-up ratio.
    minConsensusEpsKRW: z.number().positive().max(1e6),
    feeBpsPerSide: z.number().min(0).max(1000), // basis points, each side (entry AND exit)
    slippageBpsPerSide: z.number().min(0).max(1000),
    sellTaxBps: z.number().min(0).max(1000), // caller's assumed rate; never hardcoded here
    initialCapitalKRW: z.number().positive().max(1e15),
    risk: RiskPolicySchema,
  })
  .strict()
  .refine((c) => c.minPriorConsensusLagDays <= c.maxPriorConsensusLagDays, { message: "minPriorConsensusLagDays must be <= maxPriorConsensusLagDays", path: ["minPriorConsensusLagDays"] })
  .refine((c) => c.catalystMinDaysAhead <= c.catalystMaxDaysAhead, { message: "catalystMinDaysAhead must be <= catalystMaxDaysAhead", path: ["catalystMinDaysAhead"] });
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

/** The STRATEGY_SPEC.md "proposed explicit defaults": hypothesis parameters only. Costs/capital must always be added explicitly. */
export const DEFAULT_HYPOTHESIS_PARAMS = {
  version: STRATEGY_VERSION,
  currency: "KRW",
  exchange: "KOSPI",
  gapThresholdPct: 0.1,
  minRevisionPct: 0,
  maxCurrentConsensusAgeDays: 30,
  minPriorConsensusLagDays: 20,
  maxPriorConsensusLagDays: 40,
  catalystMinDaysAhead: 1,
  catalystMaxDaysAhead: 60,
  maxHoldings: 5,
  maxWeightPerHolding: 0.2,
  holdSessions: 20,
  minConsensusEpsKRW: 1,
  risk: DEFAULT_RISK_PARAMS, // minimumCashBufferKRW must be explicitly supplied along with costs and capital
} as const;

const canonicalize = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonicalize(x)]));
  return v;
};

/** Stable sha256 hex digest of a config, independent of key order; included with every strategy result. */
export function configDigest(config: StrategyConfig): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(config))).digest("hex");
}
