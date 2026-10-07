import type { PerReference, QuarterlyConsensus } from "../collection/types.js";
import type { Analysis } from "../model/model.js";

// Deterministic sanity checks on a finished valuation against what the market data itself says. Each returns a
// warning (the valuation becomes "provisional") or null, so a model's assumption that the observed data contradicts
// never passes as a verified price.

type Warning = { code: string; severity: "warning"; message: string; details?: unknown };

/**
 * The base-case P/E must sit inside the range the stock actually traded at over the collected window (closes /
 * the current trailing EPS). Bear above the range or bull below it is also flagged.
 */
export function peBandCheck(a: Analysis, per: PerReference | null | undefined): Warning | null {
  if (!per) return null;
  const { min, max, median } = per.window;
  const pe = a.assumptions.peMultiple;
  const out: string[] = [];
  if (pe.base < min || pe.base > max) out.push(`base ${pe.base} is outside the observed ${min}~${max}`);
  if (pe.bear > max) out.push(`bear ${pe.bear} is above the observed maximum ${max}`);
  if (pe.bull < min) out.push(`bull ${pe.bull} is below the observed minimum ${min}`);
  if (!out.length) return null;
  return {
    code: "PE_OUTSIDE_OBSERVED_RANGE",
    severity: "warning",
    message: `Scenario P/E multiples disagree with the P/E range the stock traded at (${per.window.from}~${per.window.to}, median ${median}, on TTM EPS ${per.ttmEpsKRW}): ${out.join("; ")}.`,
    details: { assumed: pe, observed: { min, median, max, current: per.current, from: per.window.from, to: per.window.to } },
  };
}

/**
 * The base-case target-quarter revenue and operating profit must not stray more than `maxGapPct` from the
 * market consensus for the same quarter without being reviewed. Consensus is a reference, so this only warns.
 */
export function consensusGapCheck(a: Analysis, consensus: QuarterlyConsensus[], maxGapPct = 30): Warning | null {
  const c = consensus.find((x) => x.quarter === a.targetQuarter);
  const base = a.scenarios.find((s) => s.scenario === "base");
  if (!c || !base) return null;
  const gap = (mine: number, theirs: number | null) => (theirs !== null && theirs > 0 ? ((mine - theirs) / theirs) * 100 : null);
  const rev = gap(base.totals.revenueKRW, c.revenueKRW);
  const op = gap(base.totals.operatingProfitKRW, c.operatingProfitKRW);
  const far = [rev !== null && Math.abs(rev) > maxGapPct ? `revenue ${rev.toFixed(1)}%` : null, op !== null && Math.abs(op) > maxGapPct ? `operating profit ${op.toFixed(1)}%` : null].filter(Boolean);
  if (!far.length) return null;
  return {
    code: "CONSENSUS_GAP_LARGE",
    severity: "warning",
    message: `Base-case ${a.targetQuarter} differs from the market consensus by more than ${maxGapPct}% (${far.join(", ")}); check the drivers behind the gap.`,
    details: { quarter: a.targetQuarter, revenueGapPct: rev, operatingProfitGapPct: op, consensus: { revenueKRW: c.revenueKRW, operatingProfitKRW: c.operatingProfitKRW, observedAt: c.observedAt } },
  };
}

export type QualityTier = "high" | "medium" | "low";

/**
 * One label for how far to trust a valuation as a recommendation: "high" only for a verified, cross-checked,
 * well-grounded price that agrees with the observed P/E range and the consensus; "low" for a provisional price on
 * mostly estimated inputs; "medium" otherwise. Reasons list every downgrade.
 */
export function qualityTier(p: { grade: string | null; crossChecked: boolean; dataGrounding: "high" | "medium" | "low" | null; warnings: string[] }): { tier: QualityTier | null; reasons: string[] } {
  if (!p.grade) return { tier: null, reasons: ["no valuation"] };
  const reasons: string[] = [];
  if (p.grade !== "verified") reasons.push("provisional valuation");
  if (!p.crossChecked) reasons.push("single model (no cross-check)");
  if (p.dataGrounding !== "high") reasons.push(`data grounding ${p.dataGrounding ?? "unknown"}`);
  for (const w of ["PE_OUTSIDE_OBSERVED_RANGE", "CONSENSUS_GAP_LARGE"]) if (p.warnings.includes(w)) reasons.push(w);
  const severe = p.dataGrounding === "low" || (p.grade !== "verified" && p.dataGrounding !== "high") || p.warnings.includes("PE_OUTSIDE_OBSERVED_RANGE");
  return { tier: reasons.length === 0 ? "high" : severe ? "low" : "medium", reasons };
}
