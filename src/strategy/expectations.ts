// Pure gap/revision/diagnostic arithmetic (STRATEGY_SPEC.md "Expectations and catalyst"). Eligibility gating
// (horizon match, staleness, positivity, sign of revision...) lives in screen.ts; this module only computes ratios
// once the inputs are already known to be comparable.

/** (forecastNTMEPS / currentConsensusEPS) - 1 */
export const gapPct = (forecastNtmEpsKRW: number, currentConsensusEpsKRW: number): number => forecastNtmEpsKRW / currentConsensusEpsKRW - 1;

/** (current / prior) - 1 */
export const revisionPct = (currentConsensusEpsKRW: number, priorConsensusEpsKRW: number): number => currentConsensusEpsKRW / priorConsensusEpsKRW - 1;

export type DiagnosticResult = {
  referencePE: number;
  currentPriceKRW: number;
  currentPriceImpliedEpsKRW: number; // currentPrice / referencePE
  ntmForecastValueKRW: number; // forecastNTMEPS * referencePE
  earningsOnlyUpsidePct: number; // ntmForecastValue / currentPrice - 1, PE held fixed (no multiple expansion)
};

/** Fixed-PER diagnostic: a reported number, never the trade signal (STRATEGY_SPEC.md explicit). */
export function computeDiagnostic(forecastNtmEpsKRW: number, referencePE: number, currentPriceKRW: number): DiagnosticResult {
  const ntmForecastValueKRW = forecastNtmEpsKRW * referencePE;
  return {
    referencePE,
    currentPriceKRW,
    currentPriceImpliedEpsKRW: currentPriceKRW / referencePE,
    ntmForecastValueKRW,
    earningsOnlyUpsidePct: ntmForecastValueKRW / currentPriceKRW - 1,
  };
}
